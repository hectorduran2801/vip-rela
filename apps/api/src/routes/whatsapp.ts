import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireAdmin, requireStaff, requireSuper } from '../plugins/auth.js';

/** El worker escribe worker_heartbeat_at cada pocos segundos: si es más antiguo que esto, el servicio está apagado. */
const WORKER_ALIVE_MS = 30_000;

/**
 * UNA sola sesión de OpenWA. La API NO conecta nada ni da por buena una solicitud: pide conectar/desconectar y devuelve el estado REAL
 * que escribe el worker (más si el worker está vivo y el motivo del último fallo). El QR solo lo ve ADMIN+.
 */
export const whatsappRoutes: FastifyPluginAsync = async (app) => {
  const read = async (tx: { one: (sql: string, p?: unknown[]) => Promise<any> }, withQr: boolean) => {
    const s = await tx.one(`select id, label, status, desired_state, phone_number, last_error, worker_heartbeat_at, last_seen_at, session_persisted, session_saved_at, (logout_requested_at is not null) as logout_pending, status_changed_at, updated_at, worker_dry_run, worker_real_test_enabled, worker_automatic, now() as checked_at,
        (worker_heartbeat_at is not null and worker_heartbeat_at > now() - ($1::int * interval '1 millisecond')) as worker_online,
        case when $2::boolean and status = 'awaiting_scan' and (qr_expires_at is null or qr_expires_at > now()) then qr_data end as qr_data,
        case when $2::boolean and status = 'awaiting_scan' then qr_expires_at end as qr_expires_at
      from public.whatsapp_sessions`, [WORKER_ALIVE_MS, withQr]);
    if (!s) return s;
    // Modo de envío SEPARADO de «conectado»: solo se conoce si el worker está vivo (su latido lo informa); si no, 'unknown'.
    const sending_mode = !s.worker_online || s.worker_dry_run === null ? 'unknown' : s.worker_dry_run ? 'test' : 'real';
    return { ...s, sending_mode, real_test_enabled: !!(s.worker_online && s.worker_real_test_enabled), automatic_enabled: !!(s.worker_online && s.worker_automatic) };
  };

  app.get('/whatsapp/session', { preHandler: requireStaff }, async (req, reply) => {
    const r = await req.db(async (tx) => {
      const role = (await tx.one(`select public.current_app_role() r`))?.r as string | null;
      return read(tx, role === 'super_admin' || role === 'admin');
    });
    return r ?? reply.code(404).send({ error: 'session_not_found' });
  });

  for (const [action, desired] of [['connect', 'connected'], ['disconnect', 'disconnected']] as const) {
    app.post(`/whatsapp/session/${action}`, { preHandler: requireAdmin }, async (req, reply) => {
      const r = await req.db(async (tx) => { await tx.one(`select public.request_whatsapp_connection($1) r`, [desired]); return read(tx, true); });
      // `requested` significa SOLO «la solicitud quedó registrada»: el estado real lo confirma el worker.
      return r ? { requested: true, ...r } : reply.code(404).send({ error: 'session_not_found' });
    });
  }

  // Cerrar sesión (definitivo): el worker cierra el cliente y borra las credenciales locales y cifradas. Distinto de «desconectar», que las conserva.
  app.post('/whatsapp/session/logout', { preHandler: requireAdmin }, async (req, reply) => {
    const r = await req.db(async (tx) => { await tx.one(`select public.request_whatsapp_logout() r`); return read(tx, true); });
    return r ? { requested: true, ...r } : reply.code(404).send({ error: 'session_not_found' });
  });

  // Compatibilidad: el QR ya viene dentro de GET /whatsapp/session.
  app.get('/whatsapp/session/qr', { preHandler: requireAdmin }, async (req, reply) => {
    const r = await req.db((tx) => read(tx, true));
    return r?.qr_data ? { qr_data: r.qr_data, qr_expires_at: r.qr_expires_at, status: r.status } : reply.code(404).send({ error: 'session_not_found' });
  });

  // ───── Mensajes de prueba individuales (solo SUPER_ADMIN). Nunca a conductores; nunca masivos. ─────
  const phone = z.string().min(1).max(30);
  const body = z.string().trim().min(1).max(1000);
  const bad = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }) => reply.code(400).send({ error: 'invalid_body' });
  const num = (r: Record<string, unknown>) => ({ ...r });

  // Vista previa: destinatario normalizado, emisor y avisos. No crea nada.
  app.post('/whatsapp/test-messages/preview', { preHandler: requireSuper }, async (req, reply) => {
    const b = z.object({ phone, body }).safeParse(req.body); if (!b.success) return bad(reply);
    return req.db(async (tx) => {
      let recipient: string | null = null; let invalid = false;
      const digits = b.data.phone.replace(/\D/g, '');            // misma regla que app_private.normalize_phone (sin lanzar dentro de la transacción)
      if (/^[1-9]\d{7,14}$/.test(digits)) recipient = `+${digits}`; else invalid = true;
      const isDriver = recipient ? (await tx.one(`select exists(select 1 from public.drivers where phone_e164 = $1) e`, [recipient])).e as boolean : false;
      const ses = await read(tx, false);
      return { recipient, invalid_phone: invalid, recipient_is_a_driver: isDriver, body: b.data.body, chars: b.data.body.length,
        sender: ses?.status === 'connected' ? ses.phone_number : null, session_status: ses?.status ?? null, sending_mode: ses?.sending_mode ?? 'unknown', real_test_enabled: ses?.real_test_enabled ?? false };
    });
  });

  // Comprobante de pago con DATOS DE PRUEBA (no registra ningún pago).
  app.post('/whatsapp/test-messages/receipt-preview', { preHandler: requireSuper }, async (req, reply) => {
    const b = z.object({ unit: z.string().trim().min(1).max(30), methodCode: z.string().min(1).max(30), grossCents: z.number().int().min(1).max(10_000_000), pendingBeforeCents: z.number().int().min(0).max(10_000_000) }).safeParse(req.body);
    if (!b.success) return bad(reply);
    return (await req.db((tx) => tx.one(`select public.preview_payment_receipt($1,$2,$3,$4) r`, [b.data.unit, b.data.methodCode, b.data.grossCents, b.data.pendingBeforeCents])))!.r;
  });

  app.post('/whatsapp/test-messages', { preHandler: requireSuper }, async (req, reply) => {
    const b = z.object({ phone, body, mode: z.enum(['simulated', 'real']), idempotencyKey: z.string().min(8).max(100), kind: z.enum(['test', 'payment_receipt_preview']).default('test'),
      recipientAuthorization: z.string().trim().max(120).optional(), confirmLast4: z.string().regex(/^\d{4}$/).optional() }).safeParse(req.body);
    if (!b.success) return bad(reply);
    const m = await req.db((tx) => tx.one(`select * from public.create_test_message($1,$2,$3,$4,$5,$6,$7)`,
      [b.data.phone, b.data.body, b.data.mode, b.data.idempotencyKey, b.data.recipientAuthorization ?? null, b.data.confirmLast4 ?? null, b.data.kind]));
    return reply.code(201).send(num(m));
  });
  app.get('/whatsapp/test-messages', { preHandler: requireSuper }, async (req) =>
    req.db((tx) => tx.rows(`select id, kind, recipient_phone, body, requested_mode, status, sender_phone, provider_message_id, error, recipient_authorization,
        authorized_by, created_at, claimed_at, processed_at, delivered_at, error_detail, resolved_by, resolved_at, resolution_note from public.whatsapp_test_messages where kind in ('test', 'payment_receipt_preview') order by created_at desc limit 30`)));
  app.get('/whatsapp/test-messages/:id', { preHandler: requireSuper }, async (req, reply) => {
    const p = z.object({ id: z.string().uuid() }).safeParse(req.params); if (!p.success) return bad(reply);
    const r = await req.db((tx) => tx.one(`select * from public.whatsapp_test_messages where id=$1`, [p.data.id]));
    return r ?? reply.code(404).send({ error: 'not_found' });
  });
  // Resolver un resultado incierto TRAS revisar el chat: llegó (→ «enviado», nunca «entregado») o no llegó (→ «fallido»).
  app.post('/whatsapp/test-messages/:id/resolve', { preHandler: requireSuper }, async (req, reply) => {
    const p = z.object({ id: z.string().uuid() }).safeParse(req.params);
    const b = z.object({ arrived: z.boolean(), note: z.string().trim().max(300).optional() }).safeParse(req.body);
    if (!p.success || !b.success) return bad(reply);
    return req.db((tx) => tx.one(`select * from public.resolve_test_message($1,$2,$3)`, [p.data.id, b.data.arrived, b.data.note ?? null]));
  });
  app.post('/whatsapp/test-messages/:id/cancel', { preHandler: requireSuper }, async (req, reply) => {
    const p = z.object({ id: z.string().uuid() }).safeParse(req.params); if (!p.success) return bad(reply);
    return req.db((tx) => tx.one(`select * from public.cancel_test_message($1)`, [p.data.id]));
  });

  // ───── Mensajes individuales a conductores REGISTRADOS (ADMIN y SUPER_ADMIN). El número y la autorización salen de la ficha. ─────
  app.post('/messages/driver', { preHandler: requireAdmin }, async (req, reply) => {
    const b = z.object({ driverId: z.string().uuid(), body, idempotencyKey: z.string().min(8).max(100) }).safeParse(req.body);
    if (!b.success) return bad(reply);
    const m = await req.db((tx) => tx.one(`select * from public.create_driver_message($1,$2,$3)`, [b.data.driverId, b.data.body, b.data.idempotencyKey]));
    return reply.code(201).send(m);
  });
  app.get('/messages/driver', { preHandler: requireAdmin }, async (req, reply) => {
    const q = z.object({ driverId: z.string().uuid().optional() }).safeParse(req.query); if (!q.success) return bad(reply);
    return req.db((tx) => tx.rows(`select m.id, m.driver_id, m.recipient_phone, m.body, m.status, m.sender_phone, m.provider_message_id, m.error, m.error_detail,
        m.authorized_by, m.created_at, m.claimed_at, m.processed_at, m.delivered_at, m.resolved_by, m.resolved_at, m.resolution_note,
        d.first_name, d.last_name, d.operator_code
      from public.whatsapp_test_messages m join public.drivers d on d.id = m.driver_id
      where m.kind = 'driver_message' and ($1::uuid is null or m.driver_id = $1) order by m.created_at desc limit 50`, [q.data.driverId ?? null]));
  });
  app.post('/messages/driver/:id/resolve', { preHandler: requireAdmin }, async (req, reply) => {
    const p = z.object({ id: z.string().uuid() }).safeParse(req.params);
    const b = z.object({ arrived: z.boolean(), note: z.string().trim().max(300).optional() }).safeParse(req.body);
    if (!p.success || !b.success) return bad(reply);
    return req.db((tx) => tx.one(`select * from public.resolve_test_message($1,$2,$3)`, [p.data.id, b.data.arrived, b.data.note ?? null]));
  });
  app.post('/messages/driver/:id/cancel', { preHandler: requireAdmin }, async (req, reply) => {
    const p = z.object({ id: z.string().uuid() }).safeParse(req.params); if (!p.success) return bad(reply);
    return req.db((tx) => tx.one(`select * from public.cancel_test_message($1)`, [p.data.id]));
  });
};

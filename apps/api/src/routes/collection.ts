import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireAdmin, requireStaff } from '../plugins/auth.js';

const uuid = z.string().uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const ids = z.array(uuid).min(1).max(300);

/**
 * Tabla de cobranza y envío de mensajes por plantilla. La administradora NO registra pagos: los pagos, la cuota y el saldo llegan del Excel.
 * Aquí solo se consulta, se elige a quién escribir y con qué plantilla, y se confirma el envío.
 */
export const collectionRoutes: FastifyPluginAsync = async (app) => {
  const bad = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }) => reply.code(400).send({ error: 'invalid_body' });

  /** El saldo que se muestra y se comunica es el del Excel (último SALDO válido importado) para lo gestionado por el Excel; el devengo interno de cuotas no lo modifica. */
  const saldoOf = (r: Record<string, unknown>) => {
    if (!r.saldo_managed) return { pending: Number(r.pending_cents), credit: Number(r.credit_cents) };
    const v = r.saldo_excel_cents === null || r.saldo_excel_cents === undefined ? 0 : Number(r.saldo_excel_cents);
    return { pending: Math.max(v, 0), credit: Math.max(-v, 0) };
  };

  // Una fila por unidad con operario: importes calculados por la base + WhatsApp + último mensaje de cobranza.
  app.get('/collection/board', { preHandler: requireStaff }, async (req, reply) => {
    const q = z.object({ weekStart: date }).safeParse(req.query);
    if (!q.success) return bad(reply);
    // Resumen persistido (0052) si está disponible; mientras no se aplique, la consulta de siempre. Ambos dan las mismas columnas.
    // Las dos lecturas van en paralelo (cada una con su conexión): no dependen entre sí.
    const boardQuery = req.db(async (tx) => (await tx.one(`select to_regprocedure('public.collection_summary_rows(date)') is not null ok`))!.ok
      ? (await tx.rows(`select public.collection_summary_rows($1::date) d`, [q.data.weekStart])).map((x) => x.d as Record<string, any>)
      : tx.rows(`select w.assignment_id, w.driver_id, w.unit_id, w.unit_code, w.operator_code, w.full_name, w.driver_status, w.daily_rate_cents, w.net_cents, w.pending_cents,
                            w.credit_cents, w.previous_pending_cents, d.phone_e164, a.agreement_note, a.collect_commission, (to_jsonb(a) ->> 'send_default')::boolean send_by_excel, u.agreement, a.valid_to::text valid_to, e.managed saldo_managed, e.saldo_cents saldo_excel_cents, e.week_start::text saldo_week,
                            (select coalesce(sum(p.net_cents), 0) from public.payments p where p.assignment_id = w.assignment_id and p.voided_at is null
                                and (p.paid_at at time zone app_private.tz())::date = (now() at time zone app_private.tz())::date) paid_today_cents,
                            (select jsonb_agg(jsonb_build_object('date', d::date::text, 'due', coalesce(public.planned_daily_cents(w.assignment_id, d::date), 0),
                                      'paid', coalesce((select sum(x.amount_cents) from public.excel_payment_days x where x.assignment_id = w.assignment_id and x.pay_date = d::date), 0)) order by d)
                               from generate_series($1::date, $1::date + 6, interval '1 day') d) days,
                            (select t.total_cents from app_private.saldo_total(w.assignment_id, least((now() at time zone app_private.tz())::date, $1::date + 6)) t) total_cents,
                            (select t.commission_cents from app_private.saldo_total(w.assignment_id, least((now() at time zone app_private.tz())::date, $1::date + 6)) t) commission_cents
                       from public.weekly_collection_table($1::date) w
                       join public.drivers d on d.id = w.driver_id join public.assignments a on a.id = w.assignment_id join public.units u on u.id = w.unit_id
                       cross join lateral app_private.excel_saldo(w.assignment_id) e
                      order by w.unit_code`, [q.data.weekStart]));
    // Control de mensajes EXCLUSIVAMENTE del día actual (America/Panama): todos los mensajes de hoy de cada unidad, con plantilla, hora, estado y texto exacto.
    // A las 12:00 a. m. todo vuelve a cero por fecha (no hay nada que reiniciar); los mensajes de días anteriores no se muestran ni se consultan.
    const todayQuery = req.db((tx) => tx.rows(`select m.id, m.assignment_id, m.template_name, m.status, m.created_at, m.body, m.error from public.whatsapp_test_messages m
        where m.kind = 'collection_message' and m.assignment_id is not null and (m.created_at at time zone app_private.tz())::date = (now() at time zone app_private.tz())::date
        order by m.created_at`)).catch(() => []);
    const [rows, today] = await Promise.all([boardQuery, todayQuery]);
    const byAsg = new Map<string, { id: string; template: string; at: string; status: string; body: string; error: string | null }[]>();
    for (const m of today) { const l = byAsg.get(m.assignment_id as string) ?? []; l.push({ id: m.id as string, template: (m.template_name as string) ?? '—', at: m.created_at as string, status: m.status as string, body: m.body as string, error: (m.error as string) ?? null }); byAsg.set(m.assignment_id as string, l); }
    const todayDate = new Intl.DateTimeFormat('en-CA', { timeZone: app.config.APP_TIMEZONE }).format(new Date());
    return rows.map((r) => ({
      assignmentId: r.assignment_id, driverId: r.driver_id, unitCode: r.unit_code, operatorCode: r.operator_code, fullName: r.full_name, driverStatus: r.driver_status,
      phone: r.phone_e164 ?? null, dailyRateCents: Number(r.daily_rate_cents), paidWeekCents: Number(r.net_cents), pendingCents: saldoOf(r).pending, creditCents: saldoOf(r).credit, saldoMissing: !!r.saldo_managed && r.saldo_excel_cents === null, saldoSource: r.saldo_managed ? 'excel' : 'calculado', saldoWeek: r.saldo_week ?? null,
      days: ((r.days ?? []) as { date: string; due: number | string; paid: number | string }[]).map((d) => ({ date: d.date, dueCents: Number(d.due), paidCents: Number(d.paid) })), sendByExcel: r.send_by_excel ?? null, collectCommission: r.collect_commission !== false, commissionCents: Number(r.commission_cents ?? 0), totalCents: r.total_cents === null || r.total_cents === undefined ? null : Number(r.total_cents),
      paidTodayCents: Number(r.paid_today_cents ?? 0), previousPendingCents: Number(r.previous_pending_cents), agreement: r.agreement ?? r.agreement_note ?? null,
      ended: r.valid_to !== null && r.valid_to !== undefined && String(r.valid_to).slice(0, 10) <= todayDate,          // desvinculada: sin mensajes de cobranza
      messagesToday: byAsg.get(r.assignment_id as string) ?? [],
    }));
  });

  // «Sin confirmar»: tras mirar el chat, quien administra dice si llegaron. Todo o nada; la base decide quién puede y qué cuenta ve.
  app.post('/collection/resolve', { preHandler: requireAdmin }, async (req, reply) => {
    const b = z.object({ ids: z.array(uuid).min(1).max(500), arrived: z.boolean() }).safeParse(req.body);
    if (!b.success) return bad(reply);
    const r = await req.db((tx) => tx.one(`select count(*)::int n from unnest($1::uuid[]) x(id), lateral public.resolve_test_message(x.id, $2, null) r`, [b.data.ids, b.data.arrived]));
    return { resolved: r!.n as number };
  });

  // Comisión de pago (Yappy / Punto Pago): con el check activo, el importe comunicado suma $1.00. Por defecto activo.
  app.put('/collection/assignments/:id/commission', { preHandler: requireAdmin }, async (req, reply) => {
    const p = z.object({ id: uuid }).safeParse(req.params); const b = z.object({ on: z.boolean() }).safeParse(req.body);
    if (!p.success || !b.success) return bad(reply);
    await req.db((tx) => tx.rows(`select public.set_assignment_commission($1,$2)`, [p.data.id, b.data.on]));
    return reply.code(204).send();
  });

  // Última importación exitosa del Excel de cobranza (de ella salen todos los datos de los mensajes).
  app.get('/collection/last-sync', { preHandler: requireStaff }, async (req) => {
    const r = await req.db((tx) => tx.one(`select import_id, file_name, applied_at from public.last_collection_sync()`));
    return r && r.import_id ? { importId: r.import_id as string, fileName: r.file_name as string, appliedAt: r.applied_at as string } : null;
  });

  // Vista previa (solo lectura): por cada unidad, el mensaje REAL resuelto con la última importación o el motivo de exclusión. Misma validación que el envío.
  app.post('/collection/messages/preview', { preHandler: requireStaff }, async (req, reply) => {
    const b = z.object({ templateId: uuid, assignmentIds: ids }).safeParse(req.body);
    if (!b.success) return bad(reply);
    const wa = await req.db((tx) => tx.one(`select bool_or(status = 'connected') c from public.whatsapp_sessions`));
    const r = (await req.db((tx) => tx.one(`select public.preview_collection_messages($1::uuid[], $2) r`, [b.data.assignmentIds, b.data.templateId])))!.r as { lastSync: unknown; items: unknown[] };
    const simulated = app.config.WHATSAPP_DRY_RUN;          // modo de pruebas: los envíos se simulan (no salen por WhatsApp), así que no exige sesión conectada
    return { ...r, whatsappConnected: !!wa?.c || simulated, simulated };
  });

  // Envío confirmado: un mensaje por operario seleccionado, cada uno en su propia transacción (un fallo no frena a los demás).
  app.post('/collection/messages/send', { preHandler: requireAdmin }, async (req, reply) => {
    const b = z.object({ templateId: uuid, assignmentIds: ids, batchKey: z.string().min(8).max(60), repeat: z.boolean().default(false) }).safeParse(req.body);
    if (!b.success) return bad(reply);
    const wa = await req.db((tx) => tx.one(`select bool_or(status = 'connected') c from public.whatsapp_sessions`));
    if (!wa?.c && !app.config.WHATSAPP_DRY_RUN) return reply.code(409).send({ error: 'whatsapp_disconnected' });          // sin sesión conectada no se encola nada (salvo modo simulado)
    const results: { assignmentId: string; ok: boolean; status?: string; error?: string }[] = [];
    // En paralelo y por tandas de 8 (cada mensaje en su propia transacción): 100 destinatarios ya no superan el tiempo de espera del proxy.
    const one = async (id: string) => {
      try {
        const m = await req.db((tx) => tx.one(`select id, status from public.create_collection_message($1,$2,$3,$4)`, [id, b.data.templateId, `${b.data.batchKey}:${id}`, b.data.repeat]));
        return { assignmentId: id, ok: true, status: m!.status as string };
      } catch (e) {
        const msg = (e as { message?: string }).message ?? 'error';
        return { assignmentId: id, ok: false, error: /^[a-z_]+$/.test(msg) ? msg : 'send_failed' };
      }
    };
    for (let i = 0; i < b.data.assignmentIds.length; i += 8) results.push(...await Promise.all(b.data.assignmentIds.slice(i, i + 8).map(one)));
    return reply.code(200).send({ results, sent: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length });
  });

  // Historial OPERATIVO: solo los mensajes de HOY (America/Panama). Los de días anteriores se eliminan al empezar la jornada (purge_collection_messages) y no se consultan.
  // Cada mensaje: hora, operario, unidad, destinatario, plantilla, texto exacto, estado, error, responsable, lote e importación de referencia. Filtro opcional ?batch=<lote>.
  app.get('/collection/messages', { preHandler: requireAdmin }, async (req, reply) => {
    const q = z.object({ batch: z.string().max(80).optional() }).safeParse(req.query);
    if (!q.success) return bad(reply);
    const rows = await req.db((tx) => tx.rows(`select m.id, m.template_name, m.status, m.body, m.error, m.created_at, m.recipient_phone, m.variables, m.batch_id, d.operator_code, d.first_name, d.last_name,
        (select u.code from public.assignments a join public.units u on u.id = a.unit_id where a.id = m.assignment_id) unit_code,
        (select coalesce(nullif(p.full_name, ''), p.email) from public.profiles p where p.id = m.authorized_by) sent_by,
        i.file_name import_file, i.applied_at import_applied_at
      from public.whatsapp_test_messages m join public.drivers d on d.id = m.driver_id left join public.excel_imports i on i.id = m.import_id
      where m.kind = 'collection_message' and (m.created_at at time zone app_private.tz())::date = (now() at time zone app_private.tz())::date and ($1::text is null or m.batch_id = $1)
      order by m.created_at desc limit 500`, [q.data.batch ?? null]));
    return rows.map((r) => ({ id: r.id, template: r.template_name, status: r.status, body: r.body, error: r.error, at: r.created_at, phone: r.recipient_phone, operatorCode: r.operator_code,
      name: `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim(), unitCode: r.unit_code ?? null, sentBy: r.sent_by ?? null, importFile: r.import_file ?? null,
      importAppliedAt: r.import_applied_at ?? null, variables: r.variables ?? null, batchId: r.batch_id ?? null }));
  });

  // Lotes de envío masivo de HOY: un renglón por lote con plantilla, responsable, hora y conteo por estado.
  app.get('/collection/batches', { preHandler: requireAdmin }, async (req) => {
    const rows = await req.db((tx) => tx.rows(`select m.batch_id, min(m.created_at) first_at, max(m.created_at) last_at, (array_agg(m.template_name order by m.created_at))[1] template,
        (array_agg(coalesce(nullif(p.full_name, ''), p.email) order by m.created_at))[1] sent_by, count(*)::int total,
        count(*) filter (where m.status in ('prepared','processing'))::int queued, count(*) filter (where m.status in ('sent','delivered','simulated'))::int sent,
        count(*) filter (where m.status in ('failed','cancelled','unconfirmed'))::int failed
      from public.whatsapp_test_messages m left join public.profiles p on p.id = m.authorized_by
      where m.kind = 'collection_message' and m.batch_id is not null and (m.created_at at time zone app_private.tz())::date = (now() at time zone app_private.tz())::date
      group by m.batch_id order by min(m.created_at) desc limit 200`));
    return rows.map((r) => ({ batchId: r.batch_id, firstAt: r.first_at, lastAt: r.last_at, template: r.template, sentBy: r.sent_by ?? null, total: r.total, queued: r.queued, sent: r.sent, failed: r.failed }));
  });

  // Saldo de una asignación para la ficha del conductor: el del Excel si la gestiona el Excel; si no, el cálculo anterior (managed=false).
  app.get<{ Params: { id: string } }>('/assignments/:id/saldo', { preHandler: requireStaff }, async (req, reply) => {
    const id = uuid.safeParse(req.params.id); if (!id.success) return bad(reply);
    const r = await req.db((tx) => tx.one(`select e.managed, e.saldo_cents, e.week_start::text week_start from app_private.excel_saldo($1) e`, [id.data]));
    return { managed: !!r?.managed, saldoCents: r?.saldo_cents === null || r?.saldo_cents === undefined ? null : Number(r.saldo_cents), weekStart: r?.week_start ?? null };
  });
};

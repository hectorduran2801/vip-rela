import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MON, chargeWeek, pay } from './fixtures.js';
import { newDb, type Db, type Q } from './harness.js';

let db: Db; let n = 0;
beforeAll(async () => { db = await newDb(); });
afterAll(async () => { await db.close(); });
const sup = <T>(fn: (q: Q) => Promise<T>) => db.as(db.admin, fn);       // db.admin = SUPER_ADMIN
const svc = <T>(fn: (q: Q) => Promise<T>) => db.asService(fn);
const k = () => `tm-${++n}-${Math.random().toString(36).slice(2)}`;
const PHONE = '+507 6000-0001';
const mk = (o: Partial<{ phone: string; body: string; mode: string; key: string; auth: string | null; last4: string | null; kind: string }> = {}) =>
  sup((q) => q.one(`select * from public.create_test_message($1,$2,$3,$4,$5,$6,$7)`, [o.phone ?? PHONE, o.body ?? 'Mensaje de prueba', o.mode ?? 'simulated', o.key ?? k(), o.auth ?? null, o.last4 ?? null, o.kind ?? 'test']));
const claim = () => svc((q) => q.one(`select * from public.claim_test_message()`));
const complete = (id: string, outcome: string, sender: string | null = null, prov: string | null = null, err: string | null = null) =>
  svc((q) => q.one(`select * from public.complete_test_message($1,$2,$3,$4,$5)`, [id, outcome, sender, prov, err]));
/** Deja la cola de pruebas vacía (cierra como failed lo que quede preparado/en proceso). */
const drain = async () => { let c; do { c = await claim(); if (c?.id) await complete(c.id, 'failed', null, null, 'limpieza'); } while (c?.id); };

describe('mensajes de prueba de WhatsApp', () => {
  it('solo SUPER_ADMIN puede crear, ver y cancelar; los demás roles y anon no', async () => {
    for (const who of [db.opsAdmin, db.supervisor, db.outsider]) {
      expect(await db.as(who, (q) => q.fails(`select * from public.create_test_message($1,'x','simulated',$2)`, [PHONE, k()]))).toBe('forbidden');
    }
    expect(await db.asAnon((q) => q.fails(`select * from public.create_test_message($1,'x','simulated',$2)`, [PHONE, k()]))).toMatch(/permission denied/);
    const m = await mk();
    expect((await db.as(db.opsAdmin, (q) => q.rows(`select * from public.whatsapp_test_messages`))).length).toBe(0);   // RLS: solo super
    expect((await sup((q) => q.rows(`select id from public.whatsapp_test_messages where id=$1`, [m.id]))).length).toBe(1);
    expect(await db.as(db.opsAdmin, (q) => q.fails(`select public.cancel_test_message($1)`, [m.id]))).toBe('forbidden');
  });
  it('nace «prepared», normaliza el número y registra al usuario que autorizó + auditoría', async () => {
    const m = await mk();
    expect(m).toMatchObject({ status: 'prepared', recipient_phone: '+50760000001', requested_mode: 'simulated', authorized_by: db.admin, sender_phone: null, provider_message_id: null });
    expect((await db.su.query(`select count(*)::int c from public.audit_logs where action='whatsapp.test_message.created' and entity_id=$1`, [m.id])).rows[0].c).toBe(1);
    expect(await sup((q) => q.fails(`select * from public.create_test_message('12','x','simulated',$1)`, [k()]))).toBe('invalid_phone');
    expect(await sup((q) => q.fails(`select * from public.create_test_message($1,'  ','simulated',$2)`, [PHONE, k()]))).toMatch(/check|violates/);
  });
  it('idempotente: la misma clave devuelve el mismo mensaje (sin duplicar)', async () => {
    const key = k(); const a = await mk({ key }); const b = await mk({ key });
    expect(b.id).toBe(a.id);
    expect((await db.su.query(`select count(*)::int c from public.whatsapp_test_messages where idempotency_key=$1`, [key])).rows[0].c).toBe(1);
  });
  it('rechaza números que pertenecen a un conductor', async () => {
    const x = await db.driverWithAssignment({ code: 'TM1', unit: 'TMU1', dailyCents: 3600 });
    await db.su.query(`update public.drivers set phone_e164='+50761112222' where id=$1`, [x.driver]);
    expect(await sup((q) => q.fails(`select * from public.create_test_message('+507 6111-2222','x','simulated',$1)`, [k()]))).toBe('recipient_is_a_driver');
  });
  it('modo real exige declaración del destinatario, confirmación de los últimos 4 dígitos y una sola operación pendiente', async () => {
    await drain();
    expect(await sup((q) => q.fails(`select * from public.create_test_message($1,'x','real',$2)`, [PHONE, k()]))).toBe('recipient_authorization_required');
    expect(await sup((q) => q.fails(`select * from public.create_test_message($1,'x','real',$2,'Yo mismo','9999')`, [PHONE, k()]))).toBe('confirm_last4_mismatch');
    const ok = await mk({ mode: 'real', auth: 'Propietario', last4: '0001' });
    expect(ok).toMatchObject({ requested_mode: 'real', recipient_authorization: 'Propietario', status: 'prepared' });
    expect(await sup((q) => q.fails(`select * from public.create_test_message($1,'otro','real',$2,'Propietario','0001')`, [PHONE, k()]))).toBe('real_test_already_pending');
    await sup((q) => q.one(`select * from public.cancel_test_message($1)`, [ok.id]));
    expect((await mk({ mode: 'real', auth: 'Propietario', last4: '0001' })).status).toBe('prepared');   // cancelado ⇒ se puede preparar otro
    await drain();
  });
  it('ciclo del worker: claim → simulated; un mensaje solo se procesa una vez', async () => {
    await drain();
    const m = await mk();
    const c = await claim();
    expect(c).toMatchObject({ id: m.id, status: 'processing' });
    expect((await claim())?.id ?? null).toBeNull();
    expect(await complete(m.id, 'simulated', '+50760009999', 'dryrun-1')).toMatchObject({ status: 'simulated', sender_phone: '+50760009999', provider_message_id: 'dryrun-1' });
    expect(await svc((q) => q.fails(`select * from public.complete_test_message($1,'simulated')`, [m.id]))).toBe('not_processing');
  });
  it('«sent» solo en modo real; «delivered» solo por acuse del proveedor y solo desde «sent»', async () => {
    await drain();
    const sim = await mk(); await claim();
    expect(await svc((q) => q.fails(`select * from public.complete_test_message($1,'sent')`, [sim.id]))).toBe('sent_requires_real_mode');
    await drain();
    const real = await mk({ mode: 'real', auth: 'Propietario', last4: '0001' }); await claim();
    const s = await complete(real.id, 'sent', '+50760009999', 'wamid-1');
    expect(s.status).toBe('sent');
    expect(s.delivered_at).toBeNull();                                     // aceptado por el proveedor ≠ entregado
    expect(await svc((q) => q.one(`select public.ack_test_message('desconocido') ok`))).toMatchObject({ ok: false });
    expect(await svc((q) => q.one(`select public.ack_test_message('wamid-1') ok`))).toMatchObject({ ok: true });
    expect(await sup((q) => q.one(`select status, delivered_at from public.whatsapp_test_messages where id=$1`, [real.id]))).toMatchObject({ status: 'delivered' });
  });
  it('un fallo guarda el error técnico; los atascados se marcan failed y NO se reintentan', async () => {
    await drain();
    const m = await mk(); await claim();
    expect((await complete(m.id, 'failed', null, null, 'timeout enviando mensaje')).error).toBe('timeout enviando mensaje');
    const s = await mk(); await claim();
    await db.su.query(`update public.whatsapp_test_messages set claimed_at = now() - interval '1 hour' where id=$1`, [s.id]);
    expect((await svc((q) => q.one(`select public.fail_stuck_test_messages('5 minutes') n`))).n).toBeGreaterThanOrEqual(1);
    expect((await claim())?.id ?? null).toBeNull();
    expect((await db.su.query(`select status from public.whatsapp_test_messages where id=$1`, [s.id])).rows[0].status).toBe('failed');
  });
  it('las funciones del worker no son ejecutables por usuarios ni anon; sin escritura directa', async () => {
    for (const f of [`public.claim_test_message()`, `public.complete_test_message(gen_random_uuid(),'failed')`, `public.ack_test_message('x')`]) {
      expect(await sup((q) => q.fails(`select * from ${f}`))).toMatch(/permission denied/);
      expect(await db.asAnon((q) => q.fails(`select * from ${f}`))).toMatch(/permission denied/);
    }
    expect(await sup((q) => q.fails(`update public.whatsapp_test_messages set status='delivered'`))).toMatch(/permission denied/);
    expect(await sup((q) => q.fails(`delete from public.whatsapp_test_messages`))).toMatch(/permission denied/);
  });
});

describe('resultado sin confirmar (envío real incierto)', () => {
  const real = () => mk({ mode: 'real', auth: 'Propietario', last4: '0001' });
  it('un resultado incierto NO es fallo: queda «unconfirmed», conserva el detalle y no es reintentable', async () => {
    await drain();
    const m = await real(); await claim();
    const u = await svc((q) => q.one(`select * from public.complete_test_message($1,'unconfirmed','+50760009999',null,'Resultado sin confirmar','sendText could not confirm the result')`, [m.id]));
    expect(u).toMatchObject({ status: 'unconfirmed', sender_phone: '+50760009999', error_detail: 'sendText could not confirm the result', provider_message_id: null });
    expect((await claim())?.id ?? null).toBeNull();                                           // no se vuelve a procesar
    expect(await svc((q) => q.fails(`select * from public.complete_test_message($1,'sent')`, [m.id]))).toBe('not_processing');
  });
  it('«unconfirmed» solo existe en modo real', async () => {
    await drain(); const m = await mk(); await claim();
    expect(await svc((q) => q.fails(`select * from public.complete_test_message($1,'unconfirmed')`, [m.id]))).toBe('unconfirmed_requires_real_mode');
    await drain();
  });
  it('mientras haya un real incierto sin resolver NO se permite otro real (evita duplicados); los simulados siguen', async () => {
    await drain(); await db.su.query(`update public.whatsapp_test_messages set status='failed' where status='unconfirmed'`);
    const m = await real(); await claim(); await complete(m.id, 'unconfirmed', null, null, 'incierto');
    expect(await sup((q) => q.fails(`select * from public.create_test_message($1,'otro','real',$2,'Propietario','0001')`, [PHONE, k()]))).toBe('unconfirmed_result_pending');
    expect((await mk()).status).toBe('prepared');                                              // simulado: permitido
    await drain();
  });
  it('un SUPER_ADMIN lo resuelve tras revisar el chat: llegó → «sent» (nunca «delivered»); no llegó → «failed»; queda constancia', async () => {
    await drain(); await db.su.query(`update public.whatsapp_test_messages set status='failed' where status='unconfirmed'`);
    const a = await real(); await claim(); await complete(a.id, 'unconfirmed', null, null, 'incierto');
    expect(await db.as(db.opsAdmin, (q) => q.fails(`select * from public.resolve_test_message($1,true)`, [a.id]))).toBe('forbidden');
    const r = await sup((q) => q.one(`select * from public.resolve_test_message($1,true,'lo vi en el chat')`, [a.id]));
    expect(r).toMatchObject({ status: 'sent', resolved_by: db.admin, resolution_note: 'lo vi en el chat', delivered_at: null });
    expect(await sup((q) => q.fails(`select * from public.resolve_test_message($1,false)`, [a.id]))).toBe('not_unconfirmed');
    const b = await real(); await claim(); await complete(b.id, 'unconfirmed', null, null, 'incierto');
    expect((await sup((q) => q.one(`select * from public.resolve_test_message($1,false)`, [b.id]))).status).toBe('failed');
    expect((await real()).status).toBe('prepared');                                            // resuelto: se puede preparar otro
    await drain();
  });
  it('un real atascado tras una caída queda INCIERTO (pudo salir) y un simulado atascado, fallido', async () => {
    await drain(); await db.su.query(`update public.whatsapp_test_messages set status='failed' where status='unconfirmed'`);
    const r = await real(); await claim(); await db.su.query(`update public.whatsapp_test_messages set claimed_at = now() - interval '1 hour' where id=$1`, [r.id]);
    await svc((q) => q.one(`select public.fail_stuck_test_messages('5 minutes') n`));
    expect((await db.su.query(`select status from public.whatsapp_test_messages where id=$1`, [r.id])).rows[0].status).toBe('unconfirmed');
    await db.su.query(`update public.whatsapp_test_messages set status='failed' where status='unconfirmed'`);
  });
});

describe('comprobante de pago (vista previa con datos de prueba)', () => {
  const prev = (m: string, g: number, d: number, unit = 'P811') => sup((q) => q.one(`select public.preview_payment_receipt($1,$2,$3,$4) r`, [unit, m, g, d])).then((x) => x.r);
  it('Yappy $30 con deuda $36: comisión $1, abono $29, pendiente $7 — sin registrar ningún pago', async () => {
    const cnt = async () => (await db.su.query(`select (select count(*) from public.payments)::int p, (select count(*) from public.notification_jobs)::int j`)).rows[0];
    const before = await cnt();
    const r = await prev('yappy', 3000, 3600);
    expect(r).toMatchObject({ gross_cents: 3000, commission_cents: 100, net_cents: 2900, pending_cents: 700, credit_cents: 0 });
    for (const line of ['Unidad: P811', 'Monto entregado: $30.00', 'Comisión del proveedor: $1.00', 'Abono a su cuenta: $29.00', 'Saldo pendiente: $7.00']) expect(r.body).toContain(line);
    expect(await cnt()).toEqual(before);
  });
  it('efectivo sin comisión, pago completo y crédito', async () => {
    expect(await prev('cash', 3600, 3600)).toMatchObject({ commission_cents: 0, net_cents: 3600, pending_cents: 0 });
    expect((await prev('cash', 3600, 3600)).body).toContain('Su cuenta está al día.');
    expect(await prev('yappy', 4000, 3600)).toMatchObject({ net_cents: 3900, pending_cents: 0, credit_cents: 300 });
    expect((await prev('yappy', 4000, 3600)).body).toContain('Saldo a favor: $3.00');
  });
  it('el texto es IDÉNTICO al comprobante real que prepara la cola', async () => {
    const x = await db.driverWithAssignment({ code: 'TM2', unit: 'TMU2', dailyCents: 3600 }); await chargeWeek(db, MON);
    await db.su.query(`update public.drivers set phone_e164='+50769990000', whatsapp_consent=true, whatsapp_consent_at=now() where id=$1`, [x.driver]);
    const p = await sup((q) => pay(q, x.assignment, 'yappy', 3000, { receipt: true, paidAt: `${MON}T10:00:00-05:00` }));
    await svc((q) => q.rows(`select * from public.claim_notification_jobs(500, now() + interval '1 day')`));
    const real = (await svc((q) => q.one(`select public.prepare_notification_send($1) p`, [p.receipt_job_id]))).p;
    const pos = await sup((q) => q.one(`select pending_cents, credit_cents from public.assignment_position($1, null)`, [x.assignment]));
    const r = await prev('yappy', 3000, Number(pos.pending_cents) + 2900, 'TMU2');
    expect(r.pending_cents).toBe(Number(pos.pending_cents));
    expect(real).toMatchObject({ action: 'send' }); expect(real.body).toBe(r.body);
  });
  it('valida método, importes y permisos', async () => {
    expect(await sup((q) => q.fails(`select public.preview_payment_receipt('P811','paloma',3000,3600)`))).toBe('method_not_found');
    expect(await sup((q) => q.fails(`select public.preview_payment_receipt('P811','cash',0,3600)`))).toBe('invalid_amount');
    expect(await db.as(db.supervisor, (q) => q.fails(`select public.preview_payment_receipt('P811','cash',100,3600)`))).toBe('forbidden');
  });
  it('el comprobante de prueba pasa por la cola de pruebas (kind payment_receipt_preview)', async () => {
    await drain();
    const body = (await prev('yappy', 3000, 3600)).body;
    expect(await mk({ body, kind: 'payment_receipt_preview' })).toMatchObject({ kind: 'payment_receipt_preview', status: 'prepared' });
    await drain();
  });
});

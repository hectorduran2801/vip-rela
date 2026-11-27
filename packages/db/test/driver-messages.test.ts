import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newDb, type Db, type Q } from './harness.js';

let db: Db; let n = 0;
beforeAll(async () => { db = await newDb(); await db.su.query(`update public.app_settings set min_minutes_between = 60`); });
afterAll(async () => { await db.close(); });
const adm = <T>(fn: (q: Q) => Promise<T>) => db.as(db.opsAdmin, fn);       // ADMIN
const sup = <T>(fn: (q: Q) => Promise<T>) => db.as(db.admin, fn);
const svc = <T>(fn: (q: Q) => Promise<T>) => db.asService(fn);
const key = () => `dm-${++n}-${Math.random().toString(36).slice(2)}`;
const driver = async (o: { consent?: boolean; phone?: string | null } = {}) => {
  n += 1; const x = await db.driverWithAssignment({ code: `DM${n}`, unit: `DMU${n}`, dailyCents: 3600 });
  await db.su.query(`update public.drivers set phone_e164=$2 where id=$1`, [x.driver, o.phone === null ? null : (o.phone ?? `+5076888${String(1000 + n)}`)]);
  if (o.consent !== false && o.phone !== null) await adm((q) => q.one(`select public.set_driver_consent($1,'collection',true,'verbal_admin') r`, [x.driver]));
  return x;
};
const send = (d: string, body = 'Hola', k = key()) => adm((q) => q.one(`select * from public.create_driver_message($1,$2,$3)`, [d, body, k]));
const claim = () => svc((q) => q.one(`select * from public.claim_test_message()`));
const complete = (id: string, o: string, prov: string | null = null, err: string | null = null) => svc((q) => q.one(`select * from public.complete_test_message($1,$2,'+50760009999',$3,$4)`, [id, o, prov, err]));
const drain = async () => { let c; do { c = await claim(); if (c?.id) await complete(c.id, 'failed', null, 'limpieza'); } while (c?.id); };

describe('mensaje a un conductor registrado', () => {
  it('flujo simple: solo conductor + mensaje; el número sale de la ficha; no pide autorización ni dígitos', async () => {
    await drain(); const x = await driver();
    const m = await send(x.driver, '  Hola, recuerda tu pago  ');
    const phone = (await db.su.query(`select phone_e164 from public.drivers where id=$1`, [x.driver])).rows[0].phone_e164;
    expect(m).toMatchObject({ kind: 'driver_message', driver_id: x.driver, recipient_phone: phone, requested_mode: 'auto', status: 'prepared', body: 'Hola, recuerda tu pago', authorized_by: db.opsAdmin, recipient_authorization: null });
    expect((await db.su.query(`select count(*)::int c from public.audit_logs where action='whatsapp.driver_message.created' and entity_id=$1`, [m.id])).rows[0].c).toBe(1);
  });
  it('SUPER_ADMIN también puede; sin rol y anon no', async () => {
    const x = await driver();
    expect((await sup((q) => q.one(`select * from public.create_driver_message($1,'hola',$2)`, [x.driver, key()]))).status).toBe('prepared');
    const y = await driver();
    expect(await db.as(db.outsider, (q) => q.fails(`select * from public.create_driver_message($1,'hola',$2)`, [y.driver, key()]))).toBe('forbidden');
    expect(await db.asAnon((q) => q.fails(`select * from public.create_driver_message($1,'hola',$2)`, [y.driver, key()]))).toMatch(/permission denied/);
  });
  it('BLOQUEA sin consentimiento, con consentimiento retirado, sin teléfono o con conductor inactivo', async () => {
    const a = await driver({ consent: false });
    expect(await adm((q) => q.fails(`select * from public.create_driver_message($1,'hola',$2)`, [a.driver, key()]))).toBe('consent_required');
    const b = await driver(); await adm((q) => q.one(`select public.set_driver_consent($1,'collection',false,null)`, [b.driver]));
    expect(await adm((q) => q.fails(`select * from public.create_driver_message($1,'hola',$2)`, [b.driver, key()]))).toBe('consent_required');
    const c = await driver({ phone: null });
    expect(await adm((q) => q.fails(`select * from public.create_driver_message($1,'hola',$2)`, [c.driver, key()]))).toBe('driver_without_phone');
    const d = await driver(); await db.su.query(`update public.drivers set status='inactive' where id=$1`, [d.driver]);
    expect(await adm((q) => q.fails(`select * from public.create_driver_message($1,'hola',$2)`, [d.driver, key()]))).toBe('driver_inactive');
    expect(await adm((q) => q.fails(`select * from public.create_driver_message(gen_random_uuid(),'hola',$1)`, [key()]))).toBe('driver_not_found');
    expect(await adm((q) => q.fails(`select * from public.create_driver_message($1,'  ',$2)`, [d.driver, key()]))).toBe('invalid_body');
  });
  it('consentimiento PROMOCIONAL no autoriza mensajes de cobranza (finalidades separadas)', async () => {
    const x = await driver({ consent: false });
    await adm((q) => q.one(`select public.set_driver_consent($1,'promotional',true,'signed_form')`, [x.driver]));
    expect(await adm((q) => q.fails(`select * from public.create_driver_message($1,'hola',$2)`, [x.driver, key()]))).toBe('consent_required');
  });
  it('idempotente y sin duplicados: misma clave = mismo mensaje; clave reutilizada con otro conductor es conflicto', async () => {
    await drain(); const x = await driver(); const y = await driver(); const k = key();
    const a = await send(x.driver, 'hola', k); const b = await send(x.driver, 'hola', k);
    expect(b.id).toBe(a.id);
    expect(await adm((q) => q.fails(`select * from public.create_driver_message($1,'hola',$2)`, [y.driver, k]))).toBe('idempotency_conflict');
    expect((await db.su.query(`select count(*)::int c from public.whatsapp_test_messages where idempotency_key=$1`, [k])).rows[0].c).toBe(1);
    // doble clic concurrente con claves distintas: la separación mínima deja pasar solo uno
    const z = await driver();
    const rs = await Promise.allSettled(Array.from({ length: 5 }, () => send(z.driver)));
    expect(rs.filter((r) => r.status === 'fulfilled').length).toBe(1);
  });
  it('respeta la separación mínima entre mensajes (too_soon) y deja pasar tras ese tiempo', async () => {
    await drain(); const x = await driver(); await send(x.driver);
    expect(await adm((q) => q.fails(`select * from public.create_driver_message($1,'otro',$2)`, [x.driver, key()]))).toBe('too_soon');
    await db.su.query(`update public.whatsapp_test_messages set created_at = now() - interval '2 hours' where driver_id=$1`, [x.driver]);
    expect((await send(x.driver)).status).toBe('prepared');
    await drain();
  });
  it('el consentimiento retirado ANTES de enviar cancela el mensaje preparado (verificación final)', async () => {
    await drain(); const x = await driver(); const m = await send(x.driver);
    await adm((q) => q.one(`select public.set_driver_consent($1,'collection',false,null)`, [x.driver]));
    expect((await claim())?.id ?? null).toBeNull();
    expect((await db.su.query(`select status, error from public.whatsapp_test_messages where id=$1`, [m.id])).rows[0]).toMatchObject({ status: 'cancelled', error: expect.stringMatching(/autorización/) });
  });
  it('un envío incierto a un conductor bloquea nuevos envíos a ESE conductor; ADMIN lo resuelve; los demás conductores no se ven afectados', async () => {
    await drain(); const x = await driver(); const y = await driver();
    const m = await send(x.driver); await claim(); await complete(m.id, 'unconfirmed', null, 'incierto');
    await db.su.query(`update public.whatsapp_test_messages set created_at = now() - interval '3 hours' where id=$1`, [m.id]);
    expect(await adm((q) => q.fails(`select * from public.create_driver_message($1,'otro',$2)`, [x.driver, key()]))).toBe('unconfirmed_result_pending');
    expect((await send(y.driver)).status).toBe('prepared');
    expect((await adm((q) => q.one(`select * from public.resolve_test_message($1,true,'llegó')`, [m.id]))).status).toBe('sent');
    expect((await send(x.driver)).status).toBe('prepared');
    await drain();
  });
  it('visibilidad por rol: ADMIN ve solo los mensajes a conductores; SUPER_ADMIN ve todos; los de prueba externos son solo de SUPER_ADMIN', async () => {
    await drain(); const x = await driver(); const dm = await send(x.driver);
    const t = await sup((q) => q.one(`select * from public.create_test_message('+507 6000-0044','prueba','simulated',$1)`, [key()]));
    const seenAdm = (await adm((q) => q.rows(`select id from public.whatsapp_test_messages`))).map((r) => r.id);
    expect(seenAdm).toContain(dm.id); expect(seenAdm).not.toContain(t.id);
    const seenSup = (await sup((q) => q.rows(`select id from public.whatsapp_test_messages`))).map((r) => r.id);
    expect(seenSup).toEqual(expect.arrayContaining([dm.id, t.id]));
    expect(await adm((q) => q.fails(`select * from public.create_test_message('+507 6000-0045','x','simulated',$1)`, [key()]))).toBe('forbidden');
    expect(await adm((q) => q.fails(`select * from public.cancel_test_message($1)`, [t.id]))).toBe('forbidden');
    expect((await adm((q) => q.one(`select * from public.cancel_test_message($1)`, [dm.id]))).status).toBe('cancelled');
    await drain();
  });
  it('cierre: «sent» en modo auto es posible; «delivered» solo por acuse; simulado nunca «sent»', async () => {
    await drain(); const x = await driver(); const m = await send(x.driver); await claim();
    expect((await complete(m.id, 'sent', 'wamid-9')).status).toBe('sent');
    expect(await svc((q) => q.one(`select public.ack_test_message('wamid-9') ok`))).toMatchObject({ ok: true });
  });
});

describe('prueba externa simplificada', () => {
  it('ya no exige los últimos 4 dígitos; sí la declaración del destinatario; sigue un solo real pendiente', async () => {
    await drain();
    expect(await sup((q) => q.fails(`select * from public.create_test_message('+507 6000-0050','x','real',$1)`, [key()]))).toBe('recipient_authorization_required');
    const m = await sup((q) => q.one(`select * from public.create_test_message('+507 6000-0050','x','real',$1,'Confirmado por la administradora')`, [key()]));
    expect(m).toMatchObject({ requested_mode: 'real', recipient_authorization: 'Confirmado por la administradora' });
    expect(await sup((q) => q.fails(`select * from public.create_test_message('+507 6000-0051','x','real',$1,'Confirmado')`, [key()]))).toBe('real_test_already_pending');
    expect(await sup((q) => q.fails(`select * from public.create_test_message('+507 6000-0052','x','real',$1,'Confirmado','9999')`, [key()]))).toMatch(/confirm_last4_mismatch|real_test_already_pending/);
    await drain();
  });
});

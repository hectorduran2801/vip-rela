import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newDb, type Db } from './support/harness.js';
import { realFake, seedDriver } from './support/fixtures.js';
import { Db as WorkerDb } from '../src/db.js';
import { DryRunAdapter } from '../src/adapters/dry-run.js';
import { FakeAdapter } from '../src/adapters/fake.js';
import { silentLogger } from '../src/log.js';
import { TestMessageProcessor, isUncertain } from '../src/queue/test-messages.js';
import { loadConfig } from '../src/config.js';

let db: Db; let n = 0; const open: WorkerDb[] = [];
beforeEach(async () => { db = await newDb(); });
afterEach(async () => { await Promise.all(open.splice(0).map((w) => w.close())); await db.close(); });

const PHONE = '+507 6000-0001';
const create = (o: { mode?: 'simulated' | 'real'; body?: string; phone?: string } = {}) => db.as(db.admin, (q) => q.one(
  `select * from public.create_test_message($1,$2,$3,$4,$5,$6)`,
  [o.phone ?? PHONE, o.body ?? 'Prueba VIP', o.mode ?? 'simulated', `w-${++n}-${Math.random()}`, o.mode === 'real' ? 'Propietario' : null, o.mode === 'real' ? '0001' : null]));
const row = async (id: string) => (await db.su.query(`select * from public.whatsapp_test_messages where id=$1`, [id])).rows[0];
function make(o: { real?: FakeAdapter | null; realTestEnabled?: boolean } = {}) {
  const w = new WorkerDb(db.connection, 3); open.push(w);
  const dry = new DryRunAdapter();
  const real = o.real === undefined ? null : o.real;
  const proc = new TestMessageProcessor({ db: w, log: silentLogger(), dryRunAdapter: dry, senders: { senderFor: () => real, anyConnected: () => !!real }, realTestEnabled: o.realTestEnabled ?? false });
  return { proc, dry };
}

describe('mensajes de prueba en el worker', () => {
  it('modo simulado: no toca el adaptador real, queda «simulated» con emisor y id simulado', async () => {
    const real = await realFake();
    const m = await create(); const { proc, dry } = make({ real, realTestEnabled: true });
    expect(await proc.tick()).toMatchObject({ id: m.id, status: 'simulated' });
    expect(real.calls).toHaveLength(0);
    expect(dry.sent).toHaveLength(1);
    expect(await row(m.id)).toMatchObject({ status: 'simulated', provider_message_id: 'dryrun-1', error: null });
  });
  it('sin mensajes pendientes no hace nada', async () => {
    const { proc } = make(); expect(await proc.tick()).toBeNull();
  });
  it('modo real SIN el interruptor del servidor: falla con motivo claro y NO envía ni simula', async () => {
    const real = await realFake(); const m = await create({ mode: 'real' });
    const { proc, dry } = make({ real, realTestEnabled: false });
    expect(await proc.tick()).toMatchObject({ status: 'failed' });
    expect(real.calls).toHaveLength(0); expect(dry.sent).toHaveLength(0);
    expect((await row(m.id)).error).toMatch(/real_send_disabled/);
  });
  it('modo real con interruptor y sesión conectada: UNA sola llamada al proveedor, estado «sent» (nunca «delivered»)', async () => {
    const real = await realFake(); const m = await create({ mode: 'real', body: 'Hola prueba' });
    const { proc } = make({ real, realTestEnabled: true });
    expect(await proc.tick()).toMatchObject({ status: 'sent' });
    expect(real.calls).toEqual([{ phone: '+50760000001', body: 'Hola prueba' }]);
    expect(await row(m.id)).toMatchObject({ status: 'sent', provider_message_id: 'fake-1', delivered_at: null });
    expect(await proc.tick()).toBeNull();                                // no se vuelve a enviar
    expect(real.calls).toHaveLength(1);
  });
  it('modo real sin sesión conectada: falla («sin_sesion») y no reintenta', async () => {
    const m = await create({ mode: 'real' }); const { proc } = make({ real: null, realTestEnabled: true });
    expect(await proc.tick()).toMatchObject({ status: 'failed' });
    expect((await row(m.id)).error).toMatch(/sin_sesion/);
    expect(await proc.tick()).toBeNull();
  });
  it('error del proveedor: failed con el motivo, sin reintento automático', async () => {
    const real = await realFake(); real.failNextSends(1, 'chat no encontrado');
    const m = await create({ mode: 'real' }); const { proc } = make({ real, realTestEnabled: true });
    expect(await proc.tick()).toMatchObject({ status: 'failed' });
    expect((await row(m.id)).error).toContain('chat no encontrado');
    expect(await proc.tick()).toBeNull(); expect(real.calls).toHaveLength(0);
  });
  it('no atiende la cola de cobranza ni a conductores: solo whatsapp_test_messages', async () => {
    await seedDriver(db, '9'); const before = (await db.su.query(`select count(*)::int c from public.notification_jobs`)).rows[0].c;
    const real = await realFake(); const { proc } = make({ real, realTestEnabled: true });
    await proc.tick();
    expect((await db.su.query(`select count(*)::int c from public.notification_jobs where status <> 'pending'`)).rows[0].c).toBe(0);
    expect((await db.su.query(`select count(*)::int c from public.notification_jobs`)).rows[0].c).toBe(before);
    expect(real.calls).toHaveLength(0);
  });

  it('clasifica los errores: «sin confirmar» (incierto) vs «fallido confirmado»', () => {
    expect(isUncertain(new Error('sendText could not confirm the result. The message may have been sent; check the chat before retrying.'))).toBe(true);
    expect(isUncertain(Object.assign(new Error('x'), { outcome: 'unknown' }))).toBe(true);
    expect(isUncertain(new Error('timeout enviando mensaje'))).toBe(true);
    expect(isUncertain(Object.assign(new Error('Not a contact'), { outcome: 'not_sent' }))).toBe(false);
    expect(isUncertain(Object.assign(new Error('could not confirm the result'), { outcome: 'not_sent' }))).toBe(false);
    expect(isUncertain(new Error('chat no encontrado'))).toBe(false);
  });
  it('REPRODUCE el caso real (sendText no confirma): queda «unconfirmed» con detalle técnico, NO se reintenta y bloquea otro real', async () => {
    const real = await realFake(); real.failNextSends(1, 'sendText could not confirm the result. The message may have been sent; check the chat before retrying.');
    const m = await create({ mode: 'real' }); const { proc } = make({ real, realTestEnabled: true });
    expect(await proc.tick()).toMatchObject({ id: m.id, status: 'unconfirmed' });
    expect(await row(m.id)).toMatchObject({ status: 'unconfirmed', provider_message_id: null });
    expect((await row(m.id)).error).toMatch(/sin confirmar/i); expect((await row(m.id)).error_detail).toMatch(/could not confirm/);
    expect(await proc.tick()).toBeNull(); expect(real.calls).toHaveLength(0);                    // jamás se reenvía solo
    await expect(create({ mode: 'real' })).rejects.toThrow(/unconfirmed_result_pending/);
  });
  it('un error CONFIRMADO de no envío sí es «failed»', async () => {
    const real = await realFake(); real.failNextSends(1, 'Not a contact');
    const m = await create({ mode: 'real' }); const { proc } = make({ real, realTestEnabled: true });
    expect(await proc.tick()).toMatchObject({ status: 'failed' }); expect((await row(m.id)).status).toBe('failed');
  });
  it('conductor registrado («auto»): con WHATSAPP_DRY_RUN=true se SIMULA; con false se envía de verdad por la sesión; sin sesión falla', async () => {
    const x = await seedDriver(db, '7'); await db.admin; 
    await db.as(db.admin, (q) => q.one(`select public.set_driver_consent($1,'collection',true,'verbal_admin')`, [x.driver]));
    const mk = (dry: boolean, real: FakeAdapter | null) => { const w = new WorkerDb(db.connection, 3); open.push(w); const dryA = new DryRunAdapter();
      return { dryA, proc: new TestMessageProcessor({ db: w, log: silentLogger(), dryRunAdapter: dryA, senders: { senderFor: () => real, anyConnected: () => !!real }, realTestEnabled: false, dryRun: dry }) }; };
    const send = (k: string) => db.as(db.admin, (q) => q.one(`select * from public.create_driver_message($1,'Hola conductor',$2)`, [x.driver, k]));
    const real = await realFake();
    const a = await send('wk-dm-1-aaaaaaaa'); const t1 = mk(true, real);
    expect(await t1.proc.tick()).toMatchObject({ id: a.id, status: 'simulated' }); expect(real.calls).toHaveLength(0); expect(t1.dryA.sent).toHaveLength(1);
    await db.su.query(`update public.whatsapp_test_messages set created_at = now() - interval '3 hours' where id=$1`, [a.id]);
    const b = await send('wk-dm-2-bbbbbbbb'); const t2 = mk(false, real);
    expect(await t2.proc.tick()).toMatchObject({ id: b.id, status: 'sent' }); expect(real.calls).toEqual([{ phone: expect.stringMatching(/^\+507/), body: 'Hola conductor' }]);
    await db.su.query(`update public.whatsapp_test_messages set created_at = now() - interval '3 hours' where id=$1`, [b.id]);
    const c = await send('wk-dm-3-cccccccc'); const t3 = mk(false, null);
    expect(await t3.proc.tick()).toMatchObject({ id: c.id, status: 'failed' }); expect((await row(c.id)).error).toMatch(/sin_sesion/);
  });
  it('el interruptor real es falso por defecto y exige clave de cifrado de sesión', () => {
    expect(loadConfig({ DATABASE_URL: 'postgres://x' }).WHATSAPP_ALLOW_REAL_TEST).toBe(false);
    expect(() => loadConfig({ DATABASE_URL: 'postgres://x', WHATSAPP_ALLOW_REAL_TEST: 'true' })).toThrow(/SESSION_ENCRYPTION_KEY/);
  });
  it('el latido informa el modo (dry-run + interruptor real) en la sesión', async () => {
    const { SessionManager } = await import('../src/session/session-manager.js');
    const w = new WorkerDb(db.connection, 3); open.push(w);
    const sm = new SessionManager({ db: w, log: silentLogger(), adapterFactory: () => new FakeAdapter({ autoScan: true }), pollMs: 10_000, heartbeatMs: 10_000, modes: { dryRun: true, realTestEnabled: false } });
    await sm.start(); await sm.stop();
    expect((await db.su.query(`select worker_dry_run d, worker_real_test_enabled r, worker_heartbeat_at is not null hb from public.whatsapp_sessions`)).rows[0]).toEqual({ d: true, r: false, hb: true });
  });
});

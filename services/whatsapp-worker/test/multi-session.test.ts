import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeAdapter } from '../src/adapters/fake.js';
import { Db as WorkerDb } from '../src/db.js';
import { silentLogger } from '../src/log.js';
import { TestMessageProcessor } from '../src/queue/test-messages.js';
import { SessionManager } from '../src/session/session-manager.js';
import { newDb, type Db } from './support/harness.js';

/** Varias cuentas a la vez: sesiones independientes, QR propios y NUNCA un envío por la sesión de otra cuenta. */
let db: Db; let wdb: WorkerDb; let sidA: string; let sidB: string; let B: string; let m: SessionManager;
const A = '00000000-0000-4000-8000-000000000001';
const key = randomBytes(32);
const fakes = new Map<string, FakeAdapter>();
const build = (phones: Record<string, string>, extra: Partial<ConstructorParameters<typeof SessionManager>[0]> = {}) => new SessionManager({ db: wdb, log: silentLogger(), encryptionKey: key, pollMs: 40,
  backoff: { baseMs: 20, maxMs: 80, jitter: 0 }, adapterFactory: (id) => { const f = new FakeAdapter({ phone: phones[id] }); fakes.set(id, f); return f; }, ...extra });
const row = async (id: string) => (await db.su.query(`select * from public.whatsapp_sessions where id=$1`, [id])).rows[0];
const desire = (id: string, v: string) => db.su.query(`update public.whatsapp_sessions set desired_state=$2 where id=$1`, [id, v]);
async function until(fn: () => Promise<boolean> | boolean, ms = 4000) { const t0 = Date.now(); while (!(await fn())) { if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 15)); } }
let phones: Record<string, string>;

beforeEach(async () => {
  fakes.clear();
  db = await newDb(); wdb = new WorkerDb(db.connection, 6);
  sidA = (await db.su.query(`select id from public.whatsapp_sessions where account_id=$1`, [A])).rows[0].id;
  B = (await db.su.query(`insert into public.accounts(name) values ('B') returning id`)).rows[0].id;                     // su sesión se crea sola
  sidB = (await db.su.query(`select id from public.whatsapp_sessions where account_id=$1`, [B])).rows[0].id;
  phones = { [sidA]: '+50760000001', [sidB]: '+50760000002' };
});
afterEach(async () => { await m?.stop(); await wdb.close(); await db.close(); });

const connectBoth = async () => {
  await desire(sidA, 'connected'); await desire(sidB, 'connected');
  await until(async () => (await row(sidA)).status === 'awaiting_scan' && (await row(sidB)).status === 'awaiting_scan');
  fakes.get(sidA)!.simulateScan(); fakes.get(sidB)!.simulateScan();
  await until(async () => (await row(sidA)).status === 'connected' && (await row(sidB)).status === 'connected');
};

describe('multisesión', () => {
  it('dos cuentas conectan a la vez, con QR y número propios y secretos separados', async () => {
    m = build(phones); await m.start();
    await desire(sidA, 'connected'); await desire(sidB, 'connected');
    await until(async () => !!(await row(sidA)).qr_data && !!(await row(sidB)).qr_data);
    expect(fakes.get(sidA)).not.toBe(fakes.get(sidB));
    fakes.get(sidA)!.simulateScan(); fakes.get(sidB)!.simulateScan();
    await until(() => m.status().filter((x) => x.status === 'connected').length === 2);
    await until(async () => (await db.su.query(`select count(*)::int n from public.whatsapp_session_secrets`)).rows[0].n === 2);
    expect([(await row(sidA)).phone_number, (await row(sidB)).phone_number]).toEqual(['+50760000001', '+50760000002']);
    expect(m.senderFor(A)).toBe(fakes.get(sidA)); expect(m.senderFor(B)).toBe(fakes.get(sidB));
    expect(m.senderFor(null)).toBeNull(); expect(m.senderFor('99999999-9999-4999-8999-999999999999')).toBeNull();
  });
  it('una sesión esperando QR no impide que la otra conecte', async () => {
    m = build(phones); await m.start();
    await desire(sidA, 'connected'); await until(async () => (await row(sidA)).status === 'awaiting_scan');            // nadie escanea A
    await desire(sidB, 'connected'); await until(async () => (await row(sidB)).status === 'awaiting_scan');
    fakes.get(sidB)!.simulateScan(); await until(async () => (await row(sidB)).status === 'connected');
    expect((await row(sidA)).status).toBe('awaiting_scan'); expect(m.senderFor(A)).toBeNull();
  });
  it('desconectar o cerrar sesión de una no toca la otra; la desconectada NO usa la sesión ajena', async () => {
    m = build(phones); await m.start(); await connectBoth();
    await desire(sidA, 'disconnected'); await until(async () => (await row(sidA)).status === 'disconnected');
    expect((await row(sidB)).status).toBe('connected'); expect(m.senderFor(B)).toBe(fakes.get(sidB)); expect(m.senderFor(A)).toBeNull();
    expect((await db.su.query(`select count(*)::int n from public.whatsapp_session_secrets`)).rows[0].n).toBe(2);        // desconectar conserva
    await db.su.query(`update public.whatsapp_sessions set logout_requested_at=now(), desired_state='disconnected' where id=$1`, [sidA]);
    await until(async () => (await row(sidA)).logout_requested_at === null);
    expect((await db.su.query(`select session_id from public.whatsapp_session_secrets`)).rows).toEqual([{ session_id: sidB }]);
    expect((await row(sidB)).status).toBe('connected');
  });
  it('un mensaje sale SOLO por la sesión de su cuenta; sin sesión propia falla, no se desvía', async () => {
    m = build(phones); await m.start(); await connectBoth();
    const real = { sendText: async () => ({ messageId: 'dry', simulated: true }) } as any;
    const proc = new TestMessageProcessor({ db: wdb, log: silentLogger(), dryRunAdapter: real, senders: m, dryRun: false, realTestEnabled: true });
    const ins = (acc: string, body: string, k: string) => db.su.query(`insert into public.whatsapp_test_messages(account_id, kind, status, requested_mode, recipient_phone, body, authorized_by, idempotency_key, recipient_authorization)
      values ($1,'test','prepared','real','+50761239999',$2,$3,$4,'autorizado en la prueba')`, [acc, body, db.admin, k]);
    await ins(A, 'de A', 'multi-key-a-0001'); await ins(B, 'de B', 'multi-key-b-0001');
    await proc.tick(); await proc.tick();
    expect(fakes.get(sidA)!.calls.map((c) => c.body)).toEqual(['de A']); expect(fakes.get(sidB)!.calls.map((c) => c.body)).toEqual(['de B']);
    await desire(sidA, 'disconnected'); await until(() => m.senderFor(A) === null);
    await ins(A, 'otro de A', 'multi-key-a-0002'); await proc.tick();
    expect(fakes.get(sidB)!.calls.map((c) => c.body)).toEqual(['de B']);
    const r = (await db.su.query(`select status, error from public.whatsapp_test_messages where body='otro de A'`)).rows[0];
    expect(r.status).toBe('failed'); expect(r.error).toContain('sin_sesion');
  });
  it('tras reiniciar el worker se recuperan ambas sin QR', async () => {
    m = build(phones); await m.start(); await connectBoth();
    await until(async () => (await db.su.query(`select count(*)::int n from public.whatsapp_session_secrets`)).rows[0].n === 2);
    await m.stop(); fakes.clear();
    m = build(phones, { instanceId: 'segunda' }); await m.start();
    await until(() => m.status().filter((x) => x.status === 'connected').length === 2);
    expect(fakes.get(sidA)!.restored).not.toBeNull(); expect(fakes.get(sidB)!.restored).not.toBeNull();
    expect((await row(sidA)).qr_data).toBeNull();
  });
  it('si nadie escanea, tras varios intentos se detiene solo esa sesión (no relanza el navegador sin fin)', async () => {
    m = build(phones, { qrTtlMs: -14_990 }); await m.start();          // límite del vigilante ≈ 10 ms
    await desire(sidA, 'connected');
    await until(async () => (await row(sidA)).desired_state === 'disconnected', 6000);
    expect((await row(sidA)).last_error).toContain('No se escaneó'); expect(m.status()).toHaveLength(0);
    expect((await row(sidB)).last_error).toBeNull();
  });
  it('si la restauración es rechazada (sin haber llegado a conectar), las credenciales guardadas NO se borran', async () => {
    m = build(phones); await m.start(); await connectBoth();
    await until(async () => (await db.su.query(`select count(*)::int n from public.whatsapp_session_secrets`)).rows[0].n === 2);
    const before = (await db.su.query(`select encrypted_session from public.whatsapp_session_secrets where session_id=$1`, [sidA])).rows[0].encrypted_session;
    await m.stop(); fakes.clear();
    m = new SessionManager({ db: wdb, log: silentLogger(), encryptionKey: key, pollMs: 40, instanceId: 'otra', backoff: { baseMs: 5000, maxMs: 5000, jitter: 0 },
      adapterFactory: (id) => { const f = new FakeAdapter({ phone: phones[id] }); if (id === sidA) f.connect = async () => { f.simulateLoggedOut(); }; fakes.set(id, f); return f; } });
    await m.start();
    await until(async () => ((await row(sidA)).last_error ?? '').includes('Se conserva'));
    const after = (await db.su.query(`select encrypted_session from public.whatsapp_session_secrets where session_id=$1`, [sidA])).rows[0];
    expect(after.encrypted_session.equals(before)).toBe(true);
    await until(async () => (await row(sidB)).status === 'connected');
  });
});

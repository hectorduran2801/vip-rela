import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeAdapter } from '../src/adapters/fake.js';
import { decryptSession } from '../src/crypto.js';
import { Db as WorkerDb } from '../src/db.js';
import { silentLogger } from '../src/log.js';
import { SessionManager } from '../src/session/session-manager.js';
import { loadConfig } from '../src/config.js';
import { Worker } from '../src/worker.js';
import { newDb, type Db } from './support/harness.js';
import { seedDriver, jobs, enableSchedules } from './support/fixtures.js';

let db: Db; let wdb: WorkerDb; let sid: string;
const MAIN = '00000000-0000-4000-8000-000000000001';
const key = randomBytes(32);
const row = async () => (await db.su.query(`select * from public.whatsapp_sessions where id=$1`, [sid])).rows[0];
async function waitFor<T>(fn: () => Promise<T> | T, pred: (v: T) => boolean, ms = 4000): Promise<T> {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (pred(v)) return v; if (Date.now() - t0 > ms) throw new Error(`timeout esperando; último=${JSON.stringify(v)}`); await new Promise((r) => setTimeout(r, 15)); }
}
const manager = (fake: FakeAdapter, extra: Partial<ConstructorParameters<typeof SessionManager>[0]> = {}) =>
  new SessionManager({ db: wdb, log: silentLogger(), adapterFactory: () => fake, encryptionKey: key, pollMs: 40,
    backoff: { baseMs: 20, maxMs: 80, jitter: 0 }, ...extra });

beforeEach(async () => {
  db = await newDb(); wdb = new WorkerDb(db.connection, 4);
  sid = (await db.su.query(`select id from public.whatsapp_sessions`)).rows[0].id;      // la fila única 'Principal' la crea la migración
});
afterEach(async () => { await wdb.close(); await db.close(); });

/** Historial EXACTO de estados escritos en la base (trigger de prueba). */
async function recordHistory() {
  await db.su.query(`create table status_history(n bigserial primary key, status text, qr boolean, phone text, err text)`);
  await db.su.query(`create function pg_temp_hist() returns trigger language plpgsql as $$ begin
      if new.status is distinct from old.status then insert into status_history(status, qr, phone, err) values (new.status, new.qr_data is not null, new.phone_number, new.last_error); end if; return new; end $$`);
  await db.su.query(`create trigger hist after update on public.whatsapp_sessions for each row execute function pg_temp_hist()`);
}
const history = async () => (await db.su.query(`select status, qr, phone, err from status_history order by n`)).rows;
const want = (id = sid) => db.su.query(`update public.whatsapp_sessions set desired_state='connected' where id=$1`, [id]);

describe('SessionManager con FakeAdapter', () => {
  it('la base admite una sesión POR CUENTA (nunca dos de la misma)', async () => {
    const err = await db.su.query(`insert into public.whatsapp_sessions(label, account_id) values ('otra', $1)`, [MAIN]).then(() => null, (e) => e.message);
    expect(err).toMatch(/one_per_account|unique|duplicate/i);
  });

  it('no hace nada mientras desired_state sea disconnected', async () => {
    const fake = new FakeAdapter(); const m = manager(fake); await m.start();
    await new Promise((r) => setTimeout(r, 100));
    expect(fake.connectCalls).toBe(0); expect((await row()).status).toBe('disconnected');
    await m.stop();
  });

  it('QR -> connected: guarda QR efímero, lo borra al conectar y cifra el secreto', async () => {
    const fake = new FakeAdapter(); const m = manager(fake); await m.start();
    await db.su.query(`update public.whatsapp_sessions set desired_state='connected' where id=$1`, [sid]);
    const qr = await waitFor(row, (r) => r.status === 'awaiting_scan');
    expect(qr.qr_data).toBe('fake-qr-1');
    expect(new Date(qr.qr_expires_at).getTime()).toBeGreaterThan(Date.now());
    expect(m.anyConnected()).toBe(false); expect(m.senderFor(MAIN)).toBeNull();

    fake.simulateScan();
    const ok = await waitFor(row, (r) => r.status === 'connected');
    expect(ok.qr_data).toBeNull(); expect(ok.qr_expires_at).toBeNull(); expect(ok.last_seen_at).not.toBeNull();
    expect(m.senderFor(MAIN)).toBe(fake); expect(m.status()[0]).toMatchObject({ sessionId: sid, status: 'connected' });

    const sec: any = await waitFor(async () => (await db.su.query(`select encrypted_session from public.whatsapp_session_secrets where session_id=$1`, [sid])).rows[0], Boolean);
    expect(sec.encrypted_session.toString('utf8')).not.toContain('fake-session-data');
    expect(decryptSession(sec.encrypted_session, key, sid).toString()).toBe('fake-session-data');
    expect(() => decryptSession(sec.encrypted_session, randomBytes(32), sid)).toThrow();
    await m.stop();
  });

  it('caída -> reconexión automática con backoff', async () => {
    const fake = new FakeAdapter({ autoScan: true }); const m = manager(fake); await m.start();
    await db.su.query(`update public.whatsapp_sessions set desired_state='connected' where id=$1`, [sid]);
    await waitFor(row, (r) => r.status === 'connected');
    fake.failNextConnects(2);                           // los dos primeros reintentos fallan
    fake.simulateDrop();
    await waitFor(row, (r) => r.status === 'disconnected' || r.status === 'failed' || r.status === 'connecting');
    const back = await waitFor(row, (r) => r.status === 'connected');
    expect(back.status).toBe('connected');
    expect(fake.connectCalls).toBe(4);                  // 1 inicial + 2 fallidos + 1 exitoso
    expect(m.status()[0]!.reconnectAttempt).toBe(0);    // se reinicia al conectar
    await m.stop();
  });

  it('desired_state=disconnected desconecta y limpia el QR', async () => {
    const fake = new FakeAdapter(); const m = manager(fake); await m.start();
    await db.su.query(`update public.whatsapp_sessions set desired_state='connected' where id=$1`, [sid]);
    await waitFor(row, (r) => r.status === 'awaiting_scan');
    await db.su.query(`update public.whatsapp_sessions set desired_state='disconnected' where id=$1`, [sid]);
    const r = await waitFor(row, (x) => x.status === 'disconnected');
    expect(r.qr_data).toBeNull(); expect(fake.getStatus()).toBe('disconnected');
    expect(m.status()).toHaveLength(0);
    await m.stop();
  });

  it('recuperación tras reinicio: restaura la sesión cifrada y conecta sin QR', async () => {
    const f1 = new FakeAdapter(); const m1 = manager(f1); await m1.start();
    await db.su.query(`update public.whatsapp_sessions set desired_state='connected' where id=$1`, [sid]);
    await waitFor(row, (r) => r.status === 'awaiting_scan'); f1.simulateScan();
    await waitFor(async () => (await db.su.query(`select 1 from public.whatsapp_session_secrets`)).rowCount, (n) => n === 1);
    await m1.stop();                                    // "el servicio se reinicia"
    expect((await row()).status).toBe('disconnected');

    const f2 = new FakeAdapter(); const m2 = manager(f2); await m2.start();
    await waitFor(row, (r) => r.status === 'connected');
    expect(f2.restored?.toString()).toBe('fake-session-data');
    expect((await row()).qr_data).toBeNull();
    await m2.stop();
  });

  it('un secreto corrupto no tumba el gestor: se pide QR nuevo', async () => {
    await db.su.query(`insert into public.whatsapp_session_secrets(session_id, encrypted_session) values ($1, $2)`, [sid, Buffer.from('basura-no-cifrada-1234567890123456789')]);
    await db.su.query(`update public.whatsapp_sessions set desired_state='connected' where id=$1`, [sid]);
    const fake = new FakeAdapter(); const m = manager(fake); await m.start();
    await waitFor(row, (r) => r.status === 'awaiting_scan');
    expect(fake.restored).toBeNull();
    await m.stop();
  });

  it('un adaptador que lanza al conectar no rompe el gestor (status failed y reintento)', async () => {
    const fake = new FakeAdapter(); fake.failNextConnects(1);
    await db.su.query(`update public.whatsapp_sessions set desired_state='connected' where id=$1`, [sid]);
    const m = manager(fake); await m.start();
    await waitFor(row, (r) => r.status === 'awaiting_scan');         // el segundo intento llega a QR
    expect(fake.connectCalls).toBe(2);
    await m.stop();
  });
});

describe('conexión real (FakeAdapter simulando OpenWA): estados y escrituras en la base', () => {
  it('flujo completo starting → qr_pending → awaiting_scan(QR) → connecting → connected(número)', async () => {
    await recordHistory();
    const fake = new FakeAdapter({ phone: '+50761234567' }); const m = manager(fake); await m.start();
    await want();
    const qr = await waitFor(row, (r) => r.status === 'awaiting_scan');
    expect(qr.qr_data).toBe('fake-qr-1'); expect(qr.qr_expires_at).not.toBeNull(); expect(qr.phone_number).toBeNull();
    fake.simulateScan();
    const ok = await waitFor(row, (r) => r.status === 'connected');
    expect(ok.phone_number).toBe('+50761234567'); expect(ok.qr_data).toBeNull(); expect(ok.qr_expires_at).toBeNull(); expect(ok.last_error).toBeNull();
    expect(new Date(ok.status_changed_at).getTime()).toBeGreaterThanOrEqual(new Date(qr.status_changed_at).getTime());
    expect((await history()).map((h) => h.status)).toEqual(['starting', 'qr_pending', 'awaiting_scan', 'connecting', 'connected']);
    const h = await history();
    expect(h[1]!.qr).toBe(false);                       // "Esperando QR": todavía sin qr_data
    expect(h[2]!.qr).toBe(true);                        // "Esperando escaneo": qr_data disponible
    expect(h[3]!.qr).toBe(false);                       // connecting: el QR ya no está
    await m.stop();
  });

  it('QR renovado: cada QR nuevo reemplaza al anterior y renueva su caducidad', async () => {
    const fake = new FakeAdapter(); const m = manager(fake); await m.start(); await want();
    const a = await waitFor(row, (r) => r.status === 'awaiting_scan');
    fake.simulateQrRefresh();
    const b = await waitFor(row, (r) => r.qr_data === 'fake-qr-2');
    expect(b.status).toBe('awaiting_scan');
    expect(new Date(b.qr_expires_at).getTime()).toBeGreaterThanOrEqual(new Date(a.qr_expires_at).getTime());
    await m.stop();
  });

  it('fallo: status failed con el motivo REAL (sanitizado) y nunca "connected" sin confirmación', async () => {
    await recordHistory();
    const fake = new FakeAdapter(); fake.failNextConnects(1); const m = manager(fake); await m.start(); await want();
    const f = await waitFor(row, (r) => r.last_error !== null);
    expect(f.last_error).toBe('connect falló (simulado)');
    // reintenta y llega a QR; el error se conserva hasta conectar
    await waitFor(row, (r) => r.status === 'awaiting_scan');
    expect((await history()).map((h) => h.status)).not.toContain('connected');
    // fallo en caliente con un teléfono dentro del mensaje: se sanea
    fake.simulateScan(); await waitFor(row, (r) => r.status === 'connected');
    expect((await row()).last_error).toBeNull();                 // al conectar se limpia el error
    fake.failNextConnects(1);
    fake.simulateFailure('Chrome se cerró: perfil de +50761234567 bloqueado');
    const r = await waitFor(row, (x) => x.status === 'failed');
    expect(r.last_error).toBe('Chrome se cerró: perfil de [num] bloqueado'); expect(r.phone_number).toBeNull();
    await m.stop();
  });

  it('desconexión limpia: desired_state=disconnected cierra el cliente y limpia qr_data y phone_number', async () => {
    const fake = new FakeAdapter({ autoScan: true, phone: '+50761234567' }); const m = manager(fake); await m.start(); await want();
    await waitFor(row, (r) => r.status === 'connected' && r.phone_number !== null);
    await db.su.query(`update public.whatsapp_sessions set desired_state='disconnected'`);
    const r = await waitFor(row, (x) => x.status === 'disconnected');
    expect(r.phone_number).toBeNull(); expect(r.qr_data).toBeNull(); expect(r.qr_expires_at).toBeNull();
    expect(fake.getStatus()).toBe('disconnected');
    await m.stop();
  });

  it('heartbeat: worker_heartbeat_at se escribe periódicamente aunque no haya sesión activa; la API puede pedir conectar', async () => {
    expect((await row()).worker_heartbeat_at).toBeNull();
    const m = manager(new FakeAdapter(), { heartbeatMs: 30 }); await m.start();
    const a = await waitFor(row, (r) => r.worker_heartbeat_at !== null);
    expect(a.desired_state).toBe('disconnected');
    const b = await waitFor(row, (r) => new Date(r.worker_heartbeat_at).getTime() > new Date(a.worker_heartbeat_at).getTime());
    expect(b.status).toBe('disconnected');
    // la administradora pide conectar con la función real (solo toca desired_state / last_error)
    await db.as(db.admin, (q) => q.one(`select public.request_whatsapp_connection('connected')`));
    await waitFor(row, (r) => r.status === 'awaiting_scan');
    await m.stop();
  });

  it('reinicio: la sesión guardada (persistencia propia del adaptador) se restaura SIN pedir QR', async () => {
    await recordHistory();
    const fake = new FakeAdapter();                        // la instancia hace de "perfil en disco" de OpenWA
    const m1 = manager(fake, { encryptionKey: undefined }); await m1.start(); await want();
    await waitFor(row, (r) => r.status === 'awaiting_scan'); fake.simulateScan();
    await waitFor(row, (r) => r.status === 'connected');
    await m1.stop();                                       // "el worker se reinicia"
    expect((await row()).status).toBe('disconnected');
    expect((await db.su.query(`select 1 from public.whatsapp_session_secrets`)).rowCount).toBe(0);   // sin clave no se guarda nada en la base
    await db.su.query(`delete from status_history`);
    const m2 = manager(fake, { encryptionKey: undefined }); await m2.start();
    await waitFor(row, (r) => r.status === 'connected');
    expect((await history()).map((h) => h.status)).not.toContain('awaiting_scan');
    expect((await history()).every((h) => !h.qr)).toBe(true);
    await m2.stop();
  });
});

describe('Worker: la CONEXIÓN es real aunque WHATSAPP_DRY_RUN=true; el ENVÍO jamás llama al adaptador de conexión', () => {
  it('con DRY_RUN=true la sesión usa el adaptador configurado y los jobs se "envían" por DryRun', async () => {
    const c = db.connection as { host: string; port: number; database: string };
    const url = `postgresql://postgres@localhost/${c.database}?host=${encodeURIComponent(c.host)}&port=${c.port}`;
    const cfg = loadConfig({ DATABASE_URL: url, WHATSAPP_DRY_RUN: 'true', WHATSAPP_ADAPTER: 'fake', AUTOMATIC_REMINDERS: 'true', POLL_INTERVAL_SECONDS: '1', SESSION_POLL_SECONDS: '1' });      // este caso ejercita la cola automática a propósito
    const d = await seedDriver(db, '1');
    await enableSchedules(db);
    await db.su.query(`insert into public.notification_jobs(driver_id, kind, local_date, scheduled_for, schedule_id) values ($1,'debt_first','2026-11-16', now() - interval '1 minute', (select id from public.notification_schedules where kind='debt_first'))`, [d.driver]);
    const conn = new FakeAdapter({ autoScan: true }); const made: string[] = [];
    const w = new Worker(cfg, silentLogger(), { adapterFactory: (id) => { made.push(id); return conn; } });
    await want();
    await w.start();
    try {
      await waitFor(row, (r) => r.status === 'connected');                  // conexión real (aquí simulada) con DRY_RUN=true
      expect(made).toEqual([sid]); expect(conn.connectCalls).toBe(1);
      const j = await waitFor(async () => (await jobs(db)).find((x) => x.status === 'sent'), (x) => !!x);          // alguno de los trabajos (el manual o el programado) sale por DryRun
      expect(j.dry_run).toBe(true);
      expect(conn.calls).toHaveLength(0);                                   // sendText del adaptador de conexión NUNCA se llamó
    } finally { await w.stop(); }
  });
});

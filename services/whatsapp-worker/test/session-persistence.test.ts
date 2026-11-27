import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeAdapter } from '../src/adapters/fake.js';
import { OpenWaAdapter } from '../src/adapters/openwa.js';
import { decryptSession } from '../src/crypto.js';
import { Db as WorkerDb } from '../src/db.js';
import { silentLogger } from '../src/log.js';
import { SessionManager } from '../src/session/session-manager.js';
import { newDb, type Db } from './support/harness.js';

let db: Db; let wdb: WorkerDb; let sid: string; let dir: string;
const key = randomBytes(32);
const row = async () => (await db.su.query(`select * from public.whatsapp_sessions where id=$1`, [sid])).rows[0];
const secrets = async () => (await db.su.query(`select * from public.whatsapp_session_secrets where session_id=$1`, [sid])).rows;
async function waitFor<T>(fn: () => Promise<T> | T, pred: (v: T) => boolean, ms = 5000): Promise<T> {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (pred(v)) return v; if (Date.now() - t0 > ms) throw new Error(`timeout; último=${JSON.stringify(v)}`); await new Promise((r) => setTimeout(r, 15)); }
}
const manager = (adapters: FakeAdapter | (() => FakeAdapter), extra: Partial<ConstructorParameters<typeof SessionManager>[0]> = {}) =>
  new SessionManager({ db: wdb, log: silentLogger(), adapterFactory: () => (typeof adapters === 'function' ? adapters() : adapters), encryptionKey: key, pollMs: 40, heartbeatMs: 40,
    backoff: { baseMs: 20, maxMs: 80, jitter: 0 }, ...extra });
const want = (s: 'connected' | 'disconnected') => db.su.query(`update public.whatsapp_sessions set desired_state=$2 where id=$1`, [sid, s]);
const logoutReq = () => db.su.query(`select public.request_whatsapp_logout()`).catch(() => db.su.query(`update public.whatsapp_sessions set desired_state='disconnected', logout_requested_at=now()`));
const envelope = (n = 1) => Buffer.from(JSON.stringify({ auth: `AUTH-${n}`, data: `DATA-${n}` }));

beforeEach(async () => {
  db = await newDb(); wdb = new WorkerDb(db.connection, 4); dir = mkdtempSync(join(tmpdir(), 'vip-persist-'));
  sid = (await db.su.query(`select id from public.whatsapp_sessions`)).rows[0].id;
});
afterEach(async () => { await wdb.close(); await db.close(); rmSync(dir, { recursive: true, force: true }); });

describe('persistencia cifrada de la sesión', () => {
  it('guarda cifrado (AES-256-GCM, IV distinto en cada guardado), actualiza cuando OpenWA entrega credenciales nuevas y marca session_persisted', async () => {
    const fake = new FakeAdapter(); const m = manager(fake); await m.start(); await want('connected');
    await waitFor(row, (r) => r.status === 'awaiting_scan'); fake.simulateScan();
    const s1: any = (await waitFor(secrets, (r) => r.length === 1))[0];
    expect(s1.encrypted_session.toString('utf8')).not.toContain('fake-session-data');
    expect(s1.encrypted_session[0]).toBe(1);
    expect((await waitFor(row, (r) => r.session_persisted === true)).session_saved_at).not.toBeNull();
    fake.simulateSessionData(envelope(2));
    const s2: any = (await waitFor(secrets, (r) => r[0] && !r[0].encrypted_session.equals(s1.encrypted_session)))[0];
    expect(decryptSession(s2.encrypted_session, key, sid).toString()).toBe(envelope(2).toString());
    expect(s2.encrypted_session.subarray(1, 13).equals(s1.encrypted_session.subarray(1, 13))).toBe(false);           // IV único por cifrado
    await m.stop();
  });

  it('no se escribe NADA de la sesión en los logs ni en last_error', async () => {
    const lines: string[] = [];
    const log: any = { info: (...a: any[]) => lines.push(JSON.stringify(a)), warn: (...a: any[]) => lines.push(JSON.stringify(a)), error: (...a: any[]) => lines.push(JSON.stringify(a)), debug: () => undefined, child: () => log };
    const fake = new FakeAdapter(); const m = manager(fake, { log }); await m.start(); await want('connected');
    await waitFor(row, (r) => r.status === 'awaiting_scan'); fake.simulateScan(); fake.simulateSessionData(envelope(7));
    await waitFor(secrets, (r) => r.length === 1); await m.stop();
    expect(lines.join('\n')).not.toMatch(/AUTH-7|DATA-7|fake-session-data/);
  });

  it('reiniciar el worker restaura la sesión sin QR (también si se borró el almacenamiento local)', async () => {
    const f1 = new FakeAdapter(); const m1 = manager(f1); await m1.start(); await want('connected');
    await waitFor(row, (r) => r.status === 'awaiting_scan'); f1.simulateScan(); f1.simulateSessionData(envelope(3));
    await waitFor(secrets, (r) => r.length === 1 && decryptSession(r[0].encrypted_session, key, sid).equals(envelope(3)));
    await m1.stop();                                                                      // reinicio del worker/servidor
    expect((await row()).status).toBe('disconnected');
    const f2 = new FakeAdapter();                                                         // almacenamiento local nuevo y vacío
    const m2 = manager(f2); await m2.start();
    await waitFor(row, (r) => r.status === 'connected');
    expect(f2.restored?.equals(envelope(3))).toBe(true); expect((await row()).qr_data).toBeNull();
    await m2.stop();
  });

  it('desconectar temporalmente CONSERVA la sesión y permite reconectar sin QR', async () => {
    const f = new FakeAdapter(); const m = manager(() => f); await m.start(); await want('connected');
    await waitFor(row, (r) => r.status === 'awaiting_scan'); f.simulateScan(); await waitFor(secrets, (r) => r.length === 1);
    await want('disconnected'); await waitFor(row, (r) => r.status === 'disconnected');
    expect(await secrets()).toHaveLength(1); expect((await row()).session_persisted).toBe(true); expect(f.local).not.toBeNull();
    await want('connected'); const back = await waitFor(row, (r) => r.status === 'connected');
    expect(back.qr_data).toBeNull(); await m.stop();
  });

  it('una sesión guardada con otra clave no tumba nada: informa el problema y no borra el secreto', async () => {
    const other = (await import('../src/crypto.js')).encryptSession(envelope(4), randomBytes(32), sid);
    await db.su.query(`insert into public.whatsapp_session_secrets(session_id, encrypted_session) values ($1,$2)`, [sid, other]);
    const f = new FakeAdapter(); const m = manager(f); await m.start(); await want('connected');
    const r = await waitFor(row, (x) => x.status === 'awaiting_scan');
    expect(f.restored).toBeNull(); expect(r.last_error).toMatch(/restaurar la sesión guardada/); expect(await secrets()).toHaveLength(1);
    await m.stop();
  });

  it('con la base caída al iniciar usa el almacenamiento local sin borrarlo; con sesión local y sin secreto, la respalda cifrada', async () => {
    const f = new FakeAdapter(); await f.restore(envelope(5));          // sesión local previa (p. ej. creada antes de esta función)
    const m = manager(f); await m.start(); await want('connected');
    await waitFor(row, (r) => r.status === 'connected');
    const s: any = (await waitFor(secrets, (r) => r.length === 1))[0];
    expect(decryptSession(s.encrypted_session, key, sid).equals(envelope(5))).toBe(true);
    await m.stop();
  });
});

describe('cerrar sesión', () => {
  it('elimina credenciales locales y cifradas, limpia QR/número, deja whatsapp_sessions desconectada y NO se restaura después', async () => {
    const f = new FakeAdapter(); const m = manager(() => f); await m.start(); await want('connected');
    await waitFor(row, (r) => r.status === 'awaiting_scan'); f.simulateScan(); await waitFor(secrets, (r) => r.length === 1);
    await db.su.query(`update public.whatsapp_sessions set logout_requested_at = now(), desired_state='disconnected' where id=$1`, [sid]);
    const r = await waitFor(row, (x) => x.logout_requested_at === null && x.status === 'disconnected');
    expect(f.logoutCalls).toBe(1); expect(f.local).toBeNull(); expect(await secrets()).toHaveLength(0);
    expect(r).toMatchObject({ desired_state: 'disconnected', qr_data: null, phone_number: null, session_persisted: false, session_saved_at: null, lease_owner: null });
    // La próxima conexión pide QR nuevo: nada que restaurar
    const f2 = new FakeAdapter(); const m2 = manager(() => f2, {}); await m.stop(); await m2.start(); await want('connected');
    const q = await waitFor(row, (x) => x.status === 'awaiting_scan'); expect(f2.restored).toBeNull(); expect(q.qr_data).toBe('fake-qr-1');
    await m2.stop();
  });

  it('cerrar sesión estando desconectado también borra todo (sin runtime) y no toca otros datos', async () => {
    await db.su.query(`insert into public.whatsapp_session_secrets(session_id, encrypted_session) values ($1,$2)`, [sid, Buffer.from('x'.repeat(40))]);
    await db.su.query(`update public.whatsapp_sessions set session_persisted = true where id=$1`, [sid]);
    const before = (await db.su.query(`select (select count(*) from public.message_templates)::int t, (select count(*) from public.notification_schedules)::int s`)).rows[0];
    const wiped: string[] = []; const f = new FakeAdapter(); f.wipeLocalSession = async () => { wiped.push('x'); };
    const m = manager(() => f); await m.start();
    await db.su.query(`update public.whatsapp_sessions set logout_requested_at = now() where id=$1`, [sid]);
    await waitFor(row, (x) => x.logout_requested_at === null);
    expect(await secrets()).toHaveLength(0); expect(wiped.length).toBeGreaterThan(0);
    expect((await db.su.query(`select (select count(*) from public.message_templates)::int t, (select count(*) from public.notification_schedules)::int s`)).rows[0]).toEqual(before);
    await m.stop();
  });

  it('si Supabase falla durante el cierre, la credencial anterior NO se restaura (ni al reiniciar el worker) y el cierre se completa al volver la base', async () => {
    const f = new FakeAdapter(); const m = manager(() => f); await m.start(); await want('connected');
    await waitFor(row, (r) => r.status === 'awaiting_scan'); f.simulateScan(); await waitFor(secrets, (r) => r.length === 1);
    // la base «se cae» justo al borrar el secreto
    await db.su.query(`create function pg_temp_nodelete() returns trigger language plpgsql as $$ begin raise exception 'base no disponible (simulado)'; end $$`);
    await db.su.query(`create trigger nodelete before delete on public.whatsapp_session_secrets for each row execute function pg_temp_nodelete()`);
    await db.su.query(`update public.whatsapp_sessions set logout_requested_at = now(), desired_state='disconnected' where id=$1`, [sid]);
    await waitFor(() => f.local, (l) => l === null);                                    // el almacenamiento local ya se borró
    expect(await secrets()).toHaveLength(1); expect((await row()).logout_requested_at).not.toBeNull();
    await m.stop();
    // Reinicio del worker con el cierre pendiente y la base todavía sin poder borrar: la sesión anterior no se restaura.
    const f2 = new FakeAdapter(); const m2 = manager(() => f2); await m2.start(); await want('connected');
    await new Promise((r) => setTimeout(r, 250));
    expect(f2.restored).toBeNull(); expect(f2.connectCalls).toBe(0);
    // vuelve la base: el cierre se completa
    await db.su.query(`drop trigger nodelete on public.whatsapp_session_secrets`);
    await waitFor(row, (r) => r.logout_requested_at === null && r.status === 'disconnected');
    expect(await secrets()).toHaveLength(0); expect(f2.restored).toBeNull(); expect(f2.connectCalls).toBe(0);
    await m2.stop();
  });

  it('un guardado tardío de credenciales NO resucita la sesión cerrada', async () => {
    const f = new FakeAdapter(); const m = manager(() => f); await m.start(); await want('connected');
    await waitFor(row, (r) => r.status === 'awaiting_scan'); f.simulateScan(); await waitFor(secrets, (r) => r.length === 1);
    await db.su.query(`update public.whatsapp_sessions set logout_requested_at = now(), desired_state='disconnected' where id=$1`, [sid]);
    await waitFor(row, (x) => x.logout_requested_at === null);
    f.simulateSessionData(envelope(9)); await new Promise((r) => setTimeout(r, 150));
    expect(await secrets()).toHaveLength(0); expect((await row()).session_persisted).toBe(false);
    await m.stop();
  });

  it('la sesión invalidada desde el teléfono elimina las credenciales y la reconexión pide un QR nuevo', async () => {
    const f = new FakeAdapter(); const m = manager(() => f); await m.start(); await want('connected');
    await waitFor(row, (r) => r.status === 'awaiting_scan'); f.simulateScan(); await waitFor(secrets, (r) => r.length === 1);
    f.simulateLoggedOut();
    await waitFor(secrets, (r) => r.length === 0);
    const q = await waitFor(row, (x) => x.status === 'awaiting_scan' && x.session_persisted === false);
    expect(q.qr_data).toMatch(/^fake-qr-/); await m.stop();
  });
});

describe('una sola instancia por sesión (lease en la base)', () => {
  it('la segunda instancia NO conecta mientras la primera tiene el lease; lo toma cuando expira', async () => {
    const f1 = new FakeAdapter({ autoScan: true }); const f2 = new FakeAdapter({ autoScan: true });
    const m1 = manager(f1, { instanceId: 'A' }); const m2 = manager(f2, { instanceId: 'B' });
    await m1.start(); await want('connected'); await waitFor(row, (r) => r.status === 'connected' && r.lease_owner === 'A');
    await m2.start(); await new Promise((r) => setTimeout(r, 200));
    expect(f2.connectCalls).toBe(0); expect((await row()).lease_owner).toBe('A');
    await m1.stop();                                                                      // suelta el lease
    await waitFor(row, (r) => r.lease_owner === 'B');
    await waitFor(() => f2.connectCalls, (n) => n > 0); await m2.stop();
  });
  it('si otra instancia roba el lease, la primera se detiene', async () => {
    const f1 = new FakeAdapter({ autoScan: true }); const m1 = manager(f1, { instanceId: 'A' });
    await m1.start(); await want('connected'); await waitFor(row, (r) => r.status === 'connected');
    await db.su.query(`update public.whatsapp_sessions set lease_owner='B', lease_expires_at = now() + interval '1 minute'`);
    const r = await waitFor(row, (x) => x.status === 'failed'); expect(r.last_error).toMatch(/Otra instancia/); expect(m1.anyConnected()).toBe(false);
    await m1.stop();
  });
});

describe('adaptador OpenWA: archivo de sesión (sobre auth/data)', () => {
  const fakeChild = () => {
    const h: Record<string, Array<(...a: any[]) => void>> = {}; const sent: any[] = [];
    const c = { sent, send: (m: any) => { sent.push(m); if (m.t === 'stop') setTimeout(() => (h.exit ?? []).forEach((f) => f(0, null)), 0);
        if (m.t === 'logout') setTimeout(() => (h.message ?? []).forEach((f) => f({ t: 'logout_done', native: false })), 0); },
      kill: () => undefined, on: (ev: string, cb: (...a: any[]) => void) => { (h[ev] ??= []).push(cb); }, emit: (ev: string, ...a: any[]) => (h[ev] ?? []).forEach((f) => f(...a)) };
    return c;
  };
  it('restore() escribe <id>.data.json (0600) con el sobre exacto y rechaza datos que OpenWA no entendería', async () => {
    const a = new OpenWaAdapter('s1', { childFactory: () => fakeChild() as any, sessionDataPath: dir, executablePath: '/x' });
    await expect(a.restore(Buffer.from('LOGGED OUT'))).rejects.toThrow(/formato/);
    await expect(a.restore(Buffer.from(JSON.stringify({ auth: 'x' })))).rejects.toThrow();
    await a.restore(envelope(1));
    expect(readFileSync(join(dir, 's1.data.json'))).toEqual(envelope(1));
    expect(((await import('node:fs')).statSync(join(dir, 's1.data.json')).mode & 0o777).toString(8)).toBe('600');
    expect(await a.exportSession()).toEqual(envelope(1));
    expect(readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });
  it('detecta cuando OpenWA reescribe el archivo y lo entrega; ignora archivos sin cambios o inválidos', async () => {
    const c = fakeChild(); const a = new OpenWaAdapter('s1', { childFactory: () => c as any, sessionDataPath: dir, executablePath: '/x', killAfterMs: 50 });
    const got: Buffer[] = []; a.onSessionData((d) => got.push(d));
    await a.connect(); c.emit('message', { t: 'connected', phone: '+507' });
    writeFileSync(join(dir, 's1.data.json'), envelope(1)); await waitFor(() => got.length, (n) => n === 1, 6000);
    writeFileSync(join(dir, 's1.data.json'), '{"parcial":'); await new Promise((r) => setTimeout(r, 3300));
    expect(got).toHaveLength(1);
    writeFileSync(join(dir, 's1.data.json'), envelope(2)); await a.disconnect();            // el último cambio se recoge al cerrar
    expect(got.map((b) => b.toString())).toEqual([envelope(1).toString(), envelope(2).toString()]);
  }, 20000);
  it('logout(): pide el cierre nativo al hijo, lo detiene y borra el archivo local; LOGGED OUT marca sesión invalidada', async () => {
    const c = fakeChild(); const a = new OpenWaAdapter('s1', { childFactory: () => c as any, sessionDataPath: dir, executablePath: '/x', killAfterMs: 50 });
    await a.restore(envelope(1)); await a.connect(); c.emit('message', { t: 'connected', phone: '+507' });
    const r = await a.logout();
    expect(c.sent.some((m: any) => m.t === 'logout')).toBe(true); expect(r).toEqual({ native: false });
    expect(existsSync(join(dir, 's1.data.json'))).toBe(false); expect(a.getStatus()).toBe('disconnected');
    // sesión invalidada por el teléfono
    const c2 = fakeChild(); const b = new OpenWaAdapter('s2', { childFactory: () => c2 as any, sessionDataPath: dir, executablePath: '/x', killAfterMs: 50 });
    await b.restore(envelope(2)); await b.connect(); c2.emit('message', { t: 'connected', phone: '+507' });
    c2.emit('message', { t: 'lost', reason: 'sesión cerrada desde el teléfono', loggedOut: true });
    expect(b.wasLoggedOut()).toBe(true); await b.disconnect();
  });
});

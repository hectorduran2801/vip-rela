import { SignJWT } from 'jose';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newDb, type Db } from '@vip/db/testing';
import { buildApp } from './app.js';
import { BillingEngine } from './billing-engine.js';
import { loadConfig } from './config.js';
import { createDatabase, type Database } from './db.js';

const SECRET = 'x'.repeat(40);
const sign = (sub: string) => new SignJWT({ role: 'authenticated', email: `${sub}@t.local` }).setProtectedHeader({ alg: 'HS256' })
  .setSubject(sub).setAudience('authenticated').setIssuedAt().setExpirationTime('5m').sign(new TextEncoder().encode(SECRET));
const MON = '2026-03-02';
// Mediodía de Panamá (UTC-5) del sábado 2026-03-07 → «hoy» local = 2026-03-07
const SAT_NOON = new Date('2026-03-07T12:00:00-05:00');
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

let db: Db, pool: pg.Pool, database: Database, app: FastifyInstance;
let a: { driver: string; unit: string; assignment: string };
let tAdmin: string, tOut: string, tSup: string;
const h = (t: string) => ({ authorization: `Bearer ${t}` });
const count = async () => (await db.su.query(`select count(*)::int c from public.charges where assignment_id=$1`, [a.assignment])).rows[0].c as number;

beforeAll(async () => {
  db = await newDb(); pool = new pg.Pool({ ...db.connection, max: 8 }); database = createDatabase(pool);
  app = await buildApp(loadConfig({ SUPABASE_JWT_SECRET: SECRET, RATE_LIMIT_PER_MINUTE: '100000', BILLING_ENGINE: 'false' }), { db: database });
  tAdmin = await sign(db.admin); tOut = await sign(db.outsider); tSup = await sign(db.supervisor);
  a = await db.driverWithAssignment({ code: '1', unit: 'P811', dailyCents: 4000, from: MON });
});
afterAll(async () => { await app.close(); await pool.end(); await db.close(); });

describe('motor de cobranza (API, independiente de OpenWA)', () => {
  it('al arrancar genera las cuotas lun–sáb faltantes sin worker ni WhatsApp; domingo no', async () => {
    const e = new BillingEngine({ db: database, log: silent, clock: () => SAT_NOON });
    const r = await e.runOnce();
    expect(r).toMatchObject({ created: 6, to: '2026-03-07', skipped: null });
    expect(await count()).toBe(6);
    expect((await db.su.query(`select count(*)::int c from public.notification_jobs`)).rows[0].c).toBe(0);     // no envía nada
  });

  it('reinicio de la API: una instancia nueva ejecuta y crea 0; ejecuciones simultáneas no duplican', async () => {
    const e2 = new BillingEngine({ db: database, log: silent, clock: () => SAT_NOON });
    expect((await e2.runOnce())!.created).toBe(0);
    const engines = Array.from({ length: 5 }, () => new BillingEngine({ db: database, log: silent, clock: () => new Date('2026-03-08T10:00:00-05:00') }));
    const rs = await Promise.all(engines.map((x) => x.runOnce()));
    expect(rs.every((r) => r !== null && r.created === 0)).toBe(true);
    expect(await count()).toBe(6);
  });

  it('usa el día LOCAL de Panamá: a las 23:30 locales (04:30 UTC del día siguiente) sigue siendo el mismo día', async () => {
    const b = await db.driverWithAssignment({ code: '2', unit: 'P812', dailyCents: 3000, from: '2026-03-09' });
    const e = new BillingEngine({ db: database, log: silent, clock: () => new Date('2026-03-10T04:30:00Z') });     // 2026-03-09 23:30 en Panamá
    const r = await e.runOnce();
    expect(r!.to).toBe('2026-03-09');
    expect((await db.su.query(`select charge_date::text d from public.charges where assignment_id=$1`, [b.assignment])).rows).toEqual([{ d: '2026-03-09' }]);
  });

  it('si la base falla no lanza ni tumba: devuelve null, cuenta el fallo y se recupera después', async () => {
    let fail = true;
    const flaky: Database = { ...database, asService: (fn) => (fail ? Promise.reject(new Error('ECONNREFUSED')) : database.asService!(fn)) };
    const e = new BillingEngine({ db: flaky, log: silent, clock: () => SAT_NOON });
    expect(await e.runOnce()).toBeNull();
    expect(e.stats).toMatchObject({ failures: 1, lastError: 'ECONNREFUSED' });
    fail = false;
    expect(await e.runOnce()).toMatchObject({ created: 0 });
    expect(e.stats.lastError).toBeNull();
  });

  it('start/stop: arranca con una ejecución inmediata y se detiene limpiamente', async () => {
    const c = await db.driverWithAssignment({ code: '3', unit: 'P813', dailyCents: 3000, from: '2026-03-02' });
    const e = new BillingEngine({ db: database, log: silent, clock: () => SAT_NOON, intervalMs: 60_000 });
    e.start();
    for (let i = 0; i < 50 && e.stats.runs === 0; i++) await new Promise((r) => setTimeout(r, 50));
    await e.stop();
    expect(e.stats.runs).toBe(1);
    expect((await db.su.query(`select count(*)::int n from public.charges where assignment_id=$1`, [c.assignment])).rows[0].n).toBe(6);
  });
});

describe('endpoints de cobranza', () => {
  const post = (url: string, t: string, payload: object = {}) => app.inject({ method: 'POST', url: `/api/v1${url}`, headers: h(t), payload });
  const get = (url: string, t: string) => app.inject({ method: 'GET', url: `/api/v1${url}`, headers: h(t) });

  it('POST /charges/ensure: ADMIN+ genera, es idempotente; supervisor/sin rol no', async () => {
    const d = await db.driverWithAssignment({ code: '4', unit: 'P814', dailyCents: 3000, from: '2026-03-16' });
    const r = await post('/charges/ensure', tAdmin, { through: '2026-03-17' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ to: '2026-03-17', skipped: null, gaps: [] });
    expect((await post('/charges/ensure', tAdmin, { through: '2026-03-17' })).json().created).toBe(0);
    expect(r.json().created).toBeGreaterThanOrEqual(2);
    expect((await db.su.query(`select count(*)::int n from public.charges where assignment_id=$1`, [d.assignment])).rows[0].n).toBe(2);
    expect((await post('/charges/ensure', tSup, {})).statusCode).toBe(403);
    expect((await post('/charges/ensure', tOut, {})).statusCode).toBe(403);
    expect((await post('/charges/ensure', tAdmin, { through: 'ayer' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/v1/charges/ensure', payload: {} })).statusCode).toBe(401);
  });

  it('GET /charges/gaps lista lo no generado; weekly-collection expone planned_cents y missing_days; detail expone planned_cents/charge_generated/status', async () => {
    await db.driverWithAssignment({ code: '5', unit: 'P815', dailyCents: 2000, from: '2026-03-02' });
    await db.su.query(`update public.app_settings set charge_recovery_days = 1`);
    await post('/charges/ensure', tAdmin, { through: '2026-03-17' });
    const g = await get('/charges/gaps?through=2026-03-17', tAdmin);
    expect(g.statusCode).toBe(200);
    expect(g.json().length).toBeGreaterThan(0);
    expect(g.json()[0]).toMatchObject({ reason: 'outside_window', planned_cents: expect.any(Number), unit_code: expect.any(String) });
    expect((await get('/charges/gaps', tSup)).statusCode).toBe(403);
    const t = await get('/weekly-collection?weekStart=2026-03-02', tAdmin);
    const row = t.json().find((x: any) => x.unit_code === 'P815');
    expect(row).toMatchObject({ planned_cents: 12000, missing_days: 6 });
    const dt = await get(`/weekly-collection/detail?weekStart=2026-03-02&assignmentId=${row.assignment_id}`, tAdmin);
    expect(dt.json()[0].days[0]).toMatchObject({ planned_cents: 2000, charge_generated: false, status: 'missing' });
    await db.su.query(`update public.app_settings set charge_recovery_days = 14`);
  });

  it('historial de tarifas: POST /assignments/:id/rate con motivo y GET rate-history (solo ADMIN+)', async () => {
    const rr = await post(`/assignments/${a.assignment}/rate`, tAdmin, { dailyCents: 4500, from: '2026-03-19', reason: 'ajuste' });
    expect(rr.statusCode).toBe(200);
    expect(rr.json()).toMatchObject({ new_daily_cents: 4500, previous_daily_cents: 4000 });
    const bad = await post(`/assignments/${a.assignment}/rate`, tAdmin, { dailyCents: 5000, from: '2026-03-03' });
    expect(bad.statusCode).toBe(422); expect(bad.json().error).toBe('invalid_dates');
    const hh = await get(`/assignments/${a.assignment}/rate-history`, tAdmin);
    expect(hh.json()).toHaveLength(2);
    expect(hh.json()[0]).toMatchObject({ new_daily_cents: 4500, previous_daily_cents: 4000, reason: 'ajuste', is_current: expect.any(Boolean) });
    expect((await get('/rate-history', tAdmin)).json().length).toBeGreaterThanOrEqual(2);
    expect((await get('/rate-history', tSup)).statusCode).toBe(403);
    expect((await get('/rate-history', tOut)).statusCode).toBe(403);
    expect((await get('/assignments/no-uuid/rate-history', tAdmin)).statusCode).toBe(400);
  });
});

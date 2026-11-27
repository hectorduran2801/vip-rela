import { SignJWT } from 'jose';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newDb, type Db } from '@vip/db/testing';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createDatabase } from './db.js';
import { mapDbError } from './errors.js';

const SECRET = 'x'.repeat(40);
const sign = (sub: string) => new SignJWT({ role: 'authenticated', email: `${sub}@t.local` }).setProtectedHeader({ alg: 'HS256' })
  .setSubject(sub).setAudience('authenticated').setIssuedAt().setExpirationTime('5m').sign(new TextEncoder().encode(SECRET));

let db: Db, app: FastifyInstance, pool: pg.Pool;
let tSuper: string, tAdmin: string, tSup: string, tOut: string;
const MON = '2026-03-02';
const call = (method: 'GET' | 'POST' | 'DELETE', url: string, t: string, payload?: object) =>
  app.inject({ method, url: `/api/v1${url}`, headers: { authorization: `Bearer ${t}` }, ...(payload ? { payload } : {}) });
const exists = async (table: string, id: string) => Number((await db.su.query(`select count(*) n from public.${table} where id=$1`, [id])).rows[0].n) === 1;
async function engineCase(code: string, unit: string) {
  const x = await db.driverWithAssignment({ code, unit, dailyCents: 4000, from: '2026-03-01' });
  await db.as(db.admin, (q) => q.query(`select public.ensure_daily_charges($1::date, $1::date)`, [MON]));
  return x;
}

beforeAll(async () => {
  db = await newDb(); pool = new pg.Pool({ ...db.connection, max: 6 });
  app = await buildApp(loadConfig({ SUPABASE_JWT_SECRET: SECRET, CORS_ORIGINS: 'https://vip.example', RATE_LIMIT_PER_MINUTE: '100000' }), { db: createDatabase(pool) });
  tSuper = await sign(db.admin); tAdmin = await sign(db.opsAdmin); tSup = await sign(db.supervisor); tOut = await sign(db.outsider);
});
afterAll(async () => { await app.close(); await pool.end(); await db.close(); });

describe('API: eliminar, archivar y reactivar conductores y unidades', () => {
  it('CORS permite DELETE y PUT', async () => {
    const r = await app.inject({ method: 'OPTIONS', url: '/api/v1/drivers/x', headers: { origin: 'https://vip.example', 'access-control-request-method': 'DELETE' } });
    expect(r.headers['access-control-allow-origin']).toBe('https://vip.example');
    expect(String(r.headers['access-control-allow-methods'])).toMatch(/DELETE/); expect(String(r.headers['access-control-allow-methods'])).toMatch(/PUT/);
  });
  it('errores de negocio mapeados', () => {
    expect(mapDbError(new Error('delete_blocked_has_history'))).toEqual({ status: 409, error: 'delete_blocked_has_history' });
    expect(mapDbError(new Error('already_archived'))).toEqual({ status: 409, error: 'already_archived' });
    expect(mapDbError(new Error('not_archived'))).toEqual({ status: 409, error: 'not_archived' });
    expect(mapDbError(new Error('reason_too_long'))).toEqual({ status: 422, error: 'reason_too_long' });
  });
  it('delete-check y DELETE (conductor y unidad por error, con 1 cargo diario del motor); segunda vez 404', async () => {
    const x = await engineCase('1234', '4321');
    const c = await call('GET', `/drivers/${x.driver}/delete-check`, tAdmin);
    expect(c.statusCode).toBe(200);
    expect(c.json()).toMatchObject({ can_delete: true, suggestion: 'delete', blocked_by: [], will_delete: { assignments: 1, daily_charges: 1, rates: 1 } });
    expect((await call('GET', `/units/${x.unit}/delete-check`, tSuper)).json()).toMatchObject({ can_delete: true, will_delete: { daily_charges: 1 } });
    const d = await call('DELETE', `/drivers/${x.driver}?reason=creado%20por%20error`, tAdmin);
    expect(d.statusCode).toBe(200);
    expect(d.json()).toMatchObject({ deleted: true, kind: 'driver', operator_code: '1234', reason: 'creado por error', deleted_counts: { daily_charges: 1, assignments: 1 } });
    expect(await exists('drivers', x.driver)).toBe(false);
    const u = await call('DELETE', `/units/${x.unit}`, tSuper, { reason: 'duplicada' });
    expect(u.json()).toMatchObject({ deleted: true, kind: 'unit', code: '4321', reason: 'duplicada' });
    expect((await call('DELETE', `/drivers/${x.driver}`, tAdmin)).json()).toEqual({ error: 'driver_not_found' });
    expect((await call('DELETE', `/units/${x.unit}`, tAdmin)).statusCode).toBe(404);
    expect((await call('GET', `/drivers/${x.driver}/delete-check`, tAdmin)).statusCode).toBe(404);
  });
  it('con historial: 409 delete_blocked_has_history con los bloqueantes y sugerencia de archivar; archivar y reactivar', async () => {
    const x = await engineCase('HIS1', 'HISU1');
    await db.as(db.admin, (q) => q.query(`select public.register_payment($1,'cash',1000,'api-del-1')`, [x.assignment]));
    const r = await call('DELETE', `/drivers/${x.driver}`, tAdmin);
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ error: 'delete_blocked_has_history', blockers: { payments: 1 }, blocked_by: ['payments'], suggestion: 'archive' });
    expect((await call('DELETE', `/units/${x.unit}`, tAdmin)).json()).toMatchObject({ error: 'delete_blocked_has_history', blocked_by: ['payments'] });
    expect(await exists('drivers', x.driver)).toBe(true);
    const a = await call('POST', `/drivers/${x.driver}/archive`, tAdmin, { reason: 'baja' });
    expect(a.statusCode).toBe(200);
    expect(a.json()).toMatchObject({ archived: true, status: 'inactive', reason: 'baja' });
    expect(a.json().pending_cents).toBeGreaterThanOrEqual(3000);
    expect((await call('POST', `/drivers/${x.driver}/archive`, tAdmin, {})).json()).toEqual({ error: 'already_archived' });
    expect((await call('GET', `/drivers/${x.driver}/delete-check`, tAdmin)).json()).toMatchObject({ can_delete: false, entity: { archived: true } });
    const re = await call('POST', `/drivers/${x.driver}/reactivate`, tAdmin, {});
    expect(re.json()).toMatchObject({ reactivated: true, status: 'active' });
    expect((await call('POST', `/drivers/${x.driver}/reactivate`, tAdmin, {})).json()).toEqual({ error: 'not_archived' });
    // unidad
    const ua = await call('POST', `/units/${x.unit}/archive`, tSuper, {});
    expect(ua.json()).toMatchObject({ archived: true, vehicle_status: 'out_of_service', active: false });
    expect((await call('POST', `/units/${x.unit}/reactivate`, tSuper, { reason: 'listo' })).json()).toMatchObject({ reactivated: true, vehicle_status: 'active' });
  });
  it('entradas inválidas: 400; fecha efectiva anterior a cuotas: 422; motivo demasiado largo: 422', async () => {
    const x = await engineCase('VAL1', 'VALU1');
    expect((await call('DELETE', '/drivers/no-uuid', tAdmin)).statusCode).toBe(400);
    expect((await call('POST', `/drivers/${x.driver}/archive`, tAdmin, { effectiveDate: 'mañana' })).statusCode).toBe(400);
    expect((await call('POST', `/drivers/${x.driver}/archive`, tAdmin, { effectiveDate: '2026-03-01' })).statusCode).toBe(422);
    expect((await call('DELETE', `/drivers/${x.driver}`, tAdmin, { reason: 'x'.repeat(501) })).statusCode).toBe(400);
    expect(await exists('drivers', x.driver)).toBe(true);
  });
  it('permisos: supervisor y usuario sin rol reciben 403 en todo; sin token 401', async () => {
    const x = await engineCase('PER1', 'PERU1');
    for (const t of [tSup, tOut]) {
      const rs = await Promise.all([call('GET', `/drivers/${x.driver}/delete-check`, t), call('GET', `/units/${x.unit}/delete-check`, t), call('DELETE', `/drivers/${x.driver}`, t),
        call('DELETE', `/units/${x.unit}`, t), call('POST', `/drivers/${x.driver}/archive`, t, {}), call('POST', `/units/${x.unit}/archive`, t, {}),
        call('POST', `/drivers/${x.driver}/reactivate`, t, {}), call('POST', `/units/${x.unit}/reactivate`, t, {})]);
      expect(rs.map((r) => r.statusCode)).toEqual(Array(8).fill(403));
    }
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/drivers/${x.driver}` })).statusCode).toBe(401);
    expect(await exists('drivers', x.driver)).toBe(true);
  });
});

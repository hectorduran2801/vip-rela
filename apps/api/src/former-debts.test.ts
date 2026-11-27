import { SignJWT } from 'jose';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newDb, type Db } from '@vip/db/testing';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createDatabase } from './db.js';

/** Una sola regla: la cartera activa son las asignaciones vigentes; la deuda de las finalizadas se informa aparte y se puede consultar. */
const SECRET = 'x'.repeat(40);
const sign = (sub: string) => new SignJWT({ role: 'authenticated', email: `${sub}@t.local` }).setProtectedHeader({ alg: 'HS256' })
  .setSubject(sub).setAudience('authenticated').setIssuedAt().setExpirationTime('5m').sign(new TextEncoder().encode(SECRET));
let db: Db, pool: pg.Pool, app: FastifyInstance, token: string, outsider: string;
let gone: { driver: string; assignment: string };
const get = async (url: string, t = token) => app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${t}` } });

beforeAll(async () => {
  db = await newDb(); pool = new pg.Pool({ ...db.connection, max: 8 });
  app = await buildApp(loadConfig({ SUPABASE_JWT_SECRET: SECRET, RATE_LIMIT_PER_MINUTE: '100000', BILLING_ENGINE: 'false' }), { db: createDatabase(pool) });
  token = await sign(db.admin); outsider = await sign(db.outsider);
  const debt = (a: string, cents: number) => db.su.query(`insert into public.charges(assignment_id, kind, charge_date, amount_cents, week_start) values ($1,'opening','2026-01-04',$2,'2025-12-29')`, [a, cents]);
  const here = await db.driverWithAssignment({ code: '1', unit: 'U1', from: '2026-01-01' });
  gone = await db.driverWithAssignment({ code: '10325', unit: 'P280', from: '2026-01-01' });
  const clean = await db.driverWithAssignment({ code: '3', unit: 'U3', from: '2026-01-01' });
  await debt(here.assignment, 5000); await debt(gone.assignment, 19900);
  await db.su.query(`update public.assignments set valid_to = '2026-02-01' where id in ($1,$2)`, [gone.assignment, clean.assignment]);
});
afterAll(async () => { await app.close(); await pool.end(); await db.close(); });

describe('cartera activa y deuda de desvinculados', () => {
  it('Inicio cuenta solo las asignaciones vigentes', async () => {
    const d = (await get('/api/v1/dashboard')).json();
    expect(d.collections).toMatchObject({ pending_total_cents: 5000, drivers_with_debt: 1 });
  });
  it('la deuda finalizada no se pierde: se lista con unidad, operario, fecha y saldo (sin las que no deben)', async () => {
    expect((await get('/api/v1/former-debts')).json()).toEqual([{ assignmentId: gone.assignment, driverId: gone.driver, unitCode: 'P280', operatorCode: '10325',
      fullName: 'Conductor 10325', endedOn: '2026-02-01', pendingCents: 19900 }]);
  });
  it('quien no está autorizado no la ve', async () => {
    expect((await get('/api/v1/former-debts', outsider)).statusCode).toBe(403);
  });
});

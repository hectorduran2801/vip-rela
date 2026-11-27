import { SignJWT } from 'jose';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newDb, type Db } from '@vip/db/testing';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createDatabase } from './db.js';

const SECRET = 'x'.repeat(40);
const sign = (sub: string) => new SignJWT({ role: 'authenticated', email: `${sub}@t.local` }).setProtectedHeader({ alg: 'HS256' })
  .setSubject(sub).setAudience('authenticated').setIssuedAt().setExpirationTime('5m').sign(new TextEncoder().encode(SECRET));
let db: Db, pool: pg.Pool, app: FastifyInstance, token: string, supervisor: string, ids: string[];
const post = (t: string, body: Record<string, unknown>) => app.inject({ method: 'POST', url: '/api/v1/collection/resolve', headers: { authorization: `Bearer ${t}` }, payload: body });
const statuses = async () => (await db.su.query(`select status from public.whatsapp_test_messages where id = any($1) order by status`, [ids])).rows.map((r) => r.status);

beforeAll(async () => {
  db = await newDb(); pool = new pg.Pool({ ...db.connection, max: 4 });
  app = await buildApp(loadConfig({ SUPABASE_JWT_SECRET: SECRET, RATE_LIMIT_PER_MINUTE: '100000', BILLING_ENGINE: 'false' }), { db: createDatabase(pool) });
  token = await sign(db.opsAdmin); supervisor = await sign(db.supervisor);
  const driver = (await db.driverWithAssignment({ code: '1', unit: 'U1', from: '2026-01-01' })).driver;
  ids = [];
  for (const k of ['a', 'b']) ids.push((await db.su.query(`insert into public.whatsapp_test_messages(kind, recipient_phone, body, requested_mode, authorized_by, idempotency_key, driver_id, status)
    values ('collection_message','+50760001234','x','auto',$1,$2,$3,'unconfirmed') returning id`, [db.admin, `resolve-api-${k}-12345678`, driver])).rows[0].id);
});
afterAll(async () => { await app.close(); await pool.end(); await db.close(); });

describe('POST /collection/resolve', () => {
  it('un supervisor no puede y una petición vacía se rechaza', async () => {
    expect((await post(supervisor, { ids, arrived: false })).statusCode).toBe(403);
    expect((await post(token, { ids: [], arrived: false })).statusCode).toBeGreaterThanOrEqual(400);
    expect(await statuses()).toEqual(['unconfirmed', 'unconfirmed']);
  });
  it('quien administra marca que no llegaron; repetirlo no cambia nada', async () => {
    expect((await post(token, { ids, arrived: false })).json()).toEqual({ resolved: 2 });
    expect(await statuses()).toEqual(['failed', 'failed']);
    expect((await post(token, { ids, arrived: true })).statusCode).toBe(409);
    expect(await statuses()).toEqual(['failed', 'failed']);
  });
});

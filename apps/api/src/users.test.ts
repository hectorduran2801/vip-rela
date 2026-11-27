import { SignJWT } from 'jose';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newDb, type Db } from '@vip/db/testing';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createDatabase } from './db.js';
import { resetRoleCache } from './plugins/auth.js';

const SECRET = 'y'.repeat(40);
const sign = (sub: string) => new SignJWT({ role: 'authenticated', email: `${sub}@t.local` }).setProtectedHeader({ alg: 'HS256' })
  .setSubject(sub).setAudience('authenticated').setIssuedAt().setExpirationTime('5m').sign(new TextEncoder().encode(SECRET));

let db: Db, pool: pg.Pool; let tSuper: string, tAdminRole: string, tOut: string;
const calls: Array<{ url: string; body: any; headers: Record<string, string> }> = [];
let authReply: { status: number } = { status: 200 };
/** Simula la Admin API de Supabase Auth: al «crear» la identidad inserta en auth.users como lo haría GoTrue (los disparadores de VIP se ejecutan de verdad). */
const fakeFetch = (async (url: string, init: any) => {
  const body = JSON.parse(init.body); calls.push({ url, body, headers: init.headers });
  if (authReply.status !== 200) return new Response('{}', { status: authReply.status });
  if (init.method === 'PUT') return new Response('{}', { status: 200 });                    // actualización de una cuenta existente
  await db.su.query(`insert into auth.users(email, raw_user_meta_data) values ($1, $2)`, [body.email, JSON.stringify(body.user_metadata ?? {})]);
  return new Response('{}', { status: 200 });
}) as unknown as typeof fetch;

async function app(env: Record<string, string> = {}): Promise<FastifyInstance> {
  return buildApp(loadConfig({ SUPABASE_JWT_SECRET: SECRET, RATE_LIMIT_PER_MINUTE: '100000', ...env }), { db: createDatabase(pool), fetch: fakeFetch });
}
beforeAll(async () => {
  db = await newDb(); pool = new pg.Pool({ ...db.connection, max: 6 });
  tSuper = await sign(db.admin); tAdminRole = await sign(db.opsAdmin); tOut = await sign(db.outsider);
});
afterAll(async () => { await pool.end(); await db.close(); });
const call = (a: FastifyInstance, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, t: string, payload?: object) =>
  a.inject({ method, url: `/api/v1${url}`, headers: { authorization: `Bearer ${t}` }, payload });

describe('alta y gestión de usuarios internos desde VIP', () => {
  it('crea la cuenta ADMIN completa (Auth + rol) con la clave solo en el servidor; la contraseña no se registra ni se devuelve', async () => {
    resetRoleCache(); const a = await app({ SUPABASE_URL: 'https://proj.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k'.repeat(30) });
    const r = await call(a, 'POST', '/users/create', tSuper, { email: 'Nueva.Admin@vip.test', role: 'admin', password: 'Clave-inicial-123', fullName: 'Nueva Admin' });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ mode: 'created', created: true, email: 'nueva.admin@vip.test', role: 'admin' });
    expect(r.json().temporaryPassword).toBe('Clave-inicial-123');          // la contraseña temporal se devuelve una sola vez, para copiarla
    expect(calls.at(-1)).toMatchObject({ url: 'https://proj.supabase.co/auth/v1/admin/users', body: { email: 'nueva.admin@vip.test', email_confirm: true, user_metadata: { must_change_password: true } } });
    expect(calls.at(-1)!.headers.authorization).toBe(`Bearer ${'k'.repeat(30)}`);
    const row = (await db.su.query(`select a.role from public.app_users a join public.profiles p on p.id=a.user_id where p.email='nueva.admin@vip.test'`)).rows[0];
    expect(row.role).toBe('admin');
    // la nueva cuenta inicia sesión como ADMIN: opera, pero NO gestiona usuarios
    const id = (await db.su.query(`select id from auth.users where email='nueva.admin@vip.test'`)).rows[0].id;
    const tNew = await sign(id);
    expect((await call(a, 'GET', '/me', tNew)).json()).toMatchObject({ authorized: true, role: 'admin' });
    expect((await call(a, 'GET', `/weekly-collection?weekStart=2026-03-02`, tNew)).statusCode).toBe(200);
    expect((await call(a, 'GET', '/users', tNew)).statusCode).toBe(403);
    expect((await call(a, 'POST', '/users/create', tNew, { email: 'otra@vip.test', role: 'admin', password: 'Clave-inicial-123' })).statusCode).toBe(403);
    // suspender y reactivar
    expect((await call(a, 'POST', `/users/${id}/suspend`, tAdminRole, { suspended: true })).statusCode).toBe(403);
    expect((await call(a, 'POST', `/users/${id}/suspend`, tSuper, { suspended: true })).json()).toMatchObject({ suspended: true });
    expect((await call(a, 'GET', '/me', tNew)).json()).toMatchObject({ authorized: false, role: null });
    expect((await call(a, 'GET', `/weekly-collection?weekStart=2026-03-02`, tNew)).statusCode).toBe(403);
    expect((await call(a, 'POST', `/users/${id}/suspend`, tSuper, { suspended: false })).json()).toMatchObject({ suspended: false });
    expect((await call(a, 'GET', '/me', tNew)).json()).toMatchObject({ authorized: true, role: 'admin' });
    const list = (await call(a, 'GET', '/users', tSuper)).json();
    expect(list.find((u: any) => u.user_id === id)).toMatchObject({ role: 'admin', suspended_at: null });
    // el SUPER_ADMIN inicial se conserva y no se puede suspender/eliminar/degradar siendo el único
    expect((await call(a, 'POST', `/users/${db.admin}/suspend`, tSuper, { suspended: true })).json().error).toBe('last_super_admin');
    expect((await call(a, 'DELETE', `/users/${db.admin}`, tSuper)).json().error).toBe('last_super_admin');
    expect((await call(a, 'PUT', '/users', tSuper, { email: 'admin@test.local', role: 'admin' })).json().error).toBe('last_super_admin');
    await a.close();
  });
  it('sin clave de servicio: crea la cuenta directamente en la base con contraseña temporal generada y cambio obligatorio', async () => {
    resetRoleCache(); const a = await app({ SUPABASE_URL: 'https://proj.supabase.co' });
    const r = await call(a, 'POST', '/users/create', tSuper, { email: 'sin.clave@vip.test', role: 'admin' });
    expect(r.statusCode).toBe(201);
    const pw = r.json().temporaryPassword as string;
    expect(pw).toMatch(/^[A-Za-z0-9]{16}$/);
    const u = (await db.su.query(`select raw_user_meta_data m, encrypted_password e, extensions.crypt($2, encrypted_password) = encrypted_password ok from auth.users where email=$1`, ['sin.clave@vip.test', pw])).rows[0];
    expect(u.m.must_change_password).toBe(true); expect(u.ok).toBe(true);
    expect((await db.su.query(`select a.role from public.app_users a join public.profiles p on p.id=a.user_id where p.email='sin.clave@vip.test'`)).rows[0].role).toBe('admin');
    expect(JSON.stringify(calls.at(-1) ?? {})).not.toContain('sin.clave');   // no se llamó a la Admin API
    await a.close();
  });
  it('errores de Auth: usuario ya existente (409) y servicio caído (502); la invitación se retira', async () => {
    resetRoleCache(); const a = await app({ SUPABASE_URL: 'https://proj.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k'.repeat(30) });
    authReply = { status: 422 };
    const dup = await call(a, 'POST', '/users/create', tSuper, { email: 'dup@vip.test', role: 'admin', password: 'Clave-inicial-123' });
    expect(dup.statusCode).toBe(409); expect(dup.json().error).toBe('auth_user_exists');
    authReply = { status: 500 };
    expect((await call(a, 'POST', '/users/create', tSuper, { email: 'caido@vip.test', role: 'admin', password: 'Clave-inicial-123' })).json().error).toBe('auth_create_failed');
    authReply = { status: 200 };
    expect((await db.su.query(`select count(*)::int c from public.user_invites where email in ('dup@vip.test','caido@vip.test') and consumed_at is null`)).rows[0].c).toBe(0);
    await a.close();
  });
  it('invitar (sin clave) permite crear la cuenta en el panel de Supabase; listar y cancelar invitaciones; validaciones', async () => {
    resetRoleCache(); const a = await app();
    expect((await call(a, 'POST', '/users/invite', tSuper, { email: 'panel@vip.test', role: 'admin' })).json()).toMatchObject({ mode: 'invited', role: 'admin' });
    expect((await call(a, 'GET', '/users/invites', tSuper)).json().map((i: any) => i.email)).toContain('panel@vip.test');
    // lo que ocurre cuando alguien la crea en Supabase → Authentication → Users
    await db.su.query(`insert into auth.users(email, raw_user_meta_data) values ('panel@vip.test','{}')`);
    expect((await db.su.query(`select a.role from public.app_users a join public.profiles p on p.id=a.user_id where p.email='panel@vip.test'`)).rows[0].role).toBe('admin');
    expect((await call(a, 'POST', '/users/invite', tSuper, { email: 'cancelar@vip.test', role: 'admin' })).statusCode).toBe(201);
    expect((await call(a, 'POST', '/users/invites/cancel', tSuper, { email: 'cancelar@vip.test' })).statusCode).toBe(204);
    expect((await call(a, 'POST', '/users/invites/cancel', tSuper, { email: 'cancelar@vip.test' })).json().error).toBe('invite_not_found');
    expect((await call(a, 'POST', '/users/invite', tSuper, { email: 'x@vip.test', role: 'supervisor' })).statusCode).toBe(400);
    expect((await call(a, 'POST', '/users/invite', tSuper, { email: 'no-correo', role: 'admin' })).statusCode).toBe(400);
    for (const t of [tAdminRole, tOut]) expect((await call(a, 'POST', '/users/invite', t, { email: 'z@vip.test', role: 'admin' })).statusCode).toBe(403);
    expect((await a.inject({ method: 'POST', url: '/api/v1/users/invite', payload: { email: 'z@vip.test', role: 'admin' } })).statusCode).toBe(401);
    await a.close();
  });
  it('una contraseña corta se rechaza antes de tocar nada', async () => {
    resetRoleCache(); const a = await app({ SUPABASE_URL: 'https://proj.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k'.repeat(30) });
    const n = calls.length;
    expect((await call(a, 'POST', '/users/create', tSuper, { email: 'corta@vip.test', role: 'admin', password: 'corta' })).statusCode).toBe(400);
    expect(calls.length).toBe(n); await a.close();
  });
});

describe('restablecer credenciales de una cuenta', () => {
  const env = { SUPABASE_URL: 'https://proj.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k'.repeat(30) };
  it('SUPER_ADMIN genera una contraseña temporal nueva (una sola vez), obliga a cambiarla, audita sin guardar la clave y no sirve para la cuenta propia', async () => {
    resetRoleCache(); const a = await app(env);
    const r = await call(a, 'POST', `/users/${db.opsAdmin}/reset-credentials`, tSuper);
    expect(r.statusCode).toBe(200);
    const j = r.json();
    expect(j.email).toBe('ops-admin@test.local'); expect(j.temporaryPassword).toMatch(/^[A-Za-z0-9]{16}$/);
    const c = calls.at(-1)!;
    expect(c.url).toBe(`https://proj.supabase.co/auth/v1/admin/users/${db.opsAdmin}`);
    expect(c.body).toEqual({ password: j.temporaryPassword, user_metadata: { must_change_password: true } });
    expect(c.headers.authorization).toBe(`Bearer ${'k'.repeat(30)}`);
    const log = (await db.su.query(`select detail::text d, actor from public.audit_logs where action='user_credentials_reset' order by at desc limit 1`)).rows[0];
    expect(log.actor).toBe(db.admin); expect(log.d).toContain('ops-admin@test.local'); expect(log.d).not.toContain(j.temporaryPassword);
    expect((await call(a, 'POST', `/users/${db.opsAdmin}/reset-credentials`, tSuper)).json().temporaryPassword).not.toBe(j.temporaryPassword);   // cada restablecimiento genera una nueva
    expect((await call(a, 'POST', `/users/${db.admin}/reset-credentials`, tSuper)).statusCode).toBe(403);                                     // la propia cuenta: usa «cambiar contraseña»
  });
  it('un ADMIN no puede; una cuenta que no existe en VIP da 404; si Auth falla se informa sin exponer nada', async () => {
    resetRoleCache(); const a = await app(env);
    expect((await call(a, 'POST', `/users/${db.opsAdmin}/reset-credentials`, tAdminRole)).statusCode).toBe(403);
    expect((await call(a, 'POST', `/users/${db.outsider}/reset-credentials`, tSuper)).statusCode).toBe(404);
    expect((await call(a, 'POST', `/users/no-es-uuid/reset-credentials`, tSuper)).statusCode).toBe(400);
    authReply = { status: 500 };
    const r = await call(a, 'POST', `/users/${db.opsAdmin}/reset-credentials`, tSuper);
    authReply = { status: 200 };
    expect(r.statusCode).toBe(502); expect(r.json()).toEqual({ error: 'auth_reset_failed' });
  });
  it('en desarrollo local (sin clave de servicio) lo aplica directamente en la base: la clave nueva funciona y obliga a cambiarla', async () => {
    resetRoleCache(); const a = await app();
    const r = await call(a, 'POST', `/users/${db.opsAdmin}/reset-credentials`, tSuper);
    expect(r.statusCode).toBe(200);
    const row = (await db.su.query(`select raw_user_meta_data->>'must_change_password' m, encrypted_password = extensions.crypt($2, encrypted_password) ok from auth.users where id=$1`, [db.opsAdmin, r.json().temporaryPassword])).rows[0];
    expect(row).toEqual({ m: 'true', ok: true });
  });
});

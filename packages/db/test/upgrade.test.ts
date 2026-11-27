import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import { MIGRATIONS_DIR, STUB_SQL, connConfig } from './pg-cluster.js';

/** Ensayo del camino REAL de actualización: la base de desarrollo está en 0006 con la administradora ya autorizada. */
let admin: pg.Client; let db: pg.Client; let name: string;
const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
const upTo = (n: string) => files.filter((f) => f < `20261116${n}`);
const apply = async (c: pg.Client, list: string[]) => { for (const f of list) await c.query(readFileSync(join(MIGRATIONS_DIR, f), 'utf8')); };
const as = async <T>(id: string, fn: (c: pg.Client) => Promise<T>): Promise<T> => {
  await db.query('begin'); try {
    await db.query('set local role authenticated'); await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: id, role: 'authenticated' })]);
    const r = await fn(db); await db.query('commit'); return r;
  } catch (e) { await db.query('rollback'); throw e; }
};

let adminId: string;
beforeAll(async () => {
  const c = inject('pgCluster');
  name = `up_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
  admin = new pg.Client(connConfig(c, 'postgres')); await admin.connect(); await admin.query(`create database ${name}`);
  db = new pg.Client(connConfig(c, name)); await db.connect();
  await db.query(readFileSync(STUB_SQL, 'utf8'));
  adminId = (await db.query(`insert into auth.users(email, raw_user_meta_data) values ('real-admin@test.local','{}') returning id`)).rows[0].id;   // existía ANTES de instalar VIP
  await apply(db, upTo('000700'));                                   // estado actual de Supabase de desarrollo
  await db.query(`select public.authorize_admin($1)`, [adminId]);
});
afterAll(async () => { await db.end(); await admin.query(`drop database if exists ${name} with (force)`); await admin.end(); });

describe('actualización 0006 → 0009 sobre una base con administradora y datos', () => {
  it('estado inicial: una administradora, sin roles', async () => {
    expect((await db.query(`select count(*)::int n from public.app_admins`)).rows[0].n).toBe(1);
    expect((await db.query(`select to_regclass('public.app_users') is null r`)).rows[0].r).toBe(true);
  });
  it('datos existentes (conductor, unidad, asignación, cargo, pago) sobreviven a 0007–0009 sin cambios', async () => {
    const d = (await db.query(`insert into public.drivers(operator_code, national_id, first_name) values ('U1','8-1-1','Existente') returning id`)).rows[0].id;
    const u = (await db.query(`insert into public.units(code) values ('PU1') returning id`)).rows[0].id;
    const a = (await db.query(`insert into public.assignments(driver_id, unit_id, valid_from) values ($1,$2,'2026-01-01') returning id`, [d, u])).rows[0].id;
    await db.query(`insert into public.rates(assignment_id, daily_amount_cents, valid_from) values ($1,3600,'2026-01-01')`, [a]);
    await as(adminId, (c) => c.query(`select public.generate_daily_charges('2026-03-02')`));
    await as(adminId, (c) => c.query(`select public.register_payment($1,'yappy',3700,'upg-1',null,'2026-03-02T09:00:00-05:00')`, [a]));
    const snap = async () => (await db.query(`select (select count(*) from public.drivers)::int d, (select count(*) from public.units)::int u, (select count(*) from public.assignments)::int a,
      (select count(*) from public.payments)::int p, (select coalesce(sum(net_cents),0) from public.payments)::int net, (select count(*) from public.charges)::int c, (select count(*) from public.payment_allocations)::int al`)).rows[0];
    const before = await snap();
    await apply(db, files.filter((f) => f >= '20261116000700' && f < '20261116001000'));
    expect(await snap()).toEqual(before);
    expect(before).toMatchObject({ d: 1, u: 1, p: 1, net: 3600 });
  });
  it('la administradora ya autorizada pasa a SUPER_ADMIN y conserva el acceso; no se crean cuentas', async () => {
    expect((await db.query(`select role::text r from public.app_users where user_id=$1`, [adminId])).rows[0].r).toBe('super_admin');
    expect((await db.query(`select to_regclass('public.app_admins') is null r`)).rows[0].r).toBe(true);
    expect((await db.query(`select count(*)::int n from auth.users`)).rows[0].n).toBe(1);
    expect(await as(adminId, async (c) => (await c.query(`select public.current_app_role() r`)).rows[0].r)).toBe('super_admin');
    expect(await as(adminId, async (c) => (await c.query(`select public.is_authorized() r`)).rows[0].r)).toBe(true);
    expect(await as(adminId, async (c) => (await c.query(`select public.dashboard_summary() s`)).rows[0].s.drivers.total)).toBe(1);
  });
  it('0009 → 0010: lo registrado con el catálogo de condiciones se CONSERVA como texto libre, con su historial', async () => {
    const u1 = (await db.query(`select id from public.units where code='PU1'`)).rows[0].id;
    const u2 = (await db.query(`insert into public.units(code) values ('PU2') returning id`)).rows[0].id;
    await as(adminId, (c) => c.query(`select public.set_unit_condition($1,'rescue','En proceso de rescate')`, [u1]));
    await as(adminId, (c) => c.query(`select public.set_unit_condition($1,'other','PENDIENTE DE REVISADO')`, [u2]));
    await as(adminId, (c) => c.query(`select public.set_unit_condition($1,'custody','Hasta el viernes')`, [u1]));
    const payBefore = (await db.query(`select count(*)::int c, sum(net_cents)::int n from public.payments`)).rows[0];
    await apply(db, files.filter((f) => f >= '20261116001000'));
    const r = (await db.query(`select code, agreement, agreement_note from public.units where code in ('PU1','PU2') order by code`)).rows;
    expect(r).toEqual([{ code: 'PU1', agreement: 'Custodia', agreement_note: 'Hasta el viernes' }, { code: 'PU2', agreement: 'PENDIENTE DE REVISADO', agreement_note: null }]);
    const h = (await db.query(`select h.agreement, h.previous_agreement p, h.changed_by from public.unit_agreement_history h join public.units u on u.id=h.unit_id where u.code='PU1' order by h.id`)).rows;
    expect(h.map((x) => [x.p, x.agreement])).toEqual([[null, 'Rescate'], ['Rescate', 'Custodia']]);
    expect(h.every((x) => x.changed_by === adminId)).toBe(true);                                   // quién se conserva
    expect((await db.query(`select to_regclass('public.unit_condition_types') is null a, to_regclass('public.unit_condition_history') is null b`)).rows[0]).toEqual({ a: true, b: true });
    expect((await db.query(`select count(*)::int c, sum(net_cents)::int n from public.payments`)).rows[0]).toEqual(payBefore);        // finanzas intactas
  });
  it('las funciones de 0008/0010 existen y funcionan tras la actualización (acuerdo libre, roles, importación)', async () => {
    const u = (await db.query(`select id from public.units where code='PU1'`)).rows[0].id;
    expect((await as(adminId, async (c) => (await c.query(`select public.set_unit_agreement($1,'CHAPA','Se revisa el lunes') r`, [u])).rows[0].r)).changed).toBe(true);
    expect((await db.query(`select agreement a from public.units where id=$1`, [u])).rows[0].a).toBe('CHAPA');
    expect((await db.query(`select to_regprocedure('public.apply_directory_import(uuid,date,text,boolean)') is not null r`)).rows[0].r).toBe(true);
    expect((await db.query(`select environment from public.app_settings`)).rows[0].environment).toBe('development');
  });
  it('seguridad intacta tras actualizar: anon sin acceso, usuario sin rol sin acceso, alta de usuarios en Auth cerrada, RLS en todas las tablas', async () => {
    const other = (await db.query(`select gen_random_uuid() id`)).rows[0].id;
    expect(await as(other, async (c) => (await c.query(`select public.is_authorized() r`)).rows[0].r)).toBe(false);
    expect(await as(other, async (c) => (await c.query(`select count(*)::int n from public.drivers`)).rows[0].n)).toBe(0);
    await db.query('begin'); await db.query('set local role anon');
    const e = await db.query(`select * from public.drivers`).then(() => null, (x) => x.message as string); await db.query('rollback');
    expect(e).toMatch(/permission denied/);
    expect(await db.query(`insert into auth.users(email) values ('intruso@test.local')`).then(() => null, (x) => x.message)).toMatch(/signups_closed/);
    expect((await db.query(`select count(*)::int n from pg_tables t join pg_class c on c.relname=t.tablename and c.relnamespace='public'::regnamespace where t.schemaname='public' and not c.relrowsecurity`)).rows[0].n).toBe(0);
  });
});

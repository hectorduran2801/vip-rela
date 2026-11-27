import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MON, chargeWeek, key, pay } from './fixtures.js';
import { newDb, type Db } from './harness.js';
// @ts-expect-error módulo .mjs sin tipos
import * as reset from '../../../scripts/db-reset-dev/lib.mjs';

const REF = 'ekhxxedpqnjpibpmpcmf';
const PHRASE = `REINICIAR VIP DEV ${REF}`;
let db: Db; let client: pg.Client;

beforeAll(async () => {
  db = await newDb();
  client = new pg.Client(db.connection); await client.connect();
  const a = await db.driverWithAssignment({ code: 'RS1', unit: 'RSU1', dailyCents: 3600, phone: '+50760009999', consent: true });
  const b = await db.driverWithAssignment({ code: 'RS2', unit: 'RSU2', dailyCents: 3000 });
  await chargeWeek(db, MON);
  await db.as(db.admin, (q) => pay(q, a.assignment, 'yappy', 22100, { paidAt: `${MON}T10:00:00-05:00` }));      // pago + asignaciones + crédito + aviso
  await db.as(db.admin, (q) => pay(q, b.assignment, 'cash', 1000, { paidAt: `${MON}T11:00:00-05:00` }));
  await db.as(db.admin, (q) => q.query(`select public.create_adjustment($1, 500, $2::date, 'ajuste de prueba', $3)`, [b.assignment, MON, key()]));
  await db.as(db.admin, (q) => q.query(`select public.close_week($1)`, [MON]));
  const imp = (await db.su.query(`insert into public.excel_imports(file_name, file_sha256, created_by) values ('t.xlsx','sha-reset',$1) returning id`, [db.admin])).rows[0].id;
  const blk = (await db.su.query(`insert into public.import_blocks(import_id, block_index, start_column, header_variant) values ($1,1,'B','x') returning id`, [imp])).rows[0].id;
  const row = (await db.su.query(`insert into public.import_rows(block_id, source_row, operator_code) values ($1,2,'RS1') returning id`, [blk])).rows[0].id;
  await db.su.query(`insert into public.candidate_payments(import_row_id, weekday, amount_cents) values ($1,1,100)`, [row]);
  await db.su.query(`insert into public.rate_exceptions(assignment_id, on_date, amount_cents, reason) values ($1,'2026-03-04',0,'día libre')`, [a.assignment]);
});
afterAll(async () => { await client.end(); await db.close(); });

const counts = async (tables: string[]) => Object.fromEntries(await Promise.all(tables.map(async (t) => [t, Number((await db.su.query(`select count(*) n from ${t}`)).rows[0].n)])));
const schemaFingerprint = async () => (await db.su.query(`select
  (select count(*) from pg_tables where schemaname='public') t, (select count(*) from pg_policies where schemaname='public') p,
  (select count(*) from pg_proc where pronamespace in ('public'::regnamespace,'app_private'::regnamespace)) f,
  (select count(*) from pg_trigger where not tgisinternal) g, (select count(*) from pg_class c where relnamespace='public'::regnamespace and relkind='r' and relrowsecurity) rls`)).rows[0];

describe('salvaguardas del destino', () => {
  const url = (user: string, host: string) => `postgresql://${user}:x@${host}:5432/postgres`;
  it('acepta solo el proyecto de desarrollo autorizado (pooler o host directo)', () => {
    expect(reset.assertDevTarget({ databaseUrl: url(`postgres.${REF}`, 'aws-1-us-east-1.pooler.supabase.com') }).ref).toBe(REF);
    expect(reset.assertDevTarget({ databaseUrl: url('postgres', `db.${REF}.supabase.co`) }).ref).toBe(REF);
  });
  it.each([
    ['otro proyecto Supabase', url('postgres.abcdefghijklmnopqrst', 'aws-1-us-east-1.pooler.supabase.com'), {}],
    ['host desconocido', url('postgres', 'example.com'), {}],
    ['entorno de producción (VIP_ENV)', url(`postgres.${REF}`, 'aws-1-us-east-1.pooler.supabase.com'), { VIP_ENV: 'production' }],
    ['entorno de producción (NODE_ENV)', url(`postgres.${REF}`, 'aws-1-us-east-1.pooler.supabase.com'), { NODE_ENV: 'production' }],
    ['base local sin permiso explícito', url('postgres', 'localhost'), {}],
  ])('rechaza: %s', (_n, databaseUrl, env) => {
    expect(() => reset.assertDevTarget({ databaseUrl, env })).toThrow();
  });
  it('la frase de confirmación incluye el proyecto', () => { expect(reset.confirmationPhrase(REF)).toBe(PHRASE); });
});

describe('cobertura: toda tabla de la base está clasificada', () => {
  it('RESET_TABLES + KEEP_TABLES = todas las tablas de public (una tabla nueva obliga a decidir)', async () => {
    const all = (await db.su.query(`select tablename from pg_tables where schemaname='public' order by 1`)).rows.map((r) => r.tablename);
    expect([...reset.RESET_TABLES, ...reset.KEEP_TABLES].sort()).toEqual(all);
  });
});

describe('vista previa (solo lectura)', () => {
  it('cuenta lo que se eliminaría y lo que se conserva, sin cambiar nada', async () => {
    const before = await counts(reset.RESET_TABLES.map((t: string) => `public.${t}`));
    const plan = await reset.planReset(client);
    expect(plan.environment).toBe('development');
    expect(plan.reset.drivers).toBe(2); expect(plan.reset.payments).toBe(2); expect(plan.reset.weekly_closures).toBeGreaterThan(0);
    expect(plan.keep.app_users).toBe(3); expect(plan.keep.payment_methods).toBe(3); expect(plan.keep['auth.users']).toBeGreaterThanOrEqual(4);
    expect(await counts(reset.RESET_TABLES.map((t: string) => `public.${t}`))).toEqual(before);
  });
  it('se niega si la base declara environment = production', async () => {
    await db.su.query(`update public.app_settings set environment = 'production'`);
    await expect(reset.planReset(client)).rejects.toThrow(/production/);
    await expect(reset.executeReset(client, { typed: PHRASE })).rejects.toThrow(/production/);
    expect((await counts(['public.drivers'])).drivers ?? (await counts(['public.drivers']))['public.drivers']).toBeGreaterThan(0);
    await db.su.query(`update public.app_settings set environment = 'development'`);
  });
});

describe('ejecución', () => {
  it('sin la frase exacta no cambia nada', async () => {
    const before = await counts(['public.drivers', 'public.payments']);
    await expect(reset.executeReset(client, { typed: 'reiniciar' })).rejects.toThrow(/Frase de confirmación/);
    await expect(reset.executeReset(client, { typed: undefined })).rejects.toThrow(/Frase de confirmación/);
    expect(await counts(['public.drivers', 'public.payments'])).toEqual(before);
  });
  it('si algo falla antes de confirmar, REVIERTE todo', async () => {
    const before = await counts([...reset.RESET_TABLES.map((t: string) => `public.${t}`), 'public.audit_logs']);
    await expect(reset.executeReset(client, { typed: PHRASE, beforeCommit: async () => { throw new Error('fallo simulado'); } })).rejects.toThrow(/fallo simulado/);
    expect(await counts([...reset.RESET_TABLES.map((t: string) => `public.${t}`), 'public.audit_logs'])).toEqual(before);
  });
  it('vacía solo los datos operativos y conserva Auth, roles, configuración, estructura, RLS y funciones', async () => {
    const keepTables = [...reset.KEEP_TABLES.filter((t: string) => t !== 'audit_logs').map((t: string) => `public.${t}`), 'auth.users'];
    const keepBefore = await counts(keepTables); const auditBefore = (await counts(['public.audit_logs']))['public.audit_logs']!;
    const fpBefore = await schemaFingerprint();
    const res = await reset.executeReset(client, { typed: PHRASE });
    expect(res.total).toBeGreaterThan(0);
    for (const t of reset.RESET_TABLES) expect(Number((await db.su.query(`select count(*) n from public.${t}`)).rows[0].n), t).toBe(0);
    expect(await counts(keepTables)).toEqual(keepBefore);
    expect(await schemaFingerprint()).toEqual(fpBefore);
    expect((await counts(['public.audit_logs']))['public.audit_logs']).toBe(auditBefore + 1);                    // se conserva la auditoría y se añade el registro del reinicio
    expect((await db.su.query(`select detail from public.audit_logs where action='db_reset_dev'`)).rows[0].detail.ref).toBe(REF);
    expect((await db.su.query(`select count(*)::int n from public.app_users where role='super_admin'`)).rows[0].n).toBe(1);
  });
  it('tras el reinicio el sistema sigue operativo y se puede volver a importar y cobrar', async () => {
    expect(await db.as(db.admin, async (q) => (await q.one(`select public.dashboard_summary() s`)).s.drivers.total)).toBe(0);
    expect(await db.as(db.admin, (q) => q.fails(`select public.register_payment(gen_random_uuid(),'cash',100,'k-post-reset')`))).toBe('assignment_not_found');
    const x = await db.driverWithAssignment({ code: 'POST1', unit: 'PU1', dailyCents: 3600 });
    await chargeWeek(db, MON);
    expect((await db.as(db.admin, (q) => pay(q, x.assignment, 'cash', 3600))).pending_cents).toBe(18000);
    expect(await db.as(db.opsAdmin, (q) => q.fails(`select 1`))).toBeNull();
  });
  it('es idempotente: repetirlo sobre una base ya vacía no falla', async () => {
    await reset.executeReset(client, { typed: PHRASE });
    const res = await reset.executeReset(client, { typed: PHRASE });
    expect(res.total).toBe(0);
  });
});

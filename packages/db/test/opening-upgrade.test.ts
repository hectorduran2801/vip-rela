import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import { MIGRATIONS_DIR, STUB_SQL, connConfig } from './pg-cluster.js';

/** La migración 0019 debe poder aplicarse sobre una base YA con datos (0001–0018) sin tocar una sola fila existente. */
let admin: pg.Client; let db: pg.Client; let name: string; let adminId: string;
const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
const MIG = '20261116001900_opening_balances.sql';
const as = async <T>(fn: (c: pg.Client) => Promise<T>): Promise<T> => {
  await db.query('begin'); try {
    await db.query('set local role authenticated'); await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: adminId, role: 'authenticated' })]);
    const r = await fn(db); await db.query('commit'); return r;
  } catch (e) { await db.query('rollback'); throw e; }
};
const tables = ['drivers', 'units', 'assignments', 'rates', 'charges', 'payments', 'payment_allocations', 'adjustments', 'weekly_closures', 'excel_imports', 'import_blocks', 'import_rows', 'audit_logs'];
const snapshot = async () => {
  const out: Record<string, string> = {};
  // import_rows gana raw_phone y charges source_*: se comparan SOLO las columnas que ya existían.
  const cols: Record<string, string> = { charges: 'id, assignment_id, kind, charge_date, amount_cents, week_start, adjustment_id, created_at', import_rows: 'id, block_id, source_row, unit_code, operator_code, raw_saldo, phone_e164' };
  for (const t of tables) out[t] = (await db.query(`select coalesce(md5(string_agg(x::text, '|' order by x::text)), '') h, count(*)::int n from (select ${cols[t] ?? '*'} from public.${t}) x`)).rows.map((r) => `${r.n}:${r.h}`)[0]!;
  return out;
};

beforeAll(async () => {
  const c = inject('pgCluster');
  name = `op_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
  admin = new pg.Client(connConfig(c, 'postgres')); await admin.connect(); await admin.query(`create database ${name}`);
  db = new pg.Client(connConfig(c, name)); await db.connect();
  await db.query(readFileSync(STUB_SQL, 'utf8'));
  adminId = (await db.query(`insert into auth.users(email, raw_user_meta_data) values ('real-admin@test.local','{}') returning id`)).rows[0].id;
  for (const f of files.filter((x) => x < MIG)) await db.query(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'));
  await db.query(`select public.authorize_admin($1)`, [adminId]);
});
afterAll(async () => { await db.end(); await admin.query(`drop database if exists ${name} with (force)`); await admin.end(); });

describe('0018 → 0019 sobre una base con datos', () => {
  it('no modifica, borra ni inserta ninguna fila; posiciones y tabla semanal conservan sus valores', async () => {
    const d = (await db.query(`insert into public.drivers(operator_code, national_id, first_name) values ('UP1','8-9-9','Existente') returning id`)).rows[0].id;
    const u = (await db.query(`insert into public.units(code) values ('UPU1') returning id`)).rows[0].id;
    const a = (await db.query(`insert into public.assignments(driver_id, unit_id, valid_from) values ($1,$2,'2026-01-01') returning id`, [d, u])).rows[0].id;
    await db.query(`insert into public.rates(assignment_id, daily_amount_cents, valid_from) values ($1,3900,'2026-01-01')`, [a]);
    for (const day of ['2026-03-02', '2026-03-03', '2026-03-04']) await as((c) => c.query(`select public.generate_daily_charges($1::date)`, [day]));
    await as((c) => c.query(`select public.register_payment($1,'yappy',5100,'up-1',null,'2026-03-03T09:00:00-05:00')`, [a]));
    await as((c) => c.query(`select public.create_adjustment($1, 500, '2026-03-04', 'ajuste de prueba', 'adj-1')`, [a]));
    await as((c) => c.query(`select public.close_week('2026-03-02')`));
    const rowsBefore = await snapshot();
    const posBefore = (await db.query(`select * from public.assignment_position($1)`, [a])).rows[0];
    const tblBefore = await as(async (c) => (await c.query(`select assignment_id, week_charged_cents::int ch, net_cents::int net, pending_cents::int p, credit_cents::int cr from public.weekly_collection_table('2026-03-02')`)).rows);
    const detBefore = await as(async (c) => (await c.query(`select * from public.weekly_collection_detail('2026-03-02')`)).rows);

    await db.query(readFileSync(join(MIGRATIONS_DIR, MIG), 'utf8'));

    expect(await snapshot()).toEqual(rowsBefore);
    expect((await db.query(`select * from public.assignment_position($1)`, [a])).rows[0]).toEqual(posBefore);
    const tblAfter = await as(async (c) => (await c.query(`select assignment_id, week_charged_cents::int ch, net_cents::int net, pending_cents::int p, credit_cents::int cr, previous_pending_cents::int pp, opening_cents::int op from public.weekly_collection_table('2026-03-02')`)).rows);
    expect(tblAfter.map(({ pp, op, ...r }) => r)).toEqual(tblBefore);
    expect(tblAfter[0]).toMatchObject({ pp: 0, op: 0 });
    expect(await as(async (c) => (await c.query(`select * from public.weekly_collection_detail('2026-03-02')`)).rows)).toEqual(detBefore);
    expect((await db.query(`select count(*)::int n from public.charges where kind='opening'`)).rows[0].n).toBe(0);
  });
  it('las nuevas funciones existen con permisos solo para authenticated/service_role', async () => {
    const r = await db.query(`select p.proname, has_function_privilege('anon', p.oid, 'execute') anon, has_function_privilege('authenticated', p.oid, 'execute') auth
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname='public' and p.proname in ('preview_opening_balances','apply_opening_balances','weekly_collection_table') order by 1`);
    expect(r.rows).toEqual([{ proname: 'apply_opening_balances', anon: false, auth: true }, { proname: 'preview_opening_balances', anon: false, auth: true }, { proname: 'weekly_collection_table', anon: false, auth: true }]);
  });
});

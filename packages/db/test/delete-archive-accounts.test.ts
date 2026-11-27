import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { newDb, type Db } from './harness.js';
import { MIGRATIONS_DIR, buildTemplate, connConfig } from './pg-cluster.js';

/** 0056 sobre una base COMO PRODUCCIÓN (sin 0023 ni lo posterior pendiente): queda igual que la completa y respeta las cuentas. */
const MAIN = '00000000-0000-4000-8000-000000000001';
const file = (n: string) => readFileSync(join(MIGRATIONS_DIR, n), 'utf8');
const UP = file('20261116005600_delete_archive_for_accounts.sql');
const DOWN = readFileSync(join(MIGRATIONS_DIR, '../rollback/0056_delete_archive_down.sql'), 'utf8');
const NAMES = ['delete_plan', 'driver_delete_check', 'unit_delete_check', 'delete_driver', 'delete_unit', 'archive_driver', 'archive_unit', 'reactivate_driver',
  'reactivate_unit', 'complete_charges_for_archive', 'end_open_assignments', 'clean_reason', 'block_mutation_unless_cascade', 'audit_row'];
const SHAPE = `select p.proname k, regexp_replace(regexp_replace(p.prosrc, '--[^\\n]*', '', 'g'), '\\s+', '', 'g') || ' ' || pg_get_userbyid(p.proowner) || ' ' || p.prosecdef
    || ' ' || has_function_privilege('authenticated', p.oid, 'execute') || ' ' || has_function_privilege('anon', p.oid, 'execute') v from pg_proc p where p.proname = any($1)
  union all select c.relname || '.' || t.tgname, pg_get_triggerdef(t.oid) from pg_trigger t join pg_class c on c.oid = t.tgrelid
   where c.relname in ('charges', 'driver_consents', 'unit_agreement_history') and not t.tgisinternal order by 1, 2`;

let db: Db; let full: Db; let before: unknown[]; let rolledBack: unknown[];
let other: string; let acc: string;
const shape = async (d: Db) => (await d.su.query(SHAPE, [NAMES])).rows;
const driverIn = async (account: string, code: string, unit: string) => {
  const x = await db.driverWithAssignment({ code, unit, dailyCents: 3000, from: '2026-11-01' });
  await db.su.query(`update public.rates set account_id=$1 where assignment_id=$2`, [account, x.assignment]);
  await db.su.query(`update public.assignments set account_id=$1 where id=$2`, [account, x.assignment]);
  await db.su.query(`update public.drivers set account_id=$1 where id=$2`, [account, x.driver]);
  await db.su.query(`update public.units set account_id=$1 where id=$2`, [account, x.unit]);
  return x;
};
const check = (who: string, driver: string) => db.as(who, (q) => q.one(`select public.driver_delete_check($1) r`, [driver])).then((r: any) => r.r);
const exists = async (driver: string) => Number((await db.su.query(`select count(*) n from public.drivers where id=$1`, [driver])).rows[0].n) === 1;

beforeAll(async () => {
  const c = inject('pgCluster');
  await buildTemplate(c as never, 'vip_sin_0023', ['2300', '5500', '5600']);
  db = await newDb({ template: 'vip_sin_0023' });
  full = await newDb();
  before = await shape(db);
  await db.su.query(UP); await db.su.query(DOWN); rolledBack = await shape(db);      // ida y vuelta
  await db.su.query(UP);
  other = db.outsider;
  await db.su.query(`insert into public.app_users(user_id, role, created_by) values ($1,'admin',$2)`, [other, db.admin]);
  acc = (await db.su.query(`select account_id a from public.app_users where user_id=$1`, [other])).rows[0].a;
}, 180_000);
afterAll(async () => { await db.close(); await full.close(); });

describe('0056 · eliminar y dar de baja sobre una base como producción', () => {
  it('antes no existían las funciones (el 503) y la reversión deja todo como estaba', () => {
    expect((before as { k: string }[]).map((r) => r.k)).not.toContain('driver_delete_check');
    expect(rolledBack).toEqual(before);
  });
  it('queda igual que una base con todas las migraciones', async () => {
    expect(await shape(db)).toEqual(await shape(full));
  });
  it('ninguna función de la app queda con un dueño que se salte la separación', async () => {
    const r = (await db.su.query(`select proname, pg_get_userbyid(proowner) o from pg_proc where proname = any($1) and prosecdef and prorettype <> 'trigger'::regtype`, [NAMES])).rows;
    expect(r.length).toBe(11);
    expect(r.filter((x) => x.o !== 'vip_app')).toEqual([]);
  });
  it('otra cuenta no puede revisar, eliminar ni dar de baja un conductor ajeno', async () => {
    const x = await driverIn(MAIN, 'A1', 'AU1');
    await expect(check(other, x.driver)).rejects.toThrow('driver_not_found');
    for (const fn of ['delete_driver', 'archive_driver']) await expect(db.as(other, (q) => q.one(`select public.${fn}($1)`, [x.driver]))).rejects.toThrow('driver_not_found');
    expect(await exists(x.driver)).toBe(true);
  });
  it('la administradora elimina un conductor sin historial de su cuenta', async () => {
    const x = await driverIn(acc, 'B1', 'BU1');
    expect(await check(other, x.driver)).toMatchObject({ can_delete: true });
    await db.as(other, (q) => q.one(`select public.delete_driver($1, 'duplicado')`, [x.driver]));
    expect(await exists(x.driver)).toBe(false);
  });
  it('con deuda anterior (como 10325) no se elimina: se ofrece dar de baja y se conserva todo', async () => {
    const x = await driverIn(acc, 'B2', 'BU2');
    await db.su.query(`insert into public.charges(assignment_id, kind, charge_date, amount_cents, week_start, account_id) values ($1,'opening','2026-11-01',19900,'2026-10-26',$2)`, [x.assignment, acc]);
    expect(await check(other, x.driver)).toMatchObject({ can_delete: false, suggestion: 'archive' });
    await expect(db.as(other, (q) => q.one(`select public.delete_driver($1)`, [x.driver]))).rejects.toThrow('delete_blocked_has_history');
    await db.as(other, (q) => q.one(`select public.archive_driver($1, 'ya no trabaja')`, [x.driver]));
    const r = (await db.su.query(`select d.status, a.valid_to is not null ended, (select count(*) from public.charges c where c.assignment_id=a.id and c.kind='opening')::int deuda
      from public.drivers d join public.assignments a on a.driver_id=d.id where d.id=$1`, [x.driver])).rows[0];
    expect(r).toEqual({ status: 'inactive', ended: true, deuda: 1 });
    await db.as(other, (q) => q.one(`select public.reactivate_driver($1)`, [x.driver]));
  });
  it('el super administrador, con otra cuenta seleccionada, actúa en ella y no en la suya', async () => {
    const x = await driverIn(acc, 'B3', 'BU3');
    await db.as(db.admin, (q) => q.rows(`select public.set_account_view($1)`, [acc]));
    expect(await check(db.admin, x.driver)).toMatchObject({ can_delete: true });
    await db.as(db.admin, (q) => q.one(`select public.delete_driver($1)`, [x.driver]));
    expect(await exists(x.driver)).toBe(false);
    await db.as(db.admin, (q) => q.rows(`select public.set_account_view(null)`));
  });
});

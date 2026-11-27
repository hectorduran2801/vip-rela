import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newDb, type Db } from './harness.js';

/** Auditoría de las políticas por cuenta (tras 0053): misma condición que antes, en todas las tablas y los 4 comandos; y ataques reales desde otra cuenta. */
let db: Db; let other: string; const MAIN = '00000000-0000-4000-8000-000000000001';
let tables: string[] = [];
beforeAll(async () => {
  db = await newDb();
  const x = await db.driverWithAssignment({ code: 'AU1', unit: 'AU-1', dailyCents: 3000, phone: '+50761390001' });
  await db.su.query(`insert into public.message_templates(name, body) values ('AU','Hola {{nombre}}')`);
  await db.su.query(`insert into public.charges(assignment_id, kind, charge_date, amount_cents, week_start) values ($1,'daily','2026-11-23',3000,'2026-11-23')`, [x.assignment]);
  await db.su.query(`insert into public.collection_week_units(week_start, unit_id, unit_code, assignment_id, driver_id, saldo_excel_cents) values ('2026-11-23',$1,'AU-1',$2,$3,100)`, [x.unit, x.assignment, x.driver]);
  await db.su.query(`insert into public.excel_imports(file_name, file_sha256, source_kind, created_by) values ('a.xlsx','au-sha','collection_flat',$1)`, [db.admin]);
  await db.su.query(`insert into public.send_schedules(name, local_time, enabled) values ('AU','10:00',false)`);
  other = db.outsider;
  await db.su.query(`insert into public.app_users(user_id, role, created_by) values ($1,'admin',$2)`, [other, db.admin]);
  tables = (await db.su.query(`select table_name t from information_schema.columns where table_schema='public' and column_name='account_id' and table_name not in ('app_users','account_view') order by 1`)).rows.map((r) => r.t);
}, 120_000);
afterAll(async () => { await db.close(); });

const plain = (s: string | null) => s === null ? null : s.replace(/\( SELECT app_private\.(\w+)\(\) AS \w+\)/g, 'app_private.$1()').replace(/\s+/g, ' ');

describe('auditoría de políticas por cuenta', () => {
  it('toda tabla con account_id tiene RLS y una política RESTRICTIVA por cuenta', async () => {
    for (const t of tables) {
      const rls = (await db.su.query(`select relrowsecurity r from pg_class where oid = ('public.'||$1)::regclass`, [t])).rows[0].r;
      expect(rls, t).toBe(true);
      const n = (await db.su.query(`select count(*)::int n from pg_policies where tablename=$1 and permissive='RESTRICTIVE'`, [t])).rows[0].n;
      if (!t.startsWith('collection_summary')) expect(n, t).toBeGreaterThan(0);
    }
  });
  it('la condición de cada política es la misma de antes («sin usuario» o «mi cuenta»), solo evaluada una vez', async () => {
    const rows = (await db.su.query(`select tablename t, policyname p, cmd, permissive, qual, with_check from pg_policies where policyname like 'tenant%' order by 1,2`)).rows;
    expect(rows.length).toBeGreaterThan(100);
    for (const r of rows) {
      expect(r.permissive, r.t).toBe('RESTRICTIVE');
      if (r.t === 'whatsapp_sessions' && r.p === 'tenant_delete') { expect(plain(r.qual)).toBe('(app_private.own_account() IS NULL)'); continue; }   // a propósito (0047): solo el sistema borra sesiones
      for (const e of [r.qual, r.with_check]) if (e !== null) expect(plain(e), `${r.t}.${r.p}`).toMatch(/^\(?\(app_private\.(current|own)_account\(\) IS NULL\) OR \(account_id = app_private\.(current|own)_account\(\)\)\)?$/);
      expect(String(r.qual ?? '') + String(r.with_check ?? ''), `${r.t}.${r.p} sin (select)`).not.toMatch(/(?<!SELECT )app_private\.(current|own)_account\(\)/);
    }
  });
  it('desde otra cuenta: no lee, no cambia, no borra ni inserta filas ajenas, tabla por tabla', async () => {
    const before = new Map<string, number>();
    for (const t of tables) before.set(t, (await db.su.query(`select count(*)::int n from public.${t} where account_id=$1`, [MAIN])).rows[0].n);
    const attempt = (sql: string, p: unknown[] = []) => db.as(other, (q) => q.query(sql, p)).then((r: any) => r.rowCount as number, () => 0);
    for (const t of tables) {
      expect(await db.as(other, (q) => q.rows(`select 1 from public.${t} where account_id=$1`, [MAIN])).then((r) => r.length, () => 0), `leer ${t}`).toBe(0);
      expect(await attempt(`update public.${t} set account_id=account_id where account_id=$1`, [MAIN]), `cambiar ${t}`).toBe(0);
      expect(await attempt(`delete from public.${t} where account_id=$1`, [MAIN]), `borrar ${t}`).toBe(0);
      expect((await db.su.query(`select count(*)::int n from public.${t} where account_id=$1`, [MAIN])).rows[0].n, t).toBe(before.get(t));
    }
    for (const sql of [`insert into public.units(code, account_id) values ('HACK',$1)`, `insert into public.message_templates(name, body, account_id) values ('h','x',$1)`,
      `insert into public.send_schedules(name, local_time, account_id) values ('h','10:00',$1)`]) expect(await attempt(sql, [MAIN]), sql).toBe(0);
    expect((await db.su.query(`select count(*)::int n from public.units where code='HACK'`)).rows[0].n).toBe(0);
  });
  it('anónimo no tiene acceso a ninguna tabla de datos', async () => {
    for (const t of tables) expect(await db.asAnon((q) => q.fails(`select 1 from public.${t}`)), t).toMatch(/permission denied/);
  });
});

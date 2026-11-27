import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newDb, type Db } from './harness.js';

/** 0054: la tabla semanal en bloque devuelve exactamente lo mismo que la anterior, columna por columna, y respeta la cuenta. */
let db: Db; let week: string;
beforeAll(async () => {
  db = await newDb();
  week = (await db.su.query(`select app_private.week_start_of((now() at time zone app_private.tz())::date)::text d`)).rows[0].d;
  await db.su.query(`insert into public.payment_methods(code,label) values ('excel','Excel') on conflict (code) do nothing`);
  const A: any[] = [];
  for (let i = 0; i < 10; i++) A.push(await db.driverWithAssignment({ code: `WB${i}`, unit: `WB-${i}`, dailyCents: i === 9 ? undefined : 3000 + i * 10, from: i === 4 ? '2026-11-18' : '2026-01-01' }));
  const pay = (x: any, d: string, c: number) => db.su.query(`insert into public.payments(assignment_id, method_id, gross_cents, commission_cents, net_cents, applied_cents, week_start, registered_by, idempotency_key, paid_at)
    values ($1,(select id from public.payment_methods where code='excel'),$2::int + 25,25,$2,$2,app_private.week_start_of($5::date),$4,$3,($5::date + time '12:00') at time zone 'America/Panama')`, [x.assignment, c, `wb-${Math.random()}`, db.admin, d]);
  const day = async (n: number) => (await db.su.query(`select ($1::date + $2::int)::text d`, [week, n])).rows[0].d;
  await pay(A[0], week, 3000); await pay(A[0], week, 100); await pay(A[0], await day(1), 2000); await pay(A[1], await day(-5), 9000); await pay(A[2], await day(-12), 500); await pay(A[3], week, 99999);
  for (const [i, n, c] of [[0, 0, 3000], [0, 1, 3000], [1, -6, 3010], [1, 0, 3010], [5, -20, 700]] as const) await db.su.query(`insert into public.charges(assignment_id, kind, charge_date, amount_cents, week_start) values ($1,'daily',$2,$3,app_private.week_start_of($2::date))`, [A[i].assignment, await day(n), c]);
  await db.su.query(`insert into public.charges(assignment_id, kind, charge_date, amount_cents, week_start) values ($1,'opening',$2,4000,app_private.week_start_of($2::date))`, [A[6].assignment, await day(-1)]);
  await db.su.query(`insert into public.rate_exceptions(assignment_id, on_date, amount_cents, reason) values ($1,$2,100,'feriado')`, [A[7].assignment, week]).catch(() => undefined);
  await db.su.query(`update public.drivers set active=false, status='suspended' where id=$1`, [A[8].driver]).catch(() => undefined);
}, 120_000);
afterAll(async () => { await db.close(); });

const as = async (fn: string, w: string) => db.as(db.opsAdmin, (q) => q.rows(`select * from ${fn}($1::date) order by unit_code, assignment_id`, [w]));
const both = async (w: string) => {
  const bulk = await as('public.weekly_collection_table', w);
  await db.su.query('grant execute on function app_private.weekly_collection_table_reference(date) to authenticated');
  const ref = await as('app_private.weekly_collection_table_reference', w);
  return { bulk, ref };
};

describe('tabla semanal en bloque', () => {
  it('idéntica a la anterior en la semana en curso, anteriores y siguiente', async () => {
    for (const offset of [0, -7, -14, 7]) {
      const w = (await db.su.query(`select ($1::date + $2::int)::text d`, [week, offset])).rows[0].d;
      const { bulk, ref } = await both(w);
      expect(bulk.length).toBe(ref.length); expect(bulk).toEqual(ref);
    }
  });
  it('otra cuenta no ve filas ajenas; semana que no empieza en lunes se rechaza', async () => {
    await db.su.query(`insert into public.app_users(user_id, role, created_by) values ($1,'admin',$2)`, [db.outsider, db.admin]);
    expect(await db.as(db.outsider, (q) => q.rows(`select * from public.weekly_collection_table($1::date)`, [week]))).toEqual([]);
    expect(await db.as(db.opsAdmin, (q) => q.fails(`select * from public.weekly_collection_table($1::date + 1)`, [week]))).toBe('week_start_must_be_monday');
  });
  it('la reversión restaura la versión anterior', async () => {
    await db.su.query(readFileSync(new URL('../../../supabase/rollback/0054_weekly_table_down.sql', import.meta.url), 'utf8'));
    expect((await db.su.query(`select to_regprocedure('app_private.weekly_collection_table_reference(date)') is null a`)).rows[0].a).toBe(true);
    expect((await as('public.weekly_collection_table', week)).length).toBeGreaterThan(0);
  });
});

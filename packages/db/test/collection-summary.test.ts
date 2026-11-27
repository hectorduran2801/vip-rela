import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newDb, type Db, type Q } from './harness.js';

/** 0052: el cálculo en bloque es idéntico campo por campo a la consulta anterior; solo se recalcula lo afectado; por cuenta. */
let db: Db; let week: string; let today: string; const A: { assignment: string; driver: string; unit: string }[] = [];
const MAIN = '00000000-0000-4000-8000-000000000001';
const adm = <T>(fn: (q: Q) => Promise<T>) => db.as(db.opsAdmin, fn);
const add = async (iso: string, d: number) => (await db.su.query(`select ($1::date + $2::int)::text x`, [iso, d])).rows[0].x as string;
const pay = async (x: { assignment: string; driver: string }, date: string, cents: number, excel = true) => {
  const pid = (await db.su.query(`insert into public.payments(assignment_id, method_id, gross_cents, net_cents, applied_cents, week_start, registered_by, idempotency_key, paid_at)
    values ($1,(select id from public.payment_methods where code='excel'),$2,$2,$2,app_private.week_start_of($5::date),$4,$3,($5::date + time '12:00') at time zone 'America/Panama') returning id`, [x.assignment, cents, `p-${Math.random()}`, db.admin, date])).rows[0].id;
  if (excel) await db.su.query(`insert into public.excel_payment_days(assignment_id, pay_date, week_start, driver_id, amount_cents, payment_id) values ($1,$2,app_private.week_start_of($2::date),$3,$4,$5)`, [x.assignment, date, x.driver, cents, pid]);
};
const saldo = (x: { assignment: string; unit: string; driver: string }, w: string, cents: number | null) => db.su.query(`insert into public.collection_week_units(week_start, unit_id, unit_code, assignment_id, driver_id, saldo_excel_cents) values ($1,$2,'u',$3,$4,$5)`, [w, x.unit, x.assignment, x.driver, cents]);

beforeAll(async () => {
  db = await newDb();
  await db.su.query(`insert into public.payment_methods(code, label) values ('excel','Excel') on conflict (code) do nothing`);
  today = (await db.su.query(`select (now() at time zone app_private.tz())::date::text d`)).rows[0].d;
  week = (await db.su.query(`select app_private.week_start_of($1::date)::text d`, [today])).rows[0].d;
  const prev = await add(week, -7);
  for (let i = 0; i < 12; i++) {
    const from = i === 7 ? await add(week, 1) : '2026-01-01';
    const x = await db.driverWithAssignment({ code: `CS${i}`, unit: `CS-${i}`, dailyCents: i === 11 ? undefined : 3000 + i * 100, from, phone: i % 3 ? `+5076130${1000 + i}` : undefined }); A.push(x);
  }
  await saldo(A[0]!, week, 10000); await saldo(A[1]!, week, null); await saldo(A[2]!, week, -2500); await saldo(A[3]!, prev, 5000); await saldo(A[4]!, prev, 700); await saldo(A[4]!, week, 900);
  await saldo(A[5]!, week, 0); await saldo(A[7]!, week, 1200); await saldo(A[11]!, week, 300);                                  // 6, 8, 9, 10: nunca importadas
  await pay(A[0]!, week, 3000); await pay(A[1]!, week, 9000); await pay(A[3]!, prev, 4000); await pay(A[6]!, week, 1500, false); await pay(A[8]!, prev, 99999, false);
  if (today > week) await pay(A[0]!, today, 500);
  await db.su.query(`insert into public.charges(assignment_id, kind, charge_date, amount_cents, week_start) values ($1,'daily',$3,3000,$3), ($2,'daily',$4,3000,app_private.week_start_of($4::date))`, [A[6]!.assignment, A[8]!.assignment, week, prev]);
  await db.su.query(`insert into public.rate_exceptions(assignment_id, on_date, amount_cents, reason) values ($1,$2,0,'feriado')`, [A[5]!.assignment, week]).catch(() => undefined);
  await db.su.query(`update public.assignments set collect_commission=false where id=$1`, [A[3]!.assignment]);
  await db.su.query(`update public.assignments set valid_to=$2 where id=$1`, [A[9]!.assignment, week]);
  await db.su.query(`update public.drivers set status='suspended', active=false where id=$1`, [A[10]!.driver]).catch(() => undefined);
}, 120_000);
afterAll(async () => { await db.close(); });

const read = async (w = week) => (await adm((q) => q.rows(`select public.collection_summary_rows($1::date) d`, [w]))).map((r: any) => r.d);
const reference = async (w = week) => adm(async (q) => { void q; return (await db.as(db.opsAdmin, async () => [] as any[])); }).then(async () => {
  await db.su.query('begin'); await db.su.query(`select set_config('request.jwt.claims',$1,true)`, [JSON.stringify({ sub: db.opsAdmin, role: 'authenticated' })]);
  const r = (await db.su.query(`select data from app_private.collection_rows_reference($1::date) order by unit_code`, [w])).rows.map((x) => x.data); await db.su.query('rollback'); return r; });
const norm = (rows: any[]) => rows.map((r) => Object.fromEntries(Object.entries(r).sort())).sort((a: any, b: any) => String(a.assignment_id).localeCompare(String(b.assignment_id)));
const dirty = async () => (await db.su.query(`select assignment_id from public.collection_summary_dirty where account_id=$1`, [MAIN])).rows.map((r) => r.assignment_id);

describe('cobranza en bloque y persistida', () => {
  it('idéntica campo por campo a la consulta anterior (semana en curso, anterior y siguiente)', async () => {
    for (const w of [week, await add(week, -7), await add(week, 7)]) {
      const a = norm(await read(w)), b = norm(await reference(w));
      expect(a.length).toBe(b.length); expect(a).toEqual(b);
    }
    expect((await read()).length).toBeGreaterThanOrEqual(11);
  });
  it('un cambio marca SOLO la asignación afectada y la siguiente lectura la pone al día', async () => {
    await read(); expect(await dirty()).toEqual([]);
    await db.su.query(`update public.units set code=code where false`); expect(await dirty()).toEqual([]);
    await pay(A[0]!, week, 700, false); expect(await dirty()).toEqual([A[0]!.assignment]);
    await read(); expect(await dirty()).toEqual([]); expect(norm(await read())).toEqual(norm(await reference()));
    await adm((q) => q.rows(`select public.set_assignment_commission($1,false)`, [A[0]!.assignment]));
    await db.su.query(`update public.drivers set first_name='Cambiado' where id=$1`, [A[4]!.driver]);
    expect((await dirty()).sort()).toEqual([A[0]!.assignment, A[4]!.assignment].sort());
    expect(norm(await read())).toEqual(norm(await reference()));
  });
  it('cambio de día: el servidor recalcula todo sin navegador; repetirlo no hace nada', async () => {
    await read(); await db.su.query(`update public.collection_summary_state set computed_on = computed_on - 1 where account_id=$1`, [MAIN]);
    const n = (await db.asService((q) => q.one(`select public.refresh_collection_summaries() n`)) as any).n;
    expect(Number(n)).toBeGreaterThanOrEqual(11);
    expect((await db.asService((q) => q.one(`select public.refresh_collection_summaries() n`)) as any).n).toBe(0);
    expect(await adm((q) => q.fails(`select public.refresh_collection_summaries()`))).toMatch(/permission denied/);
  });
  it('por cuenta: sin acceso directo a las tablas ni a las funciones internas; otra cuenta no ve nada ajeno', async () => {
    expect(await adm((q) => q.fails(`select * from public.collection_summary`))).toMatch(/permission denied/);
    expect(await adm((q) => q.fails(`select * from app_private.collection_rows($1,$2::date)`, [MAIN, week]))).toMatch(/permission denied/);
    expect(await db.asAnon((q) => q.fails(`select public.collection_summary_rows($1::date)`, [week]))).toMatch(/permission denied/);
    await db.su.query(`insert into public.app_users(user_id, role, created_by) values ($1,'admin',$2)`, [db.outsider, db.admin]);
    expect(await db.as(db.outsider, (q) => q.rows(`select public.collection_summary_rows($1::date)`, [week]))).toEqual([]);
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MON, MON2, SUN, addDays, chargeWeek, pay } from './fixtures.js';
import { newDb, type Db, type Q } from './harness.js';

let db: Db; let n = 0;
beforeAll(async () => { db = await newDb(); });
afterAll(async () => { await db.close(); });
const adm = <T>(fn: (q: Q) => Promise<T>) => db.as(db.admin, fn);
const fresh = async (cents = 2900, from = '2026-01-01') => {
  n += 1; return db.driverWithAssignment({ code: `W${n}`, unit: `WU${n}`, dailyCents: cents, from });
};
const detail = async (x: { assignment: string }, week = MON, who = db.admin) => {
  const r = (await db.as(who, (q) => q.rows(`select * from public.weekly_collection_detail($1::date, $2)`, [week, x.assignment])))[0];
  return { prevP: Number(r.previous_pending_cents), prevC: Number(r.previous_credit_cents), days: r.days as Array<{ date: string; weekday: number; charge_cents: number; net_paid_cents: number; remaining_cents: number; status: string }> };
};

describe('detalle semanal por día', () => {
  it('lunes a domingo con fecha y día de la semana correctos; domingo sin cuota', async () => {
    const x = await fresh(); await chargeWeek(db, MON);
    const d = await detail(x);
    expect(d.days.map((r) => r.date)).toEqual([0, 1, 2, 3, 4, 5, 6].map((i) => addDays(MON, i)));
    expect(d.days.map((r) => r.weekday)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(d.days.map((r) => r.charge_cents)).toEqual([2900, 2900, 2900, 2900, 2900, 2900, 0]);
    expect(d.days[6]).toMatchObject({ status: 'no_charge', remaining_cents: 0 });
    expect(d.days.slice(0, 6).every((r) => r.status === 'pending' && r.remaining_cents === 2900)).toBe(true);
  });
  it('estados pagado / parcial / pendiente según lo aplicado de la más antigua a la más reciente', async () => {
    const x = await fresh(); await chargeWeek(db, MON);
    await adm((q) => pay(q, x.assignment, 'cash', 2900 + 1000, { paidAt: `${MON}T10:00:00-05:00` }));     // lunes pagado + 10 sobre el martes
    const d = await detail(x);
    expect(d.days.slice(0, 3).map((r) => [r.status, r.remaining_cents])).toEqual([['paid', 0], ['partial', 1900], ['pending', 2900]]);
    expect(d.days[0]).toMatchObject({ net_paid_cents: 3900 });                                               // lo recibido ese día, aunque se aplique al martes
  });
  it('un pago del domingo reduce deuda de días anteriores y se muestra como abonado ese domingo (sin cuota)', async () => {
    const x = await fresh(); await chargeWeek(db, MON);
    await adm((q) => pay(q, x.assignment, 'cash', 2900, { paidAt: `${SUN}T09:00:00-05:00` }));
    const d = await detail(x);
    expect(d.days[6]).toMatchObject({ status: 'no_charge', charge_cents: 0, net_paid_cents: 2900 });
    expect(d.days[0]).toMatchObject({ status: 'paid', remaining_cents: 0 });                                  // lo más antiguo se cubrió primero
  });
  it('Yappy: el abonado del día es el NETO (la comisión no cuenta como abono)', async () => {
    const x = await fresh(3600); await chargeWeek(db, MON);
    await adm((q) => pay(q, x.assignment, 'yappy', 3700, { paidAt: `${MON}T10:00:00-05:00` }));
    const d = await detail(x);
    expect(d.days[0]).toMatchObject({ charge_cents: 3600, net_paid_cents: 3600, remaining_cents: 0, status: 'paid' });
  });
  it('saldo anterior: deuda y crédito con los que entra a la semana', async () => {
    const x = await fresh(); await chargeWeek(db, MON);
    await adm((q) => pay(q, x.assignment, 'cash', 10000, { paidAt: `${MON}T10:00:00-05:00` }));              // 174 de cuenta, paga 100 → debe 74
    await chargeWeek(db, MON2);
    const w2 = await detail(x, MON2);
    expect(w2.prevP).toBe(17400 - 10000); expect(w2.prevC).toBe(0);
    const y = await fresh(); await chargeWeek(db, MON);
    await adm((q) => pay(q, y.assignment, 'cash', 20000, { paidAt: `${MON}T10:00:00-05:00` }));              // paga de más: crédito 26
    expect((await detail(y, MON2))).toMatchObject({ prevP: 0, prevC: 20000 - 17400 });
    expect((await detail(y, MON)).prevP).toBe(0);                                                            // la primera semana entra sin saldo
  });
  it('una asignación que empieza a mitad de semana solo tiene cuota desde su inicio; un cambio de tarifa se ve por día', async () => {
    const x = await fresh(3000, addDays(MON, 2)); await chargeWeek(db, MON);                                 // empieza el miércoles
    expect((await detail(x)).days.map((r) => r.charge_cents)).toEqual([0, 0, 3000, 3000, 3000, 3000, 0]);
    expect((await detail(x)).days.slice(0, 2).every((r) => r.status === 'no_charge')).toBe(true);
    const y = await fresh(3000);
    for (let i = 0; i < 3; i++) await adm((q) => q.query(`select public.generate_daily_charges($1::date)`, [addDays(MON, i)]));
    await adm((q) => q.query(`select public.change_rate($1, 4000, $2::date)`, [y.assignment, addDays(MON, 3)]));
    for (let i = 3; i < 6; i++) await adm((q) => q.query(`select public.generate_daily_charges($1::date)`, [addDays(MON, i)]));
    expect((await detail(y)).days.map((r) => r.charge_cents)).toEqual([3000, 3000, 3000, 4000, 4000, 4000, 0]);
  });
  it('un ajuste positivo fechado un día se suma a la cuota de ese día; los pagos anulados no cuentan', async () => {
    const x = await fresh(); await chargeWeek(db, MON);
    await adm((q) => q.query(`select public.create_adjustment($1, 500, $2::date, 'cargo omitido', 'adj-wk-1')`, [x.assignment, addDays(MON, 2)]));
    const p = await adm((q) => pay(q, x.assignment, 'cash', 1000, { paidAt: `${MON}T10:00:00-05:00` }));
    await adm((q) => q.query(`select public.void_payment($1,'duplicado')`, [p.payment_id]));
    const d = await detail(x);
    expect(d.days[2]).toMatchObject({ charge_cents: 3400 });
    expect(d.days[0]).toMatchObject({ net_paid_cents: 0, status: 'pending' });
  });
  it('sin filtro devuelve una fila por asignación de la semana; la suma de cuotas coincide con la tabla semanal', async () => {
    await fresh(); await chargeWeek(db, MON);
    const all = await adm((q) => q.rows(`select assignment_id, days from public.weekly_collection_detail($1::date)`, [MON]));
    const table = await adm((q) => q.rows(`select assignment_id, week_charged_cents, pending_cents, credit_cents from public.weekly_collection_table($1::date)`, [MON]));
    expect(all.length).toBe(table.length);
    for (const t of table) {
      const row = all.find((r) => r.assignment_id === t.assignment_id)!;
      expect(row.days.reduce((s: number, d: { charge_cents: number }) => s + d.charge_cents, 0)).toBe(Number(t.week_charged_cents));
    }
  });
  it('exige lunes y permisos: SUPERVISOR lee; sin rol y anon no', async () => {
    const x = await fresh(); await chargeWeek(db, MON);
    expect(await adm((q) => q.fails(`select * from public.weekly_collection_detail('2026-03-03')`))).toBe('week_start_must_be_monday');
    expect((await detail(x, MON, db.supervisor)).days.length).toBe(7);
    expect(await db.as(db.outsider, (q) => q.fails(`select * from public.weekly_collection_detail($1::date)`, [MON]))).toBe('forbidden');
    expect(await db.asAnon((q) => q.fails(`select * from public.weekly_collection_detail($1::date)`, [MON]))).toMatch(/permission denied/);
  });
  it('no modifica nada (solo lectura)', async () => {
    const x = await fresh(); await chargeWeek(db, MON);
    const c = async () => (await db.su.query(`select (select count(*) from public.charges)::int c, (select count(*) from public.payments)::int p, (select count(*) from public.audit_logs)::int a`)).rows[0];
    const before = await c(); await detail(x); await detail(x, MON2);
    expect(await c()).toEqual(before);
  });
});

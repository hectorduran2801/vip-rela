import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MON, MON2, chargeWeek, pay } from './fixtures.js';
import { newDb, type Db } from './harness.js';

let db: Db;
beforeAll(async () => { db = await newDb(); });
afterAll(async () => { await db.close(); });
const summary = () => db.as(db.admin, async (q) => (await q.one(`select public.dashboard_summary() s`)).s);

describe('campos CRM', () => {
  it('el estado del conductor determina `active` y no se puede escribir directamente', async () => {
    const x = await db.driverWithAssignment({ code: 'S1', unit: 'SU1' });
    const act = async () => (await db.su.query(`select status, active from public.drivers where id=$1`, [x.driver])).rows[0];
    expect(await act()).toEqual({ status: 'active', active: true });
    for (const s of ['inactive', 'suspended', 'pending_approval']) { await db.su.query(`update public.drivers set status=$2 where id=$1`, [x.driver, s]); expect(await act()).toEqual({ status: s, active: false }); }
    expect(await db.su.query(`update public.drivers set active=true where id=$1`, [x.driver]).then(() => null, (e) => e.message)).toMatch(/can only be updated to DEFAULT/);
    expect(await db.su.query(`update public.drivers set status='bogus' where id=$1`, [x.driver]).then(() => null, (e) => e.message)).toMatch(/check/);
  });
  it('las placas son únicas (sin distinguir mayúsculas)', async () => {
    const ins = (plate: string, code: string) => db.su.query(`insert into public.units(code, plate) values ($1,$2)`, [code, plate]).then(() => null, (e) => e.message);
    expect(await ins('ab-123', 'PL1')).toBeNull();
    expect(await ins('AB-123', 'PL2')).toMatch(/units_plate_uq|unique/);
  });
  it('un conductor suspendido no genera cuotas ni admite pagos', async () => {
    const x = await db.driverWithAssignment({ code: 'S2', unit: 'SU2', dailyCents: 3600 });
    await db.su.query(`update public.drivers set status='suspended' where id=$1`, [x.driver]);
    await chargeWeek(db, MON);
    expect(Number((await db.su.query(`select count(*) n from public.charges where assignment_id=$1`, [x.assignment])).rows[0].n)).toBe(0);
    expect(await db.as(db.admin, (q) => q.fails(`select public.register_payment($1,'cash',100,'k-susp-1')`, [x.assignment]))).toBe('assignment_inactive');
  });
  it('el perfil guarda el email del usuario creado en Auth', async () => {
    expect((await db.su.query(`select email from public.profiles where id=$1`, [db.admin])).rows[0].email).toBe('admin@test.local');
  });
});

describe('dashboard_summary (datos reales)', () => {
  it('una base vacía devuelve ceros, nunca métricas inventadas', async () => {
    const fresh = await newDb();
    try {
      const s = await fresh.as(fresh.admin, async (q) => (await q.one(`select public.dashboard_summary() s`)).s);
      expect(s.drivers.total).toBe(0);
      expect(s.collections).toMatchObject({ pending_total_cents: 0, credits_total_cents: 0, collected_today_net_cents: 0, drivers_with_debt: 0 });
      expect(s.whatsapp.sessions).toHaveLength(1);        // la única sesión existe, desconectada
      expect(s.whatsapp.sessions[0].status).toBe('disconnected');
    } finally { await fresh.close(); }
  });
  it('cuenta conductores por estado y calcula cobranza, crédito, métodos y recordatorios', async () => {
    const d1 = await db.driverWithAssignment({ code: 'D1', unit: 'BU1', dailyCents: 3600, phone: '+50760001111', consent: true });
    const d2 = await db.driverWithAssignment({ code: 'D2', unit: 'BU2', dailyCents: 3600 });
    const d3 = await db.driverWithAssignment({ code: 'D3', unit: 'BU3', dailyCents: 3600 });
    await db.su.query(`update public.drivers set status='suspended' where id=$1`, [d3.driver]);
    await db.su.query(`insert into public.drivers(operator_code, national_id, first_name, status) values ('D4','ID-D4','Nuevo','pending_approval')`);
    const today = (await db.su.query(`select (now() at time zone 'America/Panama')::date::text d`)).rows[0].d;
    const monday = (await db.su.query(`select app_private.week_start_of($1::date)::text d`, [today])).rows[0].d;
    for (const x of [d1, d2]) await db.su.query(`insert into public.charges(assignment_id, kind, charge_date, amount_cents, week_start) values ($1,'daily',$2,3600,$2)`, [x.assignment, monday]);
    const before = await summary();
    await db.as(db.admin, (q) => pay(q, d1.assignment, 'yappy', 3700));
    await db.as(db.admin, (q) => pay(q, d2.assignment, 'cash', 5000));
    const s = await summary();
    expect(s.drivers.total - before.drivers.total).toBe(0);
    expect(s.drivers.suspended).toBeGreaterThanOrEqual(1); expect(s.drivers.pending_approval).toBeGreaterThanOrEqual(1);
    expect(s.drivers.total).toBe(s.drivers.active + s.drivers.inactive + s.drivers.suspended + s.drivers.pending_approval);
    expect(s.collections.collected_today_gross_cents - before.collections.collected_today_gross_cents).toBe(8700);
    expect(s.collections.collected_today_commission_cents - before.collections.collected_today_commission_cents).toBe(100);
    expect(s.collections.credits_total_cents).toBeGreaterThanOrEqual(1400);
    expect(s.by_method.find((m: { method_code: string }) => m.method_code === 'yappy')).toMatchObject({ gross_cents: 3700, commission_cents: 100, net_cents: 3600 });
    expect(s.reminders.awaiting_approval).toBe(0);                              // 0028: el flujo es manual; ya no se crean avisos de crédito en borrador
  });
});

describe('tabla semanal de cobranza', () => {
  it('muestra lunes a domingo, cuenta, bruto, comisión, neto, diferencia, pendiente y crédito (calculados en la base)', async () => {
    const x = await db.driverWithAssignment({ code: 'W1', unit: 'UW1', dailyCents: 3600 });
    await chargeWeek(db, MON);
    await db.as(db.admin, (q) => pay(q, x.assignment, 'yappy', 3700, { paidAt: `${MON}T09:00:00-05:00` }));
    await db.as(db.admin, (q) => pay(q, x.assignment, 'cash', 1000, { paidAt: '2026-03-08T10:00:00-05:00' }));
    const t = (await db.as(db.admin, (q) => q.rows(`select * from public.weekly_collection_table($1)`, [MON]))).find((r) => r.operator_code === 'W1');
    expect(t).toMatchObject({ unit_code: 'UW1', daily_rate_cents: '3600', week_charged_cents: '21600', gross_cents: '4700', commission_cents: '100', net_cents: '4600', week_diff_cents: '-17000', pending_cents: '17000', credit_cents: '0', week_closed: false });
    expect(t.day_net_cents).toEqual(['3600', '0', '0', '0', '0', '0', '1000']);
  });
  it('exige lunes y el crédito se arrastra a la semana siguiente', async () => {
    expect(await db.as(db.admin, (q) => q.fails(`select * from public.weekly_collection_table('2026-03-03')`))).toBe('week_start_must_be_monday');
    const x = await db.driverWithAssignment({ code: 'W2', unit: 'UW2', dailyCents: 3600 });
    await chargeWeek(db, MON);
    await db.as(db.admin, (q) => pay(q, x.assignment, 'cash', 22000, { paidAt: `${MON}T09:00:00-05:00` }));
    await chargeWeek(db, MON2);
    const wk = async (w: string) => (await db.as(db.admin, (q) => q.rows(`select * from public.weekly_collection_table($1)`, [w]))).find((r) => r.operator_code === 'W2');
    expect(await wk(MON)).toMatchObject({ pending_cents: '0', credit_cents: '400' });
    expect(await wk(MON2)).toMatchObject({ pending_cents: '21200', credit_cents: '0', week_diff_cents: '-21600' });
  });
});

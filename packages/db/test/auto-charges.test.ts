import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BASE_TPL, ensureBaseTemplates, MON, addDays, key, pay, position } from './fixtures.js';
import { newDb, type Db, type Q } from './harness.js';

// Una base nueva por prueba: ensure_daily_charges actúa sobre TODAS las asignaciones y los conteos deben ser exactos.
let db: Db; let n = 0;
beforeEach(async () => { db = await newDb(); });
afterEach(async () => { await db.close(); });
const adm = <T>(fn: (q: Q) => Promise<T>) => db.as(db.admin, fn);
const ensure = (through: string | null, from: string | null = null, who: (fn: (q: Q) => Promise<any>) => Promise<any> = adm) =>
  who((q) => q.one(`select public.ensure_daily_charges($1::date, $2::date) r`, [through, from])).then((x) => x.r);
const fresh = async (cents = 4000, from = MON, extra: { phone?: string; consent?: boolean } = {}) => {
  n += 1; return db.driverWithAssignment({ code: `A${n}`, unit: `AU${n}`, dailyCents: cents, from, ...extra });
};
const charges = (asg: string) => db.su.query(`select charge_date::text d, amount_cents::int a from public.charges where assignment_id=$1 and kind='daily' order by 1`, [asg]).then((r) => r.rows);
const auditCount = (action: string) => db.su.query(`select count(*)::int c from public.audit_logs where action=$1`, [action]).then((r) => r.rows[0].c as number);
const detail = async (asg: string, week = MON) =>
  (await adm((q) => q.rows(`select * from public.weekly_collection_detail($1::date, $2)`, [week, asg])))[0].days as Array<Record<string, any>>;
const table = async (week = MON) => adm((q) => q.rows(`select * from public.weekly_collection_table($1::date)`, [week]));
const todayLocal = async (): Promise<string> => (await db.su.query(`select (now() at time zone 'America/Panama')::date::text d`)).rows[0].d;
const FUTURE_MON = '2030-01-07';

describe('generación automática (ensure_daily_charges)', () => {
  it('lunes a sábado con tarifa de $40: 6 cargos, domingo ninguno; resumen jsonb', async () => {
    const x = await fresh();
    const r = await ensure(addDays(MON, 6));
    expect(r).toMatchObject({ created: 6, from: addDays(MON, 6 - 13), to: addDays(MON, 6), days_checked: 14, skipped: null, recovery_days: 14 });
    expect((await charges(x.assignment)).map((c) => c.a)).toEqual([4000, 4000, 4000, 4000, 4000, 4000]);
    expect((await charges(x.assignment)).map((c) => c.d)).toEqual([0, 1, 2, 3, 4, 5].map((i) => addDays(MON, i)));
  });

  it('idempotente: ejecutar dos veces = 0 nuevos y sin auditoría extra; una fila de auditoría por ejecución con cambios', async () => {
    await fresh();
    expect((await ensure(addDays(MON, 5))).created).toBe(6);
    expect(await auditCount('ensure_daily_charges')).toBe(1);
    const again = await ensure(addDays(MON, 5));
    expect(again.created).toBe(0);
    expect(await auditCount('ensure_daily_charges')).toBe(1);                        // created = 0 → no se audita
    expect(await db.su.query(`select count(*)::int c from public.charges`).then((r) => r.rows[0].c)).toBe(6);
  });

  it('caso real: asignación del 2026-11-16 con tarifa de $40 → 1 cargo el lunes; los días siguientes salen planned (o missing si ya ocurrieron)', async () => {
    const x = await fresh(4000, '2026-11-16');
    const r = await ensure('2026-11-16');
    expect(r.created).toBe(1);
    expect(await charges(x.assignment)).toEqual([{ d: '2026-11-16', a: 4000 }]);
    const days = await detail(x.assignment, '2026-11-16');
    expect(days[0]).toMatchObject({ planned_cents: 4000, charge_generated: true, status: 'pending', charge_cents: 4000 });
    const today = await todayLocal();
    for (let i = 1; i <= 5; i++) {
      expect(days[i]).toMatchObject({ planned_cents: 4000, charge_generated: false, charge_cents: 0, status: days[i].date <= today ? 'missing' : 'planned' });
    }
    expect(days[6]).toMatchObject({ planned_cents: 0, status: 'no_charge' });
  });

  it('respeta vigencia de la asignación: no genera antes de su inicio ni después de su fin', async () => {
    const x = await fresh(4000, addDays(MON, 2));
    await ensure(addDays(MON, 5));
    expect((await charges(x.assignment)).map((c) => c.d)).toEqual([2, 3, 4, 5].map((i) => addDays(MON, i)));
    await adm((q) => q.query(`select public.end_assignment($1,$2::date)`, [x.assignment, addDays(MON, 3)]));
    const y = await fresh(3000, MON);
    await adm((q) => q.query(`select public.end_assignment($1,$2::date)`, [y.assignment, addDays(MON, 1)]));
    await ensure(addDays(MON, 6));
    expect((await charges(y.assignment)).map((c) => c.d)).toEqual([MON, addDays(MON, 1)]);
  });

  it('excepciones: cuota distinta, día libre (0) y domingo con excepción explícita SÍ genera', async () => {
    const x = await fresh();
    await db.su.query(`insert into public.rate_exceptions(assignment_id, on_date, amount_cents, reason) values ($1,$2,2500,'acuerdo'), ($1,$3,0,'libre'), ($1,$4,3000,'domingo especial')`,
      [x.assignment, addDays(MON, 1), addDays(MON, 2), addDays(MON, 6)]);
    await ensure(addDays(MON, 6));
    expect(await charges(x.assignment)).toEqual([
      { d: MON, a: 4000 }, { d: addDays(MON, 1), a: 2500 }, { d: addDays(MON, 3), a: 4000 }, { d: addDays(MON, 4), a: 4000 }, { d: addDays(MON, 5), a: 4000 }, { d: addDays(MON, 6), a: 3000 }]);
    expect(await db.su.query(`select public.planned_daily_cents($1, $2::date) p`, [x.assignment, addDays(MON, 6)]).then((r) => Number(r.rows[0].p))).toBe(3000);
    expect(await db.su.query(`select public.planned_daily_cents($1, $2::date) p`, [x.assignment, addDays(MON, 7)]).then((r) => Number(r.rows[0].p))).toBe(4000);
  });

  it('no genera para conductor o unidad inactivos', async () => {
    const x = await fresh();
    await db.su.query(`update public.units set vehicle_status='maintenance' where id=$1`, [x.unit]);
    expect((await ensure(addDays(MON, 5))).created).toBe(0);
  });

  it('recuperación tras una interrupción: días sin ejecutar se generan al volver; nunca se modifican cargos existentes', async () => {
    const x = await fresh();
    await ensure(addDays(MON, 1));                                                   // lun-mar
    const before = await db.su.query(`select id, created_at, amount_cents from public.charges order by charge_date`).then((r) => r.rows);
    const r = await ensure(addDays(MON, 5));                                         // el proceso estuvo caído mié-vie
    expect(r.created).toBe(4);
    const after = await db.su.query(`select id, created_at, amount_cents from public.charges order by charge_date limit 2`).then((r) => r.rows);
    expect(after).toEqual(before);
    expect((await charges(x.assignment)).length).toBe(6);
  });

  it('semana cerrada: NO se genera nada en ella, ni siquiera con from explícito; se reporta en gaps (closed_week)', async () => {
    const x = await fresh();
    await ensure(addDays(MON, 2));                                                   // lun-mié
    await adm((q) => q.query(`select public.close_week($1::date)`, [MON]));
    const r = await ensure(addDays(MON, 5));
    expect(r.created).toBe(0);
    expect(r.gaps_total).toBe(3);
    expect(r.gaps.map((g: any) => [g.date, g.planned_cents, g.reason])).toEqual([3, 4, 5].map((i) => [addDays(MON, i), 4000, 'closed_week']));
    const forced = await ensure(addDays(MON, 5), MON);
    expect(forced.created).toBe(0);
    expect((await charges(x.assignment)).length).toBe(3);
    expect(await adm((q) => q.rows(`select gap_date::text d, reason from public.charge_gaps($1::date)`, [addDays(MON, 5)]))).toHaveLength(3);
  });

  it('ventana configurable: lo no recuperado se reporta en gaps y se genera explícitamente (días no cerrados)', async () => {
    const x = await fresh();
    await adm((q) => q.query(`update public.app_settings set charge_recovery_days = 3`));
    const through = addDays(MON, 13);                                                // dom 2ª semana
    const r = await ensure(through);
    expect(r).toMatchObject({ from: addDays(MON, 11), days_checked: 3, recovery_days: 3 });
    expect(r.created).toBe(2);                                                       // vie y sáb de la 2ª semana
    expect(r.gaps_total).toBe(10);                                                   // sem. 1 (6) + lun-jue de la 2ª (4)
    expect(new Set(r.gaps.map((g: any) => g.reason))).toEqual(new Set(['outside_window']));
    expect(await auditCount('ensure_daily_charges_gaps')).toBe(1);
    await ensure(through);                                                           // misma situación: sin auditoría duplicada
    expect(await auditCount('ensure_daily_charges_gaps')).toBe(1);
    // ventana más amplia → se recupera
    await adm((q) => q.query(`update public.app_settings set charge_recovery_days = 14`));
    const r2 = await ensure(through);
    expect(r2.created).toBe(10); expect(r2.gaps_total).toBe(0);
    expect((await charges(x.assignment)).length).toBe(12);
    expect(await adm((q) => q.rows(`select * from public.charge_gaps($1::date)`, [through]))).toHaveLength(0);
  });

  it('generación explícita desde una fecha anterior a la ventana (ADMIN+, con auditoría)', async () => {
    const x = await fresh();
    await adm((q) => q.query(`update public.app_settings set charge_recovery_days = 2`));
    const through = addDays(MON, 5);
    expect((await ensure(through)).created).toBe(2);
    const r = await ensure(through, MON);
    expect(r.created).toBe(4);
    expect((await charges(x.assignment)).length).toBe(6);
    const a = await db.su.query(`select detail from public.audit_logs where action='ensure_daily_charges' order by id desc limit 1`);
    expect(a.rows[0].detail).toMatchObject({ created: 4, explicit_from: true, source: 'admin' });
    expect(await adm((q) => q.fails(`select public.ensure_daily_charges($1::date, $2::date)`, [MON, addDays(MON, 1)]))).toBe('invalid_range');
    expect(await adm((q) => q.fails(`select public.ensure_daily_charges($1::date, $2::date)`, ['2027-12-31', MON]))).toBe('range_too_large');
  });

  it('exclusión mutua: si otro proceso la ejecuta devuelve skipped=locked sin duplicar; luego es idempotente', async () => {
    const x = await fresh();
    const open = async () => {
      const c = await db.open(); await c.query('begin'); await c.query('set local role service_role');
      await c.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', true)`); return c;
    };
    const c1 = await open(); const c2 = await open();
    const r1 = (await c1.query(`select public.ensure_daily_charges($1::date) r`, [addDays(MON, 5)])).rows[0].r;
    const r2 = (await c2.query(`select public.ensure_daily_charges($1::date) r`, [addDays(MON, 5)])).rows[0].r;
    expect(r1.created).toBe(6); expect(r1.skipped).toBeNull();
    expect(r2).toMatchObject({ created: 0, skipped: 'locked', gaps: [] });
    await c1.query('commit'); await c2.query('commit');
    await c1.end(); await c2.end();
    expect((await charges(x.assignment)).length).toBe(6);
    expect((await db.asService((q) => q.one(`select public.ensure_daily_charges($1::date) r`, [addDays(MON, 5)]))).r.created).toBe(0);
  });

  it('ejecuciones simultáneas (8 en paralelo): ningún duplicado y el total creado es exacto', async () => {
    const x = await fresh(); const y = await fresh(3000);
    const rs = await Promise.all(Array.from({ length: 8 }, () => db.asService((q) => q.one(`select public.ensure_daily_charges($1::date) r`, [addDays(MON, 5)]))));
    const total = rs.reduce((s, r) => s + r.r.created, 0);
    expect(total).toBe(12);
    expect((await charges(x.assignment)).length).toBe(6); expect((await charges(y.assignment)).length).toBe(6);
    expect(rs.every((r) => r.r.skipped === null || r.r.skipped === 'locked')).toBe(true);
  });

  it('funciona sin worker ni OpenWA: solo SQL (service_role); el worker no participa y no se crea ningún envío', async () => {
    await fresh(4000, MON, { phone: '+50760001234', consent: true });
    await db.asService((q) => q.one(`select public.ensure_daily_charges($1::date) r`, [addDays(MON, 2)]));
    expect(await db.su.query(`select count(*)::int c from public.notification_jobs`).then((r) => r.rows[0].c)).toBe(0);
    expect(await db.su.query(`select count(*)::int c from public.charges`).then((r) => r.rows[0].c)).toBe(3);
  });

  it('permisos: SUPER_ADMIN, ADMIN y servicio sí; supervisor, usuario sin rol y anon no', async () => {
    await fresh();
    for (const who of [db.admin, db.opsAdmin]) expect((await db.as(who, (q) => q.one(`select public.ensure_daily_charges($1::date) r`, [addDays(MON, 5)]))).r).toBeTruthy();
    expect((await db.asService((q) => q.one(`select public.ensure_daily_charges($1::date) r`, [addDays(MON, 5)]))).r.created).toBe(0);
    for (const who of [db.supervisor, db.outsider]) {
      expect(await db.as(who, (q) => q.fails(`select public.ensure_daily_charges($1::date)`, [MON]))).toBe('forbidden');
      expect(await db.as(who, (q) => q.fails(`select * from public.charge_gaps()`))).toBe('forbidden');
      expect(await db.as(who, (q) => q.fails(`select * from public.rate_history()`))).toBe('forbidden');
    }
    expect(await db.asAnon((q) => q.fails(`select public.ensure_daily_charges($1::date)`, [MON]))).toMatch(/permission denied/);
    expect(await db.asAnon((q) => q.fails(`select * from public.charge_gaps()`))).toMatch(/permission denied/);
    expect(await db.asAnon((q) => q.fails(`select * from public.rate_history()`))).toMatch(/permission denied/);
    expect(await db.asAnon((q) => q.fails(`select public.planned_daily_cents(gen_random_uuid(), $1::date)`, [MON]))).toMatch(/permission denied/);
  });

  it('charge_recovery_days: ADMIN lo edita (auditado), valida 1..90, supervisor no', async () => {
    await adm((q) => q.query(`update public.app_settings set charge_recovery_days = 30`));
    expect(await db.su.query(`select charge_recovery_days d from public.app_settings`).then((r) => r.rows[0].d)).toBe(30);
    expect(await db.su.query(`select count(*)::int c from public.audit_logs where entity='app_settings' and detail->'new'->>'charge_recovery_days'='30'`).then((r) => r.rows[0].c)).toBe(1);
    expect(await adm((q) => q.fails(`update public.app_settings set charge_recovery_days = 91`))).toMatch(/check|violates/);
    expect(await adm((q) => q.fails(`update public.app_settings set charge_recovery_days = 0`))).toMatch(/check|violates/);
    expect(await db.as(db.supervisor, (q) => q.query(`update public.app_settings set charge_recovery_days = 5`).then((r) => r.rowCount))).toBe(0);
  });
});

describe('cuota prevista vs cargo generado (detalle y tabla semanal)', () => {
  it('semana pasada sin generar: 6 días missing y missing_days = 6; tras ensure, 0 y los días quedan pending', async () => {
    const x = await fresh();
    expect((await detail(x.assignment)).map((d) => d.status)).toEqual(['missing', 'missing', 'missing', 'missing', 'missing', 'missing', 'no_charge']);
    expect((await detail(x.assignment)).map((d) => d.planned_cents)).toEqual([4000, 4000, 4000, 4000, 4000, 4000, 0]);
    let t = (await table()).find((r) => r.assignment_id === x.assignment)!;
    expect(Number(t.planned_cents)).toBe(24000); expect(t.missing_days).toBe(6); expect(Number(t.week_charged_cents)).toBe(0);
    await ensure(addDays(MON, 6));
    expect((await detail(x.assignment)).slice(0, 6).every((d) => d.status === 'pending' && d.charge_generated)).toBe(true);
    t = (await table()).find((r) => r.assignment_id === x.assignment)!;
    expect(t.missing_days).toBe(0); expect(Number(t.week_charged_cents)).toBe(24000);
  });

  it('semana futura: planned con cuota prevista, sin cargos ni missing; el domingo no_charge; leer no inserta nada', async () => {
    const x = await fresh(4000, '2026-01-01');
    const before = await db.su.query(`select count(*)::int c from public.charges`).then((r) => r.rows[0].c);
    const d = await detail(x.assignment, FUTURE_MON);
    expect(d.map((r) => r.status)).toEqual(['planned', 'planned', 'planned', 'planned', 'planned', 'planned', 'no_charge']);
    expect(d.every((r) => r.charge_generated === false)).toBe(true);
    const t = (await table(FUTURE_MON)).find((r) => r.assignment_id === x.assignment)!;
    expect(Number(t.planned_cents)).toBe(24000); expect(t.missing_days).toBe(0);
    expect(await db.su.query(`select count(*)::int c from public.charges`).then((r) => r.rows[0].c)).toBe(before);
  });

  it('cambio de tarifa a mitad de semana: prevista $255 (40×3 + 45×3), cargos antiguos intactos y la tarifa nueva solo hacia adelante', async () => {
    const x = await fresh(4000);
    await ensure(addDays(MON, 2));
    const old = await db.su.query(`select id, amount_cents from public.charges where assignment_id=$1 order by charge_date`, [x.assignment]).then((r) => r.rows);
    await adm((q) => q.query(`select public.change_rate($1, 4500, $2::date, 'ajuste de mercado')`, [x.assignment, addDays(MON, 3)]));
    let t = (await table()).find((r) => r.assignment_id === x.assignment)!;
    expect(Number(t.planned_cents)).toBe(25500);
    expect((await detail(x.assignment)).map((d) => d.planned_cents)).toEqual([4000, 4000, 4000, 4500, 4500, 4500, 0]);
    await ensure(addDays(MON, 6));
    expect((await charges(x.assignment)).map((c) => c.a)).toEqual([4000, 4000, 4000, 4500, 4500, 4500]);
    expect(await db.su.query(`select id, amount_cents from public.charges where assignment_id=$1 order by charge_date limit 3`, [x.assignment]).then((r) => r.rows)).toEqual(old);
    t = (await table()).find((r) => r.assignment_id === x.assignment)!;
    expect(Number(t.week_charged_cents)).toBe(25500); expect(t.missing_days).toBe(0);
  });

  it('cambio de conductor a mitad de semana: una fila por asignación, cada una suma solo sus días y no se duplican días', async () => {
    const a = await fresh(4000);
    n += 1;
    const b = (await db.su.query(`insert into public.drivers(operator_code, national_id, first_name) values ($1,$1,'Relevo') returning id`, [`RV${n}`])).rows[0].id;
    await ensure(addDays(MON, 2));
    expect(await adm((q) => q.fails(`select public.reassign_unit($1,$2,$3::date,4200)`, [a.unit, b, addDays(MON, 2)]))).toBe('assignment_change_retroactive');
    const newAsg = (await adm((q) => q.one(`select public.reassign_unit($1,$2,$3::date,4200) id`, [a.unit, b, addDays(MON, 3)]))).id;
    const rows = (await table()).filter((r) => r.unit_id === a.unit);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => Number(r.planned_cents)).sort()).toEqual([12000, 12600]);
    expect(rows.reduce((s, r) => s + Number(r.planned_cents), 0)).toBe(24600);
    await ensure(addDays(MON, 6));
    expect((await charges(a.assignment)).map((c) => c.d)).toEqual([0, 1, 2].map((i) => addDays(MON, i)));
    expect((await charges(newAsg)).map((c) => c.d)).toEqual([3, 4, 5].map((i) => addDays(MON, i)));
    // sin duplicar el mismo período para la unidad
    const dup = await db.su.query(`select c.charge_date from public.charges c join public.assignments x on x.id=c.assignment_id where x.unit_id=$1 and c.kind='daily' group by 1 having count(*)>1`, [a.unit]);
    expect(dup.rowCount).toBe(0);
    // trazabilidad: qué conductor/unidad generó cada deuda
    const trace = await db.su.query(`select c.charge_date::text d, x.driver_id, x.unit_id, c.amount_cents::int a from public.charges c join public.assignments x on x.id=c.assignment_id where x.unit_id=$1 order by 1`, [a.unit]);
    expect(trace.rows.map((r) => [r.driver_id === a.driver ? 'viejo' : 'nuevo', r.a])).toEqual([['viejo', 4000], ['viejo', 4000], ['viejo', 4000], ['nuevo', 4200], ['nuevo', 4200], ['nuevo', 4200]]);
    expect(trace.rows.every((r) => r.unit_id === a.unit)).toBe(true);
    // la tarifa histórica del conductor anterior se conserva
    expect(await db.su.query(`select daily_amount_cents::int a, valid_to::text t from public.rates where assignment_id=$1`, [a.assignment]).then((r) => r.rows)).toEqual([{ a: 4000, t: addDays(MON, 2) }]);
  });

  it('pago parcial, pago completo, deuda anterior y crédito a favor sobre cuotas generadas', async () => {
    const x = await fresh(4000);
    await ensure(addDays(MON, 1));                                                    // lun-mar = 8000
    await adm((q) => pay(q, x.assignment, 'cash', 2500, { paidAt: `${MON}T10:00:00-05:00` }));
    expect(await adm((q) => position(q, x.assignment))).toMatchObject({ charged_cents: 8000, pending_cents: 5500, credit_cents: 0 });
    expect((await detail(x.assignment)).slice(0, 2).map((d) => [d.status, d.remaining_cents])).toEqual([['partial', 1500], ['pending', 4000]]);
    await adm((q) => pay(q, x.assignment, 'cash', 5500, { paidAt: `${addDays(MON, 1)}T10:00:00-05:00` }));
    expect(await adm((q) => position(q, x.assignment))).toMatchObject({ pending_cents: 0, credit_cents: 0 });
    expect((await detail(x.assignment)).slice(0, 2).every((d) => d.status === 'paid')).toBe(true);
    // crédito a favor: se aplica a la cuota generada después
    await adm((q) => pay(q, x.assignment, 'cash', 6000, { paidAt: `${addDays(MON, 1)}T18:00:00-05:00` }));
    expect(await adm((q) => position(q, x.assignment))).toMatchObject({ pending_cents: 0, credit_cents: 6000 });
    await ensure(addDays(MON, 2));
    expect(await adm((q) => position(q, x.assignment))).toMatchObject({ pending_cents: 0, credit_cents: 2000 });
    expect((await detail(x.assignment))[2]).toMatchObject({ status: 'paid', charge_generated: true });
    // deuda anterior (ajuste positivo) se conserva junto a la cuota nueva
    const y = await fresh(4000);
    await adm((q) => q.query(`select public.create_adjustment($1, 11900, $2::date, 'saldo anterior', $3)`, [y.assignment, addDays(MON, -1), key('adj')]));
    await ensure(MON);
    expect(await adm((q) => position(q, y.assignment))).toMatchObject({ charged_cents: 15900, pending_cents: 15900 });
  });
});

describe('historial de tarifas', () => {
  it('change_rate cierra la anterior el día previo, registra usuario y motivo, y rate_history lo muestra', async () => {
    const x = await fresh(4000);
    await adm((q) => q.query(`select public.change_rate($1, 4500, $2::date, '  ajuste de mercado ')`, [x.assignment, addDays(MON, 3)]));
    const rates = await db.su.query(`select daily_amount_cents::int a, valid_from::text f, valid_to::text t, created_by, reason from public.rates where assignment_id=$1 order by valid_from`, [x.assignment]);
    expect(rates.rows).toEqual([
      { a: 4000, f: MON, t: addDays(MON, 2), created_by: null, reason: null },
      { a: 4500, f: addDays(MON, 3), t: null, created_by: db.admin, reason: 'ajuste de mercado' }]);
    const h = await adm((q) => q.rows(`select * from public.rate_history($1)`, [x.assignment]));
    expect(h).toHaveLength(2);                                                       // la más reciente primero
    expect(h[0]).toMatchObject({ new_daily_cents: '4500', previous_daily_cents: '4000', changed_by: db.admin, reason: 'ajuste de mercado', unit_code: expect.stringMatching(/^AU/) });
    expect(h[0].changed_at).toBeInstanceOf(Date);
    expect(await adm((q) => q.one(`select previous_valid_to::text p, valid_from::text f from public.rate_history($1) where previous_daily_cents is not null`, [x.assignment]))).toEqual({ p: addDays(MON, 2), f: addDays(MON, 3) });
    expect(h[1]).toMatchObject({ new_daily_cents: '4000', previous_daily_cents: null });
    expect(await adm((q) => q.rows(`select * from public.rate_history()`))).toHaveLength(2);
    expect(await adm((q) => q.rows(`select * from public.rate_history(gen_random_uuid())`))).toHaveLength(0);
  });

  it('rechaza reescribir el pasado: cuotas generadas, semanas cerradas, solapes; las tarifas pasadas son inmutables', async () => {
    const x = await fresh(4000);
    await ensure(addDays(MON, 2));
    expect(await adm((q) => q.fails(`select public.change_rate($1, 4500, $2::date)`, [x.assignment, addDays(MON, 2)]))).toBe('rate_change_retroactive');
    expect(await adm((q) => q.fails(`select public.change_rate($1, 4500, $2::date)`, [x.assignment, MON]))).toBe('invalid_dates');
    expect(await adm((q) => q.fails(`select public.change_rate($1, 4500, $2::date)`, [x.assignment, addDays(MON, -30)]))).toBe('invalid_dates');
    await adm((q) => q.query(`select public.close_week($1::date)`, [MON]));
    expect(await adm((q) => q.fails(`select public.change_rate($1, 4500, $2::date)`, [x.assignment, addDays(MON, 4)]))).toBe('rate_change_closed_week');
    expect(await adm((q) => q.fails(`select public.change_rate($1, 4500, $2::date)`, [x.assignment, addDays(MON, 8)]))).toBeNull();     // semana siguiente: sí
    await expect(db.su.query(`update public.rates set daily_amount_cents = 1 where assignment_id=$1`, [x.assignment])).rejects.toThrow(/rate_history_immutable/);
    expect(await db.as(db.supervisor, (q) => q.fails(`select public.change_rate($1, 4500, $2::date)`, [x.assignment, addDays(MON, 20)]))).toBe('forbidden');
  });

  it('start_assignment registra la tarifa inicial con usuario y motivo', async () => {
    n += 1;
    const dr = (await db.su.query(`insert into public.drivers(operator_code, national_id, first_name) values ($1,$1,'Nuevo') returning id`, [`NS${n}`])).rows[0].id;
    const un = (await db.su.query(`insert into public.units(code) values ($1) returning id`, [`NSU${n}`])).rows[0].id;
    const id = (await adm((q) => q.one(`select public.start_assignment($1,$2,$3::date,3600) id`, [dr, un, MON]))).id;
    const h = await adm((q) => q.rows(`select * from public.rate_history($1)`, [id]));
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ changed_by: db.admin, reason: 'Tarifa inicial de la asignación', previous_daily_cents: null, is_current: true });
  });
});

describe('recordatorios solo con deuda exigible real', () => {
  const at = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00-05:00`).toISOString();
  const setSchedules = async (opts: { minBetween?: number } = {}) => {
    await ensureBaseTemplates(db);
    await db.su.query(`update public.notification_schedules set enabled = (kind in ('debt_first','debt_update','debt_last')), scope='total', template_id=${BASE_TPL},
      local_time = case kind when 'debt_first' then '09:00'::time when 'debt_update' then '17:00'::time when 'debt_last' then '21:00'::time else local_time end`);
    await db.su.query(`update public.app_settings set max_per_driver_per_day = 3, min_minutes_between = $1`, [opts.minBetween ?? 60]);
  };
  async function tick(now: string) {
    return db.asService(async (q) => {
      await q.query(`select public.schedule_reminders($1)`, [now]);
      const jobs = await q.rows(`select * from public.claim_notification_jobs(50, $1)`, [now]);
      const out: Array<{ kind: string; action: string; status: string; body?: string }> = [];
      for (const j of jobs) {
        const p = (await q.one(`select public.prepare_notification_send($1, $2) p`, [j.id, now])).p;
        if (p.action === 'send') await q.query(`select public.complete_notification($1,'sent',null,true,$2,$3)`, [j.id, p.body, now]);
        out.push({ kind: j.kind, action: p.action, body: p.body, status: (await q.one(`select status from public.notification_jobs where id=$1`, [j.id])).status });
      }
      return out;
    });
  }
  const payAt = (asg: string, cents: number, hhmm: string) => adm((q) => pay(q, asg, 'cash', cents, { paidAt: at(MON, hhmm) }));

  it('sin cargos generados (el motor no corrió) no se programan recordatorios de deuda; tras generar, sí', async () => {
    await setSchedules();
    await fresh(4000, MON, { phone: '+50760009001', consent: true });
    expect(await tick(at(MON, '09:05'))).toEqual([]);
    expect(await db.su.query(`select count(*)::int c from public.notification_jobs`).then((r) => r.rows[0].c)).toBe(0);
    await ensure(MON);
    const out = await tick(at(MON, '09:10'));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'debt_first', action: 'send' });
  });

  it('9:00 $40 sin abonos → $40; 14:00 pago $25 → pendiente $15; 17:00 → $15; 20:00 pago $15 → saldo 0; 21:00 skipped_paid', async () => {
    await setSchedules();
    const x = await fresh(4000, MON, { phone: '+50760009002', consent: true });
    await ensure(MON);
    const a = await tick(at(MON, '09:00'));
    expect(a[0]).toMatchObject({ kind: 'debt_first', status: 'sent' }); expect(a[0].body).toContain('$40.00');
    await payAt(x.assignment, 2500, '14:00');
    expect(await adm((q) => position(q, x.assignment))).toMatchObject({ pending_cents: 1500 });
    const b = await tick(at(MON, '17:00'));
    expect(b[0]).toMatchObject({ kind: 'debt_update', status: 'sent' }); expect(b[0].body).toContain('$15.00'); expect(b[0].body).not.toContain('$40.00');
    await payAt(x.assignment, 1500, '20:00');
    expect(await adm((q) => position(q, x.assignment))).toMatchObject({ pending_cents: 0, credit_cents: 0 });
    const c = await tick(at(MON, '21:00'));
    expect(c[0]).toMatchObject({ kind: 'debt_last', action: 'skip', status: 'skipped_paid' });
  });

  it('con deuda anterior de $119: tras pagar la cuota del día el recordatorio sigue por la deuda anterior (nunca como cuenta saldada)', async () => {
    await setSchedules();
    const x = await fresh(4000, MON, { phone: '+50760009003', consent: true });
    await adm((q) => q.query(`select public.create_adjustment($1, 11900, $2::date, 'saldo anterior', $3)`, [x.assignment, addDays(MON, -1), key('adj')]));
    await ensure(MON);
    const a = await tick(at(MON, '09:00'));
    expect(a[0].body).toContain('$159.00');
    await payAt(x.assignment, 4000, '14:00');                                        // paga exactamente la cuota del día
    const b = await tick(at(MON, '17:00'));
    expect(b[0]).toMatchObject({ kind: 'debt_update', action: 'send', status: 'sent' });
    expect(b[0].body).toContain('$119.00'); expect(b[0].body).not.toContain('$159.00');
    await payAt(x.assignment, 11900, '20:00');
    expect((await tick(at(MON, '21:00')))[0]).toMatchObject({ status: 'skipped_paid' });
  });

  it('solo crédito → skipped_credit; sin consentimiento no se programa; límite min_minutes_between respetado', async () => {
    await setSchedules({ minBetween: 600 });
    const x = await fresh(4000, MON, { phone: '+50760009004', consent: true });
    await fresh(4000, MON, { phone: '+50760009005', consent: false });
    await ensure(MON);
    expect((await tick(at(MON, '09:00'))).map((o) => o.status)).toEqual(['sent']);                                // solo el que consintió
    expect((await tick(at(MON, '17:00'))).map((o) => o.status)).toEqual(['skipped_frequency']);                  // 8 h < 10 h
    await payAt(x.assignment, 9000, '18:00');                                                                    // $50 de crédito
    expect((await tick(at(MON, '21:00'))).map((o) => o.status)).toEqual(['skipped_credit']);
  });

  it('domingo: sin cuota ordinaria; con deuda anterior el resumen y el pago siguen funcionando', async () => {
    const x = await fresh(4000);
    await ensure(addDays(MON, 6));
    expect(await adm((q) => position(q, x.assignment))).toMatchObject({ charged_cents: 24000 });
    await adm((q) => pay(q, x.assignment, 'cash', 4000, { paidAt: `${addDays(MON, 6)}T09:00:00-05:00` }));
    expect(await adm((q) => position(q, x.assignment))).toMatchObject({ pending_cents: 20000 });
  });
});

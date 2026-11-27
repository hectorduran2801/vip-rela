import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MON, MON2, SUN, addDays, chargeWeek, key, pay, position } from './fixtures.js';
import { newDb, type Db, type Q } from './harness.js';

let db: Db;
let n = 0;
beforeAll(async () => { db = await newDb(); });
afterAll(async () => { await db.close(); });

const fresh = async (dailyCents = 3600, weeks: string[] = [MON]) => {
  n += 1;
  const x = await db.driverWithAssignment({ code: `C${n}`, unit: `U${n}`, dailyCents, phone: `+5076000${String(1000 + n)}`, consent: true });
  for (const w of weeks) await chargeWeek(db, w);
  return x;
};
const adm = <T>(fn: (q: Q) => Promise<T>) => db.as(db.admin, fn);
const oneDay = async (cents = 3600) => {
  n += 1;
  const x = await db.driverWithAssignment({ code: `D${n}`, unit: `V${n}`, dailyCents: cents });
  await db.su.query(`insert into public.charges(assignment_id, kind, charge_date, amount_cents, week_start) values ($1,'daily',$2,$3,$2)`, [x.assignment, MON, cents]);
  return x;
};

describe('cuotas semanales', () => {
  it('lunes a sábado generan cuota y el domingo no; es idempotente', async () => {
    const x = await db.driverWithAssignment({ code: 'W-A', unit: 'WU-A', dailyCents: 3600 });
    expect(await chargeWeek(db, MON)).toBeGreaterThanOrEqual(6);
    await chargeWeek(db, MON);
    const dates = (await db.su.query(`select charge_date::text d from public.charges where assignment_id=$1 order by 1`, [x.assignment])).rows.map((r) => r.d);
    expect(dates).toEqual([0, 1, 2, 3, 4, 5].map((i) => addDays(MON, i)));
    expect((await adm((q) => position(q, x.assignment))).charged_cents).toBe(21600);
  });
  it('respeta excepciones (día libre) y no cobra a conductores inactivos', async () => {
    const x = await db.driverWithAssignment({ code: 'W-B', unit: 'WU-B', dailyCents: 3000 });
    await db.su.query(`insert into public.rate_exceptions(assignment_id, on_date, amount_cents, reason) values ($1,$2,0,'día libre')`, [x.assignment, addDays(MON, 2)]);
    await chargeWeek(db, MON);
    expect((await adm((q) => position(q, x.assignment))).charged_cents).toBe(15000);
    await db.su.query(`update public.drivers set status='inactive' where id=$1`, [x.driver]);
    await db.as(db.admin, (q) => q.query(`select public.generate_daily_charges($1::date)`, [addDays(MON, 7)]));
    expect(Number((await db.su.query(`select count(*) n from public.charges where assignment_id=$1 and charge_date=$2`, [x.assignment, addDays(MON, 7)])).rows[0].n)).toBe(0);
  });
  it('las tarifas no pueden incluir domingo ni solaparse', async () => {
    const x = await fresh();
    expect(await db.su.query(`insert into public.rates(assignment_id, daily_amount_cents, weekdays, valid_from) values ($1,100,'{7}','2027-01-01')`, [x.assignment]).then(() => null, (e) => e.message)).toMatch(/check/);
    expect(await db.su.query(`insert into public.rates(assignment_id, daily_amount_cents, valid_from) values ($1,100,'2026-06-01')`, [x.assignment]).then(() => null, (e) => e.message)).toMatch(/conflicting key|exclusion/);
  });
});

describe('pago completo y comisión', () => {
  it('efectivo $36: la empresa recibe $36', async () => {
    const x = await oneDay();
    expect(await adm((q) => pay(q, x.assignment, 'cash', 3600))).toMatchObject({ gross_cents: 3600, commission_cents: 0, net_cents: 3600, applied_cents: 3600, credit_generated_cents: 0, pending_cents: 0 });
  });
  it.each(['yappy', 'punto_pago'])('%s $37: comisión $1 y la empresa recibe $36', async (m) => {
    const x = await oneDay();
    expect(await adm((q) => pay(q, x.assignment, m, 3700))).toMatchObject({ gross_cents: 3700, commission_cents: 100, net_cents: 3600, applied_cents: 3600, pending_cents: 0, credit_cents: 0 });
    expect(await adm((q) => position(q, x.assignment))).toMatchObject({ charged_cents: 3600, gross_cents: 3700, commission_cents: 100, net_cents: 3600 });
  });
  it('registra fecha, hora, referencia, observaciones y usuario responsable', async () => {
    const x = await fresh();
    const r = await adm((q) => pay(q, x.assignment, 'yappy', 1100, { reference: ' TX-77 ', notes: 'comprobante visto en WhatsApp', paidAt: `${MON}T15:30:00-05:00` }));
    const row = (await db.su.query(`select reference, notes, to_char(paid_at at time zone 'America/Panama','HH24:MI') t, registered_by, week_start::text w from public.payments where id=$1`, [r.payment_id])).rows[0];
    expect(row).toEqual({ reference: 'TX-77', notes: 'comprobante visto en WhatsApp', t: '15:30', registered_by: db.admin, w: MON });
  });
});

describe('pagos parciales electrónicos', () => {
  it('Yappy $30 sobre $36 → neto $29, pendiente $7; luego Yappy $8 → neto $7 y deuda cancelada', async () => {
    const x = await oneDay();
    expect(await adm((q) => pay(q, x.assignment, 'yappy', 3000))).toMatchObject({ net_cents: 2900, applied_cents: 2900, pending_cents: 700 });
    expect(await adm((q) => pay(q, x.assignment, 'yappy', 800))).toMatchObject({ net_cents: 700, applied_cents: 700, pending_cents: 0, credit_cents: 0 });
    expect(await adm((q) => position(q, x.assignment))).toMatchObject({ gross_cents: 3800, commission_cents: 200, net_cents: 3600 });
  });
  it('dos transferencias el mismo día mantienen cada una su comisión', async () => {
    const x = await fresh();
    await adm((q) => pay(q, x.assignment, 'punto_pago', 2000)); await adm((q) => pay(q, x.assignment, 'punto_pago', 1600));
    expect((await db.su.query(`select commission_cents::int c from public.payments where assignment_id=$1`, [x.assignment])).rows.map((r) => r.c)).toEqual([100, 100]);
  });
});

describe('crédito a favor', () => {
  it('netos $220 sobre cuenta $216 → crédito $4 (se usa el neto, no el bruto)', async () => {
    const x = await fresh();
    expect(await adm((q) => pay(q, x.assignment, 'yappy', 22100))).toMatchObject({ gross_cents: 22100, net_cents: 22000, applied_cents: 21600, credit_generated_cents: 400, pending_cents: 0, credit_cents: 400 });
  });
  it('se aplica a la semana siguiente ($216 − $4 = $212) y cubre parcialmente la primera cuota', async () => {
    const x = await fresh(3600, [MON]);
    await adm((q) => pay(q, x.assignment, 'cash', 22000));
    await chargeWeek(db, MON2);
    expect(await adm((q) => position(q, x.assignment))).toMatchObject({ pending_cents: 21200, credit_cents: 0 });
    const cov = await adm((q) => q.rows(`select charge_date::text d, amount_cents::int a, covered_cents::int c from public.assignment_coverage($1) where charge_date >= $2 order by 1 limit 1`, [x.assignment, MON2]));
    expect(cov[0]).toMatchObject({ d: MON2, a: 3600, c: 400 });
  });
  it('aplica el neto a las deudas MÁS ANTIGUAS primero y registra la asignación', async () => {
    const x = await fresh();
    const r = await adm((q) => pay(q, x.assignment, 'cash', 5000));
    const al = (await db.su.query(`select c.charge_date::text d, pa.amount_cents::int a from public.payment_allocations pa join public.charges c on c.id=pa.charge_id where pa.payment_id=$1 order by 1`, [r.payment_id])).rows;
    expect(al).toEqual([{ d: MON, a: 3600 }, { d: addDays(MON, 1), a: 1400 }]);
  });
  it('con deuda anterior, primero se cubre la deuda y solo el excedente es crédito', async () => {
    const x = await fresh(3600, [MON, MON2]);
    expect(await adm((q) => pay(q, x.assignment, 'cash', 50000))).toMatchObject({ applied_cents: 43200, credit_generated_cents: 6800, pending_cents: 0, credit_cents: 6800 });
  });
  it('0028 · ya no se generan avisos de crédito en borrador: ni con excedente ni al consultar', async () => {
    const x = await fresh();
    expect((await adm((q) => pay(q, x.assignment, 'cash', 1000))).credit_notice_job_id).toBeNull();
    const over = await adm((q) => pay(q, x.assignment, 'cash', 21600));
    expect(over.credit_notice_job_id ?? null).toBeNull();
    expect(Number((await db.su.query(`select count(*) n from public.notification_jobs where kind='credit_notice' and driver_id=$1`, [x.driver])).rows[0].n)).toBe(0);
    for (let i = 0; i < 3; i++) await adm((q) => position(q, x.assignment));
    expect(Number((await db.su.query(`select count(*) n from public.notification_jobs where kind='credit_notice' and driver_id=$1`, [x.driver])).rows[0].n)).toBe(0);
  });
  it('el crédito sobrevive al cierre semanal', async () => {
    const x = await fresh();
    await adm((q) => pay(q, x.assignment, 'cash', 22000, { paidAt: `${MON}T10:00:00-05:00` }));
    await db.as(db.admin, (q) => q.query(`select public.close_week($1)`, [MON]));
    expect((await db.su.query(`select pending_cents::int p, credit_cents::int c, net_cents::int n from public.weekly_closures where assignment_id=$1`, [x.assignment])).rows[0]).toEqual({ p: 0, c: 400, n: 22000 });
    expect((await adm((q) => position(q, x.assignment))).credit_cents).toBe(400);
  });
});

describe('deuda arrastrada y domingo', () => {
  it('pagos del domingo reducen la deuda, el domingo no genera cuota y la deuda pasa a la semana siguiente', async () => {
    const x = await fresh();
    await adm((q) => pay(q, x.assignment, 'cash', 18000, { paidAt: `${MON}T18:00:00-05:00` }));
    expect((await adm((q) => position(q, x.assignment))).pending_cents).toBe(3600);
    expect((await adm((q) => pay(q, x.assignment, 'cash', 2000, { paidAt: `${SUN}T09:00:00-05:00` }))).pending_cents).toBe(1600);
    expect(await db.as(db.admin, async (q) => (await q.one(`select public.generate_daily_charges($1::date) n`, [SUN])).n)).toBe(0);
    await chargeWeek(db, MON2);
    expect((await adm((q) => position(q, x.assignment))).pending_cents).toBe(1600 + 21600);
    const oldest = (await adm((q) => q.rows(`select charge_date::text d, remaining_cents::int r from public.assignment_coverage($1) where remaining_cents > 0 order by charge_date limit 1`, [x.assignment])))[0];
    expect(oldest).toEqual({ d: addDays(MON, 5), r: 1600 });
  });
  it('un pago anulado deja de contar', async () => {
    const x = await oneDay();
    const p = await adm((q) => pay(q, x.assignment, 'cash', 3600));
    await adm((q) => q.query(`select public.void_payment($1,'duplicado')`, [p.payment_id]));
    expect((await adm((q) => position(q, x.assignment))).pending_cents).toBe(3600);
  });
});

describe('idempotencia y validaciones', () => {
  it('la misma clave no registra dos veces; con otro importe es un conflicto', async () => {
    const x = await fresh(); const k = key();
    const a = await adm((q) => pay(q, x.assignment, 'yappy', 3000, { key: k })); const b = await adm((q) => pay(q, x.assignment, 'yappy', 3000, { key: k }));
    expect([a.duplicate, b.duplicate, b.payment_id === a.payment_id]).toEqual([false, true, true]);
    expect(await adm((q) => q.fails(`select public.register_payment($1,'yappy',2000,$2)`, [x.assignment, k]))).toBe('idempotency_conflict');
    expect(Number((await db.su.query(`select count(*) n from public.payments where assignment_id=$1`, [x.assignment])).rows[0].n)).toBe(1);
  });
  it('rechaza importes y datos inválidos', async () => {
    const x = await fresh();
    const bad = (m: string, g: number | string, k = key(), paidAt: string | null = null) => adm((q) => q.fails(`select public.register_payment($1,$2,$3,$4,null,$5)`, [x.assignment, m, g, k, paidAt]));
    expect(await bad('cash', 0)).toBe('invalid_amount'); expect(await bad('cash', -5)).toBe('invalid_amount');
    expect(await bad('yappy', 100)).toBe('amount_not_covering_commission'); expect(await bad('bitcoin', 1000)).toBe('invalid_method');
    expect(await bad('cash', 1000, '   ')).toBe('idempotency_key_required'); expect(await bad('cash', 1000, key(), '2099-01-01T00:00:00Z')).toBe('paid_at_in_future');
  });
  it('rechaza pagos para métodos inactivos y asignaciones cerradas', async () => {
    const x = await fresh();
    await db.su.query(`update public.payment_methods set active=false where code='punto_pago'`);
    expect(await adm((q) => q.fails(`select public.register_payment($1,'punto_pago',1000,$2)`, [x.assignment, key()]))).toBe('invalid_method');
    await db.su.query(`update public.payment_methods set active=true where code='punto_pago'`);
    await db.su.query(`update public.assignments set valid_to='2026-06-30' where id=$1`, [x.assignment]);
    expect(await adm((q) => q.fails(`select public.register_payment($1,'cash',1000,$2)`, [x.assignment, key()]))).toBe('assignment_inactive');
  });
  it('un pago fallido no deja rastro (atomicidad)', async () => {
    const x = await fresh();
    const cnt = async () => (await db.su.query(`select (select count(*) from public.payments) p, (select count(*) from public.payment_allocations) a, (select count(*) from public.notification_jobs) j`)).rows[0];
    const before = await cnt();
    await adm((q) => q.fails(`select public.register_payment($1,'yappy',50,$2)`, [x.assignment, key()]));
    expect(await cnt()).toEqual(before);
  });
  it('prepara el comprobante de WhatsApp sin enviarlo dentro de la transacción', async () => {
    const x = await fresh();
    const r = await adm((q) => pay(q, x.assignment, 'yappy', 3000, { receipt: true }));
    expect((await db.su.query(`select kind, status, sent_at, rendered_body from public.notification_jobs where id=$1`, [r.receipt_job_id])).rows[0]).toMatchObject({ kind: 'payment_receipt', status: 'pending', sent_at: null, rendered_body: null });
  });
});

describe('concurrencia', () => {
  it('10 pagos simultáneos del mismo conductor se serializan sin perder ni duplicar importes', async () => {
    const x = await fresh();
    const rs = await Promise.all(Array.from({ length: 10 }, () => adm((q) => pay(q, x.assignment, 'cash', 1000))));
    expect(new Set(rs.map((r) => r.payment_id)).size).toBe(10);
    expect(await adm((q) => position(q, x.assignment))).toMatchObject({ net_cents: 10000, pending_cents: 11600 });
    expect((await db.su.query(`select sum(applied_cents)::int a, sum(credit_generated_cents)::int c from public.payments where assignment_id=$1`, [x.assignment])).rows[0]).toEqual({ a: 10000, c: 0 });
  });
  it('10 reintentos simultáneos con la MISMA clave producen un único pago', async () => {
    const x = await fresh(); const k = key();
    const rs = await Promise.all(Array.from({ length: 10 }, () => adm((q) => pay(q, x.assignment, 'yappy', 3000, { key: k }))));
    expect(new Set(rs.map((r) => r.payment_id)).size).toBe(1);
    expect(rs.filter((r) => !r.duplicate)).toHaveLength(1);
  });
  it('pagos simultáneos que exceden la deuda generan exactamente el crédito correcto', async () => {
    const x = await fresh();
    await Promise.all(Array.from({ length: 8 }, () => adm((q) => pay(q, x.assignment, 'cash', 3000))));
    expect((await db.su.query(`select sum(applied_cents)::int a, sum(credit_generated_cents)::int c, sum(net_cents)::int n from public.payments where assignment_id=$1`, [x.assignment])).rows[0]).toEqual({ a: 21600, c: 2400, n: 24000 });
  });
});

describe('correcciones y cierres auditados', () => {
  it('anular restaura la deuda, cancela sus notificaciones, queda auditado y el registro se conserva', async () => {
    const x = await fresh();
    const p = await adm((q) => pay(q, x.assignment, 'cash', 22000, { receipt: true }));
    expect((await adm((q) => q.one(`select public.void_payment($1,'monto mal digitado') r`, [p.payment_id]))).r).toMatchObject({ pending_cents: 21600, credit_cents: 0 });
    expect((await db.su.query(`select kind, status from public.notification_jobs where payment_id=$1 order by kind`, [p.payment_id])).rows).toEqual([{ kind: 'payment_receipt', status: 'cancelled' }]);   // 0028: sin borrador de aviso de crédito
    const log = (await db.su.query(`select actor, detail from public.audit_logs where action='void_payment' and entity_id=$1`, [p.payment_id])).rows[0];
    expect(log.actor).toBe(db.admin); expect(log.detail.reason).toBe('monto mal digitado');
    expect((await db.su.query(`select count(*)::int n from public.payments where id=$1`, [p.payment_id])).rows[0].n).toBe(1);
  });
  it('no se anula dos veces, sin motivo, ni en una semana cerrada', async () => {
    const x = await fresh();
    const p = await adm((q) => pay(q, x.assignment, 'cash', 1000, { paidAt: `${MON}T09:00:00-05:00` }));
    expect(await adm((q) => q.fails(`select public.void_payment($1,'  ')`, [p.payment_id]))).toBe('reason_required');
    await adm((q) => q.query(`select public.void_payment($1,'duplicado')`, [p.payment_id]));
    expect(await adm((q) => q.fails(`select public.void_payment($1,'otra vez')`, [p.payment_id]))).toBe('already_voided');
    const p2 = await adm((q) => pay(q, x.assignment, 'cash', 1000, { paidAt: `${MON}T09:00:00-05:00` }));
    await adm((q) => q.query(`select public.close_week($1)`, [MON]));
    expect(await adm((q) => q.fails(`select public.void_payment($1,'tarde')`, [p2.payment_id]))).toBe('week_closed');
  });
  it('los ajustes positivos aumentan la deuda y los negativos otorgan crédito (idempotentes y con motivo)', async () => {
    const x = await fresh(3600, []); const k = key();
    const adj = (amount: number, reason = 'corrección autorizada', kk = key()): Promise<any> => adm((q) => q.one(`select public.create_adjustment($1,$2,'2026-03-02',$3,$4) r`, [x.assignment, amount, reason, kk]));
    expect((await adj(2500, 'cargo omitido', k)).r.pending_cents).toBe(2500);
    expect((await adj(2500, 'cargo omitido', k)).r.duplicate).toBe(true);
    expect((await adj(-4000)).r).toMatchObject({ pending_cents: 0, credit_cents: 1500 });
    expect(await adm((q) => q.fails(`select public.create_adjustment($1,100,'2026-03-02','  ',$2)`, [x.assignment, key()]))).toBe('reason_required');
    expect(await adm((q) => q.fails(`select public.create_adjustment($1,0,'2026-03-02','cero',$2)`, [x.assignment, key()]))).toBe('invalid_amount');
  });
  it('el cierre semanal toma una foto, exige lunes, es idempotente y la deuda se arrastra', async () => {
    const x = await fresh();
    await adm((q) => pay(q, x.assignment, 'yappy', 18100, { paidAt: `${MON}T10:00:00-05:00` }));
    expect(await adm((q) => q.fails(`select public.close_week($1)`, [SUN]))).toBe('week_start_must_be_monday');
    expect(await db.as(db.admin, async (q) => (await q.one(`select public.close_week($1) n`, [MON])).n)).toBeGreaterThan(0);
    expect(await db.as(db.admin, async (q) => (await q.one(`select public.close_week($1) n`, [MON])).n)).toBe(0);
    expect((await db.su.query(`select charged_cents::int ch, gross_cents::int g, commission_cents::int cm, net_cents::int n, pending_cents::int p, credit_cents::int c from public.weekly_closures where assignment_id=$1`, [x.assignment])).rows[0])
      .toEqual({ ch: 21600, g: 18100, cm: 100, n: 18000, p: 3600, c: 0 });
    await chargeWeek(db, MON2);
    expect((await adm((q) => position(q, x.assignment))).pending_cents).toBe(3600 + 21600);
  });
});

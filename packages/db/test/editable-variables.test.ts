import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newDb, type Db, type Q } from './harness.js';

/** 0037: textos de variables editables (solo ADMIN) y {{saldo_total}} = SALDO + cuota de hoy. */
let db: Db; let n = 0;
beforeAll(async () => { db = await newDb(); await db.su.query(`insert into public.payment_methods(code, label) values ('excel','Excel') on conflict (code) do nothing`); }, 120_000);
afterAll(async () => { await db.close(); });
const adm = <T>(fn: (q: Q) => Promise<T>) => db.as(db.opsAdmin, fn);
const MON = '2026-11-23', TUE = '2026-11-24', SUN = '2026-11-29';
const mk = async (saldo: number) => {
  n += 1; const x = await db.driverWithAssignment({ code: `XE${n}`, unit: `XEU${n}`, dailyCents: 3000 });
  await db.su.query(`insert into public.collection_week_units(week_start, unit_id, unit_code, assignment_id, driver_id, saldo_excel_cents, first_import_id, last_import_id)
    select $1::date, a.unit_id, 'X', a.id, a.driver_id, $3, null, null from public.assignments a where a.id=$2`, [MON, x.assignment, saldo]);
  await db.su.query(`update public.assignments set collect_commission=false where id=$1`, [x.assignment]);          // el cálculo base se mide sin comisión (ver sección de comisión)
  return x;
};
const vars = async (asg: string, date = MON) => (await db.su.query(`select app_private.template_vars($1,$2::date) v`, [asg, date])).rows[0].v;

describe('saldo_total = SALDO del Excel + cuota de hoy', () => {
  const pay = async (x: { assignment: string; driver: string }, date: string, cents: number) => {
    const pid = (await db.su.query(`insert into public.payments(assignment_id, method_id, gross_cents, net_cents, applied_cents, week_start, registered_by, idempotency_key, paid_at)
      values ($1, (select id from public.payment_methods where code='excel'), $2, $2, $2, '2026-11-23', $4, $3, $5::timestamptz) returning id`, [x.assignment, cents, `ev-${Math.random()}-${date}`, db.admin, `${date}T15:00:00Z`])).rows[0].id;
    await db.su.query(`insert into public.excel_payment_days(assignment_id, pay_date, week_start, driver_id, amount_cents, payment_id) values ($1,$2,'2026-11-23',$3,$4,$5)`, [x.assignment, date, x.driver, cents, pid]);
  };
  it('sin pagos: SALDO + cuotas de la semana hasta hoy', async () => {
    const x = await mk(10000);
    expect(await vars(x.assignment, MON)).toMatchObject({ saldo_total: '$130.00', deuda_anterior: '$100.00', cuota_hoy: '$30.00' });
    expect(await vars(x.assignment, TUE)).toMatchObject({ saldo_total: '$160.00' });
  });
  it('ejemplo de la administradora: SALDO 100, cuota 30; el lunes paga 30 y el martes 25 → el martes debe 105', async () => {
    const x = await mk(10000); await pay(x, MON, 3000);
    expect((await vars(x.assignment, MON)).saldo_total).toBe('$100.00');            // pagó completo: sigue debiendo solo el SALDO
    await pay(x, TUE, 2500);
    expect(await vars(x.assignment, TUE)).toMatchObject({ saldo_total: '$105.00', deuda_anterior: '$100.00', detalle_deuda: 'Su saldo pendiente es de $105.00.' });
  });
  it('si paga de más, lo sobrante cubre las cuotas siguientes; el neto a favor se comunica como saldo a favor', async () => {
    const x = await mk(1000); await pay(x, MON, 5000);
    expect(await vars(x.assignment, MON)).toMatchObject({ saldo_total: '$0.00', credito: '$10.00', detalle_deuda: 'Su cuenta está al día y tiene un saldo a favor de $10.00.' });
    expect((await vars(x.assignment, TUE)).saldo_total).toBe('$20.00');
  });
});

describe('saldo total: fechas controladas e importes exactos', () => {
  const WED = '2026-11-25', THU = '2026-11-26';
  const pay = async (x: { assignment: string; driver: string }, date: string, cents: number) => {
    const pid = (await db.su.query(`insert into public.payments(assignment_id, method_id, gross_cents, net_cents, applied_cents, week_start, registered_by, idempotency_key, paid_at)
      values ($1, (select id from public.payment_methods where code='excel'), $2, $2, $2, '2026-11-23', $4, $3, $5::timestamptz) returning id`, [x.assignment, cents, `ev2-${Math.random()}-${date}`, db.admin, `${date}T15:00:00Z`])).rows[0].id;
    await db.su.query(`insert into public.excel_payment_days(assignment_id, pay_date, week_start, driver_id, amount_cents, payment_id) values ($1,$2,'2026-11-23',$3,$4,$5)`, [x.assignment, date, x.driver, cents, pid]);
  };
  it('ejemplo exacto: SALDO 100, cuota 30; lun paga 30, mar 25, mié 20 → el miércoles debe $115.00 y el jueves aún no cuenta', async () => {
    const x = await mk(10000); await pay(x, MON, 3000); await pay(x, TUE, 2500); await pay(x, WED, 2000);
    expect((await vars(x.assignment, MON)).saldo_total).toBe('$100.00');
    expect((await vars(x.assignment, TUE)).saldo_total).toBe('$105.00');
    expect((await vars(x.assignment, WED)).saldo_total).toBe('$115.00');
    expect((await db.su.query(`select total_cents from app_private.saldo_total($1,$2::date)`, [x.assignment, WED])).rows[0].total_cents).toBe('11500');     // misma fuente que Cobranza y los horarios
    expect((await vars(x.assignment, THU)).saldo_total).toBe('$145.00');                                       // el jueves SÍ suma su propia cuota, pero nunca la de días posteriores
  });
  it('no cuenta días futuros: el lunes no incluye la cuota del martes aunque ya haya un pago registrado después', async () => {
    const x = await mk(10000); await pay(x, TUE, 3000);
    expect((await vars(x.assignment, MON)).saldo_total).toBe('$130.00');
  });
  it('domingo: sin cuota, pero un pago ese día reduce la deuda', async () => {
    const x = await mk(10000); await pay(x, SUN, 5000);
    expect(await vars(x.assignment, SUN)).toMatchObject({ cuota_hoy: '$0.00', saldo_total: '$230.00' });          // 100 + 6 cuotas (180) − 50
  });
  it('un pago excedente reduce lo pendiente o genera crédito; SALDO vacío = $0.00', async () => {
    const x = await mk(0); await pay(x, MON, 7000);
    expect(await vars(x.assignment, MON)).toMatchObject({ saldo_total: '$0.00', credito: '$40.00' });
    expect((await vars(x.assignment, TUE)).saldo_total).toBe('$0.00');                                             // 0 + 60 − 70 = −10 → crédito 10
    expect((await vars(x.assignment, TUE)).credito).toBe('$10.00');
    const y = await mk(0); expect((await vars(y.assignment, MON)).saldo_total).toBe('$30.00');
    n += 1; const z = await mk(0);
    await db.su.query(`update public.collection_week_units set saldo_excel_cents = null where assignment_id = $1`, [z.assignment]);   // celda SALDO vacía = $0.00, no «desconocido»
    expect(await vars(z.assignment, MON)).toMatchObject({ saldo_total: '$30.00', deuda_anterior: '$0.00' });
  });
});

describe('variables editables', () => {
  it('editar nombre/descripción se refleja en el catálogo y se puede restablecer; queda auditado', async () => {
    await adm((q) => q.rows(`select public.save_template_variable('saldo_total','Total a pagar hoy','Saldo más la cuota del día')`));
    const row = (await adm((q) => q.rows(`select code, label, description from public.template_variables()`))).find((r) => r.code === 'saldo_total')!;
    expect(row).toMatchObject({ label: 'Total a pagar hoy', description: 'Saldo más la cuota del día' });
    expect((await adm((q) => q.rows(`select customized from public.template_variable_editor() where code='saldo_total'`)))[0].customized).toBe(true);
    await adm((q) => q.rows(`select public.reset_template_variable('saldo_total')`));
    expect((await adm((q) => q.rows(`select label from public.template_variables() where code='saldo_total'`)))[0].label).toBe('Saldo total');
    expect((await db.su.query(`select count(*)::int n from public.audit_logs where action like 'template_variable.%'`)).rows[0].n).toBe(2);
  });
  it('las frases de {{detalle_deuda}} se editan (con {monto} obligatorio y protegido) y se restablecen', async () => {
    const x = await mk(5000);
    await adm((q) => q.rows(`select public.save_template_text('detalle_pendiente','Su deuda total al día de hoy es de {monto}.')`));
    expect((await vars(x.assignment)).detalle_deuda).toBe('Su deuda total al día de hoy es de $80.00.');
    expect(await adm((q) => q.fails(`select public.save_template_text('detalle_pendiente','Sin importe')`))).toBe('text_needs_amount');
    expect(await adm((q) => q.fails(`select public.save_template_text('detalle_pendiente','Debe $50.00 {monto}')`))).toBe('text_hardcoded_amount');
    expect(await adm((q) => q.fails(`select public.save_template_text('detalle_pendiente','Debe {saldo}')`))).toBe('text_bad_marker');
    expect(await adm((q) => q.fails(`select public.save_template_text('detalle_al_dia','Todo bien {monto}')`))).toBe('text_bad_marker');
    expect(await adm((q) => q.fails(`select public.save_template_text('detalle_pendiente','Hola {{nombre}} {monto}')`))).toBe('text_no_variables');
    expect(await adm((q) => q.fails(`select public.save_template_text('otra','x {monto}')`))).toBe('variable_not_found');
    await adm((q) => q.rows(`select public.reset_template_text('detalle_pendiente')`));
    expect((await vars(x.assignment)).detalle_deuda).toBe('Su saldo pendiente es de $80.00.');
  });
  it('el ejemplo mostrado de una variable también se edita y se restablece', async () => {
    await adm((q) => q.rows(`select public.save_template_variable('unidad','Unidad','Código de la unidad','P-15')`));
    expect((await adm((q) => q.rows(`select example from public.template_variables() where code='unidad'`)))[0].example).toBe('P-15');
    await adm((q) => q.rows(`select public.reset_template_variable('unidad')`));
    expect((await adm((q) => q.rows(`select example from public.template_variables() where code='unidad'`)))[0].example).toBe('4321');
  });
  it('solo ADMIN edita; el supervisor no', async () => {
    expect(await db.as(db.supervisor, (q) => q.fails(`select public.save_template_text('detalle_al_dia','Todo bien')`))).toBe('forbidden');
    expect(await db.as(db.supervisor, (q) => q.fails(`select public.save_template_variable('saldo_total','x','y')`))).toBe('forbidden');
  });
});

describe('comisión de pago ($1.00 Yappy / Punto Pago)', () => {
  const withCommission = async (saldo: number) => { const x = await mk(saldo); await db.su.query(`update public.assignments set collect_commission=true where id=$1`, [x.assignment]); return x; };
  it('por defecto está ACTIVA; suma $1.00 al importe comunicado y a {{detalle_deuda}}', async () => {
    n += 1; const d = await db.driverWithAssignment({ code: `XE${n}`, unit: `XEU${n}`, dailyCents: 3000 });
    expect((await db.su.query(`select collect_commission c from public.assignments where id=$1`, [d.assignment])).rows[0].c).toBe(true);
    const x = await withCommission(5700);                                                                  // 57 + 30 (lunes) = 87 → con comisión 88
    expect(await vars(x.assignment, MON)).toMatchObject({ saldo_total: '$88.00', deuda_anterior: '$57.00', detalle_deuda: 'Su saldo pendiente es de $88.00.' });
  });
  it('sin el check (paga en efectivo) no se cobra; con saldo a favor o al día tampoco', async () => {
    const x = await withCommission(5700);
    await adm((q) => q.rows(`select public.set_assignment_commission($1, false)`, [x.assignment]));
    expect((await vars(x.assignment, MON)).saldo_total).toBe('$87.00');
    await adm((q) => q.rows(`select public.set_assignment_commission($1, true)`, [x.assignment]));
    expect((await vars(x.assignment, MON)).saldo_total).toBe('$88.00');
    const c = await withCommission(0); await pay2(c, MON, 3000);                                          // al día: 0 + 30 − 30
    expect((await vars(c.assignment, MON)).saldo_total).toBe('$0.00');
    const d = await withCommission(0); await pay2(d, MON, 5000);                                          // pagó de más: crédito, sin comisión
    expect(await vars(d.assignment, MON)).toMatchObject({ saldo_total: '$0.00', credito: '$20.00' });
  });
  it('solo ADMIN lo cambia, queda auditado y una unidad inexistente falla', async () => {
    const x = await withCommission(1000);
    expect(await db.as(db.supervisor, (q) => q.fails(`select public.set_assignment_commission($1, false)`, [x.assignment]))).toBe('forbidden');
    expect(await adm((q) => q.fails(`select public.set_assignment_commission('00000000-0000-0000-0000-000000000000', false)`))).toBe('assignment_not_found');
    await adm((q) => q.rows(`select public.set_assignment_commission($1, false)`, [x.assignment]));
    expect((await db.su.query(`select count(*)::int n from public.audit_logs where action='assignment.commission' and entity_id=$1`, [x.assignment])).rows[0].n).toBe(1);
  });
});
const pay2 = async (x: { assignment: string; driver: string }, date: string, cents: number) => {
  const pid = (await db.su.query(`insert into public.payments(assignment_id, method_id, gross_cents, net_cents, applied_cents, week_start, registered_by, idempotency_key, paid_at)
    values ($1, (select id from public.payment_methods where code='excel'), $2, $2, $2, '2026-11-23', $4, $3, $5::timestamptz) returning id`, [x.assignment, cents, `ev3-${Math.random()}-${date}`, db.admin, `${date}T15:00:00Z`])).rows[0].id;
  await db.su.query(`insert into public.excel_payment_days(assignment_id, pay_date, week_start, driver_id, amount_cents, payment_id) values ($1,$2,'2026-11-23',$3,$4,$5)`, [x.assignment, date, x.driver, cents, pid]);
};

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BASE_TPL, ensureBaseTemplates, MON, MON2, addDays, chargeWeek, key, pay } from './fixtures.js';
import { newDb, type Db, type Q } from './harness.js';

let db: Db;
let n = 0;
beforeAll(async () => { db = await newDb(); });
afterAll(async () => { await db.close(); });

// Horas locales de Panamá (UTC−5, sin horario de verano) como instantes UTC
const at = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00-05:00`).toISOString();
const TUE = addDays(MON, 1); const SUN = addDays(MON, 6);

const setSchedules = async (enabled: string[] = ['debt_first', 'debt_update', 'debt_last', 'weekly_summary'], scope = 'total') => {
  await ensureBaseTemplates(db);
  await db.su.query(`update public.notification_schedules set enabled = (kind = any($1)), scope = $2, template_id = ${BASE_TPL}`, [enabled, scope]);
  await db.su.query(`update public.app_settings set max_per_driver_per_day = 3, min_minutes_between = 60`);
};
/** Conductor autorizado con cargo(s) directo(s) en las fechas indicadas. */
async function driver(charges: string[], opts: { consent?: boolean; rate?: number } = {}) {
  n += 1;
  const x = await db.driverWithAssignment({ code: `R${n}`, unit: `RU${n}`, dailyCents: opts.rate ?? 3600, phone: `+507601${String(10000 + n)}`, consent: opts.consent ?? true });
  for (const d of charges) await db.su.query(`insert into public.charges(assignment_id, kind, charge_date, amount_cents, week_start) values ($1,'daily',$2,$3,app_private.week_start_of($2::date))`, [x.assignment, d, opts.rate ?? 3600]);
  return x;
}
const svc = <T>(fn: (q: Q) => Promise<T>) => db.asService(fn);
interface Out { kind: string; driver: string; action: string; reason?: string; body?: string; status: string }
/** Un ciclo del worker: programa, reclama, prepara (verificación) y completa como enviado en modo de prueba. */
async function tick(now: string, onlyDriver?: string): Promise<Out[]> {
  return svc(async (q) => {
    await q.query(`select public.schedule_reminders($1)`, [now]);
    const jobs = await q.rows(`select * from public.claim_notification_jobs(50, $1) ${onlyDriver ? 'where driver_id = ' + `'${onlyDriver}'` : ''}`, [now]);
    const out: Out[] = [];
    for (const j of jobs) {
      const p = (await q.one(`select public.prepare_notification_send($1, $2) p`, [j.id, now])).p;
      if (p.action === 'send') await q.query(`select public.complete_notification($1,'sent',null,true,$2,$3)`, [j.id, p.body, now]);
      out.push({ kind: j.kind, driver: j.driver_id, action: p.action, reason: p.reason, body: p.body, status: (await q.one(`select status from public.notification_jobs where id=$1`, [j.id])).status });
    }
    return out;
  });
}
const mine = (o: Out[], d: { driver: string }) => o.filter((x) => x.driver === d.driver);
const adm = <T>(fn: (q: Q) => Promise<T>) => db.as(db.admin, fn);

describe('suspensión de recordatorios al pagar', () => {
  it('pago completo tras el primer recordatorio: los siguientes se omiten', async () => {
    await setSchedules();
    const x = await driver([MON]);
    const r1 = mine(await tick(at(MON, '11:05')), x);
    expect(r1).toHaveLength(1); expect(r1[0]).toMatchObject({ action: 'send', status: 'sent' });
    expect(r1[0]!.body).toContain('$36.00');
    await adm((q) => pay(q, x.assignment, 'cash', 3600, { paidAt: at(MON, '14:00') }));
    const r2 = mine(await tick(at(MON, '17:05')), x);
    expect(r2).toEqual([expect.objectContaining({ action: 'skip', reason: 'skipped_paid', status: 'skipped_paid' })]);
    const r3 = mine(await tick(at(MON, '21:05')), x);
    expect(r3).toEqual([expect.objectContaining({ action: 'skip', reason: 'skipped_paid' })]);
    expect((await db.su.query(`select count(*)::int n from public.notification_jobs where driver_id=$1 and status='sent'`, [x.driver])).rows[0].n).toBe(1);
  });
  it('al registrar el pago, los recordatorios pendientes se cancelan de inmediato (sin esperar al worker)', async () => {
    await setSchedules(['debt_update']);
    const x = await driver([MON]);
    await svc((q) => q.query(`select public.schedule_reminders($1)`, [at(MON, '17:05')]));
    const st = async () => (await db.su.query(`select status from public.notification_jobs where driver_id=$1`, [x.driver])).rows.map((r) => r.status);
    expect(await st()).toEqual(['pending']);
    await adm((q) => pay(q, x.assignment, 'yappy', 3700, { paidAt: at(MON, '16:00') }));
    expect(await st()).toEqual(['skipped_paid']);
  });
  it('pago parcial: el siguiente mensaje usa el saldo actualizado', async () => {
    await setSchedules();
    const x = await driver([MON]);
    expect(mine(await tick(at(MON, '11:05')), x)[0]!.body).toContain('$36.00');
    await adm((q) => pay(q, x.assignment, 'cash', 2000, { paidAt: at(MON, '14:00') }));
    expect(mine(await tick(at(MON, '17:05')), x)[0]!.body).toContain('$16.00');
    await adm((q) => pay(q, x.assignment, 'yappy', 600, { paidAt: at(MON, '19:00') }));     // neto 5 → quedan 11
    expect(mine(await tick(at(MON, '21:05')), x)[0]!.body).toContain('$11.00');
  });
  it('solo crédito → no se reclama deuda (skipped_credit)', async () => {
    await setSchedules(['debt_first']);
    const x = await driver([MON]);
    await adm((q) => pay(q, x.assignment, 'cash', 5000, { paidAt: at(MON, '09:00') }));
    expect(mine(await tick(at(MON, '11:05')), x)[0]).toMatchObject({ action: 'skip', reason: 'skipped_credit' });
  });
});

describe('cuota de hoy vs deuda anterior vs total', () => {
  it('el mensaje muestra los tres conceptos por separado', async () => {
    await setSchedules(['debt_first']);
    const x = await driver([MON, TUE]);
    const dues = await adm((q) => q.one(`select * from public.assignment_dues($1,$2)`, [x.assignment, TUE]));
    expect(dues).toMatchObject({ today_cents: '3600', overdue_cents: '3600', total_pending_cents: '7200' });
    expect(mine(await tick(at(TUE, '11:05')), x)[0]!.body).toContain('Tiene cuotas atrasadas de esta semana por $36.00 y una cuota pendiente de hoy de $36.00. Su saldo total pendiente es de $72.00.');
  });
  it('un pago de $36 con deuda anterior cubre primero lo más antiguo: queda la cuota de hoy', async () => {
    await setSchedules(['debt_update']);
    const x = await driver([MON, TUE]);
    await adm((q) => pay(q, x.assignment, 'cash', 3600, { paidAt: at(TUE, '12:00') }));
    expect(await adm((q) => q.one(`select today_cents::int t, overdue_cents::int o from public.assignment_dues($1,$2)`, [x.assignment, TUE]))).toEqual({ t: 3600, o: 0 });
    expect(mine(await tick(at(TUE, '17:05')), x)[0]!.body).toContain('Hemos registrado un abono de $36.00. Su saldo pendiente de hoy es de $36.00.');
  });
  it('el alcance "deuda anterior" solo cobra si hay deuda de días previos', async () => {
    await setSchedules(['debt_first'], 'overdue');
    const x = await driver([MON, TUE]);            // deuda anterior (lunes) + cuota de hoy
    const y = await driver([TUE]);                 // solo la cuota de hoy: nada vencido
    const out = await tick(at(TUE, '11:05'));
    expect(mine(out, x)[0]).toMatchObject({ action: 'send' });
    expect(mine(out, x)[0]!.body).toContain('cuotas atrasadas de esta semana');
    expect(mine(out, y)[0]).toMatchObject({ action: 'skip', reason: 'skipped_paid' });
  });
  it('la vista previa incluye las variables semanales {{cuenta_semana}} y {{pagos_semana}}', async () => {
    const x = await driver([MON, TUE]);
    await adm((q) => pay(q, x.assignment, 'cash', 3600, { paidAt: at(TUE, '12:00') }));
    const t = (await adm((q) => q.one(`select public.preview_template($1, 'Semana {{cuenta_semana}} / pagado {{pagos_semana}}', $2::date) t`, [x.assignment, TUE]))).t.text;
    expect(t).toBe('Semana $72.00 / pagado $36.00');
  });
  it('plantillas con variables y vista previa con datos reales', async () => {
    await setSchedules(['debt_first']);
    await db.su.query(`insert into public.message_templates(name, body) values ('plantilla-prueba', 'Hola {{nombre}}, unidad {{unidad}}: debes {{saldo_total}} ({{detalle_deuda}}) al {{fecha}}.')`);
    await db.su.query(`update public.notification_schedules set template_id = (select id from public.message_templates where name='plantilla-prueba') where kind='debt_first'`);
    const x = await driver([MON]);
    const prev = (await adm((q) => q.one(`select public.preview_template($1, 'Hola {{nombre}}, {{saldo_total}}', $2::date) t`, [x.assignment, MON]))).t.text;
    expect(prev).toBe(`Hola Conductor, $36.00`);
    expect(mine(await tick(at(MON, '11:05')), x)[0]!.body).toBe(`Hola Conductor, unidad RU${n}: debes $36.00 (Su cuota pendiente de hoy es de $36.00.) al lunes 2 de marzo de 2026.`);
  });
});

describe('domingo', () => {
  it('pago del domingo y resumen semanal con la cuenta al día', async () => {
    await setSchedules(['weekly_summary']);
    const x = await driver([0, 1, 2, 3, 4, 5].map((i) => addDays(MON, i)));
    await adm((q) => pay(q, x.assignment, 'cash', 18000, { paidAt: at(addDays(MON, 5), '18:00') }));
    await adm((q) => pay(q, x.assignment, 'cash', 3600, { paidAt: at(SUN, '08:00') }));     // pago de domingo para cerrar la semana
    const o = mine(await tick(at(SUN, '09:05')), x)[0]!;
    expect(o).toMatchObject({ action: 'send', kind: 'weekly_summary' });
    expect(o.body).toContain('Cuenta semanal: $216.00'); expect(o.body).toContain('Pagos recibidos: $216.00'); expect(o.body).toContain('Su cuenta está al día.');
  });
  it('el resumen dominical muestra la deuda pendiente cuando no pagó', async () => {
    await setSchedules(['weekly_summary']);
    const x = await driver([0, 1, 2, 3, 4, 5].map((i) => addDays(MON, i)));
    await adm((q) => pay(q, x.assignment, 'cash', 18000, { paidAt: at(addDays(MON, 5), '18:00') }));
    expect(mine(await tick(at(SUN, '09:05')), x)[0]!.body).toContain('Tiene un saldo pendiente de $36.00 correspondiente a cuotas anteriores.');
  });
});

describe('autorización, pausa y frecuencia', () => {
  it('sin consentimiento, sin teléfono, pausado o inactivo: NO se programa ningún envío', async () => {
    await setSchedules(['debt_first']);
    const a = await driver([MON], { consent: false });
    const b = await driver([MON]); await db.su.query(`update public.drivers set reminders_paused=true, reminders_paused_reason='acuerdo' where id=$1`, [b.driver]);
    const c = await driver([MON]); await db.su.query(`update public.drivers set status='suspended' where id=$1`, [c.driver]);
    const d = await driver([MON]);
    const out = await tick(at(MON, '11:05'));
    expect(mine(out, a)).toEqual([]); expect(mine(out, b)).toEqual([]); expect(mine(out, c)).toEqual([]); expect(mine(out, d)).toHaveLength(1);
  });
  it('si se pausa o se retira el consentimiento DESPUÉS de crear el trabajo, el envío se omite', async () => {
    await setSchedules(['debt_first']);
    const a = await driver([MON]); const b = await driver([MON]);
    await svc((q) => q.query(`select public.schedule_reminders($1)`, [at(MON, '11:05')]));
    await db.su.query(`update public.drivers set reminders_paused=true where id=$1`, [a.driver]);
    await db.su.query(`update public.drivers set whatsapp_consent=false where id=$1`, [b.driver]);
    const out = await tick(at(MON, '11:06'));
    expect(mine(out, a)[0]).toMatchObject({ action: 'skip', reason: 'skipped_paused' });
    expect(mine(out, b)[0]).toMatchObject({ action: 'skip', reason: 'skipped_no_consent' });
  });
  it('límite diario y separación mínima entre mensajes', async () => {
    await setSchedules(['debt_first', 'debt_update', 'debt_last']);
    await db.su.query(`update public.app_settings set max_per_driver_per_day = 1`);
    const x = await driver([MON]);
    expect(mine(await tick(at(MON, '11:05')), x)[0]).toMatchObject({ action: 'send' });
    expect(mine(await tick(at(MON, '17:05')), x)[0]).toMatchObject({ action: 'skip', reason: 'skipped_frequency' });
    await db.su.query(`update public.app_settings set max_per_driver_per_day = 3, min_minutes_between = 600`);
    const y = await driver([MON]);
    await tick(at(MON, '11:05'), y.driver);
    expect(mine(await tick(at(MON, '17:05')), y)[0]).toMatchObject({ action: 'skip', reason: 'skipped_frequency' });
    await db.su.query(`update public.app_settings set min_minutes_between = 60`);
  });
});

describe('prevención de envíos duplicados y concurrencia', () => {
  it('un horario crea un solo trabajo por conductor y día, aunque se programe muchas veces', async () => {
    await setSchedules(['debt_first']);
    const x = await driver([MON]);
    const runs = await Promise.all(Array.from({ length: 5 }, () => svc((q) => q.one(`select public.schedule_reminders($1) n`, [at(MON, '11:05')]))));
    expect(runs.reduce((a, r) => a + r.n, 0)).toBeGreaterThanOrEqual(1);
    expect((await db.su.query(`select count(*)::int n from public.notification_jobs where driver_id=$1 and kind='debt_first'`, [x.driver])).rows[0].n).toBe(1);
  });
  it('dos procesadores concurrentes nunca reclaman el mismo trabajo', async () => {
    await setSchedules(['debt_first']);
    await db.su.query(`update public.notification_jobs set status='cancelled' where status='pending'`);
    for (let i = 0; i < 20; i++) await driver([MON]);
    await svc((q) => q.query(`select public.schedule_reminders($1)`, [at(MON, '11:10')]));
    const claim = () => svc((q) => q.rows(`select id from public.claim_notification_jobs(10, $1)`, [at(MON, '11:10')]));
    const [a, b] = await Promise.all([claim(), claim()]);
    const ids = [...a, ...b].map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThanOrEqual(20);
  });
  it('pago y envío concurrentes: si el worker está preparando, el pago espera; el siguiente envío ya ve el saldo en cero', async () => {
    await setSchedules(['debt_first', 'debt_update']);
    const x = await driver([MON]);
    await svc((q) => q.query(`select public.schedule_reminders($1)`, [at(MON, '11:05')]));
    const w = await db.open();
    try {
      await w.query('begin'); await w.query('set local role service_role');
      await w.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', true)`);
      const job = (await w.query(`select * from public.claim_notification_jobs(5, $1) where driver_id=$2`, [at(MON, '11:05'), x.driver])).rows[0];
      const prep = (await w.query(`select public.prepare_notification_send($1,$2) p`, [job.id, at(MON, '11:05')])).rows[0].p;
      expect(prep).toMatchObject({ action: 'send' }); expect(prep.body).toContain('$36.00');
      // el pago intenta registrarse mientras el worker sostiene el bloqueo de la asignación
      let paid = false;
      const payment = adm((q) => pay(q, x.assignment, 'cash', 3600, { paidAt: at(MON, '11:04') })).then((r) => { paid = true; return r; });
      await new Promise((r) => setTimeout(r, 500));
      expect(paid).toBe(false);                                                    // serializado: espera al envío en curso
      await w.query(`select public.complete_notification($1,'sent',null,true,$2,$3)`, [job.id, prep.body, at(MON, '11:05')]);
      await w.query('commit');
      expect((await payment).pending_cents).toBe(0);
    } finally { await w.end(); }
    const next = mine(await tick(at(MON, '17:05')), x)[0]!;
    expect(next).toMatchObject({ action: 'skip', reason: 'skipped_paid' });
  });
  it('verificación final: si el pago llega antes del envío, el worker lo detecta al volver a verificar', async () => {
    await setSchedules(['debt_first']);
    const x = await driver([MON]);
    await svc((q) => q.query(`select public.schedule_reminders($1)`, [at(MON, '11:05')]));
    const job = (await svc((q) => q.rows(`select * from public.claim_notification_jobs(5, $1)`, [at(MON, '11:05')]))).find((j: { driver_id: string }) => j.driver_id === x.driver);
    const first = (await svc((q) => q.one(`select public.prepare_notification_send($1,$2) p`, [job.id, at(MON, '11:05')]))).p;
    expect(first.action).toBe('send');
    await adm((q) => pay(q, x.assignment, 'cash', 3600, { paidAt: at(MON, '11:04') }));              // llega el pago antes de enviar
    const final = (await svc((q) => q.one(`select public.prepare_notification_send($1,$2) p`, [job.id, at(MON, '11:05')]))).p;
    expect(final).toMatchObject({ action: 'skip', reason: 'skipped_paid' });
  });
  it('dos envíos simultáneos del mismo conductor: el de menor id va primero y el otro se difiere', async () => {
    await setSchedules(['debt_first']);
    const x = await driver([MON]);
    const p = await adm((q) => pay(q, x.assignment, 'yappy', 1100, { receipt: true, paidAt: at(MON, '10:00') }));
    await db.su.query(`update public.notification_jobs set scheduled_for = $2 where id = $1`, [p.receipt_job_id, at(MON, '10:00')]);
    await svc((q) => q.query(`select public.schedule_reminders($1)`, [at(MON, '11:05')]));
    const jobs = (await svc((q) => q.rows(`select * from public.claim_notification_jobs(50, $1)`, [at(MON, '11:05')]))).filter((j: { driver_id: string }) => j.driver_id === x.driver)
      .sort((a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id));
    expect(jobs).toHaveLength(2);
    const res = await svc(async (q) => [(await q.one(`select public.prepare_notification_send($1,$2) p`, [jobs[0].id, at(MON, '11:05')])).p, (await q.one(`select public.prepare_notification_send($1,$2) p`, [jobs[1].id, at(MON, '11:05')])).p]);
    expect(res[0].action).toBe('send'); expect(res[1].action).toBe('defer');
    expect(p.receipt_job_id).toBeTruthy();
  });
});

describe('períodos y cierre de cobranza', () => {
  it('resumen semanal con deudas y créditos: esperado, bruto, comisión, neto, recuperado, pendiente, crédito, diferencia y %', async () => {
    const a = await driver([0, 1, 2, 3, 4, 5].map((i) => addDays(MON2, i)));     // semana 2: 216 esperados
    const b = await driver([0, 1, 2, 3, 4, 5].map((i) => addDays(MON, i)).concat([0, 1, 2, 3, 4, 5].map((i) => addDays(MON2, i))));
    await adm((q) => pay(q, a.assignment, 'yappy', 22100, { paidAt: at(MON2, '10:00') }));   // neto 220 → crédito 4
    await adm((q) => pay(q, b.assignment, 'cash', 10000, { paidAt: at(addDays(MON2, 1), '10:00') }));   // paga deuda de la semana 1 (recupera)
    const s = (await adm((q) => q.one(`select public.period_summary($1::date,$2::date) s`, [MON2, addDays(MON2, 6)]))).s;
    expect(s).toMatchObject({ commission_cents: 100 });
    const base = (await adm((q) => q.one(`select public.period_summary($1::date,$2::date) s`, [MON2, addDays(MON2, 6)]))).s;
    expect(base.net_cents).toBe(base.gross_cents - base.commission_cents);
    expect(base.difference_cents).toBe(base.net_cents - base.expected_cents);
    expect(base.prior_debt_recovered_cents).toBeGreaterThanOrEqual(10000);          // deuda anterior recuperada, separada
    expect(base.credits_generated_cents).toBeGreaterThanOrEqual(400);
    expect(base.credits_end_cents).toBeGreaterThanOrEqual(400);
    expect(base.recovery_pct).toBe(Math.round(base.net_cents * 1000 / base.expected_cents) / 10);
  });
  it('cada indicador se puede abrir y sus movimientos suman el indicador', async () => {
    const f = MON2, t = addDays(MON2, 6);
    const s = (await adm((q) => q.one(`select public.period_summary($1::date,$2::date) s`, [f, t]))).s;
    const sum = async (ind: string) => (await adm((q) => q.rows(`select amount_cents from public.period_detail($1::date,$2::date,$3)`, [f, t, ind]))).reduce((acc, r) => acc + Number(r.amount_cents), 0);
    expect(await sum('charges')).toBe(s.expected_cents + s.adjustments_charged_cents);
    expect(await sum('gross')).toBe(s.gross_cents); expect(await sum('commission')).toBe(s.commission_cents); expect(await sum('net')).toBe(s.net_cents);
    expect(await sum('prior_debt_recovered')).toBe(s.prior_debt_recovered_cents);
    expect(await sum('pending')).toBe(s.pending_end_cents); expect(await sum('credits')).toBe(s.credits_end_cents);
    expect(await adm((q) => q.fails(`select * from public.period_detail($1::date,$2::date,'inventado')`, [f, t]))).toBe('invalid_indicator');
  });
  it('serie semanal para comparar períodos y rangos inválidos', async () => {
    const rows = await adm((q) => q.rows(`select week_start::text w from public.period_series($1::date,$2::date)`, [MON, addDays(MON2, 6)]));
    expect(rows.map((r) => r.w)).toEqual([MON, MON2]);
    expect(await adm((q) => q.fails(`select public.period_summary('2026-03-09','2026-03-02')`))).toBe('invalid_range');
  });
});

describe('unidades, asignaciones y tarifas', () => {
  const asg = (id: string) => db.su.query(`select charge_date::text d, amount_cents::int a from public.charges where assignment_id=$1 order by 1`, [id]).then((r) => r.rows);
  it('cambio de tarifa: no modifica retroactivamente las obligaciones ya generadas', async () => {
    const x = await driver([]);
    for (let i = 0; i < 3; i++) await adm((q) => q.query(`select public.generate_daily_charges($1::date)`, [addDays(MON, i)]));     // lun-mié a 36
    expect(await adm((q) => q.fails(`select public.change_rate($1, 4000, $2::date)`, [x.assignment, addDays(MON, 2)]))).toBe('rate_change_retroactive');   // el miércoles ya generado: no se reescribe
    const ch = await adm((q) => q.one(`select public.change_rate($1, 4000, $2::date, 'ajuste') r`, [x.assignment, addDays(MON, 3)]));
    expect(ch.r.existing_charges_from_date_unchanged).toBe(0);
    for (let i = 3; i < 6; i++) await adm((q) => q.query(`select public.generate_daily_charges($1::date)`, [addDays(MON, i)]));
    expect((await asg(x.assignment)).map((c) => c.a)).toEqual([3600, 3600, 3600, 4000, 4000, 4000]);
    expect(await adm((q) => q.fails(`select public.change_rate($1, 100, $2::date)`, [x.assignment, MON]))).toBe('invalid_dates');
    expect(await adm((q) => q.fails(`select public.change_rate($1, -1, $2::date)`, [x.assignment, addDays(MON, 4)]))).toBe('invalid_amount');
  });
  it('nueva unidad a mitad de semana: solo genera cuotas desde su fecha de inicio', async () => {
    n += 1;
    const dr = (await db.su.query(`insert into public.drivers(operator_code, national_id, first_name) values ($1,$1,'Nuevo') returning id`, [`NM${n}`])).rows[0].id;
    const un = (await db.su.query(`insert into public.units(code) values ($1) returning id`, [`NU${n}`])).rows[0].id;
    const id = await adm((q) => q.one(`select public.start_assignment($1,$2,$3::date,3600,'acuerdo especial') id`, [dr, un, addDays(MON, 2)]));
    await chargeWeek(db, MON);
    expect((await asg(id.id)).map((c) => c.d)).toEqual([2, 3, 4, 5].map((i) => addDays(MON, i)));
    expect(await adm((q) => q.fails(`select public.start_assignment($1,$2,$3::date)`, [dr, un, addDays(MON, 3)]))).toBe('assignment_overlap');
  });
  it('cambiar el conductor de una unidad cierra la asignación anterior y no solapa; el historial se conserva', async () => {
    const a = await driver([]);
    n += 1;
    const b = (await db.su.query(`insert into public.drivers(operator_code, national_id, first_name) values ($1,$1,'Relevo') returning id`, [`RV${n}`])).rows[0].id;
    const newAsg = (await adm((q) => q.one(`select public.reassign_unit($1,$2,$3::date,4200) id`, [a.unit, b, addDays(MON, 3)]))).id;
    const hist = (await db.su.query(`select driver_id, valid_from::text f, valid_to::text t from public.assignments where unit_id=$1 order by valid_from`, [a.unit])).rows;
    expect(hist).toEqual([{ driver_id: a.driver, f: '2026-01-01', t: addDays(MON, 2) }, { driver_id: b, f: addDays(MON, 3), t: null }]);
    await chargeWeek(db, MON);
    expect((await asg(a.assignment)).map((c) => c.d)).toEqual([0, 1, 2].map((i) => addDays(MON, i)));
    expect((await asg(newAsg)).map((c) => c.a)).toEqual([4200, 4200, 4200]);
    const other = await driver([]);                // otra unidad con su conductor: el relevo ya tiene unidad
    // 0028: un operario puede tener varias unidades (como permite el Excel): el relevo se acepta y queda con dos asignaciones vigentes
    expect((await adm((q) => q.one(`select public.reassign_unit($1,$2,$3::date) id`, [other.unit, b, addDays(MON, 20)]))).id).toBeTruthy();
    expect(Number((await db.su.query(`select count(*) n from public.assignments where driver_id=$1 and valid_to is null`, [b])).rows[0].n)).toBe(2);
  });
  it('suspender una unidad o terminar una asignación detiene las cuotas sin tocar las anteriores', async () => {
    const x = await driver([]);
    await adm((q) => q.query(`select public.generate_daily_charges($1::date)`, [MON]));
    await db.su.query(`update public.units set vehicle_status='maintenance' where id=$1`, [x.unit]);
    await adm((q) => q.query(`select public.generate_daily_charges($1::date)`, [TUE]));
    expect((await asg(x.assignment)).map((c) => c.d)).toEqual([MON]);
    await db.su.query(`update public.units set vehicle_status='active' where id=$1`, [x.unit]);
    await adm((q) => q.query(`select public.end_assignment($1,$2::date)`, [x.assignment, TUE]));
    await adm((q) => q.query(`select public.generate_daily_charges($1::date)`, [addDays(MON, 2)]));
    expect((await asg(x.assignment)).map((c) => c.d)).toEqual([MON]);
    expect(await adm((q) => q.fails(`select public.end_assignment($1,$2::date)`, [x.assignment, TUE]))).toBe('assignment_already_ended');
  });
  it('un usuario no autorizado no puede operar unidades ni tarifas', async () => {
    const x = await driver([]);
    const e = await db.as(db.outsider, async (q) => [await q.fails(`select public.change_rate($1,100,'2026-12-01')`, [x.assignment]), await q.fails(`select public.end_assignment($1,'2026-12-01')`, [x.assignment])]);
    expect(e).toEqual(['forbidden', 'forbidden']);
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BASE_TPL, ensureBaseTemplates, MON, addDays, pay } from './fixtures.js';
import { newDb, type Db, type Q } from './harness.js';

let db: Db;
let n = 0;
beforeAll(async () => { db = await newDb(); });
afterAll(async () => { await db.close(); });

// MON = lunes 2 de marzo de 2026. Horas locales de Panamá (UTC−5) como instantes UTC.
const at = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00-05:00`).toISOString();
const TUE = addDays(MON, 1); const WED = addDays(MON, 2); const SAT = addDays(MON, 5); const SUN = addDays(MON, 6);
const MON2 = addDays(MON, 7); const PREV_FRI = addDays(MON, -3);
const adm = <T>(fn: (q: Q) => Promise<T>) => db.as(db.admin, fn);
const svc = <T>(fn: (q: Q) => Promise<T>) => db.asService(fn);

interface Opts { first?: string; last?: string; op?: string; unit?: string; rate?: number }
/** Conductor con consentimiento y cargos directos: charges = [[fecha, centavos]]. */
async function mk(charges: [string, number][] = [], o: Opts = {}) {
  n += 1;
  const x = await db.driverWithAssignment({ code: o.op ?? `V${n}`, unit: o.unit ?? `VU${n}`, dailyCents: o.rate ?? 4000, phone: `+507602${String(10000 + n)}`, consent: true });
  await db.su.query(`update public.drivers set first_name=$2, last_name=$3 where id=$1`, [x.driver, o.first ?? 'Vanessa', o.last ?? 'Ejemplo']);
  for (const [d, c] of charges)
    await db.su.query(`insert into public.charges(assignment_id, kind, charge_date, amount_cents, week_start) values ($1,'daily',$2,$3,app_private.week_start_of($2::date))`, [x.assignment, d, c]);
  return x;
}
const vars = async (a: string, date: string): Promise<Record<string, string | null>> =>
  (await db.su.query(`select app_private.template_vars($1,$2::date) v`, [a, date])).rows[0].v;
const detail = async (a: string, date: string) => (await vars(a, date))['detalle_deuda'];
const preview = async (a: string, body: string, date: string) =>
  (await adm((q) => q.one(`select public.preview_template($1,$2,$3::date) t`, [a, body, date]))).t as { text: string; unresolved: string[] };

const setSchedules = async (enabled: string[], scope = 'total') => {
  await ensureBaseTemplates(db);
  await db.su.query(`update public.notification_schedules set enabled = (kind = any($1)), scope = $2, template_id = ${BASE_TPL}`, [enabled, scope]);
  await db.su.query(`update public.app_settings set max_per_driver_per_day = 10, min_minutes_between = 0`);
};
interface Out { driver: string; action: string; reason?: string; body?: string; status: string; error: string | null }
async function tick(now: string): Promise<Out[]> {
  return svc(async (q) => {
    await q.query(`select public.schedule_reminders($1)`, [now]);
    const jobs = await q.rows(`select * from public.claim_notification_jobs(50, $1)`, [now]);
    const out: Out[] = [];
    for (const j of jobs) {
      const p = (await q.one(`select public.prepare_notification_send($1, $2) p`, [j.id, now])).p;
      if (p.action === 'send') await q.query(`select public.complete_notification($1,'sent',null,true,$2,$3)`, [j.id, p.body, now]);
      const r = await q.one(`select status, error from public.notification_jobs where id=$1`, [j.id]);
      out.push({ driver: j.driver_id, action: p.action, reason: p.reason, body: p.body, status: r.status, error: r.error });
    }
    return out;
  });
}
const mine = (o: Out[], d: { driver: string }) => o.filter((x) => x.driver === d.driver);

describe('datos del conductor, unidad y operario', () => {
  it('nombre, apellido, nombre completo, unidad y operario', async () => {
    const x = await mk([], { op: '1234', unit: '4321' });
    expect(await vars(x.assignment, MON)).toMatchObject({ nombre: 'Vanessa', apellido: 'Ejemplo', nombre_completo: 'Vanessa Ejemplo', unidad: '4321', codigo_operario: '1234' });
    expect((await preview(x.assignment, '{{nombre}}|{{apellido}}|{{nombre_completo}}|{{unidad}}|{{codigo_operario}}', MON)).text).toBe('Vanessa|Ejemplo|Vanessa Ejemplo|4321|1234');
  });
  it('apellido vacío: nombre completo sin espacios de más y apellido sin resolver', async () => {
    const x = await mk([], { last: '' });
    expect((await vars(x.assignment, MON))['nombre_completo']).toBe('Vanessa');
    const p = await preview(x.assignment, 'Hola {{nombre_completo}}.', MON);
    expect(p).toEqual({ text: 'Hola Vanessa.', unresolved: [] });
    expect(await preview(x.assignment, 'A {{apellido}}', MON)).toEqual({ text: 'A ', unresolved: ['apellido'] });
    const y = await mk([], { first: ' Ana  María ', last: '  ' });
    expect((await vars(y.assignment, MON))['nombre_completo']).toBe('Ana María');
  });
  it('variables con espacios internos dentro de las llaves se resuelven', async () => {
    const x = await mk();
    expect((await preview(x.assignment, '{{ nombre }} {{unidad  }}', MON)).text).toBe(`Vanessa VU${n}`);
  });
});

describe('fecha completa en español', () => {
  it.each([
    ['2026-11-16', 'lunes 16 de noviembre de 2026'], ['2026-11-22', 'domingo 22 de noviembre de 2026'], ['2026-01-01', 'jueves 1 de enero de 2026'],
    ['2026-03-04', 'miércoles 4 de marzo de 2026'], ['2026-02-14', 'sábado 14 de febrero de 2026'], ['2026-05-08', 'viernes 8 de mayo de 2026'],
    ['2026-10-06', 'martes 6 de octubre de 2026'], ['2026-12-31', 'jueves 31 de diciembre de 2026'],
  ])('%s → %s', async (d, txt) => {
    expect((await db.su.query(`select app_private.fecha_es($1::date) f`, [d])).rows[0].f).toBe(txt);
  });
  it('{{fecha}} usa la fecha del envío y no el formato numérico', async () => {
    const x = await mk();
    const f = (await vars(x.assignment, '2026-11-16'))['fecha'];
    expect(f).toBe('lunes 16 de noviembre de 2026'); expect(f).not.toMatch(/\d{2}\/\d{2}/);
  });
});

describe('importes: cuota, pendiente, anterior, semanal, total, crédito', () => {
  it('cuota diaria de hoy y pendiente de hoy; domingo sin cuota', async () => {
    const x = await mk([[MON, 4000], [TUE, 4000]]);
    expect(await vars(x.assignment, TUE)).toMatchObject({ cuota_hoy: '$40.00', pendiente_hoy: '$40.00' });
    expect(await vars(x.assignment, SUN)).toMatchObject({ cuota_hoy: '$0.00', pendiente_hoy: '$0.00' });
  });
  it('pago parcial: abono NETO (la comisión Yappy de $1 no cuenta)', async () => {
    const x = await mk([[MON, 4000]]);
    await adm((q) => pay(q, x.assignment, 'yappy', 2600, { paidAt: at(MON, '13:00') }));        // bruto 26 − comisión 1 = neto 25
    expect(await vars(x.assignment, MON)).toMatchObject({ pendiente_hoy: '$15.00', pagos_semana: '$25.00' });
    expect(await detail(x.assignment, MON)).toBe('Hemos registrado un abono de $25.00. Su saldo pendiente de hoy es de $15.00.');
  });
  it('deuda anterior (semana previa) y apertura; saldo_total = anterior + semanal sin duplicar y coincide con la posición', async () => {
    const x = await mk([[PREV_FRI, 2000], [MON2, 4000]]);
    const v = await vars(x.assignment, MON2);
    expect(v).toMatchObject({ deuda_anterior: '$20.00', deuda_semanal: '$40.00', saldo_total: '$60.00', pendiente_hoy: '$40.00' });
    const dues = await adm((q) => q.one(`select total_pending_cents::int t from public.assignment_dues($1,$2)`, [x.assignment, MON2]));
    const pos = await adm((q) => q.one(`select pending_cents::int p from public.assignment_position($1)`, [x.assignment]));
    expect(dues.t).toBe(6000); expect(pos.p).toBe(6000);
    // apertura (SALDO, fechada el domingo) = deuda anterior, también el mismo domingo
    const y = await mk([[MON2, 4000]]);
    await db.su.query(`insert into public.charges(assignment_id, kind, charge_date, amount_cents, week_start) values ($1,'opening',$2,1500,app_private.week_start_of($2::date))`, [y.assignment, SUN]);
    expect(await vars(y.assignment, MON2)).toMatchObject({ deuda_anterior: '$15.00', deuda_semanal: '$40.00', saldo_total: '$55.00' });
    expect(await vars(y.assignment, SUN)).toMatchObject({ deuda_anterior: '$15.00', deuda_semanal: '$0.00', saldo_total: '$15.00', cuota_hoy: '$0.00' });
  });
  it('deuda semanal: cuotas de la semana actual hasta hoy; no incluye la anterior', async () => {
    const x = await mk([[PREV_FRI, 2000], [MON, 4000], [TUE, 4000], [WED, 4000]]);
    expect(await vars(x.assignment, WED)).toMatchObject({ deuda_anterior: '$20.00', deuda_semanal: '$120.00', saldo_total: '$140.00' });
    await adm((q) => pay(q, x.assignment, 'cash', 3000, { paidAt: at(WED, '09:00') }));         // FIFO: cubre la anterior ($20) y $10 del lunes
    expect(await vars(x.assignment, WED)).toMatchObject({ deuda_anterior: '$0.00', deuda_semanal: '$110.00', saldo_total: '$110.00' });
  });
  it('crédito a favor y cuenta al día', async () => {
    const x = await mk([[MON, 4000]]);
    await adm((q) => pay(q, x.assignment, 'cash', 5000, { paidAt: at(MON, '09:00') }));
    expect(await vars(x.assignment, MON)).toMatchObject({ credito: '$10.00', saldo_total: '$0.00' });
    const y = await mk([[MON, 4000]]);
    await adm((q) => pay(q, y.assignment, 'cash', 4000, { paidAt: at(MON, '09:00') }));
    expect(await vars(y.assignment, MON)).toMatchObject({ credito: '$0.00', saldo_total: '$0.00' });
  });
  it('cuenta_semanal PREVISTA con cambio de tarifa a mitad de semana (≠ cuotas generadas)', async () => {
    const x = await mk([[MON, 4000]], { rate: 4000 });
    await adm((q) => q.query(`select public.change_rate($1, 4500, $2::date, 'ajuste')`, [x.assignment, addDays(MON, 3)]));   // jue 5 mar
    const v = await vars(x.assignment, WED);
    expect(v['cuenta_semanal']).toBe('$255.00');          // lun–mié $40 + jue–sáb $45
    expect(v['cuenta_semana']).toBe('$40.00');            // anterior: solo lo generado
    const planned = (await db.su.query(`select sum(public.planned_daily_cents($1, $2::date + i))::int s from generate_series(0,6) i`, [x.assignment, MON])).rows[0].s;
    expect(planned).toBe(25500);
  });
  it('pagos_semana = pagos netos vigentes de la semana', async () => {
    const x = await mk([[MON, 4000], [TUE, 4000]]);
    await adm((q) => pay(q, x.assignment, 'yappy', 2600, { paidAt: at(MON, '10:00') }));
    const p2 = await adm((q) => pay(q, x.assignment, 'cash', 1000, { paidAt: at(TUE, '10:00') }));
    expect((await vars(x.assignment, TUE))['pagos_semana']).toBe('$35.00');
    await adm((q) => q.query(`select public.void_payment($1,'error de digitación')`, [p2.payment_id]));
    expect((await vars(x.assignment, TUE))['pagos_semana']).toBe('$25.00');
  });
});

describe('detalle_deuda: frase completa en cada caso', () => {
  const cases: { name: string; run: () => Promise<{ a: string; d: string }>; text: string }[] = [
    { name: '(a) cuota de hoy sin abonos', run: async () => ({ a: (await mk([[MON, 4000]])).assignment, d: MON }), text: 'Su cuota pendiente de hoy es de $40.00.' },
    { name: '(b) abono parcial hoy', run: async () => { const x = await mk([[MON, 4000]]); await adm((q) => pay(q, x.assignment, 'cash', 2500, { paidAt: at(MON, '13:00') })); return { a: x.assignment, d: MON }; },
      text: 'Hemos registrado un abono de $25.00. Su saldo pendiente de hoy es de $15.00.' },
    { name: '(c) deuda anterior + cuota de hoy', run: async () => ({ a: (await mk([[PREV_FRI, 2000], [MON2, 4000]])).assignment, d: MON2 }),
      text: 'Tiene una deuda anterior de $20.00 y una cuota pendiente de hoy de $40.00. Su saldo total pendiente es de $60.00.' },
    { name: '(d) domingo sin cuota con pendiente', run: async () => {
        const x = await mk([0, 1, 2, 3, 4, 5].map((i) => [addDays(MON, i), 4000] as [string, number]));
        await adm((q) => pay(q, x.assignment, 'cash', 22500, { paidAt: at(SAT, '18:00') })); return { a: x.assignment, d: SUN }; },
      text: 'Tiene un saldo pendiente de $15.00 correspondiente a cuotas anteriores.' },
    { name: 'domingo con abono del día', run: async () => {
        const x = await mk([0, 1, 2, 3, 4, 5].map((i) => [addDays(MON, i), 4000] as [string, number]));
        await adm((q) => pay(q, x.assignment, 'cash', 22500, { paidAt: at(SAT, '18:00') }));
        await adm((q) => pay(q, x.assignment, 'cash', 500, { paidAt: at(SUN, '10:00') })); return { a: x.assignment, d: SUN }; },
      text: 'Hemos registrado un abono de $5.00. Tiene un saldo pendiente de $10.00 correspondiente a cuotas anteriores.' },
    { name: 'cuotas atrasadas de la semana + hoy', run: async () => ({ a: (await mk([[MON, 4000], [TUE, 4000], [WED, 4000]])).assignment, d: WED }),
      text: 'Tiene cuotas atrasadas de esta semana por $80.00 y una cuota pendiente de hoy de $40.00. Su saldo total pendiente es de $120.00.' },
    { name: 'anterior + atrasadas + hoy', run: async () => ({ a: (await mk([[PREV_FRI, 2000], [MON, 4000], [TUE, 4000]])).assignment, d: TUE }),
      text: 'Tiene una deuda anterior de $20.00, cuotas atrasadas de esta semana por $40.00 y una cuota pendiente de hoy de $40.00. Su saldo total pendiente es de $100.00.' },
    { name: 'abono + deuda anterior + hoy', run: async () => { const x = await mk([[PREV_FRI, 2000], [MON2, 4000]]); await adm((q) => pay(q, x.assignment, 'cash', 1000, { paidAt: at(MON2, '12:00') })); return { a: x.assignment, d: MON2 }; },
      text: 'Hemos registrado un abono de $10.00. Tiene una deuda anterior de $10.00 y una cuota pendiente de hoy de $40.00. Su saldo total pendiente es de $50.00.' },
    { name: 'abono que cubre la deuda anterior', run: async () => { const x = await mk([[PREV_FRI, 2000], [MON2, 4000]]); await adm((q) => pay(q, x.assignment, 'cash', 2500, { paidAt: at(MON2, '12:00') })); return { a: x.assignment, d: MON2 }; },
      text: 'Hemos registrado un abono de $25.00. Su saldo pendiente de hoy es de $35.00.' },
    { name: 'sin deuda con crédito', run: async () => { const x = await mk([[MON, 4000]]); await adm((q) => pay(q, x.assignment, 'cash', 5000, { paidAt: at(MON, '09:00') })); return { a: x.assignment, d: MON }; },
      text: 'Su cuenta está al día y tiene un saldo a favor de $10.00.' },
    { name: 'sin deuda ni crédito', run: async () => { const x = await mk([[MON, 4000]]); await adm((q) => pay(q, x.assignment, 'cash', 4000, { paidAt: at(MON, '09:00') })); return { a: x.assignment, d: MON }; },
      text: 'Su cuenta está al día.' },
    { name: 'pago anulado no se menciona ni reduce la deuda', run: async () => { const x = await mk([[MON, 4000]]); const p = await adm((q) => pay(q, x.assignment, 'cash', 2500, { paidAt: at(MON, '13:00') }));
        await adm((q) => q.query(`select public.void_payment($1,'duplicado')`, [p.payment_id])); return { a: x.assignment, d: MON }; },
      text: 'Su cuota pendiente de hoy es de $40.00.' },
  ];
  it.each(cases)('$name', async ({ run, text }) => {
    const { a, d } = await run();
    const got = (await detail(a, d))!;
    expect(got).toBe(text);
    expect(got).not.toMatch(/\.\./); expect(got).not.toContain('{{'); expect(got.endsWith('.')).toBe(true);
    // los importes no se repiten salvo cuando coinciden por naturaleza: cada frase contiene un único punto final por oración
    expect(got.split('. ').every((s) => !s.startsWith('.'))).toBe(true);
  });
});

describe('vista previa == envío, variables sin resolver, compatibilidad', () => {
  it('la vista previa es idéntica al mensaje enviado para el mismo instante (plantilla propia y por defecto)', async () => {
    await setSchedules(['debt_first']);
    const body = 'Hola {{nombre}} {{apellido}} ({{nombre_completo}}), operario {{codigo_operario}}, unidad {{unidad}}, {{fecha}}. Cuota {{cuota_hoy}}, pendiente {{pendiente_hoy}}, anterior {{deuda_anterior}}, semanal {{deuda_semanal}}, total {{saldo_total}}, crédito {{credito}}, cuenta {{cuenta_semanal}}, pagos {{pagos_semana}}. {{detalle_deuda}}';
    await db.su.query(`insert into public.message_templates(name, body) values ('todas-las-variables', $1)`, [body]);
    await db.su.query(`update public.notification_schedules set template_id = (select id from public.message_templates where name='todas-las-variables') where kind='debt_first'`);
    const x = await mk([[PREV_FRI, 2000], [MON, 4000]]);
    await adm((q) => pay(q, x.assignment, 'yappy', 1600, { paidAt: at(MON, '09:00') }));
    const prev = await preview(x.assignment, body, MON);
    const out = mine(await tick(at(MON, '11:05')), x)[0]!;
    expect(out.action).toBe('send'); expect(out.body).toBe(prev.text); expect(prev.unresolved).toEqual([]); expect(prev.text).not.toContain('{{');
    // plantilla por defecto: estructura exacta
    await db.su.query(`update public.notification_schedules set template_id = ${BASE_TPL}`);
    const y = await mk([[MON, 4000]]);
    const o2 = mine(await tick(at(MON, '11:05')), y)[0]!;
    expect(o2.body).toBe(`Buenos días, Vanessa Ejemplo.\n\nUnidad: VU${n}\nFecha: lunes 2 de marzo de 2026\n\nSu cuota pendiente de hoy es de $40.00.\n\nGracias por su atención.`);
    expect(o2.body).toBe((await preview(y.assignment, `Buenos días, {{nombre_completo}}.\n\nUnidad: {{unidad}}\nFecha: {{fecha}}\n\n{{detalle_deuda}}\n\nGracias por su atención.`, MON)).text);
  });
  it('variable desconocida: NO se envía (skipped_unresolved) con motivo; la vista previa la reporta', async () => {
    await setSchedules(['debt_first']);
    await db.su.query(`insert into public.message_templates(name, body) values ('con-error', 'Hola {{nombre}} {{foo}} {{bar}} {{foo}}')`);
    await db.su.query(`update public.notification_schedules set template_id = (select id from public.message_templates where name='con-error') where kind='debt_first'`);
    const x = await mk([[MON, 4000]]);
    const prev = await preview(x.assignment, 'Hola {{nombre}} {{foo}} {{bar}} {{foo}}', MON);
    expect(prev.unresolved).toEqual(['foo', 'bar']); expect(prev.text).not.toContain('{{');
    const out = mine(await tick(at(MON, '11:05')), x)[0]!;
    expect(out).toMatchObject({ action: 'skip', reason: 'skipped_unresolved', status: 'skipped_unresolved' });
    expect(out.error).toBe('Variables sin resolver: {{foo}}, {{bar}}');
    const log = (await db.su.query(`select detail from public.audit_logs where action='notification_unresolved' order by id desc limit 1`)).rows[0].detail;
    expect(log.unresolved).toEqual(['foo', 'bar']);
    expect((await db.su.query(`select count(*)::int c from public.notification_jobs where status='sent' and driver_id=$1`, [x.driver])).rows[0].c).toBe(0);
  });
  it('dato faltante (apellido vacío) en la plantilla: no se envía', async () => {
    await setSchedules(['debt_first']);
    await db.su.query(`insert into public.message_templates(name, body) values ('con-apellido', 'Sr. {{apellido}}: {{detalle_deuda}}')`);
    await db.su.query(`update public.notification_schedules set template_id = (select id from public.message_templates where name='con-apellido') where kind='debt_first'`);
    const x = await mk([[MON, 4000]], { last: '' });
    expect(mine(await tick(at(MON, '11:05')), x)[0]).toMatchObject({ action: 'skip', reason: 'skipped_unresolved', error: 'Variables sin resolver: {{apellido}}' });
  });
  it('plantillas existentes con variables antiguas siguen resolviéndose', async () => {
    const x = await mk([[MON, 4000]]);
    const legacy = '{{nombre}} {{unidad}} {{cuota_hoy}} {{deuda_anterior}} {{saldo_total}} {{credito}} {{fecha}} {{detalle_deuda}} {{cuenta_semana}} {{pagos_semana}}';
    const p = await preview(x.assignment, legacy, MON);
    expect(p.unresolved).toEqual([]);
    expect(p.text).toBe(`Vanessa VU${n} $40.00 $0.00 $40.00 $0.00 lunes 2 de marzo de 2026 Su cuota pendiente de hoy es de $40.00. $40.00 $0.00`);
  });
  it('el recordatorio sigue omitiéndose con deuda exigible 0 (skipped_paid / skipped_credit)', async () => {
    await setSchedules(['debt_first']);
    const x = await mk([[MON, 4000]]); await adm((q) => pay(q, x.assignment, 'cash', 4000, { paidAt: at(MON, '09:00') }));
    expect(mine(await tick(at(MON, '11:05')), x)[0]).toMatchObject({ action: 'skip', reason: 'skipped_paid' });
  });
});

describe('escenario completo de un día: cuota de $40 con pagos de $25 y $15', () => {
  it('09:00, 14:00, 17:00, 20:00 y 21:00', async () => {
    await setSchedules(['debt_first', 'debt_update', 'debt_last']);
    await db.su.query(`update public.notification_schedules set local_time = case kind when 'debt_first' then '09:00'::time when 'debt_update' then '14:00'::time else '17:00'::time end where kind in ('debt_first','debt_update','debt_last')`);
    await db.su.query(`insert into public.notification_schedules(kind, label, local_time, weekdays, enabled, template_id) values ('debt_reminder','Recordatorio 20:00','20:00','{1,2,3,4,5,6}',true, (select id from public.message_templates where name='base-debt_update')), ('debt_reminder','Recordatorio 21:00','21:00','{1,2,3,4,5,6}',true, (select id from public.message_templates where name='base-debt_update'))`);
    const x = await mk([[MON, 4000]]);
    const body = (o: Out[]) => mine(o, x)[0]!;
    const r9 = body(await tick(at(MON, '09:05')));
    expect(r9.body).toContain('Su cuota pendiente de hoy es de $40.00.');
    await adm((q) => pay(q, x.assignment, 'cash', 2500, { paidAt: at(MON, '13:00') }));
    const r14 = body(await tick(at(MON, '14:05')));
    expect(r14.body).toContain('Hemos registrado un abono de $25.00. Su saldo pendiente de hoy es de $15.00.');
    const r17 = body(await tick(at(MON, '17:05')));
    expect(r17.body).toContain('Hemos registrado un abono de $25.00. Su saldo pendiente de hoy es de $15.00.');
    await adm((q) => pay(q, x.assignment, 'cash', 1500, { paidAt: at(MON, '19:00') }));
    expect(body(await tick(at(MON, '20:05')))).toMatchObject({ action: 'skip', reason: 'skipped_paid' });
    expect(body(await tick(at(MON, '21:05')))).toMatchObject({ action: 'skip', reason: 'skipped_paid' });
    for (const b of [r9.body, r14.body, r17.body]) { expect(b).not.toMatch(/\.\./); expect(b).not.toContain('{{'); }
    expect((await db.su.query(`select count(*)::int c from public.notification_jobs where driver_id=$1 and status='sent'`, [x.driver])).rows[0].c).toBe(3);
  });
});

describe('catálogo template_variables() y permisos', () => {
  it('devuelve los 5 grupos, todas las variables y ejemplos; cubre las claves que resuelve el motor', async () => {
    const rows = await adm((q) => q.rows(`select * from public.template_variables()`));
    expect([...new Set(rows.map((r) => r.group))]).toEqual(['Datos del conductor', 'Unidad y operario', 'Fechas', 'Importes financieros', 'Textos inteligentes']);
    expect(rows.every((r) => r.code && r.label && r.description && r.example)).toBe(true);
    expect(new Set(rows.map((r) => r.code)).size).toBe(rows.length);
    const x = await mk();
    expect(rows.map((r) => r.code).sort()).toEqual(Object.keys(await vars(x.assignment, MON)).filter((k) => !['apellido', 'pendiente_hoy', 'deuda_semanal', 'cuenta_semana'].includes(k)).sort());   // 0029: {{apellido}} ya no se ofrece (el nombre completo no se divide)
    expect(rows.find((r) => r.code === 'fecha')!.example).toBe('lunes 16 de noviembre de 2026');
    expect(rows.find((r) => r.code === 'nombre_completo')!.example).toBe('Vanessa Ejemplo');
  });
  it('staff (ADMIN, SUPERVISOR) lo lee; usuario sin rol y anon no', async () => {
    for (const who of [db.admin, db.opsAdmin, db.supervisor]) expect((await db.as(who, (q) => q.rows(`select code from public.template_variables()`))).length).toBeGreaterThan(10);
    expect(await db.as(db.outsider, (q) => q.fails(`select * from public.template_variables()`))).toBe('forbidden');
    expect(await db.asAnon((q) => q.fails(`select * from public.template_variables()`))).toMatch(/permission denied/);
    const x = await mk();
    expect(await db.as(db.outsider, (q) => q.fails(`select public.preview_template($1,'x')`, [x.assignment]))).toBe('forbidden');
    expect(await db.asAnon((q) => q.fails(`select public.preview_template($1,'x')`, [x.assignment]))).toMatch(/permission denied/);
  });
});

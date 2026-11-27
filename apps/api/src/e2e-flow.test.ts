import { SignJWT } from 'jose';
import ExcelJS from 'exceljs';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newDb, type Db } from '@vip/db/testing';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createDatabase } from './db.js';

/**
 * Flujo diario completo por HTTP real (app.inject) contra PostgreSQL de prueba:
 * Excel plano → importar → vista previa → aplicar → reaplicar → segundo Excel con cambios → última importación → tabla de cobranza →
 * vista previa de mensajes → envío → historial → worker simulado. Fechas fijas (semana del 2026-11-16, pasada); nada depende del día de hoy
 * salvo los mensajes, que el servidor redacta con la fecha real: esos valores se comparan contra la misma función de la base.
 */
const SECRET = 'e'.repeat(40);
const WEEK = '2026-11-16';                                          // lunes
const sign = (sub: string) => new SignJWT({ role: 'authenticated', email: `${sub}@t.local` }).setProtectedHeader({ alg: 'HS256' })
  .setSubject(sub).setAudience('authenticated').setIssuedAt().setExpirationTime('10m').sign(new TextEncoder().encode(SECRET));

// ───────── Excel plano sintético (misma forma que packages/excel-import/test/flat-fixture.ts: fila 1 vacía, cabeceras en la fila 2, columna A vacía) ─────────
type Cell = ExcelJS.CellValue;
const HEADERS = ['und', 'OERADOR', 'CEDULA ', 'NOMBRE Y AELLIDO', 'WHATSAPP', 'CUENTA ', 'ACUERDO', 'SALDO', 'LUNES ', 'MARTES ', 'MIERCOLES  ', 'JUEVES ', 'VIERNES ', 'SABADO', 'DOMINGO ', 'PAGO SEMANAL', 'Cuenta semanal'];
interface FRow { unit: string; op: string; name: string; wsp: string; rate: number; agr?: string; saldo?: number; days?: Cell[] }
async function flat(rows: FRow[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Hoja1');
  HEADERS.forEach((h, i) => { ws.getCell(2, 2 + i).value = h; });
  rows.forEach((r, i) => {
    const days = r.days ?? [null, null, null, null, null, null, null];
    const sum = days.reduce<number>((a, d) => a + (typeof d === 'number' ? d : 0), 0); const x = 3 + i;
    const vals: Cell[] = [r.unit, r.op, null, r.name, r.wsp, r.rate, r.agr ?? null, r.saldo ?? null, ...days,
      { formula: `J${x}+K${x}+L${x}+M${x}+N${x}+O${x}+P${x}-R${x}`, result: sum - r.rate * 6 } as any, { formula: `G${x}*6`, result: r.rate * 6 } as any];
    vals.forEach((v, j) => { if (v !== null && v !== undefined) ws.getCell(x, 2 + j).value = v; });
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}
const multipart = (buf: Buffer, filename: string) => {
  const b = '----vipE2E';
  return { payload: Buffer.concat([Buffer.from(`--${b}\r\ncontent-disposition: form-data; name="file"; filename="${filename}"\r\ncontent-type: application/octet-stream\r\n\r\n`), buf, Buffer.from(`\r\n--${b}--\r\n`)]), headers: { 'content-type': `multipart/form-data; boundary=${b}` } };
};

let db: Db, pool: pg.Pool, a: FastifyInstance, t: string;
const call = (method: 'GET' | 'POST', url: string, payload?: object) => a.inject({ method, url: `/api/v1${url}`, headers: { authorization: `Bearer ${t}` }, payload });
const upload = (buf: Buffer, name: string) => { const m = multipart(buf, name); return a.inject({ method: 'POST', url: '/api/v1/imports/excel', headers: { authorization: `Bearer ${t}`, ...m.headers }, payload: m.payload }); };
const q = async (sql: string, p: unknown[] = []) => (await db.su.query(sql, p)).rows;
const q1 = async (sql: string, p: unknown[] = []) => (await q(sql, p))[0];
const counts = async () => (await q1(`select (select count(*) from public.whatsapp_test_messages)::int msgs, (select count(*) from public.notification_jobs)::int jobs`));
const snapshot = () => q1(`select (select count(*) from public.units)::int units, (select count(*) from public.drivers)::int drivers, (select count(*) from public.assignments)::int asg,
  (select count(*) from public.rates)::int rates, (select count(*) from public.payments)::int pay, (select count(*) from public.excel_payment_days)::int days,
  (select count(*) from public.excel_payment_changes)::int chg, (select count(*) from public.charges)::int ch, (select count(*) from public.adjustments)::int adj`);

/** Los únicos trabajos de notificación posibles tras importar son BORRADORES (pendientes de aprobación): nunca aprobados, reclamados ni enviados. */
const onlyDraftJobs = async () => {
  const j = await q(`select kind, status, attempts, approved_at, claimed_at, sent_at, rendered_body, recipient_phone from public.notification_jobs`);
  for (const x of j) expect(x).toMatchObject({ status: expect.stringMatching(/^(awaiting_approval|discarded)$/), attempts: 0, approved_at: null, claimed_at: null, sent_at: null, rendered_body: null, recipient_phone: null });
};
const sched: { buf1?: Buffer; id1?: string; id2?: string; asg: Record<string, string>; tpl?: string; jobsAfterImports?: number; id3?: string; baseline?: { msgs: number; jobs: number } } = { asg: {} };
const asgOf = async (unit: string) => (await q1(`select a.id, a.driver_id from public.assignments a join public.units u on u.id = a.unit_id where u.code = $1`, [unit]));
const activePay = async (unit: string) => (await q(`select (p.paid_at at time zone app_private.tz())::date::text d, p.net_cents::int c from public.payments p join public.assignments a on a.id = p.assignment_id join public.units u on u.id = a.unit_id
  where u.code = $1 and p.voided_at is null order by p.paid_at`, [unit])).map((r) => [r.d, r.c]);

const FILE1: FRow[] = [
  { unit: 'P1', op: '101', name: 'Ana Pérez', wsp: '6000-0001', rate: 36, saldo: 100, days: [36, null, 10, null, null, null, null] },
  { unit: 'P2', op: '102', name: 'Luis Gómez', wsp: '6000-0002', rate: 36, saldo: 80, days: [36, 18, null, null, null, null, null] },
  { unit: 'P3', op: '101', name: 'Ana Pérez', wsp: '6000-0001', rate: 20, saldo: 30, days: [20, null, null, null, null, null, null] },
];
const FILE2: FRow[] = [
  { unit: 'P1', op: '101', name: 'Ana Pérez', wsp: '6000-0001', rate: 36, saldo: 100, days: [36, 36, null, null, null, null, null] },   // lunes igual, martes nuevo, miércoles VACÍO (no anula el de 10)
  { unit: 'P2', op: '102', name: 'Luis Gómez', wsp: '6000-0002', rate: 40, saldo: 50, days: [36, 0, null, null, null, null, null] },    // cuota 36→40, saldo 80→50, martes 0 explícito (anula los 18)
  { unit: 'P3', op: '101', name: 'Ana Pérez', wsp: '6000-0001', rate: 20, saldo: 30, days: [25, null, null, null, null, null, null] },          // lunes 20→25 (anula y crea)
];

beforeAll(async () => {
  db = await newDb(); pool = new pg.Pool({ ...db.connection, max: 6 });
  a = await buildApp(loadConfig({ SUPABASE_JWT_SECRET: SECRET, RATE_LIMIT_PER_MINUTE: '100000', WHATSAPP_DRY_RUN: 'false' }), { db: createDatabase(pool) });
  t = await sign(db.opsAdmin);
  await db.su.query(`insert into public.whatsapp_sessions(label, status, desired_state) select 'Principal', 'connected', 'connected' where not exists (select 1 from public.whatsapp_sessions)`);
  await db.su.query(`update public.whatsapp_sessions set status = 'connected'`);
});
afterAll(async () => { await a.close(); await pool.end(); await db.close(); });

describe('flujo diario de cobranza de punta a punta', () => {
  it('1-2. sube el Excel plano, vista previa sin errores, aplica y deja los datos correctos (sin mensajes ni notificaciones)', async () => {
    sched.baseline = await counts();
    sched.buf1 = await flat(FILE1);                               // los bytes se generan UNA vez (ExcelJS estampa la hora: otra generación daría otro hash)
    const up = await upload(sched.buf1, 'DATOS-1.xlsx');
    expect(up.statusCode).toBe(201);
    expect(up.json()).toMatchObject({ created: true, kind: 'collection_flat' });
    sched.id1 = up.json().importId;
    const pre = await call('GET', `/imports/${sched.id1}/sync-preview?weekStart=${WEEK}`);
    expect(pre.statusCode).toBe(200);
    expect(pre.json().units).toMatchObject({ total: 3, new: 3, errors: 0, unchanged: 0 });
    expect(pre.json().applied).toBe(false);
    expect(await q1(`select count(*)::int c from public.units where code in ('P1','P2','P3')`)).toEqual({ c: 0 });   // la vista previa no escribe

    const ap = await call('POST', `/imports/${sched.id1}/sync-apply`, { weekStart: WEEK, note: 'e2e' });
    expect(ap.statusCode).toBe(200);
    expect(ap.json()).toMatchObject({ applied: true, already_up_to_date: false, units: { new: 3, errors: 0 } });
    expect(await q1(`select status from public.excel_imports where id=$1`, [sched.id1])).toMatchObject({ status: 'applied' });

    expect((await q1(`select count(*)::int c from public.units where code in ('P1','P2','P3')`)).c).toBe(3);
    expect((await q(`select operator_code, phone_e164 from public.drivers where operator_code in ('101','102') order by operator_code`))).toEqual([
      { operator_code: '101', phone_e164: '+50760000001' }, { operator_code: '102', phone_e164: '+50760000002' }]);
    const p1 = await asgOf('P1'), p2 = await asgOf('P2'), p3 = await asgOf('P3');
    sched.asg = { P1: p1.id, P2: p2.id, P3: p3.id };
    expect(p1.driver_id).toBe(p3.driver_id); expect(p1.driver_id).not.toBe(p2.driver_id);                 // operario 101 lleva 2 unidades
    expect((await q1(`select count(*)::int c from public.assignments where driver_id=$1`, [p1.driver_id])).c).toBe(2);
    expect((await q1(`select count(*)::int c from public.assignments a join public.units u on u.id=a.unit_id where u.code in ('P1','P2','P3')`)).c).toBe(3);
    expect((await q(`select u.code, r.daily_amount_cents::int c, r.valid_from::text vf from public.rates r join public.assignments a on a.id=r.assignment_id join public.units u on u.id=a.unit_id order by u.code`)))
      .toEqual([{ code: 'P1', c: 3600, vf: WEEK }, { code: 'P2', c: 3600, vf: WEEK }, { code: 'P3', c: 2000, vf: WEEK }]);
    expect(await activePay('P1')).toEqual([['2026-11-16', 3600], ['2026-11-18', 1000]]);
    expect(await activePay('P2')).toEqual([['2026-11-16', 3600], ['2026-11-17', 1800]]);
    expect(await activePay('P3')).toEqual([['2026-11-16', 2000]]);
    expect((await q1(`select count(*)::int c from public.payments`)).c).toBe(5);
    expect((await q1(`select count(*)::int c from public.excel_payment_days where amount_cents > 0`)).c).toBe(5);
    expect((await q1(`select count(*)::int c from public.excel_payment_changes where action='create'`)).c).toBe(5);
    // saldo de apertura de P1 = 100,00 (sin deuda previa); P2 = 80,00; P3 sin saldo
    const open = await q(`select u.code, c.amount_cents::int c, c.kind, c.charge_date::text d from public.charges c join public.assignments a on a.id=c.assignment_id join public.units u on u.id=a.unit_id where c.kind='opening' order by u.code`);
    expect(open.map((r) => [r.code, r.c])).toEqual([['P1', 10000], ['P2', 8000], ['P3', 3000]]);
    expect(open[0].d).toBe('2026-11-15');                                                                   // domingo anterior a la semana
    // 10: importar/aplicar NO crea mensajes de WhatsApp. (Hallazgo: el disparador de pagos sí deja un borrador `credit_notice` en notification_jobs, solo «awaiting_approval».)
    expect((await counts()).msgs).toBe(sched.baseline!.msgs);
    await onlyDraftJobs();
  });

  it('3. reaplicar el mismo archivo es idempotente: already_up_to_date y cero filas nuevas', async () => {
    const before = await snapshot(); const base = await counts(); const jobsBefore = (await counts()).jobs;
    const pre = await call('GET', `/imports/${sched.id1}/sync-preview?weekStart=${WEEK}`);
    expect(pre.json().units).toMatchObject({ new: 0, changed: 0, unchanged: 3, errors: 0 });
    const ap = await call('POST', `/imports/${sched.id1}/sync-apply`, { weekStart: WEEK });
    expect(ap.statusCode).toBe(200);
    expect(ap.json()).toMatchObject({ already_up_to_date: true, units: { new: 0, changed: 0 }, assignments_created: 0 });
    expect(await snapshot()).toEqual(before);
    expect(await counts()).toEqual(base); expect((await counts()).jobs).toBe(jobsBefore);
    // el mismo archivo no se vuelve a importar como otro
    const again = await upload(sched.buf1!, 'DATOS-1.xlsx');
    expect([again.statusCode, again.json().created, again.json().importId]).toEqual([200, false, sched.id1]);
  });

  it('4. segundo Excel con cambios: vacío no anula, 0 explícito anula con auditoría, cuota nueva con historial, sin duplicar pagos', async () => {
    const base = await counts(); const before = await snapshot();
    const up = await upload(await flat(FILE2), 'DATOS-2.xlsx');
    expect(up.statusCode).toBe(201); sched.id2 = up.json().importId; expect(sched.id2).not.toBe(sched.id1);
    const pre = await call('GET', `/imports/${sched.id2}/sync-preview?weekStart=${WEEK}`);
    expect(pre.statusCode).toBe(200); 
    expect(pre.json().units).toMatchObject({ total: 3, new: 0, errors: 0 });
    expect(pre.json().units).toMatchObject({ changed: 3, unchanged: 0 });                                     // 0028: pagos, saldo y cuota cuentan como cambios de la unidad (una sola vez por unidad)
    expect(pre.json().saldo).toMatchObject({ adjust: 1, delta_cents: -3000 });
    expect(pre.json()).toMatchObject({ blocked: 0, rate_changes: [expect.objectContaining({ kind: 'correction', previous_cents: 3600, new_cents: 4000 })] });   // 0028: corrección de cuota en la MISMA semana
    expect(pre.json().warnings.filter((w: { code: string }) => w.code === 'rate_change_not_applied')).toEqual([]);
    expect(pre.json().payments).toMatchObject({ new: 1, changed: 1, zeroed: 1, rejected: 0 });             // P1 mar; P3 lun 20→25; P2 mar 18→0
    expect((await snapshot()).pay).toBe(before.pay);                                                       // la vista previa no escribe

    const ap = await call('POST', `/imports/${sched.id2}/sync-apply`, { weekStart: WEEK });
    expect(ap.statusCode).toBe(200);
    expect(ap.json()).toMatchObject({ applied: true, already_up_to_date: false, blocked: 0, payments: { new: 1, changed: 1, zeroed: 1 } });

    expect(await activePay('P1')).toEqual([['2026-11-16', 3600], ['2026-11-17', 3600], ['2026-11-18', 1000]]);   // el miércoles vacío NO se anuló
    expect(await activePay('P2')).toEqual([['2026-11-16', 3600]]);                                          // el 0 explícito anuló los 18,00
    expect(await activePay('P3')).toEqual([['2026-11-16', 2500]]);
    const all = await q(`select count(*)::int c, count(*) filter (where voided_at is not null)::int v from public.payments`);
    expect(all[0]).toEqual({ c: 7, v: 2 });                                                                 // 5 + martes P1 + nuevo de P3; anulados: P2 mar y P3 lun anterior
    expect((await q1(`select count(*)::int c from (select assignment_id, paid_at::date d from public.payments where voided_at is null group by 1,2 having count(*) > 1) x`)).c).toBe(0);
    // auditoría del Excel: una fila por cambio, con previo/nuevo
    const chg = await q(`select u.code, c.pay_date::text d, c.action, c.previous_cents::int pv, c.new_cents::int nv, c.delta_cents::int dl, c.import_id from public.excel_payment_changes c
      join public.assignments a on a.id=c.assignment_id join public.units u on u.id=a.unit_id where c.import_id = $1 order by u.code, c.pay_date`, [sched.id2]);
    expect(chg.map((r) => [r.code, r.d, r.action, r.pv, r.nv, r.dl])).toEqual([
      ['P1', '2026-11-17', 'create', null, 3600, 3600], ['P2', '2026-11-17', 'zero', 1800, 0, -1800], ['P3', '2026-11-16', 'change', 2000, 2500, 500]]);
    const vp = await q(`select count(*)::int c from public.payments p join public.excel_payment_changes c on c.previous_payment_id = p.id where p.voided_at is not null`);
    expect(vp[0].c).toBe(2);                                                                                // los anulados quedan enlazados desde el historial
    expect((await q1(`select count(*)::int c from public.payments where voided_at is not null and void_reason is not null`)).c).toBe(2);
    expect((await q1(`select count(*)::int c from public.audit_logs where action like '%void%' or action like '%payment%'`)).c).toBeGreaterThan(0);
    expect((await q1(`select count(*)::int c from public.excel_payment_days where amount_cents = 0`)).c).toBe(1);   // estado vigente: P2 martes = 0
    // cuota de P2 36→40 en la semana de su tarifa inicial: CORRECCIÓN en su lugar, con registro en rate_corrections y auditoría; sin tarifas duplicadas
    expect((await q(`select r.daily_amount_cents::int c, r.valid_to::text vt from public.rates r where r.assignment_id=$1`, [sched.asg.P2]))).toEqual([{ c: 4000, vt: null }]);
    expect((await q(`select previous_daily_cents::int p, new_daily_cents::int n from public.rate_corrections where assignment_id=$1`, [sched.asg.P2]))).toEqual([{ p: 3600, n: 4000 }]);
    expect((await q1(`select count(*)::int c from public.audit_logs where action='collection_sync_rate_correction' and entity_id=$1`, [sched.asg.P2])).c).toBe(1);
    expect((await q1(`select count(*)::int c from public.rates`)).c).toBe(3);
    // saldo de P2 80→50: la diferencia (−30,00) se concilia con un ajuste, no se duplica la apertura
    expect((await q(`select c.amount_cents::int c from public.charges c where c.assignment_id=$1 and c.kind='opening'`, [sched.asg.P2])).map((r) => r.c)).toEqual([8000]);
    expect((await q1(`select coalesce(sum(amount_cents),0)::int s from public.adjustments a where assignment_id=$1 and a.idempotency_key not like 'excel-ratecorr:%'`, [sched.asg.P2])).s).toBe(-3000);   // el SALDO se respeta: la corrección de cuota va aparte
    expect((await q1(`select count(*)::int c from public.assignments`)).c).toBe(3);                         // sin conductores/unidades/asignaciones duplicadas
    expect((await q1(`select count(*)::int c from public.drivers where operator_code in ('101','102')`)).c).toBe(2);
    // reaplicar el segundo no mueve nada
    const snap = await snapshot();
    expect((await call('POST', `/imports/${sched.id2}/sync-apply`, { weekStart: WEEK })).json().already_up_to_date).toBe(true);
    expect(await snapshot()).toEqual(snap);
    expect((await counts()).msgs).toBe(base.msgs);
    await onlyDraftJobs(); sched.jobsAfterImports = (await counts()).jobs;
  });

  it('5. la última importación aplicada es la de referencia: last-sync devuelve el segundo archivo', async () => {
    const r = await call('GET', '/collection/last-sync');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ importId: sched.id2, fileName: 'DATOS-2.xlsx' });
    expect(r.json().appliedAt).toBeTruthy();
  });

  it('6. tabla de cobranza: una fila por unidad, WhatsApp, pago de hoy y las dos unidades del operario 101 por separado', async () => {
    sched.tpl = (await q1(`insert into public.message_templates(name, body) values ('Resumen diario', $1) returning id`,
      ['Hola {{nombre_completo}}, unidad {{unidad}}: cuota {{cuota_diaria}}, saldo {{saldo_total}}, pagos {{pagos_semana}}, hoy {{dia_semana}}']))!.id;
    await db.su.query(`update public.whatsapp_sessions set status = 'connected'`);
    const r = await call('GET', `/collection/board?weekStart=${WEEK}`);
    expect(r.statusCode).toBe(200);
    const rows = r.json() as any[];
    const by = (u: string) => rows.find((x) => x.unitCode === u);
    expect(['P1', 'P2', 'P3'].every((u) => by(u))).toBe(true);
    expect(rows.filter((x) => ['P1', 'P2', 'P3'].includes(x.unitCode))).toHaveLength(3);
    expect(by('P1')).toMatchObject({ assignmentId: sched.asg.P1, operatorCode: '101', phone: '+50760000001', dailyRateCents: 3600, messagesToday: [] });
    expect(by('P3')).toMatchObject({ assignmentId: sched.asg.P3, operatorCode: '101', phone: '+50760000001', dailyRateCents: 2000 });
    expect(by('P2')).toMatchObject({ assignmentId: sched.asg.P2, operatorCode: '102', phone: '+50760000002', dailyRateCents: 4000 });
    expect(by('P1').assignmentId).not.toBe(by('P3').assignmentId);
    // El saldo mostrado es el SALDO del Excel (último importado), aunque el motor haya devengado cuotas: P1 100, P2 50 (2.º archivo), P3 30
    expect([by('P1'), by('P2'), by('P3')].map((x: any) => [x.pendingCents, x.saldoSource, x.saldoMissing])).toEqual([[10000, 'excel', false], [5000, 'excel', false], [3000, 'excel', false]]);
    expect((await q1(`select count(*)::int c from public.charges where kind='daily'`)).c).toBeGreaterThan(0);               // hay cuotas devengadas y aun así el saldo comunicado no cambia
    expect(by('P1').driverId).toBe(by('P3').driverId);
    for (const u of ['P1', 'P2', 'P3']) expect(typeof by(u).paidTodayCents).toBe('number');
    expect(by('P1').paidWeekCents).toBe(3600 + 3600 + 1000); expect(by('P3').paidWeekCents).toBe(2500); expect(by('P2').paidWeekCents).toBe(3600);
    expect(by('P1').paidTodayCents).toBe(0);                                                                // los pagos son de la semana del 16/11, no de hoy
  });

  it('7. vista previa de mensajes: cada unidad usa SUS importes; motivos de exclusión', async () => {
    const ids = [sched.asg.P1, sched.asg.P2, sched.asg.P3];
    const base = await counts();
    const r = await call('POST', '/collection/messages/preview', { templateId: sched.tpl, assignmentIds: ids });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.whatsappConnected).toBe(true);
    expect(body.lastSync).toMatchObject({ importId: sched.id2, fileName: 'DATOS-2.xlsx' });
    expect(body.items).toHaveLength(3);
    const item = (u: string) => body.items.find((i: any) => i.unitCode === u);
    for (const u of ['P1', 'P2', 'P3']) expect(item(u)).toMatchObject({ reason: null, unresolved: [] });
    // texto esperado: lo que calcula la propia base para ESA asignación (fecha real de hoy) — sin mezclar P1 con P3
    const vars = async (asg: string) => (await q1(`select app_private.template_vars($1, (now() at time zone app_private.tz())::date) v`, [asg])).v as Record<string, string>;
    const expected = async (asg: string) => { const v = await vars(asg); return `Hola ${v.nombre_completo}, unidad ${v.unidad}: cuota ${v.cuota_diaria}, saldo ${v.saldo_total}, pagos ${v.pagos_semana}, hoy ${v.dia_semana}`; };
    for (const [u, asg] of [['P1', ids[0]], ['P2', ids[1]], ['P3', ids[2]]] as const) expect(item(u).text).toBe(await expected(asg!));
    expect(item('P1').text).toContain('Ana Pérez'); expect(item('P1').text).toContain('unidad P1'); expect(item('P1').text).toContain('cuota $36.00');
    expect((await vars(ids[0]!)).deuda_anterior).toBe('$100.00'); expect((await vars(ids[1]!)).deuda_anterior).toBe('$50.00'); expect((await vars(ids[2]!)).deuda_anterior).toBe('$30.00');   // SALDO del Excel; el total suma además las cuotas de la semana (0038)
    expect(item('P3').text).toContain('Ana Pérez'); expect(item('P3').text).toContain('unidad P3'); expect(item('P3').text).toContain('cuota $20.00');
    expect(item('P2').text).toContain('Luis Gómez'); expect(item('P2').text).toContain('cuota $40.00');
    expect(item('P1').text).not.toEqual(item('P3').text);
    expect(item('P1').phone).toBe('+50760000001'); expect(item('P3').phone).toBe('+50760000001');
    expect(await counts()).toEqual(base);                                                                   // la vista previa no crea nada

    // sin teléfono → driver_without_phone
    const drv2 = (await asgOf('P2')).driver_id;
    await db.su.query(`update public.drivers set phone_e164 = null where id = $1`, [drv2]);
    const noPhone = await call('POST', '/collection/messages/preview', { templateId: sched.tpl, assignmentIds: [sched.asg.P2] });
    expect(noPhone.json().items[0]).toMatchObject({ unitCode: 'P2', reason: 'driver_without_phone', phone: null });
    await db.su.query(`update public.drivers set phone_e164 = '+50760000002' where id = $1`, [drv2]);
    // plantilla con {{acuerdo}} y unidad sin acuerdo → template_unresolved
    const tAg = (await q1(`insert into public.message_templates(name, body) values ('Con acuerdo', 'Acuerdo de {{unidad}}: {{acuerdo}}') returning id`)).id;
    const unres = await call('POST', '/collection/messages/preview', { templateId: tAg, assignmentIds: [sched.asg.P1] });
    expect(unres.json().items[0]).toMatchObject({ reason: 'template_unresolved', unitCode: 'P1' });
    expect(unres.json().items[0].unresolved).toContain('acuerdo');
    // con acuerdo en la unidad se resuelve
    await db.su.query(`update public.units set agreement = 'Paga los viernes' where code = 'P1'`);
    const ok = await call('POST', '/collection/messages/preview', { templateId: tAg, assignmentIds: [sched.asg.P1] });
    expect(ok.json().items[0]).toMatchObject({ reason: null, text: 'Acuerdo de P1: Paga los viernes' });
    await db.su.query(`update public.units set agreement = null where code = 'P1'`);
    // validaciones de entrada
    expect((await call('POST', '/collection/messages/preview', { templateId: sched.tpl, assignmentIds: [] })).statusCode).toBe(400);
  });

  it('8. envío: texto exacto de la vista previa, importación de referencia, variables, ya enviado hoy, repetir y WhatsApp desconectado', async () => {
    const ids = [sched.asg.P1, sched.asg.P2, sched.asg.P3];
    const pv = (await call('POST', '/collection/messages/preview', { templateId: sched.tpl, assignmentIds: ids })).json();
    const before = await counts();
    const s = await call('POST', '/collection/messages/send', { templateId: sched.tpl, assignmentIds: ids, batchKey: 'e2e-batch-0001' });
    expect(s.statusCode).toBe(200);
    expect(s.json()).toMatchObject({ sent: 3, failed: 0 });
    expect(s.json().results.every((x: any) => x.ok && x.status === 'prepared')).toBe(true);
    const rows = await q(`select m.body, m.status, m.import_id, m.variables, m.template_name, m.template_id, m.recipient_phone, m.assignment_id, u.code from public.whatsapp_test_messages m
      join public.assignments a on a.id = m.assignment_id join public.units u on u.id = a.unit_id where m.kind='collection_message' order by u.code`);
    expect(rows).toHaveLength(3);
    expect((await counts()).msgs).toBe(before.msgs + 3);
    for (const r of rows) {
      const p = pv.items.find((i: any) => i.unitCode === r.code);
      expect(r.body).toBe(p.text);
      expect(r).toMatchObject({ status: 'prepared', import_id: sched.id2, template_name: 'Resumen diario', template_id: sched.tpl, recipient_phone: p.phone });
      expect(r.variables).toMatchObject({ unidad: r.code });
      expect(r.variables.cuota_diaria).toBe({ P1: '$36.00', P2: '$40.00', P3: '$20.00' }[r.code as 'P1']);
    }
    expect(rows[0].variables.nombre_completo).toBe('Ana Pérez'); expect(rows[2].variables.nombre_completo).toBe('Ana Pérez');
    expect((await q1(`select count(*)::int c from public.audit_logs where action='whatsapp.collection_message.created'`)).c).toBe(3);
    // mismo día, misma plantilla, sin repetir
    const again = await call('POST', '/collection/messages/send', { templateId: sched.tpl, assignmentIds: ids, batchKey: 'e2e-batch-0002' });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ sent: 0, failed: 3 });
    expect(again.json().results.every((x: any) => !x.ok && x.error === 'already_sent_today')).toBe(true);
    expect((await counts()).msgs).toBe(before.msgs + 3);
    // el mismo batchKey es idempotente
    const same = await call('POST', '/collection/messages/send', { templateId: sched.tpl, assignmentIds: ids, batchKey: 'e2e-batch-0001' });
    expect(same.json().sent).toBe(3); expect((await counts()).msgs).toBe(before.msgs + 3);
    // con repeat
    const rep = await call('POST', '/collection/messages/send', { templateId: sched.tpl, assignmentIds: [sched.asg.P1], batchKey: 'e2e-batch-0003', repeat: true });
    expect(rep.json()).toMatchObject({ sent: 1, failed: 0 });
    expect((await counts()).msgs).toBe(before.msgs + 4);
    // un teléfono inválido no frena a los demás
    const drv2 = (await asgOf('P2')).driver_id;
    await db.su.query(`update public.drivers set phone_e164 = null where id = $1`, [drv2]);
    const mix = await call('POST', '/collection/messages/send', { templateId: sched.tpl, assignmentIds: [sched.asg.P2, sched.asg.P3], batchKey: 'e2e-batch-0004', repeat: true });
    expect(mix.json()).toMatchObject({ sent: 1, failed: 1 });
    expect(mix.json().results.find((x: any) => x.assignmentId === sched.asg.P2)).toMatchObject({ ok: false, error: 'driver_without_phone' });
    await db.su.query(`update public.drivers set phone_e164 = '+50760000002' where id = $1`, [drv2]);
    // WhatsApp desconectado: 409 y nada se encola
    const n = (await counts()).msgs;
    await db.su.query(`update public.whatsapp_sessions set status = 'disconnected'`);
    const off = await call('POST', '/collection/messages/send', { templateId: sched.tpl, assignmentIds: ids, batchKey: 'e2e-batch-0005', repeat: true });
    expect(off.statusCode).toBe(409); expect(off.json().error).toBe('whatsapp_disconnected');
    expect((await counts()).msgs).toBe(n);
    const pvOff = await call('POST', '/collection/messages/preview', { templateId: sched.tpl, assignmentIds: ids });
    expect(pvOff.json().whatsappConnected).toBe(false);
    await db.su.query(`update public.whatsapp_sessions set status = 'connected'`);
    expect((await counts()).jobs).toBe(sched.jobsAfterImports);                                             // 10: enviar mensajes de cobranza no toca notification_jobs
  });

  it('9. historial con unidad, plantilla, archivo e estado; el worker simulado lo pasa a «simulated»', async () => {
    const h = (await call('GET', '/collection/messages')).json() as any[];
    expect(h.length).toBeGreaterThanOrEqual(5);
    expect(h.every((m) => m.status === 'prepared')).toBe(true);
    for (const u of ['P1', 'P2', 'P3']) {
      const m = h.find((x) => x.unitCode === u);
      expect(m).toMatchObject({ template: 'Resumen diario', importFile: 'DATOS-2.xlsx', status: 'prepared', unitCode: u });
      expect(m.body).toContain(`unidad ${u}`); expect(m.variables).toMatchObject({ unidad: u }); expect(m.sentBy).toBeTruthy();
    }
    expect(h.filter((m) => m.unitCode === 'P1').length).toBeGreaterThanOrEqual(2);                          // P1 se envió dos veces (repeat)
    expect(h.find((m) => m.unitCode === 'P1')!.name).toBe('Ana Pérez');
    // la tabla refleja el último mensaje
    const board = (await call('GET', `/collection/board?weekStart=${WEEK}`)).json() as any[];
    expect(board.find((r) => r.unitCode === 'P1').messagesToday[0]).toMatchObject({ template: 'Resumen diario', status: 'prepared' });

    // worker SIMULADO (sin red): reclama y completa por la función de servicio de la base
    const drained: string[] = [];
    for (let i = 0; i < 20; i++) {
      const c = await db.asService((x) => x.one(`select * from public.claim_test_message()`));
      if (!c?.id) break;
      expect(c.status).toBe('processing'); expect(c.kind).toBe('collection_message');
      await db.asService((x) => x.one(`select * from public.complete_test_message($1,'simulated',$2,null,null)`, [c.id, c.recipient_phone]));
      drained.push(c.id);
    }
    expect(drained.length).toBe(h.length);
    const h2 = (await call('GET', '/collection/messages')).json() as any[];
    expect(h2.every((m) => m.status === 'simulated')).toBe(true);
    const board2 = (await call('GET', `/collection/board?weekStart=${WEEK}`)).json() as any[];
    expect(board2.find((r) => r.unitCode === 'P1').messagesToday.map((m: any) => m.status)).toContain('simulated');
    // simulado cuenta como enviado hoy: no se puede repetir sin confirmar
    const dup = await call('POST', '/collection/messages/send', { templateId: sched.tpl, assignmentIds: [sched.asg.P3], batchKey: 'e2e-batch-0006' });
    expect(dup.json().results[0]).toMatchObject({ ok: false, error: 'already_sent_today' });
  });

  it('10. nada de lo anterior creó mensajes por su cuenta; los roles sin permiso no pasan', async () => {
    expect((await counts()).jobs).toBe(sched.jobsAfterImports);
    await onlyDraftJobs();
    expect((await q1(`select count(*)::int c from public.whatsapp_test_messages where kind <> 'collection_message'`)).c).toBe(0);
    const tOut = await sign(db.outsider);
    const h = { authorization: `Bearer ${tOut}` };
    expect((await a.inject({ method: 'GET', url: '/api/v1/collection/last-sync', headers: h })).statusCode).toBe(403);
    expect((await a.inject({ method: 'GET', url: `/api/v1/imports/${sched.id1}/sync-preview?weekStart=${WEEK}`, headers: h })).statusCode).toBe(403);
    expect((await a.inject({ method: 'GET', url: `/api/v1/imports/${sched.id1}/sync-preview?weekStart=${WEEK}` })).statusCode).toBe(401);
  });

  it('11. cuota cambiada en la semana SIGUIENTE: nueva tarifa hacia adelante con historial; la nueva importación pasa a ser la de referencia', async () => {
    const NEXT = '2026-11-30';                                  // semana futura: el cambio contractual rige desde ese lunes (determinista, sin depender del día de hoy)
    const before = await snapshot(); const msgs = (await counts()).msgs;
    const f3 = await flat([{ ...FILE2[0]!, saldo: undefined, days: undefined }, { ...FILE2[1]!, rate: 44, saldo: undefined, days: undefined }, { ...FILE2[2]!, days: undefined }]);   // cuota de P2 40→44 desde la semana siguiente: cambio contractual
    const up = await upload(f3, 'DATOS-3.xlsx'); expect(up.statusCode).toBe(201); sched.id3 = up.json().importId;
    const pre = await call('GET', `/imports/${sched.id3}/sync-preview?weekStart=${NEXT}`);
    expect(pre.json()).toMatchObject({ units: { errors: 0, new: 0 }, blocked: 0, rate_changes: [expect.objectContaining({ unit_code: 'P2', kind: 'contract', previous_cents: 4000, new_cents: 4400, effective_from: NEXT })] });
    expect((await snapshot()).rates).toBe(before.rates);
    const ap = await call('POST', `/imports/${sched.id3}/sync-apply`, { weekStart: NEXT });
    expect(ap.statusCode).toBe(200); expect(ap.json()).toMatchObject({ applied: true, blocked: 0 });
    const rates = await q(`select r.daily_amount_cents::int c, r.valid_from::text vf, r.valid_to::text vt from public.rates r where r.assignment_id=$1 order by r.valid_from`, [sched.asg.P2]);
    expect(rates).toEqual([{ c: 4000, vf: WEEK, vt: '2026-11-29' }, { c: 4400, vf: NEXT, vt: null }]);     // la anterior se cierra, nunca se reescribe
    const hist = await db.as(db.opsAdmin, (x) => x.rows(`select new_daily_cents::int n, previous_daily_cents::int p, is_current from public.rate_history($1) order by valid_from`, [sched.asg.P2]));
    expect(hist.map((h: any) => [h.p, h.n])).toEqual([[null, 4000], [4000, 4400]]); expect(hist[0].is_current).toBe(true);                              // la tarifa nueva empieza en una semana futura: hoy sigue vigente la anterior
    expect((await q1(`select count(*)::int c from public.audit_logs where action='change_rate' and entity_id=$1`, [sched.asg.P2])).c).toBe(1);
    expect((await q1(`select count(*)::int c from public.rates where assignment_id <> $1`, [sched.asg.P2])).c).toBe(2);   // P1 y P3 sin cambios
    // los pagos de la semana anterior no se tocan y no se crean duplicados
    const after = await snapshot();
    expect([after.pay, after.units, after.drivers, after.asg]).toEqual([before.pay, before.units, before.drivers, before.asg]);
    expect(await activePay('P1')).toEqual([['2026-11-16', 3600], ['2026-11-17', 3600], ['2026-11-18', 1000]]);
    expect((await call('GET', '/collection/last-sync')).json()).toMatchObject({ importId: sched.id3, fileName: 'DATOS-3.xlsx' });
    expect((await counts()).msgs).toBe(msgs);
    await onlyDraftJobs();
  });
});

describe('escenario de 100 destinatarios (envío simulado, sin red)', () => {
  const W = '2026-11-23';                                              // semana en curso respecto del reloj del servidor (no futura)
  const rows = (saldo: (i: number) => number): FRow[] => Array.from({ length: 100 }, (_, k) => {
    const n = k + 1; const id = String(n).padStart(3, '0');
    return { unit: `U${id}`, op: `20${id}`, name: `Conductor${id} Apellido${id}`, wsp: `7000-${String(1000 + n)}`, rate: 30, saldo: saldo(n) };
  });
  const board = async () => ((await call('GET', `/collection/board?weekStart=${W}`)).json() as any[]).filter((r) => /^U\d{3}$/.test(r.unitCode));
  const send = (templateId: string, ids: string[], batchKey: string, repeat = false) => call('POST', '/collection/messages/send', { templateId, assignmentIds: ids, batchKey, repeat });
  const ctx: { tplA?: string; tplB?: string; ids: string[] } = { ids: [] };

  it('importa 100 unidades y deja la tabla lista', async () => {
    const up = await upload(await flat(rows((n) => 10 + (n % 5))), 'CIEN-1.xlsx'); expect(up.statusCode).toBe(201);
    const ap = await call('POST', `/imports/${up.json().importId}/sync-apply`, { weekStart: W, confirmHistorical: true, note: 'escenario 100: semana en curso, anterior a la semana futura del paso 11' });
    expect(ap.statusCode).toBe(200); expect(ap.json().units).toMatchObject({ new: 100, errors: 0 });
    const b = await board(); expect(b).toHaveLength(100); expect(b.every((r) => r.phone && r.messagesToday.length === 0)).toBe(true);
    ctx.ids = b.map((r) => r.assignmentId as string);
    ctx.tplA = (await q1(`insert into public.message_templates(name, body) values ('Plantilla A', 'Hola {{nombre_completo}}, unidad {{unidad}}.') returning id`)).id;
    ctx.tplB = (await q1(`insert into public.message_templates(name, body) values ('Plantilla B', '{{nombre}}: saldo pendiente {{saldo_total}} (unidad {{unidad}}).') returning id`)).id;
  });
  it('1-2. envía la plantilla A a 50 y verifica los indicadores', async () => {
    const first50 = ctx.ids.slice(0, 50);
    const r = await send(ctx.tplA!, first50, 'lote-100-a'); expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ sent: 50, failed: 0 });
    const b = await board(); const sentSet = new Set(first50);
    for (const row of b) {
      if (sentSet.has(row.assignmentId)) expect(row.messagesToday).toMatchObject([{ template: 'Plantilla A', status: 'prepared' }]);
      else expect(row.messagesToday).toEqual([]);
    }
  });
  it('3-4. selecciona los otros 50 y comprueba que no se duplica ningún mensaje (el backend bloquea el reenvío)', async () => {
    const b = await board(); const pending = b.filter((r) => !r.messagesToday.some((m: any) => m.template === 'Plantilla A')).map((r) => r.assignmentId as string);
    expect(pending).toHaveLength(50);
    const rest = await send(ctx.tplA!, pending, 'lote-100-b'); expect(rest.json()).toMatchObject({ sent: 50, failed: 0 });
    // intento accidental de enviar a los 100 otra vez: los 100 ya la recibieron
    const again = await send(ctx.tplA!, ctx.ids, 'lote-100-c');
    expect(again.json()).toMatchObject({ sent: 0, failed: 100 });
    expect(new Set(again.json().results.map((x: any) => x.error))).toEqual(new Set(['already_sent_today']));
    const dup = await q(`select assignment_id, count(*)::int n from public.whatsapp_test_messages where template_name='Plantilla A' and kind='collection_message' group by 1 having count(*) > 1`);
    expect(dup).toEqual([]);
    expect((await q1(`select count(*)::int n from public.whatsapp_test_messages where template_name='Plantilla A'`)).n).toBe(100);
  });
  it('5. historial por día y por lote con sus horarios', async () => {
    const batches = (await call('GET', '/collection/batches')).json() as any[];
    const a = batches.find((x) => x.batchId === 'lote-100-a'); const b = batches.find((x) => x.batchId === 'lote-100-b');
    expect(a).toMatchObject({ total: 50, queued: 50, template: 'Plantilla A' }); expect(b).toMatchObject({ total: 50 });
    expect(batches.find((x) => x.batchId === 'lote-100-c')).toBeUndefined();                       // no se envió nada en el intento duplicado
    const day = (await q1(`select (now() at time zone 'America/Panama')::date::text d`)).d;
    const hist = (await call('GET', '/collection/messages')).json() as any[];
    expect(hist.filter((m) => m.template === 'Plantilla A')).toHaveLength(100);                     // (el día incluye además los mensajes de los pasos anteriores)
    expect(hist.every((m) => m.at && m.body && m.status)).toBe(true);
    expect((await call('GET', '/collection/messages?batch=lote-100-a')).json()).toHaveLength(50);
  });
  it('6-7. reimporta con saldos modificados: el historial queda intacto', async () => {
    const before = await q(`select id, body, created_at, batch_id from public.whatsapp_test_messages order by id`);
    const up = await upload(await flat(rows((n) => 25 + (n % 7))), 'CIEN-2.xlsx'); expect(up.statusCode).toBe(201);
    const pre = await call('GET', `/imports/${up.json().importId}/sync-preview?weekStart=${W}`);
    expect(pre.json().units).toMatchObject({ total: 100, changed: 100, new: 0, errors: 0 });
    expect(pre.json().saldo.adjust).toBe(100);
    const ap = await call('POST', `/imports/${up.json().importId}/sync-apply`, { weekStart: W, confirmHistorical: true, note: 'escenario 100: semana en curso, anterior a la semana futura del paso 11' }); expect(ap.statusCode).toBe(200);
    expect(await q(`select id, body, created_at, batch_id from public.whatsapp_test_messages order by id`)).toEqual(before);
    expect(((await call('GET', '/collection/last-sync')).json() as any).fileName).toBe('CIEN-2.xlsx');
  });
  it('8. envía una plantilla diferente con los datos actualizados', async () => {
    const r = await send(ctx.tplB!, ctx.ids, 'lote-100-d'); expect(r.json()).toMatchObject({ sent: 100, failed: 0 });
    const m = await q1(`select m.body, m.import_id, i.file_name from public.whatsapp_test_messages m join public.excel_imports i on i.id = m.import_id
      join public.assignments a on a.id = m.assignment_id join public.units u on u.id = a.unit_id where u.code = 'U001' and m.template_name = 'Plantilla B'`);
    expect(m.file_name).toBe('CIEN-2.xlsx');
    const expected = (await q1(`select app_private.template_vars(a.id, (now() at time zone 'America/Panama')::date) ->> 'saldo_total' s from public.assignments a join public.units u on u.id = a.unit_id where u.code = 'U001'`)).s;
    expect(m.body).toBe(`Conductor001 Apellido001: saldo pendiente ${expected} (unidad U001).`);   // «nombre» es el nombre COMPLETO del Excel; el saldo = SALDO del Excel (26) + cuotas devengadas de la semana, calculado por la base
    expect(Number(expected.replace(/[^0-9.]/g, ''))).toBeGreaterThanOrEqual(26);                   // saldo 25 + (1 % 7) = 26 → datos de la última importación
    const row = (await board()).find((x) => x.unitCode === 'U001');
    expect(row.messagesToday.map((m: any) => m.template)).toEqual(['Plantilla A', 'Plantilla B']); expect([...new Set(row.messagesToday.map((m: any) => m.template))].sort()).toEqual(['Plantilla A', 'Plantilla B']);
    expect((await q1(`select count(*)::int n from public.whatsapp_test_messages where template_name in ('Plantilla A','Plantilla B')`)).n).toBe(200);
  });
});

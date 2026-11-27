import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MON, key, pay } from './fixtures.js';
import { newDb, type Db } from './harness.js';

let db: Db; let n = 0; let sha = 0;
beforeAll(async () => { db = await newDb(); });
afterAll(async () => { await db.close(); });

const adm = <T>(f: (q: Parameters<Parameters<Db['as']>[1]>[0]) => Promise<T>, uid = db.admin) => db.as(uid, f);
const cnt = async (sql: string, p: unknown[] = []) => Number((await db.su.query(`select count(*) n from (${sql}) t`, p)).rows[0].n);
/** Conductor + unidad con tarifa y UN cargo diario generado solo por el motor (ensure_daily_charges). */
async function engineCase(code: string, unit: string, opts: { phone?: string } = {}) {
  n += 1;
  const x = await db.driverWithAssignment({ code, unit, dailyCents: 4000, phone: opts.phone ?? `+5076888${String(1000 + n)}`, from: '2026-03-01' });
  await adm((q) => q.query(`select public.ensure_daily_charges($1::date, $1::date)`, [MON]));
  return x;
}
const check = (kind: 'driver' | 'unit', id: string, uid = db.admin) =>
  adm((q) => q.one(kind === 'driver' ? `select public.driver_delete_check($1) r` : `select public.unit_delete_check($1) r`, [id]).then((r) => r.r), uid);
async function failWith(fn: () => Promise<unknown>): Promise<{ message: string; detail?: string; code?: string }> {
  try { await fn(); } catch (e) { return e as { message: string; detail?: string; code?: string }; }
  throw new Error('se esperaba un error');
}

describe('eliminar conductor y unidad creados por error', () => {
  it('con 1 cargo diario del motor: se borra todo en el orden correcto y queda UNA fila de auditoría resumida', async () => {
    const x = await engineCase('1234', '4321');
    await db.su.query(`update public.drivers set whatsapp_consent=true, whatsapp_consent_source='verbal_admin' where id=$1`, [x.driver]);
    await db.su.query(`insert into public.driver_consents(driver_id, purpose, granted, source) values ($1,'collection',true,'verbal_admin')`, [x.driver]);
    await db.su.query(`insert into public.notification_jobs(driver_id, kind, local_date, scheduled_for, status) values ($1,'debt_first','2026-03-02',now(),'pending'), ($1,'debt_last','2026-03-02',now(),'cancelled')`, [x.driver]);
    await db.su.query(`insert into public.whatsapp_test_messages(kind, recipient_phone, body, requested_mode, authorized_by, idempotency_key, driver_id, status)
      values ('driver_message','+50760001234','hola','auto',$1,$2,$3,'prepared')`, [db.admin, key(), x.driver]);
    await db.su.query(`update public.units set agreement='Acuerdo de prueba' where id=$1`, [x.unit]);     // historial de acuerdo (inmutable)
    const imp = (await db.su.query(`insert into public.excel_imports(file_name, file_sha256, status, created_by, source_kind) values ('a.xlsx',$1,'applied',$2,'directory') returning id`, [`d-${++sha}`, db.admin])).rows[0].id;
    const blk = (await db.su.query(`insert into public.import_blocks(import_id, block_index, start_column, header_variant) values ($1,1,'A','plantilla') returning id`, [imp])).rows[0].id;
    await db.su.query(`insert into public.import_rows(block_id, source_row, operator_code, matched_driver_id, applied_action) values ($1,2,'1234',$2,'created')`, [blk, x.driver]);

    const c = await check('driver', x.driver);
    expect(c).toMatchObject({ can_delete: true, suggestion: 'delete', blocked_by: [], entity: { operator_code: '1234', archived: false } });
    expect(c.blockers).toMatchObject({ payments: 0, adjustments: 0, closures: 0, non_daily_charges: 0, sent_notifications: 0, sent_messages: 0, in_flight: 0 });
    expect(c.will_delete).toMatchObject({ assignments: 1, daily_charges: 1, rates: 1, exceptions: 0, pending_jobs: 2, consents: 1, unsent_messages: 1, import_rows_unlinked: 1 });
    expect(c.active_assignments).toHaveLength(1);
    expect(await check('unit', x.unit)).toMatchObject({ can_delete: true, will_delete: { assignments: 1, daily_charges: 1, agreement_history: 1 } });

    const before = await cnt(`select 1 from public.audit_logs`);
    const r = await adm((q) => q.one(`select public.delete_driver($1,'creado por error') r`, [x.driver]).then((y) => y.r));
    expect(r).toMatchObject({ deleted: true, kind: 'driver', operator_code: '1234', reason: 'creado por error',
      deleted_counts: { assignments: 1, daily_charges: 1, rates: 1, exceptions: 0, pending_jobs: 2, consents: 1, unsent_messages: 1, import_rows_unlinked: 1 } });
    expect(await cnt(`select 1 from public.drivers where id=$1`, [x.driver])).toBe(0);
    expect(await cnt(`select 1 from public.assignments where driver_id=$1`, [x.driver])).toBe(0);
    expect(await cnt(`select 1 from public.charges where assignment_id=$1`, [x.assignment])).toBe(0);
    expect(await cnt(`select 1 from public.driver_consents where driver_id=$1`, [x.driver])).toBe(0);
    expect(await cnt(`select 1 from public.notification_jobs where driver_id=$1`, [x.driver])).toBe(0);
    expect((await db.su.query(`select matched_driver_id from public.import_rows where operator_code='1234'`)).rows[0].matched_driver_id).toBeNull();
    expect(await cnt(`select 1 from public.units where id=$1`, [x.unit])).toBe(1);                       // la unidad sigue (era otro registro)

    const u = await adm((q) => q.one(`select public.delete_unit($1) r`, [x.unit]).then((y) => y.r));
    expect(u).toMatchObject({ deleted: true, kind: 'unit', code: '4321', reason: null, deleted_counts: { assignments: 0, agreement_history: 1 } });
    expect(await cnt(`select 1 from public.units where id=$1`, [x.unit])).toBe(0);
    expect(await cnt(`select 1 from public.unit_agreement_history where unit_id=$1`, [x.unit])).toBe(0);

    // Auditoría: resumida, con quién/cuándo/motivo/conteos y SIN datos personales (ni siquiera en las filas automáticas de borrado)
    const logs = (await db.su.query(`select actor, action, entity, entity_id, detail, at from public.audit_logs order by id`)).rows
      .filter((l) => (l.entity_id === x.driver || l.entity_id === x.unit) && /delete/.test(l.action));
    const sum = logs.find((l) => l.action === 'delete_driver')!;
    expect(sum).toMatchObject({ actor: db.admin, entity: 'drivers' });
    expect(sum.detail).toMatchObject({ operator_code: '1234', reason: 'creado por error', unit_codes: ['4321'], deleted: { daily_charges: 1, consents: 1 } });
    expect(logs.find((l) => l.action === 'delete_unit')!.detail).toMatchObject({ code: '4321', operator_codes: [] });
    expect(JSON.stringify(logs.filter((l) => l.action === 'delete' || l.action === 'delete_driver'))).not.toMatch(/ID-1234|\+5076888|Conductor/);
    expect(await cnt(`select 1 from public.audit_logs`)).toBeGreaterThan(before);
    // idempotencia: borrar otra vez → not found claro
    expect(await adm((q) => q.fails(`select public.delete_driver($1)`, [x.driver]))).toBe('driver_not_found');
    expect(await adm((q) => q.fails(`select public.delete_unit($1)`, [x.unit]))).toBe('unit_not_found');
    expect(await adm((q) => q.fails(`select public.driver_delete_check($1)`, [x.driver]))).toBe('driver_not_found');
  });

  it('eliminar sin nada asociado, y borrar la unidad con su asignación activa deja al conductor sin unidad', async () => {
    const d = (await db.su.query(`insert into public.drivers(operator_code, national_id, first_name) values ('LIB1','ID-LIB1','Libre') returning id`)).rows[0].id;
    const u = (await db.su.query(`insert into public.units(code) values ('LIBU1') returning id`)).rows[0].id;
    expect(await check('driver', d)).toMatchObject({ can_delete: true, will_delete: { assignments: 0, daily_charges: 0 } });
    expect(await adm((q) => q.one(`select public.delete_driver($1,null) r`, [d]).then((y) => y.r))).toMatchObject({ deleted: true });
    expect(await adm((q) => q.one(`select public.delete_unit($1,'  ') r`, [u]).then((y) => y.r))).toMatchObject({ deleted: true, reason: null });
    const x = await engineCase('ACT1', 'ACTU1');
    const c = await check('unit', x.unit);
    expect(c.active_assignments).toEqual([expect.objectContaining({ assignment_id: x.assignment, operator_code: 'ACT1', unit_code: 'ACTU1', valid_to: null })]);
    await adm((q) => q.query(`select public.delete_unit($1,'unidad duplicada')`, [x.unit]));
    expect(await cnt(`select 1 from public.drivers where id=$1`, [x.driver])).toBe(1);
    expect(await cnt(`select 1 from public.assignments where driver_id=$1`, [x.driver])).toBe(0);
  });

  it('el motivo es opcional pero acotado', async () => {
    const x = await engineCase('MOT1', 'MOTU1');
    expect(await adm((q) => q.fails(`select public.delete_driver($1,$2)`, [x.driver, 'x'.repeat(501)]))).toBe('reason_too_long');
    expect(await cnt(`select 1 from public.drivers where id=$1`, [x.driver])).toBe(1);
  });
});

describe('bloqueado por historial real: NO se elimina, se ofrece archivar', () => {
  async function expectBlocked(x: { driver: string; unit: string }, key_: string) {
    const c = await check('driver', x.driver);
    expect(c).toMatchObject({ can_delete: false, suggestion: 'archive' }); expect(c.blocked_by).toContain(key_); expect(c.blockers[key_]).toBeGreaterThan(0);
    expect(await check('unit', x.unit)).toMatchObject({ can_delete: key_ === 'sent_notifications' || key_ === 'sent_messages' ? true : false });
    const e = await failWith(() => adm((q) => q.query(`select public.delete_driver($1,'prueba')`, [x.driver])));
    expect(e.message).toBe('delete_blocked_has_history'); expect(JSON.parse(e.detail!)[key_]).toBeGreaterThan(0);
    if (!(key_ === 'sent_notifications' || key_ === 'sent_messages'))
      expect((await failWith(() => adm((q) => q.query(`select public.delete_unit($1)`, [x.unit])))).message).toBe('delete_blocked_has_history');
    expect(await cnt(`select 1 from public.drivers where id=$1`, [x.driver])).toBe(1);
    expect(await cnt(`select 1 from public.charges c join public.assignments a on a.id=c.assignment_id where a.driver_id=$1`, [x.driver])).toBeGreaterThan(0);
  }
  it('por un pago (aunque esté anulado)', async () => {
    const x = await engineCase('BP1', 'BPU1');
    const p = await adm((q) => pay(q, x.assignment, 'cash', 3000));
    await expectBlocked(x, 'payments');
    await adm((q) => q.query(`select public.void_payment($1,'error de captura')`, [p.payment_id]));
    await expectBlocked(x, 'payments');
  });
  it('por un ajuste', async () => {
    const x = await engineCase('BA1', 'BAU1');
    await adm((q) => q.query(`select public.create_adjustment($1,500,'2026-03-02','cargo omitido',$2)`, [x.assignment, key()]));
    await expectBlocked(x, 'adjustments');
    expect((await check('driver', x.driver)).blockers.non_daily_charges).toBeGreaterThan(0);        // el cargo del ajuste tampoco es diario
  });
  it('por un cierre semanal', async () => {
    const x = await engineCase('BC1', 'BCU1');
    await adm((q) => q.query(`select public.close_week($1)`, [MON]));
    await expectBlocked(x, 'closures');
  });
  it('por un cargo de apertura (SALDO)', async () => {
    const x = await engineCase('BO1', 'BOU1');
    await db.su.query(`insert into public.charges(assignment_id, kind, charge_date, amount_cents, week_start) values ($1,'opening','2026-03-01',9000,'2026-02-23')`, [x.assignment]);
    await expectBlocked(x, 'non_daily_charges');
    expect((await check('driver', x.driver)).blockers.opening_charges).toBe(1);
  });
  it('por un aviso o mensaje ya ENVIADO (no por los no enviados)', async () => {
    const x = await engineCase('BM1', 'BMU1');
    await db.su.query(`insert into public.notification_jobs(driver_id, kind, local_date, scheduled_for, status, sent_at) values ($1,'debt_first','2026-03-02',now(),'sent',now())`, [x.driver]);
    await expectBlocked(x, 'sent_notifications');
    const y = await engineCase('BM2', 'BMU2');
    for (const st of ['sent', 'delivered', 'unconfirmed']) {
      await db.su.query(`insert into public.whatsapp_test_messages(kind, recipient_phone, body, requested_mode, authorized_by, idempotency_key, driver_id, status)
        values ('driver_message','+50760001234','hola','auto',$1,$2,$3,$4)`, [db.admin, key(), y.driver, st]);
    }
    expect((await check('driver', y.driver)).blockers.sent_messages).toBe(3);
    await expectBlocked(y, 'sent_messages');
  });
  it('un envío en curso (processing) también bloquea: no se borra bajo los pies del worker', async () => {
    const x = await engineCase('BF1', 'BFU1');
    await db.su.query(`insert into public.notification_jobs(driver_id, kind, local_date, scheduled_for, status) values ($1,'debt_first','2026-03-02',now(),'processing')`, [x.driver]);
    expect((await check('driver', x.driver)).blockers.in_flight).toBe(1);
    expect((await failWith(() => adm((q) => q.query(`select public.delete_driver($1)`, [x.driver])))).message).toBe('delete_blocked_has_history');
  });
});

describe('archivar (baja reversible)', () => {
  it('conductor con deuda: cargos intactos, asignación terminada, sin cuotas nuevas, deuda visible en la tabla de cobranza; reactivar', async () => {
    const x = await engineCase('AR1', 'ARU1');
    await adm((q) => pay(q, x.assignment, 'cash', 1000));             // hay historial real (un pago) y deuda pendiente
    const ids = (await db.su.query(`select id from public.charges where assignment_id=$1 order by id`, [x.assignment])).rows.map((r) => r.id);
    const pos = async () => (await adm((q) => q.one(`select pending_cents::int p from public.assignment_position($1)`, [x.assignment]))).p;
    const debt = await pos(); expect(debt).toBeGreaterThanOrEqual(3000);
    const r = await adm((q) => q.one(`select public.archive_driver($1,'baja voluntaria') r`, [x.driver]).then((y) => y.r));
    expect(r).toMatchObject({ archived: true, kind: 'driver', status: 'inactive', previous_status: 'active', reason: 'baja voluntaria' });
    expect(r.ended_assignments).toHaveLength(1);
    expect(r.pending_cents).toBe(await pos());
    // los cargos originales siguen idénticos; la deuda sigue ahí
    expect((await db.su.query(`select id from public.charges where assignment_id=$1 and id = any($2::uuid[]) order by id`, [x.assignment, ids])).rows.map((q) => q.id)).toEqual(ids);
    const asg = (await db.su.query(`select valid_to::text vt from public.assignments where id=$1`, [x.assignment])).rows[0];
    expect(asg.vt).toBe(r.ended_assignments[0].valid_to);
    expect((await db.su.query(`select status, active from public.drivers where id=$1`, [x.driver])).rows[0]).toEqual({ status: 'inactive', active: false });
    // sin cuotas nuevas tras la baja, ni por el motor ni por el generador manual
    const total = await cnt(`select 1 from public.charges where assignment_id=$1`, [x.assignment]);
    const e = await adm((q) => q.one(`select public.ensure_daily_charges() r`).then((y) => y.r));
    await adm((q) => q.query(`select public.generate_daily_charges(current_date)`));
    expect(await cnt(`select 1 from public.charges where assignment_id=$1`, [x.assignment])).toBe(total);
    expect(e.gaps.filter((g: { assignment_id: string }) => g.assignment_id === x.assignment)).toEqual([]);
    // la tabla de cobranza lo sigue mostrando (semana de la baja) con su deuda y su estado
    const monday = (await db.su.query(`select app_private.week_start_of($1::date)::text d`, [asg.vt])).rows[0].d;
    const row = (await adm((q) => q.rows(`select * from public.weekly_collection_table($1)`, [monday]))).find((t) => t.operator_code === 'AR1');
    expect(row).toMatchObject({ driver_status: 'inactive', pending_cents: String(await pos()) });
    expect(Number(row.pending_cents)).toBeGreaterThan(0);
    await adm((q) => q.query(`select public.weekly_collection_detail($1)`, [monday]));
    // idempotencia / errores claros
    expect(await adm((q) => q.fails(`select public.archive_driver($1)`, [x.driver]))).toBe('already_archived');
    expect(await check('driver', x.driver)).toMatchObject({ can_delete: false, entity: { status: 'inactive', archived: true } });
    // reactivar (reversible): vuelve a active, la deuda y el historial siguen
    const re = await adm((q) => q.one(`select public.reactivate_driver($1,'regresó') r`, [x.driver]).then((y) => y.r));
    expect(re).toMatchObject({ reactivated: true, status: 'active', has_active_assignment: false });
    expect(await pos()).toBe(r.pending_cents);
    expect(await adm((q) => q.fails(`select public.reactivate_driver($1)`, [x.driver]))).toBe('not_archived');
    const acts = (await db.su.query(`select action, actor from public.audit_logs where entity_id=$1 and action in ('archive_driver','reactivate_driver') order by id`, [x.driver])).rows;
    expect(acts).toEqual([{ action: 'archive_driver', actor: db.admin }, { action: 'reactivate_driver', actor: db.admin }]);
  });

  it('la baja completa primero las cuotas vencidas de la ventana (no se pierde deuda ya devengada) y cancela envíos pendientes', async () => {
    n += 1;
    const x = await db.driverWithAssignment({ code: 'AR2', unit: 'ARU2', dailyCents: 1000, from: '2026-11-01' });     // hoy ≈ 2026-11-16, sin motor ejecutado
    await db.su.query(`insert into public.notification_jobs(driver_id, kind, local_date, scheduled_for, status) values ($1,'debt_first','2026-11-10',now(),'pending')`, [x.driver]);
    const r = await adm((q) => q.one(`select public.archive_driver($1) r`, [x.driver]).then((y) => y.r));
    expect(r.charges_completed).toBeGreaterThan(0);
    expect(r.cancelled_jobs).toBe(1);
    expect(await cnt(`select 1 from public.charges where assignment_id=$1 and kind='daily'`, [x.assignment])).toBe(r.charges_completed);
    expect(await cnt(`select 1 from public.charges where assignment_id=$1 and charge_date > current_date`, [x.assignment])).toBe(0);
  });

  it('unidad con asignación activa: out_of_service, asignación terminada, deuda intacta; reactivar', async () => {
    const x = await engineCase('AU1', 'AUU1');
    const c0 = await cnt(`select 1 from public.charges where assignment_id=$1`, [x.assignment]);
    const r = await adm((q) => q.one(`select public.archive_unit($1,'fuera de servicio') r`, [x.unit]).then((y) => y.r));
    expect(r).toMatchObject({ archived: true, kind: 'unit', vehicle_status: 'out_of_service', active: false });
    expect(r.ended_assignments).toHaveLength(1);
    expect((await db.su.query(`select active from public.units where id=$1`, [x.unit])).rows[0].active).toBe(false);
    expect((await db.su.query(`select valid_to from public.assignments where id=$1`, [x.assignment])).rows[0].valid_to).not.toBeNull();
    expect(await cnt(`select 1 from public.charges where assignment_id=$1`, [x.assignment])).toBeGreaterThanOrEqual(c0);
    await adm((q) => q.query(`select public.ensure_daily_charges()`));
    expect(await adm((q) => q.fails(`select public.archive_unit($1)`, [x.unit]))).toBe('already_archived');
    expect(await adm((q) => q.one(`select public.reactivate_unit($1) r`, [x.unit]).then((y) => y.r))).toMatchObject({ reactivated: true, vehicle_status: 'active', has_active_assignment: false });
    expect(await adm((q) => q.fails(`select public.reactivate_unit($1)`, [x.unit]))).toBe('not_archived');
    expect(await cnt(`select 1 from public.audit_logs where entity_id=$1 and action in ('archive_unit','reactivate_unit')`, [x.unit])).toBe(2);
  });

  it('una fecha efectiva anterior a cuotas ya generadas se rechaza sin cambiar nada', async () => {
    const x = await engineCase('AD1', 'ADU1');
    expect(await adm((q) => q.fails(`select public.archive_driver($1,null,'2026-03-01')`, [x.driver]))).toBe('invalid_dates');
    expect((await db.su.query(`select status from public.drivers where id=$1`, [x.driver])).rows[0].status).toBe('active');
  });

  it('weekly_collection_table/detail y ensure_daily_charges siguen funcionando con archivados', async () => {
    await adm((q) => q.query(`select * from public.weekly_collection_table($1)`, [MON]));
    await adm((q) => q.query(`select * from public.weekly_collection_detail($1)`, [MON]));
    const e = await adm((q) => q.one(`select public.ensure_daily_charges() r`).then((y) => y.r));
    expect(e).toHaveProperty('created');
    await adm((q) => q.query(`select * from public.charge_gaps()`));
  });
});

describe('la inmutabilidad no se puede saltar desde un cliente', () => {
  it('ni authenticated, ni service_role, ni con el indicador; el propietario sin indicador tampoco', async () => {
    const x = await engineCase('IM1', 'IMU1');
    await db.su.query(`insert into public.driver_consents(driver_id, purpose, granted, source) values ($1,'collection',true,'verbal_admin')`, [x.driver]);
    await db.su.query(`update public.units set agreement='A' where id=$1`, [x.unit]);
    const targets = [`delete from public.charges where assignment_id='${x.assignment}'`, `delete from public.driver_consents where driver_id='${x.driver}'`,
      `delete from public.unit_agreement_history where unit_id='${x.unit}'`];
    for (const flag of [false, true]) {
      for (const sql of targets) {
        // authenticated: sin permiso DELETE
        expect(await adm(async (q) => { if (flag) await q.query(`select set_config('vip.cascade_delete','on',true)`); return q.fails(sql); })).toMatch(/permission denied|no permitido/);
        // service_role: TIENE permiso sobre la tabla → lo detiene el disparador aunque ponga el indicador
        expect(await db.asService(async (q) => { if (flag) await q.query(`select set_config('vip.cascade_delete','on',true)`); return q.fails(sql); })).toMatch(/no permitido/);
      }
    }
    // el propietario (superusuario) sin indicador sigue bloqueado
    for (const sql of targets) expect(await db.su.query(sql).then(() => null, (e) => e.message)).toMatch(/no permitido/);
    // authenticated con permiso DELETE concedido explícitamente + indicador: sigue bloqueado por current_user ≠ propietario
    await db.su.query(`grant delete on public.charges, public.driver_consents, public.unit_agreement_history to authenticated`);
    try {
      // (la RLS ya filtra todas las filas: 0 borradas sin error; el recuento de abajo lo confirma)
      for (const sql of targets) expect(await adm(async (q) => { await q.query(`select set_config('vip.cascade_delete','on',true)`); return q.fails(sql); })).toSatisfy((m: string | null) => m === null || /no permitido/.test(m));
    } finally { await db.su.query(`revoke delete on public.charges, public.driver_consents, public.unit_agreement_history from authenticated`); }
    expect(await cnt(`select 1 from public.charges where assignment_id=$1`, [x.assignment])).toBe(1);
    expect(await cnt(`select 1 from public.driver_consents where driver_id=$1`, [x.driver])).toBe(1);
    expect(await cnt(`select 1 from public.unit_agreement_history where unit_id=$1`, [x.unit])).toBe(1);
    // UPDATE sigue prohibido para todos, incluso con el indicador
    expect(await db.su.query(`select set_config('vip.cascade_delete','on',false)`).then(() => db.su.query(`update public.charges set amount_cents=1`)).then(() => null, (e) => e.message)).toMatch(/no permitido/);
    await db.su.query(`select set_config('vip.cascade_delete','off',false)`);
  });

  it('pagos, ajustes, asignaciones de pago, cierres, auditoría y cargos no diarios NUNCA se borran, ni con el indicador y siendo propietario', async () => {
    const x = await engineCase('IM2', 'IMU2');
    await adm((q) => pay(q, x.assignment, 'cash', 4000));
    await adm((q) => q.query(`select public.create_adjustment($1,500,'2026-03-02','cargo omitido',$2)`, [x.assignment, key()]));
    await adm((q) => q.query(`select public.close_week($1)`, [MON]));
    await db.su.query(`select set_config('vip.cascade_delete','on',false)`);
    try {
      for (const t of ['payments', 'payment_allocations', 'adjustments', 'weekly_closures', 'audit_logs'])
        expect(await db.su.query(`delete from public.${t}`).then(() => null, (e) => e.message)).toMatch(/no permitido/);
      expect(await db.su.query(`delete from public.charges where kind <> 'daily'`).then(() => null, (e) => e.message)).toMatch(/no permitido/);
      expect(await db.su.query(`delete from public.charges where id in (select charge_id from public.payment_allocations)`).then(() => null, (e) => e.message)).toBeTruthy();
    } finally { await db.su.query(`select set_config('vip.cascade_delete','off',false)`); }
  });

  it('quedan solo las FK conocidas hacia conductores, unidades y asignaciones (si aparece una nueva, esta prueba obliga a revisar delete_*)', async () => {
    const fks = (await db.su.query(`select conrelid::regclass::text t, conname from pg_constraint where contype='f' and confrelid in ('public.drivers'::regclass,'public.units'::regclass,'public.assignments'::regclass) order by 1,2`)).rows;
    // 0026 (revisado): excel_payment_days / excel_payment_changes (FK a asignación y conductor) solo existen si hubo un pago (vigente o anulado) de esa asignación,
    // y `payments` ya bloquea delete_* (delete_blocked_has_history); no hace falta tocar delete_*. collection_week_* no tienen FK a propósito.
    // 0027 (revisado): whatsapp_test_messages.assignment_id (`on delete set null`); delete_driver ya borra los mensajes por driver_id.
    expect(fks.map((f) => f.t).sort()).toEqual(['adjustments', 'assignments', 'assignments', 'charges', 'driver_consents', 'excel_payment_changes', 'excel_payment_changes',
      'excel_payment_days', 'excel_payment_days', 'import_rows', 'notification_jobs', 'payments',
      'rate_corrections', 'rate_exceptions', 'rates', 'unit_agreement_history', 'weekly_closures', 'whatsapp_test_messages', 'whatsapp_test_messages'].sort());
  });
});

describe('permisos', () => {
  it('ADMIN y SUPER_ADMIN sí; supervisor, usuario sin rol y anon no', async () => {
    const calls = (id: string, unit: string) => [`select public.driver_delete_check('${id}')`, `select public.unit_delete_check('${unit}')`, `select public.delete_driver('${id}')`, `select public.delete_unit('${unit}')`,
      `select public.archive_driver('${id}')`, `select public.archive_unit('${unit}')`, `select public.reactivate_driver('${id}')`, `select public.reactivate_unit('${unit}')`];
    const x = await engineCase('PE1', 'PEU1');
    for (const uid of [db.supervisor, db.outsider]) for (const s of calls(x.driver, x.unit)) expect(await db.as(uid, (q) => q.fails(s))).toBe('forbidden');
    for (const s of calls(x.driver, x.unit)) expect(await db.asAnon((q) => q.fails(s))).toMatch(/permission denied/);
    expect(await cnt(`select 1 from public.drivers where id=$1`, [x.driver])).toBe(1);
    expect(await check('driver', x.driver, db.opsAdmin)).toMatchObject({ can_delete: true });
    expect(await check('driver', x.driver, db.admin)).toMatchObject({ can_delete: true });
    expect(await adm((q) => q.one(`select public.delete_driver($1) r`, [x.driver]).then((y) => y.r), db.opsAdmin)).toMatchObject({ deleted: true });
    const y = await engineCase('PE2', 'PEU2');
    expect(await adm((q) => q.one(`select public.delete_unit($1) r`, [y.unit]).then((r) => r.r), db.admin)).toMatchObject({ deleted: true });
    // service_role sin sesión de usuario: no hay identidad ADMIN+
    expect(await db.asService((q) => q.fails(`select public.delete_driver('${y.driver}')`))).toBe('not_authenticated');
  });
  it('las funciones son security definer con search_path vacío y sin acceso para anon/public', async () => {
    const f = (await db.su.query(`select p.proname, p.prosecdef, p.proconfig, has_function_privilege('anon', p.oid,'execute') anon, has_function_privilege('public', p.oid,'execute') pub, has_function_privilege('authenticated', p.oid,'execute') auth
      from pg_proc p where p.pronamespace='public'::regnamespace and p.proname in ('driver_delete_check','unit_delete_check','delete_driver','delete_unit','archive_driver','archive_unit','reactivate_driver','reactivate_unit')`)).rows;
    expect(f).toHaveLength(8);
    for (const r of f) { expect(r).toMatchObject({ prosecdef: true, anon: false, pub: false, auth: true }); expect(r.proconfig).toContain('search_path=""'); }
  });
});

describe('reimportación posterior', () => {
  async function stage(rows: Array<{ op: string; unit: string; status?: string }>) {
    const imp = (await db.su.query(`insert into public.excel_imports(file_name, file_sha256, status, created_by, source_kind) values ('re.xlsx',$1,'confirmed',$2,'directory') returning id`, [`r-${++sha}`, db.admin])).rows[0].id;
    const blk = (await db.su.query(`insert into public.import_blocks(import_id, block_index, start_column, header_variant) values ($1,1,'A','plantilla') returning id`, [imp])).rows[0].id;
    let k = 1;
    for (const r of rows) await db.su.query(`insert into public.import_rows(block_id, source_row, unit_code, operator_code, national_id, full_name, first_name, daily_rate_cents, match_status, review_status, row_status)
      values ($1,$2,$3,$4,$5,'Reimportado','Reimportado',4000,'matched','approved',$6)`, [blk, ++k, r.unit, r.op, `ID-${r.op}`, r.status ?? null]);
    return imp as string;
  }
  const apply = (imp: string) => adm((q) => q.one(`select public.apply_directory_import($1,'2026-03-02'::date,'active',false) r`, [imp]).then((y) => y.r), db.opsAdmin);

  it('lo ELIMINADO se vuelve a crear como nuevo (sin referencias que lo impidan)', async () => {
    const imp0 = await stage([{ op: 'RE1', unit: 'REU1' }]); await apply(imp0);
    const old = (await db.su.query(`select id from public.drivers where operator_code='RE1'`)).rows[0].id;
    const oldUnit = (await db.su.query(`select id from public.units where code='REU1'`)).rows[0].id;
    await adm((q) => q.query(`select public.delete_driver($1)`, [old])); await adm((q) => q.query(`select public.delete_unit($1)`, [oldUnit]));
    const r = await apply(await stage([{ op: 'RE1', unit: 'REU1' }]));
    expect(r).toMatchObject({ drivers_created: 1, units_created: 1, assignments_created: 1, rows_rejected: 0 });
    expect((await db.su.query(`select id from public.drivers where operator_code='RE1'`)).rows[0].id).not.toBe(old);
  });
  it('lo ARCHIVADO conserva su identidad: se concilia sin duplicar ni fallar y NO se reactiva solo', async () => {
    await apply(await stage([{ op: 'RE2', unit: 'REU2' }]));
    const d = (await db.su.query(`select id from public.drivers where operator_code='RE2'`)).rows[0].id;
    const u = (await db.su.query(`select id from public.units where code='REU2'`)).rows[0].id;
    await adm((q) => q.query(`select public.archive_driver($1)`, [d])); await adm((q) => q.query(`select public.archive_unit($1)`, [u]));
    const r = await apply(await stage([{ op: 'RE2', unit: 'REU2' }]));
    // La asignación terminada hoy se solapa con la nueva (misma fecha): la fila se RECHAZA con nota, sin crear duplicados ni romper la importación
    expect(r).toMatchObject({ drivers_created: 0, units_created: 0, assignments_created: 0, rows_rejected: 1 });
    expect((await db.su.query(`select applied_note from public.import_rows where operator_code='RE2' and applied_action='rejected'`)).rows.map((x) => x.applied_note)).toEqual([expect.stringMatching(/no se pudo aplicar/)]);
    expect(await cnt(`select 1 from public.drivers where operator_code='RE2'`)).toBe(1);
    expect(await cnt(`select 1 from public.units where code='REU2'`)).toBe(1);
    expect((await db.su.query(`select status from public.drivers where id=$1`, [d])).rows[0].status).toBe('inactive');
    expect((await db.su.query(`select vehicle_status from public.units where id=$1`, [u])).rows[0].vehicle_status).toBe('out_of_service');
    // sin cuotas mientras siga archivado; reactivar es una decisión explícita
    const total = () => cnt(`select 1 from public.charges c join public.assignments a on a.id=c.assignment_id where a.driver_id=$1`, [d]);
    const before = await total();
    await adm((q) => q.query(`select public.ensure_daily_charges()`));
    expect(await total()).toBe(before);
  });
});

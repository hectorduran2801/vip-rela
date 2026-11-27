import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { MON } from './fixtures.js';
import { newDb, type Db, type Q } from './harness.js';
import { MIGRATIONS_DIR, STUB_SQL, connConfig } from './pg-cluster.js';

// arming: true → SIN el trigger de pruebas que anula armed_at: aquí se prueba el comportamiento real de 0025 con el reloj real.
let db: Db; let n = 0;
beforeAll(async () => { db = await newDb({ arming: true }); });
afterAll(async () => { await db.close(); });

const adm = <T>(fn: (q: Q) => Promise<T>) => db.as(db.admin, fn);
const ops = <T>(fn: (q: Q) => Promise<T>) => db.as(db.opsAdmin, fn);
const svc = <T>(fn: (q: Q) => Promise<T>) => db.asService(fn);
const at = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00-05:00`).toISOString();
async function err(who: <T>(f: (q: Q) => Promise<T>) => Promise<unknown>, sql: string, params: unknown[] = []) {
  try { await who(async (q) => { await q.query(sql, params); }); return null; }
  catch (e) { const x = e as { message: string; code: string; detail?: string }; return { message: x.message, code: x.code, detail: x.detail }; }
}
// Hora local de Panamá (UTC-5 todo el año). Las pruebas con reloj real se omiten cerca de la medianoche.
const panamaMinutes = () => { const d = new Date(Date.now() - 5 * 3600_000); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
const NEAR_MIDNIGHT = panamaMinutes() < 15 || panamaMinutes() > 1425;
const hhmmAt = (offsetMin: number) => { const d = new Date(Date.now() - 5 * 3600_000 + offsetMin * 60_000); return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`; };
const plus = (min: number) => new Date(Date.now() + min * 60_000).toISOString();
const ALL = '{1,2,3,4,5,6,7}';
const mkTpl = async (name: string, body = 'Hola {{nombre_completo}}. {{detalle_deuda}}') =>
  (await db.su.query(`insert into public.message_templates(name, body) values ($1,$2) returning id`, [name, body])).rows[0].id as string;
/** Horario nuevo creado como lo haría un cliente (desactivado). */
async function mkSched(opts: { time: string; tpl?: string | null; kind?: string; scope?: string; weekdays?: string }) {
  n += 1;
  return (await adm((q) => q.one(`insert into public.notification_schedules(kind,label,local_time,weekdays,scope,template_id) values ($1,$2,$3,$4,$5,$6) returning *`,
    [opts.kind ?? 'debt_reminder', `Horario X${n}`, opts.time, opts.weekdays ?? ALL, opts.scope ?? 'total', opts.tpl ?? null]))) as { id: string; enabled: boolean; armed_at: string | null; label: string };
}
const row = async (id: string) => (await db.su.query(`select * from public.notification_schedules where id=$1`, [id])).rows[0];
async function mkDriver(opts: { charge?: number | null; consent?: boolean; phone?: string | null; status?: string } = {}) {
  n += 1;
  const x = await db.driverWithAssignment({ code: `EA${n}`, unit: `EAU${n}`, dailyCents: 4000, phone: opts.phone === null ? undefined : (opts.phone ?? `+507604${String(10000 + n)}`),
    consent: opts.consent ?? true, status: opts.status });
  if (opts.charge !== null) await db.su.query(`insert into public.charges(assignment_id, kind, charge_date, amount_cents, week_start) values ($1,'daily',$2,$3,app_private.week_start_of($2::date))`, [x.assignment, MON, opts.charge ?? 4000]);
  return x;
}
const jobsOf = async (sid: string) => (await db.su.query(`select * from public.notification_jobs where schedule_id=$1`, [sid])).rows;
const remind = async (now: string, grace = '60 minutes') => (await db.su.query(`select public.schedule_reminders($1, $2::interval) c`, [now, grace])).rows[0].c as number;
/** Ejecuta un ciclo del planificador y devuelve los trabajos de ESTE horario (otros horarios de la base compartida no cuentan). */
const fire = async (sid: string, now: string) => { await remind(now); return (await jobsOf(sid)).length; };
const audits = async (action: string, id: string) => (await db.su.query(`select * from public.audit_logs where action=$1 and entity_id=$2`, [action, id])).rows;

describe('1 · activación explícita e independiente', () => {
  it('crear un horario nace desactivado; un cliente no puede crearlo activo (ni con plantilla)', async () => {
    const t = await mkTpl('ea-t1');
    const s = await mkSched({ time: '10:00', tpl: t });
    expect(s.enabled).toBe(false);
    for (const who of [adm, ops]) {
      const e = await err(who, `insert into public.notification_schedules(kind,label,local_time,weekdays,enabled,template_id) values ('debt_reminder','Activo ya',$1,$2,true,$3)`, ['10:00', ALL, t]);
      expect(e).toMatchObject({ message: 'direct_activation_forbidden', code: '42501' });
    }
    expect((await db.su.query(`select 1 from public.notification_schedules where label='Activo ya'`)).rowCount).toBe(0);
  });
  it('UPDATE directo enabled=true por authenticated se rechaza, incluso con plantilla, y el indicador local no sirve (no es falsificable)', async () => {
    const t = await mkTpl('ea-t2'); const s = await mkSched({ time: '10:01', tpl: t });
    for (const who of [adm, ops]) {
      expect(await err(who, `update public.notification_schedules set enabled=true where id=$1`, [s.id])).toMatchObject({ message: 'direct_activation_forbidden', code: '42501' });
      expect(await err(who, `update public.notification_schedules set enabled=true where id=$1 and set_config('vip.schedule_activation','on',true) = 'on'`, [s.id])).toMatchObject({ message: 'direct_activation_forbidden' });
    }
    expect((await row(s.id)).enabled).toBe(false);
  });
  it('activate_schedule: sin confirmación (false/omitida) se rechaza; con confirmación activa, fija armed_at y deja auditoría con actor', async () => {
    const t = await mkTpl('ea-t3'); const s = await mkSched({ time: '10:02', tpl: t });
    expect(await adm((q) => q.fails(`select public.activate_schedule($1)`, [s.id]))).toBe('activation_not_confirmed');
    expect(await adm((q) => q.fails(`select public.activate_schedule($1, false)`, [s.id]))).toBe('activation_not_confirmed');
    expect(await adm((q) => q.fails(`select public.activate_schedule($1, null)`, [s.id]))).toBe('activation_not_confirmed');
    expect((await row(s.id)).enabled).toBe(false);
    const r = (await adm((q) => q.one(`select public.activate_schedule($1, true) r`, [s.id]))).r;
    expect(r).toMatchObject({ id: s.id, enabled: true });
    const after = await row(s.id);
    expect(after.enabled).toBe(true);
    expect(Math.abs(new Date(after.armed_at).getTime() - Date.now())).toBeLessThan(60_000);
    const a = await audits('schedule_activated', s.id);
    expect(a).toHaveLength(1);
    expect(a[0].actor).toBe(db.admin);
    expect(a[0].detail).toMatchObject({ schedule_id: s.id, template_id: t, confirmed: true, activated_by: db.admin, kind: 'debt_reminder', scope: 'total' });
    expect(a[0].detail.uses_variables).toEqual(['detalle_deuda', 'nombre_completo']);
  });
  it('sin plantilla → template_required; plantilla con variables desconocidas → template_has_unresolved_variables (lista en el detalle)', async () => {
    const s = await mkSched({ time: '10:03' });
    expect(await err(adm, `select public.activate_schedule($1, true)`, [s.id])).toMatchObject({ message: 'template_required', code: '23514' });
    const t = await mkTpl('ea-bad', 'Hola {{nombre}} {{foo}} {{ bar }} {{}}');
    await adm((q) => q.query(`update public.notification_schedules set template_id=$2 where id=$1`, [s.id, t]));
    const e = await err(adm, `select public.activate_schedule($1, true)`, [s.id]);
    expect(e).toMatchObject({ message: 'template_has_unresolved_variables' });
    expect((e as { detail: string }).detail).toContain('{{foo}}'); expect((e as { detail: string }).detail).toContain('{{bar}}'); expect((e as { detail: string }).detail).toContain('{{(vacía)}}');
    expect((e as { detail: string }).detail).not.toContain('{{nombre}}');
    expect((await row(s.id)).enabled).toBe(false);
    expect(await audits('schedule_activated', s.id)).toHaveLength(0);
  });
  it('doble activación → already_active; horario inexistente → schedule_not_found', async () => {
    const t = await mkTpl('ea-t4'); const s = await mkSched({ time: '10:04', tpl: t });
    await adm((q) => q.query(`select public.activate_schedule($1, true)`, [s.id]));
    expect(await adm((q) => q.fails(`select public.activate_schedule($1, true)`, [s.id]))).toBe('already_active');
    expect(await adm((q) => q.fails(`select public.activate_schedule($1, true)`, [randomUUID()]))).toBe('schedule_not_found');
    expect(await adm((q) => q.fails(`select public.schedule_activation_preview($1)`, [randomUUID()]))).toBe('schedule_not_found');
    expect(await audits('schedule_activated', s.id)).toHaveLength(1);
  });
  it('desactivar: UPDATE directo a false sigue permitido; deactivate_schedule audita y es idempotente', async () => {
    const t = await mkTpl('ea-t5'); const s = await mkSched({ time: '10:05', tpl: t });
    await adm((q) => q.query(`select public.activate_schedule($1, true)`, [s.id]));
    expect(await err(adm, `update public.notification_schedules set enabled=false where id=$1`, [s.id])).toBeNull();
    await ops((q) => q.query(`select public.activate_schedule($1, true)`, [s.id]));
    const r = (await adm((q) => q.one(`select public.deactivate_schedule($1) r`, [s.id]))).r;
    expect(r).toEqual({ id: s.id, enabled: false, changed: true });
    expect((await row(s.id)).enabled).toBe(false);
    const a = await audits('schedule_deactivated', s.id);
    expect(a).toHaveLength(1); expect(a[0].actor).toBe(db.admin);
    expect((await adm((q) => q.one(`select public.deactivate_schedule($1) r`, [s.id]))).r).toEqual({ id: s.id, enabled: false, changed: false });
    expect(await audits('schedule_deactivated', s.id)).toHaveLength(1);
    expect(await adm((q) => q.fails(`select public.deactivate_schedule($1)`, [randomUUID()]))).toBe('schedule_not_found');
  });
  it('editar hora/días/ámbito/etiqueta, asignar plantilla, crear plantilla del texto base o editar la plantilla NO activa nada', async () => {
    const t = await mkTpl('ea-t6'); const s = await mkSched({ time: '10:06' });
    await adm((q) => q.query(`update public.notification_schedules set local_time='10:30', weekdays='{1,2}', scope='today', label=label||' v2' where id=$1`, [s.id]));
    await adm((q) => q.query(`update public.notification_schedules set template_id=$2 where id=$1`, [s.id, t]));
    await adm((q) => q.query(`update public.message_templates set body='Otro texto {{nombre}}' where id=$1`, [t]));
    await adm((q) => q.query(`select public.create_template_from_default('debt_first', 'ea-base', $1)`, [s.id]));
    expect((await row(s.id)).enabled).toBe(false);
    expect((await db.su.query(`select count(*)::int c from public.notification_schedules where enabled and id=$1`, [s.id])).rows[0].c).toBe(0);
  });
  it('permisos: ADMIN y SUPER_ADMIN sí; outsider, supervisor y anon no', async () => {
    const t = await mkTpl('ea-t7'); const s = await mkSched({ time: '10:07', tpl: t });
    for (const sql of [`select public.activate_schedule($1, true)`, `select public.deactivate_schedule($1)`, `select public.schedule_activation_preview($1)`]) {
      expect(await db.as(db.outsider, (q) => q.fails(sql, [s.id]))).toBe('forbidden');
      expect(await db.as(db.supervisor, (q) => q.fails(sql, [s.id]))).toBe('forbidden');
      expect(await db.asAnon((q) => q.fails(sql, [s.id]))).toMatch(/permission denied/);
    }
    expect((await row(s.id)).enabled).toBe(false);
    await ops((q) => q.query(`select public.activate_schedule($1, true)`, [s.id]));
    await adm((q) => q.query(`select public.deactivate_schedule($1)`, [s.id]));
    await adm((q) => q.query(`select public.activate_schedule($1, true)`, [s.id]));
    expect((await row(s.id)).enabled).toBe(true);
  });
  it('service_role/superusuario conservan la activación directa (mantenimiento y pruebas anteriores)', async () => {
    const t = await mkTpl('ea-t8'); const s = await mkSched({ time: '10:08', tpl: t });
    expect(await err(svc, `update public.notification_schedules set enabled=true where id=$1`, [s.id])).toBeNull();
    expect((await row(s.id)).enabled).toBe(true);
  });
});

describe('2 · armed_at: nada se pone al día tras un cambio', () => {
  it('el trigger fija armed_at solo cuando cambia enabled/kind/hora/días/plantilla/ámbito; un cliente no puede fijarlo a mano', async () => {
    const t = await mkTpl('ea-a1'); const s = await mkSched({ time: '10:10', tpl: t });
    expect(s.armed_at).not.toBeNull();
    await db.su.query(`update public.notification_schedules set armed_at='2026-01-01T00:00:00Z' where id=$1`, [s.id]);        // mantenimiento
    const base = (await row(s.id)).armed_at as Date;
    expect(base.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    await adm((q) => q.query(`update public.notification_schedules set label=label||'!' where id=$1`, [s.id]));              // etiqueta: no arma
    expect(((await row(s.id)).armed_at as Date).toISOString()).toBe('2026-01-01T00:00:00.000Z');
    await adm((q) => q.query(`update public.notification_schedules set armed_at='2020-01-01' where id=$1`, [s.id]));         // cliente: ignorado
    expect(((await row(s.id)).armed_at as Date).toISOString()).toBe('2026-01-01T00:00:00.000Z');
    for (const set of [`local_time='10:40'`, `weekdays='{1,2,3}'`, `scope='today'`, `template_id=null`, `kind='debt_first'`]) {
      await db.su.query(`update public.notification_schedules set armed_at='2026-01-01T00:00:00Z' where id=$1`, [s.id]);
      await adm((q) => q.query(`update public.notification_schedules set ${set} where id=$1`, [s.id]));
      expect(Math.abs(((await row(s.id)).armed_at as Date).getTime() - Date.now()), set).toBeLessThan(60_000);
    }
    await db.su.query(`update public.notification_schedules set armed_at='2026-01-01T00:00:00Z' where id=$1`, [s.id]);
    await svc((q) => q.query(`update public.notification_schedules set enabled=true, template_id=$2 where id=$1`, [s.id, t]));
    expect(Math.abs(((await row(s.id)).armed_at as Date).getTime() - Date.now())).toBeLessThan(60_000);
  });
  it('horario sin plantilla, desactivado, o con plantilla asignada pero desactivado: NUNCA crea trabajos', async () => {
    await mkDriver();
    const t = await mkTpl('ea-a2');
    const noTpl = await mkSched({ time: '11:00' }); const off = await mkSched({ time: '11:00', tpl: t });
    await db.su.query(`alter table public.notification_schedules disable trigger guard_template`);      // simula datos anteriores a 0024: activo sin plantilla
    try { await db.su.query(`update public.notification_schedules set enabled=true where id=$1`, [noTpl.id]); } finally { await db.su.query(`alter table public.notification_schedules enable trigger guard_template`); }
    await db.su.query(`update public.notification_schedules set armed_at='2026-01-01' where id in ($1,$2)`, [noTpl.id, off.id]);
    expect(await remind(at(MON, '11:05'))).toBeGreaterThanOrEqual(0);
    expect(await jobsOf(noTpl.id)).toHaveLength(0); expect(await jobsOf(off.id)).toHaveLength(0);
  });
  it('activar a las 4:30 un horario de las 4:20 NO envía hoy; sí el siguiente día', async () => {
    const d = await mkDriver(); const t = await mkTpl('ea-a3');
    const s = await mkSched({ time: '16:20', tpl: t });
    await db.su.query(`update public.notification_schedules set enabled=true where id=$1`, [s.id]);
    await db.su.query(`update public.notification_schedules set armed_at=$2 where id=$1`, [s.id, at('2026-03-02', '16:30')]);   // «activado a las 4:30 p. m.»
    expect(await remind(at('2026-03-02', '16:31'))).toBe(0);
    expect(await jobsOf(s.id)).toHaveLength(0);
    expect(await remind(at('2026-03-03', '16:21'))).toBeGreaterThanOrEqual(1);
    expect((await jobsOf(s.id)).map((j) => j.driver_id)).toContain(d.driver);
  });
  it('activate_schedule real con la hora ya pasada: no dispara hoy (reloj real)', { skip: NEAR_MIDNIGHT }, async () => {
    await mkDriver(); const t = await mkTpl('ea-a4');
    const s = await mkSched({ time: hhmmAt(-3), tpl: t });                              // la ocurrencia de hoy ya pasó (hace 3 min)
    await adm((q) => q.query(`select public.activate_schedule($1, true)`, [s.id]));
    expect(await fire(s.id, plus(1))).toBe(0);
  });
  it('INCIDENTE: editar un horario ACTIVO lo desactiva; al reactivarlo con confirmación solo dispara en ocurrencias futuras', { skip: NEAR_MIDNIGHT }, async () => {
    const d = await mkDriver(); const t = await mkTpl('ea-a5');
    const s = await mkSched({ time: hhmmAt(+120), tpl: t });                            // «5:00 p. m.» (en el futuro)
    await adm((q) => q.query(`select public.activate_schedule($1, true)`, [s.id]));
    // «4:17 → 4:20»: la edición apaga el horario, nada sale a las 4:20
    await adm((q) => q.query(`update public.notification_schedules set local_time=$2 where id=$1`, [s.id, hhmmAt(+4)]));
    expect(await row(s.id)).toMatchObject({ enabled: false, deactivated_reason: 'config_changed' });
    expect(await fire(s.id, plus(5))).toBe(0);
    // reactivar con confirmación: la hora (+4 min) sigue en el futuro → dispara y sin duplicados
    await adm((q) => q.query(`select public.activate_schedule($1, true)`, [s.id]));
    expect(await fire(s.id, plus(2))).toBe(0);                                            // todavía no es la hora
    const n1 = await fire(s.id, plus(5));
    expect(n1).toBeGreaterThanOrEqual(1);
    expect((await jobsOf(s.id)).map((j) => j.driver_id)).toContain(d.driver);
    expect(await fire(s.id, plus(5))).toBe(n1);
    // editar a una hora ya pasada y reactivar: no se pone al día hasta el día siguiente
    await adm((q) => q.query(`update public.notification_schedules set local_time=$2 where id=$1`, [s.id, hhmmAt(-3)]));
    await db.su.query(`delete from public.notification_jobs where schedule_id=$1`, [s.id]);
    await adm((q) => q.query(`select public.activate_schedule($1, true)`, [s.id]));
    expect(await fire(s.id, plus(1))).toBe(0);
    expect(await fire(s.id, plus(24 * 60 + 1))).toBeGreaterThanOrEqual(1);
  });
  it('editar días o plantilla de un horario activo lo desactiva; sin envío retroactivo tras reactivar', { skip: NEAR_MIDNIGHT }, async () => {
    const d = await mkDriver(); const t = await mkTpl('ea-a6'); const t2 = await mkTpl('ea-a6b');
    const s = await mkSched({ time: hhmmAt(-3), tpl: t });
    await db.su.query(`update public.notification_schedules set enabled=true where id=$1`, [s.id]);
    await db.su.query(`update public.notification_schedules set armed_at='2026-01-01' where id=$1`, [s.id]);    // activo desde hace tiempo, hoy hace 3 min aún en ventana
    await adm((q) => q.query(`update public.notification_schedules set template_id=$2 where id=$1`, [s.id, t2]));
    expect((await row(s.id)).enabled).toBe(false);
    expect(await fire(s.id, plus(1))).toBe(0);
    await adm((q) => q.query(`select public.activate_schedule($1, true)`, [s.id]));
    expect(await fire(s.id, plus(1))).toBe(0);                                            // la ocurrencia de hoy ya pasó al armarse
    expect(await fire(s.id, plus(24 * 60 + 1))).toBeGreaterThanOrEqual(1);                // mañana a la misma hora
    expect((await jobsOf(s.id)).map((j) => j.driver_id)).toContain(d.driver);
  });
  it('un trabajo PENDIENTE anterior al cambio se descarta; desactivar también descarta los pendientes', async () => {
    const d = await mkDriver(); const t = await mkTpl('ea-a7');
    const s = await mkSched({ time: '09:00', tpl: t, kind: 'debt_first' });
    await db.su.query(`update public.notification_schedules set enabled=true where id=$1`, [s.id]);
    await db.su.query(`update public.notification_schedules set armed_at='2026-01-01' where id=$1`, [s.id]);
    expect(await remind(at('2026-03-02', '09:05'))).toBeGreaterThanOrEqual(1);
    expect((await jobsOf(s.id)).find((x) => x.driver_id === d.driver)).toMatchObject({ status: 'pending' });
    await adm((q) => q.query(`update public.notification_schedules set local_time='09:30' where id=$1`, [s.id]));
    const all = await jobsOf(s.id); expect(all.length).toBeGreaterThanOrEqual(1);
    for (const j of all) { expect(j.status).toBe('cancelled'); expect(j.error).toMatch(/Horario modificado/); }
    // desactivar descarta los pendientes de una nueva ocurrencia
    await db.su.query(`update public.notification_schedules set armed_at='2026-01-01', local_time='09:00' where id=$1`, [s.id]);
    await db.su.query(`delete from public.notification_jobs where schedule_id=$1`, [s.id]);
    await remind(at('2026-03-03', '09:05'));
    expect((await jobsOf(s.id)).every((j) => j.status === 'pending')).toBe(true);
    await adm((q) => q.query(`select public.deactivate_schedule($1)`, [s.id]));
    expect((await jobsOf(s.id)).every((j) => j.status === 'cancelled')).toBe(true);
  });
  it('worker: ciclos repetidos no generan duplicados (un trabajo por conductor, horario y día)', async () => {
    const d = await mkDriver(); const t = await mkTpl('ea-a8');
    const s = await mkSched({ time: '08:00', tpl: t });
    await db.su.query(`update public.notification_schedules set enabled=true where id=$1`, [s.id]);
    await db.su.query(`update public.notification_schedules set armed_at='2026-01-01' where id=$1`, [s.id]);
    const first = await remind(at('2026-03-03', '08:01'));
    expect(first).toBeGreaterThanOrEqual(1);
    expect(await remind(at('2026-03-03', '08:02'))).toBe(0);
    expect(await remind(at('2026-03-03', '08:03'))).toBe(0);
    expect((await jobsOf(s.id)).filter((j) => j.driver_id === d.driver)).toHaveLength(1);
  });
});

describe('2b · editar un horario ACTIVO lo desactiva automáticamente', () => {
  async function active(opts: { time?: string } = {}) {
    const t = await mkTpl(`ea-b-${++n}`); const s = await mkSched({ time: opts.time ?? '09:00', tpl: t, kind: 'debt_first', weekdays: '{1,2,3,4,5,6}' });
    await adm((q) => q.query(`select public.activate_schedule($1, true)`, [s.id]));
    return { ...s, t };
  }
  const edits: Array<[string, string]> = [['local_time', `local_time='09:03'`], ['weekdays', `weekdays='{1,2,3}'`], ['template_id', `template_id=(select id from public.message_templates where name='ea-b-alt')`],
    ['scope', `scope='today'`], ['kind', `kind='debt_last'`]];
  it.each(edits)('cambiar %s: queda desactivado (motivo config_changed), cancela pendientes, conserva el historial y audita old/new con actor', async (field, set) => {
    await mkTpl('ea-b-alt').catch(() => undefined);
    const dr = await mkDriver(); const dr2 = await mkDriver(); const dr3 = await mkDriver();
    const s = await active();
    await db.su.query(`insert into public.notification_jobs(driver_id, kind, local_date, scheduled_for, schedule_id, status) values ($1,'debt_first',$4,$5,$6,'pending'), ($2,'debt_first',$4,$5,$6,'processing'), ($3,'debt_first',$4,$5,$6,'sent')`,
      [dr.driver, dr2.driver, dr3.driver, MON, at(MON, '09:00'), s.id]);
    const old = await row(s.id);
    await adm((q) => q.query(`update public.notification_schedules set ${set} where id=$1`, [s.id]));
    const now = await row(s.id);
    expect(now.enabled).toBe(false); expect(now.deactivated_reason).toBe('config_changed'); expect(now.deactivated_at).not.toBeNull();
    expect(Math.abs((now.armed_at as Date).getTime() - Date.now())).toBeLessThan(60_000);
    const st = Object.fromEntries((await jobsOf(s.id)).map((j) => [j.driver_id, j.status]));
    expect(st).toEqual({ [dr.driver]: 'cancelled', [dr2.driver]: 'processing', [dr3.driver]: 'sent' });     // solo pendientes; processing y sent intactos
    const au = await audits('schedule_auto_deactivated', s.id);
    expect(au).toHaveLength(1); expect(au[0].actor).toBe(db.admin);
    expect(au[0].detail).toMatchObject({ reason: 'config_changed', actor: db.admin, schedule_id: s.id });
    expect(Object.keys(au[0].detail.changes)).toEqual([field]);
    expect(au[0].detail.changes[field].old).toEqual(field === 'local_time' ? '09:00:00' : field === 'weekdays' ? [1, 2, 3, 4, 5, 6] : field === 'template_id' ? old.template_id : field === 'scope' ? 'total' : 'debt_first');
  });
  it('varias ediciones juntas: un solo evento con todos los old/new; la etiqueta NO desactiva', async () => {
    const s = await active();
    await adm((q) => q.query(`update public.notification_schedules set label=label||' (renombrado)' where id=$1`, [s.id]));
    expect(await row(s.id)).toMatchObject({ enabled: true, deactivated_reason: null, deactivated_at: null });
    await adm((q) => q.query(`update public.notification_schedules set local_time='10:00', scope='overdue', label=label||'!' where id=$1`, [s.id]));
    const au = await audits('schedule_auto_deactivated', s.id);
    expect(au).toHaveLength(1);
    expect(au[0].detail.changes).toEqual({ local_time: { old: '09:00:00', new: '10:00:00' }, scope: { old: 'total', new: 'overdue' } });
  });
  it('reenviar enabled=true junto con otro cambio no evita la desactivación (authenticated, service_role y superusuario); en uno apagado sigue rechazado', async () => {
    const s = await active();
    await adm((q) => q.query(`update public.notification_schedules set enabled=true, local_time='09:10' where id=$1`, [s.id]));
    expect((await row(s.id)).enabled).toBe(false);
    for (const [who, i] of [[svc, 1], [(f: (q: Q) => Promise<unknown>) => db.su.query('begin').then(async () => { try { await f({ query: db.su.query.bind(db.su) } as Q); await db.su.query('commit'); } catch (e) { await db.su.query('rollback'); throw e; } }), 2]] as const) {
      const x = await active();
      await who(async (q) => { await q.query(`update public.notification_schedules set enabled=true, scope='today' where id=$1`, [x.id]); });
      expect(await row(x.id), String(i)).toMatchObject({ enabled: false, deactivated_reason: 'config_changed' });
    }
    expect(await err(adm, `update public.notification_schedules set enabled=true, local_time='09:20' where id=$1`, [s.id])).toMatchObject({ message: 'direct_activation_forbidden' });
    expect((await row(s.id)).enabled).toBe(false);
  });
  it('apagar manualmente → motivo manual; activar limpia deactivated_*; permisos del reactivado', async () => {
    const s = await active();
    await adm((q) => q.query(`update public.notification_schedules set enabled=false where id=$1`, [s.id]));
    expect(await row(s.id)).toMatchObject({ enabled: false, deactivated_reason: 'manual' });
    expect((await row(s.id)).deactivated_at).not.toBeNull();
    expect(await audits('schedule_auto_deactivated', s.id)).toHaveLength(0);
    await adm((q) => q.query(`select public.activate_schedule($1, true)`, [s.id]));
    expect(await row(s.id)).toMatchObject({ enabled: true, deactivated_reason: null, deactivated_at: null });
    await adm((q) => q.query(`update public.notification_schedules set scope='today' where id=$1`, [s.id]));
    expect((await row(s.id)).deactivated_reason).toBe('config_changed');
    await adm((q) => q.query(`select public.deactivate_schedule($1)`, [s.id]));              // ya apagado: no cambia el motivo
    expect((await row(s.id)).deactivated_reason).toBe('config_changed');
    await adm((q) => q.query(`select public.activate_schedule($1, true)`, [s.id]));
    await adm((q) => q.query(`select public.deactivate_schedule($1)`, [s.id]));
    expect((await row(s.id)).deactivated_reason).toBe('manual');
    // un cliente no puede fijar el motivo a mano
    await adm((q) => q.query(`update public.notification_schedules set deactivated_reason=null, deactivated_at=null where id=$1`, [s.id]));
    expect((await row(s.id)).deactivated_reason).toBe('manual');
  });
  it('un horario desactivado por edición no crea trabajos aunque corra el planificador (hora dentro de la ventana)', async () => {
    await mkDriver(); const s = await active({ time: '09:00' });
    await db.su.query(`update public.notification_schedules set armed_at='2026-01-01' where id=$1`, [s.id]);
    await adm((q) => q.query(`update public.notification_schedules set local_time='09:03' where id=$1`, [s.id]));
    expect(await fire(s.id, at('2026-03-03', '09:04'))).toBe(0);
    expect(await fire(s.id, at('2026-03-03', '09:05'))).toBe(0);
  });
});

describe('3 · schedule_activation_preview', () => {
  const pv = async (id: string, now?: string) => (await adm((q) => q.one(`select public.schedule_activation_preview($1, $2) p`, [id, now ?? null]))).p;
  it('contrato JSON completo con plantilla válida; texto de ejemplo del catálogo; no cambia nada', async () => {
    const t = await mkTpl('ea-p1', 'Hola {{nombre_completo}}. Unidad {{unidad}}. {{detalle_deuda}}');
    const s = await mkSched({ time: '16:20', tpl: t, weekdays: '{1,2,3,4,5,6}', scope: 'overdue' });
    const before = await row(s.id);
    const p = await pv(s.id, at('2026-03-02', '16:10'));            // lunes
    expect(await row(s.id)).toEqual(before);
    expect(p).toMatchObject({
      schedule: { id: s.id, kind: 'debt_reminder', label: s.label, local_time: '16:20:00', weekdays: [1, 2, 3, 4, 5, 6], scope: 'overdue', enabled: false, timezone: 'America/Panama',
        next_occurrence: '2026-03-02T21:20:00Z', next_occurrence_local: '2026-03-02 16:20' },
      template: { id: t, name: 'ea-p1', body: 'Hola {{nombre_completo}}. Unidad {{unidad}}. {{detalle_deuda}}' },
      text_example: 'Hola Vanessa Ejemplo. Unidad 4321. Su cuota pendiente de hoy es de $40.00.',
      uses_variables: ['detalle_deuda', 'nombre_completo', 'unidad'], unknown_variables: [], eligible_drivers_reason: null, can_activate: true, blockers: [],
    });
    expect(typeof p.eligible_drivers).toBe('number');
  });
  it('bloqueos: no_template, unknown_variables, already_active', async () => {
    const a = await pv((await mkSched({ time: '16:21' })).id);
    expect(a).toMatchObject({ template: null, text_example: null, uses_variables: [], unknown_variables: [], can_activate: false, blockers: ['no_template'] });
    const t = await mkTpl('ea-p2', 'Hola {{nombre}} {{zzz}}');
    const b = await pv((await mkSched({ time: '16:22', tpl: t })).id);
    expect(b).toMatchObject({ unknown_variables: ['zzz'], uses_variables: ['nombre', 'zzz'], can_activate: false, blockers: ['unknown_variables'] });
    const t3 = await mkTpl('ea-p3'); const s3 = await mkSched({ time: '16:23', tpl: t3 });
    await adm((q) => q.query(`select public.activate_schedule($1, true)`, [s3.id]));
    expect(await pv(s3.id)).toMatchObject({ can_activate: false, blockers: ['already_active'], schedule: { enabled: true } });
  });
  it('next_occurrence: respeta días, la hora ya pasada de hoy y armed_at', async () => {
    const t = await mkTpl('ea-p4');
    const s = await mkSched({ time: '16:20', tpl: t, weekdays: '{1,2,3,4,5,6}' });
    expect((await pv(s.id, at('2026-03-02', '16:30'))).schedule.next_occurrence_local).toBe('2026-03-03 16:20');      // lunes tras la hora → martes
    expect((await pv(s.id, at('2026-03-07', '16:30'))).schedule.next_occurrence_local).toBe('2026-03-09 16:20');      // sábado tras la hora → lunes (domingo excluido)
    await db.su.query(`update public.notification_schedules set enabled=true where id=$1`, [s.id]);
    await db.su.query(`update public.notification_schedules set armed_at=$2 where id=$1`, [s.id, at('2026-03-03', '00:00')]);
    expect((await pv(s.id, at('2026-03-02', '16:10'))).schedule.next_occurrence_local).toBe('2026-03-03 16:20');      // activo: la ocurrencia de hoy < armed_at no cuenta
    await db.su.query(`update public.notification_schedules set armed_at=$2 where id=$1`, [s.id, at('2026-03-02', '16:00')]);
    expect((await pv(s.id, at('2026-03-02', '16:10'))).schedule.next_occurrence_local).toBe('2026-03-02 16:20');
  });
  it('next_is_today, minutes_until_next, deactivated_reason y deactivated_at', async () => {
    const t = await mkTpl('ea-p6'); const s = await mkSched({ time: '16:20', tpl: t });
    expect((await pv(s.id, at('2026-03-02', '16:10'))).schedule).toMatchObject({ next_is_today: true, minutes_until_next: 10, deactivated_reason: null, deactivated_at: null });
    expect((await pv(s.id, at('2026-03-02', '16:30'))).schedule).toMatchObject({ next_is_today: false, minutes_until_next: 23 * 60 + 50, next_occurrence_local: '2026-03-03 16:20' });
    expect((await pv(s.id, at('2026-03-02', '23:50'))).schedule).toMatchObject({ next_is_today: false });   // medianoche en Panamá, no en UTC
    const only = await mkSched({ time: '16:20', tpl: t, weekdays: '{3}' });                                   // solo miércoles
    expect((await pv(only.id, at('2026-03-02', '16:10'))).schedule).toMatchObject({ next_is_today: false, next_occurrence_local: '2026-03-04 16:20', minutes_until_next: 2 * 24 * 60 + 10 });
    await adm((q) => q.query(`select public.activate_schedule($1, true)`, [s.id]));
    await adm((q) => q.query(`update public.notification_schedules set scope='today' where id=$1`, [s.id]));
    expect((await pv(s.id, at('2026-03-02', '16:10'))).schedule).toMatchObject({ enabled: false, deactivated_reason: 'config_changed' });
    expect(typeof (await pv(s.id)).schedule.deactivated_at).toBe('string');
    expect((await pv(s.id)).can_activate).toBe(true);
  });
  it('eligible_drivers: cuenta solo activos con asignación, teléfono válido, consentimiento y deuda según el ámbito', async () => {
    const t = await mkTpl('ea-p5');
    const total = await mkSched({ time: '16:30', tpl: t, scope: 'total' }); const today = await mkSched({ time: '16:31', tpl: t, scope: 'today' });
    const base = (await pv(total.id)).eligible_drivers as number; const baseToday = (await pv(today.id)).eligible_drivers as number;
    await mkDriver();                                                       // elegible (deuda vencida)
    expect((await pv(total.id)).eligible_drivers).toBe(base + 1);
    expect((await pv(today.id)).eligible_drivers).toBe(baseToday);          // su deuda es de un día pasado: no es «hoy»
    await mkDriver({ consent: false }); await mkDriver({ consent: false, phone: null }); await mkDriver({ status: 'inactive' }); await mkDriver({ charge: null });
    const paused = await mkDriver(); await db.su.query(`update public.drivers set reminders_paused=true where id=$1`, [paused.driver]);
    expect((await pv(total.id)).eligible_drivers).toBe(base + 1);
    const ws = await mkSched({ time: '09:00', tpl: t, kind: 'weekly_summary', weekdays: '{7}' });
    expect((await pv(ws.id)).eligible_drivers).toBeGreaterThanOrEqual(base + 2);   // el resumen semanal no exige deuda (incluye al sin cargos)
  });
});

describe('4 · auditoría del proveedor en notification_jobs', () => {
  async function processing() {
    const d = await mkDriver();
    return (await db.su.query(`insert into public.notification_jobs(driver_id, kind, local_date, scheduled_for, status, attempts) values ($1,'debt_first',$2,$3,'processing',1) returning id`, [d.driver, MON, at(MON, '09:00')])).rows[0].id as string;
  }
  it('columnas nuevas nulables; la firma de 6 argumentos sigue funcionando y las deja nulas', async () => {
    const cols = (await db.su.query(`select column_name, is_nullable from information_schema.columns where table_name='notification_jobs' and column_name in ('provider_message_id','sender_phone','recipient_phone','delivery_status','delivered_at') order by 1`)).rows;
    expect(cols).toEqual([{ column_name: 'delivered_at', is_nullable: 'YES' }, { column_name: 'delivery_status', is_nullable: 'YES' }, { column_name: 'provider_message_id', is_nullable: 'YES' },
      { column_name: 'recipient_phone', is_nullable: 'YES' }, { column_name: 'sender_phone', is_nullable: 'YES' }]);
    const id = await processing();
    await svc((q) => q.query(`select public.complete_notification($1,'sent',null,true,'hola',$2)`, [id, at(MON, '09:01')]));
    expect((await db.su.query(`select status, dry_run, rendered_body, provider_message_id, sender_phone, recipient_phone, delivery_status, delivered_at from public.notification_jobs where id=$1`, [id])).rows[0])
      .toEqual({ status: 'sent', dry_run: true, rendered_body: 'hola', provider_message_id: null, sender_phone: null, recipient_phone: null, delivery_status: null, delivered_at: null });
  });
  it('guarda id de mensaje, números y estado; «entregado» exige acuse real', async () => {
    const id = await processing();
    expect(await svc((q) => q.fails(`select public.complete_notification($1,'sent',null,false,'x',$2,'wamid.1','+50761111111','+50762222222','accepted',$2)`, [id, at(MON, '09:01')]))).toBe('delivery_ack_required');
    expect(await svc((q) => q.fails(`select public.complete_notification($1,'sent',null,false,'x',$2,'wamid.1',null,null,'visto',null)`, [id, at(MON, '09:01')]))).toBe('invalid_delivery_status');
    await svc((q) => q.query(`select public.complete_notification($1,'sent',null,false,'texto real',$2,'wamid.1','+50761111111','+50762222222','accepted',null)`, [id, at(MON, '09:01')]));
    expect((await db.su.query(`select status, dry_run, provider_message_id, sender_phone, recipient_phone, delivery_status, delivered_at from public.notification_jobs where id=$1`, [id])).rows[0])
      .toEqual({ status: 'sent', dry_run: false, provider_message_id: 'wamid.1', sender_phone: '+50761111111', recipient_phone: '+50762222222', delivery_status: 'accepted', delivered_at: null });
    const id2 = await processing();
    await svc((q) => q.query(`select public.complete_notification($1,'sent',null,false,'x',$2,'wamid.2',null,'+50762222222','delivered',$2)`, [id2, at(MON, '09:02')]));
    expect((await db.su.query(`select delivery_status, delivered_at from public.notification_jobs where id=$1`, [id2])).rows[0]).toMatchObject({ delivery_status: 'delivered' });
    expect(await db.su.query(`update public.notification_jobs set delivery_status='accepted' where id=$1`, [id2]).catch((e) => e.message)).toMatch(/delivered_requires_ack/);
  });
  it('solo service_role puede completar un envío', async () => {
    const id = await processing();
    expect(await adm((q) => q.fails(`select public.complete_notification($1,'sent')`, [id]))).toMatch(/permission denied/);
    expect(await db.asAnon((q) => q.fails(`select public.complete_notification($1,'sent')`, [id]))).toMatch(/permission denied/);
  });
});

describe('4b · verificación de configuración vigente en prepare_notification_send', () => {
  it('schedule_reminders guarda el snapshot de armed_at; prepare cancela si cambió o se apagó, y con snapshot nulo solo exige horario activo', async () => {
    const d = await mkDriver(); const t = await mkTpl('ea-v1');
    const s = await mkSched({ time: '08:00', tpl: t, kind: 'debt_first' });
    await db.su.query(`update public.notification_schedules set enabled=true where id=$1`, [s.id]);
    await db.su.query(`update public.notification_schedules set armed_at='2026-01-01' where id=$1`, [s.id]);
    await remind(at('2026-03-03', '08:01'));
    const j = (await jobsOf(s.id)).find((x) => x.driver_id === d.driver)!;
    expect((j.schedule_armed_at as Date).getTime()).toBe(((await row(s.id)).armed_at as Date).getTime());
    const claim = async (id: string) => { await db.su.query(`update public.notification_jobs set status='processing' where id=$1`, [id]); };
    // sin cambios: envía
    await claim(j.id);
    expect((await svc((q) => q.one(`select public.prepare_notification_send($1,$2) p`, [j.id, at('2026-03-03', '08:02')]))).p.action).toBe('send');
    // cambia armed_at (p. ej. edición + reactivación): cancela sin renderizar
    await db.su.query(`update public.notification_schedules set armed_at='2026-02-01' where id=$1`, [s.id]);
    const p = (await svc((q) => q.one(`select public.prepare_notification_send($1,$2) p`, [j.id, at('2026-03-03', '08:02')]))).p;
    expect(p).toEqual({ action: 'skip', reason: 'cancelled' });
    expect((await db.su.query(`select status, error, rendered_body from public.notification_jobs where id=$1`, [j.id])).rows[0]).toEqual({ status: 'cancelled', error: 'Horario modificado o desactivado antes del envío', rendered_body: null });
    // snapshot nulo + horario activo: comportamiento actual (envía); apagado: cancela
    await db.su.query(`update public.notification_jobs set status='processing', schedule_armed_at=null, error=null where id=$1`, [j.id]);
    expect((await svc((q) => q.one(`select public.prepare_notification_send($1,$2) p`, [j.id, at('2026-03-03', '08:02')]))).p.action).toBe('send');
    await db.su.query(`update public.notification_schedules set enabled=false where id=$1`, [s.id]);
    expect((await svc((q) => q.one(`select public.prepare_notification_send($1,$2) p`, [j.id, at('2026-03-03', '08:02')]))).p).toEqual({ action: 'skip', reason: 'cancelled' });
  });
  it('complete_notification uncertain: failed sin reintento, sin enviado ni entregado', async () => {
    const d = await mkDriver();
    const id = (await db.su.query(`insert into public.notification_jobs(driver_id, kind, local_date, scheduled_for, status, attempts) values ($1,'debt_first',$2,$3,'processing',1) returning id`, [d.driver, MON, at(MON, '09:00')])).rows[0].id;
    expect(await svc((q) => q.one(`select public.complete_notification($1,'uncertain','could not confirm',false,null,$2) s`, [id, at(MON, '09:01')]))).toEqual({ s: 'failed' });
    expect((await db.su.query(`select status, sent_at, delivery_status, error from public.notification_jobs where id=$1`, [id])).rows[0]).toMatchObject({ status: 'failed', sent_at: null, delivery_status: null, error: 'Resultado incierto, no se reintenta automáticamente: could not confirm' });
  });
});

describe('5 · sin mensajes ocultos', () => {
  it('ningún texto de recordatorio programado vive en el envío; el texto base solo es plantilla editable (sin uso automático)', async () => {
    const defs = (await db.su.query(`select p.proname, p.prosrc from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname in ('public','app_private')`)).rows as { proname: string; prosrc: string }[];
    for (const f of ['prepare_notification_send', 'schedule_reminders', 'complete_notification', 'activate_schedule'])
      for (const d of defs.filter((x) => x.proname === f)) { expect(d.prosrc, f).not.toMatch(/Buenos días|Buenas tardes|Buenas noches|Gracias por su atención/); }
    const users = defs.filter((x) => /default_template_body/.test(x.prosrc)).map((x) => x.proname).sort();
    expect(users).toEqual(['create_template_from_default', 'schedule_default_templates']);
    const send = defs.find((x) => x.proname === 'prepare_notification_send')!.prosrc;
    expect(send).toContain('skipped_no_template');
    expect(send).not.toContain('default_template_body');
  });
  it('el catálogo de variables y el análisis coinciden: un cuerpo con todo el catálogo no tiene desconocidas', async () => {
    const codes = (await adm((q) => q.rows(`select code from public.template_variables()`))).map((r) => r.code as string);
    const body = codes.map((c) => `{{${c}}}`).join(' ');
    const s = await mkSched({ time: '12:34', tpl: await mkTpl('ea-todo', body) });
    const an = (await adm((q) => q.one(`select public.schedule_activation_preview($1) p`, [s.id]))).p;
    expect(an.unknown_variables).toEqual([]); expect([...an.uses_variables].sort()).toEqual([...codes].sort()); expect(an.can_activate).toBe(true);
  });
});

describe('0024 → 0025 sobre una base con datos (no destructiva)', () => {
  let admin: pg.Client; let up: pg.Client; let name: string;
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  const MIG = '20261116002500_explicit_schedule_activation.sql';
  beforeAll(async () => {
    const c = inject('pgCluster');
    name = `ea_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
    admin = new pg.Client(connConfig(c, 'postgres')); await admin.connect(); await admin.query(`create database ${name}`);
    up = new pg.Client(connConfig(c, name)); await up.connect();
    await up.query(readFileSync(STUB_SQL, 'utf8'));
    for (const f of files.filter((x) => x < MIG)) await up.query(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'));
  });
  afterAll(async () => { await up.end(); await admin.query(`drop database if exists ${name} with (force)`); await admin.end(); });
  it('no modifica horarios, plantillas ni trabajos (incluido el envío ya realizado); armed_at queda nulo y el comportamiento anterior se conserva', async () => {
    const t = (await up.query(`insert into public.message_templates(name, body) values ('Legado', 'Hola {{nombre}}') returning id`)).rows[0].id;
    await up.query(`update public.notification_schedules set template_id=$1, enabled=true where kind='debt_update'`, [t]);          // activo con plantilla (legado)
    const d = (await up.query(`insert into public.drivers(operator_code, national_id, first_name, phone_e164, whatsapp_consent) values ('UP2','9-9-8','X','+50760022222',true) returning id`)).rows[0].id;
    const u = (await up.query(`insert into public.units(code) values ('UPU2') returning id`)).rows[0].id;
    const a = (await up.query(`insert into public.assignments(driver_id, unit_id, valid_from) values ($1,$2,'2026-01-01') returning id`, [d, u])).rows[0].id;
    await up.query(`insert into public.charges(assignment_id, kind, charge_date, amount_cents, week_start) values ($1,'daily','2026-03-02',4000,'2026-03-02')`, [a]);
    const sid = (await up.query(`select id from public.notification_schedules where kind='debt_update'`)).rows[0].id;
    await up.query(`insert into public.notification_jobs(driver_id, kind, local_date, scheduled_for, schedule_id, status, rendered_body, dry_run, sent_at) values ($1,'debt_update','2026-03-02',$2,$3,'sent','texto enviado',false,$2)`, [d, at(MON, '17:00'), sid]);
    const snap = async () => ({
      s: (await up.query(`select id, kind, label, local_time, weekdays, template_id, scope, enabled from public.notification_schedules order by id`)).rows,
      t: (await up.query(`select * from public.message_templates order by id`)).rows,
      j: (await up.query(`select id, driver_id, kind, local_date, scheduled_for, schedule_id, status, rendered_body, dry_run, sent_at, error, attempts from public.notification_jobs order by id`)).rows,
    });
    const before = await snap();
    await up.query(readFileSync(join(MIGRATIONS_DIR, MIG), 'utf8'));
    expect(await snap()).toEqual(before);
    expect((await up.query(`select count(*)::int c from public.notification_schedules where armed_at is not null`)).rows[0].c).toBe(0);
    expect((await up.query(`select count(*)::int c from public.notification_jobs where provider_message_id is not null or sender_phone is not null or recipient_phone is not null or delivery_status is not null or delivered_at is not null`)).rows[0].c).toBe(0);
    // armed_at nulo: el horario legado sigue disparando como antes (solo se «arma» cuando alguien lo modifica)
    await up.query(`delete from public.notification_jobs`);
    expect((await up.query(`select public.schedule_reminders($1) n`, [at(MON, '17:05')])).rows[0].n).toBe(1);
    // una edición lo arma: deja de poder ponerse al día
    await up.query(`delete from public.notification_jobs`);
    await up.query(`update public.notification_schedules set local_time='17:01' where id=$1`, [sid]);
    expect((await up.query(`select armed_at is not null a from public.notification_schedules where id=$1`, [sid])).rows[0].a).toBe(true);
    expect((await up.query(`select public.schedule_reminders($1) n`, [at(MON, '17:05')])).rows[0].n).toBe(0);
  });
});

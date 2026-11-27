import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { MON } from './fixtures.js';
import { newDb, type Db, type Q } from './harness.js';
import { MIGRATIONS_DIR, STUB_SQL, connConfig } from './pg-cluster.js';

let db: Db; let n = 0;
beforeAll(async () => { db = await newDb(); });
afterAll(async () => { await db.close(); });

const at = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00-05:00`).toISOString();
const adm = <T>(fn: (q: Q) => Promise<T>) => db.as(db.admin, fn);
const ops = <T>(fn: (q: Q) => Promise<T>) => db.as(db.opsAdmin, fn);
const svc = <T>(fn: (q: Q) => Promise<T>) => db.asService(fn);
/** Error completo (message, code, detail, hint) de una sentencia ejecutada como `fn`. */
async function err(who: (f: (q: Q) => Promise<unknown>) => Promise<unknown>, sql: string, params: unknown[] = []) {
  try { await who(async (q) => { await q.query(sql, params); }); return null; }
  catch (e) { const x = e as { message: string; code: string; detail?: string; hint?: string }; return { message: x.message, code: x.code, detail: x.detail, hint: x.hint }; }
}
const sch = async (kind: string) => (await db.su.query(`select * from public.notification_schedules where kind=$1 order by local_time limit 1`, [kind])).rows[0];
// 0035: el «uso» de una plantilla se mide contra los HORARIOS DE ENVÍO (send_schedules); los horarios heredados (notification_schedules) ya no la bloquean.
const mkSend = (name: string, tpl: string | null, enabled = false) => db.su.query(
  `insert into public.send_schedules(name, local_time, template_id, enabled, armed_by) values ($1,'22:00',$2,$3,$4) returning id`, [name, tpl, enabled, enabled ? db.opsAdmin : null]).then((r) => r.rows[0].id as string);
const mkTpl = async (name: string, body = 'Hola {{nombre_completo}}. {{detalle_deuda}}') =>
  (await db.su.query(`insert into public.message_templates(name, body) values ($1,$2) returning id`, [name, body])).rows[0].id as string;
async function mk(charge = 4000) {
  n += 1;
  const x = await db.driverWithAssignment({ code: `ST${n}`, unit: `STU${n}`, dailyCents: 4000, phone: `+507603${String(10000 + n)}`, consent: true });
  await db.su.query(`update public.drivers set first_name='Vanessa', last_name='Ejemplo' where id=$1`, [x.driver]);
  if (charge) await db.su.query(`insert into public.charges(assignment_id, kind, charge_date, amount_cents, week_start) values ($1,'daily',$2,$3,app_private.week_start_of($2::date))`, [x.assignment, MON, charge]);
  return x;
}
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
/** Simula datos antiguos: horario activo sin plantilla (la guardia no existía). */
async function legacyEnabledWithoutTemplate(kind: string) {
  await db.su.query(`alter table public.notification_schedules disable trigger guard_template`);
  try { await db.su.query(`update public.notification_schedules set enabled=true, template_id=null where kind=$1`, [kind]); }
  finally { await db.su.query(`alter table public.notification_schedules enable trigger guard_template`); }
}
/** Desde 0025 un cliente (authenticated) no puede activar por UPDATE directo: estas pruebas del guard de plantilla activan con el rol de servidor. */
const reset = async () => {
  await db.su.query(`alter table public.notification_schedules disable trigger guard_template`);
  await db.su.query(`update public.notification_schedules set enabled=false, template_id=null`);
  await db.su.query(`alter table public.notification_schedules enable trigger guard_template`);
  await db.su.query(`update public.app_settings set max_per_driver_per_day = 10, min_minutes_between = 0`);
};

describe('guard de activación (template_required)', () => {
  it('activar sin plantilla se rechaza con message/código/detalle reconocibles', async () => {
    await reset();
    const s = await sch('debt_first');
    const e = await err(svc, `update public.notification_schedules set enabled=true where id=$1`, [s.id]);
    expect(e).toEqual({ message: 'template_required', code: '23514', detail: 'Un horario activo necesita una plantilla de mensaje asignada.', hint: 'Asigne o cree una plantilla para el horario antes de activarlo.' });
    expect((await sch('debt_first')).enabled).toBe(false);
  });
  it('con plantilla válida se puede activar; apagar siempre se permite', async () => {
    await reset();
    const t = await mkTpl('g-valida'); const s = await sch('debt_first');
    expect(await err(svc, `update public.notification_schedules set template_id=$2, enabled=true where id=$1`, [s.id, t])).toBeNull();
    expect((await sch('debt_first'))).toMatchObject({ enabled: true, template_id: t });
    expect(await err(ops, `update public.notification_schedules set enabled=false where id=$1`, [s.id])).toBeNull();
    // activar de nuevo con la plantilla ya asignada
    expect(await err(svc, `update public.notification_schedules set enabled=true where id=$1`, [s.id])).toBeNull();
  });
  it('cambiar la plantilla de un horario activo a NULL (o a una inexistente) se rechaza', async () => {
    await reset();
    const t = await mkTpl('g-nula'); const s = await sch('debt_update');
    await svc((q) => q.query(`update public.notification_schedules set template_id=$2, enabled=true where id=$1`, [s.id, t]));
    expect((await err(adm, `update public.notification_schedules set template_id=null where id=$1`, [s.id]))?.message).toBe('template_required');
    expect(await err(adm, `update public.notification_schedules set template_id=$2 where id=$1`, [s.id, randomUUID()])).toMatchObject({ message: 'template_required', code: '23514' });   // inexistente = sin plantilla
    expect((await sch('debt_update')).template_id).toBe(t);
    // apagar y quitar la plantilla en la misma sentencia sí está permitido
    expect(await err(adm, `update public.notification_schedules set enabled=false, template_id=null where id=$1`, [s.id])).toBeNull();
  });
  it('insertar un horario activo sin plantilla se rechaza; con plantilla se permite', async () => {
    await reset();
    const t = await mkTpl('g-insert');
    expect((await err(svc, `insert into public.notification_schedules(kind,label,local_time,weekdays,enabled) values ('debt_reminder','Nuevo A','10:00','{1}',true)`))?.message).toBe('template_required');
    expect(await err(svc, `insert into public.notification_schedules(kind,label,local_time,weekdays,enabled,template_id) values ('debt_reminder','Nuevo B','10:00','{1}',true,$1)`, [t])).toBeNull();
    expect(await err(adm, `insert into public.notification_schedules(kind,label,local_time,weekdays) values ('debt_reminder','Nuevo C','10:00','{1}')`)).toBeNull();   // apagado sin plantilla: ok
  });
  it('NO retroactivo: el horario legado activo sin plantilla se puede editar mientras no toque habilitación ni plantilla', async () => {
    await reset(); await legacyEnabledWithoutTemplate('debt_update');
    const s = await sch('debt_update');
    expect(await err(adm, `update public.notification_schedules set label='Recordatorio actualizado 2', local_time='17:30' where id=$1`, [s.id])).toBeNull();
    expect(await err(svc, `update public.notification_schedules set enabled=true, template_id=null where id=$1`, [s.id])).toBeNull();     // sin cambio real
    expect((await sch('debt_update'))).toMatchObject({ enabled: true, template_id: null, label: 'Recordatorio actualizado 2' });
    await adm((q) => q.query(`update public.notification_schedules set label='Recordatorio actualizado', local_time='17:00' where id=$1`, [s.id]));
    // apagarlo y volver a encenderlo SÍ exige plantilla
    await adm((q) => q.query(`update public.notification_schedules set enabled=false where id=$1`, [s.id]));
    expect((await err(svc, `update public.notification_schedules set enabled=true where id=$1`, [s.id]))?.message).toBe('template_required');
  });
  it('permisos: outsider y anónimo no escriben horarios', async () => {
    await reset(); const s = await sch('debt_first');
    expect(await db.as(db.outsider, async (q) => (await q.rows(`update public.notification_schedules set label='x' where id=$1 returning 1`, [s.id])).length)).toBe(0);
    expect(await err((f) => db.asAnon(f), `update public.notification_schedules set label='x' where id=$1`, [s.id])).toMatchObject({ code: '42501' });
  });
});

describe('borrar plantillas y template_usage', () => {
  it('borrar una plantilla en uso se rechaza (template_in_use) y template_usage lista el horario', async () => {
    await reset();
    const t = await mkTpl('u-uso'); const sid = await mkSend('Diez de la noche', t, true);
    const e = await err(adm, `delete from public.message_templates where id=$1`, [t]);
    expect(e).toMatchObject({ message: 'template_in_use', code: '23503' });
    expect(e!.detail).toContain('Diez de la noche');
    expect((await db.su.query(`select 1 from public.message_templates where id=$1`, [t])).rowCount).toBe(1);
    const u = await adm((q) => q.rows(`select * from public.template_usage($1)`, [t]));
    expect(u).toEqual([{ id: sid, kind: 'broadcast', label: 'Diez de la noche', local_time: '22:00:00', weekdays: [1, 2, 3, 4, 5, 6, 7], enabled: true }]);
  });
  it('los horarios heredados (notification_schedules) ya no impiden borrar una plantilla ni aparecen en el uso', async () => {
    await reset();
    const t = await mkTpl('u-heredado');
    await adm((q) => q.query(`update public.notification_schedules set template_id=$1 where kind = 'debt_first'`, [t]));
    expect(await adm((q) => q.rows(`select * from public.template_usage($1)`, [t]))).toEqual([]);
    expect(await err(adm, `delete from public.message_templates where id=$1`, [t])).toBeNull();
    expect((await db.su.query(`select template_id from public.notification_schedules where kind='debt_first'`)).rows[0].template_id).toBeNull();   // la FK lo deja sin plantilla
  });
  it('plantilla compartida por 2 horarios: usage devuelve ambos (también apagados) y no se puede borrar', async () => {
    await reset();
    const t = await mkTpl('u-compartida');
    const a = await mkSend('Primer horario', t, false); const b = await mkSend('Segundo horario', t, true);
    const u = await ops((q) => q.rows(`select label, enabled from public.template_usage($1)`, [t]));
    expect(u).toEqual([{ label: 'Primer horario', enabled: false }, { label: 'Segundo horario', enabled: true }]);
    expect((await err(adm, `delete from public.message_templates where id=$1`, [t]))?.message).toBe('template_in_use');
    // liberar un horario: sigue en uso por el otro; liberar ambos (el activo se desactiva solo al quedarse sin plantilla): se puede borrar
    await db.su.query(`update public.send_schedules set template_id = null where id = $1`, [a]);
    expect((await err(adm, `delete from public.message_templates where id=$1`, [t]))?.message).toBe('template_in_use');
    await db.su.query(`update public.send_schedules set template_id = null where id = $1`, [b]);
    expect((await db.su.query(`select enabled from public.send_schedules where id=$1`, [b])).rows[0].enabled).toBe(false);
    expect(await adm((q) => q.rows(`select * from public.template_usage($1)`, [t]))).toEqual([]);
    expect(await err(adm, `delete from public.message_templates where id=$1`, [t])).toBeNull();
  });
  it('borrar una plantilla sin uso se permite; usage de una inexistente → template_not_found', async () => {
    const t = await mkTpl('u-libre');
    expect(await err(adm, `delete from public.message_templates where id=$1`, [t])).toBeNull();
    expect(await adm((q) => q.fails(`select * from public.template_usage($1)`, [t]))).toBe('template_not_found');
  });
  it('permisos de template_usage: ADMIN y SUPER sí; outsider y anónimo no', async () => {
    const t = await mkTpl('u-perm');
    await expect(adm((q) => q.rows(`select * from public.template_usage($1)`, [t]))).resolves.toEqual([]);
    await expect(ops((q) => q.rows(`select * from public.template_usage($1)`, [t]))).resolves.toEqual([]);
    expect(await db.as(db.outsider, (q) => q.fails(`select * from public.template_usage($1)`, [t]))).toBe('forbidden');
    expect((await err((f) => db.asAnon(f), `select * from public.template_usage($1)`, [t]))?.code).toBe('42501');
  });
});

describe('texto base como plantilla editable', () => {
  const EXACT: Record<string, string> = {
    debt_first: 'Buenos días, {{nombre_completo}}.\n\nUnidad: {{unidad}}\nFecha: {{fecha}}\n\n{{detalle_deuda}}\n\nGracias por su atención.',
    debt_update: 'Buenas tardes, {{nombre_completo}}.\n\nUnidad: {{unidad}}\nFecha: {{fecha}}\n\n{{detalle_deuda}}\n\nGracias por su atención.',
    debt_last: 'Buenas noches, {{nombre_completo}}.\n\nUnidad: {{unidad}}\nFecha: {{fecha}}\n\n{{detalle_deuda}}\n\nGracias por su atención.',
    weekly_summary: 'Buenos días, {{nombre_completo}}.\n\nUnidad: {{unidad}}\nFecha: {{fecha}}\n\nResumen de la semana:\nCuenta semanal: {{cuenta_semanal}}\nPagos recibidos: {{pagos_semana}}\n\n{{detalle_deuda}}\n\nGracias por su atención.',
  };
  it('schedule_default_templates devuelve los 4 tipos con los cuerpos exactos', async () => {
    const r = await adm((q) => q.rows(`select * from public.schedule_default_templates()`));
    expect(r.map((x) => x.kind)).toEqual(['debt_first', 'debt_update', 'debt_last', 'weekly_summary']);
    for (const x of r) expect(x.body).toBe(EXACT[x.kind]);
    expect(r.map((x) => x.suggested_name)).toEqual(['Primer recordatorio (texto base)', 'Recordatorio actualizado (texto base)', 'Último recordatorio (texto base)', 'Resumen semanal (texto base)']);
    expect((await db.as(db.outsider, (q) => q.fails(`select * from public.schedule_default_templates()`)))).toBe('forbidden');
  });
  it('create_template_from_default crea una plantilla real y editable; no duplica sin pedirlo (sufijos)', async () => {
    const before = (await db.su.query(`select count(*)::int c from public.message_templates where name like 'Primer recordatorio (texto base)%'`)).rows[0].c;
    expect(before).toBe(0);                                                       // listar el texto base NO crea nada
    const a = await adm((q) => q.one(`select * from public.create_template_from_default('debt_first')`));
    expect(a).toMatchObject({ name: 'Primer recordatorio (texto base)', body: EXACT.debt_first });
    const b = await ops((q) => q.one(`select * from public.create_template_from_default('debt_first')`));
    expect(b.name).toBe('Primer recordatorio (texto base) 2');
    const c = await adm((q) => q.one(`select * from public.create_template_from_default('debt_first', 'Mi texto')`));
    const d = await adm((q) => q.one(`select * from public.create_template_from_default('debt_last', ' Mi texto ')`));
    expect([c.name, d.name]).toEqual(['Mi texto', 'Mi texto 2']);
    expect(d.body).toBe(EXACT.debt_last);
    // editable como cualquier plantilla
    expect(await err(adm, `update public.message_templates set body='Hola {{nombre}}' where id=$1`, [a.id])).toBeNull();
    expect((await db.su.query(`select count(*)::int c from public.audit_logs where action='template_created_from_default'`)).rows[0].c).toBeGreaterThanOrEqual(4);
  });
  it('kind inválido, horario inexistente y permisos', async () => {
    expect(await adm((q) => q.fails(`select * from public.create_template_from_default('payment_receipt')`))).toBe('invalid_kind');
    expect(await adm((q) => q.fails(`select * from public.create_template_from_default('debt_first', null, $1)`, [randomUUID()]))).toBe('schedule_not_found');
    expect(await db.as(db.outsider, (q) => q.fails(`select * from public.create_template_from_default('debt_first')`))).toBe('forbidden');
    expect((await err((f) => db.asAnon(f), `select * from public.create_template_from_default('debt_first')`))?.code).toBe('42501');
  });
  it('asignarla de una vez al horario permite activarlo (y respeta el guard)', async () => {
    await reset();
    const s = await sch('debt_last');
    expect((await err(svc, `update public.notification_schedules set enabled=true where id=$1`, [s.id]))?.message).toBe('template_required');
    const t = await adm((q) => q.one(`select * from public.create_template_from_default('debt_last', 'Última (base)', $1)`, [s.id]));
    expect((await sch('debt_last')).template_id).toBe(t.id);
    expect(await err(svc, `update public.notification_schedules set enabled=true where id=$1`, [s.id])).toBeNull();
  });
});

describe('horarios sin plantilla: comportamiento seguro', () => {
  it('schedule_reminders no crea trabajos para un horario activo SIN plantilla (legado) y sí con plantilla', async () => {
    await reset(); await legacyEnabledWithoutTemplate('debt_update');
    const x = await mk();
    expect(await svc((q) => q.one(`select public.schedule_reminders($1) n`, [at(MON, '17:05')])).then((r) => r.n)).toBe(0);
    expect((await db.su.query(`select count(*)::int c from public.notification_jobs where driver_id=$1`, [x.driver])).rows[0].c).toBe(0);
    await adm((q) => q.one(`select * from public.create_template_from_default('debt_update', null, (select id from public.notification_schedules where kind='debt_update'))`));
    expect(await svc((q) => q.one(`select public.schedule_reminders($1) n`, [at(MON, '17:05')])).then((r) => r.n)).toBeGreaterThanOrEqual(1);
  });
  it('job sin plantilla (datos huérfanos o job manual): skipped_no_template, auditado y NUNCA se envía', async () => {
    await reset();
    const t = await mkTpl('o-huerfana'); const s = await sch('debt_first');
    await svc((q) => q.query(`update public.notification_schedules set template_id=$2, enabled=true where id=$1`, [s.id, t]));
    const x = await mk(); const y = await mk();
    await svc((q) => q.query(`select public.schedule_reminders($1)`, [at(MON, '11:05')]));        // crea trabajos con plantilla válida (x e y)
    const z = await mk();                                                                          // z se crea DESPUÉS: solo tendrá el trabajo manual (si tuviera dos, el worker aplaza uno por «envío del mismo conductor en curso»)
    // la plantilla desaparece por datos antiguos / manipulación directa (el guard normal lo impide)
    await db.su.query(`alter table public.notification_schedules disable trigger guard_template`);
    await db.su.query(`update public.notification_schedules set template_id=null where id=$1`, [s.id]);
    await db.su.query(`alter table public.notification_schedules enable trigger guard_template`);
    // un job manual sin horario
    await db.su.query(`insert into public.notification_jobs(driver_id, kind, local_date, scheduled_for) values ($1,'debt_reminder',$2,$3)`, [z.driver, MON, at(MON, '11:00')]);
    const out = await svc(async (q) => {
      const jobs = await q.rows(`select * from public.claim_notification_jobs(50, $1)`, [at(MON, '11:06')]);
      const r: Array<{ p: any; st: any }> = [];
      for (const j of jobs.filter((j) => [x.driver, y.driver, z.driver].includes(j.driver_id))) { const p = (await q.one(`select public.prepare_notification_send($1,$2) p`, [j.id, at(MON, '11:06')])).p; r.push({ p, st: await q.one(`select status, error from public.notification_jobs where id=$1`, [j.id]) }); }
      return r;
    });
    expect(out.length).toBeGreaterThanOrEqual(3);
    for (const o of out) {
      expect(o.p).toEqual({ action: 'skip', reason: 'skipped_no_template' });
      expect(o.st).toEqual({ status: 'skipped_no_template', error: 'Horario sin plantilla asignada' });
    }
    expect((await db.su.query(`select count(*)::int c from public.audit_logs where action='notification_no_template'`)).rows[0].c).toBe(out.length);
    expect((await db.su.query(`select count(*)::int c from public.notification_jobs where status in ('sent','processing') and driver_id = any($1)`, [[x.driver, y.driver, z.driver]])).rows[0].c).toBe(0);
  });
  it('plantilla eliminada tras asignar no es posible por el guard (la FK queda protegida)', async () => {
    await reset();
    const t = await mkTpl('o-protegida'); await mkSend('Protegida', t, true);
    expect((await err(adm, `delete from public.message_templates where id=$1`, [t]))?.message).toBe('template_in_use');
    expect((await db.su.query(`select 1 from public.message_templates where id=$1`, [t])).rowCount).toBe(1);
  });
  it('con plantilla: envía; consentimiento, límites y saldo cero siguen intactos; variable sin resolver no se envía', async () => {
    await reset();
    await adm((q) => q.one(`select * from public.create_template_from_default('debt_first', 'base ok', (select id from public.notification_schedules where kind='debt_first'))`));
    await svc((q) => q.query(`update public.notification_schedules set enabled=true where kind='debt_first'`));
    const ok = await mk(); const noConsent = await mk(); const paid = await mk();
    await db.su.query(`update public.drivers set whatsapp_consent=false where id=$1`, [noConsent.driver]);
    await db.su.query(`update public.payments set voided_at=voided_at where false`);
    await db.su.query(`insert into public.charges(assignment_id, kind, charge_date, amount_cents, week_start) values ($1,'adjustment',$2,0,app_private.week_start_of($2::date))`, [paid.assignment, MON]).catch(() => undefined);
    const out = await tick(at(MON, '11:05'));
    const o = out.find((r) => r.driver === ok.driver)!;
    expect(o).toMatchObject({ action: 'send', status: 'sent' });
    expect(o.body).toBe(`Buenos días, Vanessa Ejemplo.\n\nUnidad: STU${n - 2}\nFecha: lunes 2 de marzo de 2026\n\nSu cuota pendiente de hoy es de $40.00.\n\nGracias por su atención.`);
    expect(out.find((r) => r.driver === noConsent.driver)).toBeUndefined();            // sin consentimiento: ni se programa
    // variable sin resolver → no se envía
    const u = await mkTpl('o-sinresolver', 'Hola {{apellido}}');
    await adm((q) => q.query(`update public.notification_schedules set template_id=$1 where kind='debt_first'`, [u]));
    const w = await mk(); await db.su.query(`update public.drivers set last_name='' where id=$1`, [w.driver]);
    expect((await tick(at(MON, '11:10'))).find((r) => r.driver === w.driver)).toMatchObject({ action: 'skip', reason: 'skipped_unresolved' });
  });
  it('vista previa del horario == texto de prepare_notification_send; sin plantilla → source none', async () => {
    await reset();
    const s = await sch('debt_update');
    const x = await mk();
    const none = await adm((q) => q.one(`select public.preview_schedule($1,$2,$3::date) p`, [s.id, x.assignment, MON]));
    expect(none.p).toMatchObject({ text: null, unresolved: [], source: 'none', schedule: { id: s.id, kind: 'debt_update', label: 'Recordatorio actualizado', enabled: false, template_id: null, template_name: null } });
    const t = await adm((q) => q.one(`select * from public.create_template_from_default('debt_update', 'Prev', $1)`, [s.id]));
    await svc((q) => q.query(`update public.notification_schedules set enabled=true where id=$1`, [s.id]));
    const pv = (await adm((q) => q.one(`select public.preview_schedule($1,$2,$3::date) p`, [s.id, x.assignment, MON]))).p;
    expect(pv).toMatchObject({ source: 'template', unresolved: [], schedule: { template_id: t.id, template_name: 'Prev', local_time: '17:00:00', enabled: true } });
    const out = (await tick(at(MON, '17:05'))).find((r) => r.driver === x.driver)!;
    expect(out.action).toBe('send');
    expect(out.body).toBe(pv.text);
    expect(await adm((q) => q.fails(`select public.preview_schedule($1,$2,null)`, [randomUUID(), x.assignment]))).toBe('schedule_not_found');
    expect(await db.as(db.outsider, (q) => q.fails(`select public.preview_schedule($1,$2,null)`, [s.id, x.assignment]))).toBe('forbidden');
  });
});

describe('0023 → 0024 sobre una base con datos (no destructiva)', () => {
  let admin: pg.Client; let up: pg.Client; let name: string;
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  const MIG = '20261116002400_schedule_templates.sql';
  beforeAll(async () => {
    const c = inject('pgCluster');
    name = `st_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
    admin = new pg.Client(connConfig(c, 'postgres')); await admin.connect(); await admin.query(`create database ${name}`);
    up = new pg.Client(connConfig(c, name)); await up.connect();
    await up.query(readFileSync(STUB_SQL, 'utf8'));
    for (const f of files.filter((x) => x < MIG)) await up.query(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'));
  });
  afterAll(async () => { await up.end(); await admin.query(`drop database if exists ${name} with (force)`); await admin.end(); });
  it('no modifica horarios, plantillas ni trabajos; el horario activo sin plantilla queda igual y deja de crear trabajos', async () => {
    await up.query(`insert into public.message_templates(name, body) values ('Primer recordatorio', 'Hola {{nombre}}')`);
    await up.query(`update public.notification_schedules set enabled=true where kind='debt_update'`);         // legado: activo sin plantilla
    const snap = async () => ({
      s: (await up.query(`select * from public.notification_schedules order by id`)).rows,
      t: (await up.query(`select * from public.message_templates order by id`)).rows,
      j: (await up.query(`select count(*)::int c from public.notification_jobs`)).rows[0].c,
    });
    const before = await snap();
    await up.query(readFileSync(join(MIGRATIONS_DIR, MIG), 'utf8'));
    expect(await snap()).toEqual(before);
    expect(before.s.filter((r: { enabled: boolean; template_id: string | null }) => r.enabled && r.template_id === null)).toHaveLength(1);
    // y a partir de ahora no programa nada para ese horario
    const d = (await up.query(`insert into public.drivers(operator_code, national_id, first_name, phone_e164, whatsapp_consent) values ('UP1','9-9-9','X','+50760011111',true) returning id`)).rows[0].id;
    const u = (await up.query(`insert into public.units(code) values ('UPU') returning id`)).rows[0].id;
    const a = (await up.query(`insert into public.assignments(driver_id, unit_id, valid_from) values ($1,$2,'2026-01-01') returning id`, [d, u])).rows[0].id;
    await up.query(`insert into public.charges(assignment_id, kind, charge_date, amount_cents, week_start) values ($1,'daily','2026-03-02',4000,'2026-03-02')`, [a]);
    expect((await up.query(`select public.schedule_reminders($1) n`, [at(MON, '17:05')])).rows[0].n).toBe(0);
  });
});

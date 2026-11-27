import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newDb, type Db, type Q } from './harness.js';

/** 0035: horarios de envío = plantilla + audiencia + hora; crean los mensajes con el mismo método que Cobranza. */
let db: Db; let n = 0; let tpl: string;
const adm = <T>(fn: (q: Q) => Promise<T>) => db.as(db.opsAdmin, fn);
const DAY = '2026-11-23';                                  // lunes
const AT_2230 = '2026-11-24T03:30:00Z';                    // 22:30 del lunes en Panamá (UTC-5)
const ALL = '{1,2,3,4,5,6,7}';
const mk = async (saldo: number | null, paidToday = 0) => {
  n += 1; const x = await db.driverWithAssignment({ code: `SC${n}`, unit: `SCU${n}`, dailyCents: 3000, from: '2026-11-01' });
  await db.su.query(`update public.drivers set phone_e164=$2, first_name='Ana', last_name='' where id=$1`, [x.driver, `+507611300${String(10 + n)}`]);
  if (saldo !== null) {
    await db.su.query(`insert into public.collection_week_units(week_start, unit_id, unit_code, assignment_id, driver_id, saldo_excel_cents)
      select $1::date, a.unit_id, 'X', a.id, a.driver_id, $3 from public.assignments a where a.id=$2`, [DAY, x.assignment, saldo]);
    if (paidToday > 0) {
      const pid = (await db.su.query(`insert into public.payments(assignment_id, method_id, gross_cents, net_cents, applied_cents, week_start, registered_by, idempotency_key, paid_at)
        values ($1, (select id from public.payment_methods where code='excel'), $2, $2, $2, '2026-11-23', $4, $3, '2026-11-23T15:00:00Z') returning id`, [x.assignment, paidToday, `sc-pay-${n}-key-0001`, db.admin])).rows[0].id;
      await db.su.query(`insert into public.excel_payment_days(assignment_id, pay_date, week_start, driver_id, amount_cents, payment_id) values ($1,$2,$3,$4,$5,$6)`, [x.assignment, DAY, DAY, x.driver, paidToday, pid]);
    }
  }
  return x;
};
const save = (name: string, time: string, audience: string, enabled = true, weekdays = ALL, template: string | null = tpl, id: string | null = null) =>
  adm((q) => q.one(`select * from public.save_send_schedule($1,$2,$3::time,$4::smallint[],$5,$6,$7)`, [id, name, time, weekdays, template, audience, enabled]));
const run = (now = AT_2230) => db.asService((q) => q.one(`select public.run_send_schedules($1::timestamptz) r`, [now])).then((r: any) => r.r as any[]);
const msgs = async () => (await db.su.query(`select * from public.whatsapp_test_messages where kind='collection_message' order by created_at`)).rows;
const count = (a: string) => adm((q) => q.one(`select public.send_schedule_audience_count($1,$2::date) n`, [a, DAY])).then((r: any) => r.n as number);

let A: Awaited<ReturnType<typeof mk>>, B: typeof A, C: typeof A, D: typeof A;
beforeAll(async () => {
  db = await newDb();
  tpl = (await db.su.query(`insert into public.message_templates(name, body) values ('Noche','Hola {{nombre}}, tu saldo es {{saldo_total}}.') returning id`)).rows[0].id;
  await db.su.query(`insert into public.payment_methods(code, label) values ('excel','Excel') on conflict (code) do nothing`);
  await db.su.query(`insert into public.excel_imports(file_name, file_sha256, status, source_kind, created_by, applied_at) values ('DATOS.xlsx', 'sha-sched', 'applied', 'collection_flat', $1, now())`, [db.opsAdmin]);
  A = await mk(5000);            // con saldo
  B = await mk(0);               // al día
  C = await mk(null);            // sin importación del Excel (no gestionada)
  D = await mk(2000, 3000);      // con saldo y pagó hoy
}, 120_000);
afterAll(async () => { await db.close(); });

describe('audiencias (solo con datos del Excel)', () => {
  it('cuenta a quién llegaría cada audiencia', async () => {
    expect(await count('all')).toBe(4);
    expect(await count('with_balance')).toBe(3);        // A, B y D: deben algo hoy (SALDO + cuotas de la semana − pagos)
    expect(await count('without_balance')).toBe(0);     // nadie está a cero: hoy hay cuota
    expect(await count('paid_today')).toBe(1);          // D
    expect(await count('not_paid_today')).toBe(2);      // A y B (C no está gestionada por el Excel: no se sabe)
    expect(await adm((q) => q.fails(`select public.send_schedule_audience_count('x')`))).toMatch(/invalid_audience/);
  });
});

describe('permisos', () => {
  it('solo ADMIN+ gestiona horarios; las tablas no se tocan desde el cliente; solo el worker ejecuta', async () => {
    expect(await db.as(db.supervisor, (q) => q.fails(`select * from public.list_send_schedules()`))).toMatch(/forbidden|permission/i);
    expect(await db.asAnon((q) => q.fails(`select * from public.list_send_schedules()`))).toMatch(/permission denied/);
    expect(await adm((q) => q.fails(`select * from public.send_schedules`))).toMatch(/permission denied/);
    expect(await adm((q) => q.fails(`insert into public.send_schedules(name, local_time) values ('x','10:00')`))).toMatch(/permission denied/);
    expect(await adm((q) => q.fails(`select public.run_send_schedules()`))).toMatch(/permission denied/);
    expect(await db.asAnon((q) => q.fails(`select public.run_send_schedules()`))).toMatch(/permission denied/);
  });
  it('un horario activo exige plantilla', async () => {
    expect(await adm((q) => q.fails(`select * from public.save_send_schedule(null,'Sin plantilla','10:00','{1}',null,'all',true)`))).toMatch(/template_required/);
    const off = await save('Borrador', '10:00', 'all', false, ALL, null);
    expect(off.enabled).toBe(false); expect(off.armed_by).toBeNull();
    await adm((q) => q.query(`select public.delete_send_schedule($1)`, [off.id]));
  });
});

describe('ejecución', () => {
  it('a la hora indicada crea los mensajes de la audiencia, autorizados por quien activó el horario, y no se repite', async () => {
    const s = await save('Todas las noches', '22:00', 'with_balance');
    expect(s.armed_by).toBe(db.opsAdmin);
    expect(await run('2026-11-24T02:59:00Z')).toEqual([]);                                  // 21:59: aún no es la hora
    const r = await run();
    expect(r).toEqual([{ schedule: 'Todas las noches', total: 3, created: 3 }]);
    const m = await msgs();
    expect(m).toHaveLength(3);
    expect(m.every((x) => /^Hola Ana, tu saldo es \$\d+\.\d{2}\.$/.test(x.body))).toBe(true);        // el importe depende de la fecha real del envío (aquí solo se simula la hora del horario)
    expect(m.every((x) => x.authorized_by === db.opsAdmin && x.kind === 'collection_message' && x.template_id === tpl && x.status === 'prepared')).toBe(true);
    expect(m.every((x) => /^sched:/.test(x.idempotency_key))).toBe(true);
    expect(await run('2026-11-24T03:45:00Z')).toEqual([]);                                  // misma noche: ya se ejecutó
    expect(await msgs()).toHaveLength(3);
    const l = (await adm((q) => q.rows(`select * from public.list_send_schedules()`))).find((x: any) => x.name === 'Todas las noches') as any;
    expect(l).toMatchObject({ last_run_status: 'done', last_run_created: 3, last_run_total: 3, template_name: 'Noche', audience: 'with_balance' });
  });
  it('«todos»: lo que ya se envió hoy se omite con su motivo y NO detiene a los demás', async () => {
    await db.su.query(`delete from public.send_schedule_runs`); await db.su.query(`update public.send_schedules set enabled=false`);
    const s = await save('Todos', '22:15', 'all');
    const r = await run('2026-11-24T03:30:00Z');
    expect(r[0]).toMatchObject({ schedule: 'Todos', total: 4, created: 1 });                // A, B y D ya recibieron hoy esa plantilla; solo C (sin Excel: cálculo anterior) sale
    const run1 = (await db.su.query(`select * from public.send_schedule_runs where schedule_id=$1`, [s.id])).rows[0];
    expect(run1.skipped).toEqual({ already_sent_today: 3 });
    expect((await msgs()).length).toBe(4);
  });
  it('un horario desactivado, fuera de sus días o con el worker apagado más de 3 h NO envía; el día siguiente sí', async () => {
    await db.su.query(`delete from public.send_schedule_runs`); await db.su.query(`delete from public.whatsapp_test_messages`); await db.su.query(`update public.send_schedules set enabled=false`);
    const off = await save('Apagado', '22:00', 'all', false);
    expect(await run()).toEqual([]);
    const tue = await save('Solo martes', '22:00', 'with_balance', true, '{2}');
    expect(await run()).toEqual([]);                                                        // es lunes
    await adm((q) => q.query(`select public.delete_send_schedule($1)`, [tue.id])); await adm((q) => q.query(`select public.delete_send_schedule($1)`, [off.id]));
    await db.su.query(`update public.send_schedules set enabled=false`);
    const late = await save('Tarde', '18:00', 'with_balance');                              // eran las 18:00 y el worker volvió a las 22:30 (> 3 h)
    expect(await run()).toEqual([]);
    expect((await db.su.query(`select status from public.send_schedule_runs where schedule_id=$1`, [late.id])).rows[0].status).toBe('missed');
    expect(await msgs()).toHaveLength(0);
    expect(await run('2026-11-24T04:00:00Z')).toEqual([]);                                  // sigue contando como perdido ese día
  });
  it('si ya la había enviado Cobranza a mano, el horario no duplica; el worker deja un rastro auditable', async () => {
    await db.su.query(`delete from public.send_schedule_runs`); await db.su.query(`delete from public.whatsapp_test_messages`); await db.su.query(`update public.send_schedules set enabled=false`);
    await adm((q) => q.query(`select public.create_collection_message($1,$2,'manual-key-0001',false)`, [A.assignment, tpl]));
    await save('Con manual', '22:00', 'with_balance');
    const r = await run();
    expect(r[0]).toMatchObject({ total: 3, created: 2 });
    expect((await msgs()).filter((x) => x.assignment_id === A.assignment)).toHaveLength(1);
    expect((await db.su.query(`select detail from public.audit_logs where action='send_schedule.ran' order by at desc limit 1`)).rows[0].detail).toMatchObject({ created: 2, skipped: { already_sent_today: 1 } });
  });
});

describe('plantillas en uso', () => {
  it('no se puede eliminar una plantilla usada por un horario; al quitarla el horario se desactiva solo; luego sí se elimina', async () => {
    const t2 = (await db.su.query(`insert into public.message_templates(name, body) values ('Otra','Hola {{nombre}}') returning id`)).rows[0].id;
    const s = await save('Usa otra', '23:00', 'all', true, ALL, t2);
    expect(await db.su.query(`delete from public.message_templates where id=$1`, [t2]).then(() => 'borrada', (e) => e.message)).toMatch(/template_in_use/);
    expect(await adm((q) => q.rows(`select * from public.template_usage($1)`, [t2]))).toMatchObject([{ label: 'Usa otra', kind: 'broadcast', enabled: true }]);
    const after = await save('Usa otra', '23:00', 'all', true, ALL, null, s.id).then(() => 'permitido', (e: any) => e.message);
    expect(after).toMatch(/template_required/);                                              // no se puede dejar ACTIVO sin plantilla
    const off = await save('Usa otra', '23:00', 'all', false, ALL, null, s.id);
    expect(off).toMatchObject({ enabled: false, template_id: null });
    await db.su.query(`delete from public.message_templates where id=$1`, [t2]);
    expect((await db.su.query(`select count(*)::int n from public.message_templates where id=$1`, [t2])).rows[0].n).toBe(0);
  });
});

describe('0043 · conductores elegidos a mano', () => {
  const saveSel = (name: string, ids: string[], enabled = true) => adm((q) => q.one(`select * from public.save_send_schedule(null,$1,'22:00'::time,$2::smallint[],$3,'selected',$4,$5::uuid[])`, [name, ALL, tpl, enabled, ids]));
  it('envía SOLO a los marcados (hayan pagado o no) y guarda la lista', async () => {
    await db.su.query(`delete from public.send_schedule_runs`); await db.su.query(`delete from public.whatsapp_test_messages`); await db.su.query(`update public.send_schedules set enabled=false`);
    const s = await saveSel('Elegidos', [A.assignment, D.assignment, A.assignment]);
    expect(s.assignment_ids.length).toBe(2);
    const r = await run();
    expect(r).toEqual([{ schedule: 'Elegidos', total: 2, created: 2 }]);
    expect((await msgs()).map((m) => m.assignment_id).sort()).toEqual([A.assignment, D.assignment].sort());
    expect((await adm((q) => q.rows(`select * from public.list_send_schedules()`))).find((x: any) => x.name === 'Elegidos')).toMatchObject({ audience: 'selected' });
  });
  it('activo sin ningún conductor marcado no se permite; los ids desconocidos se descartan', async () => {
    expect(await adm((q) => q.fails(`select public.save_send_schedule(null,'Vacío','22:00'::time,$1::smallint[],$2,'selected',true,'{}'::uuid[])`, [ALL, tpl]))).toBe('selection_required');
    expect((await saveSel('Fantasma', ['00000000-0000-0000-0000-000000000000'], false)).assignment_ids).toEqual([]);
  });
});

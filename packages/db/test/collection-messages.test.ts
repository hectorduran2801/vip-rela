import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newDb, type Db, type Q } from './harness.js';

let db: Db; let n = 0;
let imp: string;
beforeAll(async () => { db = await newDb(); });
const sync = async () => { imp = (await db.su.query(`insert into public.excel_imports(file_name, file_sha256, status, source_kind, created_by, applied_at) values ('DATOS.xlsx', $1, 'applied', 'collection_flat', $2, now()) returning id`, [`sha-${Math.random()}`, db.opsAdmin])).rows[0].id; };
afterAll(async () => { await db.close(); });
const adm = <T>(fn: (q: Q) => Promise<T>) => db.as(db.opsAdmin, fn);
const svc = <T>(fn: (q: Q) => Promise<T>) => db.asService(fn);
const key = () => `cm-${++n}-${Math.random().toString(36).slice(2)}`;
const driver = async (o: { phone?: string | null } = {}) => {
  n += 1; const x = await db.driverWithAssignment({ code: `CM${n}`, unit: `CMU${n}`, dailyCents: 3600 });
  await db.su.query(`update public.drivers set phone_e164=$2, first_name='Ana', last_name='Pérez' where id=$1`, [x.driver, o.phone === null ? null : (o.phone ?? `+5076777${String(1000 + n)}`)]);
  return x;
};
const tpl = async (name: string, body: string) => (await db.su.query(`insert into public.message_templates(name, body) values ($1,$2) returning id`, [name, body])).rows[0].id as string;
const create = (asg: string, t: string, repeat = false, k = key()) => adm((q) => q.one(`select * from public.create_collection_message($1,$2,$3,$4)`, [asg, t, k, repeat]));

describe('mensajes de cobranza por plantilla', () => {
  it('sin ninguna importación exitosa del Excel no se envía nada (no_sync)', async () => {
    const x = await driver(); const t = await tpl('Sin sync', 'Hola {{nombre}}');
    expect(await adm((q) => q.fails(`select * from public.create_collection_message($1,$2,$3,false)`, [x.assignment, t, key()]))).toBe('no_sync');
    const pv = await adm((q) => q.one(`select public.preview_collection_messages($1::uuid[], $2) r`, [[x.assignment], t]));
    expect(pv.r.lastSync).toBeNull(); expect(pv.r.items[0].reason).toBe('no_sync');
    await sync();
  });
  it('crea el mensaje con el texto real, sin exigir autorización del conductor, y guarda la plantilla usada', async () => {
    const x = await driver(); const t = await tpl('Recordatorio A', 'Hola {{nombre}}, unidad {{unidad}}.');
    expect((await db.su.query(`select whatsapp_consent from public.drivers where id=$1`, [x.driver])).rows[0].whatsapp_consent).toBe(false);
    const m = await create(x.assignment, t);
    expect(m).toMatchObject({ kind: 'collection_message', status: 'prepared', template_id: t, template_name: 'Recordatorio A', driver_id: x.driver, assignment_id: x.assignment, import_id: imp });
    expect(m.variables).toMatchObject({ nombre: 'Ana' });                      // copia de los valores usados
    expect(m.body).toMatch(/^Hola Ana, unidad CMU\d+\.$/);
    expect((await create(x.assignment, t, false, (m as { idempotency_key: string }).idempotency_key)).id).toBe(m.id);   // idempotente
  });
  it('misma plantilla el mismo día pide confirmar el reenvío; otra plantilla se puede enviar siempre', async () => {
    const x = await driver(); const a = await tpl('Plantilla uno', 'Hola {{nombre}}'); const b = await tpl('Plantilla dos', 'Aviso {{nombre}}');
    await create(x.assignment, a);
    expect(await adm((q) => q.fails(`select * from public.create_collection_message($1,$2,$3,false)`, [x.assignment, a, key()]))).toBe('already_sent_today');
    expect((await create(x.assignment, b)).template_name).toBe('Plantilla dos');
    expect((await create(x.assignment, a, true)).status).toBe('prepared');
    const s = (await adm((q) => q.rows(`select * from public.collection_message_summary() where driver_id = $1`, [x.driver])))[0];
    expect(s.sent_today).toBe(3);
  });
  it('bloquea sin teléfono, inactivo, plantilla con variables sin resolver y roles sin permiso', async () => {
    const t = await tpl('P3', 'Hola {{nombre}}');
    const a = await driver({ phone: null });
    expect(await adm((q) => q.fails(`select * from public.create_collection_message($1,$2,$3,false)`, [a.assignment, t, key()]))).toBe('driver_without_phone');
    const b = await driver(); await db.su.query(`update public.drivers set status='inactive' where id=$1`, [b.driver]);
    expect(await adm((q) => q.fails(`select * from public.create_collection_message($1,$2,$3,false)`, [b.assignment, t, key()]))).toBe('driver_inactive');
    const c = await driver(); const bad = await tpl('P4', 'Hola {{variable_rara}}');
    expect(await adm((q) => q.fails(`select * from public.create_collection_message($1,$2,$3,false)`, [c.assignment, bad, key()]))).toBe('template_unresolved');
    expect(await db.as(db.outsider, (q) => q.fails(`select * from public.create_collection_message($1,$2,$3,false)`, [c.assignment, t, key()]))).toBe('forbidden');
  });
  it('el worker lo toma; se cancela si el operario dejó de estar activo', async () => {
    while ((await svc((q) => q.one(`select * from public.claim_test_message()`)))?.id) { /* vaciar cola */ }
    const x = await driver(); const t = await tpl('P5', 'Hola {{nombre}}');
    const m = await create(x.assignment, t);
    await db.su.query(`update public.drivers set status='inactive' where id=$1`, [x.driver]);
    expect((await svc((q) => q.one(`select * from public.claim_test_message()`)))?.id).toBeFalsy();
    expect((await db.su.query(`select status from public.whatsapp_test_messages where id=$1`, [m.id])).rows[0].status).toBe('cancelled');
    const y = await driver(); const m2 = await create(y.assignment, t);
    expect((await svc((q) => q.one(`select * from public.claim_test_message()`))).id).toBe(m2.id);
  });
  it('variables nuevas: cuota_diaria, pago_hoy, acuerdo, dia_semana (sin inventar valores)', async () => {
    const x = await driver(); await db.su.query(`update public.units set agreement='Paga los viernes' where id=(select unit_id from public.assignments where id=$1)`, [x.assignment]);
    const t = await tpl('Vars', '{{nombre_completo}}|{{unidad}}|{{cuota_diaria}}|{{pago_hoy}}|{{acuerdo}}|{{dia_semana}}|{{saldo_total}}');
    const m = await create(x.assignment, t);
    expect(m.body).toMatch(/^Ana Pérez\|CMU\d+\|\$36\.00\|\$0\.00\|Paga los viernes\|(lunes|martes|miércoles|jueves|viernes|sábado|domingo)\|\$/);
    const y = await driver(); const t2 = await tpl('Sin acuerdo', 'Acuerdo: {{acuerdo}}');
    expect(await adm((q) => q.fails(`select * from public.create_collection_message($1,$2,$3,false)`, [y.assignment, t2, key()]))).toBe('template_unresolved');
    const vars = await adm((q) => q.rows(`select code from public.template_variables()`));
    for (const c of ['cuota_diaria', 'pago_hoy', 'acuerdo', 'dia_semana', 'saldo_total', 'pagos_semana']) expect(vars.map((v) => v.code)).toContain(c);
  });
  it('conflicto de identidad: el mismo número en dos operarios distintos bloquea ambos envíos; varias unidades del MISMO operario no', async () => {
    const a = await driver({ phone: '+50761230001' }); const b = await driver({ phone: '+50761230001' }); const t = await tpl('Ident', 'Hola {{nombre}}');
    for (const x of [a, b]) expect(await adm((q) => q.fails(`select * from public.create_collection_message($1,$2,$3,false)`, [x.assignment, t, key()]))).toBe('phone_shared');
    const pv = await adm((q) => q.one(`select public.preview_collection_messages($1::uuid[], $2) r`, [[a.assignment, b.assignment], t]));
    expect(pv.r.items.map((i: any) => i.reason)).toEqual(['phone_shared', 'phone_shared']);
    expect(pv.r.lastSync).toMatchObject({ importId: imp, fileName: 'DATOS.xlsx' });
  });
  it('asignación terminada no recibe mensajes; la vista previa muestra mensaje, número y motivo de cada una', async () => {
    const x = await driver(); await db.su.query(`update public.assignments set valid_to = current_date - 1 where id=$1`, [x.assignment]);
    const ok = await driver(); const t = await tpl('Prev', 'Hola {{nombre}} ({{unidad}})');
    const pv = await adm((q) => q.one(`select public.preview_collection_messages($1::uuid[], $2) r`, [[x.assignment, ok.assignment], t]));
    expect(pv.r.items[0].reason).toBe('assignment_ended');
    expect(pv.r.items[1]).toMatchObject({ reason: null, text: expect.stringContaining('Hola Ana'), phone: expect.stringMatching(/^\+507/) });
  });
  it('control diario: lote (batch_id), plantillas enviadas hoy y último mensaje exacto por unidad', async () => {
    const x = await driver(); const a = await tpl('Diario A', 'Hola {{nombre}} A'); const b = await tpl('Diario B', 'Hola {{nombre}} B');
    const m1 = await create(x.assignment, a, false, `lote-77:${x.assignment}`);
    await create(x.assignment, b);
    expect(m1.batch_id).toBe('lote-77');
    const s2 = (await adm((q) => q.rows(`select * from public.collection_message_summary() where assignment_id = $1`, [x.assignment])))[0];
    expect(s2).toMatchObject({ driver_id: x.driver, template_name: 'Diario B', sent_today: 2, body: 'Hola Ana B' });
    expect([...s2.templates_today].sort()).toEqual(['Diario A', 'Diario B']);
    expect(s2.message_id).toBeTruthy();
  });
});

describe('0031 · desvincular conductor corta los mensajes de cobranza', () => {
  it('una asignación con fecha de fin HOY (o antes) ya no recibe mensajes; las otras unidades del mismo operario sí', async () => {
    const x = await driver(); const t = await tpl('Corta', 'Hola {{nombre}}');
    await db.su.query(`update public.assignments set valid_to = (now() at time zone 'America/Panama')::date where id=$1`, [x.assignment]);
    expect(await adm((q) => q.fails(`select * from public.create_collection_message($1,$2,$3,false)`, [x.assignment, t, key()]))).toBe('assignment_ended');
    const other = (await db.su.query(`insert into public.units(code) values ('CMU-OTRA') returning id`)).rows[0].id;
    const a2 = (await db.su.query(`insert into public.assignments(unit_id, driver_id, valid_from) values ($1,$2,current_date - 10) returning id`, [other, x.driver])).rows[0].id;
    expect((await create(a2, t)).status).toBe('prepared');                                          // la otra unidad del mismo conductor sigue recibiendo
  });
});

describe('0030 · jornada diaria: purga de mensajes de cobranza de días anteriores', () => {
  const svc = <T>(fn: (q: Q) => Promise<T>) => db.asService(fn);
  const put = async (x: { driver: string; assignment: string }, status: string, daysAgo: number, kind = 'collection_message') =>
    (await db.su.query(`insert into public.whatsapp_test_messages(kind, recipient_phone, body, requested_mode, authorized_by, idempotency_key, driver_id, assignment_id, template_name, status, created_at)
      values ($1, '+50760001234', 'texto', 'auto', $2, $3, $4, $5, 'Plantilla X', $6, now() - make_interval(days => $7)) returning id`,
      [kind, db.opsAdmin, `purge-${Math.random()}`, x.driver, x.assignment, status, daysAgo])).rows[0].id as string;
  it('borra solo los terminados de días anteriores; conserva los de hoy, los pendientes/en proceso/sin confirmar y otros tipos; deja auditoría', async () => {
    const x = await driver();
    const old = [await put(x, 'sent', 2), await put(x, 'simulated', 3), await put(x, 'failed', 5), await put(x, 'cancelled', 2), await put(x, 'delivered', 9)];
    const keep = [await put(x, 'sent', 0), await put(x, 'prepared', 4), await put(x, 'processing', 4), await put(x, 'unconfirmed', 6), await put(x, 'sent', 3, 'driver_message')];
    const r = await svc((q) => q.one(`select public.purge_collection_messages() r`));
    expect(r.r).toMatchObject({ deleted: 5, by_status: { sent: 1, simulated: 1, failed: 1, cancelled: 1, delivered: 1 } });
    expect((await db.su.query(`select id from public.whatsapp_test_messages where id = any($1::uuid[])`, [old])).rowCount).toBe(0);
    expect((await db.su.query(`select id from public.whatsapp_test_messages where id = any($1::uuid[])`, [keep])).rowCount).toBe(5);
    expect((await db.su.query(`select count(*)::int n from public.audit_logs where action='purge_collection_messages'`)).rows[0].n).toBe(1);
    expect((await svc((q) => q.one(`select public.purge_collection_messages() r`))).r.deleted).toBe(0);                // idempotente
  });
  it('no toca operarios, unidades, asignaciones, pagos, cuotas ni plantillas; solo el servicio (y ADMIN a mano) puede ejecutarla', async () => {
    const x = await driver(); const t = await tpl('No se borra', 'Hola');
    await put(x, 'sent', 4);
    const snap = async () => (await db.su.query(`select (select count(*) from public.drivers)::int d, (select count(*) from public.units)::int u, (select count(*) from public.assignments)::int a,
      (select count(*) from public.charges)::int c, (select count(*) from public.payments)::int p, (select count(*) from public.message_templates)::int t, (select count(*) from public.excel_imports)::int i`)).rows[0];
    const before = await snap();
    await svc((q) => q.one(`select public.purge_collection_messages() r`));
    expect(await snap()).toEqual(before); expect(t).toBeTruthy();
    expect(await adm((q) => q.fails(`select public.purge_collection_messages()`))).toMatch(/permission denied/);
    expect(await db.asAnon((q) => q.fails(`select public.purge_collection_messages()`))).toMatch(/permission denied/);
  });
});

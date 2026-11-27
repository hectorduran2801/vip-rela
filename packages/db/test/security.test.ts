import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MON, chargeWeek, key, pay } from './fixtures.js';
import { newDb, type Db } from './harness.js';

let db: Db;
let a: { driver: string; unit: string; assignment: string };
let paymentId: string;

beforeAll(async () => {
  db = await newDb();
  a = await db.driverWithAssignment({ code: '1001', unit: 'P1', dailyCents: 3600 });
  await chargeWeek(db, MON);
  paymentId = (await db.as(db.admin, (q) => pay(q, a.assignment, 'yappy', 23000, { paidAt: `${MON}T09:00:00-05:00` }))).payment_id;   // crea crédito → aviso pendiente
  await db.su.query(`insert into public.rate_exceptions(assignment_id, on_date, amount_cents, reason) values ($1,'2026-03-04',0,'día libre')`, [a.assignment]);
  await db.su.query(`insert into public.message_templates(name, body) values ('prueba','Hola {{nombre}}')`);
  await db.as(db.admin, (q) => q.query(`select public.create_adjustment($1, 100, $2::date, 'ajuste de prueba', $3)`, [a.assignment, MON, key()]));
  await db.as(db.admin, (q) => q.query(`select public.close_week($1)`, [MON]));   // deja un cierre semanal
});
afterAll(async () => { await db.close(); });

const TABLES = ['app_settings', 'drivers', 'units', 'assignments', 'rates', 'rate_exceptions', 'payment_methods', 'charges', 'payments', 'payment_allocations',
  'adjustments', 'weekly_closures', 'whatsapp_sessions', 'message_templates', 'notification_schedules', 'notification_jobs', 'excel_imports', 'audit_logs', 'profiles'];
const COL: Record<string, string> = { payments: 'created_at', charges: 'created_at', adjustments: 'created_at', payment_allocations: 'amount_cents', weekly_closures: 'closed_at', audit_logs: 'at' };
const FINANCIAL = ['payments', 'charges', 'adjustments', 'payment_allocations', 'weekly_closures', 'audit_logs'];

describe('acceso solo para la administradora autorizada (RLS)', () => {
  it.each(TABLES)('la administradora lee %s', async (t) => {
    const n = await db.as(db.admin, async (q) => (await q.rows(`select 1 from public.${t}`)).length);
    expect(n).toBeGreaterThan(0 - 1);   // permitido (puede estar vacía)
  });
  it.each(TABLES)('un usuario autenticado NO autorizado no ve filas de %s', async (t) => {
    const total = Number((await db.su.query(`select count(*) n from public.${t}`)).rows[0].n);
    const seen = await db.as(db.outsider, async (q) => (await q.rows(`select 1 from public.${t}`)).length);
    expect(seen).toBe(0);
    if (!['weekly_closures', 'adjustments', 'payment_allocations', 'excel_imports', 'notification_jobs'].includes(t)) expect(total, `hay datos en ${t}`).toBeGreaterThan(0);
  });
  it.each(TABLES)('anon no puede leer %s', async (t) => {
    expect(await db.asAnon((q) => q.fails(`select * from public.${t}`))).toMatch(/permission denied/);
  });
  it('la tabla de la cuenta autorizada y los secretos de WhatsApp no son accesibles desde el navegador', async () => {
    const sid = (await db.su.query(`select id from public.whatsapp_sessions`)).rows[0].id;
    await db.su.query(`insert into public.whatsapp_session_secrets(session_id, encrypted_session) values ($1,'\\xdeadbeef')`, [sid]);
    for (const who of [db.admin, db.outsider]) {
      expect(await db.as(who, (q) => q.fails(`select * from public.app_users`))).toMatch(/permission denied/);
      expect(await db.as(who, (q) => q.fails(`select * from public.whatsapp_session_secrets`))).toMatch(/permission denied/);
    }
    expect(await db.asAnon((q) => q.fails(`select * from public.whatsapp_session_secrets`))).toMatch(/permission denied/);
    expect((await db.asService((q) => q.rows(`select session_id from public.whatsapp_session_secrets`))).length).toBe(1);
  });
});

describe('un usuario autenticado que no es la administradora no puede hacer nada', () => {
  const call = (sql: string, params: unknown[] = []) => db.as(db.outsider, (q) => q.fails(sql, params));
  it('no puede ejecutar ninguna operación del negocio', async () => {
    const r = await Promise.all([
      call(`select public.register_payment($1,'cash',1000,$2)`, [a.assignment, key()]),
      call(`select public.void_payment($1,'intento')`, [paymentId]),
      call(`select public.create_adjustment($1,500,'2026-03-02','intento',$2)`, [a.assignment, key()]),
      call(`select public.generate_daily_charges('2026-03-03')`),
      call(`select public.close_week('2026-03-02')`),
      call(`select public.dashboard_summary()`),
      call(`select * from public.weekly_collection_table('2026-03-02')`),
      call(`select public.period_summary('2026-03-02','2026-03-08')`),
      call(`select public.start_assignment($1,$2,'2026-04-01')`, [a.driver, a.unit]),
      call(`select public.change_rate($1,100,'2026-04-01')`, [a.assignment]),
      call(`select public.preview_template($1,'hola')`, [a.assignment]),
      call(`select * from public.template_variables()`),
    ]);
    r.forEach((e) => expect(e).toBe('forbidden'));
  });
  it('no puede escribir en ninguna tabla', async () => {
    expect(await db.as(db.outsider, (q) => q.fails(`insert into public.drivers(operator_code, national_id, first_name) values ('x','x','x')`))).toMatch(/row-level security/);
    // UPDATE/DELETE: RLS filtra todas las filas (0 afectadas) y los datos no cambian
    const touched = await db.as(db.outsider, async (q) => [
      (await q.rows(`update public.drivers set first_name = 'x' returning 1`)).length,
      (await q.rows(`update public.app_settings set business_name = 'x' returning 1`)).length,
    ]);
    expect(touched).toEqual([0, 0]);
    expect(await db.as(db.outsider, (q) => q.fails(`update public.payment_methods set commission_cents = 0`))).toMatch(/permission denied/);   // 0029
    expect(await db.as(db.outsider, (q) => q.fails(`delete from public.units`))).toMatch(/permission denied/);
    expect((await db.su.query(`select first_name from public.drivers`)).rows.every((r) => r.first_name !== 'x')).toBe(true);
  });
  it('no puede autorizarse a sí mismo ni usar funciones de servidor', async () => {
    const e = await db.as(db.outsider, async (q) => [
      await q.fails(`select public.authorize_admin($1)`, [db.outsider]),
      await q.fails(`select public.claim_notification_jobs(5)`),
      await q.fails(`select public.schedule_reminders()`),
    ]);
    e.forEach((m) => expect(m).toMatch(/permission denied/));
  });
  it('anon no puede ejecutar funciones del negocio ni de servidor', async () => {
    const e = await db.asAnon(async (q) => [
      await q.fails(`select public.register_payment($1,'cash',100,'k')`, [a.assignment]),
      await q.fails(`select public.dashboard_summary()`), await q.fails(`select public.authorize_admin($1)`, [db.outsider]),
    ]);
    e.forEach((m) => expect(m).toMatch(/permission denied/));
  });
});

describe('instancia única: una sesión de WhatsApp y una fila de configuración', () => {
  it('solo existe una sesión de WhatsApp y una fila de configuración', async () => {
    expect(await db.su.query(`insert into public.whatsapp_sessions(label) values ('otra')`).then(() => null, (x) => x.message)).toMatch(/whatsapp_single_session|unique/);
    expect(await db.su.query(`insert into public.app_settings(id) values (false)`).then(() => null, (x) => x.message)).toMatch(/check|unique|violates/);
    expect(await db.as(db.admin, (q) => q.fails(`insert into public.app_settings default values`))).toMatch(/permission denied|row-level/);
    expect(await db.as(db.admin, (q) => q.fails(`delete from public.app_settings`))).toMatch(/permission denied/);
  });
  it('las cuentas internas no pueden borrarse de profiles mientras tengan un rol', async () => {
    expect(await db.su.query(`delete from public.profiles where id = $1`, [db.admin]).then(() => null, (x) => x.message)).toMatch(/foreign key|violates/);
  });
});

describe('la administradora tampoco puede escribir directamente en lo financiero', () => {
  it.each(FINANCIAL)('INSERT/UPDATE/DELETE directo sobre %s está bloqueado', async (t) => {
    const e = await db.as(db.admin, async (q) => [
      await q.fails(`insert into public.${t} default values`),
      await q.fails(`update public.${t} set ${COL[t]} = ${COL[t]}`),
      await q.fails(`delete from public.${t}`),
    ]);
    e.forEach((m) => expect(m).toMatch(/permission denied|row-level security/));
  });
  it('no puede insertar pagos ni ajustes a mano', async () => {
    const e = await db.as(db.admin, async (q) => [
      await q.fails(`insert into public.adjustments(assignment_id, effective_date, amount_cents, reason, idempotency_key, created_by) values ($1,'2026-03-02',-9999,'trampa','z',$2)`, [a.assignment, db.admin]),
      await q.fails(`update public.notification_jobs set status = 'pending'`),
      await q.fails(`insert into public.v_assignment_position(assignment_id) values ($1)`, [a.assignment]),
    ]);
    e.forEach((m) => expect(m).not.toBeNull());
  });
  it('ni siquiera el superusuario puede editar ni borrar movimientos', async () => {
    for (const sql of [`update public.payments set net_cents = net_cents + 1`, `delete from public.payments`, `update public.charges set amount_cents = amount_cents + 1`,
      `delete from public.charges`, `update public.adjustments set amount_cents = 1`, `delete from public.payment_allocations`, `update public.audit_logs set action = 'x'`,
      `delete from public.audit_logs`, `delete from public.weekly_closures`]) {
      expect(await db.su.query(sql).then(() => null, (x) => x.message as string), sql).toMatch(/no permitido|solo puede anularse/);
    }
  });
  it('el ADMIN solo cambia label/desired_state de la sesión de WhatsApp; el estado real lo escribe el servidor', async () => {
    const id = (await db.su.query(`select id from public.whatsapp_sessions`)).rows[0].id;
    expect(await db.as(db.admin, (q) => q.fails(`update public.whatsapp_sessions set status='connected' where id=$1`, [id]))).toMatch(/permission denied/);
    expect(await db.as(db.admin, (q) => q.fails(`update public.whatsapp_sessions set desired_state='connected' where id=$1`, [id]))).toBeNull();
  });
});

describe('auditoría', () => {
  it('cada pago deja auditoría con el usuario responsable', async () => {
    const p = await db.as(db.admin, (q) => pay(q, a.assignment, 'yappy', 1100, { reference: 'REF-1', notes: 'verificado por WhatsApp' }));
    const row = (await db.su.query(`select actor, detail from public.audit_logs where entity_id=$1 and action='register_payment'`, [p.payment_id])).rows[0];
    expect(row.actor).toBe(db.admin);
    expect(row.detail).toMatchObject({ gross_cents: 1100, commission_cents: 100, net_cents: 1000, reference: 'REF-1', notes: 'verificado por WhatsApp' });
  });
  it('los cambios de datos maestros y de configuración quedan auditados', async () => {
    await db.as(db.admin, (q) => q.query(`update public.drivers set first_name = 'Cambiado' where id = $1`, [a.driver]));
    expect((await db.su.query(`select detail from public.audit_logs where entity='drivers' and entity_id=$1 and action='update' order by id desc limit 1`, [a.driver])).rows[0].detail.new.first_name).toBe('Cambiado');
    await db.as(db.admin, (q) => q.query(`update public.app_settings set max_per_driver_per_day = 4`));
    expect(Number((await db.su.query(`select count(*) n from public.audit_logs where entity='app_settings'`)).rows[0].n)).toBe(1);
  });
});

describe('is_authorized()', () => {
  it('true para cualquier rol interno; false para otros usuarios; anon no puede llamarla', async () => {
    for (const u of [db.admin, db.opsAdmin, db.supervisor]) expect(await db.as(u, async (q) => (await q.one(`select public.is_authorized() ok`)).ok)).toBe(true);
    expect(await db.as(db.outsider, async (q) => (await q.one(`select public.is_authorized() ok`)).ok)).toBe(false);
    expect(await db.asAnon((q) => q.fails(`select public.is_authorized()`))).toMatch(/permission denied/);
  });
});

describe('registro de nuevos usuarios', () => {
  it('con cuentas internas existentes, la base de datos rechaza crear más usuarios en Auth (ventana cerrada)', async () => {
    const e = await db.su.query(`insert into auth.users(email) values ('intruso@test.local')`).then(() => null, (x) => x.message as string);
    expect(e).toMatch(/signups_closed/);
  });
  it('antes de autorizar a nadie sí se pueden crear usuarios y se les crea el perfil', async () => {
    const fresh = await newDb();
    try {
      // newDb autoriza a la administradora al crearse; se revierte solo en este clon para comprobar el estado inicial
      await fresh.su.query(`alter table public.app_users disable trigger all`);
      await fresh.su.query(`delete from public.app_users`);
      await fresh.su.query(`alter table public.app_users enable trigger all`);
      const id = await fresh.user('nuevo@test.local');
      expect((await fresh.su.query(`select email from public.profiles where id=$1`, [id])).rows[0].email).toBe('nuevo@test.local');
    } finally { await fresh.close(); }
  });
});

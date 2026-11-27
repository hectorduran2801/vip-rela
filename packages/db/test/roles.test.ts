import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MON, chargeWeek, key, pay } from './fixtures.js';
import { newDb, type Db, type Q } from './harness.js';

let db: Db;
let x: { driver: string; unit: string; assignment: string };
beforeAll(async () => {
  db = await newDb();
  x = await db.driverWithAssignment({ code: 'RL1', unit: 'RU1', dailyCents: 3600 });
  await chargeWeek(db, MON);
});
afterAll(async () => { await db.close(); });

const ROLES = [['SUPER_ADMIN', () => db.admin], ['ADMIN', () => db.opsAdmin], ['SUPERVISOR', () => db.supervisor]] as const;
const as = <T>(who: string, fn: (q: Q) => Promise<T>) => db.as(who, fn);

describe('rol actual', () => {
  it.each([['super_admin', () => db.admin], ['admin', () => db.opsAdmin], ['supervisor', () => db.supervisor]] as const)('current_app_role() devuelve %s', async (r, who) => {
    expect(await as(who(), async (q) => (await q.one(`select public.current_app_role() r`)).r)).toBe(r);
  });
  it('un usuario sin rol no tiene rol ni acceso', async () => {
    expect(await as(db.outsider, async (q) => (await q.one(`select public.current_app_role() r`)).r)).toBeNull();
  });
});

describe('lectura: todos los roles internos ven todo; los demás nada', () => {
  it.each(ROLES)('%s lee dashboard, tabla semanal e informes', async (_n, who) => {
    const r = await as(who(), async (q) => ({
      d: (await q.one(`select public.dashboard_summary() s`)).s.drivers.total,
      w: (await q.rows(`select 1 from public.weekly_collection_table($1)`, [MON])).length,
      p: (await q.one(`select public.period_summary($1::date,$2::date) s`, [MON, '2026-03-08'])).s.expected_cents,
      rows: (await q.rows(`select 1 from public.drivers`)).length,
    }));
    expect(r.d).toBeGreaterThan(0); expect(r.w).toBeGreaterThan(0); expect(r.p).toBeGreaterThan(0); expect(r.rows).toBeGreaterThan(0);
  });
});

describe('SUPERVISOR: lectura + registrar pagos, nada más', () => {
  it('registra pagos', async () => {
    const r = await as(db.supervisor, (q) => pay(q, x.assignment, 'cash', 1000));
    expect(r.net_cents).toBe(1000);
    expect((await db.su.query(`select registered_by from public.payments where id=$1`, [r.payment_id])).rows[0].registered_by).toBe(db.supervisor);
  });
  it('no puede anular, ajustar, cerrar, generar cuotas, importar, editar datos maestros ni configuración', async () => {
    const p = await as(db.supervisor, (q) => pay(q, x.assignment, 'cash', 500));
    const e = await as(db.supervisor, async (q) => [
      await q.fails(`select public.void_payment($1,'intento')`, [p.payment_id]),
      await q.fails(`select public.create_adjustment($1,100,'2026-03-02','intento',$2)`, [x.assignment, key()]),
      await q.fails(`select public.close_week('2026-03-02')`), await q.fails(`select public.generate_daily_charges('2026-03-10')`),
      await q.fails(`select public.change_rate($1,100,'2026-12-01')`, [x.assignment]), await q.fails(`select public.end_assignment($1,'2026-12-01')`, [x.assignment]),
      await q.fails(`select public.apply_import(gen_random_uuid())`), await q.fails(`select public.review_notification(gen_random_uuid(),'approve')`),
      await q.fails(`insert into public.drivers(operator_code, national_id, first_name) values ('z','z','z')`),
      await q.fails(`insert into public.excel_imports(file_name, file_sha256, created_by) values ('a','b',$1)`, [db.supervisor]),
    ]);
    expect(e.slice(0, 8)).toEqual(Array(8).fill('forbidden'));
    expect(e[8]).toMatch(/row-level security/); expect(e[9]).toMatch(/row-level security/);
    const touched = await as(db.supervisor, async (q) => [(await q.rows(`update public.drivers set first_name='x' returning 1`)).length, (await q.rows(`update public.notification_schedules set enabled = true returning 1`)).length]);
    expect(touched).toEqual([0, 0]);
  });
});

describe('ADMIN: operación completa, sin usuarios ni configuración', () => {
  it('puede operar: anular, ajustar, cerrar, importar, editar datos maestros', async () => {
    const p = await as(db.opsAdmin, (q) => pay(q, x.assignment, 'cash', 700));
    const v = await as(db.opsAdmin, (q) => q.one(`select public.void_payment($1,'registrado dos veces') r`, [p.payment_id]));
    expect(v.r.payment_id).toBe(p.payment_id);
    expect(await as(db.opsAdmin, (q) => q.fails(`insert into public.drivers(operator_code, national_id, first_name) values ('ad1','ad1','x')`))).toBeNull();
    expect(await as(db.opsAdmin, (q) => q.fails(`select public.create_adjustment($1,100,'2026-03-02','ajuste admin',$2)`, [x.assignment, key()]))).toBeNull();
  });
  it('no gestiona usuarios, métodos de pago ni configuración', async () => {
    const e = await as(db.opsAdmin, async (q) => [
      await q.fails(`select * from public.list_app_users()`), await q.fails(`select public.set_app_user('outsider@test.local','admin')`),
      await q.fails(`select public.remove_app_user($1)`, [db.supervisor]), await q.fails(`select public.open_user_creation(10)`),
    ]);
    expect(e).toEqual(['forbidden', 'forbidden', 'forbidden', 'forbidden']);
  });
  it('ADMIN gestiona la configuración operativa (comisiones, límites, horarios, plantillas) pero NO la técnica', async () => {
    // operativa: sí
    expect(await as(db.opsAdmin, (q) => q.fails(`update public.payment_methods set commission_cents = 100 where code='yappy'`))).toMatch(/permission denied/);   // 0029: los métodos de pago ya no se editan desde el cliente
    expect(await as(db.opsAdmin, async (q) => (await q.rows(`update public.app_settings set max_per_driver_per_day = 4, min_minutes_between = 90, grace_minutes = 120 returning 1`)).length)).toBe(1);
    expect(await as(db.opsAdmin, async (q) => (await q.rows(`update public.notification_schedules set enabled = false returning 1`)).length)).toBeGreaterThan(0);
    expect(await as(db.opsAdmin, async (q) => (await q.rows(`insert into public.message_templates(name, body) values ('adm-tpl', 'Hola') returning 1`)).length)).toBe(1);
    // los cambios quedan auditados con el actor
    expect((await db.su.query(`select count(*)::int c from public.audit_logs where actor=$1 and entity in ('payment_methods','app_settings')`, [db.opsAdmin])).rows[0].c).toBeGreaterThanOrEqual(1);
    // técnica: no (entorno, ventana de alta, zona horaria, nombre del negocio)
    expect(await as(db.opsAdmin, (q) => q.fails(`update public.app_settings set environment = 'production'`))).toMatch(/permission denied/);
    expect(await as(db.opsAdmin, (q) => q.fails(`update public.app_settings set user_creation_open_until = now() + interval '1 day'`))).toMatch(/permission denied/);
    expect(await as(db.opsAdmin, (q) => q.fails(`update public.app_settings set timezone = 'UTC'`))).toBe('forbidden');
    expect(await as(db.opsAdmin, (q) => q.fails(`update public.app_settings set business_name = 'Otro'`))).toBe('forbidden');
    // valores fuera de rango se rechazan igual
    expect(await as(db.opsAdmin, (q) => q.fails(`update public.app_settings set max_per_driver_per_day = 99`))).toMatch(/check|violates/);
    // sin rol (outsider) no puede nada
    expect(await as(db.outsider, (q) => q.fails(`update public.payment_methods set commission_cents = 0`))).toMatch(/permission denied/);
    expect(await as(db.outsider, async (q) => (await q.rows(`update public.app_settings set max_per_driver_per_day = 5 returning 1`)).length)).toBe(0);
    // SUPER_ADMIN sí puede la zona horaria
    expect(await as(db.admin, async (q) => (await q.rows(`update public.app_settings set timezone = 'America/Panama' returning 1`)).length)).toBe(1);
  });
});

describe('SUPER_ADMIN: usuarios, métodos de pago y configuración', () => {
  it('lista usuarios y cambia métodos de pago y configuración', async () => {
    const users = await as(db.admin, (q) => q.rows(`select email, role from public.list_app_users() order by email`));
    expect(users.map((u) => u.role).sort()).toEqual(['admin', 'super_admin', 'supervisor']);
    expect(await as(db.admin, (q) => q.fails(`update public.payment_methods set commission_cents = 100 where code='yappy'`))).toMatch(/permission denied/);
    expect(await as(db.admin, async (q) => (await q.rows(`update public.app_settings set max_per_driver_per_day = 3 returning 1`)).length)).toBe(1);
  });
  it('no puede editar directamente el entorno ni la ventana de alta de usuarios', async () => {
    expect(await as(db.admin, (q) => q.fails(`update public.app_settings set environment = 'production'`))).toMatch(/permission denied/);
    expect(await as(db.admin, (q) => q.fails(`update public.app_settings set user_creation_open_until = now() + interval '1 day'`))).toMatch(/permission denied/);
  });
  it('asigna roles a cuentas que YA existen en Auth; no crea cuentas', async () => {
    const before = Number((await db.su.query(`select count(*) n from auth.users`)).rows[0].n);
    expect(await as(db.admin, (q) => q.fails(`select public.set_app_user('outsider@test.local','supervisor')`))).toBe('role_deprecated');   // rol retirado: no se asigna más
    expect((await as(db.admin, async (q) => (await q.one(`select public.set_app_user('outsider@test.local','admin') r`)).r)).role).toBe('admin');
    expect(await as(db.outsider, async (q) => (await q.one(`select public.is_authorized() ok`)).ok)).toBe(true);
    expect(await as(db.admin, (q) => q.fails(`select public.set_app_user('no-existe@test.local','admin')`))).toBe('user_not_found');
    expect(await as(db.admin, (q) => q.fails(`select public.set_app_user('outsider@test.local','dueno')`))).toBe('invalid_role');
    expect(Number((await db.su.query(`select count(*) n from auth.users`)).rows[0].n)).toBe(before);
    await as(db.admin, (q) => q.query(`select public.remove_app_user($1)`, [db.outsider]));
    expect(await as(db.outsider, async (q) => (await q.one(`select public.is_authorized() ok`)).ok)).toBe(false);
  });
  it('nunca queda la instancia sin SUPER_ADMIN', async () => {
    expect(await as(db.admin, (q) => q.fails(`select public.set_app_user('admin@test.local','admin')`))).toBe('last_super_admin');
    expect(await as(db.admin, (q) => q.fails(`select public.remove_app_user($1)`, [db.admin]))).toBe('last_super_admin');
    await as(db.admin, (q) => q.query(`select public.set_app_user('ops-admin@test.local','super_admin')`));
    await as(db.admin, (q) => q.query(`select public.set_app_user('admin@test.local','admin')`));          // ahora sí: hay otro SUPER_ADMIN
    expect(await as(db.admin, async (q) => (await q.one(`select public.current_app_role() r`)).r)).toBe('admin');
    await db.su.query(`update public.app_users set role='super_admin' where user_id=$1`, [db.admin]);        // restablece para el resto de pruebas
    await db.su.query(`update public.app_users set role='admin' where user_id=$1`, [db.opsAdmin]);
  });
  it('los cambios de rol quedan auditados', async () => {
    expect(Number((await db.su.query(`select count(*) n from public.audit_logs where entity='app_users'`)).rows[0].n)).toBeGreaterThan(0);
  });
});

describe('alta de usuarios en Auth: cerrada salvo ventana temporal abierta por un SUPER_ADMIN', () => {
  const create = (email: string) => db.su.query(`insert into auth.users(email) values ($1)`, [email]).then(() => null, (e) => e.message as string);
  it('cerrada por defecto', async () => { expect(await create('intruso1@test.local')).toMatch(/signups_closed/); });
  it('solo un SUPER_ADMIN puede abrir la ventana; con ella abierta se puede crear y al vencer se cierra', async () => {
    expect(await as(db.supervisor, (q) => q.fails(`select public.open_user_creation(10)`))).toBe('forbidden');
    await as(db.admin, (q) => q.query(`select public.open_user_creation(10)`));
    expect(await create('invitado@test.local')).toBeNull();
    await db.su.query(`update public.app_settings set user_creation_open_until = now() - interval '1 minute'`);
    expect(await create('intruso2@test.local')).toMatch(/signups_closed/);
    await as(db.admin, (q) => q.query(`select public.open_user_creation(10)`));
    await as(db.admin, (q) => q.query(`select public.open_user_creation(0)`));                                // cerrar manualmente
    expect(await create('intruso3@test.local')).toMatch(/signups_closed/);
  });
  it('el entorno de la base es «development» por defecto', async () => {
    expect((await db.su.query(`select environment from public.app_settings`)).rows[0].environment).toBe('development');
  });
});

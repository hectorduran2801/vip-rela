import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newDb, type Db, type Q } from './harness.js';

let db: Db; let n = 0;
beforeAll(async () => { db = await newDb(); });
afterAll(async () => { await db.close(); });
const sup = <T>(fn: (q: Q) => Promise<T>) => db.as(db.admin, fn);
const email = () => `nuevo${++n}-${Math.random().toString(36).slice(2, 7)}@vip.test`;
/** Lo que hace Supabase Auth (Admin API o panel) al crear una identidad. */
const createIdentity = (e: string) => db.su.query(`insert into auth.users(email, raw_user_meta_data) values ($1, '{"full_name":"Nueva Admin"}') returning id`, [e]).then((r) => r.rows[0].id as string);
const roleOf = async (id: string) => (await db.su.query(`select role, created_by, suspended_at from public.app_users where user_id=$1`, [id])).rows[0];
const staffOf = (id: string) => db.as(id, async (q) => (await q.one(`select app_private.is_staff() s, public.current_app_role() r`)));

describe('alta de identidades en Supabase Auth', () => {
  it('REPRODUCE el error original: sin invitación el alta se rechaza (42501 signups_closed) y no crea nada', async () => {
    const e = email(); const before = Number((await db.su.query(`select count(*) from auth.users`)).rows[0].count);
    const err = await createIdentity(e).then(() => null, (x) => x);
    expect(err?.message).toMatch(/signups_closed/); expect(err?.code).toBe('42501');
    expect(Number((await db.su.query(`select count(*) from auth.users`)).rows[0].count)).toBe(before);
  });
  it('un SUPER_ADMIN invita (email + rol): se crea ESA identidad, se asigna el rol y la invitación se consume', async () => {
    const e = email();
    expect(await sup((q) => q.one(`select public.invite_app_user($1,'admin') r`, [e])).then((x) => x.r)).toMatchObject({ mode: 'invited', email: e, role: 'admin' });
    const id = await createIdentity(e);
    expect(await roleOf(id)).toMatchObject({ role: 'admin', created_by: db.admin, suspended_at: null });
    expect((await db.su.query(`select consumed_at is not null c, consumed_by from public.user_invites where email=$1`, [e])).rows[0]).toEqual({ c: true, consumed_by: id });
    expect(await staffOf(id)).toEqual({ s: true, r: 'admin' });
    expect((await db.su.query(`select count(*)::int c from public.audit_logs where action in ('invite_created','invite_consumed')`)).rows[0].c).toBeGreaterThanOrEqual(2);
    // la invitación es de un solo uso
    expect(await createIdentity(e).then(() => 'ok', (x) => x.code)).toBe('42501');         // consumida: no se puede reutilizar
  });
  it('la invitación sirve SOLO para ese correo; otro correo sigue bloqueado; el correo no distingue mayúsculas', async () => {
    const e = email(); await sup((q) => q.one(`select public.invite_app_user($1,'admin')`, [e.toUpperCase()]));
    expect(await createIdentity(email()).then(() => 'ok', (x) => x.message)).toMatch(/signups_closed/);
    expect(await createIdentity(e).then((id) => typeof id, () => 'fail')).toBe('string');
  });
  it('una invitación vencida o cancelada no permite el alta', async () => {
    const e1 = email(); await sup((q) => q.one(`select public.invite_app_user($1,'admin',5)`, [e1]));
    await db.su.query(`update public.user_invites set expires_at = now() - interval '1 minute' where email=$1`, [e1]);
    expect(await createIdentity(e1).then(() => 'ok', (x) => x.message)).toMatch(/signups_closed/);
    const e2 = email(); await sup((q) => q.one(`select public.invite_app_user($1,'admin')`, [e2]));
    await sup((q) => q.query(`select public.cancel_user_invite($1)`, [e2]));
    expect(await createIdentity(e2).then(() => 'ok', (x) => x.message)).toMatch(/signups_closed/);
    expect(await sup((q) => q.fails(`select public.cancel_user_invite($1)`, [e2]))).toBe('invite_not_found');
  });
  it('crear la identidad NO concede acceso por sí sola: sin invitación ni rol no hay acceso (y tampoco se puede crear)', async () => {
    // identidad creada con la ventana temporal (compatibilidad) pero SIN rol
    const e = email(); await db.su.query(`update public.app_settings set user_creation_open_until = now() + interval '5 minutes'`);
    const id = await createIdentity(e); await db.su.query(`update public.app_settings set user_creation_open_until = null`);
    expect(await roleOf(id)).toBeUndefined();
    expect(await staffOf(id)).toEqual({ s: false, r: null });
    expect(await db.as(id, (q) => q.fails(`select * from public.weekly_collection_table('2026-03-02')`))).toBe('forbidden');
    expect((await db.as(id, (q) => q.rows(`select id from public.drivers`))).length).toBe(0);
  });
  it('si la identidad ya existe sin rol, invitar la autoriza directamente; si ya tiene rol, avisa', async () => {
    const e = email(); await db.su.query(`update public.app_settings set user_creation_open_until = now() + interval '5 minutes'`);
    const id = await createIdentity(e); await db.su.query(`update public.app_settings set user_creation_open_until = null`);
    expect(await sup((q) => q.one(`select public.invite_app_user($1,'admin') r`, [e])).then((x) => x.r)).toMatchObject({ mode: 'assigned', role: 'admin' });
    expect(await staffOf(id)).toEqual({ s: true, r: 'admin' });
    expect(await sup((q) => q.fails(`select public.invite_app_user($1,'admin')`, [e]))).toBe('user_already_authorized');
  });
  it('validaciones y permisos: solo SUPER_ADMIN; correo y rol válidos; «supervisor» retirado', async () => {
    for (const who of [db.opsAdmin, db.supervisor, db.outsider]) expect(await db.as(who, (q) => q.fails(`select public.invite_app_user($1,'admin')`, [email()]))).toBe('forbidden');
    expect(await db.asAnon((q) => q.fails(`select public.invite_app_user($1,'admin')`, [email()]))).toMatch(/permission denied/);
    expect(await sup((q) => q.fails(`select public.invite_app_user('no-es-correo','admin')`))).toBe('invalid_email');
    expect(await sup((q) => q.fails(`select public.invite_app_user($1,'dueno')`, [email()]))).toBe('invalid_role');
    expect(await sup((q) => q.fails(`select public.invite_app_user($1,'supervisor')`, [email()]))).toBe('role_deprecated');
    expect(await sup((q) => q.fails(`select public.invite_app_user($1,'admin',1)`, [email()]))).toBe('invalid_minutes');
    expect(await db.as(db.opsAdmin, (q) => q.fails(`select * from public.list_user_invites()`))).toBe('forbidden');
    expect((await sup((q) => q.rows(`select * from public.list_user_invites()`))).length).toBeGreaterThan(0);
    expect(await db.as(db.opsAdmin, (q) => q.fails(`select * from public.user_invites`))).toMatch(/permission denied/);
  });
});

describe('suspensión y último SUPER_ADMIN', () => {
  const newAdmin = async () => { const e = email(); await sup((q) => q.one(`select public.invite_app_user($1,'admin')`, [e])); return createIdentity(e); };
  it('suspender quita TODO acceso de inmediato; reactivar lo devuelve; queda auditado; el resto de cuentas no cambia', async () => {
    const id = await newAdmin();
    expect(await staffOf(id)).toEqual({ s: true, r: 'admin' });
    expect(await db.as(db.opsAdmin, (q) => q.fails(`select public.set_app_user_suspended($1,true)`, [id]))).toBe('forbidden');
    expect(await sup((q) => q.one(`select public.set_app_user_suspended($1,true) r`, [id])).then((x) => x.r)).toEqual({ user_id: id, suspended: true });
    expect(await staffOf(id)).toEqual({ s: false, r: null });
    expect(await db.as(id, (q) => q.fails(`select * from public.weekly_collection_table('2026-03-02')`))).toBe('forbidden');
    expect((await db.as(id, (q) => q.rows(`select id from public.drivers`))).length).toBe(0);
    expect(await staffOf(db.admin)).toEqual({ s: true, r: 'super_admin' });
    expect((await sup((q) => q.rows(`select user_id, suspended_at from public.list_app_users() where user_id=$1`, [id])))[0].suspended_at).not.toBeNull();
    await sup((q) => q.one(`select public.set_app_user_suspended($1,false)`, [id]));
    expect(await staffOf(id)).toEqual({ s: true, r: 'admin' });
    expect((await db.su.query(`select count(*)::int c from public.audit_logs where action in ('user_suspended','user_reactivated') and entity_id=$1`, [id])).rows[0].c).toBe(2);
    expect(await sup((q) => q.fails(`select public.set_app_user_suspended(gen_random_uuid(),true)`))).toBe('user_not_found');
  });
  it('NUNCA se elimina, suspende ni degrada al último SUPER_ADMIN activo', async () => {
    expect(await sup((q) => q.fails(`select public.set_app_user_suspended($1,true)`, [db.admin]))).toBe('last_super_admin');
    expect(await sup((q) => q.fails(`select public.remove_app_user($1)`, [db.admin]))).toBe('last_super_admin');
    expect(await sup((q) => q.fails(`select public.set_app_user('admin@test.local','admin')`))).toBe('last_super_admin');
    // con un segundo SUPER_ADMIN activo sí se puede degradar al primero... pero si el segundo está suspendido, vuelve a protegerse
    const e = email(); await sup((q) => q.one(`select public.invite_app_user($1,'super_admin')`, [e])); const s2 = await createIdentity(e);
    await sup((q) => q.one(`select public.set_app_user_suspended($1,true)`, [s2]));
    expect(await sup((q) => q.fails(`select public.set_app_user('admin@test.local','admin')`))).toBe('last_super_admin');
    await sup((q) => q.one(`select public.set_app_user_suspended($1,false)`, [s2]));
    expect(await roleOf(db.admin)).toMatchObject({ role: 'super_admin' });                     // el principal se conserva
    expect(await db.as(s2, (q) => q.one(`select public.set_app_user_suspended($1,true) r`, [db.admin])).then((x) => x.r)).toMatchObject({ suspended: true });
    await db.as(s2, (q) => q.one(`select public.set_app_user_suspended($1,false)`, [db.admin]));
    await db.su.query(`delete from public.app_users where user_id=$1`, [s2]);
  });
  it('los pagos registrados por cada administradora quedan identificados por usuario', async () => {
    const id = await newAdmin();
    const x = await db.driverWithAssignment({ code: 'INV1', unit: 'INVU1', dailyCents: 3600 });
    await db.as(id, (q) => q.one(`select public.register_payment($1,'cash',1000,$2) r`, [x.assignment, `inv-${Math.random()}`]));
    expect((await db.su.query(`select registered_by from public.payments where assignment_id=$1`, [x.assignment])).rows[0].registered_by).toBe(id);
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newDb, type Db, type Q } from './harness.js';

/** 0045: cada cuenta ve y toca SOLO sus datos, también dentro de las funciones SECURITY DEFINER; el worker no se filtra. */
let db: Db; let other: string; let mine: Awaited<ReturnType<Db['driverWithAssignment']>>; let tpl: string; let acc: string;
const A = <T>(fn: (q: Q) => Promise<T>) => db.as(db.opsAdmin, fn);      // dueña de los datos (cuenta principal)
const B = <T>(fn: (q: Q) => Promise<T>) => db.as(other, fn);            // otra cuenta
const MAIN = '00000000-0000-4000-8000-000000000001';

beforeAll(async () => {
  db = await newDb();
  mine = await db.driverWithAssignment({ code: 'ISO1', unit: 'P121', dailyCents: 3000 });
  await db.su.query(`update public.drivers set phone_e164='+50761230000' where id=$1`, [mine.driver]);
  tpl = (await db.su.query(`insert into public.message_templates(name, body) values ('Aviso','Hola {{nombre}} {{saldo_total}}') returning id`)).rows[0].id;
  other = db.outsider;
  await db.su.query(`insert into public.app_users(user_id, role, created_by) values ($1,'admin',$2)`, [other, db.admin]);     // creada desde la app: cuenta propia
  acc = (await db.su.query(`select account_id a from public.app_users where user_id=$1`, [other])).rows[0].a;
}, 120_000);
afterAll(async () => { await db.close(); });

describe('separación entre cuentas', () => {
  it('una cuenta nueva creada desde la app tiene su propio espacio, vacío', async () => {
    expect(acc).not.toBe(MAIN);
    for (const t of ['drivers', 'units', 'assignments', 'message_templates', 'charges', 'rates']) {
      expect((await B((q) => q.one(`select count(*)::int n from public.${t}`))).n, t).toBe(0);
      expect((await A((q) => q.one(`select count(*)::int n from public.${t}`))).n, t).toBeGreaterThanOrEqual(0);
    }
    expect((await A((q) => q.one(`select count(*)::int n from public.drivers`))).n).toBe(1);
  });
  it('no puede leer ni modificar filas ajenas, ni crear filas a nombre de otra cuenta', async () => {
    expect(await B((q) => q.rows(`select * from public.drivers where id=$1`, [mine.driver]))).toEqual([]);
    await B((q) => q.query(`update public.message_templates set body='robado' where id=$1`, [tpl])).catch(() => undefined);
    await B((q) => q.query(`delete from public.message_templates where id=$1`, [tpl])).catch(() => undefined);
    expect((await db.su.query(`select body from public.message_templates where id=$1`, [tpl])).rows[0].body).toContain('Hola');
    await expect(B((q) => q.query(`insert into public.message_templates(name, body, account_id) values ('x','y',$1)`, [MAIN]))).rejects.toThrow();
  });
  it('las funciones tampoco filtran datos ajenos aunque se les pase un id de otra cuenta', async () => {
    expect(await B((q) => q.fails(`select * from public.create_collection_message($1,$2,'iso-key-0001',false)`, [mine.assignment, tpl]))).toBeTruthy();
    expect(await B((q) => q.fails(`select public.preview_template($1,'{{nombre}} {{saldo_total}}',null)`, [mine.assignment]))).toBe('assignment_not_found');
    expect(await B((q) => q.fails(`select public.set_assignment_commission($1,false)`, [mine.assignment]))).toBe('assignment_not_found');
    const sum = (await B((q) => q.one(`select public.dashboard_summary() s`))).s;
    expect(Number(sum.drivers.total)).toBe(0);
    expect(await B((q) => q.rows(`select * from public.weekly_collection_table(app_private.week_start_of(current_date))`))).toEqual([]);
  });
  it('los códigos pueden repetirse entre cuentas (P121 en ambas) pero no dentro de una', async () => {
    await B((q) => q.query(`insert into public.units(code) values ('P121')`));
    await B((q) => q.query(`insert into public.message_templates(name, body) values ('Aviso','otra')`));
    await expect(B((q) => q.query(`insert into public.units(code) values ('P121')`))).rejects.toThrow();
    expect((await db.su.query(`select count(*)::int n from public.units where code='P121'`)).rows[0].n).toBe(2);
    await B((q) => q.rows(`select public.save_template_text('detalle_al_dia','Todo en orden en B')`));
    expect((await db.su.query(`select account_id from public.template_text_settings`)).rows).toEqual([{ account_id: acc }]);
    expect((await A((q) => q.rows(`select key from public.list_template_texts() where customized`)))).toEqual([]);
  });
  it('0048: el SUPER_ADMIN consulta y MODIFICA la cuenta seleccionada (solo esa), con auditoría; un ADMIN no puede cambiar de cuenta', async () => {
    expect(await A((q) => q.fails(`select public.set_account_view($1)`, [acc]))).toBe('forbidden');
    await db.as(db.admin, (q) => q.rows(`select public.set_account_view($1)`, [acc]));
    expect((await db.as(db.admin, (q) => q.rows(`select code from public.units`))).map((r) => r.code)).toEqual(['P121']);
    expect((await db.as(db.admin, (q) => q.rows(`select * from public.drivers`)))).toEqual([]);
    await db.as(db.admin, (q) => q.query(`insert into public.units(code) values ('SUP-1')`));                       // queda en la cuenta seleccionada
    expect((await db.su.query(`select account_id from public.units where code='SUP-1'`)).rows).toEqual([{ account_id: acc }]);
    await expect(db.as(db.admin, (q) => q.query(`insert into public.units(code, account_id) values ('ZZ',$1)`, [MAIN]))).rejects.toThrow();   // no puede escribir fuera de la seleccionada
    expect((await db.su.query(`select actor, account_id, detail from public.audit_logs where action='super.account_write' and entity='units' order by at desc limit 1`)).rows[0]).toEqual({ actor: db.admin, account_id: acc, detail: { operation: 'insert' } });
    await db.as(db.admin, (q) => q.rows(`select public.set_account_view(null)`));
    expect((await db.as(db.admin, (q) => q.rows(`select * from public.drivers`))).length).toBe(1);
    expect((await db.as(db.admin, (q) => q.rows(`select * from public.units where code='SUP-1'`)))).toEqual([]);
    expect((await db.as(db.admin, (q) => q.rows(`select * from public.list_accounts()`))).length).toBeGreaterThanOrEqual(2);
    await db.su.query(`delete from public.units where code='SUP-1'`);
  });
  it('un proceso sin usuario (motor de cuotas) trabaja con todas y las filas quedan en la cuenta de su padre', async () => {
    const bx = await db.driverWithAssignment({ code: 'ISO2', unit: 'B-77', dailyCents: 2000 });
    await db.su.query(`update public.drivers set account_id=$2 where id=$1`, [bx.driver, acc]);
    await db.su.query(`update public.assignments set account_id=$2 where id=$1`, [bx.assignment, acc]);
    await db.su.query(`insert into public.charges(assignment_id, kind, charge_date, amount_cents, week_start) values ($1,'daily','2026-11-23',2000,'2026-11-23')`, [bx.assignment]);
    expect((await db.su.query(`select account_id from public.charges where assignment_id=$1 and charge_date='2026-11-23'`, [bx.assignment])).rows[0].account_id).toBe(acc);
    expect((await B((q) => q.one(`select count(*)::int n from public.charges where assignment_id=$1`, [mine.assignment]))).n).toBe(0);
  });
  it('un horario solo envía a conductores de SU cuenta', async () => {
    await db.su.query(`insert into public.excel_imports(file_name, file_sha256, status, source_kind, created_by, applied_at) values ('d.xlsx','iso-sha','applied','collection_flat',$1,now())`, [db.opsAdmin]);
    await A((q) => q.rows(`select * from public.save_send_schedule(null,'Noche','22:00'::time,'{1,2,3,4,5,6,7}'::smallint[],$1,'all',true)`, [tpl]));
    await db.asService((q) => q.one(`select public.run_send_schedules('2026-11-24T03:30:00Z'::timestamptz) r`));
    const sent = (await db.su.query(`select m.account_id, d.account_id da from public.whatsapp_test_messages m join public.drivers d on d.id=m.driver_id where m.kind='collection_message'`)).rows;
    expect(sent.length).toBe(1); expect(sent[0]).toEqual({ account_id: MAIN, da: MAIN });
  });
  // register_payment, void_payment… están REVOCADAS a los usuarios (0029); el arnés de pruebas se las concede solo para las pruebas antiguas.
  it('guardia: ninguna función SECURITY DEFINER que pueda llamar un usuario se salta la separación (salvo las de cuentas/usuarios)', async () => {
    const leaks = (await db.su.query(`select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_roles r on r.oid=p.proowner
       where n.nspname='public' and p.prosecdef and p.prorettype <> 'trigger'::regtype and p.prorettype <> 'event_trigger'::regtype and has_function_privilege('authenticated', p.oid, 'execute') and r.rolname <> 'vip_app'
         and p.prosrc not ilike '%auth.users%'
         and p.proname not in ('current_app_role','list_accounts','set_account_view','list_app_users','set_app_user','invite_app_user','remove_app_user','authorize_admin','authorize_credentials_reset',
                               'suspend_app_user','reactivate_app_user','revoke_invite','list_user_invites','open_signup_window','close_signup_window','is_admin','is_staff','is_super',
                               'register_payment','void_payment','create_adjustment','close_week','generate_daily_charges') order by 1`)).rows.map((x) => x.proname);
    expect(leaks).toEqual([]);
  });
  it('0046: la auditoría es por cuenta (consultándola por fuera de la pantalla tampoco se ve la ajena)', async () => {
    await A((q) => q.rows(`select public.set_assignment_commission($1,false)`, [mine.assignment]));
    await B((q) => q.rows(`select public.save_template_text('detalle_al_dia','B otra vez')`));
    const seen = async (who: string) => (await db.as(who, (q) => q.rows(`select distinct account_id from public.audit_logs`))).map((r) => r.account_id);
    expect(await seen(other)).toEqual([acc]);
    expect(await seen(db.opsAdmin)).toEqual([MAIN]);
    expect((await db.su.query(`select actor from public.audit_logs where action='assignment.commission' order by at desc limit 1`)).rows[0].actor).toBe(db.opsAdmin);
  });
  it('0047: cada cuenta tiene su sesión; ve y controla solo la suya; el SUPER_ADMIN controla la de la cuenta que seleccionó, con auditoría', async () => {
    const all = (await db.su.query(`select account_id from public.whatsapp_sessions`)).rows.map((r) => r.account_id);
    expect(all).toContain(MAIN); expect(all).toContain(acc); expect(new Set(all).size).toBe(all.length);
    const mineRows = await B((q) => q.rows(`select account_id from public.whatsapp_sessions`));
    expect(mineRows).toEqual([{ account_id: acc }]);
    await B((q) => q.rows(`select public.request_whatsapp_connection('connected')`));
    const state = async () => Object.fromEntries((await db.su.query(`select account_id, desired_state from public.whatsapp_sessions where account_id in ($1,$2)`, [MAIN, acc])).rows.map((r) => [r.account_id, r.desired_state]));
    expect(await state()).toEqual({ [MAIN]: 'disconnected', [acc]: 'connected' });
    await B((q) => q.query(`update public.whatsapp_sessions set desired_state='connected' where account_id=$1`, [MAIN])).catch(() => undefined);      // manipulando el id
    expect((await state())[MAIN]).toBe('disconnected');
    await db.as(db.admin, (q) => q.rows(`select public.set_account_view($1)`, [acc]));
    await db.as(db.admin, (q) => q.rows(`select public.request_whatsapp_logout()`));
    await db.as(db.admin, (q) => q.rows(`select public.set_account_view(null)`));
    expect((await db.su.query(`select logout_requested_at is not null l, account_id from public.whatsapp_sessions where logout_requested_at is not null`)).rows).toEqual([{ l: true, account_id: acc }]);
    expect((await db.su.query(`select account_id, actor from public.audit_logs where action='request_whatsapp_logout' order by at desc limit 1`)).rows[0]).toEqual({ account_id: acc, actor: db.admin });
  });
  it('0047: la cola intercala cuentas (una tanda grande de una no deja a la otra esperando al final)', async () => {
    await db.su.query(`delete from public.whatsapp_test_messages`);
    const ins = (account: string, n: number) => db.su.query(`insert into public.whatsapp_test_messages(account_id, kind, status, requested_mode, recipient_phone, body, authorized_by, idempotency_key, created_at)
      values ($1,'test','prepared','simulated','+50761230000','x',$2,$3, now() - interval '1 hour' + ($4::int * interval '1 second'))`, [account, db.admin, `fair-${account}-${n}-key`, n]);
    for (const n of [1, 2, 3]) await ins(MAIN, n); await ins(acc, 10);
    const order: string[] = [];
    for (let i = 0; i < 4; i++) order.push((await db.asService((q) => q.one(`select * from public.claim_test_message()`)) as any).account_id);
    expect(order.slice(0, 2).sort()).toEqual([MAIN, acc].sort());
  });

});

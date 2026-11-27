import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newDb, type Db } from './harness.js';

/** 0055: cada horario se ejecuta SIEMPRE en su propia cuenta, no en la que tenga seleccionada quien lo activó. */
let db: Db; let other: string; let acc: string; let tplMain: string; let tplOther: string;
let mine: { driver: string; assignment: string }; let theirs: typeof mine;
const MAIN = '00000000-0000-4000-8000-000000000001';
const AT_2230 = '2026-11-24T03:30:00Z';                    // 22:30 del lunes en Panamá
const run = () => db.asService((q) => q.one(`select public.run_send_schedules($1::timestamptz) r`, [AT_2230]));
const view = (a: string | null) => db.as(db.admin, (q) => q.rows(`select public.set_account_view($1)`, [a]));
const messages = async () => (await db.su.query(`select assignment_id, account_id from public.whatsapp_test_messages where kind='collection_message'`)).rows;
const viewing = async () => (await db.su.query(`select account_id from public.account_view where user_id=$1`, [db.admin])).rows[0]?.account_id ?? null;
const arm = async (who: string, template: string) => (await db.as(who, (q) => q.one(`select * from public.save_send_schedule(null,'Noche','22:00','{1,2,3,4,5,6,7}',$1,'all',true)`, [template]))) as { id: string };
const result = async () => (await db.su.query(`select status, total, created, skipped from public.send_schedule_runs`)).rows;

beforeAll(async () => {
  db = await newDb();
  other = db.outsider;
  await db.su.query(`insert into public.app_users(user_id, role, created_by) values ($1,'admin',$2)`, [other, db.admin]);
  acc = (await db.su.query(`select account_id a from public.app_users where user_id=$1`, [other])).rows[0].a;
  await db.su.query(`insert into public.payment_methods(code, label) values ('excel','Excel') on conflict (code) do nothing`);
  mine = await db.driverWithAssignment({ code: 'M1', unit: 'MU1', dailyCents: 3000, from: '2026-11-01' });
  theirs = await db.driverWithAssignment({ code: 'O1', unit: 'OU1', dailyCents: 3000, from: '2026-11-01' });
  // «theirs» pasa a la otra cuenta (el ayudante de pruebas crea en la principal).
  for (const [t, col, v] of [['assignments', 'id', theirs.assignment], ['drivers', 'id', theirs.driver], ['rates', 'assignment_id', theirs.assignment]]) {
    await db.su.query(`update public.${t} set account_id=$1 where ${col}=$2`, [acc, v]);
  }
  await db.su.query(`update public.units set account_id=$1 where id=(select unit_id from public.assignments where id=$2)`, [acc, theirs.assignment]);
  await db.su.query(`update public.drivers set phone_e164='+50761230001' where id=$1`, [mine.driver]);
  await db.su.query(`update public.drivers set phone_e164='+50761230002' where id=$1`, [theirs.driver]);
  for (const [a, sha] of [[MAIN, 'sha-main'], [acc, 'sha-other']]) {
    await db.su.query(`insert into public.excel_imports(file_name, file_sha256, status, source_kind, created_by, applied_at, account_id) values ('D.xlsx', $1, 'applied', 'collection_flat', $2, now(), $3)`, [sha, db.admin, a]);
  }
  const tpl = async (a: string) => (await db.su.query(`insert into public.message_templates(name, body, account_id) values ('Noche','Hola {{nombre}}',$1) returning id`, [a])).rows[0].id as string;
  tplMain = await tpl(MAIN); tplOther = await tpl(acc);
}, 120_000);
afterAll(async () => { await db.close(); });

const reset = async () => {
  await db.su.query(`delete from public.send_schedule_runs`); await db.su.query(`delete from public.send_schedules`);
  await db.su.query(`delete from public.whatsapp_test_messages`); await db.su.query(`delete from public.account_view`);
};

describe('un horario se ejecuta en su propia cuenta', () => {
  it('activado por el super administrador y luego cambia de cuenta: llega a los conductores del horario, no a los de la cuenta que mira', async () => {
    await reset();
    await view(acc); await arm(db.admin, tplOther); await view(null);                  // el horario es de «acc»; él vuelve a la suya
    await run();
    expect(await messages()).toEqual([{ assignment_id: theirs.assignment, account_id: acc }]);
    expect((await result())[0]).toMatchObject({ status: 'done', total: 1, created: 1 });
    expect(await viewing()).toBeNull();                                                // su selección queda como estaba
  });
  it('activado en su cuenta mientras después mira otra: igual, solo la cuenta del horario, y conserva la selección', async () => {
    await reset();
    await arm(db.admin, tplMain); await view(acc);
    await run();
    expect(await messages()).toEqual([{ assignment_id: mine.assignment, account_id: MAIN }]);
    expect(await viewing()).toBe(acc);
  });
  it('activado por la administradora de la cuenta: como siempre', async () => {
    await reset();
    await arm(other, tplOther);
    await run();
    expect(await messages()).toEqual([{ assignment_id: theirs.assignment, account_id: acc }]);
  });
  it('si quien lo activó ya no pertenece a la cuenta, no envía nada y queda el motivo', async () => {
    await reset();
    const s = await arm(other, tplOther);
    await db.su.query(`update public.send_schedules set armed_by=$2 where id=$1`, [s.id, db.opsAdmin]);     // administradora de la principal
    await run();
    expect(await messages()).toEqual([]);
    expect((await result())[0]).toMatchObject({ status: 'error', created: 0, skipped: { cuenta_distinta: 1 } });
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newDb, type Db } from './support/harness.js';
import { makeProcessor, seedDriver } from './support/fixtures.js';

/** 0035: el worker ejecuta los horarios de envío (solo con recordatorios automáticos) y deja los mensajes en la cola normal. */
let db: Db;
beforeEach(async () => { db = await newDb(); });
afterEach(async () => { await db.close(); });

async function setup() {
  const d = await seedDriver(db, '1');
  await db.su.query(`insert into public.excel_imports(file_name, file_sha256, status, source_kind, created_by, applied_at) values ('DATOS.xlsx','sha-w','applied','collection_flat',$1,now())`, [db.admin]);
  const tpl = (await db.su.query(`insert into public.message_templates(name, body) values ('Noche','Hola {{nombre}}') returning id`)).rows[0].id;
  // hora de 5 minutos atrás en Panamá: el horario "ya toca" ahora
  const t = (await db.su.query(`select to_char((now() at time zone app_private.tz()) - interval '5 minutes', 'HH24:MI') t`)).rows[0].t;
  await db.su.query(`insert into public.send_schedules(name, local_time, template_id, audience, enabled, armed_by) values ('Noche', $1, $2, 'all', true, $3)`, [t, tpl, db.admin]);
  return { d, tpl };
}
const queued = async () => (await db.su.query(`select status, kind, authorized_by from public.whatsapp_test_messages where kind='collection_message'`)).rows;

describe('horarios de envío en el worker', () => {
  it('con recordatorios automáticos activados, un tick crea los mensajes de la audiencia (una sola vez por día)', async () => {
    await setup();
    const { proc } = makeProcessor(db, { automaticReminders: true });
    await proc.tick();
    expect(await queued()).toEqual([{ status: 'prepared', kind: 'collection_message', authorized_by: db.admin }]);
    await proc.tick(); await proc.tick();
    expect(await queued()).toHaveLength(1);
    expect((await db.su.query(`select status, created from public.send_schedule_runs`)).rows).toEqual([{ status: 'done', created: 1 }]);
  });
  it('con AUTOMATIC_REMINDERS=false los horarios quedan guardados y NO se ejecutan', async () => {
    await setup();
    const { proc } = makeProcessor(db, { automaticReminders: false });
    for (let i = 0; i < 3; i++) await proc.tick();
    expect(await queued()).toHaveLength(0);
    expect((await db.su.query(`select count(*)::int n from public.send_schedule_runs`)).rows[0].n).toBe(0);
  });
});

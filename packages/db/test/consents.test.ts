import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BASE_TPL, ensureBaseTemplates, MON, chargeWeek } from './fixtures.js';
import { newDb, type Db, type Q } from './harness.js';

let db: Db; let n = 0;
beforeAll(async () => { db = await newDb(); });
afterAll(async () => { await db.close(); });
const adm = <T>(fn: (q: Q) => Promise<T>) => db.as(db.opsAdmin, fn);      // ADMIN
const sup = <T>(fn: (q: Q) => Promise<T>) => db.as(db.admin, fn);          // SUPER_ADMIN
const fresh = async (phone: string | null = '+50769990001') => {
  n += 1; const x = await db.driverWithAssignment({ code: `C${n}`, unit: `CU${n}`, dailyCents: 3600 });
  if (phone) await db.su.query(`update public.drivers set phone_e164=$2 where id=$1`, [x.driver, `+5076999${String(1000 + n)}`]);
  return x;
};
const drv = async (id: string) => (await db.su.query(`select whatsapp_consent, whatsapp_consent_source, whatsapp_consent_at, promotional_consent from public.drivers where id=$1`, [id])).rows[0];
const consent = (id: string, purpose: string, granted: boolean, source: string | null, ev: string | null = null) =>
  adm((q) => q.one(`select public.set_driver_consent($1,$2,$3,$4,$5) r`, [id, purpose, granted, source, ev])).then((x) => x.r);

describe('roles: solo SUPER_ADMIN y ADMIN', () => {
  it('ya no se puede asignar «supervisor»; quien lo tenía conserva solo lectura hasta ser reclasificado a mano', async () => {
    expect(await sup((q) => q.fails(`select public.set_app_user('ops@vip.test','supervisor')`))).toBe('role_deprecated');
    const before = (await db.su.query(`select role from public.app_users where user_id=$1`, [db.supervisor])).rows[0];
    expect(before.role).toBe('supervisor');                                                       // no se tocó ni se subió de nivel
    expect(await db.as(db.supervisor, (q) => q.fails(`select public.set_driver_consent(gen_random_uuid(),'collection',false,null)`))).toBe('forbidden');
  });
  it('la reclasificación es explícita y la hace un SUPER_ADMIN', async () => {
    const email = (await db.su.query(`select email from public.profiles where id=$1`, [db.supervisor])).rows[0].email;
    expect(await db.as(db.opsAdmin, (q) => q.fails(`select public.set_app_user($1,'admin')`, [email]))).toBe('forbidden');
    await sup((q) => q.one(`select public.set_app_user($1,'admin')`, [email]));
    expect((await db.su.query(`select role from public.app_users where user_id=$1`, [db.supervisor])).rows[0].role).toBe('admin');
    await db.su.query(`update public.app_users set role='supervisor' where user_id=$1`, [db.supervisor]);   // restaura el arnés
  });
});

describe('consentimiento de WhatsApp', () => {
  it('registrar exige ORIGEN; deja constancia con quién, cuándo y evidencia; ADMIN puede, otros no', async () => {
    const x = await fresh();
    expect(await adm((q) => q.fails(`select public.set_driver_consent($1,'collection',true,null)`, [x.driver]))).toBe('consent_source_required');
    expect(await adm((q) => q.fails(`select public.set_driver_consent($1,'collection',true,'legacy_unverified')`, [x.driver]))).toBe('consent_source_required');
    expect(await adm((q) => q.fails(`select public.set_driver_consent($1,'collection',true,'signed_form')`, [gen()]))).toBe('driver_not_found');
    expect(await db.as(db.supervisor, (q) => q.fails(`select public.set_driver_consent($1,'collection',true,'verbal_admin')`, [x.driver]))).toBe('forbidden');
    expect(await db.as(db.outsider, (q) => q.fails(`select public.set_driver_consent($1,'collection',true,'verbal_admin')`, [x.driver]))).toBe('forbidden');
    expect(await db.asAnon((q) => q.fails(`select public.set_driver_consent($1,'collection',true,'verbal_admin')`, [x.driver]))).toMatch(/permission denied/);
    await consent(x.driver, 'collection', true, 'driver_message', 'chat del 2026-11-10');
    expect(await drv(x.driver)).toMatchObject({ whatsapp_consent: true, whatsapp_consent_source: 'driver_message' });
    expect((await db.su.query(`select granted, source, evidence, recorded_by from public.driver_consents where driver_id=$1`, [x.driver])).rows)
      .toEqual([{ granted: true, source: 'driver_message', evidence: 'chat del 2026-11-10', recorded_by: db.opsAdmin }]);
    expect((await db.su.query(`select count(*)::int c from public.audit_logs where action='driver_consent.granted' and entity_id=$1`, [x.driver])).rows[0].c).toBe(1);
  });
  it('no se infiere por tener teléfono: un número solo no consiente; sin teléfono no se puede autorizar', async () => {
    const x = await fresh(); expect(await drv(x.driver)).toMatchObject({ whatsapp_consent: false, promotional_consent: false });
    const y = await fresh(null); await db.su.query(`update public.drivers set phone_e164=null where id=$1`, [y.driver]);
    expect(await adm((q) => q.fails(`select public.set_driver_consent($1,'collection',true,'verbal_admin')`, [y.driver]))).toBe('consent_requires_phone');
  });
  it('un cliente no puede marcar el consentimiento por la tabla directamente (ni al crear ni al editar)', async () => {
    const x = await fresh();
    expect(await adm((q) => q.fails(`update public.drivers set whatsapp_consent=true where id=$1`, [x.driver]))).toBe('consent_requires_declaration');
    expect(await adm((q) => q.fails(`update public.drivers set promotional_consent=true where id=$1`, [x.driver]))).toBe('consent_requires_declaration');
    expect(await adm((q) => q.fails(`insert into public.drivers(operator_code, first_name, last_name, phone_e164, whatsapp_consent) values ('DIRECT','A','B','+50760001234', true)`))).toBe('consent_requires_declaration');
    expect((await drv(x.driver)).whatsapp_consent).toBe(false);
    // editar otros campos sigue funcionando
    await adm((q) => q.query(`update public.drivers set first_name='Nuevo' where id=$1`, [x.driver]));
  });
  it('cobranza y promocional son independientes', async () => {
    const x = await fresh();
    await consent(x.driver, 'collection', true, 'verbal_admin');
    expect(await drv(x.driver)).toMatchObject({ whatsapp_consent: true, promotional_consent: false });
    await consent(x.driver, 'promotional', true, 'signed_form');
    await consent(x.driver, 'collection', false, null);
    expect(await drv(x.driver)).toMatchObject({ whatsapp_consent: false, promotional_consent: true });      // retirar uno no toca el otro
    expect(await adm((q) => q.fails(`select public.set_driver_consent($1,'otro',true,'verbal_admin')`, [x.driver]))).toBe('invalid_purpose');
  });
  it('retirar el de cobranza DETIENE los envíos pendientes y futuros, y conserva el historial', async () => {
    const x = await fresh(); await chargeWeek(db, MON);
    await consent(x.driver, 'collection', true, 'verbal_admin');
    await ensureBaseTemplates(db); await db.su.query(`update public.notification_schedules set enabled=true, template_id=${BASE_TPL}`);
    const sched = (await db.asService((q) => q.one(`select public.schedule_reminders($1) n`, [`${MON}T11:05:00-05:00`]))).n;
    expect(sched).toBeGreaterThanOrEqual(1);
    const pending = async () => (await db.su.query(`select count(*)::int c from public.notification_jobs where driver_id=$1 and status='pending'`, [x.driver])).rows[0].c;
    expect(await pending()).toBeGreaterThan(0);
    const r = await consent(x.driver, 'collection', false, null);
    expect(r).toMatchObject({ granted: false });
    expect(r.cancelled_jobs).toBeGreaterThan(0);
    expect(await pending()).toBe(0);
    expect((await db.su.query(`select status, error from public.notification_jobs where driver_id=$1`, [x.driver])).rows.every((j) => j.status === 'cancelled' && j.error === 'consentimiento retirado')).toBe(true);
    expect(await drv(x.driver)).toMatchObject({ whatsapp_consent: false, whatsapp_consent_source: null, whatsapp_consent_at: null });
    // nuevos recordatorios del mismo día ya no se crean para este conductor
    await db.asService((q) => q.one(`select public.schedule_reminders($1) n`, [`${MON}T17:05:00-05:00`]));
    expect(await pending()).toBe(0);
    // el historial conserva autorización y retiro
    expect((await db.su.query(`select granted, source from public.driver_consents where driver_id=$1 order by recorded_at, id`, [x.driver])).rows)
      .toEqual([{ granted: true, source: 'verbal_admin' }, { granted: false, source: 'withdrawal' }]);
  });
  it('si el consentimiento se retira con un envío ya reclamado, la verificación final lo omite', async () => {
    const x = await fresh(); await chargeWeek(db, MON);
    await consent(x.driver, 'collection', true, 'verbal_admin');
    await ensureBaseTemplates(db); await db.su.query(`update public.notification_schedules set enabled=true, template_id=${BASE_TPL}`);
    await db.asService((q) => q.one(`select public.schedule_reminders($1) n`, [`${MON}T11:05:00-05:00`]));
    const job = (await db.asService((q) => q.rows(`select * from public.claim_notification_jobs(500, $1)`, [`${MON}T11:06:00-05:00`]))).find((j) => j.driver_id === x.driver);
    expect(job).toBeTruthy();
    await consent(x.driver, 'collection', false, null);
    expect((await db.asService((q) => q.one(`select public.prepare_notification_send($1) p`, [job.id]))).p).toMatchObject({ action: 'skip', reason: 'skipped_no_consent' });
  });
  it('el historial es inmutable y solo lo ve el personal', async () => {
    const x = await fresh(); await consent(x.driver, 'collection', true, 'verbal_admin');
    expect(await adm((q) => q.fails(`update public.driver_consents set granted=false`))).toMatch(/permission denied/);
    expect(await adm((q) => q.fails(`delete from public.driver_consents`))).toMatch(/permission denied/);
    expect((await db.su.query(`select 1 from public.driver_consents`)).rows.length).toBeGreaterThan(0);
    expect(await db.su.query(`update public.driver_consents set granted=false`).then(() => 'ok', (e) => e.message)).toMatch(/no permit/i);
    expect((await db.as(db.outsider, (q) => q.rows(`select * from public.driver_consents`))).length).toBe(0);
  });
});
const gen = () => '00000000-0000-4000-8000-000000000000';

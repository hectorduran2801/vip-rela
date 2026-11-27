import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newDb, type Db } from './support/harness.js';
import { at, enableSchedules, jobs, makeProcessor, realFake, seedDriver } from './support/fixtures.js';
import { FakeAdapter } from '../src/adapters/fake.js';

// Comportamiento REAL de armed_at (sin el trigger de pruebas que lo anula). Todo con adaptadores falsos: nada sale a WhatsApp.
let db: Db;
beforeEach(async () => { db = await newDb({ arming: true }); });
afterEach(async () => { await db.close(); });

const adm = <T>(fn: (q: import('./support/harness.js').Q) => Promise<T>) => db.as(db.admin, fn);
const closeAll = (...c: Array<{ workerDb: { close(): Promise<void> } }>) => Promise.all(c.map((x) => x.workerDb.close()));

/** Promesa controlable desde la prueba. */
function gate() { let open!: () => void; const p = new Promise<void>((r) => { open = r; }); return { p, open }; }

/** Rate limiter inyectado: avisa que el job llegó a la espera (ya procesó la 1ª preparación) y se queda bloqueado hasta que la prueba lo suelta. */
function heldLimiter() {
  const entered = gate(); const release = gate();
  return { entered: entered.p, release: release.open, limiter: { acquire: async () => { entered.open(); await release.p; } } };
}

/** Adaptador falso cuyo sendText avisa que empezó y espera una puerta; puede terminar bien o con un error controlado. */
class GatedAdapter extends FakeAdapter {
  started = gate(); private door = gate(); private fail: Error | null = null;
  async sendText(phone: string, body: string) {
    this.started.open(); await this.door.p;
    if (this.fail) throw this.fail;
    return super.sendText(phone, body);
  }
  finish(err?: Error) { this.fail = err ?? null; this.door.open(); }
}

const SID = `(select id from public.notification_schedules where kind='debt_first')`;
/** Job pendiente de la configuración VIGENTE del horario (snapshot de armed_at), como lo crea schedule_reminders. */
async function seedJob(driverId: string, o: { snapshot?: boolean } = {}) {
  await db.su.query(`insert into public.notification_jobs(driver_id, kind, local_date, scheduled_for, schedule_id, schedule_armed_at)
    select $1,'debt_first','2026-11-16',$2, id, ${o.snapshot === false ? 'null' : 'armed_at'} from public.notification_schedules where kind='debt_first'`, [driverId, at('11:00')]);
}
const schedule = async () => (await db.su.query(`select * from public.notification_schedules where kind='debt_first'`)).rows[0];
const CANCEL_MSG = 'Horario modificado o desactivado antes del envío';

async function heldScenario(mutate: (driverId: string) => Promise<unknown>) {
  await enableSchedules(db);
  const d = await seedDriver(db, '1'); await seedJob(d.driver);
  const real = await realFake(); const h = heldLimiter();
  const p = makeProcessor(db, { clock: at('11:05'), real, dryRun: false, rateLimiter: h.limiter });
  const tick = p.proc.tick();
  await h.entered;                                                       // el job está en processing y ya pasó la 1ª preparación
  expect((await jobs(db))[0]!.status).toBe('processing');
  await mutate(d.driver);
  h.release();
  const res = await tick;
  return { real, p, res, d };
}

describe('la desactivación o edición durante la espera frena el envío ANTES de llamar al adaptador (verificación final)', () => {
  const cases: Array<[string, () => Promise<unknown>]> = [
    ['a) deactivate_schedule', () => adm((q) => q.query(`select public.deactivate_schedule(${SID})`))],
    ['a) UPDATE enabled=false directo', () => adm((q) => q.query(`update public.notification_schedules set enabled=false where kind='debt_first'`))],
    ['b) cambio de HORA', () => adm((q) => q.query(`update public.notification_schedules set local_time='11:04' where kind='debt_first'`))],
    ['c) cambio de DÍAS', () => adm((q) => q.query(`update public.notification_schedules set weekdays='{1,2}' where kind='debt_first'`))],
    ['d) cambio de PLANTILLA', async () => {
      await db.su.query(`insert into public.message_templates(name, body) values ('otra', 'Otro texto {{nombre}}')`);
      await adm((q) => q.query(`update public.notification_schedules set template_id=(select id from public.message_templates where name='otra') where kind='debt_first'`));
    }],
    ['e) cambio de ÁMBITO', () => adm((q) => q.query(`update public.notification_schedules set scope='today' where kind='debt_first'`))],
  ];
  it.each(cases)('%s: el job queda cancelled y el adaptador nunca se llama (también con g) rate limiter bloqueado)', async (_n, mutate) => {
    const { real, p, res } = await heldScenario(mutate);
    expect(real.calls).toHaveLength(0);
    expect(res).toMatchObject({ claimed: 1, sent: 0, skipped: 1, failed: 0 });
    const j = (await jobs(db))[0]!;
    expect(j).toMatchObject({ status: 'cancelled', error: CANCEL_MSG, sent_at: null, rendered_body: null, provider_message_id: null });
    const a = (await db.su.query(`select detail from public.audit_logs where action='notification_cancelled_schedule_changed' and entity_id=$1`, [j.id])).rows;
    expect(a).toHaveLength(1);
    await closeAll(p);
  });
  it('cambiar la hora y REACTIVAR antes de soltar: el job de la configuración antigua sigue cancelado (j)', async () => {
    const { real, p } = await heldScenario(async () => {
      await adm((q) => q.query(`update public.notification_schedules set local_time='11:04' where kind='debt_first'`));
      await adm((q) => q.query(`select public.activate_schedule(${SID}, true)`));
      expect((await schedule()).enabled).toBe(true);                                      // el horario volvió a estar activo
    });
    expect(real.calls).toHaveLength(0);
    expect((await jobs(db))[0]).toMatchObject({ status: 'cancelled', error: CANCEL_MSG });
    // más ciclos tras reactivar: el viejo no se re-encola y no sale nada (las ocurrencias nuevas solo desde armed_at)
    const later = makeProcessor(db, { clock: at('11:30'), real, dryRun: false });
    await later.proc.tick();
    expect((await jobs(db)).filter((j) => j.status === 'cancelled')).toHaveLength(1);
    expect((await jobs(db)).filter((j) => j.status === 'sent')).toHaveLength(0);
    expect(real.calls).toHaveLength(0);
    await closeAll(p, later);
  });
  it('d2) se EDITA el cuerpo de la MISMA plantilla durante la espera: se envía el cuerpo ACTUAL, nunca el anterior', async () => {
    const { real, p } = await heldScenario(async () => {
      await db.su.query(`update public.message_templates set body='TEXTO NUEVO {{nombre}}' where id=(select template_id from public.notification_schedules where kind='debt_first')`);
    });
    expect(real.calls).toHaveLength(1);
    expect(real.calls[0]!.body).toMatch(/^TEXTO NUEVO /);
    expect(real.calls[0]!.body).not.toContain('Gracias por su atención');
    expect((await jobs(db))[0]).toMatchObject({ status: 'sent', rendered_body: real.calls[0]!.body });
    await closeAll(p);
  });
  it('f) cambiar la ETIQUETA no cancela el job: se envía', async () => {
    const { real, p } = await heldScenario(() => adm((q) => q.query(`update public.notification_schedules set label=label||' (renombrado)' where kind='debt_first'`)));
    expect(real.calls).toHaveLength(1);
    expect((await jobs(db))[0]!.status).toBe('sent');
    await closeAll(p);
  });
  it('k) consentimiento retirado mientras el job está processing: se omite y no se envía', async () => {
    const { real, p } = await heldScenario((driver) => db.su.query(`update public.drivers set whatsapp_consent=false where id=$1`, [driver]));
    expect(real.calls).toHaveLength(0);
    expect((await jobs(db))[0]).toMatchObject({ status: 'skipped_no_consent' });
    await closeAll(p);
  });
});

describe('h) la desactivación llega DESPUÉS de que sendText empezó: el resultado ya no es cancelable', () => {
  async function setup() {
    await enableSchedules(db);
    const d = await seedDriver(db, '1'); await seedJob(d.driver);
    const real = new GatedAdapter(); real.forceConnected();
    const p = makeProcessor(db, { clock: at('11:05'), real, dryRun: false });
    const tick = p.proc.tick();
    await real.started.p;                                                               // sendText ya fue invocado (pasó la verificación final)
    await adm((q) => q.query(`select public.deactivate_schedule(${SID})`));            // ahora sí se desactiva
    return { real, p, tick };
  }
  it('el adaptador confirma: el job queda sent (el envío ya salió), con acuse solo «accepted», jamás delivered', async () => {
    const { real, p, tick } = await setup();
    real.finish(); await tick;
    expect(real.calls).toHaveLength(1);
    expect((await jobs(db))[0]).toMatchObject({ status: 'sent', delivery_status: 'accepted', delivered_at: null });
    await closeAll(p);
  });
  it('resultado INCIERTO (outcome unknown): job failed sin reintento, sin marcar enviado ni entregado, y NUNCA se reenvía', async () => {
    const { real, p, tick } = await setup();
    real.finish(Object.assign(new Error('could not confirm the result'), { outcome: 'unknown' }));
    expect(await tick).toMatchObject({ sent: 0, failed: 1 });
    const j = (await jobs(db))[0]!;
    expect(j).toMatchObject({ status: 'failed', sent_at: null, provider_message_id: null, delivery_status: null, delivered_at: null, rendered_body: null, attempts: 1 });
    expect(j.error).toMatch(/Resultado incierto, no se reintenta/);
    // ciclos posteriores (incluso mucho después, con el horario reactivado): no se reclama ni se reenvía
    await adm((q) => q.query(`select public.activate_schedule(${SID}, true)`));
    const later = makeProcessor(db, { clock: at('13:00'), real, dryRun: false });
    expect(await later.proc.tick()).toMatchObject({ claimed: 0, sent: 0 });
    expect((await jobs(db)).filter((x) => x.id === j.id)[0]!.status).toBe('failed');
    await closeAll(p, later);
  });
  it('un error NO incierto sí se reintenta (comportamiento anterior)', async () => {
    const { real, p, tick } = await setup();
    real.finish(new Error('sesión caída'));
    await tick;
    expect((await jobs(db))[0]).toMatchObject({ status: 'pending', attempts: 1 });
    await closeAll(p);
  });
});

describe('i) reclamos concurrentes del mismo job', () => {
  it('varios reclamadores en paralelo: el job lo obtiene uno solo (FOR UPDATE SKIP LOCKED) y se envía una vez', async () => {
    await enableSchedules(db);
    const d = await seedDriver(db, '1'); await seedJob(d.driver);
    const clients = await Promise.all(Array.from({ length: 6 }, () => db.open()));
    const got = await Promise.all(clients.map((c) => c.query(`select id from public.claim_notification_jobs(10, $1)`, [at('11:05')]).then((r) => r.rowCount)));
    await Promise.all(clients.map((c) => c.end()));
    expect(got.reduce((a, b) => a! + b!, 0)).toBe(1);
    // y dos procesadores sobre el mismo job: un solo envío
    await db.su.query(`update public.notification_jobs set status='pending', claimed_at=null, attempts=0`);
    const real = await realFake();
    const p1 = makeProcessor(db, { clock: at('11:05'), real, dryRun: false }); const p2 = makeProcessor(db, { clock: at('11:05'), real, dryRun: false });
    await Promise.all([p1.proc.tick(), p2.proc.tick()]);
    expect(real.calls).toHaveLength(1);
    await closeAll(p1, p2);
  });
});

describe('compatibilidad: job con schedule_id sin snapshot (antiguo/manual)', () => {
  it('snapshot nulo = comportamiento actual: se envía si el horario sigue activo y se cancela si está apagado', async () => {
    await enableSchedules(db);
    const d = await seedDriver(db, '1'); await seedJob(d.driver, { snapshot: false });
    const real = await realFake();
    const p = makeProcessor(db, { clock: at('11:05'), real, dryRun: false });
    await p.proc.tick();
    expect(real.calls).toHaveLength(1);
    await db.su.query(`delete from public.notification_jobs`);
    await seedJob(d.driver, { snapshot: false });
    await db.su.query(`update public.notification_schedules set enabled=false where kind='debt_first'`);
    // (el trigger ya canceló el pendiente; se reinserta uno viejo para comprobar la verificación en prepare)
    await db.su.query(`delete from public.notification_jobs`);
    await seedJob(d.driver, { snapshot: false });
    await p.proc.tick();
    expect(real.calls).toHaveLength(1);
    expect((await jobs(db))[0]).toMatchObject({ status: 'cancelled', error: CANCEL_MSG });
    await closeAll(p);
  });
});

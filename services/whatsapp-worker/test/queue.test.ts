import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newDb, type Db } from './support/harness.js';
import { at, enableSchedules, jobs, makeProcessor, pay, realFake, seedDriver } from './support/fixtures.js';
import { FakeAdapter } from '../src/adapters/fake.js';

let db: Db;
beforeEach(async () => { db = await newDb(); });
afterEach(async () => { await db.close(); });

const closeAll = (...c: Array<{ workerDb: { close(): Promise<void> } }>) => Promise.all(c.map((x) => x.workerDb.close()));

describe('recordatorios programados', () => {
  it('se crean solo dentro de la ventana y una vez por día', async () => {
    await enableSchedules(db);
    await seedDriver(db, '1');

    const before = makeProcessor(db, { clock: at('10:00') });           // antes de las 11:00
    expect((await before.proc.tick()).scheduled).toBe(0);
    const t1 = makeProcessor(db, { clock: at('11:05') });
    expect((await t1.proc.tick()).scheduled).toBe(1);                    // debt_first
    expect((await t1.proc.tick()).scheduled).toBe(0);                    // misma ventana: sin duplicado
    const late = makeProcessor(db, { clock: at('14:30') });              // 11:00 ya caducó (gracia 3 h), 17:00 aún no
    expect((await late.proc.tick()).scheduled).toBe(0);
    const t2 = makeProcessor(db, { clock: at('17:10') });
    expect((await t2.proc.tick()).scheduled).toBe(1);                    // debt_update
    const kinds = (await jobs(db)).map((j) => j.kind).sort();
    expect(kinds).toEqual(['debt_first', 'debt_update']);
    const sunday = makeProcessor(db, { clock: at('11:05', '2026-11-22') });   // domingo: solo weekly_summary (09:00)
    expect((await sunday.proc.tick()).scheduled).toBe(1);
    expect((await jobs(db, `local_date = '2026-11-22'`)).map((j) => j.kind)).toEqual(['weekly_summary']);
    await closeAll(before, t1, late, t2, sunday);
  });
});

describe('saldo al momento del envío (dry-run)', () => {
  it('a las 17:00, tras un pago parcial, el mensaje muestra el NUEVO saldo', async () => {
    await enableSchedules(db);
    const d = await seedDriver(db, '1');

    const am = makeProcessor(db, { clock: at('11:05') });
    expect((await am.proc.tick()).sent).toBe(1);
    expect((await jobs(db, `kind='debt_first'`))[0].rendered_body).toContain('$36.00');

    await pay(db, d.assignment, 1000, 'k-parcial');       // paga $10 en efectivo
    const pm = makeProcessor(db, { clock: at('17:05') });
    const r = await pm.proc.tick();
    expect(r.sent).toBe(1);
    const j = (await jobs(db, `kind='debt_update'`))[0];
    expect(j.status).toBe('sent');
    expect(j.rendered_body).toContain('$26.00');
    expect(j.rendered_body).not.toContain('$36.00');
    await closeAll(am, pm);
  });

  it('si pagó todo: skipped_paid y no se envía', async () => {
    await enableSchedules(db);
    const d = await seedDriver(db, '1');
    await pay(db, d.assignment, 3600, 'k-full');
    const real = await realFake();
    const p = makeProcessor(db, { clock: at('17:05'), real, dryRun: false });
    const r = await p.proc.tick();
    expect(r.skipped).toBe(1);
    expect((await jobs(db, `kind='debt_update'`))[0].status).toBe('skipped_paid');
    expect(real.calls).toHaveLength(0);
    await closeAll(p);
  });

  it('solo crédito: skipped_credit (y el aviso de crédito NO se envía hasta aprobación)', async () => {
    await enableSchedules(db);
    const d = await seedDriver(db, '1');
    await pay(db, d.assignment, 5000, 'k-cred');           // $50 > $36 => $14 de crédito
    const real = await realFake();
    const p = makeProcessor(db, { clock: at('17:05'), real, dryRun: false });
    expect((await p.proc.tick()).skipped).toBe(1);
    expect((await jobs(db, `kind='debt_update'`))[0].status).toBe('skipped_credit');
    expect(real.calls).toHaveLength(0);
    await closeAll(p);
  });

  it('sin consentimiento o sin teléfono: schedule_reminders NO crea jobs', async () => {
    await enableSchedules(db);
    await seedDriver(db, '1', { consent: false });
    await seedDriver(db, '2', { phone: null, consent: false });
    const real = await realFake();
    const p = makeProcessor(db, { clock: at('11:05'), real, dryRun: false });
    const r = await p.proc.tick();
    expect(r.scheduled).toBe(0); expect(r.claimed).toBe(0);
    expect(await jobs(db)).toHaveLength(0);
    expect(real.calls).toHaveLength(0);
    await closeAll(p);
  });

  it('consentimiento retirado después de crear el job: skipped_no_consent y no se envía', async () => {
    await enableSchedules(db);
    const d = await seedDriver(db, '1');
    const mgr = makeProcessor(db, { clock: at('11:05'), dryRun: false });       // sin sesión: solo programa
    expect((await mgr.proc.tick()).scheduled).toBe(1);
    await db.su.query(`update public.drivers set whatsapp_consent = false where id = $1`, [d.driver]);
    const real = await realFake();
    const p = makeProcessor(db, { clock: at('11:06'), real, dryRun: false });
    expect((await p.proc.tick()).skipped).toBe(1);
    expect((await jobs(db))[0].status).toBe('skipped_no_consent');
    expect(real.calls).toHaveLength(0);
    await closeAll(mgr, p);
  });

  it('job insertado a mano para un conductor sin consentimiento: skipped_no_consent', async () => {
    const d = await seedDriver(db, '1', { consent: false });
    await db.su.query(
      `insert into public.notification_jobs(driver_id, kind, local_date, scheduled_for) values ($1,'debt_reminder','2026-11-16',$2)`, [d.driver, at('11:00')]);
    const real = await realFake();
    const p = makeProcessor(db, { clock: at('11:05'), real, dryRun: false });
    expect((await p.proc.tick()).skipped).toBe(1);
    expect((await jobs(db))[0].status).toBe('skipped_no_consent');
    expect(real.calls).toHaveLength(0);
    await closeAll(p);
  });
});

describe('pausa y frecuencia', () => {
  it('conductor pausado: no se programa; si se pausa después, skipped_paused', async () => {
    await enableSchedules(db);
    const paused = await seedDriver(db, '1');
    await db.su.query(`update public.drivers set reminders_paused = true where id = $1`, [paused.driver]);
    const ok = await seedDriver(db, '2');
    const real = await realFake();
    const p1 = makeProcessor(db, { clock: at('11:05'), real, dryRun: false });
    expect((await p1.proc.tick()).scheduled).toBe(1);                          // solo el no pausado
    expect(real.calls).toHaveLength(1);

    await db.su.query(`update public.drivers set reminders_paused = true where id = $1`, [ok.driver]);
    const p2 = makeProcessor(db, { clock: at('17:05'), real, dryRun: false });
    expect((await p2.proc.tick()).skipped).toBe(0);                            // el pausado ya no tiene job
    expect((await jobs(db, `driver_id = '${ok.driver}' and kind = 'debt_update'`))).toHaveLength(0);

    // Job ya creado y pausa posterior: se omite en el envío.
    await db.su.query(`update public.drivers set reminders_paused = false where id = $1`, [ok.driver]);
    await db.su.query(`delete from public.notification_jobs where kind = 'debt_update'`);
    const p3 = makeProcessor(db, { clock: at('17:06'), dryRun: false });
    expect((await p3.proc.tick()).scheduled).toBeGreaterThan(0);
    await db.su.query(`update public.drivers set reminders_paused = true where id = $1`, [ok.driver]);
    const calls = real.calls.length;
    const p4 = makeProcessor(db, { clock: at('17:07'), real, dryRun: false });
    await p4.proc.tick();
    expect((await jobs(db, `driver_id = '${ok.driver}' and kind = 'debt_update'`))[0].status).toBe('skipped_paused');
    expect(real.calls).toHaveLength(calls);
    await closeAll(p1, p2, p3, p4);
  });

  it('límite diario: el segundo recordatorio del día queda skipped_frequency', async () => {
    await enableSchedules(db);
    await seedDriver(db, '1');
    await db.su.query(`update public.app_settings set max_per_driver_per_day = 1`);
    const real = await realFake();
    const am = makeProcessor(db, { clock: at('11:05'), real, dryRun: false });
    expect((await am.proc.tick()).sent).toBe(1);
    const pm = makeProcessor(db, { clock: at('17:05'), real, dryRun: false });
    const r = await pm.proc.tick();
    expect(r.sent).toBe(0); expect(r.skipped).toBe(1);
    expect((await jobs(db, `kind='debt_update'`))[0].status).toBe('skipped_frequency');
    expect(real.calls).toHaveLength(1);
    await closeAll(am, pm);
  });

  it('separación mínima entre mensajes: skipped_frequency', async () => {
    await enableSchedules(db);
    await seedDriver(db, '1');
    await db.su.query(`update public.app_settings set min_minutes_between = 600`);   // 10 h
    const real = await realFake();
    const am = makeProcessor(db, { clock: at('11:05'), real, dryRun: false });
    await am.proc.tick();
    const pm = makeProcessor(db, { clock: at('17:05'), real, dryRun: false });
    expect((await pm.proc.tick()).skipped).toBe(1);
    expect((await jobs(db, `kind='debt_update'`))[0].status).toBe('skipped_frequency');
    expect(real.calls).toHaveLength(1);
    await closeAll(am, pm);
  });
});

describe('verificación final y defer', () => {
  /** rateLimiter cuyo acquire() ejecuta `onWait` (p. ej. registrar un pago) mientras "espera el turno". */
  const waiting = (onWait: () => Promise<unknown>) => ({ acquire: async () => { await onWait(); } });

  it('un pago llega entre la preparación y el envío: no se envía el mensaje obsoleto (skipped_paid)', async () => {
    await enableSchedules(db);
    const d = await seedDriver(db, '1');
    const real = await realFake();
    let waits = 0;
    const p = makeProcessor(db, { clock: at('11:05'), real, dryRun: false,
      rateLimiter: waiting(async () => { waits++; await pay(db, d.assignment, 3600, 'k-final-full'); }) });
    const r = await p.proc.tick();
    expect(waits).toBe(1);
    expect(r.sent).toBe(0); expect(r.skipped).toBe(1);
    expect(real.calls).toHaveLength(0);                                       // nada obsoleto salió a WhatsApp
    expect((await jobs(db, `kind='debt_first'`))[0].status).toBe('skipped_paid');
    await closeAll(p);
  });

  it('un pago parcial durante la espera: se envía el texto NUEVO, no el preparado antes', async () => {
    await enableSchedules(db);
    const d = await seedDriver(db, '1');
    const real = await realFake();
    const p = makeProcessor(db, { clock: at('11:05'), real, dryRun: false,
      rateLimiter: waiting(() => pay(db, d.assignment, 1000, 'k-final-part')) });
    expect((await p.proc.tick()).sent).toBe(1);
    expect(real.calls).toHaveLength(1);
    expect(real.calls[0]!.body).toContain('$26.00');
    expect(real.calls[0]!.body).not.toContain('$36.00');
    const j = (await jobs(db, `kind='debt_first'`))[0];
    expect(j.status).toBe('sent'); expect(j.rendered_body).toBe(real.calls[0]!.body);
    await closeAll(p);
  });

  it('la verificación final también corre en dry-run (y el adaptador real nunca se llama)', async () => {
    await enableSchedules(db);
    const d = await seedDriver(db, '1');
    const real = await realFake();
    const senderFor = vi.fn(() => real);
    const p = makeProcessor(db, { clock: at('11:05'), senderFor, dryRun: true });
    await p.proc.tick();
    expect((await jobs(db))[0].status).toBe('sent');
    // dry-run: ni senderFor ni el adaptador real se tocan
    expect(senderFor).not.toHaveBeenCalled();
    expect(real.calls).toHaveLength(0);
    expect(p.dry.sent).toHaveLength(1);
    void d;
    await closeAll(p);
  });

  it('defer: otro envío del mismo conductor en curso libera el job sin consumir intento y luego se envía', async () => {
    await enableSchedules(db);
    const d = await seedDriver(db, '1');
    const idA = '00000000-0000-4000-8000-000000000001', idB = '00000000-0000-4000-8000-000000000002';
    // A (id menor) está "en curso" en otro proceso; B está pendiente.
    await db.su.query(
      `insert into public.notification_jobs(id, driver_id, kind, local_date, scheduled_for, status, attempts, claimed_at, schedule_id)
       values ($1,$3,'debt_first','2026-11-16',$4,'processing',1,$4,(select id from public.notification_schedules where kind='debt_first')), ($2,$3,'debt_update','2026-11-16',$4,'pending',0,null,(select id from public.notification_schedules where kind='debt_update'))`,
      [idA, idB, d.driver, at('11:00')]);
    const real = await realFake();
    const clock = at('11:05');
    const p = makeProcessor(db, { clock, real, dryRun: false, deferRetryMs: 30_000 });
    const r = await p.proc.tick();
    expect(r.claimed).toBe(1); expect(r.released).toBe(1); expect(r.sent).toBe(0); expect(r.failed).toBe(0);
    expect(real.calls).toHaveLength(0);
    const b = (await jobs(db, `id = '${idB}'`))[0];
    expect(b.status).toBe('pending'); expect(b.attempts).toBe(0); expect(b.claimed_at).toBeNull();
    expect(new Date(b.scheduled_for).getTime()).toBe(clock.getTime() + 30_000);

    await db.su.query(`update public.notification_jobs set status = 'cancelled' where id = $1`, [idA]);   // el otro envío terminó
    const p2 = makeProcessor(db, { clock: at('11:06'), real, dryRun: false });
    expect((await p2.proc.tick()).sent).toBe(1);
    const b2 = (await jobs(db, `id = '${idB}'`))[0];
    expect(b2.status).toBe('sent'); expect(b2.attempts).toBe(1);
    await closeAll(p, p2);
  });

  it('defer detectado en la verificación final (otro job del conductor pasa a processing durante la espera)', async () => {
    await enableSchedules(db);
    const d = await seedDriver(db, '1');
    const idA = '00000000-0000-4000-8000-0000000000a1', idB = '00000000-0000-4000-8000-0000000000b2';
    await db.su.query(
      `insert into public.notification_jobs(id, driver_id, kind, local_date, scheduled_for, status, schedule_id) values ($2,$1,'debt_first','2026-11-16',$3,'cancelled',(select id from public.notification_schedules where kind='debt_first')), ($4,$1,'debt_update','2026-11-16',$3,'pending',(select id from public.notification_schedules where kind='debt_update'))`,
      [d.driver, idA, at('11:00'), idB]);
    const real = await realFake();
    const p = makeProcessor(db, { clock: at('11:05'), real, dryRun: false,
      rateLimiter: waiting(() => db.su.query(`update public.notification_jobs set status = 'processing', claimed_at = now() where id = $1`, [idA])) });
    const r = await p.proc.tick();
    expect(r.released).toBe(1); expect(r.sent).toBe(0);
    expect(real.calls).toHaveLength(0);
    const b = (await jobs(db, `id = '${idB}'`))[0];
    expect(b.status).toBe('pending'); expect(b.attempts).toBe(0);
    await closeAll(p);
  });
});

describe('aviso de crédito con aprobación (borradores heredados; la 0028 ya no crea nuevos)', () => {
  // Simula un borrador creado antes de la 0028: se desactiva el disparador que impide crearlos.
  const legacy = () => db.su.query('alter table public.notification_jobs disable trigger skip_credit_notice');   // la base de cada prueba es nueva: no hay que reactivarlo
  it('awaiting_approval nunca se reclama; tras approve sí se envía', async () => {
    await legacy();
        const d = await seedDriver(db, '1');
    await pay(db, d.assignment, 5000, 'k-n1');
    const [notice] = await jobs(db, `kind='credit_notice'`);
    expect(notice.status).toBe('awaiting_approval');

    const real = await realFake();
    const p = makeProcessor(db, { real, dryRun: false, clock: new Date(Date.now() + 3600_000) });
    for (let i = 0; i < 3; i++) expect((await p.proc.tick()).claimed).toBe(0);
    expect((await jobs(db, `id='${notice.id}'`))[0].status).toBe('awaiting_approval');
    expect(real.calls).toHaveLength(0);

    await db.as(db.admin, (q) => q.one(`select public.review_notification($1,'approve',null)`, [notice.id]));
    const r = await p.proc.tick();
    expect(r.sent).toBe(1);
    expect(real.calls).toHaveLength(1);
    expect(real.calls[0]!.body).toContain('saldo a favor');
    const after = (await jobs(db, `id='${notice.id}'`))[0];
    expect(after.status).toBe('sent'); expect(after.dry_run).toBe(false);
    await closeAll(p);
  });

  it('un aviso descartado jamás se envía', async () => {
    await legacy();
        const d = await seedDriver(db, '1');
    await pay(db, d.assignment, 5000, 'k-d1');
    const [n] = await jobs(db, `kind='credit_notice'`);
    await db.as(db.admin, (q) => q.one(`select public.review_notification($1,'discard',null)`, [n.id]));
    const real = await realFake();
    const p = makeProcessor(db, { real, dryRun: false, clock: new Date(Date.now() + 3600_000) });
    expect((await p.proc.tick()).claimed).toBe(0);
    await closeAll(p);
  });

  it('comprobante de pago: se envía con el saldo vigente', async () => {
        const d = await seedDriver(db, '1');
    await pay(db, d.assignment, 1000, 'k-r1', true);
    const real = await realFake();
    const p = makeProcessor(db, { real, dryRun: false, clock: new Date(Date.now() + 60_000) });
    expect((await p.proc.tick()).sent).toBe(1);
    expect(real.calls[0]!.body).toContain('Saldo pendiente: $26.00');
    await closeAll(p);
  });
});

describe('fallos, reintentos y recuperación', () => {
  it('fallo del adaptador: reintento con backoff y a los 3 intentos queda failed', async () => {
    await enableSchedules(db);
    await seedDriver(db, '1');
    const real = await realFake(); real.failSendsAlways('WhatsApp se cayó para +50760000001');
    const run = (clock: Date) => makeProcessor(db, { clock, real, dryRun: false });
    const get = async () => (await jobs(db))[0];

    let p = run(at('11:05')); let r = await p.proc.tick();
    expect(r.failed).toBe(1);
    let j = await get();
    expect(j.status).toBe('pending'); expect(j.attempts).toBe(1);
    expect(new Date(j.scheduled_for).getTime()).toBe(at('11:05').getTime() + 5 * 60_000);
    expect(j.error).not.toContain('50760000001');                       // el error se sanea (sin teléfono)

    p = run(at('11:07')); expect((await p.proc.tick()).claimed).toBe(0);   // aún en backoff
    p = run(at('11:10')); await p.proc.tick();
    j = await get(); expect(j.status).toBe('pending'); expect(j.attempts).toBe(2);
    expect(new Date(j.scheduled_for).getTime()).toBe(at('11:10').getTime() + 10 * 60_000);

    p = run(at('11:20')); await p.proc.tick();
    j = await get(); expect(j.status).toBe('failed'); expect(j.attempts).toBe(3);
    expect(real.calls).toHaveLength(0);
    p = run(at('12:00')); expect((await p.proc.tick()).claimed).toBe(0);
  });

  it('tras un fallo transitorio el reintento tiene éxito', async () => {
    await enableSchedules(db);
    await seedDriver(db, '1');
    const real = await realFake(); real.failNextSends(1);
    await makeProcessor(db, { clock: at('11:05'), real, dryRun: false }).proc.tick();
    await makeProcessor(db, { clock: at('11:12'), real, dryRun: false }).proc.tick();
    const j = (await jobs(db))[0];
    expect(j.status).toBe('sent'); expect(j.attempts).toBe(2); expect(real.calls).toHaveLength(1);
  });

  it('timeout del adaptador colgado cuenta como fallo y no bloquea la cola', async () => {
    await enableSchedules(db);
    await seedDriver(db, '1');
    const real = new FakeAdapter({ sendLatencyMs: 5000 }); real.forceConnected();
    const p = makeProcessor(db, { clock: at('11:05'), real, dryRun: false, sendTimeoutMs: 50 });
    const r = await p.proc.tick();
    expect(r.failed).toBe(1);
    expect((await jobs(db))[0].error).toMatch(/timeout/);
  });

  it('job atascado en processing se recupera y se envía', async () => {
        const d = await seedDriver(db, '1');
    await pay(db, d.assignment, 1000, 'k-s1', true);
    await db.su.query(`update public.notification_jobs set status='processing', attempts=1, claimed_at = now() - interval '20 minutes'`);
    const fresh = await seedDriver(db, '2');
    await pay(db, fresh.assignment, 1000, 'k-s2', true);
    await db.su.query(`update public.notification_jobs set status='processing', attempts=1, claimed_at = now() where payment_id = (select id from public.payments where idempotency_key='k-s2')`);

    const real = await realFake();
    const p = makeProcessor(db, { real, dryRun: false, clock: new Date(Date.now() + 60_000) });
    const r = await p.proc.tick();
    expect(r.requeued).toBe(1);                       // solo el viejo; el reciente sigue siendo de otro proceso
    expect(r.sent).toBe(1);
    const st = (await jobs(db)).map((j) => j.status).sort();
    expect(st).toEqual(['processing', 'sent']);
  });

  it('sin sesión conectada (no dry-run): no se reclama nada y no se consume intento', async () => {
    await enableSchedules(db);
    await seedDriver(db, '1');
    const p = makeProcessor(db, { clock: at('11:05'), dryRun: false });     // sin real ni senders
    const r = await p.proc.tick();
    expect(r.idle).toBe('no_session'); expect(r.claimed).toBe(0);
    const j = (await jobs(db))[0];
    expect(j.status).toBe('pending'); expect(j.attempts).toBe(0);
  });

  it('sesión conectada solo en apariencia (senderFor devuelve null): el job vuelve a pending con attempts intacto y aplazado', async () => {
    await enableSchedules(db);
    await seedDriver(db, '1');
    const p = makeProcessor(db, { clock: at('11:05'), dryRun: false, senderFor: () => null, noSessionRetryMs: 120_000 });
    // anyConnected() = true (senderFor definido) pero senderFor devuelve null
    const r = await p.proc.tick();
    expect(r.released).toBe(1);
    const j = (await jobs(db))[0];
    expect(j.status).toBe('pending'); expect(j.attempts).toBe(0); expect(j.claimed_at).toBeNull();
    expect(new Date(j.scheduled_for).getTime()).toBe(at('11:05').getTime() + 120_000);
  });
});

describe('dry-run', () => {
  it('marca dry_run=true y NO llama al adaptador real', async () => {
    await enableSchedules(db);
    await seedDriver(db, '1');
    const real = await realFake();
    const p = makeProcessor(db, { clock: at('11:05'), real, dryRun: true });
    const r = await p.proc.tick();
    expect(r.sent).toBe(1);
    const j = (await jobs(db))[0];
    expect(j.status).toBe('sent'); expect(j.dry_run).toBe(true);
    expect(real.calls).toHaveLength(0);
    expect(p.dry.sent).toHaveLength(1);
  });
  it('en dry-run funciona aunque no haya ninguna sesión', async () => {
    await enableSchedules(db);
    await seedDriver(db, '1');
    const p = makeProcessor(db, { clock: at('11:05'), dryRun: true });
    expect((await p.proc.tick()).sent).toBe(1);
  });
});

describe('concurrencia: sin duplicados', () => {
  it('dos procesadores sobre los mismos jobs: cada job se envía una sola vez', async () => {
    await enableSchedules(db);
    const N = 40;
    for (let i = 1; i <= N; i++) await seedDriver(db, String(i));
    const a = await realFake(), b = await realFake();
    const clock = at('11:05');
    const p1 = makeProcessor(db, { clock, real: a, dryRun: false, batchSize: 5, concurrency: 3 });
    const p2 = makeProcessor(db, { clock, real: b, dryRun: false, batchSize: 5, concurrency: 3 });
    const drain = async (p: typeof p1) => { for (let i = 0; i < 40; i++) { const r = await p.proc.tick(); if (r.claimed === 0 && i > 1) break; } };
    await Promise.all([drain(p1), drain(p2)]);

    const all = [...a.calls, ...b.calls];
    expect(all).toHaveLength(N);
    expect(new Set(all.map((c) => c.phone)).size).toBe(N);              // ningún teléfono dos veces
    expect(a.calls.length).toBeGreaterThan(0); expect(b.calls.length).toBeGreaterThan(0);   // ambos trabajaron
    const rows = await jobs(db);
    expect(rows).toHaveLength(N);
    expect(rows.every((j) => j.status === 'sent' && j.attempts === 1)).toBe(true);
  });
});

describe('apagado ordenado', () => {
  it('stop() espera al lote en curso', async () => {
    await enableSchedules(db);
    for (let i = 1; i <= 3; i++) await seedDriver(db, String(i));
    const real = new FakeAdapter({ sendLatencyMs: 80 }); real.forceConnected();
    const p = makeProcessor(db, { clock: at('11:05'), real, dryRun: false, pollMs: 10, concurrency: 1 });
    p.proc.start();
    await new Promise((r) => setTimeout(r, 60));          // el lote ya está en curso
    await p.proc.stop();
    const rows = await jobs(db);
    expect(rows.filter((j) => j.status === 'processing')).toHaveLength(0);   // nada quedó a medias
    expect(rows.filter((j) => j.status === 'sent').length).toBe(real.calls.length);
  });
});

describe('horarios sin plantilla (0024): omitidos de forma segura, jamás se envía texto fijo', () => {
  /** Quita la plantilla a todos los horarios saltando el guard (simula datos antiguos: activo sin plantilla). */
  async function stripTemplates() {
    await db.su.query(`alter table public.notification_schedules disable trigger guard_template`);
    await db.su.query(`update public.notification_schedules set template_id = null`);
    await db.su.query(`alter table public.notification_schedules enable trigger guard_template`);
  }
  it('horario activo sin plantilla: no se crean trabajos y no se envía nada (dry-run y adaptador real)', async () => {
    await enableSchedules(db); await stripTemplates();
    await seedDriver(db, '1');
    const real = await realFake();
    const dry = makeProcessor(db, { clock: at('11:05') });
    const live = makeProcessor(db, { clock: at('11:06'), real, dryRun: false });
    expect(await dry.proc.tick()).toMatchObject({ scheduled: 0, claimed: 0, sent: 0 });
    expect(await live.proc.tick()).toMatchObject({ scheduled: 0, claimed: 0, sent: 0 });
    expect(await jobs(db)).toHaveLength(0);
    expect(real.calls).toHaveLength(0);
    await closeAll(dry, live);
  });
  it('job pendiente cuyo horario perdió la plantilla: skipped_no_template, 0 envíos (dry-run y real)', async () => {
    await enableSchedules(db);
    const d1 = await seedDriver(db, '1'); const d2 = await seedDriver(db, '2');
    const sch = `(select id from public.notification_schedules where kind='debt_first')`;
    await db.su.query(`insert into public.notification_jobs(driver_id, kind, local_date, scheduled_for, schedule_id) values ($1,'debt_first','2026-11-16',$3,${sch}), ($2,'debt_first','2026-11-16',$3,${sch})`,
      [d1.driver, d2.driver, at('11:00')]);
    await stripTemplates();
    const real = await realFake();
    const live = makeProcessor(db, { clock: at('11:05'), real, dryRun: false });
    expect(await live.proc.tick()).toMatchObject({ sent: 0, failed: 0 });
    const all = await jobs(db);
    expect(all.map((j) => [j.status, j.error])).toEqual([['skipped_no_template', 'Horario sin plantilla asignada'], ['skipped_no_template', 'Horario sin plantilla asignada']]);
    expect(real.calls).toHaveLength(0);
    // dry-run: mismo resultado (el adaptador simulado tampoco "envía")
    await db.su.query(`update public.notification_jobs set status='pending', error=null, attempts=0`);
    const dry = makeProcessor(db, { clock: at('11:06') });
    expect((await dry.proc.tick()).sent).toBe(0);
    expect((await jobs(db)).every((j) => j.status === 'skipped_no_template' && j.rendered_body === null && j.sent_at === null)).toBe(true);
    await closeAll(live, dry);
  });
  it('los textos fijos de comprobante de pago siguen enviándose aunque los horarios no tengan plantilla', async () => {
    await enableSchedules(db); await stripTemplates();
    const d = await seedDriver(db, '1');
    await pay(db, d.assignment, 1000, 'k-nt1', true);
    const real = await realFake();
    const p = makeProcessor(db, { real, dryRun: false, clock: new Date(Date.now() + 60_000) });
    expect((await p.proc.tick()).sent).toBe(1);
    expect(real.calls[0]!.body).toContain('hemos registrado su pago');
    await closeAll(p);
  });
});

describe('auditoría del proveedor (0025): id de mensaje y números solo de envíos REALES', () => {
  it('envío real: guarda provider_message_id, emisor, destinatario y delivery_status=accepted (nunca delivered)', async () => {
    await enableSchedules(db);
    await seedDriver(db, '1');
    const real = await realFake();
    const p = makeProcessor(db, { clock: at('11:05'), real, dryRun: false });
    expect((await p.proc.tick()).sent).toBe(1);
    const j = (await jobs(db))[0];
    expect(j).toMatchObject({ status: 'sent', dry_run: false, provider_message_id: 'fake-1', sender_phone: real.getPhoneNumber(), recipient_phone: '+50760000001', delivery_status: 'accepted', delivered_at: null });
    expect(j.rendered_body).toBe(real.calls[0]!.body);
    await closeAll(p);
  });
  it('si el adaptador no devuelve id ni emisor: se guardan nulos (no se inventa nada ni se marca entregado)', async () => {
    await enableSchedules(db);
    await seedDriver(db, '1');
    const real = await realFake();
    real.sendText = async (phone: string, body: string) => { real.calls.push({ phone, body }); return {}; };
    (real as unknown as { getPhoneNumber: () => null }).getPhoneNumber = () => null;
    const p = makeProcessor(db, { clock: at('11:05'), real, dryRun: false });
    expect((await p.proc.tick()).sent).toBe(1);
    expect((await jobs(db))[0]).toMatchObject({ status: 'sent', provider_message_id: null, sender_phone: null, delivery_status: null, delivered_at: null, recipient_phone: '+50760000001' });
    await closeAll(p);
  });
  it('el emisor puede venir del propio resultado del adaptador', async () => {
    await enableSchedules(db);
    await seedDriver(db, '1');
    const real = await realFake();
    real.sendText = async (phone: string, body: string) => { real.calls.push({ phone, body }); return { messageId: 'wamid.X', sender: '+50769990000' }; };
    const p = makeProcessor(db, { clock: at('11:05'), real, dryRun: false });
    await p.proc.tick();
    expect((await jobs(db))[0]).toMatchObject({ provider_message_id: 'wamid.X', sender_phone: '+50769990000', delivery_status: 'accepted' });
    await closeAll(p);
  });
  it('dry-run: no se guarda id simulado ni números; un fallo de envío no guarda nada del proveedor', async () => {
    await enableSchedules(db);
    await seedDriver(db, '1');
    const p = makeProcessor(db, { clock: at('11:05'), dryRun: true });
    await p.proc.tick();
    expect((await jobs(db))[0]).toMatchObject({ status: 'sent', dry_run: true, provider_message_id: null, sender_phone: null, recipient_phone: null, delivery_status: null });
    await db.su.query(`delete from public.notification_jobs`);
    const real = await realFake(); real.failSendsAlways('boom');
    const q = makeProcessor(db, { clock: at('11:06'), real, dryRun: false });
    await q.proc.tick();
    expect((await jobs(db))[0]).toMatchObject({ status: 'pending', provider_message_id: null, recipient_phone: null, delivery_status: null });
    await closeAll(p, q);
  });
  it('un horario recién creado (desactivado) o editado jamás hace que el worker envíe', async () => {
    await enableSchedules(db);
    await seedDriver(db, '1');
    await db.su.query(`update public.notification_schedules set enabled=false`);
    const real = await realFake();
    const p = makeProcessor(db, { clock: at('11:05'), real, dryRun: false });
    expect(await p.proc.tick()).toMatchObject({ scheduled: 0, sent: 0 });
    expect(real.calls).toHaveLength(0);
    await closeAll(p);
  });
});

describe('editar un horario ACTIVO (0025): se desactiva y el worker no envía nada', () => {
  it('cambio de hora a +3 min con un pendiente creado: queda desactivado, trabajo cancelado, 0 envíos (adaptador falso y dry-run)', async () => {
    await db.su.query(`drop trigger zz_test_disarm on public.notification_schedules`);       // comportamiento real de 0025
    await enableSchedules(db);
    const d = await seedDriver(db, '1');
    const sid = (await db.su.query(`select id from public.notification_schedules where kind='debt_first'`)).rows[0].id as string;
    await db.su.query(`update public.notification_schedules set armed_at='2026-01-01' where id=$1`, [sid]);
    const sched = makeProcessor(db, { clock: at('11:01'), dryRun: true });
    await sched.proc.tick();                                                                  // crea el pendiente de las 11:00 y lo envía en dry-run
    await db.su.query(`delete from public.notification_jobs`);
    await db.su.query(`insert into public.notification_jobs(driver_id, kind, local_date, scheduled_for, schedule_id) values ($1,'debt_first','2026-11-16',$2,$3)`, [d.driver, at('11:00'), sid]);
    await db.as(db.admin, (q) => q.query(`update public.notification_schedules set local_time='11:04' where id=$1`, [sid]));   // «4:17 → 4:20»
    expect((await db.su.query(`select enabled, deactivated_reason from public.notification_schedules where id=$1`, [sid])).rows[0]).toEqual({ enabled: false, deactivated_reason: 'config_changed' });
    const real = await realFake();
    const live = makeProcessor(db, { clock: at('11:05'), real, dryRun: false });
    const dry = makeProcessor(db, { clock: at('11:05') });
    expect(await live.proc.tick()).toMatchObject({ scheduled: 0, claimed: 0, sent: 0 });
    expect(await dry.proc.tick()).toMatchObject({ scheduled: 0, claimed: 0, sent: 0 });
    expect(real.calls).toHaveLength(0); expect(dry.dry.sent).toHaveLength(0);
    expect((await jobs(db)).map((j) => j.status)).toEqual(['cancelled']);
    await closeAll(sched, live, dry);
  });
});

describe('recordatorios automáticos desactivados por bandera (AUTOMATIC_REMINDERS=false)', () => {
  it('aunque haya un horario habilitado y conductores con autorización, ni se programa ni se reclama nada por el paso del tiempo', async () => {
    const d = await seedDriver(db, '1');
    const tpl = (await db.su.query(`insert into public.message_templates(name, body) values ('Bandera', 'Hola {{nombre}}') returning id`)).rows[0].id;
    await db.su.query(`update public.notification_schedules set template_id = $1, enabled = true, local_time = '00:00', weekdays = '{1,2,3,4,5,6,7}'`, [tpl]);
    const { proc } = makeProcessor(db, { automaticReminders: false, clock: new Date(Date.now() + 3600_000) });
    for (let i = 0; i < 3; i++) { const r = await proc.tick(); expect(r).toMatchObject({ scheduled: 0, claimed: 0 }); expect(r.idle).toBe('manual_only'); }
    expect(Number((await db.su.query(`select count(*) n from public.notification_jobs where driver_id = $1`, [d.driver])).rows[0].n)).toBe(0);
  });
});

describe('jornada diaria: el worker purga los mensajes de cobranza de días anteriores (una vez por día local)', () => {
  it('elimina los terminados de ayer, conserva pendientes/en proceso/sin confirmar y de hoy; no repite el mismo día', async () => {
    const d = await seedDriver(db, '1');
    const put = async (status: string, daysAgo: number) => (await db.su.query(`insert into public.whatsapp_test_messages(kind, recipient_phone, body, requested_mode, authorized_by, idempotency_key, driver_id, assignment_id, template_name, status, created_at)
      values ('collection_message', '+50760001234', 'x', 'auto', $1, $2, $3, $4, 'P', $5, now() - make_interval(days => $6)) returning id`, [db.admin, `wp-${Math.random()}`, d.driver, d.assignment, status, daysAgo])).rows[0].id as string;
    const old = [await put('sent', 2), await put('failed', 3)]; const keep = [await put('prepared', 2), await put('unconfirmed', 5), await put('sent', 0)];
    const { proc } = makeProcessor(db, { automaticReminders: false });
    await proc.tick();
    expect((await db.su.query(`select id from public.whatsapp_test_messages where id = any($1::uuid[])`, [old])).rowCount).toBe(0);
    expect((await db.su.query(`select id from public.whatsapp_test_messages where id = any($1::uuid[])`, [keep])).rowCount).toBe(3);
    await db.su.query(`update public.whatsapp_test_messages set created_at = created_at - interval '3 days' where id = $1`, [keep[2]]);
    await proc.tick();                                                                       // mismo día local: no vuelve a ejecutarse
    expect((await db.su.query(`select id from public.whatsapp_test_messages where id = $1`, [keep[2]])).rowCount).toBe(1);
  });
});

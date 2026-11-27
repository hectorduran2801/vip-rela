import { Db as WorkerDb } from '../../src/db.js';
import { DryRunAdapter } from '../../src/adapters/dry-run.js';
import { FakeAdapter } from '../../src/adapters/fake.js';
import { QueueProcessor, type ProcessorOptions } from '../../src/queue/processor.js';
import { RateLimiter } from '../../src/queue/rate-limiter.js';
import { silentLogger } from '../../src/log.js';
import type { Db } from './harness.js';

// 2026-11-16 es lunes. Panamá = UTC-5 (sin horario de verano).
export const at = (hhmmPanama: string, day = '2026-11-16') => new Date(`${day}T${hhmmPanama}:00-05:00`);

/** Conductor con unidad y asignación; por defecto con teléfono, consentimiento y una cuota diaria de $36 el 2026-11-16. */
export async function seedDriver(db: Db, code: string, o: { phone?: string | null; consent?: boolean; chargeCents?: number | null } = {}) {
  const d = await db.driverWithAssignment({
    code, unit: `U-${code}`, phone: o.phone === undefined ? `+5076000${code.padStart(4, '0')}` : o.phone ?? undefined, consent: o.consent ?? true,
  });
  const cents = o.chargeCents === undefined ? 3600 : o.chargeCents;
  if (cents) {
    await db.su.query(
      `insert into public.charges(assignment_id, kind, charge_date, amount_cents, week_start) values ($1,'daily','2026-11-16',$2,'2026-11-16')`,
      [d.assignment, cents]);
  }
  return d;
}

/** Desde 0024 un horario activo exige plantilla: se asigna el «texto base» (cuerpos de app_private.default_template_body) como plantilla real. */
export async function enableSchedules(db: Db): Promise<void> {
  await db.su.query(`insert into public.message_templates(name, body)
    select 'base-' || k, app_private.default_template_body(k) from unnest(array['debt_first','debt_update','debt_last','weekly_summary']) k on conflict (account_id, name) do nothing`);
  await db.su.query(`update public.notification_schedules set enabled = true, template_id = (select id from public.message_templates where name = 'base-' || notification_schedules.kind)`);
}

/** Registra un pago en efectivo como la administradora autorizada. */
export const pay = (db: Db, assignment: string, gross: number, key: string, receipt = false) =>
  db.as(db.admin, (q) => q.one(`select public.register_payment($1,'cash',$2,$3,null,null,$4) r`, [assignment, gross, key, receipt]));

export const jobs = async (db: Db, where = 'true') =>
  (await db.su.query(`select * from public.notification_jobs where ${where} order by created_at, id`)).rows;

export function makeProcessor(db: Db, o: { real?: FakeAdapter; senderFor?: ProcessorOptions['senders']['senderFor']; clock?: Date } & Partial<Omit<ProcessorOptions, 'clock'>> = {}) {
  const workerDb = new WorkerDb(db.connection, 4);
  const dry = new DryRunAdapter();
  const { real, senderFor, clock, ...rest } = o;
  const senders = { senderFor: senderFor ?? (() => real ?? null), anyConnected: () => !!real || !!senderFor };
  const proc = new QueueProcessor({
    // las pruebas de la cola ejercitan el camino automático; la prueba del interruptor pasa automaticReminders:false
    db: workerDb, log: silentLogger(), dryRun: true, automaticReminders: true, dryRunAdapter: dry, senders,
    rateLimiter: new RateLimiter(60_000, 0), sleep: async () => undefined, clock: clock ? () => clock : undefined,
    ...rest,
  });
  return { proc, workerDb, dry };
}

export async function realFake() { const f = new FakeAdapter(); f.forceConnected(); return f; }

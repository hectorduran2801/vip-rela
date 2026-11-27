import type { Db, Q } from './harness.js';

export const MON = '2026-03-02'; // lunes (pasado: los pagos no pueden fecharse en el futuro)
export const MON2 = '2026-03-09';
export const SUN = '2026-03-08';

export const addDays = (d: string, n: number): string => {
  const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10);
};

/** Genera las cuotas lun–sáb de una semana como la administradora (domingo incluido: debe crear 0). */
export async function chargeWeek(db: Db, monday: string): Promise<number> {
  let total = 0;
  for (let i = 0; i < 7; i++) {
    total += await db.as(db.admin, async (q) => (await q.one(`select public.generate_daily_charges($1::date) n`, [addDays(monday, i)])).n);
  }
  return total;
}

let seq = 0;
export const key = (p = 'k') => `${p}-${++seq}-${Math.random().toString(36).slice(2, 8)}`;

export function pay(q: Q, assignment: string, method: string, grossCents: number,
  opts: { key?: string; reference?: string | null; paidAt?: string | null; receipt?: boolean; notes?: string | null } = {}) {
  return q.one(`select public.register_payment($1,$2,$3,$4,$5,$6,$7,$8) r`,
    [assignment, method, grossCents, opts.key ?? key(), opts.reference ?? null, opts.paidAt ?? null, opts.receipt ?? false, opts.notes ?? null]).then((x) => x.r);
}

export const position = (q: Q, assignment: string) =>
  q.one(`select charged_cents::int, gross_cents::int, commission_cents::int, net_cents::int, pending_cents::int, credit_cents::int, balance_cents::int
         from public.assignment_position($1)`, [assignment]);

/**
 * Plantillas «texto base» (una por tipo, nombre `base-<tipo>`) para que las pruebas puedan ACTIVAR horarios: desde 0024 un horario activo
 * exige plantilla. Cuerpos = app_private.default_template_body (el texto que antes estaba fijo en el código). Idempotente.
 */
export const BASE_TPL = `(select id from public.message_templates where name = 'base-' || notification_schedules.kind)`;
export async function ensureBaseTemplates(db: Db): Promise<void> {
  await db.su.query(`insert into public.message_templates(name, body)
    select 'base-' || k, app_private.default_template_body(k) from unnest(array['debt_first','debt_update','debt_last','weekly_summary']) k
    on conflict (account_id, name) do nothing`);
}

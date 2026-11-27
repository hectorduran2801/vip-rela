import * as X from '@vip/excel-export';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireStaff } from '../plugins/auth.js';

const uuid = z.string().uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const send = (reply: FastifyReply, name: string, buf: Buffer) =>
  reply.header('content-type', XLSX).header('content-disposition', `attachment; filename="${name}"`).header('cache-control', 'no-store').send(buf);

const PAYMENTS_SQL = `select to_char(p.paid_at at time zone o.timezone, 'YYYY-MM-DD HH24:MI') paid_at, u.code unit_code, d.operator_code,
    btrim(d.first_name || ' ' || d.last_name) full_name, m.label method_label, p.gross_cents::int gross_cents, p.commission_cents::int commission_cents,
    p.net_cents::int net_cents, p.applied_cents::int applied_cents, p.credit_generated_cents::int credit_generated_cents, p.reference,
    pr.full_name registered_by, p.voided_at is not null voided, p.void_reason
  from public.payments p join public.assignments a on a.id = p.assignment_id join public.drivers d on d.id = a.driver_id
  join public.units u on u.id = a.unit_id join public.payment_methods m on m.id = p.method_id cross join (select timezone from public.app_settings) o
  left join public.profiles pr on pr.id = p.registered_by
  where (p.paid_at at time zone o.timezone)::date between $1::date and $2::date order by p.paid_at`;

/** Mismo saldo que Cobranza: para unidades gestionadas por el Excel, pendiente/crédito salen del último SALDO válido importado (sin saldo = 0 pendiente y 0 crédito); el resto, el cálculo anterior. */
const excelBalance = <T extends Record<string, any>>(r: T): T => {
  if (!r.saldo_managed) return r;
  const v = r.saldo_excel_cents === null || r.saldo_excel_cents === undefined ? 0 : Number(r.saldo_excel_cents);
  return { ...r, pending_cents: Math.max(v, 0), credit_cents: Math.max(-v, 0) } as T;
};

export const exportRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireStaff);
  const bad = (reply: FastifyReply) => reply.code(400).send({ error: 'invalid_body' });

  app.get('/exports/weekly.xlsx', async (req, reply) => {
    const q = z.object({ weekStart: date }).safeParse(req.query);
    if (!q.success) return bad(reply);
    const { rows, org } = await req.db(async (tx) => ({
      rows: (await tx.rows(`select w.*, e.managed saldo_managed, e.saldo_cents saldo_excel_cents from public.weekly_collection_table($1::date) w cross join lateral app_private.excel_saldo(w.assignment_id) e`, [q.data.weekStart]))
        .map((r) => excelBalance(r)),
      org: (await tx.one(`select business_name from public.app_settings`))?.business_name as string | undefined }));
    return send(reply, `vip-cobranza-semanal-${q.data.weekStart}.xlsx`, await X.exportWeeklyTable(rows, { weekStart: q.data.weekStart, organizationName: org }));
  });

  app.get('/exports/day.xlsx', async (req, reply) => {
    const q = z.object({ date }).safeParse(req.query);
    if (!q.success) return bad(reply);
    const rows = await req.db((tx) => tx.rows(PAYMENTS_SQL, [q.data.date, q.data.date]));
    return send(reply, `vip-cobranza-dia-${q.data.date}.xlsx`, await X.exportDayCollection(rows, { date: q.data.date }));
  });

  app.get('/exports/payments.xlsx', async (req, reply) => {
    const q = z.object({ from: date, to: date }).safeParse(req.query);
    if (!q.success) return bad(reply);
    const rows = await req.db((tx) => tx.rows(PAYMENTS_SQL, [q.data.from, q.data.to]));
    return send(reply, `vip-historial-pagos-${q.data.from}_${q.data.to}.xlsx`, await X.exportPaymentHistory(rows, q.data));
  });

  app.get('/exports/payments-by-method.xlsx', async (req, reply) => {
    const q = z.object({ from: date, to: date }).safeParse(req.query);
    if (!q.success) return bad(reply);
    const rows = await req.db((tx) => tx.rows(`select m.label method_label, count(p.id)::int payments, coalesce(sum(p.gross_cents),0)::int gross_cents,
        coalesce(sum(p.commission_cents),0)::int commission_cents, coalesce(sum(p.net_cents),0)::int net_cents
      from public.payment_methods m cross join (select timezone from public.app_settings) o
      left join public.payments p on p.method_id = m.id and p.voided_at is null and (p.paid_at at time zone o.timezone)::date between $1::date and $2::date
      group by m.label order by m.label`, [q.data.from, q.data.to]));
    return send(reply, `vip-pagos-por-metodo-${q.data.from}_${q.data.to}.xlsx`, await X.exportPaymentsByMethod(rows, q.data));
  });

  const balances = (kind: 'pending' | 'credits') => async (req: FastifyRequest, reply: FastifyReply) => {
    const q = z.object({}).safeParse(req.query);
    if (!q.success) return bad(reply);
    const rows = (await req.db((tx) => tx.rows(`select u.code unit_code, d.operator_code, d.national_id, btrim(d.first_name || ' ' || d.last_name) full_name,
        d.status driver_status, pos.pending_cents::int pending_cents, pos.credit_cents::int credit_cents, d.phone_e164 phone, e.managed saldo_managed, e.saldo_cents saldo_excel_cents
      from public.v_assignment_position pos join public.drivers d on d.id = pos.driver_id join public.units u on u.id = pos.unit_id
      cross join lateral app_private.excel_saldo(pos.assignment_id) e`)))
      .map((r) => excelBalance(r))
      .sort((a, b) => (kind === 'pending' ? Number(b.pending_cents) - Number(a.pending_cents) : Number(b.credit_cents) - Number(a.credit_cents)) || String(a.unit_code).localeCompare(String(b.unit_code)));
    const asOf = new Date().toISOString().slice(0, 10);
    return send(reply, `vip-${kind === 'pending' ? 'deudas-pendientes' : 'creditos-a-favor'}-${asOf}.xlsx`,
      await (kind === 'pending' ? X.exportPendingDebts : X.exportCredits)(rows, { asOf }));
  };
  app.get('/exports/pending.xlsx', balances('pending'));
  app.get('/exports/credits.xlsx', balances('credits'));

  app.get('/exports/directory.xlsx', async (req, reply) => {
    const q = z.object({}).safeParse(req.query);
    if (!q.success) return bad(reply);
    const rows = await req.db((tx) => tx.rows(`select d.operator_code, d.national_id, btrim(d.first_name || ' ' || d.last_name) full_name, d.status, d.phone,
        d.phone_e164 whatsapp, d.license_number, d.license_expires_on::text license_expires_on, u.code unit_code, u.plate,
        (select r.daily_amount_cents from public.rates r where r.assignment_id = a.id and r.valid_to is null limit 1)::int daily_rate_cents
      from public.drivers d left join public.assignments a on a.driver_id = d.id and a.valid_to is null left join public.units u on u.id = a.unit_id
      order by d.operator_code`));
    return send(reply, 'vip-conductores-y-unidades.xlsx', await X.exportDirectory(rows));
  });

  app.get('/exports/drivers.xlsx', async (req, reply) => {
    const rows = await req.db((tx) => tx.rows(`select d.operator_code, d.national_id, d.first_name, d.last_name, d.status, d.phone, d.phone_e164, d.whatsapp_consent, d.reminders_paused,
        d.license_number, d.license_expires_on::text license_expires_on, d.notes, u.code unit_code, d.created_at::date::text created_at
      from public.drivers d left join public.assignments a on a.driver_id = d.id and a.valid_to is null left join public.units u on u.id = a.unit_id order by d.operator_code`));
    return send(reply, 'vip-conductores.xlsx', await X.exportDrivers(rows));
  });
  app.get('/exports/units.xlsx', async (req, reply) => {
    const rows = await req.db((tx) => tx.rows(`select u.code, u.plate, u.make, u.model, u.year, u.vehicle_status, u.notes, d.operator_code, btrim(d.first_name || ' ' || d.last_name) driver_name,
        u.agreement, u.agreement_note
      from public.units u
      left join public.assignments a on a.unit_id = u.id and a.valid_to is null left join public.drivers d on d.id = a.driver_id order by u.code`));
    return send(reply, 'vip-unidades.xlsx', await X.exportUnits(rows));
  });
  app.get('/exports/assignments.xlsx', async (req, reply) => {
    const rows = await req.db((tx) => tx.rows(`select u.code unit_code, d.operator_code, btrim(d.first_name || ' ' || d.last_name) driver_name, a.valid_from::text valid_from, a.valid_to::text valid_to,
        (select r.daily_amount_cents from public.rates r where r.assignment_id = a.id order by r.valid_from desc limit 1)::int daily_rate_cents, a.agreement_note
      from public.assignments a join public.units u on u.id = a.unit_id join public.drivers d on d.id = a.driver_id order by u.code, a.valid_from desc`));
    return send(reply, 'vip-asignaciones.xlsx', await X.exportAssignments(rows));
  });

  app.get('/exports/movements.xlsx', async (req, reply) => {
    const q = z.object({ assignmentId: uuid.optional(), from: date.optional(), to: date.optional() }).safeParse(req.query);
    if (!q.success) return bad(reply);
    const rows = await req.db((tx) => tx.rows(`select to_char(v.occurred_at at time zone o.timezone, 'YYYY-MM-DD HH24:MI') occurred_at, v.kind, v.detail, v.amount_cents::int amount_cents,
        v.commission_cents::int commission_cents, pr.full_name actor
      from public.v_movements v cross join (select timezone from public.app_settings) o left join public.profiles pr on pr.id = v.actor
      where ($1::uuid is null or v.assignment_id = $1)
        and ($2::date is null or (v.occurred_at at time zone o.timezone)::date >= $2) and ($3::date is null or (v.occurred_at at time zone o.timezone)::date <= $3)
      order by v.occurred_at`, [q.data.assignmentId ?? null, q.data.from ?? null, q.data.to ?? null]));
    return send(reply, 'vip-historial-movimientos.xlsx', await X.exportMovements(rows, { title: 'Historial de movimientos' }));
  });
};

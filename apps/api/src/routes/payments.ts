import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireAdmin, requireStaff } from '../plugins/auth.js';

const uuid = z.string().uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const reviewBody = z.object({ action: z.enum(['approve', 'edit', 'discard']), body: z.string().max(1000).nullish() });

export const paymentRoutes: FastifyPluginAsync = async (app) => {
  const bad = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }, issues?: unknown) => reply.code(400).send({ error: 'invalid_body', issues });

  app.get('/payment-methods', { preHandler: requireStaff }, async (req) =>
    req.db((tx) => tx.rows(`select id, code, label, commission_cents::int, active from public.payment_methods order by code`)));

  // Operaciones manuales que movían dinero fuera del Excel: deshabilitadas (pagos/cuota/saldo solo entran por apply_collection_sync).
  // La autenticación/rol se evalúa primero (preHandler): 401/403 se mantienen; las autorizadas reciben 410 sin tocar la base.
  const disabled = async (_req: unknown, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) => reply.code(410).send({ error: 'manual_payments_disabled' });
  app.post('/payments/preview', { preHandler: requireStaff }, disabled);
  app.post('/payments', { preHandler: requireStaff }, disabled);
  app.post('/payments/:id/void', { preHandler: requireAdmin }, disabled);
  app.post('/adjustments', { preHandler: requireAdmin }, disabled);
  app.post('/charges/generate', { preHandler: requireAdmin }, disabled);

  // Recuperación/generación idempotente de cuotas faltantes (motor de cobranza). through: último día (por defecto hoy en Panamá); from: inicio explícito
  // (solo días NO cerrados). Devuelve { created, from, to, days_checked, skipped, gaps[], gaps_total, recovery_days }.
  app.post('/charges/ensure', { preHandler: requireAdmin }, async (req, reply) => {
    const b = z.object({ through: date.nullish(), from: date.nullish() }).safeParse(req.body ?? {});
    if (!b.success) return bad(reply);
    return (await req.db((tx) => tx.one(`select public.ensure_daily_charges($1::date, $2::date) r`, [b.data.through ?? null, b.data.from ?? null])))!.r;
  });
  // Cuotas con importe previsto y sin cargo (fuera de la ventana de recuperación o en semanas cerradas) para revisión administrativa.
  app.get('/charges/gaps', { preHandler: requireAdmin }, async (req, reply) => {
    const q = z.object({ through: date.optional() }).safeParse(req.query);
    if (!q.success) return bad(reply);
    const rows = await req.db((tx) => tx.rows(`select assignment_id, unit_code, operator_code, driver_name, gap_date::text, planned_cents, reason from public.charge_gaps($1::date)`, [q.data.through ?? null]));
    return rows.map((r) => ({ ...r, planned_cents: Number(r.planned_cents) }));
  });

  app.post('/weeks/close', { preHandler: requireAdmin }, disabled);

  app.post<{ Params: { id: string } }>('/notifications/:id/review', { preHandler: requireAdmin }, async (req, reply) => {
    const id = uuid.safeParse(req.params.id); const b = reviewBody.safeParse(req.body);
    if (!id.success || !b.success) return bad(reply);
    return (await req.db((tx) => tx.one(`select public.review_notification($1,$2,$3) r`, [id.data, b.data.action, b.data.body ?? null])))!.r;
  });
};

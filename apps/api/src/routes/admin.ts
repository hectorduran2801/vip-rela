import type { FastifyPluginAsync } from 'fastify';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { requireAdmin, requireStaff, requireSuper, requireUser, resetRoleCache } from '../plugins/auth.js';
import { ACTIVE_TOTALS_SQL, FORMER_DEBTS_SQL } from '../debt.js';

const uuid = z.string().uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const cents = z.number().int().min(0).max(100_000_000);

export const adminRoutes: FastifyPluginAsync = async (app) => {
  const bad = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }) => reply.code(400).send({ error: 'invalid_body' });

  // ¿La cuenta autenticada es la administradora autorizada? (la decide la base de datos)
  app.get('/me', { preHandler: requireUser }, async (req) => {
    const role = await req.db(async (tx) => (await tx.one(`select public.current_app_role() r`))!.r as string | null);
    return { userId: req.user!.id, email: req.user!.email ?? null, authorized: role !== null, role };
  });

  // Cuentas (datos separados): el SUPER_ADMIN puede consultar otra en solo lectura.
  app.get('/accounts', { preHandler: requireSuper }, async (req) => (await req.db((tx) => tx.rows(`select id, name, own, viewing, drivers from public.list_accounts()`))));
  app.put('/account-view', { preHandler: requireSuper }, async (req, reply) => {
    const b = z.object({ accountId: uuid.nullable() }).safeParse(req.body);
    if (!b.success) return bad(reply);
    await req.db((tx) => tx.rows(`select public.set_account_view($1)`, [b.data.accountId]));
    return reply.code(204).send();
  });

  // Nombre que la cuenta muestra junto al logo (solo el propio).
  app.get('/me/profile', { preHandler: requireStaff }, async (req) => ({ fullName: (await req.db((tx) => tx.one(`select public.get_my_display_name() n`)))!.n }));
  app.put('/me/profile', { preHandler: requireStaff }, async (req, reply) => {
    const b = z.object({ fullName: z.string().max(60) }).safeParse(req.body);
    if (!b.success) return bad(reply);
    return { fullName: (await req.db((tx) => tx.one(`select public.set_my_display_name($1) n`, [b.data.fullName])))!.n };
  });

  app.get('/dashboard', { preHandler: requireStaff }, async (req) => req.db(async (tx) => {
    const s = (await tx.one(`select public.dashboard_summary() s`))!.s as { collections: Record<string, number> };
    const t = (await tx.one(ACTIVE_TOTALS_SQL))!;
    return { ...s, collections: { ...s.collections, pending_total_cents: Number(t.pending), credits_total_cents: Number(t.credit), drivers_with_debt: Number(t.debtors) } };
  }));
  app.get('/former-debts', { preHandler: requireStaff }, async (req) => (await req.db((tx) => tx.rows(FORMER_DEBTS_SQL))).map((r) => ({
    assignmentId: r.assignment_id, driverId: r.driver_id, unitCode: r.unit_code, operatorCode: r.operator_code, fullName: r.full_name, endedOn: r.ended_on, pendingCents: Number(r.pending) })));

  app.get('/weekly-collection', { preHandler: requireStaff }, async (req, reply) => {
    const q = z.object({ weekStart: date }).safeParse(req.query);
    if (!q.success) return bad(reply);
    const rows = await req.db((tx) => tx.rows(`select * from public.weekly_collection_table($1::date)`, [q.data.weekStart]));
    return rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) =>
      [k, k === 'day_net_cents' ? (v as string[]).map(Number) : k.endsWith('_cents') || k === 'missing_days' ? Number(v) : v])));
  });

  // Detalle por día (lunes a domingo) de cada conductor de la semana: cuota, abonado, pendiente y estado + saldo anterior.
  app.get('/weekly-collection/detail', { preHandler: requireStaff }, async (req, reply) => {
    const q = z.object({ weekStart: date, assignmentId: uuid.optional() }).safeParse(req.query);
    if (!q.success) return bad(reply);
    try {
      const rows = await req.db((tx) => tx.rows(`select * from public.weekly_collection_detail($1::date, $2)`, [q.data.weekStart, q.data.assignmentId ?? null]));
      return rows.map((r) => ({
        assignment_id: r.assignment_id as string,
        previous_pending_cents: Number(r.previous_pending_cents),
        previous_credit_cents: Number(r.previous_credit_cents),
        days: (r.days as Array<Record<string, unknown>> | null ?? []).map((d) => ({
          date: d.date as string, weekday: Number(d.weekday), status: d.status as string,
          charge_cents: Number(d.charge_cents), net_paid_cents: Number(d.net_paid_cents), remaining_cents: Number(d.remaining_cents),
          planned_cents: Number(d.planned_cents ?? 0), charge_generated: Boolean(d.charge_generated),
        })),
      }));
    } catch (e) {
      if ((e as { message?: string }).message?.includes('week_start_must_be_monday')) return reply.code(400).send({ error: 'week_start_must_be_monday' });
      throw e;
    }
  });

  // ───── Consentimiento de WhatsApp (cobranza y promocional son independientes; siempre con origen) ─────
  const purpose = z.enum(['collection', 'promotional']);
  app.put('/drivers/:id/consent', { preHandler: requireAdmin }, async (req, reply) => {
    const p = z.object({ id: uuid }).safeParse(req.params);
    const b = z.object({ purpose, granted: z.boolean(), source: z.enum(['verbal_admin', 'driver_message', 'signed_form', 'import_declaration', 'other']).optional(),
      evidence: z.string().trim().max(500).optional() }).safeParse(req.body);
    if (!p.success || !b.success) return bad(reply);
    return (await req.db((tx) => tx.one(`select public.set_driver_consent($1,$2,$3,$4,$5) r`, [p.data.id, b.data.purpose, b.data.granted, b.data.source ?? null, b.data.evidence ?? null])))!.r;
  });
  app.get('/drivers/:id/consents', { preHandler: requireStaff }, async (req, reply) => {
    const p = z.object({ id: uuid }).safeParse(req.params); if (!p.success) return bad(reply);
    return req.db((tx) => tx.rows(`select id, purpose, granted, source, evidence, recorded_by, recorded_at from public.driver_consents where driver_id = $1 order by recorded_at desc, id`, [p.data.id]));
  });

  // ───── Eliminar o dar de baja conductores y unidades ─────
  // Eliminar solo sin historial financiero real (la base lo decide); con historial → 409 delete_blocked_has_history y se ofrece archivar (baja reversible).
  const reasonZ = z.string().trim().max(500).optional();
  const reasonOf = (req: { body?: unknown; query?: unknown }) => {
    const b = z.object({ reason: reasonZ }).passthrough().safeParse(req.body ?? {});
    const q = z.object({ reason: reasonZ }).passthrough().safeParse(req.query ?? {});
    return b.success && q.success ? { reason: b.data.reason ?? q.data.reason ?? null } : null;
  };
  const kinds = [
    { path: 'drivers', check: 'driver_delete_check', del: 'delete_driver', archive: 'archive_driver', reactivate: 'reactivate_driver' },
    { path: 'units', check: 'unit_delete_check', del: 'delete_unit', archive: 'archive_unit', reactivate: 'reactivate_unit' },
  ] as const;
  for (const k of kinds) {
    app.get(`/${k.path}/:id/delete-check`, { preHandler: requireAdmin }, async (req, reply) => {
      const p = z.object({ id: uuid }).safeParse(req.params); if (!p.success) return bad(reply);
      return (await req.db((tx) => tx.one(`select public.${k.check}($1) r`, [p.data.id])))!.r;
    });
    app.delete(`/${k.path}/:id`, { preHandler: requireAdmin }, async (req, reply) => {
      const p = z.object({ id: uuid }).safeParse(req.params); const r = reasonOf(req); if (!p.success || !r) return bad(reply);
      try { return (await req.db((tx) => tx.one(`select public.${k.del}($1,$2) r`, [p.data.id, r.reason])))!.r; }
      catch (e) {
        if ((e as { message?: string }).message === 'delete_blocked_has_history') {
          let blockers: Record<string, number> = {};
          try { blockers = JSON.parse((e as { detail?: string }).detail ?? '{}'); } catch { /* sin detalle */ }
          return reply.code(409).send({ error: 'delete_blocked_has_history', blockers,
            blocked_by: Object.entries(blockers).filter(([n, v]) => n !== 'opening_charges' && Number(v) > 0).map(([n]) => n).sort(), suggestion: 'archive' });
        }
        throw e;
      }
    });
    app.post(`/${k.path}/:id/archive`, { preHandler: requireAdmin }, async (req, reply) => {
      const p = z.object({ id: uuid }).safeParse(req.params);
      const b = z.object({ reason: reasonZ, effectiveDate: date.optional() }).safeParse(req.body ?? {});
      if (!p.success || !b.success) return bad(reply);
      return (await req.db((tx) => tx.one(`select public.${k.archive}($1,$2,$3::date) r`, [p.data.id, b.data.reason ?? null, b.data.effectiveDate ?? null])))!.r;
    });
    app.post(`/${k.path}/:id/reactivate`, { preHandler: requireAdmin }, async (req, reply) => {
      const p = z.object({ id: uuid }).safeParse(req.params); const b = z.object({ reason: reasonZ }).safeParse(req.body ?? {});
      if (!p.success || !b.success) return bad(reply);
      return (await req.db((tx) => tx.one(`select public.${k.reactivate}($1,$2) r`, [p.data.id, b.data.reason ?? null])))!.r;
    });
  }

  // ───── Informes por período ─────
  app.get('/reports/period', { preHandler: requireStaff }, async (req, reply) => {
    const q = z.object({ from: date, to: date }).safeParse(req.query);
    if (!q.success) return bad(reply);
    return (await req.db((tx) => tx.one(`select public.period_summary($1::date,$2::date) s`, [q.data.from, q.data.to])))!.s;
  });
  app.get('/reports/period/detail', { preHandler: requireStaff }, async (req, reply) => {
    const q = z.object({ from: date, to: date, indicator: z.enum(['charges', 'gross', 'commission', 'net', 'applied', 'credits_generated', 'prior_debt_recovered', 'pending', 'credits']) }).safeParse(req.query);
    if (!q.success) return bad(reply);
    const rows = await req.db((tx) => tx.rows(`select occurred_on::text, kind, unit_code, operator_code, full_name, amount_cents, detail from public.period_detail($1::date,$2::date,$3)`, [q.data.from, q.data.to, q.data.indicator]));
    return rows.map((r) => ({ ...r, amount_cents: Number(r.amount_cents) }));
  });
  app.get('/reports/series', { preHandler: requireStaff }, async (req, reply) => {
    const q = z.object({ from: date, to: date }).safeParse(req.query);
    if (!q.success) return bad(reply);
    const rows = await req.db((tx) => tx.rows(`select week_start::text, expected_cents, gross_cents, commission_cents, net_cents, pending_end_cents, credits_end_cents, difference_cents, recovery_pct from public.period_series($1::date,$2::date)`, [q.data.from, q.data.to]));
    return rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, k === 'week_start' ? v : v === null ? null : Number(v)])));
  });

  // ───── Plantillas: catálogo de variables y vista previa con datos reales ─────
  app.get('/templates/variables', { preHandler: requireStaff }, async (req) =>
    req.db((tx) => tx.rows(`select "group", code, label, description, example from public.template_variables()`)));
  // Editor de variables (solo ADMIN): nombre/descripción del catálogo y frases de {{detalle_deuda}}.
  app.get('/templates/variables/editor', { preHandler: requireAdmin }, async (req) =>
    req.db((tx) => tx.rows(`select "group", code, label, description, example, customized, default_label, default_description, default_example from public.template_variable_editor()`)));
  app.put('/templates/variables/:code', { preHandler: requireAdmin }, async (req, reply) => {
    const p = z.object({ code: z.string().regex(/^[a-z_]{2,40}$/) }).safeParse(req.params); const b = z.object({ label: z.string().trim().min(1).max(60), description: z.string().max(400).default(''), example: z.string().max(120).default('') }).safeParse(req.body);
    if (!p.success || !b.success) return bad(reply);
    await req.db((tx) => tx.rows(`select public.save_template_variable($1,$2,$3,$4)`, [p.data.code, b.data.label, b.data.description, b.data.example]));
    return reply.code(204).send();
  });
  app.delete('/templates/variables/:code', { preHandler: requireAdmin }, async (req, reply) => {
    const p = z.object({ code: z.string().regex(/^[a-z_]{2,40}$/) }).safeParse(req.params);
    if (!p.success) return bad(reply);
    await req.db((tx) => tx.rows(`select public.reset_template_variable($1)`, [p.data.code]));
    return reply.code(204).send();
  });
  app.get('/templates/texts', { preHandler: requireAdmin }, async (req) =>
    req.db((tx) => tx.rows(`select key, title, text, default_text, customized, example from public.list_template_texts()`)));
  app.put('/templates/texts/:key', { preHandler: requireAdmin }, async (req, reply) => {
    const p = z.object({ key: z.string().regex(/^[a-z_]{2,40}$/) }).safeParse(req.params); const b = z.object({ text: z.string().min(1).max(300) }).safeParse(req.body);
    if (!p.success || !b.success) return bad(reply);
    await req.db((tx) => tx.rows(`select public.save_template_text($1,$2)`, [p.data.key, b.data.text]));
    return reply.code(204).send();
  });
  app.delete('/templates/texts/:key', { preHandler: requireAdmin }, async (req, reply) => {
    const p = z.object({ key: z.string().regex(/^[a-z_]{2,40}$/) }).safeParse(req.params);
    if (!p.success) return bad(reply);
    await req.db((tx) => tx.rows(`select public.reset_template_text($1)`, [p.data.key]));
    return reply.code(204).send();
  });
  app.post('/templates/preview', { preHandler: requireStaff }, async (req, reply) => {
    const b = z.object({ assignmentId: uuid, body: z.string().min(1).max(1000), date: date.nullish() }).safeParse(req.body);
    if (!b.success) return bad(reply);
    const r = (await req.db((tx) => tx.one(`select public.preview_template($1,$2,$3::date) t`, [b.data.assignmentId, b.data.body, b.data.date ?? null])))!.t as { text: string; unresolved: string[] };
    return { text: r.text, unresolved: r.unresolved };
  });

  // ───── Horarios ↔ plantillas (la escritura de horarios va por Supabase/RLS; el guard de la base devuelve `template_required`) ─────
  // Texto base de cada tipo de recordatorio, para mostrarlo y convertirlo (a petición) en una plantilla real.
  app.get('/schedules/default-templates', { preHandler: requireStaff }, async (req) =>
    req.db((tx) => tx.rows(`select kind, suggested_name, body from public.schedule_default_templates()`)));
  // Vista previa de la plantilla ASIGNADA al horario con los datos de un conductor: MISMO resolvedor que el envío.
  app.get('/schedules/:id/preview', { preHandler: requireAdmin }, async (req, reply) => {
    const p = z.object({ id: uuid }).safeParse(req.params); const q = z.object({ assignmentId: uuid, date: date.optional() }).safeParse(req.query);
    if (!p.success || !q.success) return bad(reply);
    return (await req.db((tx) => tx.one(`select public.preview_schedule($1,$2,$3::date) r`, [p.data.id, q.data.assignmentId, q.data.date ?? null])))!.r;
  });
  // Activación EXPLÍCITA: crear/editar un horario nunca lo activa; la única vía es activate (confirm:true). Apagar: deactivate.
  app.get('/schedules/:id/activation-preview', { preHandler: requireAdmin }, async (req, reply) => {
    const p = z.object({ id: uuid }).safeParse(req.params);
    if (!p.success) return bad(reply);
    return (await req.db((tx) => tx.one(`select public.schedule_activation_preview($1) r`, [p.data.id])))!.r;
  });
  app.post('/schedules/:id/activate', { preHandler: requireAdmin }, async (req, reply) => {
    const p = z.object({ id: uuid }).safeParse(req.params); const b = z.object({ confirm: z.boolean() }).safeParse(req.body ?? {});
    if (!p.success || !b.success) return bad(reply);
    return (await req.db((tx) => tx.one(`select public.activate_schedule($1,$2) r`, [p.data.id, b.data.confirm])))!.r;
  });
  app.post('/schedules/:id/deactivate', { preHandler: requireAdmin }, async (req, reply) => {
    const p = z.object({ id: uuid }).safeParse(req.params);
    if (!p.success) return bad(reply);
    return (await req.db((tx) => tx.one(`select public.deactivate_schedule($1) r`, [p.data.id])))!.r;
  });
  app.post('/templates/from-default', { preHandler: requireAdmin }, async (req, reply) => {
    const b = z.object({ kind: z.enum(['debt_first', 'debt_update', 'debt_last', 'weekly_summary']), name: z.string().trim().max(100).nullish(), scheduleId: uuid.nullish() }).safeParse(req.body);
    if (!b.success) return bad(reply);
    const r = (await req.db((tx) => tx.one(`select id, name, body, created_at from public.create_template_from_default($1,$2,$3)`, [b.data.kind, b.data.name ?? null, b.data.scheduleId ?? null])))!;
    return reply.code(201).send({ id: r.id, name: r.name, body: r.body, created_at: r.created_at });
  });
  // Horarios que usan una plantilla (para avisar antes de editar o borrar una plantilla compartida).
  app.get('/templates/:id/usage', { preHandler: requireAdmin }, async (req, reply) => {
    const p = z.object({ id: uuid }).safeParse(req.params);
    if (!p.success) return bad(reply);
    return req.db((tx) => tx.rows(`select id, kind, label, local_time, weekdays, enabled from public.template_usage($1)`, [p.data.id]));
  });

  // ───── Horarios de envío (0035): a la hora indicada, esta plantilla a esta audiencia. Solo ADMIN+; el worker los ejecuta si hay recordatorios automáticos. ─────
  const audience = z.enum(['all', 'with_balance', 'without_balance', 'not_paid_today', 'paid_today', 'selected']);
  const scheduleBody = z.object({
    name: z.string().trim().min(1).max(80), localTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7).transform((a) => [...new Set(a)].sort()),
    templateId: uuid.nullable(), audience, enabled: z.boolean(), assignmentIds: z.array(uuid).max(2000).default([]),
  });
  const scheduleRow = (r: Record<string, any>) => ({ id: r.id, name: r.name, local_time: String(r.local_time).slice(0, 5), weekdays: r.weekdays, template_id: r.template_id, template_name: r.template_name ?? null,
    audience: r.audience, enabled: r.enabled, last_run_date: r.last_run_date ?? null, last_run_status: r.last_run_status ?? null, last_run_created: r.last_run_created ?? null, last_run_total: r.last_run_total ?? null, assignment_ids: r.assignment_ids ?? [] });
  app.get('/send-schedules', { preHandler: requireAdmin }, async (req) => (await req.db((tx) => tx.rows(`select * from public.list_send_schedules()`))).map(scheduleRow));
  // Lista LIGERA para elegir conductores: una sola consulta, sin recalcular saldos ni leer pagos (el saldo es el último importado del Excel).
  app.get('/send-schedules/recipients', { preHandler: requireAdmin }, async (req) =>
    (await req.db((tx) => tx.rows(`select a.id assignment_id, u.code unit_code, d.operator_code, btrim(d.first_name || ' ' || coalesce(d.last_name, '')) full_name, d.phone_e164, e.saldo_cents
        from public.assignments a join public.drivers d on d.id = a.driver_id join public.units u on u.id = a.unit_id cross join lateral app_private.excel_saldo(a.id) e
       where d.status = 'active' and d.phone_e164 is not null and a.valid_from <= (now() at time zone app_private.tz())::date
         and (a.valid_to is null or a.valid_to > (now() at time zone app_private.tz())::date) order by u.code`)))
      .map((r) => ({ assignmentId: r.assignment_id, unitCode: r.unit_code, operatorCode: r.operator_code, fullName: r.full_name, phone: r.phone_e164, saldoCents: r.saldo_cents === null ? null : Number(r.saldo_cents) })));
  app.get('/send-schedules/audience-count', { preHandler: requireAdmin }, async (req, reply) => {
    const q = z.object({ audience }).safeParse(req.query);
    if (!q.success) return bad(reply);
    return { count: (await req.db((tx) => tx.one(`select public.send_schedule_audience_count($1) n`, [q.data.audience])))!.n };
  });
  app.post('/send-schedules', { preHandler: requireAdmin }, async (req, reply) => {
    const b = scheduleBody.safeParse(req.body);
    if (!b.success) return bad(reply);
    const r = (await req.db((tx) => tx.one(`select * from public.save_send_schedule(null,$1,$2::time,$3::smallint[],$4,$5,$6,$7::uuid[])`, [b.data.name, b.data.localTime, b.data.weekdays, b.data.templateId, b.data.audience, b.data.enabled, b.data.assignmentIds])))!;
    return reply.code(201).send(scheduleRow(r));
  });
  app.put('/send-schedules/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const p = z.object({ id: uuid }).safeParse(req.params); const b = scheduleBody.safeParse(req.body);
    if (!p.success || !b.success) return bad(reply);
    const r = (await req.db((tx) => tx.one(`select * from public.save_send_schedule($1,$2,$3::time,$4::smallint[],$5,$6,$7,$8::uuid[])`, [p.data.id, b.data.name, b.data.localTime, b.data.weekdays, b.data.templateId, b.data.audience, b.data.enabled, b.data.assignmentIds])))!;
    return scheduleRow(r);
  });
  app.delete('/send-schedules/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const p = z.object({ id: uuid }).safeParse(req.params);
    if (!p.success) return bad(reply);
    await req.db((tx) => tx.one(`select public.delete_send_schedule($1) r`, [p.data.id]));
    return reply.code(204).send();
  });

  // ───── Usuarios internos y roles (solo SUPER_ADMIN). Los conductores NO son usuarios: nunca se crean cuentas de Auth. ─────
  const roleEnum = z.enum(['super_admin', 'admin'])   // «supervisor» fue retirado: ya no se asigna;
  app.get('/users', { preHandler: requireSuper }, async (req) =>
    req.db((tx) => tx.rows(`select user_id, email, full_name, role, created_at, suspended_at from public.list_app_users()`)));
  app.put('/users', { preHandler: requireSuper }, async (req, reply) => {
    const b = z.object({ email: z.string().email().max(200), role: roleEnum }).safeParse(req.body);
    if (!b.success) return bad(reply);
    const r = await req.db((tx) => tx.one(`select public.set_app_user($1,$2) r`, [b.data.email, b.data.role]));
    resetRoleCache();
    return r!.r;
  });
  app.delete<{ Params: { userId: string } }>('/users/:userId', { preHandler: requireSuper }, async (req, reply) => {
    const id = uuid.safeParse(req.params.userId);
    if (!id.success) return bad(reply);
    await req.db((tx) => tx.one(`select public.remove_app_user($1) x`, [id.data]));
    resetRoleCache();
    return reply.code(204).send();
  });

  // ───── Alta de usuarios internos desde VIP (identidad en Auth + autorización + rol, sin tocar PostgreSQL a mano) ─────
  const emailZ = z.string().trim().toLowerCase().email().max(200);
  // Invitar: autoriza ESTE correo (y solo este) durante un tiempo limitado; al crearse la cuenta en Auth recibe el rol. Si la identidad ya existe, se autoriza al instante.
  app.post('/users/invite', { preHandler: requireSuper }, async (req, reply) => {
    const b = z.object({ email: emailZ, role: roleEnum, minutes: z.number().int().min(5).max(1440).optional() }).safeParse(req.body);
    if (!b.success) return bad(reply);
    const r = await req.db((tx) => tx.one(`select public.invite_app_user($1,$2,$3) r`, [b.data.email, b.data.role, b.data.minutes ?? 120]));
    resetRoleCache();
    return reply.code(201).send(r!.r);
  });
  app.get('/users/invites', { preHandler: requireSuper }, async (req) =>
    req.db((tx) => tx.rows(`select email, role, created_at, expires_at, consumed_at from public.list_user_invites()`)));
  app.post('/users/invites/cancel', { preHandler: requireSuper }, async (req, reply) => {
    const b = z.object({ email: emailZ }).safeParse(req.body); if (!b.success) return bad(reply);
    await req.db((tx) => tx.one(`select public.cancel_user_invite($1) x`, [b.data.email]));
    return reply.code(204).send();
  });
  // Crear la cuenta completa desde VIP: invitación + identidad en Auth con una contraseña TEMPORAL generada aquí (o la indicada).
  // La persona deberá cambiarla al entrar (`must_change_password`). Con clave de servicio se usa la Admin API; sin ella, el alta se hace
  // directamente en la base (el disparador de invitaciones sigue exigiendo que el correo esté invitado por un SUPER_ADMIN).
  const generatePassword = () => { const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'; const b = randomBytes(16); return Array.from(b, (x) => abc[x % abc.length]).join(''); };
  app.post('/users/create', { preHandler: requireSuper }, async (req, reply) => {
    const b = z.object({ email: emailZ, role: roleEnum, password: z.string().min(12).max(72).optional(), fullName: z.string().trim().max(120).optional() }).safeParse(req.body);
    if (!b.success) return bad(reply);
    const { SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: key } = app.config;
    const owner = app.ownerDb?.asOwner;
    if (!(url && key) && !owner) return reply.code(501).send({ error: 'service_role_not_configured' });
    const password = b.data.password ?? generatePassword();
    const invited = (await req.db((tx) => tx.one(`select public.invite_app_user($1,$2,10) r`, [b.data.email, b.data.role])))!.r as { mode: string };
    if (invited.mode === 'assigned') { resetRoleCache(); return reply.code(200).send({ ...invited, created: false }); }   // la identidad ya existía
    const cancel = () => req.db((tx) => tx.one(`select public.cancel_user_invite($1) x`, [b.data.email])).catch(() => undefined);
    if (url && key) {
      let res: Response;
      try {
        res = await app.httpFetch(`${url}/auth/v1/admin/users`, { method: 'POST', headers: { 'content-type': 'application/json', apikey: key, authorization: `Bearer ${key}` },
          body: JSON.stringify({ email: b.data.email, password, email_confirm: true, user_metadata: { full_name: b.data.fullName ?? '', must_change_password: true } }) });
      } catch (e) {
        req.log.error({ err: (e as Error).message }, 'auth admin api unreachable');
        return reply.code(502).send({ error: 'auth_unreachable' });
      }
      if (!res.ok) {
        req.log.error({ status: res.status }, 'auth admin api rejected user creation');           // sin cuerpo: puede contener datos del usuario
        await cancel();
        return reply.code(res.status === 422 ? 409 : 502).send({ error: res.status === 422 ? 'auth_user_exists' : 'auth_create_failed' });
      }
    } else {
      try {
        await owner!.call(app.ownerDb, async (tx) => {
          const u = (await tx.one<{ id: string }>(
            `insert into auth.users (instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at,confirmation_token,recovery_token,email_change_token_new,email_change)
             values ('00000000-0000-0000-0000-000000000000', gen_random_uuid(),'authenticated','authenticated',$1, extensions.crypt($2, extensions.gen_salt('bf')), now(),
               '{"provider":"email","providers":["email"]}'::jsonb, jsonb_build_object('full_name',$3::text,'must_change_password',true), now(), now(),'','','','') returning id`,
            [b.data.email, password, b.data.fullName ?? '']))!;
          await tx.one(`insert into auth.identities (provider_id,user_id,identity_data,provider,last_sign_in_at,created_at,updated_at)
             values ($1::text,$1::uuid,jsonb_build_object('sub',$1::text,'email',$2::text,'email_verified',true),'email',now(),now(),now()) returning 1`, [u.id, b.data.email]);
        });
      } catch (e) {
        req.log.error({ err: (e as Error).message, code: (e as { code?: string }).code }, 'direct auth user creation failed');
        await cancel();
        return reply.code((e as { code?: string }).code === '23505' ? 409 : 502).send({ error: (e as { code?: string }).code === '23505' ? 'auth_user_exists' : 'auth_create_failed' });
      }
    }
    resetRoleCache();
    return reply.code(201).send({ ...invited, mode: 'created', created: true, temporaryPassword: password });
  });
  // Restablecer credenciales: genera una contraseña temporal nueva (se muestra UNA vez), obliga a cambiarla al entrar y deja la auditoría. No sirve para la cuenta propia.
  app.post<{ Params: { userId: string } }>('/users/:userId/reset-credentials', { preHandler: requireSuper }, async (req, reply) => {
    const id = uuid.safeParse(req.params.userId);
    if (!id.success) return bad(reply);
    const { SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: key } = app.config;
    const owner = app.ownerDb?.asOwner;
    if (!(url && key) && !owner) return reply.code(501).send({ error: 'service_role_not_configured' });
    const who = (await req.db((tx) => tx.one(`select public.authorize_credentials_reset($1) r`, [id.data])))!.r as { email: string };
    const password = generatePassword();
    if (url && key) {
      let res: Response;
      try {
        res = await app.httpFetch(`${url}/auth/v1/admin/users/${id.data}`, { method: 'PUT', headers: { 'content-type': 'application/json', apikey: key, authorization: `Bearer ${key}` },
          body: JSON.stringify({ password, user_metadata: { must_change_password: true } }) });
      } catch (e) {
        req.log.error({ err: (e as Error).message }, 'auth admin api unreachable');
        return reply.code(502).send({ error: 'auth_unreachable' });
      }
      if (!res.ok) {
        req.log.error({ status: res.status }, 'auth admin api rejected credentials reset');            // sin cuerpo: puede contener datos del usuario
        return reply.code(res.status === 404 ? 404 : 502).send({ error: res.status === 404 ? 'user_not_found' : 'auth_reset_failed' });
      }
    } else {
      try {
        const n = await owner!.call(app.ownerDb, async (tx) => (await tx.rows(
          `update auth.users set encrypted_password = extensions.crypt($2, extensions.gen_salt('bf')), raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) || '{"must_change_password": true}'::jsonb, updated_at = now()
            where id = $1 returning 1`, [id.data, password])).length);
        if (!n) return reply.code(404).send({ error: 'user_not_found' });
      } catch (e) {
        req.log.error({ err: (e as Error).message }, 'direct credentials reset failed');
        return reply.code(502).send({ error: 'auth_reset_failed' });
      }
    }
    return { email: who.email, temporaryPassword: password };
  });
  app.post<{ Params: { userId: string } }>('/users/:userId/suspend', { preHandler: requireSuper }, async (req, reply) => {
    const id = uuid.safeParse(req.params.userId); const b = z.object({ suspended: z.boolean() }).safeParse(req.body);
    if (!id.success || !b.success) return bad(reply);
    const r = await req.db((tx) => tx.one(`select public.set_app_user_suspended($1,$2) r`, [id.data, b.data.suspended]));
    resetRoleCache();
    return r!.r;
  });
  // Ventana temporal para crear cuentas en Supabase Auth (cerrada por defecto; 0 = cerrar).
  app.post('/users/creation-window', { preHandler: requireSuper }, async (req, reply) => {
    const b = z.object({ minutes: z.number().int().min(0).max(60) }).safeParse(req.body);
    if (!b.success) return bad(reply);
    return { openUntil: (await req.db((tx) => tx.one(`select public.open_user_creation($1) v`, [b.data.minutes])))!.v };
  });

  // ───── Unidades, asignaciones y tarifas (atómicas) ─────
  app.post('/assignments/start', { preHandler: requireAdmin }, async (req, reply) => {
    const b = z.object({ driverId: uuid, unitId: uuid, validFrom: date, dailyCents: cents.nullish(), agreementNote: z.string().max(300).nullish() }).safeParse(req.body);
    if (!b.success) return bad(reply);
    const r = await req.db((tx) => tx.one(`select public.start_assignment($1,$2,$3::date,$4,$5) id`, [b.data.driverId, b.data.unitId, b.data.validFrom, b.data.dailyCents ?? null, b.data.agreementNote ?? null]));
    return reply.code(201).send({ assignmentId: r!.id });
  });
  app.post('/assignments/reassign', { preHandler: requireAdmin }, async (req, reply) => {
    const b = z.object({ unitId: uuid, newDriverId: uuid, validFrom: date, dailyCents: cents.nullish(), agreementNote: z.string().max(300).nullish() }).safeParse(req.body);
    if (!b.success) return bad(reply);
    const r = await req.db((tx) => tx.one(`select public.reassign_unit($1,$2,$3::date,$4,$5) id`, [b.data.unitId, b.data.newDriverId, b.data.validFrom, b.data.dailyCents ?? null, b.data.agreementNote ?? null]));
    return reply.code(201).send({ assignmentId: r!.id });
  });
  app.post<{ Params: { id: string } }>('/assignments/:id/end', { preHandler: requireAdmin }, async (req, reply) => {
    const id = uuid.safeParse(req.params.id); const b = z.object({ endDate: date }).safeParse(req.body);
    if (!id.success || !b.success) return bad(reply);
    await req.db((tx) => tx.one(`select public.end_assignment($1,$2::date) x`, [id.data, b.data.endDate]));
    return reply.code(204).send();
  });
  app.post<{ Params: { id: string } }>('/assignments/:id/rate', { preHandler: requireAdmin }, async (req, reply) => {
    const id = uuid.safeParse(req.params.id); const b = z.object({ dailyCents: cents, from: date, reason: z.string().trim().max(500).nullish() }).safeParse(req.body);
    if (!id.success || !b.success) return bad(reply);
    return (await req.db((tx) => tx.one(`select public.change_rate($1,$2,$3::date,$4) r`, [id.data, b.data.dailyCents, b.data.from, b.data.reason ?? null])))!.r;
  });

  // Historial de tarifas (ADMIN+): una fila por cambio, con tarifa anterior/nueva, vigencia, responsable, fecha/hora y motivo.
  const rateHistory = async (req: { db: <T>(fn: (tx: import('../db.js').Tx) => Promise<T>) => Promise<T> }, assignment: string | null) =>
    (await req.db((tx) => tx.rows(`select * from public.rate_history($1)`, [assignment]))).map((r) => ({
      ...r, previous_daily_cents: r.previous_daily_cents === null ? null : Number(r.previous_daily_cents), new_daily_cents: Number(r.new_daily_cents) }));
  app.get<{ Params: { id: string } }>('/assignments/:id/rate-history', { preHandler: requireAdmin }, async (req, reply) => {
    const id = uuid.safeParse(req.params.id); if (!id.success) return bad(reply);
    return rateHistory(req, id.data);
  });
  app.get('/rate-history', { preHandler: requireAdmin }, async (req) => rateHistory(req, null));
};

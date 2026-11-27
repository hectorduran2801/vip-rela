-- VIP · 0019 · Movimiento de APERTURA (deuda arrastrada del SALDO del Excel), conciliación previa y WhatsApp en el formato de bloques.
-- ADITIVA y NO destructiva: no modifica ni borra filas existentes (solo amplía un CHECK, añade columnas nulables, un índice parcial y redefine funciones).
--
-- REGLAS (confirmadas por el dueño):
--  · SALDO del Excel = DEUDA pendiente ARRASTRADA de la semana anterior (no es dinero pagado ni crédito). No se reinicia entre semanas.
--  · Una celda SALDO vacía NO es un cero confirmado: no se registra nada. Texto no numérico: se omite con aviso.
--  · El SALDO nunca sobrescribe un saldo calculado: entra como un cargo `opening` auditado, inmutable, previa conciliación (preview_opening_balances).
--  · `opening` cuenta como DEUDA y se cubre por FIFO (fecha = domingo anterior a la semana de apertura: es lo más antiguo), pero NO es
--    «cuota generada de la semana» ni cuota diaria: los informes lo muestran aparte («Deuda anterior / apertura»).
--  · Un solo `opening` por asignación (índice único parcial) → reimportar el mismo archivo/bloque/semana NO duplica deuda.
set search_path = public, extensions;

-- ───────── 1. Cargo `opening` ─────────
do $$
declare v_name text;
begin
  select c.conname into v_name from pg_constraint c
   where c.conrelid = 'public.charges'::regclass and c.contype = 'c' and pg_get_constraintdef(c.oid) like '%kind%daily%adjustment%';
  if v_name is null then raise exception 'No se encontró el CHECK de charges.kind'; end if;
  execute format('alter table public.charges drop constraint %I', v_name);
end $$;
alter table public.charges add constraint charges_kind_check check (kind in ('daily', 'adjustment', 'opening'));
-- La apertura siempre se fecha un DOMINGO (el domingo anterior a la semana a la que pertenece el SALDO).
alter table public.charges add constraint charges_opening_on_sunday check (kind <> 'opening' or extract(isodow from charge_date) = 7);
-- Procedencia (informativa; sin FK a propósito: los cargos son inmutables y el staging puede limpiarse).
alter table public.charges add column source_import_id uuid, add column source_row_id uuid;
create unique index charges_one_opening_per_assignment on public.charges(assignment_id) where kind = 'opening';

-- ───────── 2. WhatsApp en el formato de bloques ─────────
alter table public.import_rows add column raw_phone text;     -- celda original (phone_e164 ya existe: el valor normalizado)

-- ───────── 3. Movimientos y desglose: la apertura es deuda, no cuota del día ─────────
create or replace view public.v_movements with (security_invoker = true) as
select c.assignment_id, c.created_at as occurred_at, 'charge'::text as kind, c.id as ref_id, c.amount_cents, null::bigint as commission_cents, c.charge_date::text as detail, null::uuid as actor
  from public.charges c where c.kind = 'daily'
union all
select p.assignment_id, p.paid_at, 'payment', p.id, p.net_cents, p.commission_cents, case when p.voided_at is null then 'vigente' else 'anulado' end, p.registered_by from public.payments p
union all
select p.assignment_id, p.voided_at, 'payment_void', p.id, -p.net_cents, null, p.void_reason, p.voided_by from public.payments p where p.voided_at is not null
union all
select a.assignment_id, a.created_at, 'adjustment', a.id, a.amount_cents, null, a.reason, a.created_by from public.adjustments a
union all
select c.assignment_id, c.created_at, 'opening', c.id, c.amount_cents, null, 'Deuda anterior (apertura) al ' || c.charge_date::text, null::uuid from public.charges c where c.kind = 'opening';

-- La apertura siempre es «deuda anterior», nunca la cuota de hoy ni una cuota futura.
create or replace function public.assignment_dues(p_assignment uuid, p_date date)
returns table (today_cents bigint, overdue_cents bigint, future_cents bigint, total_pending_cents bigint, credit_cents bigint)
language sql stable security invoker set search_path = '' as $$
  with cov as (select kind, charge_date, remaining_cents from public.assignment_coverage(p_assignment))
  select coalesce(sum(remaining_cents) filter (where kind <> 'opening' and charge_date = p_date), 0)::bigint,
         coalesce(sum(remaining_cents) filter (where kind = 'opening' or charge_date < p_date), 0)::bigint,
         coalesce(sum(remaining_cents) filter (where kind <> 'opening' and charge_date > p_date), 0)::bigint,
         coalesce(sum(remaining_cents), 0)::bigint,
         (select pos.credit_cents from public.assignment_position(p_assignment) pos)
    from cov
$$;

-- ───────── 4. Funciones que sumaban «cuotas de la semana» (la apertura no cuenta) ─────────

-- close_week: CONSERVA deuda y crédito (posición al domingo, incluida la apertura); `charged_cents` = cuotas generadas de la semana (sin apertura).
-- Idempotente (on conflict do nothing): no duplica cierres. No bloquea pagos posteriores (el domingo y días siguientes se pueden seguir pagando).
create or replace function public.close_week(p_week_start date) returns int
language plpgsql security definer set search_path = '' as $$
declare v_n int;
begin
  perform app_private.assert_admin();
  if extract(isodow from p_week_start) <> 1 then raise exception 'week_start_must_be_monday' using errcode = '22023'; end if;
  insert into public.weekly_closures(assignment_id, week_start, charged_cents, gross_cents, commission_cents, net_cents, pending_cents, credit_cents, closed_by)
  select a.id, p_week_start,
         coalesce((select sum(c.amount_cents) from public.charges c where c.assignment_id = a.id and c.week_start = p_week_start and c.kind <> 'opening'), 0),
         coalesce((select sum(p.gross_cents) from public.payments p where p.assignment_id = a.id and p.week_start = p_week_start and p.voided_at is null), 0),
         coalesce((select sum(p.commission_cents) from public.payments p where p.assignment_id = a.id and p.week_start = p_week_start and p.voided_at is null), 0),
         coalesce((select sum(p.net_cents) from public.payments p where p.assignment_id = a.id and p.week_start = p_week_start and p.voided_at is null), 0),
         pos.pending_cents, pos.credit_cents, auth.uid()
    from public.assignments a cross join lateral public.assignment_position(a.id, p_week_start + 6) pos
   where a.valid_from <= p_week_start + 6 and (a.valid_to is null or a.valid_to >= p_week_start)
  on conflict (assignment_id, week_start) do nothing;
  get diagnostics v_n = row_count;
  perform app_private.audit('close_week', 'weekly_closures', null, jsonb_build_object('week_start', p_week_start, 'closed', v_n));
  return v_n;
end $$;

create or replace function app_private.template_vars(p_assignment uuid, p_date date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare a record; d record; u record; x record; v_detail text;
begin
  select * into a from public.assignments where id = p_assignment;
  select * into d from public.drivers where id = a.driver_id;
  select * into u from public.units where id = a.unit_id;
  select * into x from public.assignment_dues(p_assignment, p_date);
  v_detail := case
    when x.today_cents > 0 and x.overdue_cents > 0 then 'cuota de hoy ' || app_private.fmt_usd(x.today_cents) || ', deuda anterior ' || app_private.fmt_usd(x.overdue_cents) || ', total ' || app_private.fmt_usd(x.total_pending_cents)
    when x.today_cents > 0 then 'su cuota de hoy pendiente es de ' || app_private.fmt_usd(x.today_cents)
    when x.overdue_cents > 0 then 'su deuda anterior es de ' || app_private.fmt_usd(x.overdue_cents)
    when x.credit_cents > 0 then 'su cuenta está al día con saldo a favor de ' || app_private.fmt_usd(x.credit_cents)
    else 'su cuenta está al día' end;
  return jsonb_build_object('nombre', btrim(d.first_name || ' ' || d.last_name), 'unidad', u.code,
    'cuota_hoy', app_private.fmt_usd(x.today_cents), 'deuda_anterior', app_private.fmt_usd(x.overdue_cents),
    'saldo_total', app_private.fmt_usd(x.total_pending_cents), 'credito', app_private.fmt_usd(x.credit_cents),
    'fecha', to_char(p_date, 'DD/MM/YYYY'), 'detalle_deuda', v_detail,
    'cuenta_semana', app_private.fmt_usd((select coalesce(sum(c.amount_cents), 0)::bigint from public.charges c where c.assignment_id = p_assignment and c.week_start = app_private.week_start_of(p_date) and c.kind <> 'opening')),
    'pagos_semana', app_private.fmt_usd((select coalesce(sum(p.net_cents), 0)::bigint from public.payments p where p.assignment_id = p_assignment and p.voided_at is null and p.week_start = app_private.week_start_of(p_date))));
end $$;

create or replace function public.prepare_notification_send(p_job_id uuid, p_now timestamptz default now()) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare j record; d record; a record; u record; s record; st record; pay record; pm record; x record; pos record;
  v_body text; v_amount bigint; v_week date; v_charged bigint; v_tpl text; v_vars jsonb; v_sent_today int; v_last timestamptz; v_is_debt boolean;
begin
  select * into j from public.notification_jobs where id = p_job_id for update;
  if not found or j.status <> 'processing' then raise exception 'job_not_processing' using errcode = '22023'; end if;
  select * into d from public.drivers where id = j.driver_id;
  v_is_debt := j.kind in ('debt_reminder','debt_first','debt_update','debt_last');
  if d.status <> 'active' then
    update public.notification_jobs set status = 'cancelled', error = 'conductor no activo' where id = p_job_id;
    return jsonb_build_object('action', 'skip', 'reason', 'cancelled');
  end if;
  if not d.whatsapp_consent or d.phone_e164 is null then
    update public.notification_jobs set status = 'skipped_no_consent' where id = p_job_id;
    return jsonb_build_object('action', 'skip', 'reason', 'skipped_no_consent');
  end if;
  if d.reminders_paused and (v_is_debt or j.kind = 'weekly_summary') then
    update public.notification_jobs set status = 'skipped_paused' where id = p_job_id;
    return jsonb_build_object('action', 'skip', 'reason', 'skipped_paused');
  end if;
  select a2.* into a from public.assignments a2 where a2.driver_id = j.driver_id and a2.valid_from <= j.local_date
     and (a2.valid_to is null or a2.valid_to >= j.local_date) order by a2.valid_from desc limit 1;
  if not found then
    update public.notification_jobs set status = 'cancelled', error = 'sin asignación vigente' where id = p_job_id;
    return jsonb_build_object('action', 'skip', 'reason', 'cancelled');
  end if;
  perform 1 from public.assignments where id = a.id for share;       -- serializa con register_payment (FOR UPDATE)
  if exists (select 1 from public.notification_jobs o where o.driver_id = j.driver_id and o.id < j.id and o.status = 'processing') then
    return jsonb_build_object('action', 'defer', 'reason', 'otro_envio_en_curso');
  end if;
  select * into u from public.units where id = a.unit_id;
  select * into pos from public.assignment_position(a.id);
  select * into st from public.app_settings;
  select * into s from public.notification_schedules where id = j.schedule_id;

  if v_is_debt then
    select count(*), max(sent_at) into v_sent_today, v_last from public.notification_jobs
     where driver_id = j.driver_id and local_date = j.local_date and status = 'sent' and kind in ('debt_reminder','debt_first','debt_update','debt_last');
    if v_sent_today >= st.max_per_driver_per_day or (v_last is not null and v_last > p_now - make_interval(mins => st.min_minutes_between)) then
      update public.notification_jobs set status = 'skipped_frequency' where id = p_job_id;
      return jsonb_build_object('action', 'skip', 'reason', 'skipped_frequency');
    end if;
    select * into x from public.assignment_dues(a.id, j.local_date);
    v_amount := case coalesce(s.scope, 'total') when 'today' then x.today_cents when 'overdue' then x.overdue_cents else x.total_pending_cents end;
    if v_amount <= 0 then
      update public.notification_jobs set status = case when x.credit_cents > 0 then 'skipped_credit' else 'skipped_paid' end where id = p_job_id;
      return jsonb_build_object('action', 'skip', 'reason', case when x.credit_cents > 0 then 'skipped_credit' else 'skipped_paid' end);
    end if;
    v_vars := app_private.template_vars(a.id, j.local_date);
    select t.body into v_tpl from public.message_templates t where t.id = s.template_id;
    v_body := app_private.render_template(coalesce(v_tpl, case j.kind when 'debt_last' then 'Último recordatorio del día, unidad {{unidad}}: {{detalle_deuda}}.'
                                                                      else 'Estimado conductor, unidad {{unidad}}: {{detalle_deuda}}.' end), v_vars);
  elsif j.kind = 'weekly_summary' then
    v_week := app_private.week_start_of(j.local_date);
    select coalesce(sum(c.amount_cents), 0) into v_charged from public.charges c where c.assignment_id = a.id and c.week_start = v_week and c.kind <> 'opening';
    v_vars := app_private.template_vars(a.id, j.local_date) || jsonb_build_object('cuenta_semana', app_private.fmt_usd(v_charged::bigint),
      'pagos_semana', app_private.fmt_usd((select coalesce(sum(p.net_cents), 0)::bigint from public.payments p where p.assignment_id = a.id and p.week_start = v_week and p.voided_at is null)));
    select t.body into v_tpl from public.message_templates t where t.id = s.template_id;
    v_body := app_private.render_template(coalesce(v_tpl, E'Resumen semanal, unidad {{unidad}}:\nCuenta de la semana: {{cuenta_semana}}\nPagos aplicados: {{pagos_semana}}\n{{detalle_deuda}}.'), v_vars);
  elsif j.kind = 'payment_receipt' then
    select p.* into pay from public.payments p where p.id = j.payment_id;
    if pay.voided_at is not null then
      update public.notification_jobs set status = 'cancelled' where id = p_job_id;
      return jsonb_build_object('action', 'skip', 'reason', 'cancelled');
    end if;
    select * into pm from public.payment_methods where id = pay.method_id;
    v_body := E'Estimado conductor, hemos registrado su pago correctamente.\nUnidad: ' || u.code || E'\nMétodo: ' || pm.label
      || E'\nMonto entregado: ' || app_private.fmt_usd(pay.gross_cents)
      || case when pay.commission_cents > 0 then E'\nComisión del proveedor: ' || app_private.fmt_usd(pay.commission_cents) else '' end
      || E'\nAbono a su cuenta: ' || app_private.fmt_usd(pay.net_cents)
      || case when pos.pending_cents > 0 then E'\nSaldo pendiente: ' || app_private.fmt_usd(pos.pending_cents)
              when pos.credit_cents > 0 then E'\nSaldo a favor: ' || app_private.fmt_usd(pos.credit_cents) else E'\nSu cuenta está al día.' end || E'\nGracias por su pago.';
  elsif j.kind = 'credit_notice' then
    if j.approved_by is null then raise exception 'not_approved' using errcode = '42501'; end if;
    v_body := j.suggested_body;
  end if;
  return jsonb_build_object('action', 'send', 'phone', d.phone_e164, 'body', v_body, 'job_id', j.id);
end $$;

create or replace function public.dashboard_summary() returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare v_today date; v_week date; v_drivers jsonb; v_pos record; v_pay record; v_week_ch bigint; v_week_net bigint; v_methods jsonb; v_rem jsonb; v_wa jsonb;
begin
  perform app_private.assert_staff();
  v_today := (now() at time zone app_private.tz())::date; v_week := app_private.week_start_of(v_today);
  select jsonb_build_object('total', count(*), 'active', count(*) filter (where status = 'active'), 'inactive', count(*) filter (where status = 'inactive'),
    'suspended', count(*) filter (where status = 'suspended'), 'pending_approval', count(*) filter (where status = 'pending_approval')) into v_drivers from public.drivers;
  select coalesce(sum(p.pending_cents), 0)::bigint pending, coalesce(sum(p.credit_cents), 0)::bigint credit, count(distinct p.driver_id) filter (where p.pending_cents > 0) debtors
    into v_pos from public.v_assignment_position p;
  select coalesce(sum(gross_cents), 0)::bigint g, coalesce(sum(commission_cents), 0)::bigint c, coalesce(sum(net_cents), 0)::bigint n into v_pay
    from public.payments where voided_at is null and (paid_at at time zone app_private.tz())::date = v_today;
  select coalesce(sum(amount_cents), 0)::bigint into v_week_ch from public.charges where week_start = v_week and kind <> 'opening';
  select coalesce(sum(net_cents), 0)::bigint into v_week_net from public.payments where voided_at is null and week_start = v_week;
  select coalesce(jsonb_agg(jsonb_build_object('method_code', m.code, 'payments', x.n, 'gross_cents', x.g, 'commission_cents', x.c, 'net_cents', x.nt) order by m.code), '[]'::jsonb)
    into v_methods from public.payment_methods m
    cross join lateral (select count(p.id)::bigint n, coalesce(sum(p.gross_cents), 0)::bigint g, coalesce(sum(p.commission_cents), 0)::bigint c, coalesce(sum(p.net_cents), 0)::bigint nt
                          from public.payments p where p.method_id = m.id and p.voided_at is null and p.week_start = v_week) x;
  select jsonb_build_object('scheduled_today', count(*) filter (where local_date = v_today and status in ('pending','processing')),
    'pending_total', count(*) filter (where status = 'pending'), 'awaiting_approval', count(*) filter (where status = 'awaiting_approval')) into v_rem from public.notification_jobs;
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'label', label, 'status', status, 'last_seen_at', last_seen_at)), '[]'::jsonb) into v_wa from public.whatsapp_sessions;
  return jsonb_build_object('as_of_date', v_today, 'week_start', v_week, 'drivers', v_drivers,
    'collections', jsonb_build_object('pending_total_cents', v_pos.pending, 'drivers_with_debt', v_pos.debtors, 'credits_total_cents', v_pos.credit,
      'collected_today_gross_cents', v_pay.g, 'collected_today_commission_cents', v_pay.c, 'collected_today_net_cents', v_pay.n,
      'week_charged_cents', v_week_ch, 'week_net_cents', v_week_net),
    'by_method', v_methods, 'reminders', v_rem, 'whatsapp', jsonb_build_object('sessions', v_wa));
end $$;

-- period_summary: la apertura NO es cuota generada (expected_cents) ni ajuste; se informa aparte en opening_charged_cents.
create or replace function public.period_summary(p_from date, p_to date) returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare v_tz text := app_private.tz(); v_exp bigint; v_adj bigint; v_pay record; v_recovered bigint; v_to_period bigint; v_end record; v_open bigint;
begin
  perform app_private.assert_staff();
  if p_to < p_from or p_to - p_from > 400 then raise exception 'invalid_range' using errcode = '22023'; end if;
  select coalesce(sum(amount_cents) filter (where kind = 'daily'), 0), coalesce(sum(amount_cents) filter (where kind = 'adjustment'), 0),
         coalesce(sum(amount_cents) filter (where kind = 'opening'), 0)
    into v_exp, v_adj, v_open from public.charges where charge_date between p_from and p_to;
  select count(*) n, coalesce(sum(gross_cents), 0) g, coalesce(sum(commission_cents), 0) c, coalesce(sum(net_cents), 0) nt,
         coalesce(sum(applied_cents), 0) ap, coalesce(sum(credit_generated_cents), 0) cr into v_pay
    from public.payments where voided_at is null and (paid_at at time zone v_tz)::date between p_from and p_to;
  select coalesce(sum(pa.amount_cents) filter (where c.charge_date < p_from), 0), coalesce(sum(pa.amount_cents) filter (where c.charge_date between p_from and p_to), 0)
    into v_recovered, v_to_period from public.payment_allocations pa join public.payments p on p.id = pa.payment_id join public.charges c on c.id = pa.charge_id
   where p.voided_at is null and (p.paid_at at time zone v_tz)::date between p_from and p_to;
  select coalesce(sum(pos.pending_cents), 0) pend, coalesce(sum(pos.credit_cents), 0) cred, count(*) filter (where pos.pending_cents > 0) debtors into v_end
    from public.assignments a cross join lateral public.assignment_position(a.id, p_to) pos where a.valid_from <= p_to;
  return jsonb_build_object('from', p_from, 'to', p_to, 'charges_generated_cents', v_exp, 'adjustments_charged_cents', v_adj, 'opening_charged_cents', v_open, 'expected_cents', v_exp,
    'payments_count', v_pay.n, 'gross_cents', v_pay.g, 'commission_cents', v_pay.c, 'net_cents', v_pay.nt, 'applied_cents', v_pay.ap,
    'applied_to_period_cents', v_to_period, 'prior_debt_recovered_cents', v_recovered, 'credits_generated_cents', v_pay.cr,
    'pending_end_cents', v_end.pend, 'credits_end_cents', v_end.cred, 'drivers_with_debt_end', v_end.debtors,
    'difference_cents', v_pay.nt - v_exp, 'recovery_pct', case when v_exp > 0 then round(v_pay.nt * 100.0 / v_exp, 1) end);
end $$;

create or replace function public.period_detail(p_from date, p_to date, p_indicator text)
returns table (occurred_on date, kind text, unit_code text, operator_code text, full_name text, amount_cents bigint, detail text)
language plpgsql stable security invoker set search_path = '' as $$
declare v_tz text := app_private.tz();
begin
  perform app_private.assert_staff();
  if p_indicator = 'charges' then
    return query select c.charge_date, c.kind, u.code, d.operator_code, btrim(d.first_name || ' ' || d.last_name), c.amount_cents::bigint, case when c.kind = 'opening' then 'Deuda anterior (apertura)' end
      from public.charges c join public.assignments a on a.id = c.assignment_id join public.drivers d on d.id = a.driver_id join public.units u on u.id = a.unit_id
     where c.charge_date between p_from and p_to order by 1, 3;
  elsif p_indicator in ('gross', 'commission', 'net', 'applied', 'credits_generated') then
    return query select (p.paid_at at time zone v_tz)::date, 'payment'::text, u.code, d.operator_code, btrim(d.first_name || ' ' || d.last_name),
        (case p_indicator when 'gross' then p.gross_cents when 'commission' then p.commission_cents when 'net' then p.net_cents when 'applied' then p.applied_cents else p.credit_generated_cents end)::bigint, m.label
      from public.payments p join public.assignments a on a.id = p.assignment_id join public.drivers d on d.id = a.driver_id
      join public.units u on u.id = a.unit_id join public.payment_methods m on m.id = p.method_id
     where p.voided_at is null and (p.paid_at at time zone v_tz)::date between p_from and p_to
       and (case p_indicator when 'commission' then p.commission_cents when 'credits_generated' then p.credit_generated_cents when 'applied' then p.applied_cents else 1 end) > 0 order by 1, 3;
  elsif p_indicator = 'prior_debt_recovered' then
    return query select (p.paid_at at time zone v_tz)::date, 'allocation'::text, u.code, d.operator_code, btrim(d.first_name || ' ' || d.last_name), pa.amount_cents::bigint, 'cuota del ' || c.charge_date::text
      from public.payment_allocations pa join public.payments p on p.id = pa.payment_id join public.charges c on c.id = pa.charge_id
      join public.assignments a on a.id = p.assignment_id join public.drivers d on d.id = a.driver_id join public.units u on u.id = a.unit_id
     where p.voided_at is null and c.charge_date < p_from and (p.paid_at at time zone v_tz)::date between p_from and p_to order by 1, 3;
  elsif p_indicator in ('pending', 'credits') then
    return query select p_to, 'balance'::text, u.code, d.operator_code, btrim(d.first_name || ' ' || d.last_name),
        (case p_indicator when 'pending' then pos.pending_cents else pos.credit_cents end)::bigint, null::text
      from public.assignments a join public.drivers d on d.id = a.driver_id join public.units u on u.id = a.unit_id
      cross join lateral public.assignment_position(a.id, p_to) pos
     where a.valid_from <= p_to and (case p_indicator when 'pending' then pos.pending_cents else pos.credit_cents end) > 0 order by 6 desc, 3;
  else raise exception 'invalid_indicator' using errcode = '22023';
  end if;
end $$;


-- ───────── 5. Tabla semanal: deuda anterior vs cuotas generadas vs saldo exigible ─────────
--   previous_pending_cents / previous_credit_cents : posición con la que el conductor ENTRA a la semana (hasta el domingo anterior; incluye la apertura)
--   opening_cents                                  : apertura (SALDO del Excel) registrada para ESTA semana (0 si no hay)
--   week_charged_cents                             : cuotas generadas de la semana (lun–sáb + ajustes positivos); NO incluye la apertura
--   pending_cents / credit_cents                   : posición al cierre del domingo (= saldo exigible según los días generados)
drop function public.weekly_collection_table(date);
create function public.weekly_collection_table(p_week_start date)
returns table (assignment_id uuid, driver_id uuid, unit_id uuid, unit_code text, operator_code text, national_id text, full_name text,
  driver_status text, daily_rate_cents bigint, week_charged_cents bigint, day_net_cents bigint[], gross_cents bigint, commission_cents bigint,
  net_cents bigint, week_diff_cents bigint, pending_cents bigint, credit_cents bigint, week_closed boolean,
  previous_pending_cents bigint, previous_credit_cents bigint, opening_cents bigint)
language plpgsql stable security invoker set search_path = '' as $$
declare v_tz text := app_private.tz(); v_end date := p_week_start + 6;
begin
  perform app_private.assert_staff();
  if extract(isodow from p_week_start) <> 1 then raise exception 'week_start_must_be_monday' using errcode = '22023'; end if;
  return query
  select x.assignment_id, x.driver_id, x.unit_id, x.unit_code, x.operator_code, x.national_id, x.full_name, x.driver_status, x.daily_rate_cents, x.week_charged_cents,
         x.day_net_cents, x.gross_cents, x.commission_cents, x.net_cents, (x.net_cents - x.week_charged_cents), x.pending_cents, x.credit_cents, x.week_closed,
         x.previous_pending_cents, x.previous_credit_cents, x.opening_cents
  from (
    select a.id as assignment_id, d.id as driver_id, u.id as unit_id, u.code as unit_code, d.operator_code, d.national_id, btrim(d.first_name || ' ' || d.last_name) as full_name,
           d.status as driver_status,
           coalesce((select r.daily_amount_cents from public.rates r where r.assignment_id = a.id and r.valid_from <= v_end and (r.valid_to is null or r.valid_to >= p_week_start)
                      order by r.valid_from desc limit 1), 0)::bigint as daily_rate_cents,
           coalesce((select sum(c.amount_cents) from public.charges c where c.assignment_id = a.id and c.week_start = p_week_start and c.kind <> 'opening'), 0)::bigint as week_charged_cents,
           array(select coalesce((select sum(p.net_cents) from public.payments p where p.assignment_id = a.id and p.voided_at is null
                                    and (p.paid_at at time zone v_tz)::date = p_week_start + i), 0)::bigint from generate_series(0, 6) i) as day_net_cents,
           coalesce((select sum(p.gross_cents) from public.payments p where p.assignment_id = a.id and p.voided_at is null and p.week_start = p_week_start), 0)::bigint as gross_cents,
           coalesce((select sum(p.commission_cents) from public.payments p where p.assignment_id = a.id and p.voided_at is null and p.week_start = p_week_start), 0)::bigint as commission_cents,
           coalesce((select sum(p.net_cents) from public.payments p where p.assignment_id = a.id and p.voided_at is null and p.week_start = p_week_start), 0)::bigint as net_cents,
           pos.pending_cents, pos.credit_cents,
           exists (select 1 from public.weekly_closures w where w.assignment_id = a.id and w.week_start = p_week_start) as week_closed,
           prev.pending_cents as previous_pending_cents, prev.credit_cents as previous_credit_cents,
           coalesce((select sum(c.amount_cents) from public.charges c where c.assignment_id = a.id and c.kind = 'opening' and c.charge_date = p_week_start - 1), 0)::bigint as opening_cents
      from public.assignments a join public.drivers d on d.id = a.driver_id join public.units u on u.id = a.unit_id
      cross join lateral public.assignment_position(a.id, v_end) pos
      cross join lateral public.assignment_position(a.id, p_week_start - 1) prev
     where a.valid_from <= v_end and (a.valid_to is null or a.valid_to >= p_week_start)
  ) x order by x.unit_code;
end $$;
revoke all on function public.weekly_collection_table(date) from public, anon, authenticated;
grant execute on function public.weekly_collection_table(date) to authenticated, service_role;

-- Detalle semanal: la apertura (domingo anterior) NO es la cuota del domingo de la semana anterior ni de ninguna otra: se excluye de los días.
create or replace function public.weekly_collection_detail(p_week_start date, p_assignment uuid default null)
returns table (assignment_id uuid, previous_pending_cents bigint, previous_credit_cents bigint, days jsonb)
language plpgsql stable security invoker set search_path = '' as $$
declare v_tz text := app_private.tz();
begin
  perform app_private.assert_staff();
  if extract(isodow from p_week_start) <> 1 then raise exception 'week_start_must_be_monday' using errcode = '22023'; end if;
  return query
  select a.id, prev.pending_cents, prev.credit_cents, d.days
    from public.assignments a
    cross join lateral public.assignment_position(a.id, p_week_start - 1) prev
    cross join lateral (
      with cov as (select c.charge_date, sum(c.remaining_cents)::bigint rem from public.assignment_coverage(a.id) c where c.kind <> 'opening' group by c.charge_date)
      select jsonb_agg(jsonb_build_object(
               'date', g.d::date, 'weekday', extract(isodow from g.d)::int,
               'charge_cents', coalesce(ch.amt, 0), 'net_paid_cents', coalesce(pd.amt, 0), 'remaining_cents', coalesce(cov.rem, 0),
               'status', case when coalesce(ch.amt, 0) = 0 then 'no_charge' when coalesce(cov.rem, 0) = 0 then 'paid'
                              when cov.rem >= ch.amt then 'pending' else 'partial' end) order by g.d) as days
        from generate_series(p_week_start::timestamp, (p_week_start + 6)::timestamp, interval '1 day') g(d)
        left join lateral (select sum(c.amount_cents)::bigint amt from public.charges c where c.assignment_id = a.id and c.charge_date = g.d::date and c.kind <> 'opening') ch on true
        left join lateral (select sum(p.net_cents)::bigint amt from public.payments p where p.assignment_id = a.id and p.voided_at is null
                              and (p.paid_at at time zone v_tz)::date = g.d::date) pd on true
        left join cov on cov.charge_date = g.d::date
    ) d
   where a.valid_from <= p_week_start + 6 and (a.valid_to is null or a.valid_to >= p_week_start) and (p_assignment is null or a.id = p_assignment);
end $$;

-- ───────── 6. Opening: plan de conciliación (compartido por la vista previa y la aplicación) ─────────
-- Validaciones comunes: importación de cobranza ya confirmada (o aplicada), bloque de ESA importación, lunes.
create function app_private.opening_check(p_import uuid, p_block uuid, p_week_start date) returns void
language plpgsql stable security definer set search_path = '' as $$
declare v_imp record;
begin
  if p_week_start is null or extract(isodow from p_week_start) <> 1 then raise exception 'week_start_must_be_monday' using errcode = '22023'; end if;
  select i.id, i.status, i.source_kind into v_imp from public.excel_imports i where i.id = p_import;
  if not found then raise exception 'import_not_found' using errcode = 'P0002'; end if;
  if v_imp.source_kind <> 'cobranza' then raise exception 'wrong_import_kind' using errcode = '22023'; end if;
  if v_imp.status not in ('confirmed', 'applied') then raise exception 'import_not_confirmed' using errcode = '22023'; end if;
  if not exists (select 1 from public.import_blocks b where b.id = p_block and b.import_id = p_import) then raise exception 'block_not_found' using errcode = 'P0002'; end if;
end $$;

-- action: create | unchanged | conflict | skip_empty | skip_zero | skip_text | no_assignment | ambiguous
create function app_private.opening_plan(p_import uuid, p_block uuid, p_week_start date)
returns table (assignment_id uuid, import_row_id uuid, source_row int, unit_code text, operator_code text, raw_saldo text,
  saldo_excel_cents bigint, saldo_state text, pending_before_cents bigint, credit_before_cents bigint,
  existing_opening_cents bigint, existing_opening_week_start date, prior_records boolean, week_activity_cents bigint,
  action text, note text)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_end date := p_week_start + 6; v_tz text := app_private.tz();
  r record; r2 record; i int; n int := 0;
  v_ids uuid[] := '{}'; v_asgs uuid[] := '{}'; v_res text[] := '{}'; v_notes text[] := '{}';
  v_drv uuid; v_unit uuid; v_op_set uuid[]; v_unit_set uuid[]; v_both uuid[]; v_has_op boolean; v_has_unit boolean; v_asg uuid; v_resn text; v_note text;
  v_raw text; v_num text; v_dec numeric; v_cents bigint; v_state text;
  v_ex_amt bigint; v_ex_date date; v_dups int; v_un text; v_oc text; v_closed boolean;
begin
  -- Pasada 1: a qué asignación activa en esa semana corresponde cada fila.
  for r in select ir.id, ir.operator_code, ir.unit_code from public.import_rows ir
            where ir.block_id = p_block and ir.review_status = 'approved' and ir.match_status <> 'ignored' order by ir.source_row loop
    v_has_op := nullif(btrim(r.operator_code), '') is not null; v_has_unit := nullif(btrim(r.unit_code), '') is not null;
    v_drv := null; v_unit := null; v_op_set := null; v_unit_set := null; v_both := null; v_asg := null; v_resn := 'ok'; v_note := null;
    if v_has_op then
      select d.id into v_drv from public.drivers d where d.operator_code = btrim(r.operator_code);
      select array_agg(a.id) into v_op_set from public.assignments a
       where a.driver_id = v_drv and a.valid_from <= v_end and (a.valid_to is null or a.valid_to >= p_week_start);
    end if;
    if v_has_unit then
      select u.id into v_unit from public.units u where upper(u.code) = upper(btrim(r.unit_code));
      select array_agg(a.id) into v_unit_set from public.assignments a
       where a.unit_id = v_unit and a.valid_from <= v_end and (a.valid_to is null or a.valid_to >= p_week_start);
    end if;
    if not v_has_op and not v_has_unit then v_resn := 'no_assignment'; v_note := 'fila sin unidad ni operario';
    elsif v_has_op and v_op_set is not null and v_has_unit and v_unit_set is not null then
      select array_agg(x) into v_both from unnest(v_op_set) x where x = any (v_unit_set);
      if v_both is null then v_resn := 'ambiguous'; v_note := 'el operario y la unidad apuntan a asignaciones distintas';
      elsif cardinality(v_both) > 1 then v_resn := 'ambiguous'; v_note := 'varias asignaciones activas en la semana';
      else v_asg := v_both[1]; end if;
    elsif v_has_op then
      if v_op_set is null then v_resn := 'no_assignment'; v_note := case when v_drv is null then 'el operario no existe' else 'el conductor no tiene asignación activa en la semana' end;
      elsif cardinality(v_op_set) > 1 then v_resn := 'ambiguous'; v_note := 'varias asignaciones activas en la semana';
      else v_asg := v_op_set[1]; end if;
    else   -- solo unidad
      if v_unit_set is null then v_resn := 'no_assignment'; v_note := case when v_unit is null then 'la unidad no existe' else 'la unidad no tiene asignación activa en la semana' end;
      elsif cardinality(v_unit_set) > 1 then v_resn := 'ambiguous'; v_note := 'varias asignaciones activas en la semana';
      else v_asg := v_unit_set[1]; end if;
    end if;
    n := n + 1; v_ids := v_ids || r.id; v_asgs := v_asgs || v_asg; v_res := v_res || v_resn; v_notes := v_notes || coalesce(v_note, '');
  end loop;

  -- Pasada 2: SALDO, comparación con lo registrado y acción.
  for i in 1 .. n loop
    select ir.* into r2 from public.import_rows ir where ir.id = v_ids[i];
    v_raw := nullif(btrim(r2.raw_saldo), ''); v_cents := null; v_note := null;
    if v_raw is null then v_state := 'empty';
    else
      v_num := regexp_replace(v_raw, '^\$\s*', '');
      if v_num ~ '^-?[0-9]+,[0-9]{3}$' then v_state := 'text'; v_note := 'formato ambiguo (separador de miles)';
      elsif v_num ~ '^-?[0-9]+([.,][0-9]+)?$' then
        v_dec := replace(v_num, ',', '.')::numeric;
        if v_dec < 0 then v_state := 'text'; v_note := 'saldo negativo: no es una deuda interpretable';
        else v_cents := round(v_dec * 100)::bigint; v_state := case when v_cents = 0 then 'zero' else 'amount' end; end if;
      else v_state := 'text'; v_note := 'no es un importe numérico';
      end if;
    end if;
    v_asg := v_asgs[i];
    assignment_id := v_asg; import_row_id := r2.id; source_row := r2.source_row; raw_saldo := r2.raw_saldo; saldo_state := v_state; saldo_excel_cents := v_cents;
    unit_code := r2.unit_code; operator_code := r2.operator_code;
    pending_before_cents := null; credit_before_cents := null; existing_opening_cents := null; existing_opening_week_start := null;
    prior_records := null; week_activity_cents := null; v_ex_amt := null; v_ex_date := null; v_dups := 0; v_closed := false;
    if v_asg is not null then
      select u.code, d.operator_code into v_un, v_oc from public.assignments a join public.units u on u.id = a.unit_id join public.drivers d on d.id = a.driver_id where a.id = v_asg;
      unit_code := v_un; operator_code := v_oc;
      select pos.pending_cents, pos.credit_cents into pending_before_cents, credit_before_cents from public.assignment_position(v_asg, p_week_start - 1) pos;
      select c.amount_cents, c.charge_date into v_ex_amt, v_ex_date from public.charges c where c.assignment_id = v_asg and c.kind = 'opening';
      existing_opening_cents := v_ex_amt; existing_opening_week_start := v_ex_date + 1;
      prior_records := exists (select 1 from public.charges c where c.assignment_id = v_asg and c.kind <> 'opening' and c.charge_date < p_week_start)
                    or exists (select 1 from public.weekly_closures w where w.assignment_id = v_asg and w.week_start < p_week_start);
      select coalesce(sum(p.net_cents), 0)::bigint into week_activity_cents from public.payments p
       where p.assignment_id = v_asg and p.voided_at is null and (p.paid_at at time zone v_tz)::date between p_week_start and v_end;
      select count(*) into v_dups from unnest(v_asgs) x where x = v_asg;
      v_closed := exists (select 1 from public.weekly_closures w where w.assignment_id = v_asg and w.week_start = p_week_start);
    end if;
    if v_res[i] <> 'ok' then action := v_res[i]; note := nullif(v_notes[i], '');
    elsif v_dups > 1 then action := 'ambiguous'; note := 'varias filas del bloque apuntan a la misma asignación';
    elsif v_state = 'empty' then action := 'skip_empty'; note := 'SALDO vacío: no es un cero confirmado, no se registra nada';
    elsif v_state = 'zero' then action := 'skip_zero'; note := 'SALDO 0 explícito: no hay deuda que registrar';
    elsif v_state = 'text' then action := 'skip_text'; note := v_note;
    elsif v_ex_amt is null then
      if v_closed then action := 'conflict'; note := 'la semana ya está cerrada para esta asignación: no se registra una apertura';
      else action := 'create'; note := case when prior_records then 'el sistema ya tiene cargos o cierres anteriores: verifique que el SALDO no duplica deuda ya registrada' end; end if;
    elsif v_ex_amt = v_cents and v_ex_date = p_week_start - 1 then action := 'unchanged'; note := 'ya registrada con el mismo importe';
    else action := 'conflict'; note := 'ya existe una apertura de ' || app_private.fmt_usd(v_ex_amt) || ' (semana del ' || (v_ex_date + 1)::text || '): no se sobrescribe';
    end if;
    return next;
  end loop;
end $$;

-- ───────── 7. preview_opening_balances (solo lectura) ─────────
create function public.preview_opening_balances(p_import uuid, p_block uuid, p_week_start date)
returns table (assignment_id uuid, import_row_id uuid, source_row int, unit_code text, operator_code text, raw_saldo text,
  saldo_excel_cents bigint, saldo_state text, pending_before_cents bigint, credit_before_cents bigint,
  existing_opening_cents bigint, existing_opening_week_start date, prior_records boolean, week_activity_cents bigint,
  action text, note text)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app_private.assert_admin();
  perform app_private.opening_check(p_import, p_block, p_week_start);
  return query select * from app_private.opening_plan(p_import, p_block, p_week_start);
end $$;

-- ───────── 8. apply_opening_balances (transaccional e idempotente) ─────────
-- Crea SOLO los cargos `opening` con action = 'create'. Nunca modifica ni borra cargos existentes. Reaplicar el mismo bloque/semana no duplica.
create function public.apply_opening_balances(p_import uuid, p_block uuid, p_week_start date, p_actor_note text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_plan jsonb; x jsonb; v_n int; v_created int := 0; v_conflicts int := 0; v_created_cents bigint := 0; v_items jsonb := '[]'::jsonb; v_res jsonb;
  c_unchanged int; c_conf int; c_empty int; c_zero int; c_text int; c_noasg int; c_amb int; c_total int; v_key text;
begin
  perform app_private.assert_admin();
  perform 1 from public.excel_imports where id = p_import for update;      -- serializa aplicaciones de la misma importación
  perform app_private.opening_check(p_import, p_block, p_week_start);
  select coalesce(jsonb_agg(to_jsonb(p)), '[]'::jsonb) into v_plan from app_private.opening_plan(p_import, p_block, p_week_start) p;
  select count(*) filter (where e ->> 'action' = 'unchanged'), count(*) filter (where e ->> 'action' = 'conflict'), count(*) filter (where e ->> 'action' = 'skip_empty'),
         count(*) filter (where e ->> 'action' = 'skip_zero'), count(*) filter (where e ->> 'action' = 'skip_text'),
         count(*) filter (where e ->> 'action' = 'no_assignment'), count(*) filter (where e ->> 'action' = 'ambiguous'), count(*)
    into c_unchanged, c_conf, c_empty, c_zero, c_text, c_noasg, c_amb, c_total from jsonb_array_elements(v_plan) e;
  for x in select e from jsonb_array_elements(v_plan) e where e ->> 'action' = 'create' loop
    insert into public.charges(assignment_id, kind, charge_date, amount_cents, week_start, source_import_id, source_row_id)
    values ((x ->> 'assignment_id')::uuid, 'opening', p_week_start - 1, (x ->> 'saldo_excel_cents')::bigint, app_private.week_start_of(p_week_start - 1), p_import, (x ->> 'import_row_id')::uuid)
    on conflict (assignment_id) where kind = 'opening' do nothing;
    get diagnostics v_n = row_count;
    if v_n = 1 then
      v_created := v_created + 1; v_created_cents := v_created_cents + (x ->> 'saldo_excel_cents')::bigint;
      v_items := v_items || jsonb_build_object('assignment_id', x ->> 'assignment_id', 'unit_code', x ->> 'unit_code', 'operator_code', x ->> 'operator_code', 'amount_cents', (x ->> 'saldo_excel_cents')::bigint);
    else v_conflicts := v_conflicts + 1;     -- otra importación la creó entre la vista previa y la aplicación
    end if;
  end loop;
  v_res := jsonb_build_object('import_id', p_import, 'block_id', p_block, 'week_start', p_week_start, 'rows', c_total,
    'created', v_created, 'created_cents', v_created_cents, 'unchanged', c_unchanged, 'conflicts', c_conf + v_conflicts,
    'skipped_empty', c_empty, 'skipped_zero', c_zero, 'skipped_text', c_text, 'no_assignment', c_noasg, 'ambiguous', c_amb);
  perform app_private.audit('apply_opening_balances', 'excel_imports', p_import,
    v_res || jsonb_build_object('actor_note', nullif(btrim(p_actor_note), ''), 'items', v_items));
  v_key := p_block::text || ':' || p_week_start::text;
  update public.excel_imports set summary = jsonb_set(summary, '{opening}', coalesce(summary -> 'opening', '{}'::jsonb) || jsonb_build_object(v_key, v_res), true) where id = p_import;
  return v_res;
end $$;

revoke all on function public.preview_opening_balances(uuid, uuid, date), public.apply_opening_balances(uuid, uuid, date, text) from public, anon, authenticated;
grant execute on function public.preview_opening_balances(uuid, uuid, date), public.apply_opening_balances(uuid, uuid, date, text) to authenticated, service_role;


-- ───────── 9. apply_import: teléfono de WhatsApp de la columna del bloque (nunca marca consentimiento) ─────────
create or replace function public.apply_import(p_import_id uuid, p_valid_from date default null, p_initial_status text default 'active',
  p_resolve text default 'skip') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_phones text[]; v_phone text; v_curphone text; c_phones_set int := 0; c_phone_conflicts int := 0;
  v_imp record; v_from date; g record; v_drv uuid; v_unit uuid; v_asg uuid; v_existing_asg record; v_maxblock int;
  v_nid text[]; v_units text[]; v_rates bigint[]; v_name text; v_created_driver boolean; v_note text; v_action text;
  c_drivers_created int := 0; c_drivers_linked int := 0; c_units_created int := 0; c_asg_created int := 0; c_rates_created int := 0;
  c_skipped int := 0; c_rejected int := 0; c_excluded int := 0; c_resolved int := 0; v_issues jsonb := '[]'::jsonb;
  c_units_no_driver int := 0; c_agr_set int := 0; c_agr_skipped int := 0; uu record; v_n int; v_text text; v_cur text; v_maxb int;
begin
  perform app_private.assert_admin();
  if p_resolve not in ('skip', 'latest_block') then raise exception 'invalid_resolve' using errcode = '22023'; end if;
  select i.* into v_imp from public.excel_imports i where i.id = p_import_id for update;
  if not found then raise exception 'import_not_found' using errcode = 'P0002'; end if;
  if v_imp.source_kind <> 'cobranza' then raise exception 'wrong_import_kind' using errcode = '22023'; end if;
  if v_imp.status = 'applied' then raise exception 'import_already_applied' using errcode = '22023'; end if;
  if v_imp.status <> 'confirmed' then raise exception 'import_not_confirmed' using errcode = '22023'; end if;
  if p_initial_status not in ('active', 'inactive', 'pending_approval') then raise exception 'invalid_status' using errcode = '22023'; end if;
  v_from := coalesce(p_valid_from, (now() at time zone app_private.tz())::date);

  update public.import_rows r set applied_action = 'excluded', applied_note = 'no aprobada'
    from public.import_blocks b where b.id = r.block_id and b.import_id = p_import_id and r.review_status <> 'approved';
  get diagnostics c_excluded = row_count;
  update public.import_rows r set applied_action = 'rejected',
      applied_note = case when r.match_status in ('ignored','conflict','duplicate') then 'estado de conciliación: ' || r.match_status else 'sin unidad ni operario' end
    from public.import_blocks b where b.id = r.block_id and b.import_id = p_import_id and r.review_status = 'approved'
     and (r.match_status in ('ignored','conflict','duplicate') or (coalesce(btrim(r.operator_code), '') = '' and coalesce(btrim(r.unit_code), '') = ''));
  get diagnostics c_rejected = row_count;

  for g in select btrim(r.operator_code) as op, array_agg(r.id) as row_ids from public.import_rows r join public.import_blocks b on b.id = r.block_id
            where b.import_id = p_import_id and r.review_status = 'approved' and r.applied_action is null and coalesce(btrim(r.operator_code), '') <> '' group by btrim(r.operator_code) order by btrim(r.operator_code) loop
    select max(b.block_index) into v_maxblock from public.import_rows r join public.import_blocks b on b.id = r.block_id where r.id = any (g.row_ids);
    select array_agg(distinct btrim(r.national_id)) filter (where coalesce(btrim(r.national_id), '') <> '') into v_nid from public.import_rows r where r.id = any (g.row_ids);
    if v_nid is null then   -- operario sin cédula: no se crea el conductor; la unidad se importa igualmente
      update public.import_rows set applied_action = 'skipped', applied_note = 'sin cédula: no se crea el conductor (la unidad sí)' where id = any (g.row_ids);
      c_skipped := c_skipped + 1; v_issues := v_issues || jsonb_build_object('operator', g.op, 'issue', 'driver_incomplete'); continue;
    end if;
    if cardinality(v_nid) > 1 then
      update public.import_rows set applied_action = 'skipped', applied_note = 'cédulas distintas para el mismo operador' where id = any (g.row_ids);
      c_skipped := c_skipped + 1; v_issues := v_issues || jsonb_build_object('operator', g.op, 'issue', 'national_id_ambiguous'); continue;
    end if;
    select array_agg(distinct upper(btrim(r.unit_code))) filter (where coalesce(btrim(r.unit_code), '') <> ''), array_agg(distinct r.daily_rate_cents) filter (where r.daily_rate_cents > 0)
      into v_units, v_rates from public.import_rows r join public.import_blocks b on b.id = r.block_id where r.id = any (g.row_ids);
    if p_resolve = 'latest_block' and (cardinality(v_units) > 1 or cardinality(v_rates) > 1) then
      select array_agg(distinct upper(btrim(r.unit_code))) filter (where coalesce(btrim(r.unit_code), '') <> ''), array_agg(distinct r.daily_rate_cents) filter (where r.daily_rate_cents > 0)
        into v_units, v_rates from public.import_rows r join public.import_blocks b on b.id = r.block_id where r.id = any (g.row_ids) and b.block_index = v_maxblock;
      c_resolved := c_resolved + 1;
      v_issues := v_issues || jsonb_build_object('operator', g.op, 'issue', 'resolved_by_latest_block');
    end if;
    -- WhatsApp de la columna opcional del bloque: un único número normalizado por conductor; si los bloques traen números distintos NO se adivina.
    select array_agg(distinct btrim(r.phone_e164)) filter (where btrim(r.phone_e164) ~ '^\+[1-9][0-9]{7,14}$') into v_phones from public.import_rows r where r.id = any (g.row_ids);
    v_phone := case when cardinality(v_phones) = 1 then v_phones[1] end;
    if cardinality(v_phones) > 1 then v_issues := v_issues || jsonb_build_object('operator', g.op, 'issue', 'phone_ambiguous'); end if;
    select r.full_name into v_name from public.import_rows r join public.import_blocks b on b.id = r.block_id
     where r.id = any (g.row_ids) and coalesce(btrim(r.full_name), '') <> '' group by r.full_name order by count(*) desc, max(b.block_index) desc limit 1;

    select d.id into v_drv from public.drivers d where d.operator_code = g.op or d.national_id = v_nid[1] order by (d.operator_code = g.op) desc limit 1;
    v_created_driver := false;
    if v_drv is null then
      insert into public.drivers(operator_code, national_id, first_name, last_name, phone_e164, status)
      values (g.op, v_nid[1], coalesce(nullif(btrim(v_name), ''), 'Sin nombre'), '', v_phone, p_initial_status) returning id into v_drv;
      if v_phone is not null then c_phones_set := c_phones_set + 1; end if;
      v_created_driver := true; c_drivers_created := c_drivers_created + 1;
    else
      if exists (select 1 from public.drivers where id = v_drv and (operator_code <> g.op or national_id <> v_nid[1])) then
        update public.import_rows set applied_action = 'skipped', applied_note = 'el operador y la cédula apuntan a conductores distintos' where id = any (g.row_ids);
        c_skipped := c_skipped + 1; v_issues := v_issues || jsonb_build_object('operator', g.op, 'issue', 'identity_conflict'); continue;
      end if;
      -- Conductor existente: el teléfono se completa SOLO si no tiene; si difiere NO se sobrescribe (phone_conflict). Nunca toca el consentimiento.
      select d.phone_e164 into v_curphone from public.drivers d where d.id = v_drv;
      if v_phone is not null then
        if v_curphone is null then update public.drivers set phone_e164 = v_phone where id = v_drv; c_phones_set := c_phones_set + 1;
        elsif v_curphone <> v_phone then
          c_phone_conflicts := c_phone_conflicts + 1;
          v_issues := v_issues || jsonb_build_object('operator', g.op, 'issue', 'phone_conflict', 'current', v_curphone, 'imported', v_phone);
        end if;
      end if;
      c_drivers_linked := c_drivers_linked + 1;
    end if;

    v_note := null; v_action := case when v_created_driver then 'created' else 'linked' end; v_asg := null;
    if v_units is null then v_note := 'sin unidad: conductor sin asignación';
    elsif cardinality(v_units) > 1 then
      v_note := 'unidades distintas entre bloques (' || array_to_string(v_units, ', ') || '): asigne manualmente';
      v_issues := v_issues || jsonb_build_object('operator', g.op, 'issue', 'unit_ambiguous');
    else
      select u.id into v_unit from public.units u where upper(u.code) = v_units[1];
      if v_unit is null then
        insert into public.units(code) values ((select btrim(r.unit_code) from public.import_rows r where r.id = any (g.row_ids) and upper(btrim(r.unit_code)) = v_units[1] limit 1)) returning id into v_unit;
        c_units_created := c_units_created + 1;
      end if;
      select a.* into v_existing_asg from public.assignments a where a.driver_id = v_drv and a.valid_to is null limit 1;
      if found then
        if v_existing_asg.unit_id = v_unit then v_asg := v_existing_asg.id;
        else v_note := 'el conductor ya tiene otra unidad asignada: no se modifica'; v_issues := v_issues || jsonb_build_object('operator', g.op, 'issue', 'assignment_conflict'); end if;
      elsif exists (select 1 from public.assignments a where a.unit_id = v_unit and a.valid_to is null) then
        v_note := 'la unidad ya está asignada a otro conductor: no se modifica'; v_issues := v_issues || jsonb_build_object('operator', g.op, 'issue', 'unit_already_assigned');
      else
        insert into public.assignments(driver_id, unit_id, valid_from) values (v_drv, v_unit, v_from) returning id into v_asg;
        c_asg_created := c_asg_created + 1;
      end if;
      if v_asg is not null then
        if v_rates is null then v_note := coalesce(v_note || '; ', '') || 'sin tarifa en el Excel';
        elsif cardinality(v_rates) > 1 then
          v_note := coalesce(v_note || '; ', '') || 'tarifas distintas entre bloques: defina la tarifa manualmente';
          v_issues := v_issues || jsonb_build_object('operator', g.op, 'issue', 'rate_ambiguous');
        elsif not exists (select 1 from public.rates r where r.assignment_id = v_asg and r.valid_to is null) then
          insert into public.rates(assignment_id, daily_amount_cents, valid_from) values (v_asg, v_rates[1], v_from);
          c_rates_created := c_rates_created + 1;
        elsif not exists (select 1 from public.rates r where r.assignment_id = v_asg and r.valid_to is null and r.daily_amount_cents = v_rates[1]) then
          v_note := coalesce(v_note || '; ', '') || 'la tarifa del Excel difiere de la vigente: no se modifica';
          v_issues := v_issues || jsonb_build_object('operator', g.op, 'issue', 'rate_differs');
        end if;
      end if;
    end if;
    update public.import_rows set applied_action = v_action, applied_note = v_note, matched_driver_id = v_drv where id = any (g.row_ids);
  end loop;

  -- ───── Unidades (con o sin conductor) y su acuerdo / condición especial ─────
  -- El código de unidad es obligatorio y único; una unidad puede existir sin conductor. La condición se toma de ACUERDO.
  for uu in select upper(btrim(r.unit_code)) as ucode, min(btrim(r.unit_code)) as raw_code, array_agg(r.id) as row_ids
             from public.import_rows r join public.import_blocks b on b.id = r.block_id
            where b.import_id = p_import_id and r.review_status = 'approved' and coalesce(btrim(r.unit_code), '') <> ''
              and (r.applied_action is null or r.applied_action in ('created', 'linked', 'skipped'))
            group by upper(btrim(r.unit_code)) order by upper(btrim(r.unit_code)) loop
    select un.id into v_unit from public.units un where upper(un.code) = uu.ucode;
    if v_unit is null then
      insert into public.units(code) values (uu.raw_code) returning id into v_unit; c_units_created := c_units_created + 1;
      if not exists (select 1 from public.assignments a where a.unit_id = v_unit) then c_units_no_driver := c_units_no_driver + 1; end if;
    elsif not exists (select 1 from public.assignments a where a.unit_id = v_unit and a.valid_to is null) and exists
          (select 1 from public.import_rows r where r.id = any (uu.row_ids) and coalesce(btrim(r.operator_code), '') = '') then
      c_units_no_driver := c_units_no_driver + 1;
    end if;
    update public.import_rows set applied_action = case when applied_action is null then 'linked' else applied_action end,
           applied_note = coalesce(applied_note, 'unidad sin conductor asignado') where id = any (uu.row_ids) and applied_action is null;
    -- ACUERDO → «Acuerdo / condición especial» de la unidad: TEXTO LIBRE, se guarda tal cual (solo se recortan espacios laterales).
    -- 'skip': solo si todas las filas con valor coinciden (sin distinguir mayúsculas); 'latest_block': el valor del bloque más a la derecha.
    select max(b.block_index) into v_maxb from public.import_rows r join public.import_blocks b on b.id = r.block_id
     where r.id = any (uu.row_ids) and nullif(btrim(r.raw_agreement), '') is not null;
    select count(distinct upper(btrim(r.raw_agreement))), (array_agg(btrim(r.raw_agreement) order by b.block_index desc, r.source_row))[1]
      into v_n, v_text from public.import_rows r join public.import_blocks b on b.id = r.block_id
     where r.id = any (uu.row_ids) and nullif(btrim(r.raw_agreement), '') is not null and (p_resolve = 'skip' or b.block_index = v_maxb);
    if coalesce(v_n, 0) = 0 then continue;
    elsif v_n > 1 then
      c_agr_skipped := c_agr_skipped + 1; v_issues := v_issues || jsonb_build_object('unit', uu.ucode, 'issue', 'agreement_ambiguous'); continue;
    end if;
    select un.agreement into v_cur from public.units un where un.id = v_unit;
    if v_cur is not null and upper(btrim(v_cur)) <> upper(v_text) then
      c_agr_skipped := c_agr_skipped + 1; v_issues := v_issues || jsonb_build_object('unit', uu.ucode, 'issue', 'agreement_differs'); continue;   -- no pisa un acuerdo ya registrado
    end if;
    if v_cur is null then
      perform set_config('vip.source', 'import', true);
      begin
        update public.units set agreement = v_text where id = v_unit;
        c_agr_set := c_agr_set + 1;
      exception when others then
        c_agr_skipped := c_agr_skipped + 1; v_issues := v_issues || jsonb_build_object('unit', uu.ucode, 'issue', 'agreement_invalid', 'detail', sqlerrm);
      end;
    end if;
  end loop;

  update public.excel_imports set status = 'applied', applied_by = auth.uid(), applied_at = now(),
    summary = summary || jsonb_build_object('applied', jsonb_build_object('drivers_created', c_drivers_created, 'drivers_linked', c_drivers_linked,
      'units_created', c_units_created, 'assignments_created', c_asg_created, 'rates_created', c_rates_created, 'skipped', c_skipped,
      'rows_rejected', c_rejected, 'rows_excluded', c_excluded, 'resolved_by_latest_block', c_resolved, 'units_without_driver', c_units_no_driver, 'agreements_set', c_agr_set, 'agreements_skipped', c_agr_skipped, 'phones_set', c_phones_set, 'phone_conflicts', c_phone_conflicts, 'resolve', p_resolve, 'valid_from', v_from, 'issues', v_issues)) where id = p_import_id;
  perform app_private.audit('apply_import', 'excel_imports', p_import_id, jsonb_build_object('drivers_created', c_drivers_created, 'drivers_linked', c_drivers_linked,
    'units_created', c_units_created, 'assignments_created', c_asg_created, 'rates_created', c_rates_created, 'resolve', p_resolve));
  return (select summary -> 'applied' from public.excel_imports where id = p_import_id);
end $$;

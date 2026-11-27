-- VIP · 0004 · Operaciones financieras atómicas y cola de notificaciones.
-- Todas SECURITY DEFINER con search_path vacío; validan SIEMPRE que el llamante sea la administradora autorizada.
set search_path = public, extensions;

create function app_private.payment_result(p_payment uuid, p_duplicate boolean) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('payment_id', p.id, 'duplicate', p_duplicate, 'gross_cents', p.gross_cents,
    'commission_cents', p.commission_cents, 'net_cents', p.net_cents, 'applied_cents', p.applied_cents,
    'credit_generated_cents', p.credit_generated_cents, 'paid_at', p.paid_at,
    'pending_cents', pos.pending_cents, 'credit_cents', pos.credit_cents, 'balance_cents', pos.balance_cents)
  from public.payments p cross join lateral public.assignment_position(p.assignment_id) pos where p.id = p_payment
$$;

-- Los recordatorios pendientes se reevalúan de inmediato al registrar un pago.
create function app_private.reevaluate_reminders(p_driver uuid, p_local_date date) returns void
language plpgsql security definer set search_path = '' as $$
declare j record; x record; v_amount bigint;
begin
  -- Cada recordatorio pendiente se evalúa con SU fecha (puede no ser la del pago).
  for j in select nj.id, nj.local_date, coalesce(s.scope, 'total') as scope,
                  (select a2.id from public.assignments a2 where a2.driver_id = p_driver and a2.valid_from <= nj.local_date
                      and (a2.valid_to is null or a2.valid_to >= nj.local_date) order by a2.valid_from desc limit 1) as assignment_id
             from public.notification_jobs nj left join public.notification_schedules s on s.id = nj.schedule_id
            where nj.driver_id = p_driver and nj.status = 'pending' and nj.kind in ('debt_reminder','debt_first','debt_update','debt_last')
              for update of nj loop
    if j.assignment_id is null then continue; end if;
    select * into x from public.assignment_dues(j.assignment_id, j.local_date);
    v_amount := case j.scope when 'today' then x.today_cents when 'overdue' then x.overdue_cents else x.total_pending_cents end;
    if v_amount <= 0 then
      update public.notification_jobs set status = case when x.credit_cents > 0 then 'skipped_credit' else 'skipped_paid' end where id = j.id;
    end if;
  end loop;
end $$;

-- ═════════ register_payment ═════════
-- Una transacción: valida, calcula bruto/comisión/neto, aplica el neto a las deudas más antiguas, registra crédito,
-- es idempotente, reevalúa recordatorios, audita y PREPARA notificaciones (nunca las envía).
create function public.register_payment(p_assignment_id uuid, p_method_code text, p_gross_cents bigint, p_idempotency_key text,
  p_reference text default null, p_paid_at timestamptz default null, p_send_receipt boolean default false, p_notes text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid(); v_asg record; v_method record; v_existing record; v_driver record; v_unit record;
  v_paid_at timestamptz := coalesce(p_paid_at, now()); v_local date; v_net bigint; v_before record; v_after record;
  v_applied bigint; v_generated bigint; v_payment_id uuid; v_credit_job uuid; v_receipt_job uuid; v_covered jsonb; v_cov_before jsonb;
begin
  perform app_private.assert_admin();
  if p_idempotency_key is null or length(btrim(p_idempotency_key)) = 0 then raise exception 'idempotency_key_required' using errcode = '22023'; end if;
  select a.* into v_asg from public.assignments a where a.id = p_assignment_id for update;     -- serializa pagos del mismo conductor
  if not found then raise exception 'assignment_not_found' using errcode = 'P0002'; end if;
  v_local := (v_paid_at at time zone app_private.tz())::date;

  select p.* into v_existing from public.payments p where p.idempotency_key = p_idempotency_key;
  if found then
    if v_existing.assignment_id <> p_assignment_id or v_existing.gross_cents <> p_gross_cents then raise exception 'idempotency_conflict' using errcode = '23505'; end if;
    return app_private.payment_result(v_existing.id, true);
  end if;

  if v_paid_at > now() + interval '5 minutes' then raise exception 'paid_at_in_future' using errcode = '22023'; end if;
  if p_gross_cents is null or p_gross_cents <= 0 then raise exception 'invalid_amount' using errcode = '22023'; end if;
  select d.* into v_driver from public.drivers d where d.id = v_asg.driver_id;
  select u.* into v_unit from public.units u where u.id = v_asg.unit_id;
  if not v_driver.active or not v_unit.active or v_asg.valid_from > v_local or (v_asg.valid_to is not null and v_asg.valid_to < v_local) then
    raise exception 'assignment_inactive' using errcode = '22023'; end if;
  select pm.* into v_method from public.payment_methods pm where pm.code = p_method_code and pm.active;
  if not found then raise exception 'invalid_method' using errcode = '22023'; end if;
  if p_gross_cents <= v_method.commission_cents then raise exception 'amount_not_covering_commission' using errcode = '22023'; end if;

  v_net := p_gross_cents - v_method.commission_cents;
  select * into v_before from public.assignment_position(p_assignment_id);
  select * into v_after from public.assignment_position(p_assignment_id, null, v_net);
  v_applied := v_before.pending_cents - v_after.pending_cents;
  v_generated := v_after.credit_cents - v_before.credit_cents;
  select coalesce(jsonb_object_agg(c.charge_id::text, c.covered_cents), '{}'::jsonb) into v_cov_before from public.assignment_coverage(p_assignment_id) c;

  begin
    insert into public.payments(assignment_id, method_id, gross_cents, commission_cents, net_cents, applied_cents, credit_generated_cents,
      reference, notes, paid_at, week_start, idempotency_key, registered_by)
    values (p_assignment_id, v_method.id, p_gross_cents, v_method.commission_cents, v_net, v_applied, v_generated,
      nullif(btrim(p_reference), ''), nullif(btrim(p_notes), ''), v_paid_at, app_private.week_start_of(v_local), p_idempotency_key, v_uid)
    returning id into v_payment_id;
  exception when unique_violation then raise exception 'idempotency_conflict' using errcode = '23505';
  end;

  insert into public.payment_allocations(payment_id, charge_id, amount_cents)
  select v_payment_id, a.charge_id, a.covered_cents - coalesce((v_cov_before ->> a.charge_id::text)::bigint, 0)
    from public.assignment_coverage(p_assignment_id) a
   where a.covered_cents - coalesce((v_cov_before ->> a.charge_id::text)::bigint, 0) > 0;
  select coalesce(jsonb_agg(jsonb_build_object('charge_id', charge_id, 'amount_cents', amount_cents)), '[]'::jsonb) into v_covered
    from public.payment_allocations where payment_id = v_payment_id;

  if v_generated > 0 then
    insert into public.notification_jobs(driver_id, kind, local_date, payment_id, scheduled_for, status, suggested_body)
    values (v_asg.driver_id, 'credit_notice', v_local, v_payment_id, now(), 'awaiting_approval',
      'Estimado conductor, le informamos que su cuenta (unidad ' || v_unit.code || ') se encuentra al día y mantiene un saldo a favor de '
      || app_private.fmt_usd(v_after.credit_cents) || E', que será aplicado a sus próximas obligaciones.\n¡Gracias por su puntualidad!')
    returning id into v_credit_job;
  end if;
  if p_send_receipt then
    insert into public.notification_jobs(driver_id, kind, local_date, payment_id, scheduled_for, status)
    values (v_asg.driver_id, 'payment_receipt', v_local, v_payment_id, now(), 'pending') returning id into v_receipt_job;
  end if;

  perform app_private.reevaluate_reminders(v_asg.driver_id, v_local);
  perform app_private.audit('register_payment', 'payments', v_payment_id, jsonb_build_object(
    'assignment_id', p_assignment_id, 'method', p_method_code, 'gross_cents', p_gross_cents, 'commission_cents', v_method.commission_cents,
    'net_cents', v_net, 'applied_cents', v_applied, 'credit_generated_cents', v_generated, 'reference', p_reference, 'notes', p_notes,
    'idempotency_key', p_idempotency_key));
  return app_private.payment_result(v_payment_id, false) || jsonb_build_object('covered', v_covered, 'credit_notice_job_id', v_credit_job, 'receipt_job_id', v_receipt_job);
end $$;

-- ═════════ void_payment ═════════
create function public.void_payment(p_payment_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_pay record;
begin
  perform app_private.assert_admin();
  if p_reason is null or length(btrim(p_reason)) < 3 then raise exception 'reason_required' using errcode = '22023'; end if;
  select p.* into v_pay from public.payments p where p.id = p_payment_id;
  if not found then raise exception 'payment_not_found' using errcode = 'P0002'; end if;
  perform 1 from public.assignments where id = v_pay.assignment_id for update;
  select p.* into v_pay from public.payments p where p.id = p_payment_id;
  if v_pay.voided_at is not null then raise exception 'already_voided' using errcode = '22023'; end if;
  if exists (select 1 from public.weekly_closures c where c.assignment_id = v_pay.assignment_id and c.week_start = v_pay.week_start) then
    raise exception 'week_closed' using errcode = '22023'; end if;
  update public.payments set voided_at = now(), voided_by = auth.uid(), void_reason = btrim(p_reason) where id = p_payment_id;
  update public.notification_jobs set status = 'cancelled' where payment_id = p_payment_id and status = 'pending';
  update public.notification_jobs set status = 'discarded' where payment_id = p_payment_id and status = 'awaiting_approval';
  perform app_private.audit('void_payment', 'payments', p_payment_id, jsonb_build_object('reason', btrim(p_reason), 'net_cents', v_pay.net_cents, 'gross_cents', v_pay.gross_cents));
  return app_private.payment_result(p_payment_id, false);
end $$;

-- ═════════ create_adjustment (+ aumenta deuda, − otorga crédito) ═════════
create function public.create_adjustment(p_assignment_id uuid, p_amount_cents bigint, p_effective_date date, p_reason text, p_idempotency_key text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_adj record; v_id uuid;
begin
  perform app_private.assert_admin();
  perform 1 from public.assignments where id = p_assignment_id for update;
  if not found then raise exception 'assignment_not_found' using errcode = 'P0002'; end if;
  if p_amount_cents is null or p_amount_cents = 0 then raise exception 'invalid_amount' using errcode = '22023'; end if;
  if p_reason is null or length(btrim(p_reason)) < 3 then raise exception 'reason_required' using errcode = '22023'; end if;
  select * into v_adj from public.adjustments where idempotency_key = p_idempotency_key;
  if found then
    if v_adj.assignment_id <> p_assignment_id or v_adj.amount_cents <> p_amount_cents then raise exception 'idempotency_conflict' using errcode = '23505'; end if;
    return jsonb_build_object('adjustment_id', v_adj.id, 'duplicate', true);
  end if;
  insert into public.adjustments(assignment_id, effective_date, amount_cents, reason, idempotency_key, created_by)
  values (p_assignment_id, p_effective_date, p_amount_cents, btrim(p_reason), p_idempotency_key, auth.uid()) returning id into v_id;
  if p_amount_cents > 0 then
    insert into public.charges(assignment_id, kind, charge_date, amount_cents, week_start, adjustment_id)
    values (p_assignment_id, 'adjustment', p_effective_date, p_amount_cents, app_private.week_start_of(p_effective_date), v_id);
  end if;
  perform app_private.audit('create_adjustment', 'adjustments', v_id, jsonb_build_object('assignment_id', p_assignment_id, 'amount_cents', p_amount_cents, 'reason', btrim(p_reason)));
  return jsonb_build_object('adjustment_id', v_id, 'duplicate', false) || (select to_jsonb(pos) from public.assignment_position(p_assignment_id) pos);
end $$;

-- ═════════ generate_daily_charges ═════════
create function public.generate_daily_charges(p_date date) returns int
language plpgsql security definer set search_path = '' as $$
declare v_n int;
begin
  if not app_private.is_service() then perform app_private.assert_admin(); end if;
  if extract(isodow from p_date) = 7 then return 0; end if;       -- el domingo no genera cuota ordinaria
  insert into public.charges(assignment_id, kind, charge_date, amount_cents, week_start)
  select a.id, 'daily', p_date, x.amt, app_private.week_start_of(p_date)
    from public.assignments a
    join public.drivers d on d.id = a.driver_id and d.active
    join public.units u on u.id = a.unit_id and u.active
    cross join lateral (select coalesce(
        (select e.amount_cents from public.rate_exceptions e where e.assignment_id = a.id and e.on_date = p_date),
        (select r.daily_amount_cents from public.rates r where r.assignment_id = a.id and r.valid_from <= p_date
            and (r.valid_to is null or r.valid_to >= p_date) and extract(isodow from p_date)::smallint = any (r.weekdays))) as amt) x
   where a.valid_from <= p_date and (a.valid_to is null or a.valid_to >= p_date) and x.amt > 0
  on conflict (assignment_id, charge_date) where kind = 'daily' do nothing;
  get diagnostics v_n = row_count;
  perform app_private.audit('generate_daily_charges', 'charges', null, jsonb_build_object('date', p_date, 'created', v_n));
  return v_n;
end $$;

-- ═════════ close_week ═════════
create function public.close_week(p_week_start date) returns int
language plpgsql security definer set search_path = '' as $$
declare v_n int;
begin
  perform app_private.assert_admin();
  if extract(isodow from p_week_start) <> 1 then raise exception 'week_start_must_be_monday' using errcode = '22023'; end if;
  insert into public.weekly_closures(assignment_id, week_start, charged_cents, gross_cents, commission_cents, net_cents, pending_cents, credit_cents, closed_by)
  select a.id, p_week_start,
         coalesce((select sum(c.amount_cents) from public.charges c where c.assignment_id = a.id and c.week_start = p_week_start), 0),
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

-- ═════════ review_notification (aviso de crédito) ═════════
create function public.review_notification(p_job_id uuid, p_action text, p_body text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_job record;
begin
  perform app_private.assert_admin();
  select j.* into v_job from public.notification_jobs j where j.id = p_job_id for update;
  if not found then raise exception 'notification_not_found' using errcode = 'P0002'; end if;
  if v_job.kind <> 'credit_notice' or v_job.status <> 'awaiting_approval' then raise exception 'not_awaiting_approval' using errcode = '22023'; end if;
  if p_action = 'edit' then update public.notification_jobs set suggested_body = btrim(p_body) where id = p_job_id;
  elsif p_action = 'approve' then
    update public.notification_jobs set status = 'pending', approved_by = auth.uid(), approved_at = now(),
      suggested_body = coalesce(nullif(btrim(p_body), ''), suggested_body), scheduled_for = now() where id = p_job_id;
  elsif p_action = 'discard' then update public.notification_jobs set status = 'discarded' where id = p_job_id;
  else raise exception 'invalid_action' using errcode = '22023'; end if;
  perform app_private.audit('review_notification_' || p_action, 'notification_jobs', p_job_id, '{}');
  return (select to_jsonb(j) - 'rendered_body' from public.notification_jobs j where j.id = p_job_id);
end $$;

-- ═════════ Plantillas ═════════
create function app_private.render_template(p_body text, p_vars jsonb) returns text
language plpgsql immutable set search_path = '' as $$
declare r record; v_out text := p_body;
begin
  for r in select key, value from jsonb_each_text(p_vars) loop v_out := replace(v_out, '{{' || r.key || '}}', r.value); end loop;
  return v_out;
end $$;

create function app_private.template_vars(p_assignment uuid, p_date date) returns jsonb
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
    'cuenta_semana', app_private.fmt_usd((select coalesce(sum(c.amount_cents), 0)::bigint from public.charges c where c.assignment_id = p_assignment and c.week_start = app_private.week_start_of(p_date))),
    'pagos_semana', app_private.fmt_usd((select coalesce(sum(p.net_cents), 0)::bigint from public.payments p where p.assignment_id = p_assignment and p.voided_at is null and p.week_start = app_private.week_start_of(p_date))));
end $$;

create function public.preview_template(p_assignment uuid, p_body text, p_date date default null) returns text
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app_private.assert_admin();
  if not exists (select 1 from public.assignments where id = p_assignment) then raise exception 'assignment_not_found' using errcode = 'P0002'; end if;
  return app_private.render_template(p_body, app_private.template_vars(p_assignment, coalesce(p_date, (now() at time zone app_private.tz())::date)));
end $$;

-- ═════════ Cola del worker (solo service_role) ═════════
create function public.schedule_reminders(p_now timestamptz default now(), p_grace interval default null) returns int
language plpgsql security definer set search_path = '' as $$
declare v_total int := 0; v_n int; s record; v_set record; v_local timestamp; v_due timestamptz; v_grace interval;
begin
  select * into v_set from public.app_settings;
  for s in select * from public.notification_schedules where enabled loop
    v_local := p_now at time zone v_set.timezone;
    if not (extract(isodow from v_local)::smallint = any (s.weekdays)) then continue; end if;
    v_due := (v_local::date + s.local_time) at time zone v_set.timezone;
    v_grace := coalesce(p_grace, make_interval(mins => v_set.grace_minutes));
    if v_due > p_now or p_now - v_due > v_grace then continue; end if;
    insert into public.notification_jobs(driver_id, kind, local_date, scheduled_for, schedule_id)
    select a.driver_id, s.kind, v_local::date, v_due, s.id
      from public.assignments a join public.drivers d on d.id = a.driver_id
     where a.valid_from <= v_local::date and (a.valid_to is null or a.valid_to >= v_local::date)
       and d.status = 'active' and d.whatsapp_consent and d.phone_e164 is not null and not d.reminders_paused   -- nunca sin autorización
    on conflict (driver_id, schedule_id, local_date) where schedule_id is not null do nothing;
    get diagnostics v_n = row_count;
    v_total := v_total + v_n;
  end loop;
  return v_total;
end $$;

create function public.claim_notification_jobs(p_limit int default 10, p_now timestamptz default now()) returns setof public.notification_jobs
language sql security definer set search_path = '' as $$
  update public.notification_jobs j set status = 'processing', attempts = j.attempts + 1, claimed_at = p_now
   where j.id in (select id from public.notification_jobs where status = 'pending' and scheduled_for <= p_now order by scheduled_for, id limit p_limit for update skip locked)
  returning j.*
$$;

create function public.requeue_stuck_notifications(p_older_than interval default interval '10 minutes', p_now timestamptz default now()) returns int
language plpgsql security definer set search_path = '' as $$
declare v_n int;
begin
  update public.notification_jobs set status = case when attempts >= 3 then 'failed' else 'pending' end, error = 'recuperado tras quedar en processing'
   where status = 'processing' and claimed_at < p_now - p_older_than;
  get diagnostics v_n = row_count; return v_n;
end $$;

create function public.release_notification(p_job_id uuid, p_delay interval default interval '1 minute', p_now timestamptz default now()) returns void
language sql security definer set search_path = '' as $$
  update public.notification_jobs set status = 'pending', attempts = greatest(attempts - 1, 0), claimed_at = null, scheduled_for = greatest(scheduled_for, p_now + p_delay)
   where id = p_job_id and status = 'processing'
$$;

-- Decide y redacta AL MOMENTO DEL ENVÍO con el saldo vigente; el worker lo vuelve a invocar justo antes de enviar.
create function public.prepare_notification_send(p_job_id uuid, p_now timestamptz default now()) returns jsonb
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
    select coalesce(sum(c.amount_cents), 0) into v_charged from public.charges c where c.assignment_id = a.id and c.week_start = v_week;
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

create function public.complete_notification(p_job_id uuid, p_outcome text, p_error text default null,
  p_dry_run boolean default true, p_body text default null, p_now timestamptz default now()) returns text
language plpgsql security definer set search_path = '' as $$
declare j record; v_status text;
begin
  select * into j from public.notification_jobs where id = p_job_id for update;
  if not found or j.status <> 'processing' then raise exception 'job_not_processing' using errcode = '22023'; end if;
  if p_outcome = 'sent' then
    update public.notification_jobs set status = 'sent', sent_at = p_now, dry_run = p_dry_run, rendered_body = p_body, error = null where id = p_job_id;
    return 'sent';
  elsif p_outcome = 'failed' then
    v_status := case when j.attempts >= 3 then 'failed' else 'pending' end;
    update public.notification_jobs set status = v_status, error = left(p_error, 500),
      scheduled_for = case when v_status = 'pending' then p_now + (j.attempts * interval '5 minutes') else scheduled_for end where id = p_job_id;
    return v_status;
  end if;
  raise exception 'invalid_outcome' using errcode = '22023';
end $$;

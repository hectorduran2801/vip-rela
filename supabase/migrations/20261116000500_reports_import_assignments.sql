-- VIP · 0005 · Dashboard, tabla semanal, resúmenes por período, aplicación del Excel y operaciones de unidades/tarifas.
set search_path = public, extensions;

create function public.dashboard_summary() returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare v_today date; v_week date; v_drivers jsonb; v_pos record; v_pay record; v_week_ch bigint; v_week_net bigint; v_methods jsonb; v_rem jsonb; v_wa jsonb;
begin
  perform app_private.assert_admin();
  v_today := (now() at time zone app_private.tz())::date; v_week := app_private.week_start_of(v_today);
  select jsonb_build_object('total', count(*), 'active', count(*) filter (where status = 'active'), 'inactive', count(*) filter (where status = 'inactive'),
    'suspended', count(*) filter (where status = 'suspended'), 'pending_approval', count(*) filter (where status = 'pending_approval')) into v_drivers from public.drivers;
  select coalesce(sum(p.pending_cents), 0)::bigint pending, coalesce(sum(p.credit_cents), 0)::bigint credit, count(distinct p.driver_id) filter (where p.pending_cents > 0) debtors
    into v_pos from public.v_assignment_position p;
  select coalesce(sum(gross_cents), 0)::bigint g, coalesce(sum(commission_cents), 0)::bigint c, coalesce(sum(net_cents), 0)::bigint n into v_pay
    from public.payments where voided_at is null and (paid_at at time zone app_private.tz())::date = v_today;
  select coalesce(sum(amount_cents), 0)::bigint into v_week_ch from public.charges where week_start = v_week;
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

create function public.weekly_collection_table(p_week_start date)
returns table (assignment_id uuid, driver_id uuid, unit_id uuid, unit_code text, operator_code text, national_id text, full_name text,
  driver_status text, daily_rate_cents bigint, week_charged_cents bigint, day_net_cents bigint[], gross_cents bigint, commission_cents bigint,
  net_cents bigint, week_diff_cents bigint, pending_cents bigint, credit_cents bigint, week_closed boolean)
language plpgsql stable security invoker set search_path = '' as $$
declare v_tz text := app_private.tz(); v_end date := p_week_start + 6;
begin
  perform app_private.assert_admin();
  if extract(isodow from p_week_start) <> 1 then raise exception 'week_start_must_be_monday' using errcode = '22023'; end if;
  return query
  select x.assignment_id, x.driver_id, x.unit_id, x.unit_code, x.operator_code, x.national_id, x.full_name, x.driver_status, x.daily_rate_cents, x.week_charged_cents,
         x.day_net_cents, x.gross_cents, x.commission_cents, x.net_cents, (x.net_cents - x.week_charged_cents), x.pending_cents, x.credit_cents, x.week_closed
  from (
    select a.id as assignment_id, d.id as driver_id, u.id as unit_id, u.code as unit_code, d.operator_code, d.national_id, btrim(d.first_name || ' ' || d.last_name) as full_name,
           d.status as driver_status,
           coalesce((select r.daily_amount_cents from public.rates r where r.assignment_id = a.id and r.valid_from <= v_end and (r.valid_to is null or r.valid_to >= p_week_start)
                      order by r.valid_from desc limit 1), 0)::bigint as daily_rate_cents,
           coalesce((select sum(c.amount_cents) from public.charges c where c.assignment_id = a.id and c.week_start = p_week_start), 0)::bigint as week_charged_cents,
           array(select coalesce((select sum(p.net_cents) from public.payments p where p.assignment_id = a.id and p.voided_at is null
                                    and (p.paid_at at time zone v_tz)::date = p_week_start + i), 0)::bigint from generate_series(0, 6) i) as day_net_cents,
           coalesce((select sum(p.gross_cents) from public.payments p where p.assignment_id = a.id and p.voided_at is null and p.week_start = p_week_start), 0)::bigint as gross_cents,
           coalesce((select sum(p.commission_cents) from public.payments p where p.assignment_id = a.id and p.voided_at is null and p.week_start = p_week_start), 0)::bigint as commission_cents,
           coalesce((select sum(p.net_cents) from public.payments p where p.assignment_id = a.id and p.voided_at is null and p.week_start = p_week_start), 0)::bigint as net_cents,
           pos.pending_cents, pos.credit_cents,
           exists (select 1 from public.weekly_closures w where w.assignment_id = a.id and w.week_start = p_week_start) as week_closed
      from public.assignments a join public.drivers d on d.id = a.driver_id join public.units u on u.id = a.unit_id
      cross join lateral public.assignment_position(a.id, v_end) pos
     where a.valid_from <= v_end and (a.valid_to is null or a.valid_to >= p_week_start)
  ) x order by x.unit_code;
end $$;

-- ───────── Resúmenes por período ─────────
create function public.period_summary(p_from date, p_to date) returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare v_tz text := app_private.tz(); v_exp bigint; v_adj bigint; v_pay record; v_recovered bigint; v_to_period bigint; v_end record;
begin
  perform app_private.assert_admin();
  if p_to < p_from or p_to - p_from > 400 then raise exception 'invalid_range' using errcode = '22023'; end if;
  select coalesce(sum(amount_cents) filter (where kind = 'daily'), 0), coalesce(sum(amount_cents) filter (where kind = 'adjustment'), 0)
    into v_exp, v_adj from public.charges where charge_date between p_from and p_to;
  select count(*) n, coalesce(sum(gross_cents), 0) g, coalesce(sum(commission_cents), 0) c, coalesce(sum(net_cents), 0) nt,
         coalesce(sum(applied_cents), 0) ap, coalesce(sum(credit_generated_cents), 0) cr into v_pay
    from public.payments where voided_at is null and (paid_at at time zone v_tz)::date between p_from and p_to;
  select coalesce(sum(pa.amount_cents) filter (where c.charge_date < p_from), 0), coalesce(sum(pa.amount_cents) filter (where c.charge_date between p_from and p_to), 0)
    into v_recovered, v_to_period from public.payment_allocations pa join public.payments p on p.id = pa.payment_id join public.charges c on c.id = pa.charge_id
   where p.voided_at is null and (p.paid_at at time zone v_tz)::date between p_from and p_to;
  select coalesce(sum(pos.pending_cents), 0) pend, coalesce(sum(pos.credit_cents), 0) cred, count(*) filter (where pos.pending_cents > 0) debtors into v_end
    from public.assignments a cross join lateral public.assignment_position(a.id, p_to) pos where a.valid_from <= p_to;
  return jsonb_build_object('from', p_from, 'to', p_to, 'charges_generated_cents', v_exp, 'adjustments_charged_cents', v_adj, 'expected_cents', v_exp,
    'payments_count', v_pay.n, 'gross_cents', v_pay.g, 'commission_cents', v_pay.c, 'net_cents', v_pay.nt, 'applied_cents', v_pay.ap,
    'applied_to_period_cents', v_to_period, 'prior_debt_recovered_cents', v_recovered, 'credits_generated_cents', v_pay.cr,
    'pending_end_cents', v_end.pend, 'credits_end_cents', v_end.cred, 'drivers_with_debt_end', v_end.debtors,
    'difference_cents', v_pay.nt - v_exp, 'recovery_pct', case when v_exp > 0 then round(v_pay.nt * 100.0 / v_exp, 1) end);
end $$;

create function public.period_detail(p_from date, p_to date, p_indicator text)
returns table (occurred_on date, kind text, unit_code text, operator_code text, full_name text, amount_cents bigint, detail text)
language plpgsql stable security invoker set search_path = '' as $$
declare v_tz text := app_private.tz();
begin
  perform app_private.assert_admin();
  if p_indicator = 'charges' then
    return query select c.charge_date, c.kind, u.code, d.operator_code, btrim(d.first_name || ' ' || d.last_name), c.amount_cents::bigint, null::text
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

create function public.period_series(p_from date, p_to date)
returns table (week_start date, expected_cents bigint, gross_cents bigint, commission_cents bigint, net_cents bigint,
  pending_end_cents bigint, credits_end_cents bigint, difference_cents bigint, recovery_pct numeric)
language plpgsql stable security invoker set search_path = '' as $$
begin
  perform app_private.assert_admin();
  if p_to - p_from > 400 then raise exception 'invalid_range' using errcode = '22023'; end if;
  return query
  select w.d, (s ->> 'expected_cents')::bigint, (s ->> 'gross_cents')::bigint, (s ->> 'commission_cents')::bigint, (s ->> 'net_cents')::bigint,
         (s ->> 'pending_end_cents')::bigint, (s ->> 'credits_end_cents')::bigint, (s ->> 'difference_cents')::bigint, (s ->> 'recovery_pct')::numeric
    from (select g::date d from generate_series(app_private.week_start_of(p_from)::timestamp, p_to::timestamp, interval '7 days') g) w
    cross join lateral (select public.period_summary(w.d, w.d + 6) s) y order by w.d;
end $$;

-- ───────── Aplicar una importación aprobada al directorio ─────────
-- Crea/vincula conductores, unidades, asignaciones y tarifas SOLO con datos inequívocos. Importes, SALDO y ACUERDO NO pasan a finanzas.
create function public.apply_import(p_import_id uuid, p_valid_from date default null, p_initial_status text default 'active') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_imp record; v_from date; g record; v_drv uuid; v_unit uuid; v_asg uuid; v_existing_asg record;
  v_nid text[]; v_units text[]; v_rates bigint[]; v_name text; v_created_driver boolean; v_note text; v_action text;
  c_drivers_created int := 0; c_drivers_linked int := 0; c_units_created int := 0; c_asg_created int := 0; c_rates_created int := 0;
  c_skipped int := 0; c_rejected int := 0; c_excluded int := 0; v_issues jsonb := '[]'::jsonb;
begin
  perform app_private.assert_admin();
  select i.* into v_imp from public.excel_imports i where i.id = p_import_id for update;
  if not found then raise exception 'import_not_found' using errcode = 'P0002'; end if;
  if v_imp.status = 'applied' then raise exception 'import_already_applied' using errcode = '22023'; end if;
  if v_imp.status <> 'confirmed' then raise exception 'import_not_confirmed' using errcode = '22023'; end if;
  if p_initial_status not in ('active', 'inactive', 'pending_approval') then raise exception 'invalid_status' using errcode = '22023'; end if;
  v_from := coalesce(p_valid_from, (now() at time zone app_private.tz())::date);   -- fecha de alta en VIP, nunca la de un bloque

  update public.import_rows r set applied_action = 'excluded', applied_note = 'no aprobada'
    from public.import_blocks b where b.id = r.block_id and b.import_id = p_import_id and r.review_status <> 'approved';
  get diagnostics c_excluded = row_count;
  update public.import_rows r set applied_action = 'rejected',
      applied_note = case when r.match_status in ('ignored','conflict','duplicate') then 'estado de conciliación: ' || r.match_status
                          when coalesce(btrim(r.operator_code), '') = '' then 'sin código de operador' else 'sin cédula' end
    from public.import_blocks b where b.id = r.block_id and b.import_id = p_import_id and r.review_status = 'approved'
     and (r.match_status in ('ignored','conflict','duplicate') or coalesce(btrim(r.operator_code), '') = '' or coalesce(btrim(r.national_id), '') = '');
  get diagnostics c_rejected = row_count;

  for g in select btrim(r.operator_code) as op, array_agg(r.id) as row_ids from public.import_rows r join public.import_blocks b on b.id = r.block_id
            where b.import_id = p_import_id and r.review_status = 'approved' and r.applied_action is null group by btrim(r.operator_code) loop
    select array_agg(distinct btrim(r.national_id)), array_agg(distinct upper(btrim(r.unit_code))) filter (where coalesce(btrim(r.unit_code), '') <> ''),
           array_agg(distinct r.daily_rate_cents) filter (where r.daily_rate_cents > 0)
      into v_nid, v_units, v_rates from public.import_rows r where r.id = any (g.row_ids);
    if cardinality(v_nid) > 1 then
      update public.import_rows set applied_action = 'skipped', applied_note = 'cédulas distintas para el mismo operador' where id = any (g.row_ids);
      c_skipped := c_skipped + 1; v_issues := v_issues || jsonb_build_object('operator', g.op, 'issue', 'national_id_ambiguous'); continue;
    end if;
    select r.full_name into v_name from public.import_rows r join public.import_blocks b on b.id = r.block_id
     where r.id = any (g.row_ids) and coalesce(btrim(r.full_name), '') <> '' group by r.full_name order by count(*) desc, max(b.block_index) desc limit 1;

    select d.id into v_drv from public.drivers d where d.operator_code = g.op or d.national_id = v_nid[1] order by (d.operator_code = g.op) desc limit 1;
    v_created_driver := false;
    if v_drv is null then
      insert into public.drivers(operator_code, national_id, first_name, last_name, status)
      values (g.op, v_nid[1], coalesce(nullif(btrim(v_name), ''), 'Sin nombre'), '', p_initial_status) returning id into v_drv;
      v_created_driver := true; c_drivers_created := c_drivers_created + 1;
    else
      if exists (select 1 from public.drivers where id = v_drv and (operator_code <> g.op or national_id <> v_nid[1])) then
        update public.import_rows set applied_action = 'skipped', applied_note = 'el operador y la cédula apuntan a conductores distintos' where id = any (g.row_ids);
        c_skipped := c_skipped + 1; v_issues := v_issues || jsonb_build_object('operator', g.op, 'issue', 'identity_conflict'); continue;
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

  update public.excel_imports set status = 'applied', applied_by = auth.uid(), applied_at = now(),
    summary = summary || jsonb_build_object('applied', jsonb_build_object('drivers_created', c_drivers_created, 'drivers_linked', c_drivers_linked,
      'units_created', c_units_created, 'assignments_created', c_asg_created, 'rates_created', c_rates_created, 'skipped', c_skipped,
      'rows_rejected', c_rejected, 'rows_excluded', c_excluded, 'valid_from', v_from, 'issues', v_issues)) where id = p_import_id;
  perform app_private.audit('apply_import', 'excel_imports', p_import_id, jsonb_build_object('drivers_created', c_drivers_created, 'drivers_linked', c_drivers_linked,
    'units_created', c_units_created, 'assignments_created', c_asg_created, 'rates_created', c_rates_created));
  return (select summary -> 'applied' from public.excel_imports where id = p_import_id);
end $$;

-- ───────── Unidades, asignaciones y tarifas (atómicas; nunca reescriben cargos ya generados) ─────────
create function public.start_assignment(p_driver_id uuid, p_unit_id uuid, p_valid_from date, p_daily_cents bigint default null, p_agreement_note text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform app_private.assert_admin();
  if not exists (select 1 from public.drivers where id = p_driver_id) or not exists (select 1 from public.units where id = p_unit_id) then
    raise exception 'assignment_not_found' using errcode = 'P0002'; end if;
  if p_daily_cents is not null and p_daily_cents < 0 then raise exception 'invalid_amount' using errcode = '22023'; end if;
  begin
    insert into public.assignments(driver_id, unit_id, valid_from, agreement_note) values (p_driver_id, p_unit_id, p_valid_from, nullif(btrim(p_agreement_note), '')) returning id into v_id;
  exception when exclusion_violation then raise exception 'assignment_overlap' using errcode = '23P01'; end;
  if p_daily_cents is not null then insert into public.rates(assignment_id, daily_amount_cents, valid_from) values (v_id, p_daily_cents, p_valid_from); end if;
  perform app_private.audit('start_assignment', 'assignments', v_id, jsonb_build_object('driver_id', p_driver_id, 'unit_id', p_unit_id, 'valid_from', p_valid_from, 'daily_cents', p_daily_cents));
  return v_id;
end $$;

create function public.end_assignment(p_assignment_id uuid, p_end_date date) returns void
language plpgsql security definer set search_path = '' as $$
declare a record;
begin
  perform app_private.assert_admin();
  select * into a from public.assignments where id = p_assignment_id for update;
  if not found then raise exception 'assignment_not_found' using errcode = 'P0002'; end if;
  if a.valid_to is not null then raise exception 'assignment_already_ended' using errcode = '22023'; end if;
  if p_end_date < a.valid_from then raise exception 'invalid_dates' using errcode = '22023'; end if;
  update public.assignments set valid_to = p_end_date where id = p_assignment_id;
  update public.rates set valid_to = p_end_date where assignment_id = p_assignment_id and (valid_to is null or valid_to > p_end_date);
  perform app_private.audit('end_assignment', 'assignments', p_assignment_id, jsonb_build_object('end_date', p_end_date));
end $$;

create function public.reassign_unit(p_unit_id uuid, p_new_driver_id uuid, p_valid_from date, p_daily_cents bigint default null, p_agreement_note text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare cur record;
begin
  perform app_private.assert_admin();
  select * into cur from public.assignments where unit_id = p_unit_id and valid_to is null for update;
  if found then
    if p_valid_from <= cur.valid_from then raise exception 'invalid_dates' using errcode = '22023'; end if;
    update public.assignments set valid_to = p_valid_from - 1 where id = cur.id;
    update public.rates set valid_to = p_valid_from - 1 where assignment_id = cur.id and valid_to is null;
  end if;
  if exists (select 1 from public.assignments where driver_id = p_new_driver_id and valid_to is null) then raise exception 'driver_already_assigned' using errcode = '23P01'; end if;
  return public.start_assignment(p_new_driver_id, p_unit_id, p_valid_from, p_daily_cents, p_agreement_note);
end $$;

create function public.change_rate(p_assignment_id uuid, p_new_daily_cents bigint, p_from date) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare a record; cur record; v_existing int;
begin
  perform app_private.assert_admin();
  select * into a from public.assignments where id = p_assignment_id for update;
  if not found then raise exception 'assignment_not_found' using errcode = 'P0002'; end if;
  if p_new_daily_cents is null or p_new_daily_cents < 0 then raise exception 'invalid_amount' using errcode = '22023'; end if;
  if p_from < a.valid_from or (a.valid_to is not null and p_from > a.valid_to) then raise exception 'invalid_dates' using errcode = '22023'; end if;
  select * into cur from public.rates where assignment_id = p_assignment_id and valid_to is null;
  if found then
    if p_from <= cur.valid_from then raise exception 'invalid_dates' using errcode = '22023'; end if;
    update public.rates set valid_to = p_from - 1 where id = cur.id;
  end if;
  insert into public.rates(assignment_id, daily_amount_cents, valid_from, valid_to) values (p_assignment_id, p_new_daily_cents, p_from, a.valid_to);
  select count(*) into v_existing from public.charges where assignment_id = p_assignment_id and kind = 'daily' and charge_date >= p_from;
  perform app_private.audit('change_rate', 'assignments', p_assignment_id, jsonb_build_object('new_daily_cents', p_new_daily_cents, 'from', p_from,
    'previous_daily_cents', cur.daily_amount_cents, 'existing_charges_from_date', v_existing));
  return jsonb_build_object('assignment_id', p_assignment_id, 'from', p_from, 'existing_charges_from_date_unchanged', v_existing);
end $$;

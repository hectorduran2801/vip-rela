-- VIP · 0038 · {{saldo_total}} = SALDO del Excel + lo que falta de las cuotas de la semana hasta hoy (cuotas previstas − pagos del Excel).
--   Ejemplo: SALDO 100, cuota $30 de lunes a sábado. Lunes paga 30 → debe 100. Martes paga 25 → le faltan 5 → debe 105.
--   Si paga de más, lo sobrante cubre cuotas siguientes; si el neto queda a favor, se comunica como saldo a favor.
-- Reemplaza la fórmula de 0037 (SALDO + solo la cuota de hoy). No toca datos. Reversible: volver a la función de 0037.
set search_path = public, extensions;

create function app_private.saldo_total(p_assignment uuid, p_date date)
returns table (managed boolean, saldo_cents bigint, total_cents bigint, cuota_hoy_cents bigint, pagado_cents bigint)
language plpgsql stable security definer set search_path = '' as $$
declare e record; v_acc bigint := 0; v_paid bigint := 0; v_plan bigint;
begin
  select * into e from app_private.excel_saldo(p_assignment);
  v_plan := coalesce(public.planned_daily_cents(p_assignment, p_date), 0);
  if e.managed and e.week_start is not null and e.week_start <= p_date then
    select coalesce(sum(public.planned_daily_cents(p_assignment, d::date)), 0)::bigint into v_acc from generate_series(e.week_start, p_date, interval '1 day') d;
    select coalesce(sum(p.amount_cents), 0)::bigint into v_paid from public.excel_payment_days p where p.assignment_id = p_assignment and p.pay_date between e.week_start and p_date;
  end if;
  return query select e.managed, e.saldo_cents, case when e.saldo_cents is null then null else e.saldo_cents + v_acc - v_paid end, v_plan, v_paid;
end $$;
revoke all on function app_private.saldo_total(uuid, date) from public, anon, authenticated;
grant execute on function app_private.saldo_total(uuid, date) to authenticated, service_role;

create function app_private.fill_text(p_text text, p_monto bigint, p_saldo bigint, p_cuota bigint, p_pagos bigint) returns text language sql immutable set search_path = '' as $$
  select replace(replace(replace(replace(p_text, '{monto}', app_private.fmt_usd(p_monto)), '{saldo}', app_private.fmt_usd(greatest(coalesce(p_saldo, 0), 0))),
         '{cuota}', app_private.fmt_usd(coalesce(p_cuota, 0))), '{pagos}', app_private.fmt_usd(coalesce(p_pagos, 0))) $$;
revoke all on function app_private.fill_text(text, bigint, bigint, bigint, bigint) from public, anon, authenticated;
grant execute on function app_private.fill_text(text, bigint, bigint, bigint, bigint) to authenticated, service_role;

create or replace function app_private.template_vars(p_assignment uuid, p_date date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_rate bigint; v_today bigint; v_ag text; v_tz text := app_private.tz(); v jsonb; e record; v_plan bigint; v_tot bigint; v_paid bigint; t record;
begin
  select r.daily_amount_cents into v_rate from public.rates r where r.assignment_id = p_assignment and r.valid_from <= p_date and (r.valid_to is null or r.valid_to >= p_date)
   order by r.valid_from desc limit 1;
  select coalesce(sum(p.net_cents), 0)::bigint into v_today from public.payments p
   where p.assignment_id = p_assignment and p.voided_at is null and (p.paid_at at time zone v_tz)::date = p_date;
  select nullif(btrim(u.agreement), '') into v_ag from public.assignments a join public.units u on u.id = a.unit_id where a.id = p_assignment;
  v := app_private.template_vars_core(p_assignment, p_date) || jsonb_build_object(
    'cuota_diaria', case when v_rate is null then null else app_private.fmt_usd(v_rate) end,
    'pago_hoy', app_private.fmt_usd(v_today), 'acuerdo', v_ag,
    'dia_semana', (array['domingo','lunes','martes','miércoles','jueves','viernes','sábado'])[extract(dow from p_date)::int + 1]);
  select * into t from app_private.saldo_total(p_assignment, p_date);
  if t.managed then
    -- Saldo total = SALDO del Excel + lo que falta de las cuotas de la semana hasta hoy (ver app_private.saldo_total). Ej.: SALDO 100, cuota 30; lunes paga 30, martes 25 → 105.
    v_plan := t.cuota_hoy_cents; v_paid := t.pagado_cents; v_tot := t.total_cents;
    v := v || jsonb_build_object(
      'cuota_hoy', app_private.fmt_usd(v_plan),
      'saldo_total', case when v_tot is null then null else app_private.fmt_usd(greatest(v_tot, 0)) end,
      'deuda_anterior', case when t.saldo_cents is null then null else app_private.fmt_usd(greatest(t.saldo_cents, 0)) end,
      'credito', case when v_tot is null then null else app_private.fmt_usd(greatest(-v_tot, 0)) end,
      'detalle_deuda', case when v_tot is null then null
                            when v_tot > 0 then app_private.fill_text(app_private.template_text('detalle_pendiente'), v_tot, t.saldo_cents, v_plan, v_paid)
                            when v_tot < 0 then app_private.fill_text(app_private.template_text('detalle_credito'), -v_tot, t.saldo_cents, v_plan, v_paid)
                            else app_private.fill_text(app_private.template_text('detalle_al_dia'), 0, t.saldo_cents, v_plan, v_paid) end,
      'pendiente_hoy', null, 'deuda_semanal', null, 'cuenta_semana', null);
  end if;
  return v;
end $$;

create or replace function public.template_variables()
returns table ("group" text, code text, label text, description text, example text)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app_private.assert_staff();
  return query select b."group", b.code, coalesce(s.label, case b.code when 'saldo_total' then 'Saldo total' else b.label end),
    coalesce(s.description, case b.code when 'saldo_total' then 'Lo que debe hoy: el SALDO del Excel (semanas anteriores) + lo que falta de las cuotas de la semana hasta hoy (cuotas lunes–sábado menos lo pagado). Si el Excel nunca trajo SALDO, queda sin resolver y no se envía.'
                                        when 'cuota_hoy' then 'Cuota prevista de hoy según la tarifa vigente ($0.00 si hoy no hay cuota).'
                                        when 'deuda_anterior' then 'Solo el SALDO del Excel, sin la cuota de hoy.' else b.description end),
    b.example
    from public.template_variables_base() b left join public.template_variable_settings s on s.code = b.code;
end $$;
revoke all on function public.template_variables() from public, anon, authenticated;
grant execute on function public.template_variables() to authenticated, service_role;


-- ───────── Texto mostrado (ejemplo) editable y marcadores en las frases ─────────
alter table public.template_variable_settings add column example text check (example is null or char_length(example) <= 120);

create or replace function public.template_variables()
returns table ("group" text, code text, label text, description text, example text)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app_private.assert_staff();
  return query select b."group", b.code, coalesce(s.label, case b.code when 'saldo_total' then 'Saldo total' else b.label end),
    coalesce(s.description, case b.code when 'saldo_total' then 'Lo que debe hoy: el SALDO del Excel (semanas anteriores) + lo que falta de las cuotas de la semana hasta hoy (cuotas lunes–sábado menos lo pagado). Si el Excel nunca trajo SALDO, queda sin resolver y no se envía.'
                                        when 'cuota_hoy' then 'Cuota prevista de hoy según la tarifa vigente ($0.00 si hoy no hay cuota).'
                                        when 'deuda_anterior' then 'Solo el SALDO del Excel, sin las cuotas de la semana.' else b.description end),
    coalesce(s.example, b.example)
    from public.template_variables_base() b left join public.template_variable_settings s on s.code = b.code;
end $$;

drop function public.template_variable_editor();
create function public.template_variable_editor()
returns table ("group" text, code text, label text, description text, example text, customized boolean, default_label text, default_description text, default_example text)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app_private.assert_admin();
  return query select b."group", b.code, coalesce(s.label, b.label), coalesce(s.description, b.description), coalesce(s.example, b.example), (s.code is not null), b.label, b.description, b.example
    from public.template_variables_base() b left join public.template_variable_settings s on s.code = b.code;
end $$;
drop function public.save_template_variable(text, text, text);
create function public.save_template_variable(p_code text, p_label text, p_description text, p_example text default null) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.assert_admin();
  if not exists (select 1 from public.template_variables_base() b where b.code = p_code) then raise exception 'variable_not_found' using errcode = 'P0002'; end if;
  if nullif(btrim(p_label), '') is null then raise exception 'invalid_label' using errcode = '22023'; end if;
  insert into public.template_variable_settings(code, label, description, example, updated_by)
  values (p_code, btrim(p_label), nullif(btrim(coalesce(p_description, '')), ''), nullif(btrim(coalesce(p_example, '')), ''), auth.uid())
  on conflict (code) do update set label = excluded.label, description = excluded.description, example = excluded.example, updated_by = auth.uid(), updated_at = now();
  perform app_private.audit('template_variable.saved', 'template_variable_settings', null, jsonb_build_object('code', p_code));
end $$;

create or replace function public.save_template_text(p_key text, p_text text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.assert_admin();
  if p_key not in ('detalle_pendiente','detalle_al_dia','detalle_credito') then raise exception 'variable_not_found' using errcode = 'P0002'; end if;
  if nullif(btrim(p_text), '') is null or char_length(p_text) > 300 then raise exception 'invalid_text' using errcode = '22023'; end if;
  if p_text ~ '\{\{' then raise exception 'text_no_variables' using errcode = '22023'; end if;
  if regexp_replace(p_text, '\{(monto|saldo|cuota|pagos)\}', '', 'g') ~ '[{}]' then raise exception 'text_bad_marker' using errcode = '22023'; end if;
  insert into public.template_text_settings(key, text, updated_by) values (p_key, btrim(p_text), auth.uid())
  on conflict (key) do update set text = excluded.text, updated_by = auth.uid(), updated_at = now();
  perform app_private.audit('template_text.saved', 'template_text_settings', null, jsonb_build_object('key', p_key));
end $$;

revoke all on function public.template_variable_editor(), public.save_template_variable(text, text, text, text), public.save_template_text(text, text) from public, anon;
grant execute on function public.template_variable_editor(), public.save_template_variable(text, text, text, text), public.save_template_text(text, text) to authenticated, service_role;

-- Las audiencias «con/sin saldo» usan el MISMO saldo total que el mensaje.
create or replace function app_private.send_schedule_audience(p_audience text, p_date date)
returns table (assignment_id uuid, driver_id uuid, saldo_cents bigint, managed boolean, paid_today_cents bigint)
language sql stable security definer set search_path = '' as $$
  select x.id, x.driver_id, x.saldo, x.managed, x.paid from (
    select a.id, a.driver_id, t.total_cents as saldo, t.managed,
           coalesce((select sum(p.amount_cents) from public.excel_payment_days p where p.assignment_id = a.id and p.pay_date = p_date), 0)::bigint as paid
      from public.assignments a join public.drivers d on d.id = a.driver_id
      cross join lateral app_private.saldo_total(a.id, p_date) t
     where a.valid_from <= p_date and (a.valid_to is null or a.valid_to > p_date) and d.status = 'active' and d.phone_e164 is not null) x
  where case p_audience
    when 'all' then true
    when 'with_balance' then coalesce(x.saldo, 0) > 0
    when 'without_balance' then x.saldo is not null and x.saldo <= 0
    when 'not_paid_today' then x.managed and x.paid = 0
    when 'paid_today' then x.managed and x.paid > 0
    else false end
$$;

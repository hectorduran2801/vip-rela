-- VIP · 0037 · Variables editables + {{saldo_total}} con la cuota del día.
--   · {{saldo_total}} (unidades gestionadas por el Excel) = SALDO del Excel + cuota prevista de HOY (0 si hoy no hay cuota). {{deuda_anterior}} sigue siendo solo el SALDO.
--   · {{cuota_hoy}} (gestionadas) = cuota prevista de hoy según la tarifa vigente (no depende de que el motor ya haya generado el cargo).
--   · Las frases de {{detalle_deuda}} y los nombres/descripciones del catálogo se pueden editar (solo ADMIN); se puede restablecer lo original.
-- No modifica cargos, pagos, plantillas ni mensajes. Reversible: restablecer template_vars (0032) y template_variables (0032) y borrar las dos tablas.
set search_path = public, extensions;

create table public.template_variable_settings (
  code text primary key, label text, description text,
  updated_by uuid references auth.users(id) on delete set null, updated_at timestamptz not null default now(),
  check (label is null or char_length(btrim(label)) between 1 and 60), check (description is null or char_length(description) <= 400));
create table public.template_text_settings (
  key text primary key check (key in ('detalle_pendiente','detalle_al_dia','detalle_credito')), text text not null check (char_length(btrim(text)) between 1 and 300),
  updated_by uuid references auth.users(id) on delete set null, updated_at timestamptz not null default now());
alter table public.template_variable_settings enable row level security;
alter table public.template_text_settings enable row level security;
revoke all on public.template_variable_settings, public.template_text_settings from anon, authenticated;

create function app_private.template_text_default(p_key text) returns text language sql immutable set search_path = '' as $$
  select case p_key when 'detalle_pendiente' then 'Su saldo pendiente es de {monto}.' when 'detalle_al_dia' then 'Su cuenta está al día.'
                    when 'detalle_credito' then 'Su cuenta está al día y tiene un saldo a favor de {monto}.' end $$;
create function app_private.template_text(p_key text) returns text language sql stable security definer set search_path = '' as $$
  select coalesce((select t.text from public.template_text_settings t where t.key = p_key), app_private.template_text_default(p_key)) $$;
revoke all on function app_private.template_text_default(text), app_private.template_text(text) from public, anon, authenticated;
grant execute on function app_private.template_text_default(text), app_private.template_text(text) to authenticated, service_role;

-- ───────── Variables de WhatsApp ─────────
create or replace function app_private.template_vars(p_assignment uuid, p_date date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_rate bigint; v_today bigint; v_ag text; v_tz text := app_private.tz(); v jsonb; e record; v_plan bigint; v_tot bigint;
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
  select * into e from app_private.excel_saldo(p_assignment);
  if e.managed then
    v_plan := coalesce(public.planned_daily_cents(p_assignment, p_date), 0);
    v_tot := case when e.saldo_cents is null then null else e.saldo_cents + v_plan end;       -- SALDO del Excel + cuota de hoy
    v := v || jsonb_build_object(
      'cuota_hoy', app_private.fmt_usd(v_plan),
      'saldo_total', case when v_tot is null then null else app_private.fmt_usd(greatest(v_tot, 0)) end,
      'deuda_anterior', case when e.saldo_cents is null then null else app_private.fmt_usd(greatest(e.saldo_cents, 0)) end,
      'credito', case when v_tot is null then null else app_private.fmt_usd(greatest(-v_tot, 0)) end,
      'detalle_deuda', case when v_tot is null then null
                            when v_tot > 0 then replace(app_private.template_text('detalle_pendiente'), '{monto}', app_private.fmt_usd(v_tot))
                            when v_tot < 0 then replace(app_private.template_text('detalle_credito'), '{monto}', app_private.fmt_usd(-v_tot))
                            else app_private.template_text('detalle_al_dia') end,
      'pendiente_hoy', null, 'deuda_semanal', null, 'cuenta_semana', null);
  end if;
  return v;
end $$;

-- ───────── Catálogo con textos editables ─────────
alter function public.template_variables() rename to template_variables_base;
revoke all on function public.template_variables_base() from public, anon, authenticated;
grant execute on function public.template_variables_base() to service_role;
create function public.template_variables()
returns table ("group" text, code text, label text, description text, example text)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app_private.assert_staff();
  return query select b."group", b.code, coalesce(s.label, case b.code when 'saldo_total' then 'Saldo total' else b.label end),
    coalesce(s.description, case b.code when 'saldo_total' then 'Saldo del Excel + la cuota de hoy (si hoy hay cuota). Si el Excel nunca trajo SALDO, queda sin resolver y no se envía.'
                                        when 'cuota_hoy' then 'Cuota prevista de hoy según la tarifa vigente ($0.00 si hoy no hay cuota).'
                                        when 'deuda_anterior' then 'Solo el SALDO del Excel, sin la cuota de hoy.' else b.description end),
    b.example
    from public.template_variables_base() b left join public.template_variable_settings s on s.code = b.code;
end $$;
revoke all on function public.template_variables() from public, anon, authenticated;
grant execute on function public.template_variables() to authenticated, service_role;

-- Editor: valor vigente, original y si fue personalizado.
create function public.template_variable_editor()
returns table ("group" text, code text, label text, description text, example text, customized boolean, default_label text, default_description text)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app_private.assert_admin();
  return query select b."group", b.code, coalesce(s.label, b.label), coalesce(s.description, b.description), b.example, (s.code is not null), b.label, b.description
    from public.template_variables_base() b left join public.template_variable_settings s on s.code = b.code;
end $$;
create function public.save_template_variable(p_code text, p_label text, p_description text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_default record;
begin
  perform app_private.assert_admin();
  select * into v_default from public.template_variables_base() b where b.code = p_code;
  if not found then raise exception 'variable_not_found' using errcode = 'P0002'; end if;
  if nullif(btrim(p_label), '') is null then raise exception 'invalid_label' using errcode = '22023'; end if;
  insert into public.template_variable_settings(code, label, description, updated_by) values (p_code, btrim(p_label), nullif(btrim(coalesce(p_description, '')), ''), auth.uid())
  on conflict (code) do update set label = excluded.label, description = excluded.description, updated_by = auth.uid(), updated_at = now();
  perform app_private.audit('template_variable.saved', 'template_variable_settings', null, jsonb_build_object('code', p_code));
end $$;
create function public.reset_template_variable(p_code text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.assert_admin();
  delete from public.template_variable_settings where code = p_code;
  perform app_private.audit('template_variable.reset', 'template_variable_settings', null, jsonb_build_object('code', p_code));
end $$;

create function public.list_template_texts() returns table (key text, title text, text text, default_text text, customized boolean, example text)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app_private.assert_admin();
  return query select k.key, k.title, app_private.template_text(k.key), app_private.template_text_default(k.key), exists (select 1 from public.template_text_settings t where t.key = k.key), k.example
    from (values ('detalle_pendiente','Cuando debe dinero','Usa {monto} para el saldo total.','$79.00'),
                 ('detalle_al_dia','Cuando está al día','Sin importes.','—'),
                 ('detalle_credito','Cuando tiene saldo a favor','Usa {monto} para el saldo a favor.','$10.00')) k(key, title, example0, example)
   order by k.key desc;
end $$;
create function public.save_template_text(p_key text, p_text text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.assert_admin();
  if p_key not in ('detalle_pendiente','detalle_al_dia','detalle_credito') then raise exception 'variable_not_found' using errcode = 'P0002'; end if;
  if nullif(btrim(p_text), '') is null or char_length(p_text) > 300 then raise exception 'invalid_text' using errcode = '22023'; end if;
  if p_key <> 'detalle_al_dia' and position('{monto}' in p_text) = 0 then raise exception 'text_needs_amount' using errcode = '22023'; end if;
  if p_text ~ '\{\{' then raise exception 'text_no_variables' using errcode = '22023'; end if;
  insert into public.template_text_settings(key, text, updated_by) values (p_key, btrim(p_text), auth.uid())
  on conflict (key) do update set text = excluded.text, updated_by = auth.uid(), updated_at = now();
  perform app_private.audit('template_text.saved', 'template_text_settings', null, jsonb_build_object('key', p_key));
end $$;
create function public.reset_template_text(p_key text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.assert_admin();
  delete from public.template_text_settings where key = p_key;
  perform app_private.audit('template_text.reset', 'template_text_settings', null, jsonb_build_object('key', p_key));
end $$;
revoke all on function public.template_variable_editor(), public.save_template_variable(text, text, text), public.reset_template_variable(text),
  public.list_template_texts(), public.save_template_text(text, text), public.reset_template_text(text) from public, anon;
grant execute on function public.template_variable_editor(), public.save_template_variable(text, text, text), public.reset_template_variable(text),
  public.list_template_texts(), public.save_template_text(text, text), public.reset_template_text(text) to authenticated, service_role;

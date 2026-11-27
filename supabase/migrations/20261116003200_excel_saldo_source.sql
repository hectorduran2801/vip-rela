-- VIP · 0032 · El SALDO que ve y recibe el conductor es el del Excel (último saldo válido importado); el motor de cuotas queda como cálculo interno.
-- Para toda asignación que ya pasó por la importación del Excel («gestionada por el Excel»):
--   · saldo pendiente (Cobranza, Inicio, ficha, variable {{saldo_total}}/{{deuda_anterior}}) = último SALDO no vacío importado (collection_week_units.saldo_excel_cents, semana más reciente);
--   · si el Excel nunca trajo SALDO para la unidad → «sin saldo» (la variable queda sin resolver y no se envía; nunca se inventa un cero ni se usa el cálculo interno);
--   · crédito = saldo negativo del Excel; {{detalle_deuda}} se redacta con ese saldo;
--   · las variables que dependen del devengo interno ({{pendiente_hoy}}, {{deuda_semanal}}, {{cuenta_semana}}) quedan sin resolver y salen del selector.
-- Las asignaciones que NUNCA pasaron por el Excel conservan el cálculo anterior. No se modifican cargos, pagos ni ajustes.
-- Reversible: restablecer template_vars (0027), template_variables (0029) y dashboard_summary (0019).
set search_path = public, extensions;

create function app_private.excel_saldo(p_assignment uuid) returns table (managed boolean, saldo_cents bigint, week_start date)
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.collection_week_units w where w.assignment_id = p_assignment),
         (select w.saldo_excel_cents from public.collection_week_units w where w.assignment_id = p_assignment and w.saldo_excel_cents is not null order by w.week_start desc limit 1),
         (select w.week_start from public.collection_week_units w where w.assignment_id = p_assignment and w.saldo_excel_cents is not null order by w.week_start desc limit 1)
$$;
revoke all on function app_private.excel_saldo(uuid) from public, anon, authenticated;
grant execute on function app_private.excel_saldo(uuid) to authenticated, service_role;

-- ───────── Variables de WhatsApp ─────────
create or replace function app_private.template_vars(p_assignment uuid, p_date date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_rate bigint; v_today bigint; v_ag text; v_tz text := app_private.tz(); v jsonb; e record;
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
    v := v || jsonb_build_object(
      'saldo_total', case when e.saldo_cents is null then null else app_private.fmt_usd(greatest(e.saldo_cents, 0)) end,
      'deuda_anterior', case when e.saldo_cents is null then null else app_private.fmt_usd(greatest(e.saldo_cents, 0)) end,
      'credito', case when e.saldo_cents is null then null else app_private.fmt_usd(greatest(-e.saldo_cents, 0)) end,
      'detalle_deuda', case when e.saldo_cents is null then null
                            when e.saldo_cents > 0 then 'Su saldo pendiente es de ' || app_private.fmt_usd(e.saldo_cents) || '.'
                            when e.saldo_cents < 0 then 'Su cuenta está al día y tiene un saldo a favor de ' || app_private.fmt_usd(-e.saldo_cents) || '.'
                            else 'Su cuenta está al día.' end,
      'pendiente_hoy', null, 'deuda_semanal', null, 'cuenta_semana', null);
  end if;
  return v;
end $$;

-- ───────── Catálogo de variables ─────────
create or replace function public.template_variables()
returns table ("group" text, code text, label text, description text, example text)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app_private.assert_staff();
  return query select v."group", v.code,
    case v.code when 'saldo_total' then 'Saldo pendiente' when 'deuda_anterior' then 'Saldo del Excel (alias)' else v.label end,
    case v.code
      when 'nombre' then 'Nombre completo de la persona (equivale a nombre_completo; se conserva por compatibilidad).'
      when 'saldo_total' then 'Saldo pendiente: el ÚLTIMO SALDO válido importado del Excel. No se recalcula ni crece solo; si el Excel nunca lo trajo, la variable queda sin resolver y no se envía.'
      when 'deuda_anterior' then 'Igual que saldo_total (el SALDO del Excel). Se conserva por compatibilidad.'
      when 'credito' then 'Saldo a favor: el SALDO del Excel cuando es negativo ($0.00 si no).'
      when 'detalle_deuda' then 'Frase completa (termina en punto) con el SALDO del Excel: saldo pendiente, cuenta al día o saldo a favor.'
      else v.description end,
    v.example
    from public.template_variables_v2() v where v.code not in ('apellido', 'pendiente_hoy', 'deuda_semanal', 'cuenta_semana');
end $$;

-- ───────── Inicio: pendiente por cobrar = suma de los SALDOS del Excel ─────────
alter function public.dashboard_summary() rename to dashboard_summary_core;
revoke all on function public.dashboard_summary_core() from public, anon, authenticated;
grant execute on function public.dashboard_summary_core() to authenticated, service_role;      -- la envoltura es security invoker: ejecuta con el rol de quien consulta (RLS aplica)
create function public.dashboard_summary() returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare v jsonb; s record;
begin
  perform app_private.assert_staff();
  v := public.dashboard_summary_core();
  select coalesce(sum(case when e.managed then greatest(coalesce(e.saldo_cents, 0), 0) else p.pending_cents end), 0)::bigint pending,
         coalesce(sum(case when e.managed then greatest(-coalesce(e.saldo_cents, 0), 0) else p.credit_cents end), 0)::bigint credit,
         count(distinct p.driver_id) filter (where case when e.managed then coalesce(e.saldo_cents, 0) > 0 else p.pending_cents > 0 end) debtors
    into s from public.v_assignment_position p cross join lateral app_private.excel_saldo(p.assignment_id) e;
  return jsonb_set(v, '{collections}', (v -> 'collections') || jsonb_build_object('pending_total_cents', s.pending, 'credits_total_cents', s.credit, 'drivers_with_debt', s.debtors));
end $$;
revoke all on function public.dashboard_summary() from public, anon, authenticated;
grant execute on function public.dashboard_summary() to authenticated, service_role;

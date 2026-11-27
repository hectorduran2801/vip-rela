-- VIP · 0041 · Comisión de pago (Yappy / Punto Pago = $1.00): el importe que se comunica suma $1.00 cuando la unidad tiene activo «cobrar comisión».
--   · assignments.collect_commission (por defecto ACTIVO). Se desactiva para quien paga en efectivo. La importación del Excel no lo modifica.
--   · La comisión se suma SOLO si hay deuda (saldo total > 0); con saldo a favor o al día no se cobra.
--   · Es parte del mismo cálculo (app_private.saldo_total): Cobranza, variables, vistas previas, mensajes y horarios muestran el mismo importe.
--   · NO modifica cargos, pagos ni ajustes: solo cambia el importe comunicado.
-- Reversible: volver a app_private.saldo_total de 0038 y quitar la columna.
set search_path = public, extensions;

alter table public.assignments add column collect_commission boolean not null default true;

create function app_private.payment_commission_cents() returns bigint language sql immutable set search_path = '' as $$ select 100::bigint $$;
revoke all on function app_private.payment_commission_cents() from public, anon, authenticated;
grant execute on function app_private.payment_commission_cents() to authenticated, service_role;

drop function app_private.saldo_total(uuid, date);
create function app_private.saldo_total(p_assignment uuid, p_date date)
returns table (managed boolean, saldo_cents bigint, total_cents bigint, cuota_hoy_cents bigint, pagado_cents bigint, commission_cents bigint)
language plpgsql stable security definer set search_path = '' as $$
declare e record; v_acc bigint := 0; v_paid bigint := 0; v_plan bigint; v_base bigint; v_com bigint := 0;
begin
  select * into e from app_private.excel_saldo(p_assignment);
  v_plan := coalesce(public.planned_daily_cents(p_assignment, p_date), 0);
  if e.managed and e.week_start is not null and e.week_start <= p_date then
    select coalesce(sum(public.planned_daily_cents(p_assignment, d::date)), 0)::bigint into v_acc from generate_series(e.week_start, p_date, interval '1 day') d;
    select coalesce(sum(p.amount_cents), 0)::bigint into v_paid from public.excel_payment_days p where p.assignment_id = p_assignment and p.pay_date between e.week_start and p_date;
  end if;
  v_base := case when e.saldo_cents is null then null else e.saldo_cents + v_acc - v_paid end;
  if v_base is not null and v_base > 0 and exists (select 1 from public.assignments a where a.id = p_assignment and a.collect_commission) then v_com := app_private.payment_commission_cents(); end if;
  return query select e.managed, e.saldo_cents, case when v_base is null then null else v_base + v_com end, v_plan, v_paid, v_com;
end $$;
revoke all on function app_private.saldo_total(uuid, date) from public, anon, authenticated;
grant execute on function app_private.saldo_total(uuid, date) to authenticated, service_role;

create function public.set_assignment_commission(p_assignment uuid, p_on boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.assert_admin();
  update public.assignments set collect_commission = coalesce(p_on, true) where id = p_assignment;
  if not found then raise exception 'assignment_not_found' using errcode = 'P0002'; end if;
  perform app_private.audit('assignment.commission', 'assignments', p_assignment, jsonb_build_object('collect_commission', coalesce(p_on, true)));
end $$;
revoke all on function public.set_assignment_commission(uuid, boolean) from public, anon;
grant execute on function public.set_assignment_commission(uuid, boolean) to authenticated, service_role;

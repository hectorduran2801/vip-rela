-- VIP · 0011 · Detalle semanal por conductor: cuota, abonado, saldo y estado de CADA día + saldo anterior.
-- Solo lectura. Todo se calcula desde movimientos (cargos, pagos, aplicación FIFO); nada se escribe ni se recalcula en el cliente.
set search_path = public, extensions;

-- days[i] = { date, weekday (1=lunes…7=domingo), charge_cents, net_paid_cents, remaining_cents, status }
--   charge_cents    : cuota que corresponde a ese día (cuota diaria + ajustes positivos fechados ese día)
--   net_paid_cents  : lo recibido (neto) ESE día, aunque se aplique a deuda más antigua
--   remaining_cents : lo que sigue pendiente de ESA cuota hoy (cobertura de la más antigua a la más reciente)
--   status          : no_charge | paid | partial | pending
-- previous_*       : saldo con el que el conductor ENTRA a la semana (hasta el domingo anterior)
create function public.weekly_collection_detail(p_week_start date, p_assignment uuid default null)
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
      with cov as (select c.charge_date, sum(c.remaining_cents)::bigint rem from public.assignment_coverage(a.id) c group by c.charge_date)
      select jsonb_agg(jsonb_build_object(
               'date', g.d::date, 'weekday', extract(isodow from g.d)::int,
               'charge_cents', coalesce(ch.amt, 0), 'net_paid_cents', coalesce(pd.amt, 0), 'remaining_cents', coalesce(cov.rem, 0),
               'status', case when coalesce(ch.amt, 0) = 0 then 'no_charge' when coalesce(cov.rem, 0) = 0 then 'paid'
                              when cov.rem >= ch.amt then 'pending' else 'partial' end) order by g.d) as days
        from generate_series(p_week_start::timestamp, (p_week_start + 6)::timestamp, interval '1 day') g(d)
        left join lateral (select sum(c.amount_cents)::bigint amt from public.charges c where c.assignment_id = a.id and c.charge_date = g.d::date) ch on true
        left join lateral (select sum(p.net_cents)::bigint amt from public.payments p where p.assignment_id = a.id and p.voided_at is null
                              and (p.paid_at at time zone v_tz)::date = g.d::date) pd on true
        left join cov on cov.charge_date = g.d::date
    ) d
   where a.valid_from <= p_week_start + 6 and (a.valid_to is null or a.valid_to >= p_week_start) and (p_assignment is null or a.id = p_assignment);
end $$;

revoke all on function public.weekly_collection_detail(date, uuid) from public, anon, authenticated;
grant execute on function public.weekly_collection_detail(date, uuid) to authenticated, service_role;

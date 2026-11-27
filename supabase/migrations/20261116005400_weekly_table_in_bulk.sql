-- VIP · 0054 · NO APLICAR EN REMOTO sin autorización expresa.
-- Tabla semanal (Informes y exportaciones) calculada EN BLOQUE. Mismas columnas y valores (se comprueba contra la versión anterior). Sigue siendo SECURITY INVOKER: aplica la RLS del usuario.
set search_path = public, extensions;

-- Referencia: la versión anterior, sin cambios, para comparar.
create function app_private.weekly_collection_table_reference(p_week_start date)
returns table (assignment_id uuid, driver_id uuid, unit_id uuid, unit_code text, operator_code text, national_id text, full_name text,
  driver_status text, daily_rate_cents bigint, week_charged_cents bigint, day_net_cents bigint[], gross_cents bigint, commission_cents bigint,
  net_cents bigint, week_diff_cents bigint, pending_cents bigint, credit_cents bigint, week_closed boolean,
  previous_pending_cents bigint, previous_credit_cents bigint, opening_cents bigint, planned_cents bigint, missing_days int)
language plpgsql stable security invoker set search_path = '' as $$
declare v_tz text := app_private.tz(); v_end date := p_week_start + 6; v_today date := (now() at time zone app_private.tz())::date;
begin
  perform app_private.assert_staff();
  if extract(isodow from p_week_start) <> 1 then raise exception 'week_start_must_be_monday' using errcode = '22023'; end if;
  return query
  select x.assignment_id, x.driver_id, x.unit_id, x.unit_code, x.operator_code, x.national_id, x.full_name, x.driver_status, x.daily_rate_cents, x.week_charged_cents,
         x.day_net_cents, x.gross_cents, x.commission_cents, x.net_cents, (x.net_cents - x.week_charged_cents), x.pending_cents, x.credit_cents, x.week_closed,
         x.previous_pending_cents, x.previous_credit_cents, x.opening_cents, x.planned_cents,
         case when x.week_closed then 0 else x.missing_days end
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
           coalesce((select sum(c.amount_cents) from public.charges c where c.assignment_id = a.id and c.kind = 'opening' and c.charge_date = p_week_start - 1), 0)::bigint as opening_cents,
           coalesce((select sum(public.planned_daily_cents(a.id, p_week_start + i)) from generate_series(0, 6) i), 0)::bigint as planned_cents,
           (select count(*) from generate_series(0, 6) i where p_week_start + i <= v_today and public.planned_daily_cents(a.id, p_week_start + i) > 0
               and not exists (select 1 from public.charges c where c.assignment_id = a.id and c.kind = 'daily' and c.charge_date = p_week_start + i))::int as missing_days
      from public.assignments a join public.drivers d on d.id = a.driver_id join public.units u on u.id = a.unit_id
      cross join lateral public.assignment_position(a.id, v_end) pos
      cross join lateral public.assignment_position(a.id, p_week_start - 1) prev
     where a.valid_from <= v_end and (a.valid_to is null or a.valid_to >= p_week_start)
  ) x order by x.unit_code;
end $$;
revoke all on function app_private.weekly_collection_table_reference(date) from public, anon, authenticated;
grant execute on function app_private.weekly_collection_table_reference(date) to service_role;

create or replace function public.weekly_collection_table(p_week_start date)
returns table (assignment_id uuid, driver_id uuid, unit_id uuid, unit_code text, operator_code text, national_id text, full_name text,
  driver_status text, daily_rate_cents bigint, week_charged_cents bigint, day_net_cents bigint[], gross_cents bigint, commission_cents bigint,
  net_cents bigint, week_diff_cents bigint, pending_cents bigint, credit_cents bigint, week_closed boolean,
  previous_pending_cents bigint, previous_credit_cents bigint, opening_cents bigint, planned_cents bigint, missing_days int)
language plpgsql stable security invoker set search_path = '' as $$
#variable_conflict use_column
declare v_tz text := app_private.tz(); v_end date := p_week_start + 6; v_today date := (now() at time zone app_private.tz())::date;
begin
  perform app_private.assert_staff();
  if extract(isodow from p_week_start) <> 1 then raise exception 'week_start_must_be_monday' using errcode = '22023'; end if;
  return query
  with asg as (
    select a.id, a.driver_id, a.unit_id, a.valid_from, a.valid_to, d.operator_code, d.national_id, btrim(d.first_name || ' ' || d.last_name) full_name, d.status driver_status, d.active d_active, u.code unit_code, u.active u_active
      from public.assignments a join public.drivers d on d.id = a.driver_id join public.units u on u.id = a.unit_id
     where a.valid_from <= v_end and (a.valid_to is null or a.valid_to >= p_week_start)),
  pay as (
    select p.assignment_id,
      coalesce(sum(p.gross_cents) filter (where p.week_start = p_week_start), 0)::bigint gross, coalesce(sum(p.commission_cents) filter (where p.week_start = p_week_start), 0)::bigint commission,
      coalesce(sum(p.net_cents) filter (where p.week_start = p_week_start), 0)::bigint net,
      coalesce(sum(p.net_cents) filter (where (p.paid_at at time zone v_tz)::date <= v_end), 0)::bigint net_end,
      coalesce(sum(p.net_cents) filter (where (p.paid_at at time zone v_tz)::date <= p_week_start - 1), 0)::bigint net_prev
      from public.payments p join asg on asg.id = p.assignment_id where p.voided_at is null group by p.assignment_id),
  pay_day as (
    select p.assignment_id, (p.paid_at at time zone v_tz)::date d, sum(p.net_cents)::bigint c from public.payments p join asg on asg.id = p.assignment_id
     where p.voided_at is null and (p.paid_at at time zone v_tz)::date between p_week_start and v_end group by 1, 2),
  days_net as (
    select asg.id, array_agg(coalesce(pay_day.c, 0)::bigint order by i) arr from asg cross join generate_series(0, 6) i
      left join pay_day on pay_day.assignment_id = asg.id and pay_day.d = p_week_start + i group by asg.id),
  ch as (
    select c.assignment_id,
      coalesce(sum(c.amount_cents) filter (where c.week_start = p_week_start and c.kind <> 'opening'), 0)::bigint week_charged,
      coalesce(sum(c.amount_cents) filter (where c.charge_date <= v_end), 0)::bigint end_c, coalesce(sum(c.amount_cents) filter (where c.charge_date <= p_week_start - 1), 0)::bigint prev_c,
      coalesce(sum(c.amount_cents) filter (where c.kind = 'opening' and c.charge_date = p_week_start - 1), 0)::bigint opening
      from public.charges c join asg on asg.id = c.assignment_id group by c.assignment_id),
  adj as (
    select x.assignment_id, coalesce(sum(-x.amount_cents) filter (where x.amount_cents < 0 and x.effective_date <= v_end), 0)::bigint end_a,
      coalesce(sum(-x.amount_cents) filter (where x.amount_cents < 0 and x.effective_date <= p_week_start - 1), 0)::bigint prev_a
      from public.adjustments x join asg on asg.id = x.assignment_id group by x.assignment_id),
  plan as (
    select asg.id, i, coalesce(case when asg.d_active and asg.u_active and asg.valid_from <= p_week_start + i and (asg.valid_to is null or asg.valid_to >= p_week_start + i) then coalesce(ex.amount_cents, rt.daily_amount_cents) end, 0)::bigint c
      from asg cross join generate_series(0, 6) i
      left join public.rate_exceptions ex on ex.assignment_id = asg.id and ex.on_date = p_week_start + i
      left join lateral (select r.daily_amount_cents from public.rates r where r.assignment_id = asg.id and r.valid_from <= p_week_start + i and (r.valid_to is null or r.valid_to >= p_week_start + i)
                           and extract(isodow from p_week_start + i)::smallint = any (r.weekdays) limit 1) rt on true),
  plan_sum as (
    select plan.id, sum(plan.c)::bigint planned,
      count(*) filter (where p_week_start + plan.i <= v_today and plan.c > 0 and not exists (select 1 from public.charges c where c.assignment_id = plan.id and c.kind = 'daily' and c.charge_date = p_week_start + plan.i))::int missing
      from plan group by plan.id),
  rate as (
    select distinct on (r.assignment_id) r.assignment_id, r.daily_amount_cents from public.rates r join asg on asg.id = r.assignment_id
     where r.valid_from <= v_end and (r.valid_to is null or r.valid_to >= p_week_start) order by r.assignment_id, r.valid_from desc),
  closed as (select w.assignment_id from public.weekly_closures w where w.week_start = p_week_start)
  select asg.id, asg.driver_id, asg.unit_id, asg.unit_code, asg.operator_code, asg.national_id, asg.full_name, asg.driver_status,
    coalesce(rate.daily_amount_cents, 0)::bigint, coalesce(ch.week_charged, 0)::bigint, days_net.arr, coalesce(pay.gross, 0)::bigint, coalesce(pay.commission, 0)::bigint, coalesce(pay.net, 0)::bigint,
    (coalesce(pay.net, 0) - coalesce(ch.week_charged, 0))::bigint,
    greatest(coalesce(ch.end_c, 0) - (coalesce(pay.net_end, 0) + coalesce(adj.end_a, 0)), 0)::bigint,
    greatest((coalesce(pay.net_end, 0) + coalesce(adj.end_a, 0)) - coalesce(ch.end_c, 0), 0)::bigint,
    (closed.assignment_id is not null),
    greatest(coalesce(ch.prev_c, 0) - (coalesce(pay.net_prev, 0) + coalesce(adj.prev_a, 0)), 0)::bigint,
    greatest((coalesce(pay.net_prev, 0) + coalesce(adj.prev_a, 0)) - coalesce(ch.prev_c, 0), 0)::bigint,
    coalesce(ch.opening, 0)::bigint, coalesce(plan_sum.planned, 0)::bigint,
    case when closed.assignment_id is not null then 0 else coalesce(plan_sum.missing, 0) end
  from asg
    left join pay on pay.assignment_id = asg.id left join days_net on days_net.id = asg.id left join ch on ch.assignment_id = asg.id left join adj on adj.assignment_id = asg.id
    left join plan_sum on plan_sum.id = asg.id left join rate on rate.assignment_id = asg.id left join closed on closed.assignment_id = asg.id
  order by asg.unit_code;
end $$;

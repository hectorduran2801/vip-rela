-- Reversión de 0054: restaura la tabla semanal anterior. NO se aplica sola.
set search_path = public, extensions;
begin;
create or replace function public.weekly_collection_table(p_week_start date)
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
drop function app_private.weekly_collection_table_reference(date);
commit;

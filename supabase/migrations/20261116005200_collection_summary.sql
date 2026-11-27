-- VIP · 0052 · NO APLICAR EN REMOTO sin autorización expresa.
-- Cobranza calculada EN BLOQUE y persistida. No cambia reglas, importes ni mensajes (se comprueba campo por campo contra la consulta anterior).
--   · collection_rows(): una sola pasada por tabla (sin consultas por conductor ni por día).
--   · collection_summary: resultado de la semana en curso por cuenta. Solo se recalculan las asignaciones afectadas por un cambio; todo al cambiar de día.
--   · Se actualiza dentro de la transacción de la importación, al leer si hay algo pendiente, y desde el servidor (sin navegador) con refresh_collection_summaries().
-- Reversible: borrar las tres tablas y las funciones.
set search_path = public, extensions;

create table public.collection_summary (
  account_id uuid not null references public.accounts(id) on delete cascade, week_start date not null, assignment_id uuid not null, unit_code text not null, data jsonb not null,
  primary key (account_id, week_start, assignment_id));
create table public.collection_summary_state (
  account_id uuid not null references public.accounts(id) on delete cascade, week_start date not null, computed_on date not null, computed_at timestamptz not null,
  primary key (account_id, week_start));
create table public.collection_summary_dirty (
  account_id uuid not null references public.accounts(id) on delete cascade, assignment_id uuid not null, primary key (account_id, assignment_id));
alter table public.collection_summary enable row level security;
alter table public.collection_summary_state enable row level security;
alter table public.collection_summary_dirty enable row level security;
revoke all on public.collection_summary, public.collection_summary_state, public.collection_summary_dirty from anon, authenticated;

-- Índices para el cálculo en bloque (por cuenta).
create index if not exists payments_account_assignment_idx on public.payments(account_id, assignment_id) where voided_at is null;
create index if not exists charges_account_assignment_idx on public.charges(account_id, assignment_id, charge_date);
create index if not exists excel_payment_days_account_idx on public.excel_payment_days(account_id, assignment_id, pay_date);

create function app_private.collection_rows(p_account uuid, p_week date, p_ids uuid[] default null) returns table (unit_code text, assignment_id uuid, data jsonb)
language sql stable security definer set search_path = '' as $$
with k as (select app_private.tz() tz, (now() at time zone app_private.tz())::date today, p_week + 6 as wend),
asg as (
  select a.id, a.driver_id, a.unit_id, a.valid_from, a.valid_to, a.agreement_note, a.collect_commission, to_jsonb(a) ->> 'send_default' as send_default,
         d.operator_code, btrim(d.first_name || ' ' || d.last_name) full_name, d.status driver_status, d.phone_e164, d.active d_active, u.code unit_code, u.agreement, u.active u_active
    from public.assignments a join public.drivers d on d.id = a.driver_id join public.units u on u.id = a.unit_id, k
   where a.account_id = p_account and a.valid_from <= k.wend and (a.valid_to is null or a.valid_to >= p_week) and (p_ids is null or a.id = any (p_ids))),
-- semana más reciente del Excel por asignación (igual que app_private.excel_saldo)
xs as (select distinct on (w.assignment_id) w.assignment_id, coalesce(w.saldo_excel_cents, 0) saldo, w.week_start
         from public.collection_week_units w join asg on asg.id = w.assignment_id order by w.assignment_id, w.week_start desc),
ref as (select asg.id, least(k.today, k.wend) as pdate from asg, k),
-- cuota prevista por asignación y día (igual que public.planned_daily_cents), para todos los días que hagan falta
days as (
  select asg.id, g::date d from asg join ref on ref.id = asg.id left join xs on xs.assignment_id = asg.id,
         lateral generate_series(least(p_week, coalesce(xs.week_start, p_week)), greatest(p_week + 6, ref.pdate), interval '1 day') g),
plan as (
  select days.id, days.d,
         coalesce(case when asg.d_active and asg.u_active and asg.valid_from <= days.d and (asg.valid_to is null or asg.valid_to >= days.d) then
           coalesce(ex.amount_cents, rt.daily_amount_cents) end, 0)::bigint cents
    from days join asg on asg.id = days.id
    left join public.rate_exceptions ex on ex.assignment_id = days.id and ex.on_date = days.d
    left join lateral (select r.daily_amount_cents from public.rates r where r.assignment_id = days.id and r.valid_from <= days.d and (r.valid_to is null or r.valid_to >= days.d)
                         and extract(isodow from days.d)::smallint = any (r.weekdays) limit 1) rt on true),
xp as (select x.assignment_id, x.pay_date, sum(x.amount_cents)::bigint cents from public.excel_payment_days x join asg on asg.id = x.assignment_id group by 1, 2),
week_days as (
  select p.id, jsonb_agg(jsonb_build_object('date', p.d::text, 'due', p.cents, 'paid', coalesce(xp.cents, 0)) order by p.d) days
    from plan p left join xp on xp.assignment_id = p.id and xp.pay_date = p.d where p.d between p_week and p_week + 6 group by p.id),
-- saldo total (igual que app_private.saldo_total a la fecha min(hoy, fin de semana))
acc as (
  select ref.id, coalesce(sum(p.cents) filter (where p.d between xs.week_start and ref.pdate), 0)::bigint due,
         coalesce(sum(xp.cents) filter (where p.d between xs.week_start and ref.pdate), 0)::bigint paid
    from ref join xs on xs.assignment_id = ref.id join plan p on p.id = ref.id left join xp on xp.assignment_id = p.id and xp.pay_date = p.d
   group by ref.id),
pay as (
  select p.assignment_id,
         coalesce(sum(p.net_cents) filter (where p.week_start = p_week), 0)::bigint week_net,
         coalesce(sum(p.net_cents) filter (where (p.paid_at at time zone k.tz)::date <= k.wend), 0)::bigint net_end,
         coalesce(sum(p.net_cents) filter (where (p.paid_at at time zone k.tz)::date <= p_week - 1), 0)::bigint net_prev,
         coalesce(sum(p.net_cents) filter (where (p.paid_at at time zone k.tz)::date = k.today), 0)::bigint net_today
    from public.payments p join asg on asg.id = p.assignment_id, k where p.voided_at is null group by p.assignment_id),
ch as (
  select c.assignment_id, coalesce(sum(c.amount_cents) filter (where c.charge_date <= k.wend), 0)::bigint end_c,
         coalesce(sum(c.amount_cents) filter (where c.charge_date <= p_week - 1), 0)::bigint prev_c
    from public.charges c join asg on asg.id = c.assignment_id, k group by c.assignment_id),
adj as (
  select x.assignment_id, coalesce(sum(-x.amount_cents) filter (where x.amount_cents < 0 and x.effective_date <= k.wend), 0)::bigint end_a,
         coalesce(sum(-x.amount_cents) filter (where x.amount_cents < 0 and x.effective_date <= p_week - 1), 0)::bigint prev_a
    from public.adjustments x join asg on asg.id = x.assignment_id, k group by x.assignment_id),
rate as (
  select distinct on (r.assignment_id) r.assignment_id, r.daily_amount_cents
    from public.rates r join asg on asg.id = r.assignment_id, k where r.valid_from <= k.wend and (r.valid_to is null or r.valid_to >= p_week)
   order by r.assignment_id, r.valid_from desc),
calc as (
  select asg.*, coalesce(rate.daily_amount_cents, 0)::bigint daily_rate_cents, coalesce(pay.week_net, 0)::bigint net_cents,
         greatest(coalesce(ch.end_c, 0) - (coalesce(pay.net_end, 0) + coalesce(adj.end_a, 0)), 0)::bigint pending_cents,
         greatest((coalesce(pay.net_end, 0) + coalesce(adj.end_a, 0)) - coalesce(ch.end_c, 0), 0)::bigint credit_cents,
         greatest(coalesce(ch.prev_c, 0) - (coalesce(pay.net_prev, 0) + coalesce(adj.prev_a, 0)), 0)::bigint previous_pending_cents,
         (xs.assignment_id is not null) saldo_managed, xs.saldo::bigint saldo_excel_cents, xs.week_start::text saldo_week,
         coalesce(pay.net_today, 0)::bigint paid_today_cents, wd.days,
         case when xs.assignment_id is null then null
              else xs.saldo + case when xs.week_start <= ref.pdate then coalesce(acc.due, 0) - coalesce(acc.paid, 0) else 0 end end::bigint base_cents
    from asg join ref on ref.id = asg.id
    left join rate on rate.assignment_id = asg.id left join pay on pay.assignment_id = asg.id left join ch on ch.assignment_id = asg.id
    left join adj on adj.assignment_id = asg.id left join xs on xs.assignment_id = asg.id left join acc on acc.id = asg.id left join week_days wd on wd.id = asg.id),
fin as (
  select calc.*, case when base_cents is not null and base_cents > 0 and collect_commission then app_private.payment_commission_cents() else 0 end::bigint commission_cents from calc)
select f.unit_code, f.id, jsonb_build_object('assignment_id', f.id, 'driver_id', f.driver_id, 'unit_id', f.unit_id, 'unit_code', f.unit_code, 'operator_code', f.operator_code, 'full_name', f.full_name,
  'driver_status', f.driver_status, 'daily_rate_cents', f.daily_rate_cents, 'net_cents', f.net_cents, 'pending_cents', f.pending_cents, 'credit_cents', f.credit_cents,
  'previous_pending_cents', f.previous_pending_cents, 'phone_e164', f.phone_e164, 'agreement_note', f.agreement_note, 'collect_commission', f.collect_commission,
  'send_by_excel', f.send_default::boolean, 'agreement', f.agreement, 'valid_to', f.valid_to::text, 'saldo_managed', f.saldo_managed, 'saldo_excel_cents', f.saldo_excel_cents,
  'saldo_week', f.saldo_week, 'paid_today_cents', f.paid_today_cents, 'days', f.days,
  'total_cents', case when f.base_cents is null then null else f.base_cents + f.commission_cents end, 'commission_cents', f.commission_cents)
from fin f order by f.unit_code
$$;

-- Referencia: la consulta anterior, sin cambios (fila por fila). Solo sirve para comprobar que el cálculo en bloque da exactamente lo mismo.
create function app_private.collection_rows_reference(p_week date) returns table (unit_code text, assignment_id uuid, data jsonb)
language plpgsql stable security invoker set search_path = '' as $$
begin
  return query select q.unit_code, q.assignment_id, to_jsonb(q) from (select w.assignment_id, w.driver_id, w.unit_id, w.unit_code, w.operator_code, w.full_name, w.driver_status, w.daily_rate_cents, w.net_cents, w.pending_cents,
                            w.credit_cents, w.previous_pending_cents, d.phone_e164, a.agreement_note, a.collect_commission, (to_jsonb(a) ->> 'send_default')::boolean send_by_excel, u.agreement, a.valid_to::text valid_to, e.managed saldo_managed, e.saldo_cents saldo_excel_cents, e.week_start::text saldo_week,
                            (select coalesce(sum(p.net_cents), 0) from public.payments p where p.assignment_id = w.assignment_id and p.voided_at is null
                                and (p.paid_at at time zone app_private.tz())::date = (now() at time zone app_private.tz())::date) paid_today_cents,
                            (select jsonb_agg(jsonb_build_object('date', d::date::text, 'due', coalesce(public.planned_daily_cents(w.assignment_id, d::date), 0),
                                      'paid', coalesce((select sum(x.amount_cents) from public.excel_payment_days x where x.assignment_id = w.assignment_id and x.pay_date = d::date), 0)) order by d)
                               from generate_series(p_week, p_week + 6, interval '1 day') d) days,
                            (select t.total_cents from app_private.saldo_total(w.assignment_id, least((now() at time zone app_private.tz())::date, p_week + 6)) t) total_cents,
                            (select t.commission_cents from app_private.saldo_total(w.assignment_id, least((now() at time zone app_private.tz())::date, p_week + 6)) t) commission_cents
                       from public.weekly_collection_table(p_week) w
                       join public.drivers d on d.id = w.driver_id join public.assignments a on a.id = w.assignment_id join public.units u on u.id = w.unit_id
                       cross join lateral app_private.excel_saldo(w.assignment_id) e
                      order by w.unit_code) q;
end $$;

-- p_ids null = todo; si no, solo esas asignaciones (las que dejaron de estar en la semana se retiran).
create function app_private.refresh_collection_summary(p_account uuid, p_week date, p_ids uuid[] default null) returns int language plpgsql security definer set search_path = '' as $$
declare v_today date := (now() at time zone app_private.tz())::date; n int;
begin
  delete from public.collection_summary s where s.account_id = p_account and s.week_start = p_week and (p_ids is null or s.assignment_id = any (p_ids));
  insert into public.collection_summary(account_id, week_start, assignment_id, unit_code, data) select p_account, p_week, r.assignment_id, r.unit_code, r.data from app_private.collection_rows(p_account, p_week, p_ids) r;
  get diagnostics n = row_count;
  insert into public.collection_summary_state(account_id, week_start, computed_on, computed_at) values (p_account, p_week, v_today, now())
  on conflict (account_id, week_start) do update set computed_on = excluded.computed_on, computed_at = excluded.computed_at;
  return n;
end $$;

-- Deja al día el resumen de una cuenta: todo si cambió el día (hora de Panamá) o no existe; si no, solo lo afectado. Idempotente y serializado por cuenta.
create function app_private.ensure_collection_summary(p_account uuid) returns int language plpgsql security definer set search_path = '' as $$
declare v_today date := (now() at time zone app_private.tz())::date; v_week date; v_ids uuid[];
begin
  v_week := app_private.week_start_of(v_today);
  if not exists (select 1 from public.collection_summary_dirty d where d.account_id = p_account)
     and exists (select 1 from public.collection_summary_state s where s.account_id = p_account and s.week_start = v_week and s.computed_on = v_today) then return 0; end if;
  perform pg_advisory_xact_lock(7405212, hashtext(p_account::text));
  with gone as (delete from public.collection_summary_dirty d where d.account_id = p_account returning d.assignment_id) select array_agg(assignment_id) into v_ids from gone;
  if not exists (select 1 from public.collection_summary_state s where s.account_id = p_account and s.week_start = v_week and s.computed_on = v_today) then
    delete from public.collection_summary s where s.account_id = p_account and s.week_start <> v_week;
    return app_private.refresh_collection_summary(p_account, v_week, null);
  end if;
  if v_ids is null then return 0; end if;
  return app_private.refresh_collection_summary(p_account, v_week, v_ids);
end $$;

-- Lectura (usuarios): semana en curso desde el resumen (puesto al día antes de responder); otras semanas se calculan al vuelo, en bloque.
create function public.collection_summary_rows(p_week date) returns setof jsonb language plpgsql security definer set search_path = '' as $$
declare v_acc uuid; v_cur date := app_private.week_start_of((now() at time zone app_private.tz())::date);
begin
  perform app_private.assert_staff();
  if extract(isodow from p_week) <> 1 then raise exception 'week_start_must_be_monday' using errcode = '22023'; end if;
  v_acc := app_private.current_account();
  if v_acc is null then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_week <> v_cur then return query select r.data from app_private.collection_rows(v_acc, p_week) r order by r.unit_code; return; end if;
  perform app_private.ensure_collection_summary(v_acc);
  return query select s.data from public.collection_summary s where s.account_id = v_acc and s.week_start = p_week order by s.unit_code;
end $$;

-- Servidor (sin navegador): al cambiar el día o quedar cambios pendientes.
create function public.refresh_collection_summaries() returns int language plpgsql security definer set search_path = '' as $$
declare a record; n int := 0;
begin
  if not app_private.is_service() then raise exception 'forbidden' using errcode = '42501'; end if;
  for a in select id from public.accounts order by id loop n := n + app_private.ensure_collection_summary(a.id); end loop;
  return n;
end $$;

-- Marca SOLO las asignaciones afectadas por cada cambio real.
create function app_private.mark_collection_dirty() returns trigger language plpgsql security definer set search_path = '' as $$
declare v_col text := tg_argv[0];
begin
  if v_col = 'driver' then
    insert into public.collection_summary_dirty select distinct a.account_id, a.id from changed c join public.assignments a on a.driver_id = c.id on conflict do nothing;
  elsif v_col = 'unit' then
    insert into public.collection_summary_dirty select distinct a.account_id, a.id from changed c join public.assignments a on a.unit_id = c.id on conflict do nothing;
  elsif v_col = 'id' then
    execute 'insert into public.collection_summary_dirty select distinct c.account_id, c.id from changed c on conflict do nothing';
  else
    execute 'insert into public.collection_summary_dirty select distinct c.account_id, c.assignment_id from changed c where c.assignment_id is not null on conflict do nothing';
  end if;
  return null;
end $$;
do $$ declare t record; begin
  for t in select * from (values ('assignments','id'), ('drivers','driver'), ('units','unit'), ('rates','assignment'), ('rate_exceptions','assignment'), ('payments','assignment'),
                                 ('charges','assignment'), ('adjustments','assignment'), ('collection_week_units','assignment'), ('excel_payment_days','assignment')) v(name, key) loop
    execute format('create trigger summary_ins after insert on public.%I referencing new table as changed for each statement execute function app_private.mark_collection_dirty(%L)', t.name, t.key);
    execute format('create trigger summary_upd after update on public.%I referencing new table as changed for each statement execute function app_private.mark_collection_dirty(%L)', t.name, t.key);
    execute format('create trigger summary_del after delete on public.%I referencing old table as changed for each statement execute function app_private.mark_collection_dirty(%L)', t.name, t.key);
  end loop;
end $$;

-- Al aplicar una importación: se pone al día al final de la MISMA transacción (si falla, no queda nada a medias).
create function app_private.summary_after_import() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'applied' then perform app_private.ensure_collection_summary(new.account_id); end if;
  return null;
end $$;
create constraint trigger summary_import after update of status on public.excel_imports deferrable initially deferred for each row execute function app_private.summary_after_import();

revoke all on function app_private.collection_rows(uuid, date, uuid[]), app_private.collection_rows_reference(date), app_private.refresh_collection_summary(uuid, date, uuid[]),
  app_private.ensure_collection_summary(uuid), app_private.mark_collection_dirty(), app_private.summary_after_import() from public, anon, authenticated, vip_app;
grant execute on function app_private.collection_rows(uuid, date, uuid[]), app_private.ensure_collection_summary(uuid) to vip_app, service_role;
grant execute on function app_private.collection_rows_reference(date) to service_role;
alter function public.collection_summary_rows(date) owner to vip_app;
grant select on public.collection_summary to vip_app;
create policy vip_app_read on public.collection_summary for select to vip_app using (account_id = app_private.current_account());
revoke all on function public.collection_summary_rows(date), public.refresh_collection_summaries() from public, anon, authenticated;
grant execute on function public.collection_summary_rows(date) to authenticated, service_role;
grant execute on function public.refresh_collection_summaries() to service_role;

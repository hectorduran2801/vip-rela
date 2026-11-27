-- VIP · 0021 · Generación automática de cuotas (motor de cobranza), cuota prevista vs generada, historial de tarifas y ventana de recuperación.
-- SOLO local: no destructiva, no toca filas existentes ni migraciones previas. Los cargos, pagos, ajustes y cierres siguen siendo inmutables.
set search_path = public, extensions;

-- ───────── 1. Trazabilidad de tarifas y ventana de recuperación configurable ─────────
alter table public.rates add column created_by uuid references public.profiles(id), add column reason text;
alter table public.rate_exceptions add column created_by uuid references public.profiles(id);
alter table public.app_settings add column charge_recovery_days int not null default 14 check (charge_recovery_days between 1 and 90);
grant update (charge_recovery_days) on public.app_settings to authenticated;      -- ADMIN+ (la política app_settings_write ya exige is_admin); auditada por el disparador de app_settings

create function app_private.stamp_created_by() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.created_by is null then select p.id into new.created_by from public.profiles p where p.id = auth.uid(); end if;
  return new;
end $$;
create trigger stamp_created_by before insert on public.rates for each row execute function app_private.stamp_created_by();
create trigger stamp_created_by before insert on public.rate_exceptions for each row execute function app_private.stamp_created_by();

-- Una tarifa pasada no se reescribe: solo puede cerrarse (valid_to), nunca cambiar importe, días, inicio ni asignación.
create function app_private.rates_history_guard() returns trigger language plpgsql as $$
begin
  if (new.assignment_id, new.daily_amount_cents, new.weekdays, new.valid_from) is distinct from (old.assignment_id, old.daily_amount_cents, old.weekdays, old.valid_from) then
    raise exception 'rate_history_immutable' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger rates_history_guard before update on public.rates for each row execute function app_private.rates_history_guard();

-- ───────── 2. Cuota prevista: la MISMA resolución que el generador ─────────
-- excepción de fecha > tarifa vigente ese día (vigencia + días de la semana); 0 si no hay asignación vigente, conductor/unidad inactivos, domingo sin excepción o tarifa 0.
create function public.planned_daily_cents(p_assignment uuid, p_date date) returns bigint
language sql stable security invoker set search_path = '' as $$
  select coalesce((
    select x.amt
      from public.assignments a
      join public.drivers d on d.id = a.driver_id and d.active
      join public.units u on u.id = a.unit_id and u.active
      cross join lateral (select coalesce(
          (select e.amount_cents from public.rate_exceptions e where e.assignment_id = a.id and e.on_date = p_date),
          (select r.daily_amount_cents from public.rates r where r.assignment_id = a.id and r.valid_from <= p_date
              and (r.valid_to is null or r.valid_to >= p_date) and extract(isodow from p_date)::smallint = any (r.weekdays))) as amt) x
     where a.id = p_assignment and a.valid_from <= p_date and (a.valid_to is null or a.valid_to >= p_date)), 0)::bigint
$$;
revoke all on function public.planned_daily_cents(uuid, date) from public, anon, authenticated;
grant execute on function public.planned_daily_cents(uuid, date) to authenticated, service_role;

-- ───────── 3. Generador compartido ─────────
create function app_private.create_daily_charges(p_from date, p_to date, p_skip_closed boolean) returns int
language plpgsql security definer set search_path = '' as $$
declare v_n int;
begin
  insert into public.charges(assignment_id, kind, charge_date, amount_cents, week_start)
  select a.id, 'daily', g.d::date, pl.amt, app_private.week_start_of(g.d::date)
    from public.assignments a
    cross join lateral generate_series(greatest(a.valid_from, p_from)::timestamp, least(coalesce(a.valid_to, p_to), p_to)::timestamp, interval '1 day') g(d)
    cross join lateral (select public.planned_daily_cents(a.id, g.d::date) as amt) pl
   where pl.amt > 0
     and (not p_skip_closed or not exists (select 1 from public.weekly_closures w where w.assignment_id = a.id and w.week_start = app_private.week_start_of(g.d::date)))
   order by a.id, g.d
  on conflict (assignment_id, charge_date) where kind = 'daily' do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end $$;
revoke all on function app_private.create_daily_charges(date, date, boolean) from public, anon, authenticated;

-- Recuperación manual de un día (se mantiene): ahora comparte la lógica y respeta excepciones de domingo.
create or replace function public.generate_daily_charges(p_date date) returns int
language plpgsql security definer set search_path = '' as $$
declare v_n int;
begin
  if not app_private.is_service() then perform app_private.assert_admin(); end if;
  v_n := app_private.create_daily_charges(p_date, p_date, false);
  perform app_private.audit('generate_daily_charges', 'charges', null, jsonb_build_object('date', p_date, 'created', v_n));
  return v_n;
end $$;

-- Huecos: días ya ocurridos con cuota prevista y SIN cargo diario guardado.
create function app_private.charge_gaps_raw(p_through date, p_floor date)
returns table (assignment_id uuid, gap_date date, planned_cents bigint, reason text)
language sql stable security definer set search_path = '' as $$
  select a.id, g.d::date, pl.amt,
         case when exists (select 1 from public.weekly_closures w where w.assignment_id = a.id and w.week_start = app_private.week_start_of(g.d::date)) then 'closed_week'
              when g.d::date < p_floor then 'outside_window' else 'not_generated' end
    from public.assignments a
    cross join lateral generate_series(greatest(a.valid_from, p_through - 365)::timestamp, least(coalesce(a.valid_to, p_through), p_through)::timestamp, interval '1 day') g(d)
    cross join lateral (select public.planned_daily_cents(a.id, g.d::date) as amt) pl
   where pl.amt > 0 and not exists (select 1 from public.charges c where c.assignment_id = a.id and c.kind = 'daily' and c.charge_date = g.d::date)
$$;
revoke all on function app_private.charge_gaps_raw(date, date) from public, anon, authenticated;

-- ═════════ ensure_daily_charges: motor de cobranza (lo invoca la API; también ADMIN+ para recuperar) ═════════
-- p_through: último día (por defecto «hoy» local de America/Panama). p_from: inicio EXPLÍCITO (solo ADMIN+/servicio); por defecto through − (charge_recovery_days − 1).
-- Idempotente, sin duplicados (índice único + exclusión mutua por advisory lock), nunca toca cargos existentes ni semanas cerradas.
-- Devuelve {created, from, to, days_checked, skipped, gaps[], gaps_total, recovery_days}; gaps = días vencidos con cuota prevista y sin cargo que NO se generaron
-- (fuera de la ventana o en semana cerrada), nunca descartados en silencio.
create function public.ensure_daily_charges(p_through date default null, p_from date default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_service boolean := app_private.is_service(); v_today date := (now() at time zone app_private.tz())::date;
  v_to date; v_from date; v_win int; v_created int; v_gaps jsonb; v_total int;
begin
  if not v_service then perform app_private.assert_admin(); end if;
  select s.charge_recovery_days into v_win from public.app_settings s;
  v_to := coalesce(p_through, v_today);
  v_from := coalesce(p_from, v_to - (v_win - 1));
  if v_from > v_to then raise exception 'invalid_range' using errcode = '22023'; end if;
  if v_to - v_from > 366 then raise exception 'range_too_large' using errcode = '22023'; end if;
  if not pg_try_advisory_xact_lock(7405210) then
    return jsonb_build_object('created', 0, 'from', v_from, 'to', v_to, 'days_checked', 0, 'skipped', 'locked', 'gaps', '[]'::jsonb, 'gaps_total', 0, 'recovery_days', v_win);
  end if;
  v_created := app_private.create_daily_charges(v_from, v_to, true);          -- las semanas cerradas NO se tocan
  select count(*)::int, coalesce(jsonb_agg(jsonb_build_object('assignment_id', t.assignment_id, 'date', t.gap_date, 'planned_cents', t.planned_cents, 'reason', t.reason)
           order by t.gap_date, t.assignment_id) filter (where t.rn <= 200), '[]'::jsonb)
    into v_total, v_gaps
    from (select g.*, row_number() over (order by g.gap_date, g.assignment_id) rn from app_private.charge_gaps_raw(v_to, v_from) g) t;
  if v_created > 0 then
    perform app_private.audit('ensure_daily_charges', 'charges', null, jsonb_build_object('created', v_created, 'from', v_from, 'to', v_to,
      'days_checked', v_to - v_from + 1, 'explicit_from', p_from is not null, 'gaps_total', v_total, 'source', case when v_service then 'engine' else 'admin' end));
  end if;
  if v_total > 0 and not exists (select 1 from public.audit_logs l where l.action = 'ensure_daily_charges_gaps' and l.at > now() - interval '24 hours'
                                    and (l.detail ->> 'gaps_total')::int = v_total) then
    perform app_private.audit('ensure_daily_charges_gaps', 'charges', null, jsonb_build_object('gaps_total', v_total, 'from', v_from, 'to', v_to));
  end if;
  return jsonb_build_object('created', v_created, 'from', v_from, 'to', v_to, 'days_checked', v_to - v_from + 1, 'skipped', null,
    'gaps', v_gaps, 'gaps_total', v_total, 'recovery_days', v_win);
end $$;
revoke all on function public.ensure_daily_charges(date, date) from public, anon, authenticated;
grant execute on function public.ensure_daily_charges(date, date) to authenticated, service_role;

-- Cuotas sin generar pendientes de revisión administrativa (solo lectura).
create function public.charge_gaps(p_through date default null)
returns table (assignment_id uuid, unit_code text, operator_code text, driver_name text, gap_date date, planned_cents bigint, reason text)
language plpgsql stable security definer set search_path = '' as $$
declare v_to date := coalesce(p_through, (now() at time zone app_private.tz())::date); v_win int;
begin
  if not app_private.is_service() then perform app_private.assert_admin(); end if;
  select s.charge_recovery_days into v_win from public.app_settings s;
  return query
  select g.assignment_id, u.code, d.operator_code, btrim(d.first_name || ' ' || d.last_name), g.gap_date, g.planned_cents, g.reason
    from app_private.charge_gaps_raw(v_to, v_to - (v_win - 1)) g
    join public.assignments a on a.id = g.assignment_id join public.units u on u.id = a.unit_id join public.drivers d on d.id = a.driver_id
   order by g.gap_date, u.code;
end $$;
revoke all on function public.charge_gaps(date) from public, anon, authenticated;
grant execute on function public.charge_gaps(date) to authenticated, service_role;

-- ───────── 4. Detalle semanal: cuota prevista vs cargo generado ─────────
-- days[i] añade: planned_cents (cuota prevista ese día según tarifa/asignación vigente) y charge_generated (existe cargo diario guardado).
-- status: paid|partial|pending (hay cargo) · planned (día futuro con cuota prevista, sin cargo) · missing (día ya ocurrido con cuota prevista y SIN cargo: el motor no corrió)
--         · no_charge (no corresponde cuota; en semanas cerradas un día sin cargo también es no_charge). Nada se inserta desde lectura.
create or replace function public.weekly_collection_detail(p_week_start date, p_assignment uuid default null)
returns table (assignment_id uuid, previous_pending_cents bigint, previous_credit_cents bigint, days jsonb)
language plpgsql stable security invoker set search_path = '' as $$
declare v_tz text := app_private.tz(); v_today date := (now() at time zone app_private.tz())::date;
begin
  perform app_private.assert_staff();
  if extract(isodow from p_week_start) <> 1 then raise exception 'week_start_must_be_monday' using errcode = '22023'; end if;
  return query
  select a.id, prev.pending_cents, prev.credit_cents, d.days
    from public.assignments a
    cross join lateral public.assignment_position(a.id, p_week_start - 1) prev
    cross join lateral (
      with cov as (select c.charge_date, sum(c.remaining_cents)::bigint rem from public.assignment_coverage(a.id) c where c.kind <> 'opening' group by c.charge_date),
           closed as (select exists (select 1 from public.weekly_closures w where w.assignment_id = a.id and w.week_start = p_week_start) v)
      select jsonb_agg(jsonb_build_object(
               'date', g.d::date, 'weekday', extract(isodow from g.d)::int,
               'charge_cents', coalesce(ch.amt, 0), 'net_paid_cents', coalesce(pd.amt, 0), 'remaining_cents', coalesce(cov.rem, 0),
               'planned_cents', pl.amt, 'charge_generated', coalesce(ch.has_daily, false),
               'status', case when coalesce(ch.amt, 0) > 0 and (coalesce(ch.has_daily, false) or pl.amt = 0 or closed.v) then
                                case when coalesce(cov.rem, 0) = 0 then 'paid' when cov.rem >= ch.amt then 'pending' else 'partial' end
                              when pl.amt > 0 and not closed.v then case when g.d::date <= v_today then 'missing' else 'planned' end
                              else 'no_charge' end) order by g.d) as days
        from closed, generate_series(p_week_start::timestamp, (p_week_start + 6)::timestamp, interval '1 day') g(d)
        cross join lateral (select public.planned_daily_cents(a.id, g.d::date) as amt) pl
        left join lateral (select sum(c.amount_cents)::bigint amt, bool_or(c.kind = 'daily') has_daily from public.charges c
                            where c.assignment_id = a.id and c.charge_date = g.d::date and c.kind <> 'opening') ch on true
        left join lateral (select sum(p.net_cents)::bigint amt from public.payments p where p.assignment_id = a.id and p.voided_at is null
                              and (p.paid_at at time zone v_tz)::date = g.d::date) pd on true
        left join cov on cov.charge_date = g.d::date
    ) d
   where a.valid_from <= p_week_start + 6 and (a.valid_to is null or a.valid_to >= p_week_start) and (p_assignment is null or a.id = p_assignment);
end $$;

-- Tabla semanal: añade planned_cents (suma de la cuota prevista día a día por los PERÍODOS REALES de vigencia, no tarifa×6) y missing_days.
drop function public.weekly_collection_table(date);
create function public.weekly_collection_table(p_week_start date)
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
revoke all on function public.weekly_collection_table(date) from public, anon, authenticated;
grant execute on function public.weekly_collection_table(date) to authenticated, service_role;

-- ───────── 5. Historial de tarifas: change_rate con motivo y sin reescribir el pasado ─────────
drop function public.change_rate(uuid, bigint, date);
create function public.change_rate(p_assignment uuid, p_amount bigint, p_from date, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare a record; cur record; v_id uuid; v_reason text := nullif(btrim(p_reason), '');
begin
  perform app_private.assert_admin();
  select * into a from public.assignments where id = p_assignment for update;
  if not found then raise exception 'assignment_not_found' using errcode = 'P0002'; end if;
  if p_amount is null or p_amount < 0 then raise exception 'invalid_amount' using errcode = '22023'; end if;
  if p_from is null or p_from < a.valid_from or (a.valid_to is not null and p_from > a.valid_to) then raise exception 'invalid_dates' using errcode = '22023'; end if;
  select * into cur from public.rates where assignment_id = p_assignment and valid_to is null;
  if found and p_from <= cur.valid_from then raise exception 'invalid_dates' using errcode = '22023'; end if;
  -- La tarifa nueva aplica HACIA ADELANTE: no se reescriben cargos generados ni semanas cerradas.
  if exists (select 1 from public.charges c where c.assignment_id = p_assignment and c.kind = 'daily' and c.charge_date >= p_from) then
    raise exception 'rate_change_retroactive' using errcode = '22023', hint = 'Ya existen cuotas generadas desde esa fecha; la tarifa nueva aplica hacia adelante.'; end if;
  if exists (select 1 from public.weekly_closures w where w.assignment_id = p_assignment and w.week_start + 6 >= p_from) then
    raise exception 'rate_change_closed_week' using errcode = '22023', hint = 'La fecha cae en una semana cerrada o anterior a un cierre.'; end if;
  if found then update public.rates set valid_to = p_from - 1 where id = cur.id; end if;
  begin
    insert into public.rates(assignment_id, daily_amount_cents, valid_from, valid_to, created_by, reason)
    values (p_assignment, p_amount, p_from, a.valid_to, (select p.id from public.profiles p where p.id = auth.uid()), v_reason) returning id into v_id;
  exception when exclusion_violation then raise exception 'rate_overlap' using errcode = '23P01'; end;
  perform app_private.audit('change_rate', 'assignments', p_assignment, jsonb_build_object('rate_id', v_id, 'new_daily_cents', p_amount, 'from', p_from,
    'previous_daily_cents', cur.daily_amount_cents, 'reason', v_reason));
  return jsonb_build_object('assignment_id', p_assignment, 'rate_id', v_id, 'from', p_from, 'previous_daily_cents', cur.daily_amount_cents,
    'new_daily_cents', p_amount, 'existing_charges_from_date_unchanged', 0);
end $$;
revoke all on function public.change_rate(uuid, bigint, date, text) from public, anon, authenticated;
grant execute on function public.change_rate(uuid, bigint, date, text) to authenticated, service_role;

create or replace function public.start_assignment(p_driver_id uuid, p_unit_id uuid, p_valid_from date, p_daily_cents bigint default null, p_agreement_note text default null) returns uuid
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
  if p_daily_cents is not null then insert into public.rates(assignment_id, daily_amount_cents, valid_from, reason) values (v_id, p_daily_cents, p_valid_from, 'Tarifa inicial de la asignación'); end if;
  perform app_private.audit('start_assignment', 'assignments', v_id, jsonb_build_object('driver_id', p_driver_id, 'unit_id', p_unit_id, 'valid_from', p_valid_from, 'daily_cents', p_daily_cents));
  return v_id;
end $$;

-- Cambio de conductor/unidad: la asignación anterior conserva sus cargos y su tarifa; no se puede solapar el período ya cobrado (evita cobrar dos veces el mismo día).
create or replace function public.reassign_unit(p_unit_id uuid, p_new_driver_id uuid, p_valid_from date, p_daily_cents bigint default null, p_agreement_note text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare cur record;
begin
  perform app_private.assert_admin();
  select * into cur from public.assignments where unit_id = p_unit_id and valid_to is null for update;
  if found then
    if p_valid_from <= cur.valid_from then raise exception 'invalid_dates' using errcode = '22023'; end if;
    if exists (select 1 from public.charges c where c.assignment_id = cur.id and c.kind = 'daily' and c.charge_date >= p_valid_from) then
      raise exception 'assignment_change_retroactive' using errcode = '22023', hint = 'La asignación anterior ya tiene cuotas desde esa fecha; elige una fecha posterior.'; end if;
    update public.assignments set valid_to = p_valid_from - 1 where id = cur.id;
    update public.rates set valid_to = p_valid_from - 1 where assignment_id = cur.id and valid_to is null;
  end if;
  if exists (select 1 from public.assignments where driver_id = p_new_driver_id and valid_to is null) then raise exception 'driver_already_assigned' using errcode = '23P01'; end if;
  return public.start_assignment(p_new_driver_id, p_unit_id, p_valid_from, p_daily_cents, p_agreement_note);
end $$;

-- Historial por cambio de tarifa (una fila por tarifa; la primera es la inicial). ADMIN+.
create function public.rate_history(p_assignment uuid default null)
returns table (rate_id uuid, assignment_id uuid, unit_id uuid, unit_code text, driver_id uuid, operator_code text, driver_name text,
  previous_rate_id uuid, previous_daily_cents bigint, new_daily_cents bigint, valid_from date, previous_valid_to date, valid_to date,
  changed_by uuid, changed_by_name text, changed_at timestamptz, reason text, is_current boolean)
language plpgsql stable security definer set search_path = '' as $$
declare v_today date := (now() at time zone app_private.tz())::date;
begin
  perform app_private.assert_admin();
  return query
  select h.id, h.assignment_id, u.id, u.code, d.id, d.operator_code, btrim(d.first_name || ' ' || d.last_name),
         h.prev_id, h.prev_cents, h.daily_amount_cents, h.valid_from, h.prev_to, h.valid_to,
         h.created_by, coalesce(nullif(btrim(p.full_name), ''), p.email), h.created_at, h.reason,
         (h.valid_from <= v_today and (h.valid_to is null or h.valid_to >= v_today))
    from (select r.*, lag(r.id) over w prev_id, lag(r.daily_amount_cents) over w prev_cents, lag(r.valid_to) over w prev_to
            from public.rates r where p_assignment is null or r.assignment_id = p_assignment
            window w as (partition by r.assignment_id order by r.valid_from)) h
    join public.assignments a on a.id = h.assignment_id join public.units u on u.id = a.unit_id join public.drivers d on d.id = a.driver_id
    left join public.profiles p on p.id = h.created_by
   order by u.code, h.valid_from desc;
end $$;
revoke all on function public.rate_history(uuid) from public, anon, authenticated;
grant execute on function public.rate_history(uuid) to authenticated, service_role;

-- ───────── 6. Recordatorios: solo con obligaciones que YA existen ─────────
-- Un recordatorio de deuda no se programa si el conductor aún no tiene ningún cargo hasta hoy (p. ej. el motor de cobranza no ha generado nada):
-- no hay obligación que cobrar. El monto exigible real lo sigue calculando prepare_notification_send justo antes de enviar.
create or replace function public.schedule_reminders(p_now timestamptz default now(), p_grace interval default null) returns int
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
       and (s.kind = 'weekly_summary' or exists (select 1 from public.charges c where c.assignment_id = a.id and c.charge_date <= v_local::date))
    on conflict (driver_id, schedule_id, local_date) where schedule_id is not null do nothing;
    get diagnostics v_n = row_count;
    v_total := v_total + v_n;
  end loop;
  return v_total;
end $$;

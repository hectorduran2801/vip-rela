-- VIP · 0023 · Eliminar o dar de baja (archivar) conductores y unidades SIN romper la integridad contable.
-- SOLO local, NO aplicar a Supabase sin autorización. No destructiva: solo funciones y disparadores; no toca ninguna fila existente.
--
--  · ELIMINAR (delete_driver / delete_unit): únicamente si NO hay historial financiero real (pagos, ajustes, cierres, cargos que no sean
--    diarios —incluida la apertura/SALDO—, avisos o mensajes ya ENVIADOS). Los cargos diarios generados por el motor sin pagos asociados
--    no cuentan: se eliminan junto con la asignación, sus tarifas y excepciones. Todo queda en UNA fila de auditoría resumida.
--  · ARCHIVAR (archive_* / reactivate_*): reversible. Conductor → status 'inactive'; unidad → vehicle_status 'out_of_service' (active = false);
--    se termina la asignación vigente con fecha efectiva. Cargos, pagos y deuda NO se tocan; no se generan cuotas nuevas tras la baja
--    (planned_daily_cents exige conductor y unidad activos).
--  · Inmutabilidad: charges (solo kind 'daily'), driver_consents y unit_agreement_history aceptan DELETE ÚNICAMENTE cuando se cumplen A LA VEZ
--    (1) el indicador local `vip.cascade_delete` = 'on' (set_config(..., true), que solo ponen estas funciones) y (2) current_user es el
--    PROPIETARIO de la función de disparador (el rol de las funciones security definer). authenticated, anon y service_role NUNCA pasan,
--    aunque pongan el indicador. Pagos, ajustes, asignaciones de pago, cierres y auditoría siguen sin poder borrarse jamás.
set search_path = public, extensions;

-- ───────── 1. Disparador de borrado con excepción controlada ─────────
create function app_private.block_mutation_unless_cascade() returns trigger language plpgsql as $$
declare v_ok boolean := false;
begin
  if tg_op = 'DELETE' and tg_table_schema = 'public' then
    if tg_table_name = 'charges' then v_ok := old.kind = 'daily';
    elsif tg_table_name in ('driver_consents', 'unit_agreement_history') then v_ok := true; end if;
    if v_ok and coalesce(current_setting('vip.cascade_delete', true), '') = 'on'
       and current_user = (select pg_get_userbyid(p.proowner) from pg_proc p where p.oid = 'app_private.block_mutation_unless_cascade()'::regprocedure)
    then return old; end if;
  end if;
  raise exception '% sobre % no permitido: use las operaciones auditadas', tg_op, tg_table_name using errcode = '42501';
end $$;

drop trigger no_delete on public.charges;
create trigger no_delete before delete on public.charges for each row execute function app_private.block_mutation_unless_cascade();
drop trigger immutable on public.driver_consents;
create trigger immutable_update before update on public.driver_consents for each row execute function app_private.block_mutation();
create trigger immutable_delete before delete on public.driver_consents for each row execute function app_private.block_mutation_unless_cascade();
drop trigger no_mutation on public.unit_agreement_history;
create trigger no_update before update on public.unit_agreement_history for each row execute function app_private.block_mutation();
create trigger no_delete before delete on public.unit_agreement_history for each row execute function app_private.block_mutation_unless_cascade();

-- La auditoría fila a fila NO guarda datos personales de un conductor/unidad eliminado (cédula, teléfono, nombre): solo identificador y código.
-- (La fila de auditoría resumida de delete_driver/delete_unit describe lo eliminado.) Fuera de ese contexto el comportamiento es idéntico al anterior.
create or replace function app_private.audit_row() returns trigger language plpgsql security definer set search_path = '' as $$
declare v_row jsonb := to_jsonb(coalesce(new, old));
begin
  insert into public.audit_logs(actor, action, entity, entity_id, detail)
  values (auth.uid(), lower(tg_op), tg_table_name, case when (v_row ->> 'id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then (v_row ->> 'id')::uuid end,
          case when tg_op = 'DELETE' and tg_table_name in ('drivers', 'units') and coalesce(current_setting('vip.cascade_delete', true), '') = 'on'
                 then jsonb_build_object('old', jsonb_build_object('id', v_row -> 'id') || case tg_table_name when 'drivers' then jsonb_build_object('operator_code', v_row ->> 'operator_code')
                                                                                                      else jsonb_build_object('code', v_row ->> 'code') end)
               when tg_op = 'INSERT' then jsonb_build_object('new', to_jsonb(new))
               when tg_op = 'DELETE' then jsonb_build_object('old', to_jsonb(old))
               else jsonb_build_object('old', to_jsonb(old), 'new', to_jsonb(new)) end);
  return coalesce(new, old);
end $$;

-- ───────── 2. Plan: qué bloquea y qué se eliminaría (solo lectura) ─────────
create function app_private.delete_plan(p_kind text, p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_asg uuid[]; v_today date := (now() at time zone app_private.tz())::date; v_driver boolean := p_kind = 'driver';
  b jsonb; w jsonb; v_active jsonb; v_blocked text[]; v_info jsonb;
begin
  if v_driver then
    select coalesce(array_agg(a.id), '{}') into v_asg from public.assignments a where a.driver_id = p_id;
    select jsonb_build_object('id', d.id, 'operator_code', d.operator_code, 'status', d.status, 'archived', d.status = 'inactive') into v_info from public.drivers d where d.id = p_id;
  else
    select coalesce(array_agg(a.id), '{}') into v_asg from public.assignments a where a.unit_id = p_id;
    select jsonb_build_object('id', u.id, 'code', u.code, 'vehicle_status', u.vehicle_status, 'archived', u.vehicle_status = 'out_of_service') into v_info from public.units u where u.id = p_id;
  end if;
  if v_info is null then raise exception '%', case when v_driver then 'driver_not_found' else 'unit_not_found' end using errcode = 'P0002'; end if;

  b := jsonb_build_object(
    'payments',          (select count(*) from public.payments x where x.assignment_id = any (v_asg)),
    'adjustments',       (select count(*) from public.adjustments x where x.assignment_id = any (v_asg)),
    'closures',          (select count(*) from public.weekly_closures x where x.assignment_id = any (v_asg)),
    'non_daily_charges', (select count(*) from public.charges x where x.assignment_id = any (v_asg) and x.kind <> 'daily'),
    'opening_charges',   (select count(*) from public.charges x where x.assignment_id = any (v_asg) and x.kind = 'opening'),     -- subconjunto de non_daily_charges (informativo)
    'sent_notifications', case when v_driver then (select count(*) from public.notification_jobs j where j.driver_id = p_id and (j.status = 'sent' or j.sent_at is not null)) else 0 end,
    'sent_messages',     case when v_driver then (select count(*) from public.whatsapp_test_messages m where m.driver_id = p_id and m.status in ('sent', 'delivered', 'unconfirmed')) else 0 end,
    'in_flight',         case when v_driver then (select count(*) from public.notification_jobs j where j.driver_id = p_id and j.status = 'processing')
                                               + (select count(*) from public.whatsapp_test_messages m where m.driver_id = p_id and m.status = 'processing') else 0 end);
  w := jsonb_build_object(
    'assignments',   cardinality(v_asg),
    'daily_charges', (select count(*) from public.charges x where x.assignment_id = any (v_asg) and x.kind = 'daily'),
    'rates',         (select count(*) from public.rates x where x.assignment_id = any (v_asg)),
    'exceptions',    (select count(*) from public.rate_exceptions x where x.assignment_id = any (v_asg)),
    'pending_jobs',  case when v_driver then (select count(*) from public.notification_jobs j where j.driver_id = p_id and j.status <> 'sent' and j.sent_at is null and j.status <> 'processing') else 0 end,
    'consents',      case when v_driver then (select count(*) from public.driver_consents c where c.driver_id = p_id) else 0 end,
    'unsent_messages', case when v_driver then (select count(*) from public.whatsapp_test_messages m where m.driver_id = p_id and m.status not in ('sent', 'delivered', 'unconfirmed', 'processing')) else 0 end,
    'import_rows_unlinked', case when v_driver then (select count(*) from public.import_rows r where r.matched_driver_id = p_id) else 0 end,
    'agreement_history', case when v_driver then 0 else (select count(*) from public.unit_agreement_history h where h.unit_id = p_id) end);

  select array_agg(k order by k) into v_blocked from jsonb_each(b) e(k, v) where k <> 'opening_charges' and (e.v)::text::bigint > 0;
  select coalesce(jsonb_agg(jsonb_build_object('assignment_id', a.id, 'driver_id', a.driver_id, 'operator_code', d.operator_code, 'unit_id', a.unit_id, 'unit_code', u.code,
                                               'valid_from', a.valid_from, 'valid_to', a.valid_to) order by a.valid_from), '[]'::jsonb)
    into v_active
    from public.assignments a join public.drivers d on d.id = a.driver_id join public.units u on u.id = a.unit_id
   where a.id = any (v_asg) and (a.valid_to is null or a.valid_to >= v_today);

  return jsonb_build_object('kind', p_kind, 'entity', v_info, 'can_delete', v_blocked is null, 'blocked_by', to_jsonb(coalesce(v_blocked, '{}'::text[])),
    'blockers', b, 'will_delete', w, 'active_assignments', v_active, 'suggestion', case when v_blocked is null then 'delete' else 'archive' end);
end $$;
revoke all on function app_private.delete_plan(text, uuid) from public, anon, authenticated;

create function public.driver_delete_check(p_driver uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app_private.assert_admin();
  return app_private.delete_plan('driver', p_driver);
end $$;
create function public.unit_delete_check(p_unit uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app_private.assert_admin();
  return app_private.delete_plan('unit', p_unit);
end $$;

-- ───────── 3. Eliminar definitivamente ─────────
create function app_private.clean_reason(p_reason text) returns text language plpgsql immutable set search_path = '' as $$
declare v text := nullif(btrim(p_reason), '');
begin
  if length(v) > 500 then raise exception 'reason_too_long' using errcode = '22023'; end if;
  return v;
end $$;
revoke all on function app_private.clean_reason(text) from public, anon, authenticated;

create function public.delete_driver(p_driver uuid, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_reason text; d public.drivers; v_plan jsonb; v_units text[];
  n_charges int; n_exc int; n_rates int; n_asg int; n_cons int; n_jobs int; n_msgs int; n_rows int;
begin
  perform app_private.assert_admin();
  v_reason := app_private.clean_reason(p_reason);
  perform pg_advisory_xact_lock(7405210);                      -- el motor de cobranza (ensure_daily_charges) espera/omite mientras se elimina
  select * into d from public.drivers where id = p_driver for update;
  if not found then raise exception 'driver_not_found' using errcode = 'P0002'; end if;
  perform 1 from public.assignments a where a.driver_id = p_driver for update;      -- un pago concurrente espera (register_payment bloquea la asignación)
  v_plan := app_private.delete_plan('driver', p_driver);
  if not (v_plan ->> 'can_delete')::boolean then
    raise exception 'delete_blocked_has_history' using errcode = '23001', detail = (v_plan -> 'blockers')::text, hint = 'archive_driver';
  end if;
  select coalesce(array_agg(distinct u.code order by u.code), '{}') into v_units from public.assignments a join public.units u on u.id = a.unit_id where a.driver_id = p_driver;

  perform set_config('vip.cascade_delete', 'on', true);
  delete from public.charges c using public.assignments a where c.assignment_id = a.id and a.driver_id = p_driver and c.kind = 'daily';
  get diagnostics n_charges = row_count;
  delete from public.rate_exceptions x using public.assignments a where x.assignment_id = a.id and a.driver_id = p_driver;
  get diagnostics n_exc = row_count;
  delete from public.rates x using public.assignments a where x.assignment_id = a.id and a.driver_id = p_driver;
  get diagnostics n_rates = row_count;
  delete from public.assignments a where a.driver_id = p_driver;
  get diagnostics n_asg = row_count;
  delete from public.driver_consents where driver_id = p_driver;
  get diagnostics n_cons = row_count;
  delete from public.notification_jobs where driver_id = p_driver;
  get diagnostics n_jobs = row_count;
  delete from public.whatsapp_test_messages where driver_id = p_driver;
  get diagnostics n_msgs = row_count;
  update public.import_rows set matched_driver_id = null where matched_driver_id = p_driver;
  get diagnostics n_rows = row_count;
  delete from public.drivers where id = p_driver;
  perform set_config('vip.cascade_delete', 'off', true);

  v_plan := jsonb_build_object('assignments', n_asg, 'daily_charges', n_charges, 'rates', n_rates, 'exceptions', n_exc, 'pending_jobs', n_jobs,
                               'consents', n_cons, 'unsent_messages', n_msgs, 'import_rows_unlinked', n_rows);
  perform app_private.audit('delete_driver', 'drivers', p_driver, jsonb_build_object('operator_code', d.operator_code, 'status', d.status, 'reason', v_reason,
    'unit_codes', to_jsonb(v_units), 'deleted', v_plan));
  return jsonb_build_object('deleted', true, 'kind', 'driver', 'id', p_driver, 'operator_code', d.operator_code, 'reason', v_reason, 'deleted_counts', v_plan);
end $$;

create function public.delete_unit(p_unit uuid, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_reason text; u public.units; v_plan jsonb; v_ops text[];
  n_charges int; n_exc int; n_rates int; n_asg int; n_hist int;
begin
  perform app_private.assert_admin();
  v_reason := app_private.clean_reason(p_reason);
  perform pg_advisory_xact_lock(7405210);
  select * into u from public.units where id = p_unit for update;
  if not found then raise exception 'unit_not_found' using errcode = 'P0002'; end if;
  perform 1 from public.assignments a where a.unit_id = p_unit for update;
  v_plan := app_private.delete_plan('unit', p_unit);
  if not (v_plan ->> 'can_delete')::boolean then
    raise exception 'delete_blocked_has_history' using errcode = '23001', detail = (v_plan -> 'blockers')::text, hint = 'archive_unit';
  end if;
  select coalesce(array_agg(distinct d.operator_code order by d.operator_code), '{}') into v_ops from public.assignments a join public.drivers d on d.id = a.driver_id where a.unit_id = p_unit;

  perform set_config('vip.cascade_delete', 'on', true);
  delete from public.charges c using public.assignments a where c.assignment_id = a.id and a.unit_id = p_unit and c.kind = 'daily';
  get diagnostics n_charges = row_count;
  delete from public.rate_exceptions x using public.assignments a where x.assignment_id = a.id and a.unit_id = p_unit;
  get diagnostics n_exc = row_count;
  delete from public.rates x using public.assignments a where x.assignment_id = a.id and a.unit_id = p_unit;
  get diagnostics n_rates = row_count;
  delete from public.assignments a where a.unit_id = p_unit;
  get diagnostics n_asg = row_count;
  delete from public.unit_agreement_history where unit_id = p_unit;
  get diagnostics n_hist = row_count;
  delete from public.units where id = p_unit;
  perform set_config('vip.cascade_delete', 'off', true);

  v_plan := jsonb_build_object('assignments', n_asg, 'daily_charges', n_charges, 'rates', n_rates, 'exceptions', n_exc, 'agreement_history', n_hist);
  perform app_private.audit('delete_unit', 'units', p_unit, jsonb_build_object('code', u.code, 'vehicle_status', u.vehicle_status, 'reason', v_reason,
    'operator_codes', to_jsonb(v_ops), 'deleted', v_plan));
  return jsonb_build_object('deleted', true, 'kind', 'unit', 'id', p_unit, 'code', u.code, 'reason', v_reason, 'deleted_counts', v_plan);
end $$;

-- ───────── 4. Baja (archivar) y reactivación ─────────
-- Completa las cuotas vencidas de la ventana de recuperación de UNA asignación hasta la fecha efectiva (mientras conductor y unidad siguen activos):
-- así la baja no hace perder deuda ya devengada. Idempotente; respeta semanas cerradas; nunca toca cargos existentes.
create function app_private.complete_charges_for_archive(p_assignment uuid, p_through date) returns int
language plpgsql security definer set search_path = '' as $$
declare v_today date := (now() at time zone app_private.tz())::date; v_win int; v_n int;
begin
  select s.charge_recovery_days into v_win from public.app_settings s;
  insert into public.charges(assignment_id, kind, charge_date, amount_cents, week_start)
  select a.id, 'daily', g.d::date, pl.amt, app_private.week_start_of(g.d::date)
    from public.assignments a
    cross join lateral generate_series(greatest(a.valid_from, v_today - (v_win - 1))::timestamp, least(coalesce(a.valid_to, p_through), p_through, v_today)::timestamp, interval '1 day') g(d)
    cross join lateral (select public.planned_daily_cents(a.id, g.d::date) as amt) pl
   where a.id = p_assignment and pl.amt > 0
     and not exists (select 1 from public.weekly_closures w where w.assignment_id = a.id and w.week_start = app_private.week_start_of(g.d::date))
   order by g.d
  on conflict (assignment_id, charge_date) where kind = 'daily' do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end $$;
revoke all on function app_private.complete_charges_for_archive(uuid, date) from public, anon, authenticated;

-- Termina las asignaciones abiertas indicadas (fecha efectiva por defecto: hoy, o el inicio si aún no empezó). No toca cargos ni pagos.
create function app_private.end_open_assignments(p_driver uuid, p_unit uuid, p_effective date) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare a record; v_today date := (now() at time zone app_private.tz())::date; v_eff date; v_out jsonb := '[]'::jsonb; v_done int := 0; v_gen int := 0; v_g int;
begin
  for a in select x.* from public.assignments x where x.valid_to is null and ((p_driver is not null and x.driver_id = p_driver) or (p_unit is not null and x.unit_id = p_unit)) order by x.valid_from for update loop
    v_eff := coalesce(p_effective, greatest(v_today, a.valid_from));
    if v_eff < a.valid_from or exists (select 1 from public.charges c where c.assignment_id = a.id and c.charge_date > v_eff) then
      raise exception 'invalid_dates' using errcode = '22023', hint = 'La fecha efectiva es anterior al inicio de la asignación o a cuotas ya generadas.';
    end if;
    v_g := app_private.complete_charges_for_archive(a.id, v_eff);
    v_gen := v_gen + v_g;
    perform public.end_assignment(a.id, v_eff);
    v_out := v_out || jsonb_build_object('assignment_id', a.id, 'driver_id', a.driver_id, 'unit_id', a.unit_id, 'valid_to', v_eff);
    v_done := v_done + 1;
  end loop;
  return jsonb_build_object('ended', v_out, 'charges_completed', v_gen);
end $$;
revoke all on function app_private.end_open_assignments(uuid, uuid, date) from public, anon, authenticated;

create function public.archive_driver(p_driver uuid, p_reason text default null, p_effective date default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_reason text; d public.drivers; v_end jsonb; v_jobs int; v_msgs int; v_pending bigint;
begin
  perform app_private.assert_admin();
  v_reason := app_private.clean_reason(p_reason);
  select * into d from public.drivers where id = p_driver for update;
  if not found then raise exception 'driver_not_found' using errcode = 'P0002'; end if;
  if d.status = 'inactive' then raise exception 'already_archived' using errcode = '55000'; end if;
  v_end := app_private.end_open_assignments(p_driver, null, p_effective);          -- antes del cambio de estado: completa las cuotas vencidas
  update public.drivers set status = 'inactive' where id = p_driver;
  update public.notification_jobs set status = 'cancelled', error = 'conductor dado de baja' where driver_id = p_driver and status in ('pending', 'awaiting_approval');
  get diagnostics v_jobs = row_count;
  update public.whatsapp_test_messages set status = 'cancelled', processed_at = now(), error = 'conductor dado de baja' where driver_id = p_driver and status = 'prepared';
  get diagnostics v_msgs = row_count;
  select coalesce(sum(pos.pending_cents), 0)::bigint into v_pending from public.assignments a cross join lateral public.assignment_position(a.id) pos where a.driver_id = p_driver;
  perform app_private.audit('archive_driver', 'drivers', p_driver, jsonb_build_object('operator_code', d.operator_code, 'previous_status', d.status, 'reason', v_reason,
    'ended_assignments', jsonb_array_length(v_end -> 'ended'), 'charges_completed', v_end -> 'charges_completed', 'cancelled_jobs', v_jobs, 'cancelled_messages', v_msgs, 'pending_cents', v_pending));
  return jsonb_build_object('archived', true, 'kind', 'driver', 'id', p_driver, 'operator_code', d.operator_code, 'status', 'inactive', 'previous_status', d.status,
    'ended_assignments', v_end -> 'ended', 'charges_completed', v_end -> 'charges_completed', 'cancelled_jobs', v_jobs, 'cancelled_messages', v_msgs, 'pending_cents', v_pending, 'reason', v_reason);
end $$;

create function public.archive_unit(p_unit uuid, p_reason text default null, p_effective date default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_reason text; u public.units; v_end jsonb; v_pending bigint;
begin
  perform app_private.assert_admin();
  v_reason := app_private.clean_reason(p_reason);
  select * into u from public.units where id = p_unit for update;
  if not found then raise exception 'unit_not_found' using errcode = 'P0002'; end if;
  if u.vehicle_status = 'out_of_service' then raise exception 'already_archived' using errcode = '55000'; end if;
  v_end := app_private.end_open_assignments(null, p_unit, p_effective);
  update public.units set vehicle_status = 'out_of_service' where id = p_unit;
  select coalesce(sum(pos.pending_cents), 0)::bigint into v_pending from public.assignments a cross join lateral public.assignment_position(a.id) pos where a.unit_id = p_unit;
  perform app_private.audit('archive_unit', 'units', p_unit, jsonb_build_object('code', u.code, 'previous_vehicle_status', u.vehicle_status, 'reason', v_reason,
    'ended_assignments', jsonb_array_length(v_end -> 'ended'), 'charges_completed', v_end -> 'charges_completed', 'pending_cents', v_pending));
  return jsonb_build_object('archived', true, 'kind', 'unit', 'id', p_unit, 'code', u.code, 'vehicle_status', 'out_of_service', 'active', false, 'previous_vehicle_status', u.vehicle_status,
    'ended_assignments', v_end -> 'ended', 'charges_completed', v_end -> 'charges_completed', 'pending_cents', v_pending, 'reason', v_reason);
end $$;

-- Reactivar NO recrea la asignación terminada ni cuotas pasadas: se vuelve a asignar con start_assignment/reassign_unit.
create function public.reactivate_driver(p_driver uuid, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_reason text; d public.drivers;
begin
  perform app_private.assert_admin();
  v_reason := app_private.clean_reason(p_reason);
  select * into d from public.drivers where id = p_driver for update;
  if not found then raise exception 'driver_not_found' using errcode = 'P0002'; end if;
  if d.status <> 'inactive' then raise exception 'not_archived' using errcode = '55000'; end if;
  update public.drivers set status = 'active' where id = p_driver;
  perform app_private.audit('reactivate_driver', 'drivers', p_driver, jsonb_build_object('operator_code', d.operator_code, 'reason', v_reason));
  return jsonb_build_object('reactivated', true, 'kind', 'driver', 'id', p_driver, 'operator_code', d.operator_code, 'status', 'active',
    'has_active_assignment', exists (select 1 from public.assignments a where a.driver_id = p_driver and a.valid_to is null), 'reason', v_reason);
end $$;

create function public.reactivate_unit(p_unit uuid, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_reason text; u public.units;
begin
  perform app_private.assert_admin();
  v_reason := app_private.clean_reason(p_reason);
  select * into u from public.units where id = p_unit for update;
  if not found then raise exception 'unit_not_found' using errcode = 'P0002'; end if;
  if u.vehicle_status <> 'out_of_service' then raise exception 'not_archived' using errcode = '55000'; end if;
  update public.units set vehicle_status = 'active' where id = p_unit;
  perform app_private.audit('reactivate_unit', 'units', p_unit, jsonb_build_object('code', u.code, 'reason', v_reason));
  return jsonb_build_object('reactivated', true, 'kind', 'unit', 'id', p_unit, 'code', u.code, 'vehicle_status', 'active', 'active', true,
    'has_active_assignment', exists (select 1 from public.assignments a where a.unit_id = p_unit and a.valid_to is null), 'reason', v_reason);
end $$;

-- ───────── 5. Permisos: solo usuarios autenticados (el rol ADMIN+ se verifica dentro) ─────────
do $$ declare f text; begin
  foreach f in array array['public.driver_delete_check(uuid)', 'public.unit_delete_check(uuid)', 'public.delete_driver(uuid, text)', 'public.delete_unit(uuid, text)',
    'public.archive_driver(uuid, text, date)', 'public.archive_unit(uuid, text, date)', 'public.reactivate_driver(uuid, text)', 'public.reactivate_unit(uuid, text)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end $$;

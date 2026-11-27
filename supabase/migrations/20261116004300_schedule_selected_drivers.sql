-- VIP · 0043 · Horarios con conductores ELEGIDOS a mano (audiencia «selected»): se guarda la lista marcada y se envía a esa lista tal cual hasta que se edite.
-- No cambia la hora, los días ni la forma de enviar. Reversible: volver a las funciones de 0035 y quitar la columna.
set search_path = public, extensions;

alter table public.send_schedules add column assignment_ids uuid[] not null default '{}';
alter table public.send_schedules drop constraint send_schedules_audience_check;
alter table public.send_schedules add constraint send_schedules_audience_check check (audience in ('all', 'with_balance', 'without_balance', 'not_paid_today', 'paid_today', 'selected'));

drop function public.list_send_schedules();
create function public.list_send_schedules() returns table (id uuid, name text, local_time time, weekdays smallint[], template_id uuid, template_name text, audience text, enabled boolean,
  last_run_date date, last_run_status text, last_run_created int, last_run_total int, assignment_ids uuid[])
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app_private.assert_admin();
  return query select s.id, s.name, s.local_time, s.weekdays, s.template_id, t.name, s.audience, s.enabled, r.local_date, r.status, r.created, r.total, s.assignment_ids
    from public.send_schedules s left join public.message_templates t on t.id = s.template_id
    left join lateral (select x.* from public.send_schedule_runs x where x.schedule_id = s.id order by x.local_date desc limit 1) r on true
    order by s.local_time, s.name;
end $$;

drop function public.save_send_schedule(uuid, text, time, smallint[], uuid, text, boolean);
create function public.save_send_schedule(p_id uuid, p_name text, p_local_time time, p_weekdays smallint[], p_template uuid, p_audience text, p_enabled boolean, p_assignments uuid[] default null)
returns public.send_schedules language plpgsql security definer set search_path = '' as $$
declare r public.send_schedules; v_old public.send_schedules; v_ids uuid[] := '{}';
begin
  perform app_private.assert_admin();
  if p_template is not null and not exists (select 1 from public.message_templates t where t.id = p_template) then raise exception 'template_not_found' using errcode = 'P0002'; end if;
  if coalesce(p_enabled, false) and p_template is null then
    raise exception 'template_required' using errcode = '23514', detail = 'Un horario activo necesita una plantilla de mensaje asignada.';
  end if;
  if p_audience = 'selected' then
    select coalesce(array_agg(distinct a.id), '{}') into v_ids from public.assignments a where a.id = any (coalesce(p_assignments, '{}'));
    if coalesce(p_enabled, false) and cardinality(v_ids) = 0 then raise exception 'selection_required' using errcode = '23514'; end if;
  end if;
  if p_id is null then
    insert into public.send_schedules(name, local_time, weekdays, template_id, audience, enabled, armed_by, assignment_ids)
      values (btrim(p_name), p_local_time, p_weekdays, p_template, p_audience, coalesce(p_enabled, false), case when coalesce(p_enabled, false) then auth.uid() end, v_ids) returning * into r;
  else
    select * into v_old from public.send_schedules where id = p_id for update;
    if not found then raise exception 'schedule_not_found' using errcode = 'P0002'; end if;
    update public.send_schedules set name = btrim(p_name), local_time = p_local_time, weekdays = p_weekdays, template_id = p_template, audience = p_audience, enabled = coalesce(p_enabled, false),
           armed_by = case when coalesce(p_enabled, false) then (case when v_old.enabled then v_old.armed_by else auth.uid() end) else null end, assignment_ids = v_ids
     where id = p_id returning * into r;
  end if;
  perform app_private.audit('send_schedule.saved', 'send_schedules', r.id, jsonb_build_object('name', r.name, 'time', r.local_time, 'audience', r.audience, 'enabled', r.enabled, 'template_id', r.template_id, 'selected', cardinality(v_ids)));
  return r;
end $$;
revoke all on function public.list_send_schedules(), public.save_send_schedule(uuid, text, time, smallint[], uuid, text, boolean, uuid[]) from public, anon, authenticated;
grant execute on function public.list_send_schedules(), public.save_send_schedule(uuid, text, time, smallint[], uuid, text, boolean, uuid[]) to authenticated, service_role;

create or replace function public.run_send_schedules(p_now timestamptz default now()) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s record; a record; v_tz text := app_private.tz(); v_local timestamp := p_now at time zone app_private.tz(); v_date date := (p_now at time zone app_private.tz())::date;
  v_due timestamptz; v_claims text := current_setting('request.jwt.claims', true); v_created int; v_total int; v_skip jsonb; v_reason text; v_ran jsonb := '[]'::jsonb;
  v_grace interval := interval '3 hours'; v_ins int;
begin
  if not app_private.is_service() then raise exception 'forbidden' using errcode = '42501'; end if;
  for s in select * from public.send_schedules where enabled and template_id is not null order by local_time loop
    if not (extract(isodow from v_local)::smallint = any (s.weekdays)) then continue; end if;
    v_due := (v_date + s.local_time) at time zone v_tz;
    if v_due > p_now then continue; end if;
    insert into public.send_schedule_runs(schedule_id, local_date, status) values (s.id, v_date, case when p_now - v_due > v_grace then 'missed' else 'running' end) on conflict do nothing;
    get diagnostics v_ins = row_count;
    if v_ins = 0 then continue; end if;                                                    -- ya se ejecutó (o se dio por perdido) hoy
    if p_now - v_due > v_grace then continue; end if;                                      -- el worker estuvo apagado más de 3 h: no se envía a deshoras
    if s.armed_by is null then
      update public.send_schedule_runs set status = 'error', skipped = '{"sin_autorizacion": 1}' where schedule_id = s.id and local_date = v_date; continue;
    end if;
    perform set_config('request.jwt.claims', jsonb_build_object('sub', s.armed_by, 'role', 'authenticated')::text, true);     -- los mensajes salen autorizados por quien activó el horario
    v_created := 0; v_total := 0; v_skip := '{}'::jsonb;
    -- «selected»: la lista fija que marcó la administradora (tal cual, hayan pagado o no); solo cuentan los que siguen activos y con WhatsApp.
    for a in select * from app_private.send_schedule_audience(case when s.audience = 'selected' then 'all' else s.audience end, v_date) x
              where s.audience <> 'selected' or x.assignment_id = any (s.assignment_ids) loop
      v_total := v_total + 1;
      begin
        perform public.create_collection_message(a.assignment_id, s.template_id, 'sched:' || s.id || ':' || v_date || ':' || a.assignment_id, false);
        v_created := v_created + 1;
      exception when others then
        v_reason := sqlerrm;
        v_skip := jsonb_set(v_skip, array[v_reason], to_jsonb(coalesce((v_skip ->> v_reason)::int, 0) + 1));
      end;
    end loop;
    perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
    update public.send_schedule_runs set status = 'done', total = v_total, created = v_created, skipped = v_skip where schedule_id = s.id and local_date = v_date;
    insert into public.audit_logs(actor, action, entity, entity_id, detail)
      values (s.armed_by, 'send_schedule.ran', 'send_schedules', s.id, jsonb_build_object('name', s.name, 'date', v_date, 'audience', s.audience, 'total', v_total, 'created', v_created, 'skipped', v_skip));
    v_ran := v_ran || jsonb_build_object('schedule', s.name, 'total', v_total, 'created', v_created);
  end loop;
  perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
  return v_ran;
end $$;

-- VIP · 0055 · NO APLICAR EN REMOTO sin autorización expresa.
-- Un horario se ejecutaba con la cuenta que tuviera SELECCIONADA quien lo activó: activado por el super administrador y mirando otra cuenta,
-- enviaba a 0 (o, con audiencias no fijas, a conductores de la otra cuenta). Ahora se ejecuta siempre en la cuenta del propio horario.
-- Sin cambios de datos, de reglas de cobro ni de mensajes. Reversión: supabase/rollback/0055_schedule_account_down.sql
create or replace function public.run_send_schedules(p_now timestamptz default now()) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s record; a record; v_tz text := app_private.tz(); v_local timestamp := p_now at time zone app_private.tz(); v_date date := (p_now at time zone app_private.tz())::date;
  v_due timestamptz; v_claims text := current_setting('request.jwt.claims', true); v_created int; v_total int; v_skip jsonb; v_reason text; v_ran jsonb := '[]'::jsonb;
  v_role text; v_own uuid; v_prev uuid;
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
    -- El horario se ejecuta en SU cuenta. Quien lo activó debe pertenecer a ella o ser el super administrador, a quien se le fija esa cuenta solo mientras dura.
    select u.role::text, u.account_id into v_role, v_own from public.app_users u where u.user_id = s.armed_by;
    if v_role is distinct from 'super_admin' and v_own is distinct from s.account_id then
      update public.send_schedule_runs set status = 'error', skipped = '{"cuenta_distinta": 1}' where schedule_id = s.id and local_date = v_date; continue;
    end if;
    if v_role = 'super_admin' then
      select v.account_id into v_prev from public.account_view v where v.user_id = s.armed_by for update;
      delete from public.account_view where user_id = s.armed_by;
      if s.account_id is distinct from v_own then insert into public.account_view(user_id, account_id) values (s.armed_by, s.account_id); end if;
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
    if v_role = 'super_admin' then                                                          -- su selección vuelve a como estaba
      delete from public.account_view where user_id = s.armed_by;
      if v_prev is not null then insert into public.account_view(user_id, account_id) values (s.armed_by, v_prev); end if;
      v_prev := null;
    end if;
    update public.send_schedule_runs set status = 'done', total = v_total, created = v_created, skipped = v_skip where schedule_id = s.id and local_date = v_date;
    insert into public.audit_logs(actor, action, entity, entity_id, detail)
      values (s.armed_by, 'send_schedule.ran', 'send_schedules', s.id, jsonb_build_object('name', s.name, 'date', v_date, 'audience', s.audience, 'total', v_total, 'created', v_created, 'skipped', v_skip));
    v_ran := v_ran || jsonb_build_object('schedule', s.name, 'total', v_total, 'created', v_created);
  end loop;
  perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
  return v_ran;
end $$;

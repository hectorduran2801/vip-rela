-- VIP · 0029 · (1) Los pagos solo entran por el Excel: se cierran las operaciones manuales también para PostgREST/RPC.
--             (2) Fecha de corte (fecha de referencia de los DATOS del Excel) independiente de la semana y de la fecha de importación.
--             (3) El catálogo de variables ya no ofrece {{apellido}} (el nombre completo no se divide).
-- No borra ni modifica filas. La importación (apply_collection_sync, security definer) sigue usando register_payment / void_payment internamente.
-- Reversión: grant execute de nuevo a authenticated en las funciones de la sección 1; restaurar preview/apply de 0028.
set search_path = public, extensions;

-- ───────── 1. Pagos manuales fuera de PostgREST ─────────
do $$ declare f regprocedure; begin
  for f in select p.oid::regprocedure from pg_proc p where p.pronamespace = 'public'::regnamespace
            and p.proname in ('register_payment', 'void_payment', 'create_adjustment', 'close_week', 'generate_daily_charges') loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);       -- el servicio (motor de cuotas / tareas internas) conserva el acceso
  end loop;
end $$;
-- Los métodos de pago ya no se editan desde el cliente (la importación crea «Excel» como función de definidor).
drop policy if exists payment_methods_write on public.payment_methods;
revoke insert, update, delete on public.payment_methods from authenticated;

-- ───────── 2. Fecha de corte de los datos ─────────
alter table public.collection_sync_runs add column data_date date;

drop function app_private.collection_sync_guard(uuid, date);
create function app_private.collection_sync_guard(p_import uuid, p_week date, p_data_date date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_imp record; v_latest date; v_reasons text[] := '{}'; v_prior jsonb; v_who text; v_last record; v_today date := (now() at time zone app_private.tz())::date; v_newer record;
begin
  select i.file_name, i.file_sha256, i.created_at, i.created_by into v_imp from public.excel_imports i where i.id = p_import;
  select max(r.week_start) into v_latest from public.collection_sync_runs r where r.import_id <> p_import;
  if v_latest is not null and p_week < v_latest then v_reasons := v_reasons || array['older_week']; end if;
  if exists (select 1 from public.collection_sync_runs r join public.excel_imports i2 on i2.id = r.import_id
              where r.week_start = p_week and r.import_id <> p_import and i2.created_at > v_imp.created_at) then v_reasons := v_reasons || array['older_file_for_week']; end if;
  -- Datos con fecha de corte anterior a otros ya aplicados a la MISMA semana (p. ej. la copia del lunes subida el miércoles, después de la del martes).
  select r.data_date, r.applied_at, i2.file_name into v_newer from public.collection_sync_runs r join public.excel_imports i2 on i2.id = r.import_id
   where r.week_start = p_week and r.import_id <> p_import and r.data_date is not null and r.data_date > p_data_date order by r.data_date desc, r.applied_at desc limit 1;
  if v_newer.data_date is not null then v_reasons := v_reasons || array['older_data_date']; end if;
  select coalesce(jsonb_agg(jsonb_build_object('weekStart', r.week_start, 'dataDate', r.data_date, 'appliedAt', r.applied_at, 'appliedBy', coalesce(nullif(p.full_name, ''), p.email)) order by r.applied_at desc), '[]'::jsonb)
    into v_prior from public.collection_sync_runs r left join public.profiles p on p.id = r.applied_by where r.import_id = p_import;
  select coalesce(nullif(p.full_name, ''), p.email) into v_who from public.profiles p where p.id = v_imp.created_by;
  select r.week_start, r.data_date, r.applied_at, i2.file_name into v_last from public.collection_sync_runs r join public.excel_imports i2 on i2.id = r.import_id
   where r.import_id <> p_import order by r.applied_at desc limit 1;
  return jsonb_build_object('historical', cardinality(v_reasons) > 0, 'reasons', to_jsonb(v_reasons), 'latestWeek', v_latest, 'dataDate', p_data_date,
    'newerData', case when v_newer.data_date is null then null else jsonb_build_object('dataDate', v_newer.data_date, 'appliedAt', v_newer.applied_at, 'fileName', v_newer.file_name) end,
    'lastRun', case when v_last.applied_at is null then null else jsonb_build_object('weekStart', v_last.week_start, 'dataDate', v_last.data_date, 'appliedAt', v_last.applied_at, 'fileName', v_last.file_name) end,
    'import', jsonb_build_object('fileName', v_imp.file_name, 'sha256', v_imp.file_sha256, 'uploadedAt', v_imp.created_at, 'uploadedBy', v_who), 'priorRuns', v_prior);
end $$;
revoke all on function app_private.collection_sync_guard(uuid, date, date) from public, anon, authenticated;
grant execute on function app_private.collection_sync_guard(uuid, date, date) to authenticated, service_role;

drop function public.preview_collection_sync(uuid, date);
create function public.preview_collection_sync(p_import uuid, p_week_start date, p_data_date date default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_dd date := coalesce(p_data_date, (now() at time zone app_private.tz())::date);
begin
  perform app_private.assert_admin();
  if v_dd > (now() at time zone app_private.tz())::date then raise exception 'invalid_data_date' using errcode = '22023'; end if;
  return app_private.collection_sync(p_import, p_week_start, false, null) || jsonb_build_object('guard', app_private.collection_sync_guard(p_import, p_week_start, v_dd));
end $$;
revoke all on function public.preview_collection_sync(uuid, date, date) from public, anon, authenticated;
grant execute on function public.preview_collection_sync(uuid, date, date) to authenticated, service_role;

drop function public.apply_collection_sync(uuid, date, text, boolean);
create function public.apply_collection_sync(p_import uuid, p_week_start date, p_note text default null, p_confirm_historical boolean default false, p_data_date date default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare g jsonb; v_out jsonb; v_dd date := coalesce(p_data_date, (now() at time zone app_private.tz())::date);
begin
  perform app_private.assert_admin();
  if v_dd > (now() at time zone app_private.tz())::date then raise exception 'invalid_data_date' using errcode = '22023'; end if;
  g := app_private.collection_sync_guard(p_import, p_week_start, v_dd);
  if (g ->> 'historical')::boolean and not (coalesce(p_confirm_historical, false) and length(btrim(coalesce(p_note, ''))) >= 3) then
    raise exception 'historical_import_requires_confirmation' using errcode = '22023', detail = g::text;
  end if;
  v_out := app_private.collection_sync(p_import, p_week_start, true, p_note);
  insert into public.collection_sync_runs(import_id, week_start, data_date, applied_by, historical, historical_reasons, note, already_up_to_date)
  values (p_import, p_week_start, v_dd, auth.uid(), (g ->> 'historical')::boolean, array(select jsonb_array_elements_text(g -> 'reasons')), nullif(btrim(p_note), ''), coalesce((v_out ->> 'already_up_to_date')::boolean, false));
  if (g ->> 'historical')::boolean then
    perform app_private.audit('collection_sync_historical', 'excel_imports', p_import, jsonb_build_object('week_start', p_week_start, 'data_date', v_dd, 'reasons', g -> 'reasons', 'note', nullif(btrim(p_note), '')));
  end if;
  return v_out || jsonb_build_object('guard', g);
end $$;
revoke all on function public.apply_collection_sync(uuid, date, text, boolean, date) from public, anon, authenticated;
grant execute on function public.apply_collection_sync(uuid, date, text, boolean, date) to authenticated, service_role;

-- ───────── 3. Variables: sin {{apellido}} en el selector ─────────
-- El resolvedor la sigue reconociendo (queda «sin resolver» y bloquea el envío), para no enviar jamás un mensaje con un apellido inventado.
alter function public.template_variables() rename to template_variables_v2;
create function public.template_variables()
returns table ("group" text, code text, label text, description text, example text)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app_private.assert_staff();
  return query select v."group", v.code, v.label,
    case when v.code = 'nombre' then 'Nombre completo de la persona (equivale a nombre_completo; se conserva por compatibilidad).' else v.description end,
    v.example from public.template_variables_v2() v where v.code <> 'apellido';
end $$;
revoke all on function public.template_variables(), public.template_variables_v2() from public, anon, authenticated;
grant execute on function public.template_variables() to authenticated, service_role;

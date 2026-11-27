-- ══════════════════════════════════════════════════════════════════════════
-- 0025 · Activación EXPLÍCITA de horarios + «sin ponerse al día» + auditoría del proveedor de WhatsApp
-- SOLO local: NO aplicar a Supabase sin autorización. No destructiva: NO modifica ninguna fila existente (ni horarios, ni plantillas, ni
-- trabajos), ni migraciones anteriores. Solo agrega columnas nulables, triggers, funciones y redefine schedule_reminders / complete_notification.
--
-- Incidente que motiva esta migración: un horario ACTIVO se movió de 5:00 p. m. a 4:20 p. m. a las 4:17 y a las 4:20 salió un WhatsApp real.
--   1) La ÚNICA vía para pasar enabled false→true para un usuario (authenticated/anon) es public.activate_schedule(id, true).
--      Crear un horario, editar hora/días/ámbito/etiqueta, asignar o editar una plantilla NUNCA lo activan. Apagar sigue libre.
--   2) armed_at: la hora a partir de la cual el horario puede disparar. Un trigger la pone en now() cada vez que cambian
--      enabled, kind, local_time, weekdays, template_id o scope. schedule_reminders solo programa ocurrencias con hora ≥ armed_at:
--      nada es retroactivo (la ventana de tolerancia grace_minutes aplica solo a ocurrencias ≥ armed_at).
--      Los horarios existentes quedan con armed_at NULO = comportamiento anterior hasta que alguien los modifique.
--   3) schedule_activation_preview: qué pasaría al activar (texto de ejemplo, variables, conductores elegibles, próxima ejecución).
--   4) notification_jobs conserva ahora el resultado del proveedor (id de mensaje, números, acuse) cuando el worker lo provee.
-- ══════════════════════════════════════════════════════════════════════════

-- ───────── 1. Columnas nuevas (todas nulables; sin tocar filas) ─────────
alter table public.notification_schedules add column armed_at timestamptz, add column deactivated_reason text, add column deactivated_at timestamptz;
alter table public.notification_schedules add constraint notification_schedules_deactivated_reason_check check (deactivated_reason is null or deactivated_reason in ('config_changed', 'manual'));
comment on column public.notification_schedules.deactivated_reason is 'config_changed = se desactivó solo porque cambió su configuración (la UI debe pedir revisar y reactivar); manual = apagado por el usuario. Se limpia al activar.';
comment on column public.notification_schedules.armed_at is
  'Hora a partir de la cual el horario puede disparar. La fija un trigger (now()) cuando cambian enabled/kind/local_time/weekdays/template_id/scope. NULA = horario anterior a 0025 sin modificar (comportamiento previo).';

alter table public.notification_jobs
  add column schedule_armed_at timestamptz,
  add column provider_message_id text,
  add column sender_phone text,
  add column recipient_phone text,
  add column delivery_status text,
  add column delivered_at timestamptz;
alter table public.notification_jobs add constraint notification_jobs_delivery_status_check
  check (delivery_status is null or delivery_status in ('accepted', 'delivered', 'read'));
alter table public.notification_jobs add constraint notification_jobs_delivered_requires_ack
  check (delivered_at is null or delivery_status in ('delivered', 'read'));       -- nunca «entregado» sin acuse real
comment on column public.notification_jobs.schedule_armed_at is 'Snapshot de notification_schedules.armed_at al crear el job. prepare_notification_send cancela el job si difiere del actual o si el horario ya no está activo. Nulo = job antiguo/manual (solo se exige horario activo).';
comment on column public.notification_jobs.provider_message_id is 'Id del mensaje devuelto por el proveedor (OpenWA) en un envío REAL. Nulo en dry-run y en envíos anteriores a 0025.';
comment on column public.notification_jobs.delivery_status is 'accepted = el proveedor aceptó el envío (sin acuse de entrega); delivered/read solo con acuse real del proveedor.';

-- ───────── 2. Activación: solo por activate_schedule ─────────
-- Trigger de INVOKER (no security definer): current_user es el rol REAL de quien ejecuta (un cliente no puede falsificarlo).
-- Los roles de cliente solo pasan enabled false→true (o insertar activo) cuando la ejecuta activate_schedule: dentro de esa función
-- security definer current_user es el dueño de la función y el indicador local vip.schedule_activation lo habilita (mismo patrón que vip.cascade_delete).
create function app_private.guard_schedule_activation() returns trigger language plpgsql set search_path = '' as $$
declare v_owner name;
begin
  if new.enabled and (tg_op = 'INSERT' or not old.enabled) and (current_user in ('authenticated', 'anon')) then
    select pg_get_userbyid(p.proowner) into v_owner from pg_proc p where p.oid = 'app_private.guard_schedule_activation()'::regprocedure;
    if not (coalesce(current_setting('vip.schedule_activation', true), '') = 'on' and current_user = v_owner) then
      raise exception 'direct_activation_forbidden' using errcode = '42501',
        detail = 'Un horario solo se activa con la acción explícita «Activar» (activate_schedule) y su confirmación.',
        hint = 'Cree o edite el horario desactivado y actívelo después con activate_schedule(id, true).';
    end if;
  end if;
  return new;
end $$;
create trigger a_guard_activation before insert or update on public.notification_schedules for each row execute function app_private.guard_schedule_activation();

-- ───────── 3. armed_at + auto-desactivación: nada es retroactivo y editar un horario ACTIVO jamás deja salir un envío sin nueva confirmación ─────────
-- Un cliente nunca fija armed_at/deactivated_* a mano. Reglas (BEFORE INSERT/UPDATE, de invoker):
--  · horario ACTIVO (y sigue activo en el UPDATE) que cambia kind/local_time/weekdays/template_id/scope → se DESACTIVA en el mismo UPDATE
--    (enabled=false, deactivated_reason='config_changed'); aunque el UPDATE reenvíe enabled=true (también para service_role/superusuario). Solo activate_schedule reactiva.
--  · apagar (true→false) sin cambio de configuración → deactivated_reason='manual'; activar (false→true) limpia deactivated_*.
--  · armed_at = now() cuando cambian enabled/kind/local_time/weekdays/template_id/scope. La etiqueta no cambia nada de esto.
create function app_private.set_schedule_armed_at() returns trigger language plpgsql set search_path = '' as $$
declare v_client boolean := current_user in ('authenticated', 'anon'); v_cfg boolean := false; v_en boolean := false;
begin
  if tg_op = 'INSERT' then
    new.armed_at := case when v_client then now() else coalesce(new.armed_at, now()) end;
    if v_client then new.deactivated_reason := null; new.deactivated_at := null; end if;
    return new;
  end if;
  v_cfg := new.kind is distinct from old.kind or new.local_time is distinct from old.local_time or new.weekdays is distinct from old.weekdays
        or new.template_id is distinct from old.template_id or new.scope is distinct from old.scope;
  v_en := new.enabled is distinct from old.enabled;
  if old.enabled and new.enabled and v_cfg then
    new.enabled := false; new.deactivated_reason := 'config_changed'; new.deactivated_at := now(); new.armed_at := now();
  elsif v_en or v_cfg then
    new.armed_at := now();
    if v_en and old.enabled then new.deactivated_reason := 'manual'; new.deactivated_at := now();
    elsif v_en then new.deactivated_reason := null; new.deactivated_at := null; end if;
  elsif v_client then
    new.armed_at := old.armed_at; new.deactivated_reason := old.deactivated_reason; new.deactivated_at := old.deactivated_at;
  end if;
  return new;
end $$;
create trigger h_set_armed_at before insert or update on public.notification_schedules for each row execute function app_private.set_schedule_armed_at();

-- AFTER UPDATE (security definer): al armarse de nuevo se descartan TODOS los trabajos pendientes / por aprobar del horario (configuración anterior).
-- Nunca se tocan sent/failed/historial ni el que ya está `processing` (lo frena la verificación final del worker). Si fue auto-desactivación, queda auditoría.
create function app_private.cancel_stale_schedule_jobs() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.armed_at is not null and new.armed_at is distinct from old.armed_at then
    update public.notification_jobs set status = 'cancelled', error = 'Horario modificado: trabajo pendiente anterior descartado'
     where schedule_id = new.id and status in ('pending', 'awaiting_approval');
  end if;
  if old.enabled and not new.enabled and new.deactivated_reason = 'config_changed' then
    perform app_private.audit('schedule_auto_deactivated', 'notification_schedules', new.id, jsonb_build_object(
      'schedule_id', new.id, 'label', new.label, 'reason', 'config_changed', 'actor', auth.uid(),
      'changes', (select coalesce(jsonb_object_agg(c.k, jsonb_build_object('old', c.o, 'new', c.n)), '{}'::jsonb) from (values
          ('kind', to_jsonb(old.kind), to_jsonb(new.kind)), ('local_time', to_jsonb(old.local_time), to_jsonb(new.local_time)),
          ('weekdays', to_jsonb(old.weekdays), to_jsonb(new.weekdays)), ('template_id', to_jsonb(old.template_id), to_jsonb(new.template_id)),
          ('scope', to_jsonb(old.scope), to_jsonb(new.scope))) as c(k, o, n) where c.o is distinct from c.n)));
  end if;
  return null;
end $$;
create trigger i_cancel_stale_jobs after update on public.notification_schedules for each row execute function app_private.cancel_stale_schedule_jobs();

-- ───────── 4. schedule_reminders: solo ocurrencias ≥ armed_at ─────────
create or replace function public.schedule_reminders(p_now timestamptz default now(), p_grace interval default null) returns int
language plpgsql security definer set search_path = '' as $$
declare v_total int := 0; v_n int; s record; v_set record; v_local timestamp; v_due timestamptz; v_grace interval;
begin
  select * into v_set from public.app_settings;
  for s in select sc.* from public.notification_schedules sc where sc.enabled
       and exists (select 1 from public.message_templates t where t.id = sc.template_id) loop       -- sin plantilla válida: no se programa nada
    v_local := p_now at time zone v_set.timezone;
    if not (extract(isodow from v_local)::smallint = any (s.weekdays)) then continue; end if;
    v_due := (v_local::date + s.local_time) at time zone v_set.timezone;
    v_grace := coalesce(p_grace, make_interval(mins => v_set.grace_minutes));
    if v_due > p_now or p_now - v_due > v_grace then continue; end if;
    if s.armed_at is not null and v_due < s.armed_at then continue; end if;       -- la ocurrencia ya había pasado cuando se armó el horario: no se pone al día
    insert into public.notification_jobs(driver_id, kind, local_date, scheduled_for, schedule_id, schedule_armed_at)
    select a.driver_id, s.kind, v_local::date, v_due, s.id, s.armed_at
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

-- ───────── 5. Análisis de una plantilla con el MISMO resolvedor del envío ─────────
-- {uses: [códigos usados], unknown: [no existentes en el catálogo], text_example: texto con los ejemplos del catálogo}
create function app_private.template_analysis(p_body text) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_ex jsonb; v_res jsonb; v_uses text[];
begin
  select coalesce(jsonb_object_agg(code, example), '{}'::jsonb) into v_ex from public.template_variables();
  v_res := app_private.render_template_ex(p_body, v_ex);
  select coalesce(array_agg(distinct coalesce(nullif(m.g[2], ''), '(vacía)') order by coalesce(nullif(m.g[2], ''), '(vacía)')), '{}')
    into v_uses from regexp_matches(coalesce(p_body, ''), '(\{\{\s*([^{}]*?)\s*\}\})', 'g') as m(g);
  return jsonb_build_object('uses', to_jsonb(v_uses), 'unknown', v_res -> 'unresolved', 'text_example', v_res ->> 'text');
end $$;
revoke all on function app_private.template_analysis(text), app_private.guard_schedule_activation(),
  app_private.set_schedule_armed_at(), app_private.cancel_stale_schedule_jobs() from public, anon, authenticated;
grant execute on function app_private.template_analysis(text) to service_role;

-- Marca de tiempo en ISO 8601 UTC, independiente de la zona de la sesión (contrato estable para la API/UI).
create function app_private.iso_utc(p_ts timestamptz) returns text language sql immutable set search_path = '' as $$
  select to_char(p_ts at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
$$;
revoke all on function app_private.iso_utc(timestamptz) from public, anon, authenticated;
grant execute on function app_private.iso_utc(timestamptz) to authenticated, service_role;

-- Próxima ejecución real: respeta días, armed_at (un horario apagado se «armaría» al activarlo, ahora) y solo cuenta el futuro.
create function app_private.schedule_next_occurrence(p_schedule uuid, p_now timestamptz) returns timestamptz
language plpgsql stable security definer set search_path = '' as $$
declare s record; v_tz text := app_private.tz(); v_today date; v_floor timestamptz; v_due timestamptz;
begin
  select * into s from public.notification_schedules where id = p_schedule;
  if not found then return null; end if;
  v_today := (p_now at time zone v_tz)::date;
  v_floor := case when s.enabled then coalesce(s.armed_at, '-infinity'::timestamptz) else p_now end;
  for i in 0..14 loop
    if extract(isodow from v_today + i)::smallint = any (s.weekdays) then
      v_due := ((v_today + i) + s.local_time) at time zone v_tz;
      if v_due > p_now and v_due >= v_floor then return v_due; end if;
    end if;
  end loop;
  return null;
end $$;
revoke all on function app_private.schedule_next_occurrence(uuid, timestamptz) from public, anon, authenticated;
grant execute on function app_private.schedule_next_occurrence(uuid, timestamptz) to service_role;

-- ───────── 6. Vista previa de activación (solo lectura) ─────────
create function public.schedule_activation_preview(p_schedule uuid, p_now timestamptz default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s record; t record; v_an jsonb; v_next timestamptz; v_now timestamptz := coalesce(p_now, now()); v_tz text := app_private.tz();
  v_today date; v_eligible int; v_blockers text[] := '{}';
begin
  perform app_private.assert_admin();
  select * into s from public.notification_schedules where id = p_schedule;
  if not found then raise exception 'schedule_not_found' using errcode = 'P0002'; end if;
  select * into t from public.message_templates where id = s.template_id;
  v_today := (v_now at time zone v_tz)::date;
  if t.id is not null then v_an := app_private.template_analysis(t.body); end if;

  if s.enabled then v_blockers := array_append(v_blockers, 'already_active'); end if;
  if t.id is null then v_blockers := array_append(v_blockers, 'no_template');
  elsif jsonb_array_length(v_an -> 'unknown') > 0 then v_blockers := array_append(v_blockers, 'unknown_variables'); end if;

  v_next := app_private.schedule_next_occurrence(p_schedule, v_now);

  -- Conductores POTENCIALMENTE elegibles hoy: mismas condiciones que schedule_reminders (activos, asignación vigente, teléfono válido,
  -- autorización de WhatsApp vigente, recordatorios no pausados) y, en recordatorios de deuda, con monto pendiente según el ámbito del horario
  -- (assignment_dues, FIFO). No incluye límites de frecuencia ni pagos posteriores al momento de la consulta.
  select count(distinct a.driver_id)::int into v_eligible
    from public.assignments a join public.drivers d on d.id = a.driver_id
   where a.valid_from <= v_today and (a.valid_to is null or a.valid_to >= v_today)
     and d.status = 'active' and d.whatsapp_consent and not d.reminders_paused
     and d.phone_e164 ~ '^\+[1-9][0-9]{6,14}$'
     and (s.kind = 'weekly_summary'
          or (select case coalesce(s.scope, 'total') when 'today' then x.today_cents when 'overdue' then x.overdue_cents else x.today_cents + x.overdue_cents end
                from public.assignment_dues(a.id, v_today) x) > 0);

  return jsonb_build_object(
    'schedule', jsonb_build_object('id', s.id, 'kind', s.kind, 'label', s.label, 'local_time', s.local_time, 'weekdays', to_jsonb(s.weekdays),
        'scope', s.scope, 'enabled', s.enabled, 'timezone', v_tz, 'deactivated_reason', s.deactivated_reason, 'deactivated_at', app_private.iso_utc(s.deactivated_at),
        'next_is_today', (v_next is not null and (v_next at time zone v_tz)::date = v_today),
        'minutes_until_next', case when v_next is null then null else floor(extract(epoch from (v_next - v_now)) / 60)::int end, 'armed_at', app_private.iso_utc(s.armed_at),
        'next_occurrence', app_private.iso_utc(v_next), 'next_occurrence_local', to_char(v_next at time zone v_tz, 'YYYY-MM-DD HH24:MI')),
    'template', case when t.id is not null then jsonb_build_object('id', t.id, 'name', t.name, 'body', t.body) end,
    'text_example', v_an -> 'text_example',
    'uses_variables', coalesce(v_an -> 'uses', '[]'::jsonb),
    'unknown_variables', coalesce(v_an -> 'unknown', '[]'::jsonb),
    'eligible_drivers', v_eligible,
    'eligible_drivers_reason', null,
    'can_activate', cardinality(v_blockers) = 0,
    'blockers', to_jsonb(v_blockers));
end $$;
revoke all on function public.schedule_activation_preview(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.schedule_activation_preview(uuid, timestamptz) to authenticated, service_role;

-- ───────── 7. Activar / desactivar (únicas operaciones de la UI sobre `enabled`) ─────────
create function public.activate_schedule(p_schedule uuid, p_confirm boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s record; t record; v_an jsonb; v_unk text; r record;
begin
  perform app_private.assert_admin();
  select * into s from public.notification_schedules where id = p_schedule for update;
  if not found then raise exception 'schedule_not_found' using errcode = 'P0002'; end if;
  if p_confirm is distinct from true then
    raise exception 'activation_not_confirmed' using errcode = '22023',
      detail = 'Activar un horario puede enviar WhatsApp reales a los conductores y requiere confirmación explícita.',
      hint = 'Revise la vista previa de activación y confirme (confirm = true).';
  end if;
  if s.enabled then raise exception 'already_active' using errcode = '55000', detail = 'El horario ya está activo.'; end if;
  select * into t from public.message_templates where id = s.template_id;
  if t.id is null then
    raise exception 'template_required' using errcode = '23514',
      detail = 'Un horario activo necesita una plantilla de mensaje asignada.',
      hint = 'Asigne o cree una plantilla para el horario antes de activarlo.';
  end if;
  v_an := app_private.template_analysis(t.body);
  if jsonb_array_length(v_an -> 'unknown') > 0 then
    select string_agg('{{' || e || '}}', ', ') into v_unk from jsonb_array_elements_text(v_an -> 'unknown') e;
    raise exception 'template_has_unresolved_variables' using errcode = '22023',
      detail = 'La plantilla usa variables desconocidas: ' || v_unk || '.',
      hint = 'Corrija la plantilla con variables del catálogo antes de activar el horario.';
  end if;

  perform set_config('vip.schedule_activation', 'on', true);
  update public.notification_schedules set enabled = true where id = p_schedule returning * into r;     -- el trigger fija armed_at = now()
  perform set_config('vip.schedule_activation', 'off', true);

  perform app_private.audit('schedule_activated', 'notification_schedules', p_schedule, jsonb_build_object(
    'schedule_id', r.id, 'label', r.label, 'kind', r.kind, 'local_time', r.local_time, 'weekdays', to_jsonb(r.weekdays), 'scope', r.scope,
    'template_id', t.id, 'template_name', t.name, 'uses_variables', v_an -> 'uses', 'armed_at', app_private.iso_utc(r.armed_at), 'activated_by', auth.uid(),
    'confirmed', true, 'next_occurrence', app_private.iso_utc(app_private.schedule_next_occurrence(p_schedule, now()))));
  return jsonb_build_object('id', r.id, 'enabled', true, 'armed_at', app_private.iso_utc(r.armed_at),
    'next_occurrence', app_private.iso_utc(app_private.schedule_next_occurrence(p_schedule, now())),
    'next_occurrence_local', to_char(app_private.schedule_next_occurrence(p_schedule, now()) at time zone app_private.tz(), 'YYYY-MM-DD HH24:MI'));
end $$;
revoke all on function public.activate_schedule(uuid, boolean) from public, anon, authenticated;
grant execute on function public.activate_schedule(uuid, boolean) to authenticated, service_role;

-- Idempotente: si ya estaba apagado devuelve changed=false sin auditar.
create function public.deactivate_schedule(p_schedule uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s record; r record;
begin
  perform app_private.assert_admin();
  select * into s from public.notification_schedules where id = p_schedule for update;
  if not found then raise exception 'schedule_not_found' using errcode = 'P0002'; end if;
  if not s.enabled then return jsonb_build_object('id', s.id, 'enabled', false, 'changed', false); end if;
  update public.notification_schedules set enabled = false where id = p_schedule returning * into r;
  perform app_private.audit('schedule_deactivated', 'notification_schedules', p_schedule, jsonb_build_object(
    'schedule_id', r.id, 'label', r.label, 'kind', r.kind, 'local_time', r.local_time, 'deactivated_by', auth.uid()));
  return jsonb_build_object('id', r.id, 'enabled', false, 'changed', true);
end $$;
revoke all on function public.deactivate_schedule(uuid) from public, anon, authenticated;
grant execute on function public.deactivate_schedule(uuid) to authenticated, service_role;

-- ───────── 7b. prepare_notification_send: verificación de configuración vigente (también en la verificación final del worker) ─────────
create or replace function public.prepare_notification_send(p_job_id uuid, p_now timestamptz default now()) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare j record; d record; a record; u record; s record; st record; pay record; pm record; x record; pos record;
  v_body text; v_amount bigint; v_tpl text; v_res jsonb; v_sent_today int; v_last timestamptz; v_is_debt boolean; v_unres text;
begin
  select * into j from public.notification_jobs where id = p_job_id for update;
  if not found or j.status <> 'processing' then raise exception 'job_not_processing' using errcode = '22023'; end if;
  -- VERIFICACIÓN DE CONFIGURACIÓN VIGENTE (0025): un job de horario solo sale si el horario existe, sigue activo y el job pertenece a su configuración
  -- vigente (schedule_armed_at = armed_at actual; snapshot nulo = job antiguo/manual: solo se exige que el horario siga activo). Corre en CADA llamada,
  -- incluida la verificación final del worker justo antes de sendText, antes de cualquier render.
  if j.schedule_id is not null then
    select * into s from public.notification_schedules where id = j.schedule_id;
    if s.id is null or not s.enabled or (j.schedule_armed_at is not null and s.armed_at is distinct from j.schedule_armed_at) then
      update public.notification_jobs set status = 'cancelled', error = 'Horario modificado o desactivado antes del envío' where id = p_job_id;
      perform app_private.audit('notification_cancelled_schedule_changed', 'notification_jobs', p_job_id, jsonb_build_object(
        'kind', j.kind, 'schedule_id', j.schedule_id, 'schedule_enabled', s.enabled,
        'job_armed_at', app_private.iso_utc(j.schedule_armed_at), 'schedule_armed_at', app_private.iso_utc(s.armed_at)));
      return jsonb_build_object('action', 'skip', 'reason', 'cancelled');
    end if;
  end if;
  select * into d from public.drivers where id = j.driver_id;
  v_is_debt := j.kind in ('debt_reminder','debt_first','debt_update','debt_last');
  if d.status <> 'active' then
    update public.notification_jobs set status = 'cancelled', error = 'conductor no activo' where id = p_job_id;
    return jsonb_build_object('action', 'skip', 'reason', 'cancelled');
  end if;
  if not d.whatsapp_consent or d.phone_e164 is null then
    update public.notification_jobs set status = 'skipped_no_consent' where id = p_job_id;
    return jsonb_build_object('action', 'skip', 'reason', 'skipped_no_consent');
  end if;
  if d.reminders_paused and (v_is_debt or j.kind = 'weekly_summary') then
    update public.notification_jobs set status = 'skipped_paused' where id = p_job_id;
    return jsonb_build_object('action', 'skip', 'reason', 'skipped_paused');
  end if;
  select a2.* into a from public.assignments a2 where a2.driver_id = j.driver_id and a2.valid_from <= j.local_date
     and (a2.valid_to is null or a2.valid_to >= j.local_date) order by a2.valid_from desc limit 1;
  if not found then
    update public.notification_jobs set status = 'cancelled', error = 'sin asignación vigente' where id = p_job_id;
    return jsonb_build_object('action', 'skip', 'reason', 'cancelled');
  end if;
  perform 1 from public.assignments where id = a.id for share;       -- serializa con register_payment (FOR UPDATE)
  if exists (select 1 from public.notification_jobs o where o.driver_id = j.driver_id and o.id < j.id and o.status = 'processing') then
    return jsonb_build_object('action', 'defer', 'reason', 'otro_envio_en_curso');
  end if;
  select * into u from public.units where id = a.unit_id;
  select * into pos from public.assignment_position(a.id);
  select * into st from public.app_settings;
  select * into s from public.notification_schedules where id = j.schedule_id;

  if v_is_debt or j.kind = 'weekly_summary' then
    if v_is_debt then
      select count(*), max(sent_at) into v_sent_today, v_last from public.notification_jobs
       where driver_id = j.driver_id and local_date = j.local_date and status = 'sent' and kind in ('debt_reminder','debt_first','debt_update','debt_last');
      if v_sent_today >= st.max_per_driver_per_day or (v_last is not null and v_last > p_now - make_interval(mins => st.min_minutes_between)) then
        update public.notification_jobs set status = 'skipped_frequency' where id = p_job_id;
        return jsonb_build_object('action', 'skip', 'reason', 'skipped_frequency');
      end if;
      select * into x from public.assignment_dues(a.id, j.local_date);
      v_amount := case coalesce(s.scope, 'total') when 'today' then x.today_cents when 'overdue' then x.overdue_cents else x.today_cents + x.overdue_cents end;
      if v_amount <= 0 then
        update public.notification_jobs set status = case when x.credit_cents > 0 then 'skipped_credit' else 'skipped_paid' end where id = p_job_id;
        return jsonb_build_object('action', 'skip', 'reason', case when x.credit_cents > 0 then 'skipped_credit' else 'skipped_paid' end);
      end if;
    end if;
    -- La plantilla ASIGNADA al horario es la única fuente del texto. Sin horario, sin plantilla o plantilla inexistente: se omite, nunca se improvisa texto.
    select t.body into v_tpl from public.message_templates t where t.id = s.template_id;
    if v_tpl is null then
      update public.notification_jobs set status = 'skipped_no_template', error = 'Horario sin plantilla asignada' where id = p_job_id;
      perform app_private.audit('notification_no_template', 'notification_jobs', p_job_id, jsonb_build_object('kind', j.kind, 'schedule_id', j.schedule_id));
      return jsonb_build_object('action', 'skip', 'reason', 'skipped_no_template');
    end if;
    v_res := app_private.resolve_template(a.id, v_tpl, j.local_date);
    if jsonb_array_length(v_res -> 'unresolved') > 0 then
      select string_agg('{{' || e || '}}', ', ') into v_unres from jsonb_array_elements_text(v_res -> 'unresolved') e;
      update public.notification_jobs set status = 'skipped_unresolved', error = 'Variables sin resolver: ' || v_unres where id = p_job_id;
      perform app_private.audit('notification_unresolved', 'notification_jobs', p_job_id, jsonb_build_object('kind', j.kind, 'unresolved', v_res -> 'unresolved'));
      return jsonb_build_object('action', 'skip', 'reason', 'skipped_unresolved', 'unresolved', v_res -> 'unresolved');
    end if;
    v_body := v_res ->> 'text';
  elsif j.kind = 'payment_receipt' then
    select p.* into pay from public.payments p where p.id = j.payment_id;
    if pay.voided_at is not null then
      update public.notification_jobs set status = 'cancelled' where id = p_job_id;
      return jsonb_build_object('action', 'skip', 'reason', 'cancelled');
    end if;
    select * into pm from public.payment_methods where id = pay.method_id;
    v_body := E'Estimado conductor, hemos registrado su pago correctamente.\nUnidad: ' || u.code || E'\nMétodo: ' || pm.label
      || E'\nMonto entregado: ' || app_private.fmt_usd(pay.gross_cents)
      || case when pay.commission_cents > 0 then E'\nComisión del proveedor: ' || app_private.fmt_usd(pay.commission_cents) else '' end
      || E'\nAbono a su cuenta: ' || app_private.fmt_usd(pay.net_cents)
      || case when pos.pending_cents > 0 then E'\nSaldo pendiente: ' || app_private.fmt_usd(pos.pending_cents)
              when pos.credit_cents > 0 then E'\nSaldo a favor: ' || app_private.fmt_usd(pos.credit_cents) else E'\nSu cuenta está al día.' end || E'\nGracias por su pago.';
  elsif j.kind = 'credit_notice' then
    if j.approved_by is null then raise exception 'not_approved' using errcode = '42501'; end if;
    v_body := j.suggested_body;
  end if;
  return jsonb_build_object('action', 'send', 'phone', d.phone_e164, 'body', v_body, 'job_id', j.id);
end $$;
revoke all on function public.prepare_notification_send(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.prepare_notification_send(uuid, timestamptz) to service_role;

-- ───────── 8. complete_notification: guarda el resultado del proveedor (firma compatible: parámetros nuevos con valores por defecto) ─────────
-- Se reemplaza la función (misma lógica + columnas nuevas). Una llamada de 6 argumentos funciona igual que antes.
drop function public.complete_notification(uuid, text, text, boolean, text, timestamptz);
create function public.complete_notification(p_job_id uuid, p_outcome text, p_error text default null,
  p_dry_run boolean default true, p_body text default null, p_now timestamptz default now(),
  p_provider_message_id text default null, p_sender_phone text default null, p_recipient_phone text default null,
  p_delivery_status text default null, p_delivered_at timestamptz default null) returns text
language plpgsql security definer set search_path = '' as $$
declare j record; v_status text;
begin
  select * into j from public.notification_jobs where id = p_job_id for update;
  if not found or j.status <> 'processing' then raise exception 'job_not_processing' using errcode = '22023'; end if;
  if p_delivery_status is not null and p_delivery_status not in ('accepted', 'delivered', 'read') then raise exception 'invalid_delivery_status' using errcode = '22023'; end if;
  if p_delivered_at is not null and p_delivery_status is distinct from 'delivered' and p_delivery_status is distinct from 'read' then
    raise exception 'delivery_ack_required' using errcode = '22023';          -- «entregado» solo con acuse real
  end if;
  if p_outcome = 'sent' then
    update public.notification_jobs set status = 'sent', sent_at = p_now, dry_run = p_dry_run, rendered_body = p_body, error = null,
      provider_message_id = p_provider_message_id, sender_phone = p_sender_phone, recipient_phone = p_recipient_phone,
      delivery_status = p_delivery_status, delivered_at = p_delivered_at where id = p_job_id;
    return 'sent';
  elsif p_outcome = 'failed' then
    v_status := case when j.attempts >= 3 then 'failed' else 'pending' end;
    update public.notification_jobs set status = v_status, error = left(p_error, 500),
      scheduled_for = case when v_status = 'pending' then p_now + (j.attempts * interval '5 minutes') else scheduled_for end where id = p_job_id;
    return v_status;
  elsif p_outcome = 'uncertain' then
    -- La solicitud ya se entregó al proveedor y no se sabe si salió: NO se reintenta (podría duplicar), NO se marca entregado ni enviado.
    update public.notification_jobs set status = 'failed', error = left('Resultado incierto, no se reintenta automáticamente: ' || coalesce(p_error, ''), 500) where id = p_job_id;
    return 'failed';
  end if;
  raise exception 'invalid_outcome' using errcode = '22023';
end $$;
revoke all on function public.complete_notification(uuid, text, text, boolean, text, timestamptz, text, text, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.complete_notification(uuid, text, text, boolean, text, timestamptz, text, text, text, text, timestamptz) to service_role;

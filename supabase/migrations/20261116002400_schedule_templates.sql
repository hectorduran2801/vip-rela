-- ══════════════════════════════════════════════════════════════════════════
-- 0024 · Horarios ↔ plantillas: un horario ACTIVO siempre tiene plantilla; el «texto base» pasa a ser una plantilla editable
-- No destructiva: NO modifica ninguna fila existente (ni horarios, ni plantillas, ni trabajos). Solo agrega triggers, funciones y amplía el
-- check de estados de notification_jobs con `skipped_no_template`.
--
-- ATENCIÓN (efecto al aplicar): un horario que ya esté activo SIN plantilla (template_id nulo) se queda como está (no es retroactivo), pero
-- a partir de esta migración YA NO envía: schedule_reminders no le crea trabajos y los pendientes se omiten de forma segura
-- (skipped_no_template). Vuelve a enviar cuando se le asigne una plantilla. El texto fijo de código ya no se usa para recordatorios.
-- ══════════════════════════════════════════════════════════════════════════

-- ───────── 1. Nuevo estado de trabajo ─────────
alter table public.notification_jobs drop constraint notification_jobs_status_check;
alter table public.notification_jobs add constraint notification_jobs_status_check
  check (status in ('pending','awaiting_approval','processing','sent','failed',
    'skipped_paid','skipped_credit','skipped_no_consent','skipped_paused','skipped_frequency','skipped_unresolved','skipped_no_template','cancelled','discarded'));

-- ───────── 2. Texto base: fuente única (la UI lo muestra y permite convertirlo en plantilla real) ─────────
-- Cuerpos EXACTOS del texto fijo que usaba prepare_notification_send hasta 0022.
create function app_private.default_template_body(p_kind text) returns text language sql immutable set search_path = '' as $$
  select case when p_kind = 'weekly_summary'
    then 'Buenos días' || E', {{nombre_completo}}.\n\nUnidad: {{unidad}}\nFecha: {{fecha}}\n\nResumen de la semana:\nCuenta semanal: {{cuenta_semanal}}\nPagos recibidos: {{pagos_semana}}\n\n{{detalle_deuda}}\n\nGracias por su atención.'
    when p_kind in ('debt_first', 'debt_update', 'debt_last')
    then case p_kind when 'debt_first' then 'Buenos días' when 'debt_last' then 'Buenas noches' else 'Buenas tardes' end
         || E', {{nombre_completo}}.\n\nUnidad: {{unidad}}\nFecha: {{fecha}}\n\n{{detalle_deuda}}\n\nGracias por su atención.'
  end
$$;
create function app_private.default_template_name(p_kind text) returns text language sql immutable set search_path = '' as $$
  select case p_kind when 'debt_first' then 'Primer recordatorio (texto base)' when 'debt_update' then 'Recordatorio actualizado (texto base)'
    when 'debt_last' then 'Último recordatorio (texto base)' when 'weekly_summary' then 'Resumen semanal (texto base)' end
$$;
revoke all on function app_private.default_template_body(text), app_private.default_template_name(text) from public, anon, authenticated;
grant execute on function app_private.default_template_body(text), app_private.default_template_name(text) to service_role;

create function public.schedule_default_templates() returns table (kind text, suggested_name text, body text)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app_private.assert_staff();
  return query select k.kind, app_private.default_template_name(k.kind), app_private.default_template_body(k.kind)
    from (values (1, 'debt_first'), (2, 'debt_update'), (3, 'debt_last'), (4, 'weekly_summary')) as k(o, kind) order by k.o;
end $$;
revoke all on function public.schedule_default_templates() from public, anon, authenticated;
grant execute on function public.schedule_default_templates() to authenticated, service_role;

-- ───────── 3. Guard de activación ─────────
-- Rechaza (a) activar un horario sin plantilla existente, (b) insertarlo activo sin ella y (c) dejarlo sin plantilla (nula o inexistente) estando activo.
-- NO es retroactivo: un horario ya activo sin plantilla se puede seguir editando (etiqueta, hora...) sin tocar habilitación ni plantilla.
-- Apagar siempre se permite. Error: message = 'template_required', errcode 23514, detail/hint en español para la UI.
create function app_private.guard_schedule_template() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.enabled and (tg_op = 'INSERT' or not old.enabled or old.template_id is distinct from new.template_id) then
    if new.template_id is null or not exists (select 1 from public.message_templates t where t.id = new.template_id) then
      raise exception 'template_required' using errcode = '23514',
        detail = 'Un horario activo necesita una plantilla de mensaje asignada.',
        hint = 'Asigne o cree una plantilla para el horario antes de activarlo.';
    end if;
  end if;
  return new;
end $$;
create trigger guard_template before insert or update on public.notification_schedules for each row execute function app_private.guard_schedule_template();

-- ───────── 4. Borrar una plantilla en uso ─────────
create function app_private.guard_template_delete() returns trigger language plpgsql security definer set search_path = '' as $$
declare v_labels text;
begin
  select string_agg(s.label, ', ' order by s.local_time, s.label) into v_labels from public.notification_schedules s where s.template_id = old.id;
  if v_labels is not null then
    raise exception 'template_in_use' using errcode = '23503',
      detail = 'La plantilla está asignada a: ' || v_labels || '.',
      hint = 'Asigne otra plantilla a esos horarios (o desactívelos y quíteles la plantilla) antes de eliminarla.';
  end if;
  return old;
end $$;
create trigger guard_in_use before delete on public.message_templates for each row execute function app_private.guard_template_delete();

create function public.template_usage(p_template uuid)
returns table (id uuid, kind text, label text, local_time time, weekdays smallint[], enabled boolean)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app_private.assert_admin();
  if not exists (select 1 from public.message_templates t where t.id = p_template) then raise exception 'template_not_found' using errcode = 'P0002'; end if;
  return query select s.id, s.kind, s.label, s.local_time, s.weekdays, s.enabled from public.notification_schedules s
    where s.template_id = p_template order by s.local_time, s.label;
end $$;
revoke all on function public.template_usage(uuid) from public, anon, authenticated;
grant execute on function public.template_usage(uuid) to authenticated, service_role;

-- ───────── 5. Crear una plantilla real a partir del texto base (solo cuando el usuario lo pide) ─────────
create function public.create_template_from_default(p_kind text, p_name text default null, p_schedule uuid default null)
returns public.message_templates language plpgsql security definer set search_path = '' as $$
declare v_base text; v_name text; v_i int := 1; r public.message_templates;
begin
  perform app_private.assert_admin();
  if p_kind is null or app_private.default_template_body(p_kind) is null then raise exception 'invalid_kind' using errcode = '22023'; end if;
  if p_schedule is not null and not exists (select 1 from public.notification_schedules where id = p_schedule) then
    raise exception 'schedule_not_found' using errcode = 'P0002';
  end if;
  v_base := coalesce(nullif(btrim(p_name), ''), app_private.default_template_name(p_kind));
  perform pg_advisory_xact_lock(hashtext('create_template_from_default'));
  v_name := v_base;
  while exists (select 1 from public.message_templates t where t.name = v_name) loop v_i := v_i + 1; v_name := v_base || ' ' || v_i; end loop;
  insert into public.message_templates(name, body) values (v_name, app_private.default_template_body(p_kind)) returning * into r;
  perform app_private.audit('template_created_from_default', 'message_templates', r.id, jsonb_build_object('kind', p_kind, 'name', r.name, 'schedule_id', p_schedule));
  if p_schedule is not null then update public.notification_schedules set template_id = r.id where id = p_schedule; end if;   -- respeta el guard
  return r;
end $$;
revoke all on function public.create_template_from_default(text, text, uuid) from public, anon, authenticated;
grant execute on function public.create_template_from_default(text, text, uuid) to authenticated, service_role;

-- ───────── 6. Vista previa del horario: MISMO resolvedor que el envío ─────────
create function public.preview_schedule(p_schedule uuid, p_assignment uuid, p_date date default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s record; t record; v_res jsonb;
begin
  perform app_private.assert_admin();
  select * into s from public.notification_schedules where id = p_schedule;
  if not found then raise exception 'schedule_not_found' using errcode = 'P0002'; end if;
  if not exists (select 1 from public.assignments where id = p_assignment) then raise exception 'assignment_not_found' using errcode = 'P0002'; end if;
  select * into t from public.message_templates where id = s.template_id;
  if t.id is not null then
    v_res := app_private.resolve_template(p_assignment, t.body, coalesce(p_date, (now() at time zone app_private.tz())::date));
  end if;
  return jsonb_build_object(
    'schedule', jsonb_build_object('id', s.id, 'kind', s.kind, 'label', s.label, 'local_time', s.local_time, 'enabled', s.enabled,
                                   'template_id', s.template_id, 'template_name', t.name),
    'text', v_res -> 'text', 'unresolved', coalesce(v_res -> 'unresolved', '[]'::jsonb),
    'source', case when t.id is not null then 'template' else 'none' end);
end $$;
revoke all on function public.preview_schedule(uuid, uuid, date) from public, anon, authenticated;
grant execute on function public.preview_schedule(uuid, uuid, date) to authenticated, service_role;

-- ───────── 7. schedule_reminders: no crea trabajos para horarios sin plantilla válida ─────────
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

-- ───────── 8. prepare_notification_send: sin plantilla → omitir (skipped_no_template); NUNCA texto fijo de código para recordatorios ─────────
create or replace function public.prepare_notification_send(p_job_id uuid, p_now timestamptz default now()) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare j record; d record; a record; u record; s record; st record; pay record; pm record; x record; pos record;
  v_body text; v_amount bigint; v_tpl text; v_res jsonb; v_sent_today int; v_last timestamptz; v_is_debt boolean; v_unres text;
begin
  select * into j from public.notification_jobs where id = p_job_id for update;
  if not found or j.status <> 'processing' then raise exception 'job_not_processing' using errcode = '22023'; end if;
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

-- VIP · 0027 · Mensajes de cobranza por PLANTILLA, elegidos a mano desde la tabla de cobranza.
-- La administradora selecciona operarios, elige una plantilla, revisa el texto real de cada uno y confirma. Cada envío queda registrado con la plantilla
-- usada; puede enviar otra plantilla al mismo operario cuando quiera. No hay recordatorios automáticos en este flujo ni se pide autorización por conductor.
-- Reutiliza la cola de `whatsapp_test_messages` (la misma que ya procesa el worker, con modo simulado/real decidido por WHATSAPP_DRY_RUN).
-- Reversible: drop function public.create_collection_message, public.collection_message_summary; drop las columnas y restablecer las restricciones de 0018.
set search_path = public, extensions;

alter table public.whatsapp_test_messages add column template_id uuid references public.message_templates(id) on delete set null;
alter table public.whatsapp_test_messages add column template_name text;
alter table public.whatsapp_test_messages add column assignment_id uuid references public.assignments(id) on delete set null;

alter table public.whatsapp_test_messages drop constraint whatsapp_test_messages_kind_check;
alter table public.whatsapp_test_messages add constraint whatsapp_test_messages_kind_check check (kind in ('test', 'payment_receipt_preview', 'driver_message', 'collection_message'));
alter table public.whatsapp_test_messages drop constraint whatsapp_test_messages_driver_check;
alter table public.whatsapp_test_messages add constraint whatsapp_test_messages_driver_check
  check ((kind in ('driver_message', 'collection_message')) = (driver_id is not null) and (kind not in ('driver_message', 'collection_message') or requested_mode = 'auto'));
create index whatsapp_test_messages_collection on public.whatsapp_test_messages(driver_id, created_at desc) where kind = 'collection_message';

drop policy wtm_select on public.whatsapp_test_messages;
create policy wtm_select on public.whatsapp_test_messages for select to authenticated
  using (app_private.is_super() or (kind in ('driver_message', 'collection_message') and app_private.is_admin()));

-- ───────── Trazabilidad: qué importación del Excel respaldó cada mensaje y con qué valores se redactó ─────────
alter table public.whatsapp_test_messages add column import_id uuid references public.excel_imports(id) on delete set null;
alter table public.whatsapp_test_messages add column variables jsonb;

-- ───────── Variables nuevas (sin duplicar las existentes) ─────────
-- Ya existían: nombre, apellido, nombre_completo, unidad, codigo_operario (= «operario»), fecha, cuota_hoy, pendiente_hoy, deuda_anterior, deuda_semanal,
-- saldo_total (= «saldo pendiente»), credito, cuenta_semanal, pagos_semana (= «total pagado en la semana»), detalle_deuda. Faltaban: cuota_diaria, pago_hoy, acuerdo, dia_semana.
alter function app_private.template_vars(uuid, date) rename to template_vars_core;
create function app_private.template_vars(p_assignment uuid, p_date date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_rate bigint; v_today bigint; v_ag text; v_tz text := app_private.tz();
begin
  select r.daily_amount_cents into v_rate from public.rates r where r.assignment_id = p_assignment and r.valid_from <= p_date and (r.valid_to is null or r.valid_to >= p_date)
   order by r.valid_from desc limit 1;                                                    -- tarifa vigente ese día; sin tarifa = sin dato (no se inventa un cero)
  select coalesce(sum(p.net_cents), 0)::bigint into v_today from public.payments p
   where p.assignment_id = p_assignment and p.voided_at is null and (p.paid_at at time zone v_tz)::date = p_date;
  select nullif(btrim(u.agreement), '') into v_ag from public.assignments a join public.units u on u.id = a.unit_id where a.id = p_assignment;
  return app_private.template_vars_core(p_assignment, p_date) || jsonb_build_object(
    'cuota_diaria', case when v_rate is null then null else app_private.fmt_usd(v_rate) end,
    'pago_hoy', app_private.fmt_usd(v_today),
    'acuerdo', v_ag,
    'dia_semana', (array['domingo','lunes','martes','miércoles','jueves','viernes','sábado'])[extract(dow from p_date)::int + 1]);
end $$;
revoke all on function app_private.template_vars(uuid, date), app_private.template_vars_core(uuid, date) from public, anon, authenticated;
grant execute on function app_private.template_vars(uuid, date) to authenticated, service_role;

alter function public.template_variables() rename to template_variables_core;
create function public.template_variables()
returns table ("group" text, code text, label text, description text, example text)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app_private.assert_staff();
  return query select x."group", x.code, x.label, x.description, x.example from (
    select c."group", c.code, c.label, c.description, c.example, c.n::int o from public.template_variables_core() with ordinality c("group", code, label, description, example, n)
    union all select * from (values
      ('Importes financieros', 'cuota_diaria', 'Cuota diaria', 'Tarifa diaria vigente de la unidad (viene del Excel). Si no hay tarifa, la variable queda sin resolver.', '$36.00', 1001),
      ('Importes financieros', 'pago_hoy', 'Pago de hoy', 'Lo pagado hoy según el Excel importado (neto). $0.00 si no hay pago hoy.', '$36.00', 1002),
      ('Unidad y operario', 'acuerdo', 'Acuerdo', 'Acuerdo u observación de la unidad. Si no tiene, la variable queda sin resolver y el mensaje no se envía.', 'Paga los viernes', 1003),
      ('Fechas', 'dia_semana', 'Día de la semana', 'Día de hoy en español.', 'lunes', 1004)) n("group", code, label, description, example, o)
  ) x order by case x."group" when 'Datos del conductor' then 1 when 'Unidad y operario' then 2 when 'Fechas' then 3 when 'Importes financieros' then 4 else 5 end, x.o;
end $$;
revoke all on function public.template_variables(), public.template_variables_core() from public, anon, authenticated;
grant execute on function public.template_variables() to authenticated, service_role;

-- ───────── Última importación exitosa del Excel de cobranza ─────────
create function public.last_collection_sync() returns table (import_id uuid, file_name text, applied_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app_private.assert_staff();
  return query select i.id, i.file_name, i.applied_at from public.excel_imports i where i.source_kind = 'collection_flat' and i.status = 'applied' order by i.applied_at desc limit 1;
end $$;
revoke all on function public.last_collection_sync() from public, anon, authenticated;
grant execute on function public.last_collection_sync() to authenticated, service_role;

-- ───────── Validación ÚNICA (la usan la vista previa y el envío) ─────────
-- reason: null = se puede enviar. Códigos: no_sync, assignment_not_found, template_not_found, driver_inactive, unit_inactive, assignment_ended,
-- driver_without_phone, phone_shared (otro operario con el mismo número: riesgo de escribir a la persona equivocada), unconfirmed_result_pending,
-- template_unresolved, invalid_body. «already_sent_today» se evalúa aparte porque el reenvío se puede confirmar.
create function app_private.collection_message_check(p_assignment uuid, p_template uuid, p_date date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare a public.assignments; d public.drivers; t public.message_templates; u public.units; v_res jsonb := null; v_reason text;
begin
  select * into t from public.message_templates where id = p_template;
  if not found then return jsonb_build_object('reason', 'template_not_found'); end if;
  select * into a from public.assignments where id = p_assignment;
  if not found then return jsonb_build_object('reason', 'assignment_not_found'); end if;
  select * into d from public.drivers where id = a.driver_id;
  select * into u from public.units where id = a.unit_id;
  v_reason := case
    when not exists (select 1 from public.excel_imports i where i.source_kind = 'collection_flat' and i.status = 'applied') then 'no_sync'
    when d.status <> 'active' then 'driver_inactive'
    when not u.active then 'unit_inactive'
    when a.valid_from > p_date or (a.valid_to is not null and a.valid_to < p_date) then 'assignment_ended'
    when d.phone_e164 is null then 'driver_without_phone'
    when exists (select 1 from public.drivers x where x.phone_e164 = d.phone_e164 and x.id <> d.id) then 'phone_shared'
    when exists (select 1 from public.whatsapp_test_messages m where m.driver_id = d.id and m.status = 'unconfirmed') then 'unconfirmed_result_pending'
  end;
  if v_reason is null then
    v_res := app_private.resolve_template(p_assignment, t.body, p_date);
    if jsonb_array_length(v_res -> 'unresolved') > 0 then v_reason := 'template_unresolved';
    elsif length(btrim(v_res ->> 'text')) = 0 or length(v_res ->> 'text') > 1000 then v_reason := 'invalid_body'; end if;
  end if;
  return jsonb_build_object('reason', v_reason, 'text', v_res ->> 'text', 'unresolved', coalesce(v_res -> 'unresolved', '[]'::jsonb), 'phone', d.phone_e164,
    'driver_id', d.id, 'template', t.name);
end $$;
revoke all on function app_private.collection_message_check(uuid, uuid, date) from public, anon, authenticated;
grant execute on function app_private.collection_message_check(uuid, uuid, date) to authenticated, service_role;

-- Vista previa de una selección: SOLO LECTURA. Devuelve la última importación y, por cada unidad, el mensaje resuelto o el motivo de exclusión.
create function public.preview_collection_messages(p_assignments uuid[], p_template uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_today date := (now() at time zone app_private.tz())::date; v_items jsonb := '[]'::jsonb; v_id uuid; c jsonb; v_sent timestamptz; v_sync record; a record;
begin
  perform app_private.assert_admin();
  if cardinality(p_assignments) > 300 then raise exception 'too_many_recipients' using errcode = '22023'; end if;
  select i.id, i.file_name, i.applied_at into v_sync from public.excel_imports i where i.source_kind = 'collection_flat' and i.status = 'applied' order by i.applied_at desc limit 1;
  foreach v_id in array p_assignments loop
    c := app_private.collection_message_check(v_id, p_template, v_today);
    select m.created_at into v_sent from public.whatsapp_test_messages m
     where m.kind = 'collection_message' and m.assignment_id = v_id and m.template_id = p_template and m.status in ('prepared', 'processing', 'sent', 'delivered', 'simulated', 'unconfirmed')
       and (m.created_at at time zone app_private.tz())::date = v_today order by m.created_at desc limit 1;
    select u.code unit_code, dd.operator_code, concat_ws(' ', dd.first_name, nullif(dd.last_name, '')) full_name into a
      from public.assignments x join public.units u on u.id = x.unit_id join public.drivers dd on dd.id = x.driver_id where x.id = v_id;
    v_items := v_items || jsonb_build_array(jsonb_build_object('assignmentId', v_id, 'unitCode', a.unit_code, 'operatorCode', a.operator_code, 'fullName', a.full_name,
      'phone', c -> 'phone', 'text', c -> 'text', 'unresolved', c -> 'unresolved', 'reason', c -> 'reason', 'alreadySentAt', v_sent));
  end loop;
  return jsonb_build_object('lastSync', case when v_sync.id is null then null else jsonb_build_object('importId', v_sync.id, 'fileName', v_sync.file_name, 'appliedAt', v_sync.applied_at) end, 'items', v_items);
end $$;
revoke all on function public.preview_collection_messages(uuid[], uuid) from public, anon, authenticated;
grant execute on function public.preview_collection_messages(uuid[], uuid) to authenticated, service_role;

-- Crea UN mensaje con la plantilla elegida para la unidad/operario de la asignación. El texto se resuelve en el servidor con los datos de la última importación.
-- Misma plantilla el mismo día a la misma persona → `already_sent_today` salvo que se confirme el reenvío (p_repeat). Guarda el texto EXACTO, los valores usados y la importación de referencia.
create function public.create_collection_message(p_assignment uuid, p_template uuid, p_idempotency_key text, p_repeat boolean default false)
returns public.whatsapp_test_messages language plpgsql security definer set search_path = '' as $$
declare a public.assignments; r public.whatsapp_test_messages; c jsonb; v_today date := (now() at time zone app_private.tz())::date; v_drv uuid; v_imp uuid;
begin
  perform app_private.assert_admin();
  if p_idempotency_key is null or length(btrim(p_idempotency_key)) < 8 then raise exception 'idempotency_key_required' using errcode = '22023'; end if;
  select * into r from public.whatsapp_test_messages where idempotency_key = p_idempotency_key;
  if found then
    if r.assignment_id is distinct from p_assignment or r.template_id is distinct from p_template then raise exception 'idempotency_conflict' using errcode = '23505'; end if;
    return r;
  end if;
  select * into a from public.assignments where id = p_assignment;
  if not found then raise exception 'assignment_not_found' using errcode = 'P0002'; end if;
  perform 1 from public.drivers where id = a.driver_id for update;                             -- serializa envíos al mismo operario
  c := app_private.collection_message_check(p_assignment, p_template, v_today);
  if c ->> 'reason' is not null then
    raise exception '%', c ->> 'reason' using errcode = case c ->> 'reason' when 'template_not_found' then 'P0002' when 'assignment_not_found' then 'P0002' when 'driver_without_phone' then '23514'
      when 'template_unresolved' then '22023' when 'invalid_body' then '22023' else '55000' end, detail = (c -> 'unresolved')::text;
  end if;
  v_drv := (c ->> 'driver_id')::uuid;
  if not p_repeat and exists (select 1 from public.whatsapp_test_messages m where m.kind = 'collection_message' and m.driver_id = v_drv and m.assignment_id = p_assignment and m.template_id = p_template
        and m.status in ('prepared', 'processing', 'sent', 'delivered', 'simulated', 'unconfirmed') and (m.created_at at time zone app_private.tz())::date = v_today) then
    raise exception 'already_sent_today' using errcode = '55000'; end if;
  select i.id into v_imp from public.excel_imports i where i.source_kind = 'collection_flat' and i.status = 'applied' order by i.applied_at desc limit 1;
  insert into public.whatsapp_test_messages(kind, recipient_phone, body, requested_mode, authorized_by, idempotency_key, driver_id, template_id, template_name, assignment_id, import_id, variables)
    values ('collection_message', c ->> 'phone', btrim(c ->> 'text'), 'auto', auth.uid(), p_idempotency_key, v_drv, p_template, c ->> 'template', p_assignment, v_imp,
            app_private.template_vars(p_assignment, v_today)) returning * into r;
  perform app_private.audit('whatsapp.collection_message.created', 'whatsapp_test_message', r.id, jsonb_build_object('driver_id', v_drv, 'assignment_id', p_assignment, 'template', c ->> 'template', 'repeat', p_repeat, 'import_id', v_imp));
  return r;
end $$;

-- Último mensaje de cobranza por operario (para mostrar «ya se envió la plantilla X» en la tabla).
create function public.collection_message_summary() returns table (driver_id uuid, template_name text, status text, created_at timestamptz, sent_today int)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app_private.assert_admin();
  return query
  select l.driver_id, l.template_name, l.status, l.created_at,
         (select count(*)::int from public.whatsapp_test_messages x where x.kind = 'collection_message' and x.driver_id = l.driver_id and x.status in ('prepared', 'processing', 'sent', 'delivered', 'simulated', 'unconfirmed')
             and (x.created_at at time zone app_private.tz())::date = (now() at time zone app_private.tz())::date)
    from (select distinct on (m.driver_id) m.driver_id, m.template_name, m.status, m.created_at from public.whatsapp_test_messages m
           where m.kind = 'collection_message' order by m.driver_id, m.created_at desc) l;
end $$;

revoke all on function public.create_collection_message(uuid, uuid, text, boolean), public.collection_message_summary() from public, anon, authenticated;
grant execute on function public.create_collection_message(uuid, uuid, text, boolean), public.collection_message_summary() to authenticated, service_role;

-- Worker: un mensaje de cobranza se cancela si el operario ya no está activo o cambió de número (sin exigir autorización por conductor).
create or replace function public.claim_test_message() returns public.whatsapp_test_messages
language plpgsql security definer set search_path = '' as $$
declare r public.whatsapp_test_messages;
begin
  if not app_private.is_service() then raise exception 'forbidden' using errcode = '42501'; end if;
  loop
    update public.whatsapp_test_messages m set status = 'processing', claimed_at = now()
     where m.id = (select id from public.whatsapp_test_messages where status = 'prepared' order by created_at limit 1 for update skip locked)
    returning m.* into r;
    exit when r.id is null;
    if r.kind = 'driver_message' and not exists (select 1 from public.drivers d where d.id = r.driver_id and d.whatsapp_consent and d.status = 'active' and d.phone_e164 = r.recipient_phone) then
      update public.whatsapp_test_messages set status = 'cancelled', processed_at = now(), error = 'cancelado: el conductor ya no tiene autorización vigente' where id = r.id;
      continue;
    end if;
    if r.kind = 'collection_message' and not exists (select 1 from public.drivers d where d.id = r.driver_id and d.status = 'active' and d.phone_e164 = r.recipient_phone) then
      update public.whatsapp_test_messages set status = 'cancelled', processed_at = now(), error = 'cancelado: el operario ya no está activo o cambió de número' where id = r.id;
      continue;
    end if;
    return r;
  end loop;
  return null;
end $$;

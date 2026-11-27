-- VIP · 0031 · «Desvincular conductor»: la unidad queda disponible y deja de recibir mensajes de cobranza.
-- end_assignment ya existe (cierra la asignación y su tarifa, conserva cargos, pagos, saldos e historial): se REUTILIZA sin cambios.
-- Aquí solo: (1) una asignación con fecha de fin ≤ hoy ya no recibe mensajes de cobranza (antes seguía «vigente» el último día);
--           (2) la importación del Excel no reasigna sola una unidad desvinculada (ver app_private.collection_sync, cuerpo en 0026).
-- Reversible: restablecer collection_message_check de 0028.
set search_path = public, extensions;

create or replace function app_private.collection_message_check(p_assignment uuid, p_template uuid, p_date date) returns jsonb
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
    when a.valid_from > p_date or (a.valid_to is not null and a.valid_to <= p_date) then 'assignment_ended'      -- desvinculada (o terminada): sin mensajes desde el día de fin
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

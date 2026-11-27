-- VIP · 0050 · NO APLICAR EN REMOTO sin autorización expresa.
-- El Excel es la fuente de verdad de las asignaciones VIGENTES (solo al importar la semana en curso y solo de las unidades que trae el archivo):
--   · Fila sin operario (código, nombre, cédula y WhatsApp vacíos): finaliza la asignación vigente y esa fila no mueve pagos, saldo ni tarifa.
--   · El operario vuelve: se reabre su asignación. Entra otro: asignación nueva desde el día siguiente al cierre.
--   · Cambio de operario con cuotas ya generadas esa semana: se cierra en el último día con cuota (o ayer) y la nueva empieza al siguiente.
--   · WhatsApp y cédula distintos: se actualizan (celda vacía no borra; nunca concede consentimiento).
-- Nada se borra: asignaciones, cargos y pagos quedan como historial. No anula pagos ya registrados.
set search_path = public, extensions;

create function app_private.vacate_assignment(p_assignment uuid, p_apply boolean, p_import uuid) returns date language plpgsql security definer set search_path = '' as $$
declare a record; v_today date := (now() at time zone app_private.tz())::date; v_end date;
begin
  select * into a from public.assignments where id = p_assignment;
  -- último día con cuota ya generada o ayer, nunca antes de su inicio: así queda terminada hoy mismo sin reescribir historia
  v_end := greatest(a.valid_from, v_today - 1, coalesce((select max(c.charge_date) from public.charges c where c.assignment_id = p_assignment and c.kind = 'daily'), a.valid_from));
  if p_apply then
    update public.rates set valid_to = greatest(v_end, valid_from) where assignment_id = p_assignment and valid_to is null;
    update public.assignments set valid_to = v_end where id = p_assignment;
    perform app_private.audit('import_end_assignment', 'assignments', p_assignment, jsonb_build_object('import_id', p_import, 'valid_to', v_end));
  end if;
  return v_end;
end $$;
create function app_private.ended_by_import(p_assignment uuid) returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.audit_logs l where l.action = 'import_end_assignment' and l.entity_id = p_assignment) $$;
revoke all on function app_private.vacate_assignment(uuid, boolean, uuid), app_private.ended_by_import(uuid) from public, anon, authenticated;
grant execute on function app_private.vacate_assignment(uuid, boolean, uuid), app_private.ended_by_import(uuid) to vip_app, service_role;

do $mig$
declare d text := pg_get_functiondef('app_private.collection_sync(uuid, date, boolean, text)'::regprocedure);
  procedure_ok boolean;
  pairs text[][] := array[
   array['v_unorm text;', 'v_unorm text; c_vac int := 0; v_end date; v_start date; v_cur_week boolean := p_week = app_private.week_start_of((now() at time zone app_private.tz())::date);'],
   array['v_asg_found := found;', 'v_asg_found := found; v_start := p_week;'],
   array['if not v_asg_found and v_unit_exists and exists (select 1 from public.assignments a2 where a2.unit_id = v_unit_id and a2.valid_from > p_week + 6) then',
$n$-- ── El Excel manda sobre las asignaciones vigentes (semana en curso) ──
    if v_cur_week and v_asg_found then
      if v_op is null and v_nid is null and v_name is null and btrim(coalesce(r.raw_phone, '')) = '' and v_phone is null then
        if asg.valid_to is null then
          v_end := app_private.vacate_assignment(asg.id, p_apply, p_import); c_vac := c_vac + 1; v_changed := true;
          v_warn := v_warn || app_private.cs_warn(r.source_row, 'operador', 'unit_vacated', 'La unidad quedó sin operario en el Excel: se finaliza la asignación de '
            || (select trim(coalesce(dv.operator_code, '') || ' ' || coalesce(dv.first_name, '')) from public.drivers dv where dv.id = asg.driver_id) || '. Se conserva su historial.', 'warning');
        end if;
        v_asg_found := false; v_asg_end := null; v_asg_ended := false;          -- sin operario: la fila no mueve pagos, saldo ni tarifa
      elsif v_op is not null and asg.valid_to is not null and app_private.ended_by_import(asg.id) then
        if v_drv_id is not null and asg.driver_id = v_drv_id then
          if p_apply then
            update public.assignments set valid_to = null where id = asg.id;
            update public.rates set valid_to = null where assignment_id = asg.id and valid_to = (select max(x.valid_to) from public.rates x where x.assignment_id = asg.id);
            perform app_private.audit('import_reopen_assignment', 'assignments', asg.id, jsonb_build_object('import_id', p_import));
          end if;
          asg.valid_to := null; v_asg_end := null; v_asg_ended := false; v_changed := true;
        else
          v_start := asg.valid_to + 1; v_asg_found := false; v_asg_end := null; v_asg_ended := false;
        end if;
      end if;
    end if;
    if not v_asg_found and v_unit_exists and exists (select 1 from public.assignments a2 where a2.unit_id = v_unit_id and a2.valid_from > p_week + 6) then$n$],
   array['when exists (select 1 from public.charges c where c.assignment_id = asg.id and c.kind = ''daily'' and c.charge_date >= p_week) then ''la asignación vigente ya tiene cuotas generadas desde ese lunes''',
         'when not v_cur_week and exists (select 1 from public.charges c where c.assignment_id = asg.id and c.kind = ''daily'' and c.charge_date >= p_week) then ''la asignación vigente ya tiene cuotas generadas desde ese lunes'''],
   array['when asg.valid_from >= p_week then', 'when not v_cur_week and asg.valid_from >= p_week then'],
   array['when exists (select 1 from public.rates rt where rt.assignment_id = asg.id and rt.valid_from >= p_week) then', 'when not v_cur_week and exists (select 1 from public.rates rt where rt.assignment_id = asg.id and rt.valid_from >= p_week) then'],
   array['update public.assignments set valid_to = p_week - 1 where id = asg.id;',
         'if v_cur_week and (asg.valid_from >= p_week or exists (select 1 from public.charges c where c.assignment_id = asg.id and c.kind = ''daily'' and c.charge_date >= p_week)) then v_end := app_private.vacate_assignment(asg.id, true, p_import); v_start := v_end + 1; else update public.assignments set valid_to = p_week - 1 where id = asg.id; end if;'],
   array['update public.rates set valid_to = p_week - 1 where assignment_id = asg.id', 'update public.rates set valid_to = greatest(v_start - 1, valid_from) where assignment_id = asg.id'],
   array['values (v_drv_id, v_unit_id, p_week) returning id into v_asg_id', 'values (v_drv_id, v_unit_id, v_start) returning id into v_asg_id'],
   array['values (v_asg_id, coalesce(nullif(v_new_rate, 0), nullif(v_carry, 0)), p_week,', 'values (v_asg_id, coalesce(nullif(v_new_rate, 0), nullif(v_carry, 0)), v_start,'],
   array['''assignments_created'', c_asg_created,', '''assignments_created'', c_asg_created, ''assignments_ended'', c_vac,'],
   array['if v_nid is not null and drv.national_id is null', 'if v_nid is not null and drv.national_id is distinct from v_nid'],
   array['elsif v_drv_phone <> v_phone then
        v_warn := v_warn || app_private.cs_warn(r.source_row, ''whatsapp'', ''phone_conflict'', ''El WhatsApp del Excel difiere del registrado: no se modifica.'');',
         'elsif v_drv_phone <> v_phone then
        v_changed := true; c_drv_updated := c_drv_updated + 1; v_drv_phone := v_phone; v_phone_set := true;
        if p_apply then update public.drivers set phone_e164 = v_phone where id = v_drv_id; end if;
        v_warn := v_warn || app_private.cs_warn(r.source_row, ''whatsapp'', ''phone_updated'', ''El WhatsApp se actualiza con el del Excel.'', ''info'');']
  ];
  i int;
begin
  for i in 1 .. array_length(pairs, 1) loop
    if position(pairs[i][1] in d) = 0 then raise exception 'no se encontró el punto % de collection_sync', i; end if;
    d := replace(d, pairs[i][1], pairs[i][2]);
  end loop;
  d := replace(d, 'update public.drivers set national_id = v_nid where id = v_drv_id and national_id is null;', 'update public.drivers set national_id = v_nid where id = v_drv_id;');
  execute d;
end $mig$;
alter function app_private.collection_sync(uuid, date, boolean, text) owner to vip_app;

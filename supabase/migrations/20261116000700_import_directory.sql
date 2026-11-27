-- VIP · 0007 · Importación masiva del directorio: formato plantilla, resolución de ambigüedades y aplicación por lotes.
-- Los conductores son registros del CRM: la importación NUNCA crea cuentas en Supabase Auth.
-- Importes, SALDO y ACUERDO siguen sin convertirse en movimientos financieros.
set search_path = public, extensions;

-- ───────── Staging: formato de archivo y campos de la plantilla ─────────
alter table public.excel_imports
  add column source_kind text not null default 'cobranza' check (source_kind in ('cobranza', 'directory'));
alter table public.import_rows
  add column first_name text, add column last_name text, add column phone_e164 text, add column row_status text,
  add column changes jsonb not null default '{}';            -- diferencias detectadas frente a lo existente (solo informativo)

-- ═════════ apply_import (v2): con política de resolución explícita ═════════
-- p_resolve = 'skip'         → lo ambiguo entre bloques NO se adivina (comportamiento anterior).
-- p_resolve = 'latest_block' → para unidad y tarifa se usa el bloque MÁS A LA DERECHA donde aparece el conductor.
--                              Supuesto declarado (sin confirmar): los bloques están en orden cronológico. No inventa fechas:
--                              la fecha de alta la elige la administradora al aplicar.
drop function public.apply_import(uuid, date, text);
create function public.apply_import(p_import_id uuid, p_valid_from date default null, p_initial_status text default 'active',
  p_resolve text default 'skip') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_imp record; v_from date; g record; v_drv uuid; v_unit uuid; v_asg uuid; v_existing_asg record; v_maxblock int;
  v_nid text[]; v_units text[]; v_rates bigint[]; v_name text; v_created_driver boolean; v_note text; v_action text;
  c_drivers_created int := 0; c_drivers_linked int := 0; c_units_created int := 0; c_asg_created int := 0; c_rates_created int := 0;
  c_skipped int := 0; c_rejected int := 0; c_excluded int := 0; c_resolved int := 0; v_issues jsonb := '[]'::jsonb;
begin
  perform app_private.assert_admin();
  if p_resolve not in ('skip', 'latest_block') then raise exception 'invalid_resolve' using errcode = '22023'; end if;
  select i.* into v_imp from public.excel_imports i where i.id = p_import_id for update;
  if not found then raise exception 'import_not_found' using errcode = 'P0002'; end if;
  if v_imp.source_kind <> 'cobranza' then raise exception 'wrong_import_kind' using errcode = '22023'; end if;
  if v_imp.status = 'applied' then raise exception 'import_already_applied' using errcode = '22023'; end if;
  if v_imp.status <> 'confirmed' then raise exception 'import_not_confirmed' using errcode = '22023'; end if;
  if p_initial_status not in ('active', 'inactive', 'pending_approval') then raise exception 'invalid_status' using errcode = '22023'; end if;
  v_from := coalesce(p_valid_from, (now() at time zone app_private.tz())::date);

  update public.import_rows r set applied_action = 'excluded', applied_note = 'no aprobada'
    from public.import_blocks b where b.id = r.block_id and b.import_id = p_import_id and r.review_status <> 'approved';
  get diagnostics c_excluded = row_count;
  update public.import_rows r set applied_action = 'rejected',
      applied_note = case when r.match_status in ('ignored','conflict','duplicate') then 'estado de conciliación: ' || r.match_status
                          when coalesce(btrim(r.operator_code), '') = '' then 'sin código de operador' else 'sin cédula' end
    from public.import_blocks b where b.id = r.block_id and b.import_id = p_import_id and r.review_status = 'approved'
     and (r.match_status in ('ignored','conflict','duplicate') or coalesce(btrim(r.operator_code), '') = '' or coalesce(btrim(r.national_id), '') = '');
  get diagnostics c_rejected = row_count;

  for g in select btrim(r.operator_code) as op, array_agg(r.id) as row_ids from public.import_rows r join public.import_blocks b on b.id = r.block_id
            where b.import_id = p_import_id and r.review_status = 'approved' and r.applied_action is null group by btrim(r.operator_code) order by btrim(r.operator_code) loop
    select max(b.block_index) into v_maxblock from public.import_rows r join public.import_blocks b on b.id = r.block_id where r.id = any (g.row_ids);
    select array_agg(distinct btrim(r.national_id)) into v_nid from public.import_rows r where r.id = any (g.row_ids);
    if cardinality(v_nid) > 1 then
      update public.import_rows set applied_action = 'skipped', applied_note = 'cédulas distintas para el mismo operador' where id = any (g.row_ids);
      c_skipped := c_skipped + 1; v_issues := v_issues || jsonb_build_object('operator', g.op, 'issue', 'national_id_ambiguous'); continue;
    end if;
    select array_agg(distinct upper(btrim(r.unit_code))) filter (where coalesce(btrim(r.unit_code), '') <> ''), array_agg(distinct r.daily_rate_cents) filter (where r.daily_rate_cents > 0)
      into v_units, v_rates from public.import_rows r join public.import_blocks b on b.id = r.block_id where r.id = any (g.row_ids);
    if p_resolve = 'latest_block' and (cardinality(v_units) > 1 or cardinality(v_rates) > 1) then
      select array_agg(distinct upper(btrim(r.unit_code))) filter (where coalesce(btrim(r.unit_code), '') <> ''), array_agg(distinct r.daily_rate_cents) filter (where r.daily_rate_cents > 0)
        into v_units, v_rates from public.import_rows r join public.import_blocks b on b.id = r.block_id where r.id = any (g.row_ids) and b.block_index = v_maxblock;
      c_resolved := c_resolved + 1;
      v_issues := v_issues || jsonb_build_object('operator', g.op, 'issue', 'resolved_by_latest_block');
    end if;
    select r.full_name into v_name from public.import_rows r join public.import_blocks b on b.id = r.block_id
     where r.id = any (g.row_ids) and coalesce(btrim(r.full_name), '') <> '' group by r.full_name order by count(*) desc, max(b.block_index) desc limit 1;

    select d.id into v_drv from public.drivers d where d.operator_code = g.op or d.national_id = v_nid[1] order by (d.operator_code = g.op) desc limit 1;
    v_created_driver := false;
    if v_drv is null then
      insert into public.drivers(operator_code, national_id, first_name, last_name, status)
      values (g.op, v_nid[1], coalesce(nullif(btrim(v_name), ''), 'Sin nombre'), '', p_initial_status) returning id into v_drv;
      v_created_driver := true; c_drivers_created := c_drivers_created + 1;
    else
      if exists (select 1 from public.drivers where id = v_drv and (operator_code <> g.op or national_id <> v_nid[1])) then
        update public.import_rows set applied_action = 'skipped', applied_note = 'el operador y la cédula apuntan a conductores distintos' where id = any (g.row_ids);
        c_skipped := c_skipped + 1; v_issues := v_issues || jsonb_build_object('operator', g.op, 'issue', 'identity_conflict'); continue;
      end if;
      c_drivers_linked := c_drivers_linked + 1;
    end if;

    v_note := null; v_action := case when v_created_driver then 'created' else 'linked' end; v_asg := null;
    if v_units is null then v_note := 'sin unidad: conductor sin asignación';
    elsif cardinality(v_units) > 1 then
      v_note := 'unidades distintas entre bloques (' || array_to_string(v_units, ', ') || '): asigne manualmente';
      v_issues := v_issues || jsonb_build_object('operator', g.op, 'issue', 'unit_ambiguous');
    else
      select u.id into v_unit from public.units u where upper(u.code) = v_units[1];
      if v_unit is null then
        insert into public.units(code) values ((select btrim(r.unit_code) from public.import_rows r where r.id = any (g.row_ids) and upper(btrim(r.unit_code)) = v_units[1] limit 1)) returning id into v_unit;
        c_units_created := c_units_created + 1;
      end if;
      select a.* into v_existing_asg from public.assignments a where a.driver_id = v_drv and a.valid_to is null limit 1;
      if found then
        if v_existing_asg.unit_id = v_unit then v_asg := v_existing_asg.id;
        else v_note := 'el conductor ya tiene otra unidad asignada: no se modifica'; v_issues := v_issues || jsonb_build_object('operator', g.op, 'issue', 'assignment_conflict'); end if;
      elsif exists (select 1 from public.assignments a where a.unit_id = v_unit and a.valid_to is null) then
        v_note := 'la unidad ya está asignada a otro conductor: no se modifica'; v_issues := v_issues || jsonb_build_object('operator', g.op, 'issue', 'unit_already_assigned');
      else
        insert into public.assignments(driver_id, unit_id, valid_from) values (v_drv, v_unit, v_from) returning id into v_asg;
        c_asg_created := c_asg_created + 1;
      end if;
      if v_asg is not null then
        if v_rates is null then v_note := coalesce(v_note || '; ', '') || 'sin tarifa en el Excel';
        elsif cardinality(v_rates) > 1 then
          v_note := coalesce(v_note || '; ', '') || 'tarifas distintas entre bloques: defina la tarifa manualmente';
          v_issues := v_issues || jsonb_build_object('operator', g.op, 'issue', 'rate_ambiguous');
        elsif not exists (select 1 from public.rates r where r.assignment_id = v_asg and r.valid_to is null) then
          insert into public.rates(assignment_id, daily_amount_cents, valid_from) values (v_asg, v_rates[1], v_from);
          c_rates_created := c_rates_created + 1;
        elsif not exists (select 1 from public.rates r where r.assignment_id = v_asg and r.valid_to is null and r.daily_amount_cents = v_rates[1]) then
          v_note := coalesce(v_note || '; ', '') || 'la tarifa del Excel difiere de la vigente: no se modifica';
          v_issues := v_issues || jsonb_build_object('operator', g.op, 'issue', 'rate_differs');
        end if;
      end if;
    end if;
    update public.import_rows set applied_action = v_action, applied_note = v_note, matched_driver_id = v_drv where id = any (g.row_ids);
  end loop;

  update public.excel_imports set status = 'applied', applied_by = auth.uid(), applied_at = now(),
    summary = summary || jsonb_build_object('applied', jsonb_build_object('drivers_created', c_drivers_created, 'drivers_linked', c_drivers_linked,
      'units_created', c_units_created, 'assignments_created', c_asg_created, 'rates_created', c_rates_created, 'skipped', c_skipped,
      'rows_rejected', c_rejected, 'rows_excluded', c_excluded, 'resolved_by_latest_block', c_resolved, 'resolve', p_resolve, 'valid_from', v_from, 'issues', v_issues)) where id = p_import_id;
  perform app_private.audit('apply_import', 'excel_imports', p_import_id, jsonb_build_object('drivers_created', c_drivers_created, 'drivers_linked', c_drivers_linked,
    'units_created', c_units_created, 'assignments_created', c_asg_created, 'rates_created', c_rates_created, 'resolve', p_resolve));
  return (select summary -> 'applied' from public.excel_imports where id = p_import_id);
end $$;

-- ═════════ apply_directory_import: plantilla para altas Y actualizaciones ═════════
-- Una celda vacía significa "sin cambio" (nunca borra datos). No toca pagos, cargos ni saldos.
-- Las diferencias de tarifa solo se aplican si p_apply_rate_changes = true (cierra la vigente el día anterior y abre la nueva).
-- Los cambios de unidad de un conductor ya asignado NO se aplican: se informan (usar «cambiar conductor/unidad»).
create function public.apply_directory_import(p_import_id uuid, p_valid_from date default null, p_initial_status text default 'active',
  p_apply_rate_changes boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_imp record; v_from date; r record; v_drv uuid; v_unit uuid; v_asg uuid; v_asg_row record; v_status text; v_cur record;
  c_created int := 0; c_updated int := 0; c_unchanged int := 0; c_units int := 0; c_asg int := 0; c_rates int := 0; c_rate_changed int := 0;
  c_rejected int := 0; c_excluded int := 0; v_issues jsonb := '[]'::jsonb; v_note text; v_changed boolean; v_new boolean;
begin
  perform app_private.assert_admin();
  select i.* into v_imp from public.excel_imports i where i.id = p_import_id for update;
  if not found then raise exception 'import_not_found' using errcode = 'P0002'; end if;
  if v_imp.source_kind <> 'directory' then raise exception 'wrong_import_kind' using errcode = '22023'; end if;
  if v_imp.status = 'applied' then raise exception 'import_already_applied' using errcode = '22023'; end if;
  if v_imp.status <> 'confirmed' then raise exception 'import_not_confirmed' using errcode = '22023'; end if;
  if p_initial_status not in ('active', 'inactive', 'pending_approval') then raise exception 'invalid_status' using errcode = '22023'; end if;
  v_from := coalesce(p_valid_from, (now() at time zone app_private.tz())::date);

  update public.import_rows x set applied_action = 'excluded', applied_note = 'no aprobada'
    from public.import_blocks b where b.id = x.block_id and b.import_id = p_import_id and x.review_status <> 'approved';
  get diagnostics c_excluded = row_count;

  for r in select x.* from public.import_rows x join public.import_blocks b on b.id = x.block_id
            where b.import_id = p_import_id and x.review_status = 'approved' and x.applied_action is null order by x.source_row loop
    begin
      if r.match_status in ('ignored', 'duplicate', 'conflict') or coalesce(btrim(r.operator_code), '') = '' or coalesce(btrim(r.national_id), '') = ''
         or coalesce(btrim(r.first_name), '') = '' then
        update public.import_rows set applied_action = 'rejected', applied_note = coalesce(nullif(case when r.match_status in ('ignored','duplicate','conflict') then 'estado de conciliación: ' || r.match_status end, ''), 'faltan operador, cédula o nombre') where id = r.id;
        c_rejected := c_rejected + 1; continue;
      end if;
      v_status := nullif(btrim(r.row_status), '');
      if v_status is not null and v_status not in ('active', 'inactive', 'suspended', 'pending_approval') then
        update public.import_rows set applied_action = 'rejected', applied_note = 'estado inválido' where id = r.id; c_rejected := c_rejected + 1; continue;
      end if;
      v_note := null; v_new := false; v_changed := false;

      select d.id into v_drv from public.drivers d where d.operator_code = btrim(r.operator_code) or d.national_id = btrim(r.national_id)
       order by (d.operator_code = btrim(r.operator_code)) desc limit 1;
      if v_drv is not null and exists (select 1 from public.drivers where id = v_drv and (operator_code <> btrim(r.operator_code) or national_id <> btrim(r.national_id))) then
        update public.import_rows set applied_action = 'rejected', applied_note = 'el operador y la cédula apuntan a conductores distintos' where id = r.id;
        c_rejected := c_rejected + 1; v_issues := v_issues || jsonb_build_object('operator', r.operator_code, 'issue', 'identity_conflict'); continue;
      end if;

      if v_drv is null then
        insert into public.drivers(operator_code, national_id, first_name, last_name, phone_e164, status)
        values (btrim(r.operator_code), btrim(r.national_id), btrim(r.first_name), coalesce(btrim(r.last_name), ''), nullif(btrim(r.phone_e164), ''), coalesce(v_status, p_initial_status))
        returning id into v_drv;
        v_new := true; c_created := c_created + 1;
      else
        select * into v_cur from public.drivers where id = v_drv;
        if btrim(r.first_name) <> v_cur.first_name or coalesce(nullif(btrim(r.last_name), ''), v_cur.last_name) <> v_cur.last_name
           or (nullif(btrim(r.phone_e164), '') is not null and btrim(r.phone_e164) is distinct from v_cur.phone_e164)
           or (v_status is not null and v_status <> v_cur.status) then
          update public.drivers set first_name = btrim(r.first_name), last_name = coalesce(nullif(btrim(r.last_name), ''), last_name),
              phone_e164 = coalesce(nullif(btrim(r.phone_e164), ''), phone_e164), status = coalesce(v_status, status) where id = v_drv;
          v_changed := true; c_updated := c_updated + 1;
        else c_unchanged := c_unchanged + 1; end if;
      end if;

      v_asg := null;
      if coalesce(btrim(r.unit_code), '') <> '' then
        select u.id into v_unit from public.units u where upper(u.code) = upper(btrim(r.unit_code));
        if v_unit is null then insert into public.units(code) values (btrim(r.unit_code)) returning id into v_unit; c_units := c_units + 1; end if;
        select a.* into v_asg_row from public.assignments a where a.driver_id = v_drv and a.valid_to is null limit 1;
        if found then
          if v_asg_row.unit_id = v_unit then v_asg := v_asg_row.id;
          else v_note := 'el conductor ya tiene otra unidad: use «cambiar conductor/unidad»'; v_issues := v_issues || jsonb_build_object('operator', r.operator_code, 'issue', 'assignment_conflict'); end if;
        elsif exists (select 1 from public.assignments a where a.unit_id = v_unit and a.valid_to is null) then
          v_note := 'la unidad ya está asignada a otro conductor'; v_issues := v_issues || jsonb_build_object('operator', r.operator_code, 'issue', 'unit_already_assigned');
        else
          insert into public.assignments(driver_id, unit_id, valid_from) values (v_drv, v_unit, v_from) returning id into v_asg; c_asg := c_asg + 1;
        end if;
      else
        select a.id into v_asg from public.assignments a where a.driver_id = v_drv and a.valid_to is null limit 1;
      end if;

      if v_asg is not null and r.daily_rate_cents is not null and r.daily_rate_cents > 0 then
        select * into v_cur from public.rates where assignment_id = v_asg and valid_to is null;
        if not found then
          insert into public.rates(assignment_id, daily_amount_cents, valid_from) values (v_asg, r.daily_rate_cents, v_from); c_rates := c_rates + 1;
        elsif v_cur.daily_amount_cents <> r.daily_rate_cents then
          if p_apply_rate_changes then
            perform public.change_rate(v_asg, r.daily_rate_cents, v_from); c_rate_changed := c_rate_changed + 1;
          else
            v_note := coalesce(v_note || '; ', '') || 'la tarifa difiere de la vigente: no se modifica';
            v_issues := v_issues || jsonb_build_object('operator', r.operator_code, 'issue', 'rate_differs');
          end if;
        end if;
      end if;
      update public.import_rows set applied_action = case when v_new then 'created' else 'linked' end, applied_note = v_note, matched_driver_id = v_drv where id = r.id;
    exception when check_violation or invalid_text_representation or exclusion_violation or raise_exception then
      update public.import_rows set applied_action = 'rejected', applied_note = left('no se pudo aplicar: ' || sqlerrm, 200) where id = r.id;
      c_rejected := c_rejected + 1; v_issues := v_issues || jsonb_build_object('operator', r.operator_code, 'issue', 'row_failed');
    end;
  end loop;

  update public.excel_imports set status = 'applied', applied_by = auth.uid(), applied_at = now(),
    summary = summary || jsonb_build_object('applied', jsonb_build_object('drivers_created', c_created, 'drivers_updated', c_updated, 'drivers_unchanged', c_unchanged,
      'units_created', c_units, 'assignments_created', c_asg, 'rates_created', c_rates, 'rates_changed', c_rate_changed, 'rows_rejected', c_rejected,
      'rows_excluded', c_excluded, 'valid_from', v_from, 'issues', v_issues)) where id = p_import_id;
  perform app_private.audit('apply_directory_import', 'excel_imports', p_import_id, jsonb_build_object('drivers_created', c_created, 'drivers_updated', c_updated,
    'units_created', c_units, 'assignments_created', c_asg, 'rates_created', c_rates, 'rates_changed', c_rate_changed));
  return (select summary -> 'applied' from public.excel_imports where id = p_import_id);
end $$;

revoke all on function public.apply_import(uuid, date, text, text), public.apply_directory_import(uuid, date, text, boolean) from public, anon, authenticated;
grant execute on function public.apply_import(uuid, date, text, text), public.apply_directory_import(uuid, date, text, boolean) to authenticated, service_role;

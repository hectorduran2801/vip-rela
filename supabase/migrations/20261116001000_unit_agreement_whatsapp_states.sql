-- VIP · 0010 · «Acuerdo / condición especial» de la unidad como TEXTO LIBRE (sin catálogo) + estados reales de la sesión de WhatsApp.
-- Los datos de 0009 se CONSERVAN: valores y historial se migran a las columnas/tabla nuevas antes de retirar el catálogo.
-- Cambiar el acuerdo NUNCA toca pagos, cargos, tarifas, saldos ni asignaciones.
set search_path = public, extensions;

-- ───────── Acuerdo libre en la unidad ─────────
alter table public.units
  add column agreement text check (agreement is null or length(btrim(agreement)) between 1 and 200),
  add column agreement_note text check (agreement_note is null or length(agreement_note) <= 1000);

-- Conserva lo registrado con el catálogo: «Otros» ya guardaba el texto en el comentario; los demás pasan a su etiqueta.
update public.units u set
  agreement = case when u.condition_code = 'other' then nullif(btrim(u.condition_comment), '') else t.label end,
  agreement_note = case when u.condition_code = 'other' then null else nullif(btrim(u.condition_comment), '') end
  from public.unit_condition_types t where t.code = u.condition_code;

create table public.unit_agreement_history (
  id bigint generated always as identity primary key,
  unit_id uuid not null references public.units(id),
  agreement text,                                       -- null = se quitó
  note text,
  previous_agreement text,
  previous_note text,
  source text not null default 'manual' check (source in ('manual', 'import')),
  changed_by uuid references public.profiles(id),       -- null = servidor / importación sin sesión
  changed_at timestamptz not null default now()
);
create index unit_agreement_history_unit on public.unit_agreement_history(unit_id, changed_at desc);
create trigger no_mutation before update or delete on public.unit_agreement_history for each row execute function app_private.block_mutation();
-- historial anterior → nueva tabla (en orden, sin perder quién ni cuándo)
insert into public.unit_agreement_history(unit_id, agreement, note, previous_agreement, previous_note, source, changed_by, changed_at)
select h.unit_id, case when h.condition_code = 'other' then h.comment else t.label end, case when h.condition_code = 'other' then null else h.comment end,
       case when h.previous_condition_code = 'other' then h.previous_comment else pt.label end, case when h.previous_condition_code = 'other' then null else h.previous_comment end,
       h.source, h.changed_by, h.changed_at
  from public.unit_condition_history h left join public.unit_condition_types t on t.code = h.condition_code
  left join public.unit_condition_types pt on pt.code = h.previous_condition_code order by h.id;

-- Retira el catálogo y sus mecanismos
drop trigger enforce_condition on public.units;
drop trigger record_condition on public.units;
drop function public.set_unit_condition(uuid, text, text, date);
drop function app_private.enforce_unit_condition();
drop function app_private.record_unit_condition();
drop function app_private.map_unit_condition(text);
alter table public.units drop constraint units_condition_consistency;
drop index public.units_condition_idx;
alter table public.units drop column condition_code, drop column condition_comment, drop column condition_since;
drop table public.unit_condition_history;
drop table public.unit_condition_types;
alter table public.import_rows rename column unit_condition to unit_agreement;
alter table public.import_rows rename column unit_condition_comment to unit_agreement_note;
create index units_agreement_idx on public.units(upper(agreement)) where agreement is not null;

-- Historial automático (quién y cuándo), venga de la función, de una importación o de SQL.
create function app_private.record_unit_agreement() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' and new.agreement is null and new.agreement_note is null then return new; end if;
  if tg_op = 'UPDATE' and new.agreement is not distinct from old.agreement and new.agreement_note is not distinct from old.agreement_note then return new; end if;
  insert into public.unit_agreement_history(unit_id, agreement, note, previous_agreement, previous_note, source, changed_by)
  values (new.id, new.agreement, new.agreement_note, case when tg_op = 'UPDATE' then old.agreement end, case when tg_op = 'UPDATE' then old.agreement_note end,
          coalesce(nullif(current_setting('vip.source', true), ''), 'manual'), auth.uid());
  return new;
end $$;
create trigger record_agreement after insert or update on public.units for each row execute function app_private.record_unit_agreement();

-- Edición (ADMIN+): texto libre, vacío = sin acuerdo. Sin cambios reales no se escribe nada (evita ruido y solicitudes duplicadas).
create function public.set_unit_agreement(p_unit_id uuid, p_agreement text, p_note text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare u record; v_ag text := nullif(btrim(coalesce(p_agreement, '')), ''); v_nt text := nullif(btrim(coalesce(p_note, '')), '');
begin
  perform app_private.assert_admin();
  select * into u from public.units where id = p_unit_id for update;
  if not found then raise exception 'unit_not_found' using errcode = 'P0002'; end if;
  if v_ag is null then v_nt := nullif(v_nt, ''); end if;                       -- la observación se conserva aunque no haya acuerdo
  if v_ag is not distinct from u.agreement and v_nt is not distinct from u.agreement_note then
    return jsonb_build_object('unit_id', u.id, 'agreement', u.agreement, 'agreement_note', u.agreement_note, 'changed', false);
  end if;
  if v_ag is not null and length(v_ag) > 200 then raise exception 'agreement_too_long' using errcode = '22023'; end if;
  if v_nt is not null and length(v_nt) > 1000 then raise exception 'note_too_long' using errcode = '22023'; end if;
  update public.units set agreement = v_ag, agreement_note = v_nt where id = p_unit_id;
  perform app_private.audit('set_unit_agreement', 'units', p_unit_id, jsonb_build_object('previous_agreement', u.agreement, 'agreement', v_ag, 'previous_note', u.agreement_note, 'note', v_nt));
  return jsonb_build_object('unit_id', p_unit_id, 'agreement', v_ag, 'agreement_note', v_nt, 'changed', true);
end $$;

-- Aplica agreement/note venidos de la plantilla. '-' = quitar el acuerdo; vacío = sin cambio. Devuelve true si cambió algo.
create function app_private.apply_unit_agreement(p_unit uuid, p_agreement text, p_note text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare u record; v_ag text := nullif(btrim(coalesce(p_agreement, '')), ''); v_nt text := nullif(btrim(coalesce(p_note, '')), ''); v_new_ag text; v_new_nt text;
begin
  if v_ag is null and v_nt is null then return false; end if;
  select * into u from public.units where id = p_unit for update;
  v_new_ag := case when v_ag = '-' then null when v_ag is null then u.agreement else v_ag end;
  v_new_nt := case when v_ag = '-' then null when v_nt is null then u.agreement_note else v_nt end;
  if v_new_ag is not distinct from u.agreement and v_new_nt is not distinct from u.agreement_note then return false; end if;
  perform set_config('vip.source', 'import', true);
  update public.units set agreement = v_new_ag, agreement_note = v_new_nt where id = p_unit;
  return true;
end $$;

-- La columna se edita SOLO con set_unit_agreement (el UPDATE directo de agreement/agreement_note sigue sin permiso).
alter table public.unit_agreement_history enable row level security;
revoke all on public.unit_agreement_history from anon, authenticated;
grant select on public.unit_agreement_history to authenticated;
grant all on public.unit_agreement_history to service_role;
grant usage, select on sequence public.unit_agreement_history_id_seq to service_role;
create policy unit_agreement_history_select on public.unit_agreement_history for select to authenticated using (app_private.is_staff());

create or replace function public.apply_import(p_import_id uuid, p_valid_from date default null, p_initial_status text default 'active',
  p_resolve text default 'skip') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_imp record; v_from date; g record; v_drv uuid; v_unit uuid; v_asg uuid; v_existing_asg record; v_maxblock int;
  v_nid text[]; v_units text[]; v_rates bigint[]; v_name text; v_created_driver boolean; v_note text; v_action text;
  c_drivers_created int := 0; c_drivers_linked int := 0; c_units_created int := 0; c_asg_created int := 0; c_rates_created int := 0;
  c_skipped int := 0; c_rejected int := 0; c_excluded int := 0; c_resolved int := 0; v_issues jsonb := '[]'::jsonb;
  c_units_no_driver int := 0; c_agr_set int := 0; c_agr_skipped int := 0; uu record; v_n int; v_text text; v_cur text; v_maxb int;
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
      applied_note = case when r.match_status in ('ignored','conflict','duplicate') then 'estado de conciliación: ' || r.match_status else 'sin unidad ni operario' end
    from public.import_blocks b where b.id = r.block_id and b.import_id = p_import_id and r.review_status = 'approved'
     and (r.match_status in ('ignored','conflict','duplicate') or (coalesce(btrim(r.operator_code), '') = '' and coalesce(btrim(r.unit_code), '') = ''));
  get diagnostics c_rejected = row_count;

  for g in select btrim(r.operator_code) as op, array_agg(r.id) as row_ids from public.import_rows r join public.import_blocks b on b.id = r.block_id
            where b.import_id = p_import_id and r.review_status = 'approved' and r.applied_action is null and coalesce(btrim(r.operator_code), '') <> '' group by btrim(r.operator_code) order by btrim(r.operator_code) loop
    select max(b.block_index) into v_maxblock from public.import_rows r join public.import_blocks b on b.id = r.block_id where r.id = any (g.row_ids);
    select array_agg(distinct btrim(r.national_id)) filter (where coalesce(btrim(r.national_id), '') <> '') into v_nid from public.import_rows r where r.id = any (g.row_ids);
    if v_nid is null then   -- operario sin cédula: no se crea el conductor; la unidad se importa igualmente
      update public.import_rows set applied_action = 'skipped', applied_note = 'sin cédula: no se crea el conductor (la unidad sí)' where id = any (g.row_ids);
      c_skipped := c_skipped + 1; v_issues := v_issues || jsonb_build_object('operator', g.op, 'issue', 'driver_incomplete'); continue;
    end if;
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

  -- ───── Unidades (con o sin conductor) y su acuerdo / condición especial ─────
  -- El código de unidad es obligatorio y único; una unidad puede existir sin conductor. La condición se toma de ACUERDO.
  for uu in select upper(btrim(r.unit_code)) as ucode, min(btrim(r.unit_code)) as raw_code, array_agg(r.id) as row_ids
             from public.import_rows r join public.import_blocks b on b.id = r.block_id
            where b.import_id = p_import_id and r.review_status = 'approved' and coalesce(btrim(r.unit_code), '') <> ''
              and (r.applied_action is null or r.applied_action in ('created', 'linked', 'skipped'))
            group by upper(btrim(r.unit_code)) order by upper(btrim(r.unit_code)) loop
    select un.id into v_unit from public.units un where upper(un.code) = uu.ucode;
    if v_unit is null then
      insert into public.units(code) values (uu.raw_code) returning id into v_unit; c_units_created := c_units_created + 1;
      if not exists (select 1 from public.assignments a where a.unit_id = v_unit) then c_units_no_driver := c_units_no_driver + 1; end if;
    elsif not exists (select 1 from public.assignments a where a.unit_id = v_unit and a.valid_to is null) and exists
          (select 1 from public.import_rows r where r.id = any (uu.row_ids) and coalesce(btrim(r.operator_code), '') = '') then
      c_units_no_driver := c_units_no_driver + 1;
    end if;
    update public.import_rows set applied_action = case when applied_action is null then 'linked' else applied_action end,
           applied_note = coalesce(applied_note, 'unidad sin conductor asignado') where id = any (uu.row_ids) and applied_action is null;
    -- ACUERDO → «Acuerdo / condición especial» de la unidad: TEXTO LIBRE, se guarda tal cual (solo se recortan espacios laterales).
    -- 'skip': solo si todas las filas con valor coinciden (sin distinguir mayúsculas); 'latest_block': el valor del bloque más a la derecha.
    select max(b.block_index) into v_maxb from public.import_rows r join public.import_blocks b on b.id = r.block_id
     where r.id = any (uu.row_ids) and nullif(btrim(r.raw_agreement), '') is not null;
    select count(distinct upper(btrim(r.raw_agreement))), (array_agg(btrim(r.raw_agreement) order by b.block_index desc, r.source_row))[1]
      into v_n, v_text from public.import_rows r join public.import_blocks b on b.id = r.block_id
     where r.id = any (uu.row_ids) and nullif(btrim(r.raw_agreement), '') is not null and (p_resolve = 'skip' or b.block_index = v_maxb);
    if coalesce(v_n, 0) = 0 then continue;
    elsif v_n > 1 then
      c_agr_skipped := c_agr_skipped + 1; v_issues := v_issues || jsonb_build_object('unit', uu.ucode, 'issue', 'agreement_ambiguous'); continue;
    end if;
    select un.agreement into v_cur from public.units un where un.id = v_unit;
    if v_cur is not null and upper(btrim(v_cur)) <> upper(v_text) then
      c_agr_skipped := c_agr_skipped + 1; v_issues := v_issues || jsonb_build_object('unit', uu.ucode, 'issue', 'agreement_differs'); continue;   -- no pisa un acuerdo ya registrado
    end if;
    if v_cur is null then
      perform set_config('vip.source', 'import', true);
      begin
        update public.units set agreement = v_text where id = v_unit;
        c_agr_set := c_agr_set + 1;
      exception when others then
        c_agr_skipped := c_agr_skipped + 1; v_issues := v_issues || jsonb_build_object('unit', uu.ucode, 'issue', 'agreement_invalid', 'detail', sqlerrm);
      end;
    end if;
  end loop;

  update public.excel_imports set status = 'applied', applied_by = auth.uid(), applied_at = now(),
    summary = summary || jsonb_build_object('applied', jsonb_build_object('drivers_created', c_drivers_created, 'drivers_linked', c_drivers_linked,
      'units_created', c_units_created, 'assignments_created', c_asg_created, 'rates_created', c_rates_created, 'skipped', c_skipped,
      'rows_rejected', c_rejected, 'rows_excluded', c_excluded, 'resolved_by_latest_block', c_resolved, 'units_without_driver', c_units_no_driver, 'agreements_set', c_agr_set, 'agreements_skipped', c_agr_skipped, 'resolve', p_resolve, 'valid_from', v_from, 'issues', v_issues)) where id = p_import_id;
  perform app_private.audit('apply_import', 'excel_imports', p_import_id, jsonb_build_object('drivers_created', c_drivers_created, 'drivers_linked', c_drivers_linked,
    'units_created', c_units_created, 'assignments_created', c_asg_created, 'rates_created', c_rates_created, 'resolve', p_resolve));
  return (select summary -> 'applied' from public.excel_imports where id = p_import_id);
end $$;

create or replace function public.apply_directory_import(p_import_id uuid, p_valid_from date default null, p_initial_status text default 'active',
  p_apply_rate_changes boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_imp record; v_from date; r record; v_drv uuid; v_unit uuid; v_asg uuid; v_asg_row record; v_status text; v_cur record;
  c_created int := 0; c_updated int := 0; c_unchanged int := 0; c_units int := 0; c_asg int := 0; c_rates int := 0; c_rate_changed int := 0;
  c_rejected int := 0; c_excluded int := 0; v_issues jsonb := '[]'::jsonb; v_note text; v_changed boolean; v_new boolean; c_units_no_driver int := 0; c_agr_set int := 0;
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
      if coalesce(btrim(r.operator_code), '') = '' and coalesce(btrim(r.unit_code), '') <> '' and r.match_status not in ('ignored', 'duplicate', 'conflict') then
        -- unidad SIN conductor: el código de unidad es obligatorio; el operario no. No se inventa conductor.
        select u.id into v_unit from public.units u where upper(u.code) = upper(btrim(r.unit_code));
        if v_unit is null then insert into public.units(code) values (btrim(r.unit_code)) returning id into v_unit; c_units := c_units + 1; c_units_no_driver := c_units_no_driver + 1; end if;
        if app_private.apply_unit_agreement(v_unit, r.unit_agreement, r.unit_agreement_note) then c_agr_set := c_agr_set + 1; end if;
        update public.import_rows set applied_action = 'linked', applied_note = 'unidad sin conductor' where id = r.id;
        continue;
      end if;
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

      if v_unit is not null and coalesce(btrim(r.unit_code), '') <> '' and app_private.apply_unit_agreement(v_unit, r.unit_agreement, r.unit_agreement_note) then c_agr_set := c_agr_set + 1; end if;
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
      'rows_excluded', c_excluded, 'units_without_driver', c_units_no_driver, 'agreements_set', c_agr_set, 'valid_from', v_from, 'issues', v_issues)) where id = p_import_id;
  perform app_private.audit('apply_directory_import', 'excel_imports', p_import_id, jsonb_build_object('drivers_created', c_created, 'drivers_updated', c_updated,
    'units_created', c_units, 'assignments_created', c_asg, 'rates_created', c_rates, 'rates_changed', c_rate_changed));
  return (select summary -> 'applied' from public.excel_imports where id = p_import_id);
end $$;

-- ───────── WhatsApp: estados reales de la sesión ─────────
-- disconnected → starting (Iniciando) → qr_pending (Esperando QR) → awaiting_scan (Esperando escaneo) → connecting → connected | failed (Error)
alter table public.whatsapp_sessions drop constraint whatsapp_sessions_status_check;
alter table public.whatsapp_sessions add constraint whatsapp_sessions_status_check
  check (status in ('disconnected', 'starting', 'qr_pending', 'awaiting_scan', 'connecting', 'connected', 'failed'));
alter table public.whatsapp_sessions
  add column phone_number text,                       -- número vinculado (solo cuando está conectada)
  add column last_error text,                         -- motivo real del último fallo
  add column worker_heartbeat_at timestamptz,         -- el worker lo actualiza; si es antiguo, el servicio está apagado
  add column status_changed_at timestamptz not null default now();

-- La administradora pide conectar/desconectar. Limpia el último error; el estado real lo escribe SOLO el worker.
create function public.request_whatsapp_connection(p_desired text) returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.assert_admin();
  if p_desired not in ('connected', 'disconnected') then raise exception 'invalid_state' using errcode = '22023'; end if;
  update public.whatsapp_sessions set desired_state = p_desired, last_error = null, updated_at = now();
  perform app_private.audit('request_whatsapp_' || p_desired, 'whatsapp_sessions', null, '{}');
  return (select jsonb_build_object('id', id, 'status', status, 'desired_state', desired_state, 'worker_heartbeat_at', worker_heartbeat_at) from public.whatsapp_sessions);
end $$;

revoke all on function public.set_unit_agreement(uuid, text, text), public.request_whatsapp_connection(text), public.apply_import(uuid, date, text, text),
  public.apply_directory_import(uuid, date, text, boolean), app_private.record_unit_agreement(), app_private.apply_unit_agreement(uuid, text, text) from public, anon, authenticated;
grant execute on function public.set_unit_agreement(uuid, text, text), public.request_whatsapp_connection(text), public.apply_import(uuid, date, text, text),
  public.apply_directory_import(uuid, date, text, boolean) to authenticated, service_role;

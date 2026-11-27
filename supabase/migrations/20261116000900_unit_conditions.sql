-- VIP · 0009 · Condiciones especiales de las unidades (catálogo + historial) y unidades sin conductor.
-- La condición explica situaciones (custodia, rescate, chapa, tapicería…) y es INDEPENDIENTE del estado operativo del vehículo.
-- Cambiarla NUNCA toca pagos, cargos, tarifas ni saldos, y no suspende la cobranza por sí sola.
set search_path = public, extensions;

create table public.unit_condition_types (
  code text primary key check (code ~ '^[a-z_]+$'),
  label text not null,
  requires_comment boolean not null default false,
  active boolean not null default true,
  sort_order int not null default 0
);
insert into public.unit_condition_types(code, label, requires_comment, sort_order) values
  ('agreement', 'Acuerdo', false, 10), ('custody', 'Custodia', false, 20), ('rescue', 'Rescate', false, 30),
  ('plate', 'Chapa', false, 40), ('upholstery', 'Tapicería', false, 50), ('other', 'Otros', true, 60);

alter table public.units
  add column condition_code text references public.unit_condition_types(code),
  add column condition_comment text,
  add column condition_since date,
  add constraint units_condition_consistency check (condition_code is not null or (condition_comment is null and condition_since is null));
-- El código de unidad es único sin distinguir mayúsculas ni espacios laterales (P300 = p300).
create unique index units_code_normalized_uq on public.units(upper(btrim(code)));
create index units_condition_idx on public.units(condition_code) where condition_code is not null;

alter table public.import_rows add column unit_condition text, add column unit_condition_comment text;

create table public.unit_condition_history (
  id bigint generated always as identity primary key,
  unit_id uuid not null references public.units(id),
  condition_code text,                                  -- null = se quitó la condición
  comment text,
  since date,
  previous_condition_code text,
  previous_comment text,
  source text not null default 'manual' check (source in ('manual', 'import')),
  changed_by uuid references public.profiles(id),       -- null = servidor / importación sin sesión
  changed_at timestamptz not null default now()
);
create index unit_condition_history_unit on public.unit_condition_history(unit_id, changed_at desc);
create trigger no_mutation before update or delete on public.unit_condition_history for each row execute function app_private.block_mutation();

-- El comentario es obligatorio cuando el tipo de condición lo exige (p. ej. «Otros»).
create function app_private.enforce_unit_condition() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.condition_code is not null then
    if not exists (select 1 from public.unit_condition_types t where t.code = new.condition_code and t.active) then
      raise exception 'invalid_condition' using errcode = '22023'; end if;
    if exists (select 1 from public.unit_condition_types t where t.code = new.condition_code and t.requires_comment) and length(btrim(coalesce(new.condition_comment, ''))) < 3 then
      raise exception 'comment_required' using errcode = '22023'; end if;
    new.condition_comment := nullif(btrim(new.condition_comment), '');
  end if;
  return new;
end $$;
create trigger enforce_condition before insert or update of condition_code, condition_comment on public.units
  for each row execute function app_private.enforce_unit_condition();

-- Historial automático (quién y cuándo), venga de la función, de una importación o de SQL.
create function app_private.record_unit_condition() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' and new.condition_code is null then return new; end if;
  if tg_op = 'UPDATE' and new.condition_code is not distinct from old.condition_code and new.condition_comment is not distinct from old.condition_comment
     and new.condition_since is not distinct from old.condition_since then return new; end if;
  insert into public.unit_condition_history(unit_id, condition_code, comment, since, previous_condition_code, previous_comment, source, changed_by)
  values (new.id, new.condition_code, new.condition_comment, new.condition_since, case when tg_op = 'UPDATE' then old.condition_code end,
          case when tg_op = 'UPDATE' then old.condition_comment end, coalesce(nullif(current_setting('vip.source', true), ''), 'manual'), auth.uid());
  return new;
end $$;
create trigger record_condition after insert or update on public.units for each row execute function app_private.record_unit_condition();

-- ACUERDO (texto libre del Excel) → catálogo. Reconoce custodia/rescate/chapa/tapicería/acuerdo; lo demás es «Otros» con el texto original.
create function app_private.map_unit_condition(p_raw text) returns table (code text, comment text)
language plpgsql immutable set search_path = '' as $$
declare v text; v_raw text := nullif(btrim(coalesce(p_raw, '')), '');
begin
  if v_raw is null then return; end if;
  v := lower(translate(v_raw, 'ÁÉÍÓÚÜáéíóúü', 'AEIOUUaeiouu'));
  code := case when v ~ '^custodia\M' then 'custody' when v ~ '^rescate\M' then 'rescue' when v ~ '^chapa\M' then 'plate'
               when v ~ '^tapiceria\M' then 'upholstery' when v ~ '^acuerdo\M' then 'agreement' else 'other' end;
  comment := case when v ~ '^(custodia|rescate|chapa|tapiceria|acuerdo)s?$' then null else v_raw end;     -- «CHAPA» a secas no lleva comentario
  return next;
end $$;

-- ───────── Edición de la condición (ADMIN+): valida, deja historial y auditoría ─────────
create function public.set_unit_condition(p_unit_id uuid, p_condition_code text, p_comment text default null, p_since date default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare u record;
begin
  perform app_private.assert_admin();
  select * into u from public.units where id = p_unit_id for update;
  if not found then raise exception 'unit_not_found' using errcode = 'P0002'; end if;
  if p_condition_code is null or p_condition_code in ('', 'none') then
    update public.units set condition_code = null, condition_comment = null, condition_since = null where id = p_unit_id;
  else
    update public.units set condition_code = p_condition_code, condition_comment = nullif(btrim(p_comment), ''), condition_since = p_since where id = p_unit_id;
  end if;
  perform app_private.audit('set_unit_condition', 'units', p_unit_id, jsonb_build_object('condition', p_condition_code, 'comment', p_comment, 'since', p_since));
  return (select jsonb_build_object('unit_id', id, 'condition_code', condition_code, 'condition_comment', condition_comment, 'condition_since', condition_since) from public.units where id = p_unit_id);
end $$;

-- Los miembros internos pueden ver nombre y correo de los demás (para saber quién hizo cada cambio). Los conductores no tienen perfil.
create function app_private.is_internal_user(p_id uuid) returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.app_users u where u.user_id = p_id) $$;
revoke all on function app_private.is_internal_user(uuid) from public, anon, authenticated;
grant execute on function app_private.is_internal_user(uuid) to authenticated, service_role;
drop policy profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
  using (app_private.is_staff() and (id = auth.uid() or app_private.is_internal_user(id)));

-- ───────── Permisos: la condición solo se edita con set_unit_condition ─────────
alter table public.unit_condition_types enable row level security;
alter table public.unit_condition_history enable row level security;
revoke all on public.unit_condition_types, public.unit_condition_history from anon, authenticated;
grant select on public.unit_condition_types, public.unit_condition_history to authenticated;
grant insert, update on public.unit_condition_types to authenticated;
grant all on public.unit_condition_types, public.unit_condition_history to service_role;
grant usage, select on sequence public.unit_condition_history_id_seq to service_role;
create policy unit_condition_types_select on public.unit_condition_types for select to authenticated using (app_private.is_staff());
create policy unit_condition_types_write on public.unit_condition_types for all to authenticated using (app_private.is_super()) with check (app_private.is_super());
create policy unit_condition_history_select on public.unit_condition_history for select to authenticated using (app_private.is_staff());
revoke insert, update on public.units from authenticated;
grant insert (code, plate, make, model, year, vehicle_status, notes), update (code, plate, make, model, year, vehicle_status, notes) on public.units to authenticated;
create trigger audit after insert or update or delete on public.unit_condition_types for each row execute function app_private.audit_row();

create or replace function public.apply_import(p_import_id uuid, p_valid_from date default null, p_initial_status text default 'active',
  p_resolve text default 'skip') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_imp record; v_from date; g record; v_drv uuid; v_unit uuid; v_asg uuid; v_existing_asg record; v_maxblock int;
  v_nid text[]; v_units text[]; v_rates bigint[]; v_name text; v_created_driver boolean; v_note text; v_action text;
  c_drivers_created int := 0; c_drivers_linked int := 0; c_units_created int := 0; c_asg_created int := 0; c_rates_created int := 0;
  c_skipped int := 0; c_rejected int := 0; c_excluded int := 0; c_resolved int := 0; v_issues jsonb := '[]'::jsonb;
  c_units_no_driver int := 0; c_cond_set int := 0; c_cond_skipped int := 0; uu record; v_conds jsonb; v_n int; v_cc text; v_cm text; v_cur_code text;
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

  -- ───── Unidades (con o sin conductor) y su condición especial ─────
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
    -- condición especial (ACUERDO → catálogo). 'skip': solo si todas las filas coinciden; 'latest_block': el bloque más a la derecha con valor.
    select coalesce(jsonb_agg(distinct jsonb_build_object('code', m.code, 'comment', m.comment)), '[]'::jsonb) into v_conds
      from public.import_rows r join public.import_blocks b on b.id = r.block_id cross join lateral app_private.map_unit_condition(r.raw_agreement) m
     where r.id = any (uu.row_ids) and m.code is not null
       and (p_resolve = 'skip' or b.block_index = (select max(b2.block_index) from public.import_rows r2 join public.import_blocks b2 on b2.id = r2.block_id
                                                    cross join lateral app_private.map_unit_condition(r2.raw_agreement) m2 where r2.id = any (uu.row_ids) and m2.code is not null));
    v_n := jsonb_array_length(v_conds);
    if v_n = 0 then continue;
    elsif v_n > 1 then
      c_cond_skipped := c_cond_skipped + 1; v_issues := v_issues || jsonb_build_object('unit', uu.ucode, 'issue', 'condition_ambiguous'); continue;
    end if;
    v_cc := v_conds -> 0 ->> 'code'; v_cm := nullif(v_conds -> 0 ->> 'comment', '');
    select un.condition_code into v_cur_code from public.units un where un.id = v_unit;
    if v_cur_code is not null and v_cur_code is distinct from v_cc then
      c_cond_skipped := c_cond_skipped + 1; v_issues := v_issues || jsonb_build_object('unit', uu.ucode, 'issue', 'condition_differs'); continue;   -- no pisa una condición ya registrada
    end if;
    if v_cur_code is null then
      perform set_config('vip.source', 'import', true);
      begin
        update public.units set condition_code = v_cc, condition_comment = v_cm where id = v_unit;     -- sin fecha: no se inventa
        c_cond_set := c_cond_set + 1;
      exception when others then      -- p. ej. comment_required (22023) o una restricción: se informa y se omite, no se aborta el apply
        c_cond_skipped := c_cond_skipped + 1; v_issues := v_issues || jsonb_build_object('unit', uu.ucode, 'issue', 'condition_invalid', 'detail', sqlerrm);
      end;
    end if;
  end loop;

  update public.excel_imports set status = 'applied', applied_by = auth.uid(), applied_at = now(),
    summary = summary || jsonb_build_object('applied', jsonb_build_object('drivers_created', c_drivers_created, 'drivers_linked', c_drivers_linked,
      'units_created', c_units_created, 'assignments_created', c_asg_created, 'rates_created', c_rates_created, 'skipped', c_skipped,
      'rows_rejected', c_rejected, 'rows_excluded', c_excluded, 'resolved_by_latest_block', c_resolved, 'units_without_driver', c_units_no_driver, 'conditions_set', c_cond_set, 'conditions_skipped', c_cond_skipped, 'resolve', p_resolve, 'valid_from', v_from, 'issues', v_issues)) where id = p_import_id;
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
  c_rejected int := 0; c_excluded int := 0; v_issues jsonb := '[]'::jsonb; v_note text; v_changed boolean; v_new boolean; c_units_no_driver int := 0; c_cond_set int := 0; v_cond text;
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
        v_cond := nullif(btrim(r.unit_condition), '');
        if v_cond is not null then
          perform set_config('vip.source', 'import', true);
          if v_cond = 'none' then update public.units set condition_code = null, condition_comment = null, condition_since = null where id = v_unit and condition_code is not null;
          else update public.units set condition_code = v_cond, condition_comment = nullif(btrim(r.unit_condition_comment), '') where id = v_unit and (condition_code is distinct from v_cond or condition_comment is distinct from nullif(btrim(r.unit_condition_comment), '')); end if;
          c_cond_set := c_cond_set + 1;
        end if;
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

      v_cond := nullif(btrim(r.unit_condition), '');
      if v_cond is not null and v_unit is not null and coalesce(btrim(r.unit_code), '') <> '' then
        perform set_config('vip.source', 'import', true);
        if v_cond = 'none' then update public.units set condition_code = null, condition_comment = null, condition_since = null where id = v_unit and condition_code is not null;
        else update public.units set condition_code = v_cond, condition_comment = nullif(btrim(r.unit_condition_comment), '') where id = v_unit and (condition_code is distinct from v_cond or condition_comment is distinct from nullif(btrim(r.unit_condition_comment), '')); end if;
        c_cond_set := c_cond_set + 1;
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
      'rows_excluded', c_excluded, 'units_without_driver', c_units_no_driver, 'conditions_set', c_cond_set, 'valid_from', v_from, 'issues', v_issues)) where id = p_import_id;
  perform app_private.audit('apply_directory_import', 'excel_imports', p_import_id, jsonb_build_object('drivers_created', c_created, 'drivers_updated', c_updated,
    'units_created', c_units, 'assignments_created', c_asg, 'rates_created', c_rates, 'rates_changed', c_rate_changed));
  return (select summary -> 'applied' from public.excel_imports where id = p_import_id);
end $$;

revoke all on function public.set_unit_condition(uuid, text, text, date), public.apply_import(uuid, date, text, text), public.apply_directory_import(uuid, date, text, boolean) from public, anon, authenticated;
revoke all on function app_private.map_unit_condition(text), app_private.enforce_unit_condition(), app_private.record_unit_condition() from public, anon, authenticated;
grant execute on function public.set_unit_condition(uuid, text, text, date), public.apply_import(uuid, date, text, text), public.apply_directory_import(uuid, date, text, boolean) to authenticated, service_role;
grant execute on function app_private.map_unit_condition(text) to authenticated, service_role;

-- VIP · 0020 · Filas con unidad pero sin datos suficientes de conductor (operario o cédula faltantes).
-- Decisión del dueño: `missing_operator` / `missing_national_id` ya no son errores bloqueantes: son «Requiere revisión».
-- La unidad (`und`) sigue siendo obligatoria; una unidad puede existir SIN conductor. Si faltan datos para CREAR el conductor
-- (operator_code y national_id son not null unique; first_name not null) NO se inventa nada: se importa la unidad (con su acuerdo),
-- NO se crea conductor ni asignación (ni tarifa: pertenece a la asignación) y la fila conserva el motivo en `driver_review` + `applied_note`.
-- Un conductor ya existente identificado por el operario o la cédula presentes se concilia completando SOLO lo vacío con lo guardado (no se sobrescribe).
-- Una advertencia NUNCA autoriza datos inválidos: duplicados, conflictos, cédulas contradictorias y filas sin unidad siguen rechazándose como antes.
-- No destructiva: una columna nueva nullable y `create or replace` (misma firma, security definer, search_path vacío, mismos grants). No toca datos existentes.
-- Resultado JSON: se AGREGAN `drivers_pending_review` y `units_without_driver_created`; ninguna clave existente cambia.
set search_path = public, extensions;

alter table public.import_rows add column if not exists driver_review text[];   -- motivos (missing_operator|missing_national_id|missing_first_name) por los que el conductor quedó pendiente de revisión; null = sin pendiente
comment on column public.import_rows.driver_review is 'Conductor pendiente de revisión al aplicar: faltan datos obligatorios para crearlo. La unidad sí se importó.';

create or replace function public.apply_directory_import(p_import_id uuid, p_valid_from date default null, p_initial_status text default 'active',
  p_apply_rate_changes boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_imp record; v_from date; r record; v_drv uuid; v_unit uuid; v_asg uuid; v_asg_row record; v_status text; v_cur record;
  c_created int := 0; c_updated int := 0; c_unchanged int := 0; c_units int := 0; c_asg int := 0; c_rates int := 0; c_rate_changed int := 0;
  c_rejected int := 0; c_excluded int := 0; v_issues jsonb := '[]'::jsonb; v_note text; v_changed boolean; v_new boolean; c_units_no_driver int := 0; c_agr_set int := 0;
  v_cd public.drivers; v_ev text; v_cres jsonb; c_cons_granted int := 0; c_cons_withdrawn int := 0; c_cons_unchanged int := 0; c_cons_ignored int := 0; c_cons_jobs int := 0;
  v_ex public.drivers; v_reasons text[]; v_pending boolean; v_ucreated boolean; c_pending int := 0; c_units_wd_created int := 0;
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
      -- Identidad incompleta de un conductor YA EXISTENTE (identificado por el operario o la cédula presentes): se concilia completando SOLO lo vacío con lo guardado; nunca se sobrescribe.
      if r.match_status not in ('ignored', 'duplicate', 'conflict')
         and (coalesce(btrim(r.operator_code), '') = '' or coalesce(btrim(r.national_id), '') = '' or coalesce(btrim(r.first_name), '') = '')
         and (coalesce(btrim(r.operator_code), '') <> '' or coalesce(btrim(r.national_id), '') <> '') then
        select d.* into v_ex from public.drivers d
         where (coalesce(btrim(r.operator_code), '') <> '' and d.operator_code = btrim(r.operator_code)) or (coalesce(btrim(r.national_id), '') <> '' and d.national_id = btrim(r.national_id))
         order by (d.operator_code = btrim(r.operator_code)) desc limit 1;
        if found and (coalesce(btrim(r.operator_code), '') in ('', v_ex.operator_code)) and (coalesce(btrim(r.national_id), '') in ('', v_ex.national_id)) then
          r.operator_code := v_ex.operator_code; r.national_id := v_ex.national_id;
          if coalesce(btrim(r.first_name), '') = '' then r.first_name := v_ex.first_name; end if;
        end if;
      end if;
      if coalesce(btrim(r.unit_code), '') <> '' and r.match_status not in ('ignored', 'duplicate', 'conflict')
         and (coalesce(btrim(r.operator_code), '') = '' or coalesce(btrim(r.national_id), '') = '' or coalesce(btrim(r.first_name), '') = '') then
        -- UNIDAD sin datos suficientes para crear un conductor: el código de unidad es obligatorio y la unidad puede existir sin conductor.
        -- NO se crea conductor ni asignación (ni código, cédula o nombre inventados); si la fila traía datos de conductor, queda PENDIENTE DE REVISIÓN.
        v_reasons := array[]::text[];
        if coalesce(btrim(r.operator_code), '') = '' then v_reasons := array_append(v_reasons, 'missing_operator'::text); end if;
        if coalesce(btrim(r.national_id), '') = '' then v_reasons := array_append(v_reasons, 'missing_national_id'::text); end if;
        if coalesce(btrim(r.first_name), '') = '' then v_reasons := array_append(v_reasons, 'missing_first_name'::text); end if;
        v_pending := coalesce(btrim(r.operator_code), '') <> '' or coalesce(btrim(r.national_id), '') <> '' or coalesce(btrim(r.first_name), '') <> ''
                     or coalesce(btrim(r.last_name), '') <> '' or coalesce(btrim(r.phone_e164), '') <> '' or coalesce(btrim(r.row_status), '') <> '' or coalesce(r.daily_rate_cents, 0) > 0;
        select u.id into v_unit from public.units u where upper(u.code) = upper(btrim(r.unit_code));
        v_ucreated := v_unit is null;
        if v_ucreated then
          insert into public.units(code) values (btrim(r.unit_code)) returning id into v_unit; c_units := c_units + 1; c_units_no_driver := c_units_no_driver + 1; c_units_wd_created := c_units_wd_created + 1;
        end if;
        if app_private.apply_unit_agreement(v_unit, r.unit_agreement, r.unit_agreement_note) then c_agr_set := c_agr_set + 1; end if;
        if v_pending then
          c_pending := c_pending + 1;
          v_issues := v_issues || jsonb_build_object('operator', nullif(btrim(r.operator_code), ''), 'unit', btrim(r.unit_code), 'issue', 'driver_pending_review', 'reasons', to_jsonb(v_reasons));
          update public.import_rows set applied_action = 'linked', driver_review = v_reasons,
            applied_note = 'conductor pendiente de revisión: falta ' || array_to_string(array(select case x when 'missing_operator' then 'código de operario' when 'missing_national_id' then 'cédula' else 'nombre' end from unnest(v_reasons) x), ' y ')
              || ' (la unidad se importó; no se creó conductor ni asignación' || case when coalesce(r.daily_rate_cents, 0) > 0 then '; la tarifa no se aplicó' else '' end || ')'
           where id = r.id;
        else
          update public.import_rows set applied_action = 'linked', applied_note = 'unidad sin conductor' where id = r.id;
        end if;
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

      -- Consentimiento de WhatsApp (SOLO cobranza). El teléfono por sí solo NUNCA consiente: hace falta «SI» explícito + origen + teléfono válido.
      -- Se registra con la misma lógica que set_driver_consent (historial, auditoría y cancelación de envíos pendientes al retirar).
      if r.consent_request is not null then
        select * into v_cd from public.drivers where id = v_drv;
        v_ev := left(coalesce(nullif(btrim(r.consent_origin), ''), 'sin origen indicado'), 380) || ' | archivo: ' || left(v_imp.file_name, 100);
        if r.consent_request = 'grant' then
          if coalesce(btrim(r.consent_origin), '') = '' then
            c_cons_ignored := c_cons_ignored + 1; v_note := coalesce(v_note || '; ', '') || 'consentimiento ignorado: falta origen';
            v_issues := v_issues || jsonb_build_object('operator', r.operator_code, 'issue', 'consent_ignored_missing_origin');
          elsif v_cd.phone_e164 is null then
            c_cons_ignored := c_cons_ignored + 1; v_note := coalesce(v_note || '; ', '') || 'consentimiento ignorado: falta teléfono';
            v_issues := v_issues || jsonb_build_object('operator', r.operator_code, 'issue', 'consent_ignored_missing_phone');
          elsif v_cd.whatsapp_consent then c_cons_unchanged := c_cons_unchanged + 1;
          else
            perform public.set_driver_consent(v_drv, 'collection', true, 'import_declaration', v_ev); c_cons_granted := c_cons_granted + 1;
          end if;
        elsif v_cd.whatsapp_consent then
          v_cres := public.set_driver_consent(v_drv, 'collection', false, 'withdrawal', v_ev);
          c_cons_withdrawn := c_cons_withdrawn + 1; c_cons_jobs := c_cons_jobs + coalesce((v_cres ->> 'cancelled_jobs')::int, 0);
        else c_cons_unchanged := c_cons_unchanged + 1; end if;
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
      'rows_excluded', c_excluded, 'units_without_driver', c_units_no_driver, 'units_without_driver_created', c_units_wd_created, 'drivers_pending_review', c_pending, 'agreements_set', c_agr_set,
      'consents_granted', c_cons_granted, 'consents_withdrawn', c_cons_withdrawn, 'consents_unchanged', c_cons_unchanged, 'consents_ignored', c_cons_ignored, 'consent_jobs_cancelled', c_cons_jobs, 'valid_from', v_from, 'issues', v_issues)) where id = p_import_id;
  perform app_private.audit('apply_directory_import', 'excel_imports', p_import_id, jsonb_build_object('drivers_created', c_created, 'drivers_updated', c_updated,
    'units_created', c_units, 'assignments_created', c_asg, 'rates_created', c_rates, 'rates_changed', c_rate_changed,
    'consents_granted', c_cons_granted, 'consents_withdrawn', c_cons_withdrawn));
  return (select summary -> 'applied' from public.excel_imports where id = p_import_id);
end $$;

create or replace function public.apply_import(p_import_id uuid, p_valid_from date default null, p_initial_status text default 'active',
  p_resolve text default 'skip') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_phones text[]; v_phone text; v_curphone text; c_phones_set int := 0; c_phone_conflicts int := 0;
  v_imp record; v_from date; g record; v_drv uuid; v_unit uuid; v_asg uuid; v_existing_asg record; v_maxblock int;
  v_nid text[]; v_units text[]; v_rates bigint[]; v_name text; v_created_driver boolean; v_note text; v_action text;
  c_drivers_created int := 0; c_drivers_linked int := 0; c_units_created int := 0; c_asg_created int := 0; c_rates_created int := 0;
  c_skipped int := 0; c_rejected int := 0; c_excluded int := 0; c_resolved int := 0; v_issues jsonb := '[]'::jsonb;
  c_units_no_driver int := 0; c_agr_set int := 0; c_pending int := 0; c_units_wd_created int := 0; c_agr_skipped int := 0; uu record; v_n int; v_text text; v_cur text; v_maxb int;
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
      update public.import_rows set applied_action = 'skipped', driver_review = array['missing_national_id'],
          applied_note = 'conductor pendiente de revisión: falta cédula (no se crea el conductor; la unidad sí)' where id = any (g.row_ids);
      c_skipped := c_skipped + 1; c_pending := c_pending + 1; v_issues := v_issues || jsonb_build_object('operator', g.op, 'issue', 'driver_incomplete') || jsonb_build_object('operator', g.op, 'issue', 'driver_pending_review', 'reasons', jsonb_build_array('missing_national_id')); continue;
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
    -- WhatsApp de la columna opcional del bloque: un único número normalizado por conductor; si los bloques traen números distintos NO se adivina.
    select array_agg(distinct btrim(r.phone_e164)) filter (where btrim(r.phone_e164) ~ '^\+[1-9][0-9]{7,14}$') into v_phones from public.import_rows r where r.id = any (g.row_ids);
    v_phone := case when cardinality(v_phones) = 1 then v_phones[1] end;
    if cardinality(v_phones) > 1 then v_issues := v_issues || jsonb_build_object('operator', g.op, 'issue', 'phone_ambiguous'); end if;
    select r.full_name into v_name from public.import_rows r join public.import_blocks b on b.id = r.block_id
     where r.id = any (g.row_ids) and coalesce(btrim(r.full_name), '') <> '' group by r.full_name order by count(*) desc, max(b.block_index) desc limit 1;

    select d.id into v_drv from public.drivers d where d.operator_code = g.op or d.national_id = v_nid[1] order by (d.operator_code = g.op) desc limit 1;
    v_created_driver := false;
    if v_drv is null then
      insert into public.drivers(operator_code, national_id, first_name, last_name, phone_e164, status)
      values (g.op, v_nid[1], coalesce(nullif(btrim(v_name), ''), 'Sin nombre'), '', v_phone, p_initial_status) returning id into v_drv;
      if v_phone is not null then c_phones_set := c_phones_set + 1; end if;
      v_created_driver := true; c_drivers_created := c_drivers_created + 1;
    else
      if exists (select 1 from public.drivers where id = v_drv and (operator_code <> g.op or national_id <> v_nid[1])) then
        update public.import_rows set applied_action = 'skipped', applied_note = 'el operador y la cédula apuntan a conductores distintos' where id = any (g.row_ids);
        c_skipped := c_skipped + 1; v_issues := v_issues || jsonb_build_object('operator', g.op, 'issue', 'identity_conflict'); continue;
      end if;
      -- Conductor existente: el teléfono se completa SOLO si no tiene; si difiere NO se sobrescribe (phone_conflict). Nunca toca el consentimiento.
      select d.phone_e164 into v_curphone from public.drivers d where d.id = v_drv;
      if v_phone is not null then
        if v_curphone is null then update public.drivers set phone_e164 = v_phone where id = v_drv; c_phones_set := c_phones_set + 1;
        elsif v_curphone <> v_phone then
          c_phone_conflicts := c_phone_conflicts + 1;
          v_issues := v_issues || jsonb_build_object('operator', g.op, 'issue', 'phone_conflict', 'current', v_curphone, 'imported', v_phone);
        end if;
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

  -- Cédula sin código de operario: no se inventa el operario ni se crea el conductor; queda pendiente de revisión y la unidad sí se importa.
  with p as (
    update public.import_rows r set driver_review = array['missing_operator'],
        applied_note = 'conductor pendiente de revisión: falta código de operario (no se crea el conductor; la unidad sí)'
      from public.import_blocks b
     where b.id = r.block_id and b.import_id = p_import_id and r.review_status = 'approved' and r.applied_action is null
       and coalesce(btrim(r.operator_code), '') = '' and coalesce(btrim(r.national_id), '') <> '' and coalesce(btrim(r.unit_code), '') <> ''
    returning btrim(r.national_id) as nid)
  select count(distinct nid) into v_n from p;
  c_pending := c_pending + coalesce(v_n, 0);
  if coalesce(v_n, 0) > 0 then v_issues := v_issues || jsonb_build_object('issue', 'driver_pending_review', 'reasons', jsonb_build_array('missing_operator'), 'count', v_n); end if;

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
      if not exists (select 1 from public.assignments a where a.unit_id = v_unit) then c_units_no_driver := c_units_no_driver + 1; c_units_wd_created := c_units_wd_created + 1; end if;
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
      'rows_rejected', c_rejected, 'rows_excluded', c_excluded, 'resolved_by_latest_block', c_resolved, 'units_without_driver', c_units_no_driver, 'units_without_driver_created', c_units_wd_created, 'drivers_pending_review', c_pending, 'agreements_set', c_agr_set, 'agreements_skipped', c_agr_skipped, 'phones_set', c_phones_set, 'phone_conflicts', c_phone_conflicts, 'resolve', p_resolve, 'valid_from', v_from, 'issues', v_issues)) where id = p_import_id;
  perform app_private.audit('apply_import', 'excel_imports', p_import_id, jsonb_build_object('drivers_created', c_drivers_created, 'drivers_linked', c_drivers_linked,
    'units_created', c_units_created, 'assignments_created', c_asg_created, 'rates_created', c_rates_created, 'resolve', p_resolve));
  return (select summary -> 'applied' from public.excel_imports where id = p_import_id);
end $$;

revoke all on function public.apply_import(uuid, date, text, text), public.apply_directory_import(uuid, date, text, boolean) from public, anon, authenticated;
grant execute on function public.apply_import(uuid, date, text, text), public.apply_directory_import(uuid, date, text, boolean) to authenticated, service_role;

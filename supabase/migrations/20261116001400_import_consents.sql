-- VIP · 0014 · Importación del Excel con consentimiento de WhatsApp (cobranza) seguro.
-- Reglas: un teléfono NO prueba autorización. Solo «SI» explícito + origen + teléfono E.164 registra el consentimiento (source 'import_declaration',
-- evidence = origen + archivo, recorded_by = quien aplica). «NO» explícito lo retira (source 'withdrawal') y cancela envíos pendientes. Vacío = sin cambio.
-- Solo finalidad de cobranza: el consentimiento promocional NO se importa. Nunca se crean cuentas de Auth ni se tocan pagos.
set search_path = public, extensions;

alter table public.import_rows
  add column consent_request text check (consent_request in ('grant', 'withdraw')),   -- null = sin cambio / ignorado en el análisis
  add column consent_origin text check (length(consent_origin) <= 2000);

create or replace function public.apply_directory_import(p_import_id uuid, p_valid_from date default null, p_initial_status text default 'active',
  p_apply_rate_changes boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_imp record; v_from date; r record; v_drv uuid; v_unit uuid; v_asg uuid; v_asg_row record; v_status text; v_cur record;
  c_created int := 0; c_updated int := 0; c_unchanged int := 0; c_units int := 0; c_asg int := 0; c_rates int := 0; c_rate_changed int := 0;
  c_rejected int := 0; c_excluded int := 0; v_issues jsonb := '[]'::jsonb; v_note text; v_changed boolean; v_new boolean; c_units_no_driver int := 0; c_agr_set int := 0;
  v_cd public.drivers; v_ev text; v_cres jsonb; c_cons_granted int := 0; c_cons_withdrawn int := 0; c_cons_unchanged int := 0; c_cons_ignored int := 0; c_cons_jobs int := 0;
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
      'rows_excluded', c_excluded, 'units_without_driver', c_units_no_driver, 'agreements_set', c_agr_set,
      'consents_granted', c_cons_granted, 'consents_withdrawn', c_cons_withdrawn, 'consents_unchanged', c_cons_unchanged, 'consents_ignored', c_cons_ignored, 'consent_jobs_cancelled', c_cons_jobs, 'valid_from', v_from, 'issues', v_issues)) where id = p_import_id;
  perform app_private.audit('apply_directory_import', 'excel_imports', p_import_id, jsonb_build_object('drivers_created', c_created, 'drivers_updated', c_updated,
    'units_created', c_units, 'assignments_created', c_asg, 'rates_created', c_rates, 'rates_changed', c_rate_changed,
    'consents_granted', c_cons_granted, 'consents_withdrawn', c_cons_withdrawn));
  return (select summary -> 'applied' from public.excel_imports where id = p_import_id);
end $$;

revoke all on function public.apply_directory_import(uuid, date, text, boolean) from public, anon, authenticated;
grant execute on function public.apply_directory_import(uuid, date, text, boolean) to authenticated, service_role;

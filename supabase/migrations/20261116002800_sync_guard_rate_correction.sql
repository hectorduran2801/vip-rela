-- VIP · 0028 · Excel como fuente única: protección contra importaciones antiguas, corrección de cuota vs cambio contractual, conflictos de identidad,
-- reasignación con varias unidades por operario, trazabilidad de lotes de mensajes y fin de los avisos de crédito automáticos.
-- Aditiva: tablas nuevas, funciones nuevas o reemplazadas y disparadores; no borra ni modifica filas existentes. La función app_private.collection_sync
-- (cuerpo en 0026) se vuelve a crear con `create or replace` para: conflictos de identidad, contador de unidades con cambios y corrección de cuota.
-- Reversible: drop de los objetos nuevos y restablecer rates_history_guard / reassign_unit / apply_collection_sync de 0021 / 0026.
set search_path = public, extensions;

-- ───────── 1. Nombres: ¿son la misma persona? ─────────
create function app_private.name_tokens(p_name text) returns text[]
language sql immutable set search_path = '' as $$
  select coalesce(array_agg(distinct t), '{}') from unnest(regexp_split_to_array(
    lower(translate(btrim(coalesce(p_name, '')), 'áéíóúüñÁÉÍÓÚÜÑ', 'aeiouunAEIOUUN')), '[^a-z0-9]+')) t where t <> ''
$$;
revoke all on function app_private.name_tokens(text) from public, anon, authenticated;
grant execute on function app_private.name_tokens(text) to authenticated, service_role;

-- ───────── 2. Corrección de cuota ≠ cambio contractual ─────────
-- Corrección: la cuota se escribió mal (la vigente nació en la semana que se importa): se corrige EN SU LUGAR, queda en rate_corrections y en auditoría, y lo ya generado se
-- ajusta con ajustes (no se reescriben cargos ni se tocan pagos). Cambio contractual: change_rate (rige hacia adelante, historial de 0021).
create table public.rate_corrections (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references public.assignments(id),
  rate_id uuid not null references public.rates(id),
  previous_daily_cents bigint not null, new_daily_cents bigint not null,
  week_start date not null, import_id uuid references public.excel_imports(id) on delete set null,
  adjusted_charges int not null default 0, adjusted_cents bigint not null default 0,
  created_by uuid references public.profiles(id), created_at timestamptz not null default now()
);
alter table public.rate_corrections enable row level security;
grant select on public.rate_corrections to authenticated; grant all on public.rate_corrections to service_role;
create policy rate_corrections_select on public.rate_corrections for select to authenticated using (app_private.is_admin());

create or replace function app_private.rates_history_guard() returns trigger language plpgsql as $$
begin
  if coalesce(current_setting('vip.rate_correction', true), '') = 'on'
     and (new.assignment_id, new.weekdays, new.valid_from) is not distinct from (old.assignment_id, old.weekdays, old.valid_from) then
    return new;                                                  -- solo corrección de importe, abierta por app_private.correct_rate (que la registra)
  end if;
  if (new.assignment_id, new.daily_amount_cents, new.weekdays, new.valid_from) is distinct from (old.assignment_id, old.daily_amount_cents, old.weekdays, old.valid_from) then
    raise exception 'rate_history_immutable' using errcode = '42501';
  end if;
  return new;
end $$;

create function app_private.correct_rate(p_asg uuid, p_new bigint, p_week date, p_import uuid, p_row uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare cur public.rates; c record; v_corr bigint; v_eff bigint; v_delta bigint; v_adj uuid; v_n int := 0; v_sum bigint := 0;
begin
  select * into cur from public.rates where assignment_id = p_asg and valid_to is null for update;
  if not found then raise exception 'rate_not_found' using errcode = 'P0002'; end if;
  if cur.daily_amount_cents = p_new then return; end if;
  perform set_config('vip.rate_correction', 'on', true);
  update public.rates set daily_amount_cents = p_new where id = cur.id;
  perform set_config('vip.rate_correction', '', true);
  for c in select ch.* from public.charges ch where ch.assignment_id = p_asg and ch.kind = 'daily' and ch.charge_date >= cur.valid_from order by ch.charge_date loop
    select coalesce(sum(a.amount_cents), 0) into v_corr from public.adjustments a where a.idempotency_key like 'excel-ratecorr:' || c.id || ':%';
    v_eff := c.amount_cents + v_corr;                              -- lo que hoy vale esa cuota (original + correcciones previas)
    if v_eff <> cur.daily_amount_cents then continue; end if;      -- excepciones de fecha u otros montos: no se tocan
    v_delta := p_new - v_eff;
    v_adj := null;
    insert into public.adjustments(assignment_id, effective_date, amount_cents, reason, idempotency_key, created_by)
    values (p_asg, c.charge_date, v_delta, 'Corrección de cuota del Excel (semana ' || p_week || '): ' || app_private.fmt_usd(cur.daily_amount_cents) || ' → ' || app_private.fmt_usd(p_new),
            'excel-ratecorr:' || c.id || ':' || cur.daily_amount_cents || '>' || p_new, auth.uid())
    on conflict (idempotency_key) do nothing returning id into v_adj;
    if v_adj is not null then
      if v_delta > 0 then
        insert into public.charges(assignment_id, kind, charge_date, amount_cents, week_start, adjustment_id, source_import_id, source_row_id)
        values (p_asg, 'adjustment', c.charge_date, v_delta, c.week_start, v_adj, p_import, p_row);
      end if;
      v_n := v_n + 1; v_sum := v_sum + v_delta;
    end if;
  end loop;
  insert into public.rate_corrections(assignment_id, rate_id, previous_daily_cents, new_daily_cents, week_start, import_id, adjusted_charges, adjusted_cents, created_by)
  values (p_asg, cur.id, cur.daily_amount_cents, p_new, p_week, p_import, v_n, v_sum, auth.uid());
  perform app_private.audit('collection_sync_rate_correction', 'assignments', p_asg, jsonb_build_object('rate_id', cur.id, 'previous_daily_cents', cur.daily_amount_cents,
    'new_daily_cents', p_new, 'week_start', p_week, 'import_id', p_import, 'adjusted_charges', v_n, 'adjusted_cents', v_sum));
end $$;
revoke all on function app_private.correct_rate(uuid, bigint, date, uuid, uuid) from public, anon, authenticated;
grant execute on function app_private.correct_rate(uuid, bigint, date, uuid, uuid) to authenticated, service_role;

-- ───────── 3. Protección contra importaciones antiguas ─────────
-- La fecha de referencia es la SEMANA que indica quien importa (el Excel no trae fecha fiable; la fecha de modificación del archivo no se usa).
-- Se compara contra las aplicaciones anteriores registradas en collection_sync_runs.
create table public.collection_sync_runs (
  id uuid primary key default gen_random_uuid(),
  import_id uuid not null references public.excel_imports(id),
  week_start date not null,
  applied_by uuid references public.profiles(id), applied_at timestamptz not null default now(),
  historical boolean not null default false, historical_reasons text[] not null default '{}', note text,
  already_up_to_date boolean not null default false
);
create index collection_sync_runs_week on public.collection_sync_runs(week_start, applied_at desc);
alter table public.collection_sync_runs enable row level security;
grant select on public.collection_sync_runs to authenticated; grant all on public.collection_sync_runs to service_role;
create policy collection_sync_runs_select on public.collection_sync_runs for select to authenticated using (app_private.is_admin());

create function app_private.collection_sync_guard(p_import uuid, p_week date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_imp record; v_latest date; v_reasons text[] := '{}'; v_prior jsonb; v_who text; v_last record;
begin
  select i.file_name, i.file_sha256, i.created_at, i.created_by into v_imp from public.excel_imports i where i.id = p_import;
  select max(r.week_start) into v_latest from public.collection_sync_runs r where r.import_id <> p_import;
  if v_latest is not null and p_week < v_latest then v_reasons := v_reasons || array['older_week']; end if;
  if exists (select 1 from public.collection_sync_runs r join public.excel_imports i2 on i2.id = r.import_id
              where r.week_start = p_week and r.import_id <> p_import and i2.created_at > v_imp.created_at) then v_reasons := v_reasons || array['older_file_for_week']; end if;
  select coalesce(jsonb_agg(jsonb_build_object('weekStart', r.week_start, 'appliedAt', r.applied_at, 'appliedBy', coalesce(nullif(p.full_name, ''), p.email)) order by r.applied_at desc), '[]'::jsonb)
    into v_prior from public.collection_sync_runs r left join public.profiles p on p.id = r.applied_by where r.import_id = p_import;
  select coalesce(nullif(p.full_name, ''), p.email) into v_who from public.profiles p where p.id = v_imp.created_by;
  select r.week_start, r.applied_at, i2.file_name into v_last from public.collection_sync_runs r join public.excel_imports i2 on i2.id = r.import_id
   where r.import_id <> p_import order by r.applied_at desc limit 1;
  return jsonb_build_object('historical', cardinality(v_reasons) > 0, 'reasons', to_jsonb(v_reasons), 'latestWeek', v_latest,
    'lastRun', case when v_last.applied_at is null then null else jsonb_build_object('weekStart', v_last.week_start, 'appliedAt', v_last.applied_at, 'fileName', v_last.file_name) end,
    'import', jsonb_build_object('fileName', v_imp.file_name, 'sha256', v_imp.file_sha256, 'uploadedAt', v_imp.created_at, 'uploadedBy', v_who), 'priorRuns', v_prior);
end $$;
revoke all on function app_private.collection_sync_guard(uuid, date) from public, anon, authenticated;
grant execute on function app_private.collection_sync_guard(uuid, date) to authenticated, service_role;

create or replace function public.preview_collection_sync(p_import uuid, p_week_start date) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.assert_admin();
  return app_private.collection_sync(p_import, p_week_start, false, null) || jsonb_build_object('guard', app_private.collection_sync_guard(p_import, p_week_start));
end $$;

drop function public.apply_collection_sync(uuid, date, text);
create function public.apply_collection_sync(p_import uuid, p_week_start date, p_note text default null, p_confirm_historical boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare g jsonb; v_out jsonb;
begin
  perform app_private.assert_admin();
  g := app_private.collection_sync_guard(p_import, p_week_start);
  if (g ->> 'historical')::boolean and not (coalesce(p_confirm_historical, false) and length(btrim(coalesce(p_note, ''))) >= 3) then
    raise exception 'historical_import_requires_confirmation' using errcode = '22023', detail = g::text;
  end if;
  v_out := app_private.collection_sync(p_import, p_week_start, true, p_note);
  insert into public.collection_sync_runs(import_id, week_start, applied_by, historical, historical_reasons, note, already_up_to_date)
  values (p_import, p_week_start, auth.uid(), (g ->> 'historical')::boolean, array(select jsonb_array_elements_text(g -> 'reasons')), nullif(btrim(p_note), ''), coalesce((v_out ->> 'already_up_to_date')::boolean, false));
  if (g ->> 'historical')::boolean then
    perform app_private.audit('collection_sync_historical', 'excel_imports', p_import, jsonb_build_object('week_start', p_week_start, 'reasons', g -> 'reasons', 'note', nullif(btrim(p_note), '')));
  end if;
  return v_out || jsonb_build_object('guard', g);
end $$;
revoke all on function public.apply_collection_sync(uuid, date, text, boolean) from public, anon, authenticated;
grant execute on function public.apply_collection_sync(uuid, date, text, boolean) to authenticated, service_role;

-- ───────── 4. Sin avisos de crédito automáticos (el flujo es manual) ─────────
-- Los borradores existentes se conservan; solo se impide crear nuevos (register_payment los generaba también desde la importación).
create function app_private.skip_credit_notice() returns trigger language plpgsql as $$
begin
  if new.kind = 'credit_notice' then return null; end if;
  return new;
end $$;
create trigger skip_credit_notice before insert on public.notification_jobs for each row execute function app_private.skip_credit_notice();

-- ───────── 5. Un operario puede tener varias unidades (como permite el Excel) ─────────
create or replace function public.reassign_unit(p_unit_id uuid, p_new_driver_id uuid, p_valid_from date, p_daily_cents bigint default null, p_agreement_note text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare cur record;
begin
  perform app_private.assert_admin();
  select * into cur from public.assignments where unit_id = p_unit_id and valid_to is null for update;
  if found then
    if p_valid_from <= cur.valid_from then raise exception 'invalid_dates' using errcode = '22023'; end if;
    if exists (select 1 from public.charges c where c.assignment_id = cur.id and c.kind = 'daily' and c.charge_date >= p_valid_from) then
      raise exception 'assignment_change_retroactive' using errcode = '22023', hint = 'La asignación anterior ya tiene cuotas desde esa fecha; elige una fecha posterior.'; end if;
    update public.assignments set valid_to = p_valid_from - 1 where id = cur.id;
    update public.rates set valid_to = p_valid_from - 1 where assignment_id = cur.id and valid_to is null;
  end if;
  return public.start_assignment(p_new_driver_id, p_unit_id, p_valid_from, p_daily_cents, p_agreement_note);
end $$;

-- ───────── 6. Lotes de envío y control diario ─────────
alter table public.whatsapp_test_messages add column batch_id text;
create index whatsapp_test_messages_batch on public.whatsapp_test_messages(batch_id) where batch_id is not null;
create function app_private.stamp_batch() returns trigger language plpgsql as $$
begin
  if new.kind = 'collection_message' and new.batch_id is null and position(':' in new.idempotency_key) > 0 then new.batch_id := split_part(new.idempotency_key, ':', 1); end if;
  return new;
end $$;
create trigger stamp_batch before insert on public.whatsapp_test_messages for each row execute function app_private.stamp_batch();

drop function public.collection_message_summary();
create function public.collection_message_summary() returns table (driver_id uuid, assignment_id uuid, template_name text, status text, created_at timestamptz, sent_today int, templates_today text[], body text, message_id uuid)
language plpgsql stable security definer set search_path = '' as $$
declare v_today date := (now() at time zone app_private.tz())::date;
begin
  perform app_private.assert_admin();
  return query
  select l.driver_id, l.assignment_id, l.template_name, l.status, l.created_at,
         (select count(*)::int from public.whatsapp_test_messages x where x.kind = 'collection_message' and x.assignment_id = l.assignment_id
             and x.status in ('prepared', 'processing', 'sent', 'delivered', 'simulated', 'unconfirmed') and (x.created_at at time zone app_private.tz())::date = v_today),
         array(select distinct x.template_name from public.whatsapp_test_messages x where x.kind = 'collection_message' and x.assignment_id = l.assignment_id
             and x.status in ('prepared', 'processing', 'sent', 'delivered', 'simulated', 'unconfirmed') and (x.created_at at time zone app_private.tz())::date = v_today and x.template_name is not null),
         l.body, l.id
    from (select distinct on (m.assignment_id) m.id, m.driver_id, m.assignment_id, m.template_name, m.status, m.created_at, m.body from public.whatsapp_test_messages m
           where m.kind = 'collection_message' and m.assignment_id is not null order by m.assignment_id, m.created_at desc) l;
end $$;
revoke all on function public.collection_message_summary() from public, anon, authenticated;
grant execute on function public.collection_message_summary() to authenticated, service_role;

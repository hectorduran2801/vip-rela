-- 0035 · Horarios de envío: «a esta hora, esta plantilla, a esta audiencia»
-- Sustituye el uso de los horarios heredados (notification_schedules, que quedan intactos y desactivados). Un horario crea los mensajes con
-- EXACTAMENTE el mismo método que Cobranza (public.create_collection_message): mismas validaciones, mismas variables del Excel, prevención de
-- duplicados por (conductor, plantilla, día) y el mismo modo simulado/real del worker. Cada ejecución es única por horario y día.
-- El worker solo los ejecuta con AUTOMATIC_REMINDERS=true; si no, quedan guardados sin hacer nada.

create table public.send_schedules (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (length(btrim(name)) between 1 and 80),
  local_time time not null,
  weekdays smallint[] not null default '{1,2,3,4,5,6,7}' check (weekdays <@ array[1,2,3,4,5,6,7]::smallint[] and cardinality(weekdays) > 0),
  template_id uuid references public.message_templates(id) on delete set null,
  audience text not null default 'all' check (audience in ('all', 'with_balance', 'without_balance', 'not_paid_today', 'paid_today')),
  enabled boolean not null default false,
  armed_by uuid references public.profiles(id) on delete set null,        -- quién lo activó: los mensajes salen autorizados por esa persona
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.send_schedule_runs (
  schedule_id uuid not null references public.send_schedules(id) on delete cascade,
  local_date date not null,
  ran_at timestamptz not null default now(),
  status text not null check (status in ('running', 'done', 'missed', 'error')),
  total int not null default 0, created int not null default 0,
  skipped jsonb not null default '{}'::jsonb,                                 -- motivo → cantidad (sin teléfono, ya enviado hoy, sin saldo en el Excel…)
  primary key (schedule_id, local_date)
);
alter table public.send_schedules enable row level security;
alter table public.send_schedule_runs enable row level security;
revoke all on public.send_schedules, public.send_schedule_runs from anon, authenticated;   -- solo por las funciones de abajo

-- Un horario nunca queda activo sin plantilla; si se le quita la plantilla, se desactiva solo.
create function app_private.guard_send_schedule() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' and old.template_id is not null and new.template_id is null then new.enabled := false; end if;
  if new.enabled and new.template_id is null then
    raise exception 'template_required' using errcode = '23514', detail = 'Un horario activo necesita una plantilla de mensaje asignada.';
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger guard before insert or update on public.send_schedules for each row execute function app_private.guard_send_schedule();

-- ───────── Audiencias ─────────
-- Solo con datos del Excel: SALDO (último válido) y pagos diarios importados. «Atrasado» = SALDO > 0; «no pagó hoy» solo para unidades gestionadas por el Excel.
create function app_private.send_schedule_audience(p_audience text, p_date date)
returns table (assignment_id uuid, driver_id uuid, saldo_cents bigint, managed boolean, paid_today_cents bigint)
language sql stable security definer set search_path = '' as $$
  select x.id, x.driver_id, x.saldo, x.managed, x.paid from (
    select a.id, a.driver_id, e.saldo_cents as saldo, e.managed,
           coalesce((select sum(p.amount_cents) from public.excel_payment_days p where p.assignment_id = a.id and p.pay_date = p_date), 0)::bigint as paid
      from public.assignments a join public.drivers d on d.id = a.driver_id
      cross join lateral app_private.excel_saldo(a.id) e
     where a.valid_from <= p_date and (a.valid_to is null or a.valid_to > p_date) and d.status = 'active' and d.phone_e164 is not null) x
  where case p_audience
    when 'all' then true
    when 'with_balance' then coalesce(x.saldo, 0) > 0
    when 'without_balance' then x.saldo is not null and x.saldo <= 0
    when 'not_paid_today' then x.managed and x.paid = 0
    when 'paid_today' then x.managed and x.paid > 0
    else false end
$$;
revoke all on function app_private.send_schedule_audience(text, date) from public, anon, authenticated;
grant execute on function app_private.send_schedule_audience(text, date) to service_role;

create function public.send_schedule_audience_count(p_audience text, p_date date default null) returns int
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app_private.assert_admin();
  if p_audience not in ('all', 'with_balance', 'without_balance', 'not_paid_today', 'paid_today') then raise exception 'invalid_audience' using errcode = '22023'; end if;
  return (select count(*)::int from app_private.send_schedule_audience(p_audience, coalesce(p_date, (now() at time zone app_private.tz())::date)));
end $$;

-- ───────── CRUD (solo ADMIN+) ─────────
create function public.list_send_schedules() returns table (id uuid, name text, local_time time, weekdays smallint[], template_id uuid, template_name text, audience text, enabled boolean,
  last_run_date date, last_run_status text, last_run_created int, last_run_total int)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app_private.assert_admin();
  return query select s.id, s.name, s.local_time, s.weekdays, s.template_id, t.name, s.audience, s.enabled, r.local_date, r.status, r.created, r.total
    from public.send_schedules s left join public.message_templates t on t.id = s.template_id
    left join lateral (select x.* from public.send_schedule_runs x where x.schedule_id = s.id order by x.local_date desc limit 1) r on true
    order by s.local_time, s.name;
end $$;

create function public.save_send_schedule(p_id uuid, p_name text, p_local_time time, p_weekdays smallint[], p_template uuid, p_audience text, p_enabled boolean)
returns public.send_schedules language plpgsql security definer set search_path = '' as $$
declare r public.send_schedules; v_old public.send_schedules;
begin
  perform app_private.assert_admin();
  if p_template is not null and not exists (select 1 from public.message_templates t where t.id = p_template) then raise exception 'template_not_found' using errcode = 'P0002'; end if;
  if coalesce(p_enabled, false) and p_template is null then
    raise exception 'template_required' using errcode = '23514', detail = 'Un horario activo necesita una plantilla de mensaje asignada.';
  end if;
  if p_id is null then
    insert into public.send_schedules(name, local_time, weekdays, template_id, audience, enabled, armed_by)
      values (btrim(p_name), p_local_time, p_weekdays, p_template, p_audience, coalesce(p_enabled, false), case when coalesce(p_enabled, false) then auth.uid() end) returning * into r;
  else
    select * into v_old from public.send_schedules where id = p_id for update;
    if not found then raise exception 'schedule_not_found' using errcode = 'P0002'; end if;
    update public.send_schedules set name = btrim(p_name), local_time = p_local_time, weekdays = p_weekdays, template_id = p_template, audience = p_audience, enabled = coalesce(p_enabled, false),
           armed_by = case when coalesce(p_enabled, false) then (case when v_old.enabled then v_old.armed_by else auth.uid() end) else null end
     where id = p_id returning * into r;
  end if;
  perform app_private.audit('send_schedule.saved', 'send_schedules', r.id, jsonb_build_object('name', r.name, 'time', r.local_time, 'audience', r.audience, 'enabled', r.enabled, 'template_id', r.template_id));
  return r;
end $$;

create function public.delete_send_schedule(p_id uuid) returns void language plpgsql security definer set search_path = '' as $$
declare v_name text;
begin
  perform app_private.assert_admin();
  delete from public.send_schedules where id = p_id returning name into v_name;
  if v_name is null then raise exception 'schedule_not_found' using errcode = 'P0002'; end if;
  perform app_private.audit('send_schedule.deleted', 'send_schedules', p_id, jsonb_build_object('name', v_name));
end $$;
revoke all on function public.send_schedule_audience_count(text, date), public.list_send_schedules(),
  public.save_send_schedule(uuid, text, time, smallint[], uuid, text, boolean), public.delete_send_schedule(uuid) from public, anon, authenticated;
grant execute on function public.send_schedule_audience_count(text, date), public.list_send_schedules(),
  public.save_send_schedule(uuid, text, time, smallint[], uuid, text, boolean), public.delete_send_schedule(uuid) to authenticated, service_role;

-- ───────── Plantillas en uso: ahora por estos horarios ─────────
create or replace function app_private.guard_template_delete() returns trigger language plpgsql security definer set search_path = '' as $$
declare v_labels text;
begin
  select string_agg(s.name, ', ' order by s.local_time, s.name) into v_labels from public.send_schedules s where s.template_id = old.id;
  if v_labels is not null then
    raise exception 'template_in_use' using errcode = '23503', detail = 'La plantilla está asignada a: ' || v_labels || '.',
      hint = 'Quítala de esos horarios (quedan desactivados) o asígnales otra plantilla antes de eliminarla.';
  end if;
  return old;
end $$;
create or replace function public.template_usage(p_template uuid)
returns table (id uuid, kind text, label text, local_time time, weekdays smallint[], enabled boolean)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app_private.assert_admin();
  if not exists (select 1 from public.message_templates t where t.id = p_template) then raise exception 'template_not_found' using errcode = 'P0002'; end if;
  return query select s.id, 'broadcast'::text, s.name, s.local_time, s.weekdays, s.enabled from public.send_schedules s where s.template_id = p_template order by s.local_time, s.name;
end $$;

-- ───────── Ejecución (worker; solo con recordatorios automáticos activados) ─────────
alter table public.whatsapp_sessions add column worker_automatic boolean;      -- lo informa el worker en cada latido

create function public.run_send_schedules(p_now timestamptz default now()) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s record; a record; v_tz text := app_private.tz(); v_local timestamp := p_now at time zone app_private.tz(); v_date date := (p_now at time zone app_private.tz())::date;
  v_due timestamptz; v_claims text := current_setting('request.jwt.claims', true); v_created int; v_total int; v_skip jsonb; v_reason text; v_ran jsonb := '[]'::jsonb;
  v_grace interval := interval '3 hours'; v_ins int;
begin
  if not app_private.is_service() then raise exception 'forbidden' using errcode = '42501'; end if;
  for s in select * from public.send_schedules where enabled and template_id is not null order by local_time loop
    if not (extract(isodow from v_local)::smallint = any (s.weekdays)) then continue; end if;
    v_due := (v_date + s.local_time) at time zone v_tz;
    if v_due > p_now then continue; end if;
    insert into public.send_schedule_runs(schedule_id, local_date, status) values (s.id, v_date, case when p_now - v_due > v_grace then 'missed' else 'running' end) on conflict do nothing;
    get diagnostics v_ins = row_count;
    if v_ins = 0 then continue; end if;                                                    -- ya se ejecutó (o se dio por perdido) hoy
    if p_now - v_due > v_grace then continue; end if;                                      -- el worker estuvo apagado más de 3 h: no se envía a deshoras
    if s.armed_by is null then
      update public.send_schedule_runs set status = 'error', skipped = '{"sin_autorizacion": 1}' where schedule_id = s.id and local_date = v_date; continue;
    end if;
    perform set_config('request.jwt.claims', jsonb_build_object('sub', s.armed_by, 'role', 'authenticated')::text, true);     -- los mensajes salen autorizados por quien activó el horario
    v_created := 0; v_total := 0; v_skip := '{}'::jsonb;
    for a in select * from app_private.send_schedule_audience(s.audience, v_date) loop
      v_total := v_total + 1;
      begin
        perform public.create_collection_message(a.assignment_id, s.template_id, 'sched:' || s.id || ':' || v_date || ':' || a.assignment_id, false);
        v_created := v_created + 1;
      exception when others then
        v_reason := sqlerrm;
        v_skip := jsonb_set(v_skip, array[v_reason], to_jsonb(coalesce((v_skip ->> v_reason)::int, 0) + 1));
      end;
    end loop;
    perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
    update public.send_schedule_runs set status = 'done', total = v_total, created = v_created, skipped = v_skip where schedule_id = s.id and local_date = v_date;
    insert into public.audit_logs(actor, action, entity, entity_id, detail)
      values (s.armed_by, 'send_schedule.ran', 'send_schedules', s.id, jsonb_build_object('name', s.name, 'date', v_date, 'audience', s.audience, 'total', v_total, 'created', v_created, 'skipped', v_skip));
    v_ran := v_ran || jsonb_build_object('schedule', s.name, 'total', v_total, 'created', v_created);
  end loop;
  perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
  return v_ran;
end $$;
revoke all on function public.run_send_schedules(timestamptz) from public, anon, authenticated;
grant execute on function public.run_send_schedules(timestamptz) to service_role;

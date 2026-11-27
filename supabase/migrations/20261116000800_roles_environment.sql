-- VIP · 0008 · Roles internos (SUPER_ADMIN, ADMIN, SUPERVISOR) SIN organizaciones, y marcador de entorno.
-- Los conductores NO son usuarios: son registros del CRM. Esta migración no crea cuentas de Auth.
--
-- Matriz de permisos (propuesta, ajustable):
--   SUPER_ADMIN : todo + gestión de usuarios/roles, métodos de pago, configuración.
--   ADMIN       : operación completa (conductores, unidades, asignaciones, tarifas, pagos, anulaciones, ajustes, cierres,
--                 importación, recordatorios, WhatsApp). No gestiona usuarios, métodos de pago ni configuración.
--   SUPERVISOR  : lectura de todo + registrar pagos. No anula, ajusta, cierra, importa ni edita datos maestros.
set search_path = public, extensions;

create type public.app_role as enum ('super_admin', 'admin', 'supervisor');

create table public.app_users (
  user_id uuid primary key references public.profiles(id) on delete restrict,
  role public.app_role not null,
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(id)
);

-- La cuenta ya autorizada (instancia única anterior) pasa a SUPER_ADMIN.
insert into public.app_users(user_id, role) select user_id, 'super_admin' from public.app_admins;
drop function public.authorize_admin(uuid);
drop function app_private.block_signups() cascade;
drop function public.is_authorized();
drop function app_private.is_admin() cascade;
drop table public.app_admins;

alter table public.app_settings
  add column environment text not null default 'development' check (environment in ('development', 'production')),
  add column user_creation_open_until timestamptz;           -- ventana temporal para crear usuarios en Auth (cerrada por defecto)

-- ───────── Autorización por rol ─────────
create function app_private.current_role() returns public.app_role
language sql stable security definer set search_path = '' as $$ select u.role from public.app_users u where u.user_id = auth.uid() $$;
create function app_private.is_staff() returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.app_users u where u.user_id = auth.uid()) $$;
-- «admin» = SUPER_ADMIN o ADMIN (operación completa)
create function app_private.is_admin() returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.app_users u where u.user_id = auth.uid() and u.role in ('super_admin', 'admin')) $$;
create function app_private.is_super() returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.app_users u where u.user_id = auth.uid() and u.role = 'super_admin') $$;

create or replace function app_private.assert_admin() returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if not app_private.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
end $$;
create function app_private.assert_staff() returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if not app_private.is_staff() then raise exception 'forbidden' using errcode = '42501'; end if;
end $$;
create function app_private.assert_super() returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if not app_private.is_super() then raise exception 'forbidden' using errcode = '42501'; end if;
end $$;

-- ¿Puede esta cuenta usar VIP? (cualquier rol) y ¿con qué rol?
create function public.is_authorized() returns boolean language sql stable security definer set search_path = '' as $$ select app_private.is_staff() $$;
create function public.current_app_role() returns text language sql stable security definer set search_path = '' as $$ select app_private.current_role()::text $$;

-- Primer SUPER_ADMIN (solo servidor / administración de base de datos).
create function public.authorize_admin(p_user_id uuid) returns void language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.profiles where id = p_user_id) then raise exception 'user_not_found' using errcode = 'P0002'; end if;
  insert into public.app_users(user_id, role) values (p_user_id, 'super_admin') on conflict (user_id) do update set role = 'super_admin';
end $$;

-- ───────── Gestión de usuarios (solo SUPER_ADMIN; la cuenta debe existir ya en Supabase Auth) ─────────
create function public.list_app_users() returns table (user_id uuid, email text, full_name text, role text, created_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app_private.assert_super();
  return query select u.user_id, p.email, p.full_name, u.role::text, u.created_at from public.app_users u join public.profiles p on p.id = u.user_id order by u.role, p.email;
end $$;

create function public.set_app_user(p_email text, p_role text) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_role public.app_role;
begin
  perform app_private.assert_super();
  begin v_role := p_role::public.app_role; exception when invalid_text_representation then raise exception 'invalid_role' using errcode = '22023'; end;
  select p.id into v_id from public.profiles p where lower(p.email) = lower(btrim(p_email));
  if v_id is null then raise exception 'user_not_found' using errcode = 'P0002'; end if;      -- primero debe existir en Supabase Auth
  if v_id = auth.uid() and v_role <> 'super_admin' and (select count(*) from public.app_users where role = 'super_admin') <= 1 then
    raise exception 'last_super_admin' using errcode = '23514'; end if;
  insert into public.app_users(user_id, role, created_by) values (v_id, v_role, auth.uid()) on conflict (user_id) do update set role = excluded.role;
  if not exists (select 1 from public.app_users where role = 'super_admin') then raise exception 'last_super_admin' using errcode = '23514'; end if;
  perform app_private.audit('set_app_user', 'app_users', v_id, jsonb_build_object('role', v_role));
  return jsonb_build_object('user_id', v_id, 'role', v_role);
end $$;

create function public.remove_app_user(p_user_id uuid) returns void language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.assert_super();
  if (select role from public.app_users where user_id = p_user_id) = 'super_admin'
     and (select count(*) from public.app_users where role = 'super_admin') <= 1 then raise exception 'last_super_admin' using errcode = '23514'; end if;
  delete from public.app_users where user_id = p_user_id;
  if not found then raise exception 'user_not_found' using errcode = 'P0002'; end if;
  perform app_private.audit('remove_app_user', 'app_users', p_user_id, '{}');
end $$;

-- Ventana temporal para crear usuarios en Supabase Auth (cerrada por defecto). Reemplaza el bloqueo total de altas.
create function public.open_user_creation(p_minutes int default 15) returns timestamptz language plpgsql security definer set search_path = '' as $$
declare v timestamptz;
begin
  perform app_private.assert_super();
  if p_minutes < 0 or p_minutes > 60 then raise exception 'invalid_minutes' using errcode = '22023'; end if;
  v := case when p_minutes = 0 then null else now() + make_interval(mins => p_minutes) end;
  update public.app_settings set user_creation_open_until = v;
  perform app_private.audit('open_user_creation', 'app_settings', null, jsonb_build_object('minutes', p_minutes));
  return v;
end $$;

create function app_private.block_signups() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.app_users) and not exists (select 1 from public.app_settings where user_creation_open_until > now()) then
    raise exception 'signups_closed: VIP es privado, el alta de nuevos usuarios está cerrada' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger block_signups before insert on auth.users for each row execute function app_private.block_signups();

-- Las cuentas internas dejan de depender de una única fila: auditoría de cambios de rol
create trigger audit after insert or update or delete on public.app_users for each row execute function app_private.audit_row();

-- ───────── RLS por rol ─────────
alter table public.app_users enable row level security;       -- sin políticas: solo vía funciones
revoke all on public.app_users from anon, authenticated;
grant all on public.app_users to service_role;

-- Lectura: cualquier rol. Escritura de datos maestros: admin+. Configuración y métodos de pago: solo SUPER_ADMIN.
do $$ declare t text; pol record; begin
  for pol in select polname, tablename from (select p.polname, c.relname as tablename from pg_policy p join pg_class c on c.oid = p.polrelid
            where c.relnamespace = 'public'::regnamespace and (p.polname like '%\_select' escape '\' or p.polname like '%\_write' escape '\')) x loop
    execute format('drop policy %I on public.%I', pol.polname, pol.tablename);
  end loop;
  foreach t in array array['app_settings','drivers','units','assignments','rates','rate_exceptions','payment_methods','adjustments','charges','payments',
    'payment_allocations','weekly_closures','whatsapp_sessions','message_templates','notification_schedules','notification_jobs','excel_imports',
    'import_blocks','import_rows','candidate_payments','audit_logs'] loop
    execute format('create policy %I on public.%I for select to authenticated using (app_private.is_staff())', t || '_select', t);
  end loop;
  foreach t in array array['drivers','units','assignments','rates','notification_schedules','excel_imports','import_blocks','import_rows',
    'candidate_payments','rate_exceptions','message_templates'] loop
    execute format('create policy %I on public.%I for all to authenticated using (app_private.is_admin()) with check (app_private.is_admin())', t || '_write', t);
  end loop;
  foreach t in array array['payment_methods','app_settings'] loop
    execute format('create policy %I on public.%I for all to authenticated using (app_private.is_super()) with check (app_private.is_super())', t || '_write', t);
  end loop;
end $$;
-- Las configuraciones de usuario_creation y entorno NO se editan directamente desde el navegador
revoke update on public.app_settings from authenticated;
grant update (business_name, timezone, max_per_driver_per_day, min_minutes_between, grace_minutes) on public.app_settings to authenticated;
create policy whatsapp_sessions_write on public.whatsapp_sessions for update to authenticated using (app_private.is_admin()) with check (app_private.is_admin());
create policy profiles_select on public.profiles for select to authenticated using (id = auth.uid() and app_private.is_staff());

-- ───────── Funciones que ahora admiten SUPERVISOR (lectura y registrar pagos) ─────────
create or replace function public.register_payment(p_assignment_id uuid, p_method_code text, p_gross_cents bigint, p_idempotency_key text,
  p_reference text default null, p_paid_at timestamptz default null, p_send_receipt boolean default false, p_notes text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid(); v_asg record; v_method record; v_existing record; v_driver record; v_unit record;
  v_paid_at timestamptz := coalesce(p_paid_at, now()); v_local date; v_net bigint; v_before record; v_after record;
  v_applied bigint; v_generated bigint; v_payment_id uuid; v_credit_job uuid; v_receipt_job uuid; v_covered jsonb; v_cov_before jsonb;
begin
  perform app_private.assert_staff();
  if p_idempotency_key is null or length(btrim(p_idempotency_key)) = 0 then raise exception 'idempotency_key_required' using errcode = '22023'; end if;
  select a.* into v_asg from public.assignments a where a.id = p_assignment_id for update;     -- serializa pagos del mismo conductor
  if not found then raise exception 'assignment_not_found' using errcode = 'P0002'; end if;
  v_local := (v_paid_at at time zone app_private.tz())::date;

  select p.* into v_existing from public.payments p where p.idempotency_key = p_idempotency_key;
  if found then
    if v_existing.assignment_id <> p_assignment_id or v_existing.gross_cents <> p_gross_cents then raise exception 'idempotency_conflict' using errcode = '23505'; end if;
    return app_private.payment_result(v_existing.id, true);
  end if;

  if v_paid_at > now() + interval '5 minutes' then raise exception 'paid_at_in_future' using errcode = '22023'; end if;
  if p_gross_cents is null or p_gross_cents <= 0 then raise exception 'invalid_amount' using errcode = '22023'; end if;
  select d.* into v_driver from public.drivers d where d.id = v_asg.driver_id;
  select u.* into v_unit from public.units u where u.id = v_asg.unit_id;
  if not v_driver.active or not v_unit.active or v_asg.valid_from > v_local or (v_asg.valid_to is not null and v_asg.valid_to < v_local) then
    raise exception 'assignment_inactive' using errcode = '22023'; end if;
  select pm.* into v_method from public.payment_methods pm where pm.code = p_method_code and pm.active;
  if not found then raise exception 'invalid_method' using errcode = '22023'; end if;
  if p_gross_cents <= v_method.commission_cents then raise exception 'amount_not_covering_commission' using errcode = '22023'; end if;

  v_net := p_gross_cents - v_method.commission_cents;
  select * into v_before from public.assignment_position(p_assignment_id);
  select * into v_after from public.assignment_position(p_assignment_id, null, v_net);
  v_applied := v_before.pending_cents - v_after.pending_cents;
  v_generated := v_after.credit_cents - v_before.credit_cents;
  select coalesce(jsonb_object_agg(c.charge_id::text, c.covered_cents), '{}'::jsonb) into v_cov_before from public.assignment_coverage(p_assignment_id) c;

  begin
    insert into public.payments(assignment_id, method_id, gross_cents, commission_cents, net_cents, applied_cents, credit_generated_cents,
      reference, notes, paid_at, week_start, idempotency_key, registered_by)
    values (p_assignment_id, v_method.id, p_gross_cents, v_method.commission_cents, v_net, v_applied, v_generated,
      nullif(btrim(p_reference), ''), nullif(btrim(p_notes), ''), v_paid_at, app_private.week_start_of(v_local), p_idempotency_key, v_uid)
    returning id into v_payment_id;
  exception when unique_violation then raise exception 'idempotency_conflict' using errcode = '23505';
  end;

  insert into public.payment_allocations(payment_id, charge_id, amount_cents)
  select v_payment_id, a.charge_id, a.covered_cents - coalesce((v_cov_before ->> a.charge_id::text)::bigint, 0)
    from public.assignment_coverage(p_assignment_id) a
   where a.covered_cents - coalesce((v_cov_before ->> a.charge_id::text)::bigint, 0) > 0;
  select coalesce(jsonb_agg(jsonb_build_object('charge_id', charge_id, 'amount_cents', amount_cents)), '[]'::jsonb) into v_covered
    from public.payment_allocations where payment_id = v_payment_id;

  if v_generated > 0 then
    insert into public.notification_jobs(driver_id, kind, local_date, payment_id, scheduled_for, status, suggested_body)
    values (v_asg.driver_id, 'credit_notice', v_local, v_payment_id, now(), 'awaiting_approval',
      'Estimado conductor, le informamos que su cuenta (unidad ' || v_unit.code || ') se encuentra al día y mantiene un saldo a favor de '
      || app_private.fmt_usd(v_after.credit_cents) || E', que será aplicado a sus próximas obligaciones.\n¡Gracias por su puntualidad!')
    returning id into v_credit_job;
  end if;
  if p_send_receipt then
    insert into public.notification_jobs(driver_id, kind, local_date, payment_id, scheduled_for, status)
    values (v_asg.driver_id, 'payment_receipt', v_local, v_payment_id, now(), 'pending') returning id into v_receipt_job;
  end if;

  perform app_private.reevaluate_reminders(v_asg.driver_id, v_local);
  perform app_private.audit('register_payment', 'payments', v_payment_id, jsonb_build_object(
    'assignment_id', p_assignment_id, 'method', p_method_code, 'gross_cents', p_gross_cents, 'commission_cents', v_method.commission_cents,
    'net_cents', v_net, 'applied_cents', v_applied, 'credit_generated_cents', v_generated, 'reference', p_reference, 'notes', p_notes,
    'idempotency_key', p_idempotency_key));
  return app_private.payment_result(v_payment_id, false) || jsonb_build_object('covered', v_covered, 'credit_notice_job_id', v_credit_job, 'receipt_job_id', v_receipt_job);
end $$;

create or replace function public.dashboard_summary() returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare v_today date; v_week date; v_drivers jsonb; v_pos record; v_pay record; v_week_ch bigint; v_week_net bigint; v_methods jsonb; v_rem jsonb; v_wa jsonb;
begin
  perform app_private.assert_staff();
  v_today := (now() at time zone app_private.tz())::date; v_week := app_private.week_start_of(v_today);
  select jsonb_build_object('total', count(*), 'active', count(*) filter (where status = 'active'), 'inactive', count(*) filter (where status = 'inactive'),
    'suspended', count(*) filter (where status = 'suspended'), 'pending_approval', count(*) filter (where status = 'pending_approval')) into v_drivers from public.drivers;
  select coalesce(sum(p.pending_cents), 0)::bigint pending, coalesce(sum(p.credit_cents), 0)::bigint credit, count(distinct p.driver_id) filter (where p.pending_cents > 0) debtors
    into v_pos from public.v_assignment_position p;
  select coalesce(sum(gross_cents), 0)::bigint g, coalesce(sum(commission_cents), 0)::bigint c, coalesce(sum(net_cents), 0)::bigint n into v_pay
    from public.payments where voided_at is null and (paid_at at time zone app_private.tz())::date = v_today;
  select coalesce(sum(amount_cents), 0)::bigint into v_week_ch from public.charges where week_start = v_week;
  select coalesce(sum(net_cents), 0)::bigint into v_week_net from public.payments where voided_at is null and week_start = v_week;
  select coalesce(jsonb_agg(jsonb_build_object('method_code', m.code, 'payments', x.n, 'gross_cents', x.g, 'commission_cents', x.c, 'net_cents', x.nt) order by m.code), '[]'::jsonb)
    into v_methods from public.payment_methods m
    cross join lateral (select count(p.id)::bigint n, coalesce(sum(p.gross_cents), 0)::bigint g, coalesce(sum(p.commission_cents), 0)::bigint c, coalesce(sum(p.net_cents), 0)::bigint nt
                          from public.payments p where p.method_id = m.id and p.voided_at is null and p.week_start = v_week) x;
  select jsonb_build_object('scheduled_today', count(*) filter (where local_date = v_today and status in ('pending','processing')),
    'pending_total', count(*) filter (where status = 'pending'), 'awaiting_approval', count(*) filter (where status = 'awaiting_approval')) into v_rem from public.notification_jobs;
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'label', label, 'status', status, 'last_seen_at', last_seen_at)), '[]'::jsonb) into v_wa from public.whatsapp_sessions;
  return jsonb_build_object('as_of_date', v_today, 'week_start', v_week, 'drivers', v_drivers,
    'collections', jsonb_build_object('pending_total_cents', v_pos.pending, 'drivers_with_debt', v_pos.debtors, 'credits_total_cents', v_pos.credit,
      'collected_today_gross_cents', v_pay.g, 'collected_today_commission_cents', v_pay.c, 'collected_today_net_cents', v_pay.n,
      'week_charged_cents', v_week_ch, 'week_net_cents', v_week_net),
    'by_method', v_methods, 'reminders', v_rem, 'whatsapp', jsonb_build_object('sessions', v_wa));
end $$;

create or replace function public.weekly_collection_table(p_week_start date)
returns table (assignment_id uuid, driver_id uuid, unit_id uuid, unit_code text, operator_code text, national_id text, full_name text,
  driver_status text, daily_rate_cents bigint, week_charged_cents bigint, day_net_cents bigint[], gross_cents bigint, commission_cents bigint,
  net_cents bigint, week_diff_cents bigint, pending_cents bigint, credit_cents bigint, week_closed boolean)
language plpgsql stable security invoker set search_path = '' as $$
declare v_tz text := app_private.tz(); v_end date := p_week_start + 6;
begin
  perform app_private.assert_staff();
  if extract(isodow from p_week_start) <> 1 then raise exception 'week_start_must_be_monday' using errcode = '22023'; end if;
  return query
  select x.assignment_id, x.driver_id, x.unit_id, x.unit_code, x.operator_code, x.national_id, x.full_name, x.driver_status, x.daily_rate_cents, x.week_charged_cents,
         x.day_net_cents, x.gross_cents, x.commission_cents, x.net_cents, (x.net_cents - x.week_charged_cents), x.pending_cents, x.credit_cents, x.week_closed
  from (
    select a.id as assignment_id, d.id as driver_id, u.id as unit_id, u.code as unit_code, d.operator_code, d.national_id, btrim(d.first_name || ' ' || d.last_name) as full_name,
           d.status as driver_status,
           coalesce((select r.daily_amount_cents from public.rates r where r.assignment_id = a.id and r.valid_from <= v_end and (r.valid_to is null or r.valid_to >= p_week_start)
                      order by r.valid_from desc limit 1), 0)::bigint as daily_rate_cents,
           coalesce((select sum(c.amount_cents) from public.charges c where c.assignment_id = a.id and c.week_start = p_week_start), 0)::bigint as week_charged_cents,
           array(select coalesce((select sum(p.net_cents) from public.payments p where p.assignment_id = a.id and p.voided_at is null
                                    and (p.paid_at at time zone v_tz)::date = p_week_start + i), 0)::bigint from generate_series(0, 6) i) as day_net_cents,
           coalesce((select sum(p.gross_cents) from public.payments p where p.assignment_id = a.id and p.voided_at is null and p.week_start = p_week_start), 0)::bigint as gross_cents,
           coalesce((select sum(p.commission_cents) from public.payments p where p.assignment_id = a.id and p.voided_at is null and p.week_start = p_week_start), 0)::bigint as commission_cents,
           coalesce((select sum(p.net_cents) from public.payments p where p.assignment_id = a.id and p.voided_at is null and p.week_start = p_week_start), 0)::bigint as net_cents,
           pos.pending_cents, pos.credit_cents,
           exists (select 1 from public.weekly_closures w where w.assignment_id = a.id and w.week_start = p_week_start) as week_closed
      from public.assignments a join public.drivers d on d.id = a.driver_id join public.units u on u.id = a.unit_id
      cross join lateral public.assignment_position(a.id, v_end) pos
     where a.valid_from <= v_end and (a.valid_to is null or a.valid_to >= p_week_start)
  ) x order by x.unit_code;
end $$;

create or replace function public.period_summary(p_from date, p_to date) returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare v_tz text := app_private.tz(); v_exp bigint; v_adj bigint; v_pay record; v_recovered bigint; v_to_period bigint; v_end record;
begin
  perform app_private.assert_staff();
  if p_to < p_from or p_to - p_from > 400 then raise exception 'invalid_range' using errcode = '22023'; end if;
  select coalesce(sum(amount_cents) filter (where kind = 'daily'), 0), coalesce(sum(amount_cents) filter (where kind = 'adjustment'), 0)
    into v_exp, v_adj from public.charges where charge_date between p_from and p_to;
  select count(*) n, coalesce(sum(gross_cents), 0) g, coalesce(sum(commission_cents), 0) c, coalesce(sum(net_cents), 0) nt,
         coalesce(sum(applied_cents), 0) ap, coalesce(sum(credit_generated_cents), 0) cr into v_pay
    from public.payments where voided_at is null and (paid_at at time zone v_tz)::date between p_from and p_to;
  select coalesce(sum(pa.amount_cents) filter (where c.charge_date < p_from), 0), coalesce(sum(pa.amount_cents) filter (where c.charge_date between p_from and p_to), 0)
    into v_recovered, v_to_period from public.payment_allocations pa join public.payments p on p.id = pa.payment_id join public.charges c on c.id = pa.charge_id
   where p.voided_at is null and (p.paid_at at time zone v_tz)::date between p_from and p_to;
  select coalesce(sum(pos.pending_cents), 0) pend, coalesce(sum(pos.credit_cents), 0) cred, count(*) filter (where pos.pending_cents > 0) debtors into v_end
    from public.assignments a cross join lateral public.assignment_position(a.id, p_to) pos where a.valid_from <= p_to;
  return jsonb_build_object('from', p_from, 'to', p_to, 'charges_generated_cents', v_exp, 'adjustments_charged_cents', v_adj, 'expected_cents', v_exp,
    'payments_count', v_pay.n, 'gross_cents', v_pay.g, 'commission_cents', v_pay.c, 'net_cents', v_pay.nt, 'applied_cents', v_pay.ap,
    'applied_to_period_cents', v_to_period, 'prior_debt_recovered_cents', v_recovered, 'credits_generated_cents', v_pay.cr,
    'pending_end_cents', v_end.pend, 'credits_end_cents', v_end.cred, 'drivers_with_debt_end', v_end.debtors,
    'difference_cents', v_pay.nt - v_exp, 'recovery_pct', case when v_exp > 0 then round(v_pay.nt * 100.0 / v_exp, 1) end);
end $$;

create or replace function public.period_detail(p_from date, p_to date, p_indicator text)
returns table (occurred_on date, kind text, unit_code text, operator_code text, full_name text, amount_cents bigint, detail text)
language plpgsql stable security invoker set search_path = '' as $$
declare v_tz text := app_private.tz();
begin
  perform app_private.assert_staff();
  if p_indicator = 'charges' then
    return query select c.charge_date, c.kind, u.code, d.operator_code, btrim(d.first_name || ' ' || d.last_name), c.amount_cents::bigint, null::text
      from public.charges c join public.assignments a on a.id = c.assignment_id join public.drivers d on d.id = a.driver_id join public.units u on u.id = a.unit_id
     where c.charge_date between p_from and p_to order by 1, 3;
  elsif p_indicator in ('gross', 'commission', 'net', 'applied', 'credits_generated') then
    return query select (p.paid_at at time zone v_tz)::date, 'payment'::text, u.code, d.operator_code, btrim(d.first_name || ' ' || d.last_name),
        (case p_indicator when 'gross' then p.gross_cents when 'commission' then p.commission_cents when 'net' then p.net_cents when 'applied' then p.applied_cents else p.credit_generated_cents end)::bigint, m.label
      from public.payments p join public.assignments a on a.id = p.assignment_id join public.drivers d on d.id = a.driver_id
      join public.units u on u.id = a.unit_id join public.payment_methods m on m.id = p.method_id
     where p.voided_at is null and (p.paid_at at time zone v_tz)::date between p_from and p_to
       and (case p_indicator when 'commission' then p.commission_cents when 'credits_generated' then p.credit_generated_cents when 'applied' then p.applied_cents else 1 end) > 0 order by 1, 3;
  elsif p_indicator = 'prior_debt_recovered' then
    return query select (p.paid_at at time zone v_tz)::date, 'allocation'::text, u.code, d.operator_code, btrim(d.first_name || ' ' || d.last_name), pa.amount_cents::bigint, 'cuota del ' || c.charge_date::text
      from public.payment_allocations pa join public.payments p on p.id = pa.payment_id join public.charges c on c.id = pa.charge_id
      join public.assignments a on a.id = p.assignment_id join public.drivers d on d.id = a.driver_id join public.units u on u.id = a.unit_id
     where p.voided_at is null and c.charge_date < p_from and (p.paid_at at time zone v_tz)::date between p_from and p_to order by 1, 3;
  elsif p_indicator in ('pending', 'credits') then
    return query select p_to, 'balance'::text, u.code, d.operator_code, btrim(d.first_name || ' ' || d.last_name),
        (case p_indicator when 'pending' then pos.pending_cents else pos.credit_cents end)::bigint, null::text
      from public.assignments a join public.drivers d on d.id = a.driver_id join public.units u on u.id = a.unit_id
      cross join lateral public.assignment_position(a.id, p_to) pos
     where a.valid_from <= p_to and (case p_indicator when 'pending' then pos.pending_cents else pos.credit_cents end) > 0 order by 6 desc, 3;
  else raise exception 'invalid_indicator' using errcode = '22023';
  end if;
end $$;

create or replace function public.period_series(p_from date, p_to date)
returns table (week_start date, expected_cents bigint, gross_cents bigint, commission_cents bigint, net_cents bigint,
  pending_end_cents bigint, credits_end_cents bigint, difference_cents bigint, recovery_pct numeric)
language plpgsql stable security invoker set search_path = '' as $$
begin
  perform app_private.assert_staff();
  if p_to - p_from > 400 then raise exception 'invalid_range' using errcode = '22023'; end if;
  return query
  select w.d, (s ->> 'expected_cents')::bigint, (s ->> 'gross_cents')::bigint, (s ->> 'commission_cents')::bigint, (s ->> 'net_cents')::bigint,
         (s ->> 'pending_end_cents')::bigint, (s ->> 'credits_end_cents')::bigint, (s ->> 'difference_cents')::bigint, (s ->> 'recovery_pct')::numeric
    from (select g::date d from generate_series(app_private.week_start_of(p_from)::timestamp, p_to::timestamp, interval '7 days') g) w
    cross join lateral (select public.period_summary(w.d, w.d + 6) s) y order by w.d;
end $$;

create or replace function public.preview_template(p_assignment uuid, p_body text, p_date date default null) returns text
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app_private.assert_staff();
  if not exists (select 1 from public.assignments where id = p_assignment) then raise exception 'assignment_not_found' using errcode = 'P0002'; end if;
  return app_private.render_template(p_body, app_private.template_vars(p_assignment, coalesce(p_date, (now() at time zone app_private.tz())::date)));
end $$;

-- ───────── Permisos de ejecución ─────────
revoke all on all functions in schema public from public, anon, authenticated;
revoke all on all functions in schema app_private from public, anon, authenticated;
grant execute on function app_private.is_staff(), app_private.is_admin(), app_private.is_super(), app_private.current_role(), app_private.is_service(), app_private.tz() to authenticated, service_role;
grant execute on function app_private.assert_admin(), app_private.assert_staff(), app_private.assert_super(), app_private.fmt_usd(bigint), app_private.week_start_of(date),
  app_private.payment_result(uuid, boolean), app_private.render_template(text, jsonb), app_private.template_vars(uuid, date) to authenticated, service_role;
grant execute on function public.assignment_position(uuid, date, bigint), public.assignment_coverage(uuid, bigint), public.assignment_dues(uuid, date),
  public.register_payment(uuid, text, bigint, text, text, timestamptz, boolean, text), public.void_payment(uuid, text),
  public.create_adjustment(uuid, bigint, date, text, text), public.generate_daily_charges(date), public.close_week(date),
  public.review_notification(uuid, text, text), public.preview_template(uuid, text, date), public.dashboard_summary(),
  public.weekly_collection_table(date), public.period_summary(date, date), public.period_detail(date, date, text), public.period_series(date, date),
  public.apply_import(uuid, date, text, text), public.apply_directory_import(uuid, date, text, boolean), public.start_assignment(uuid, uuid, date, bigint, text),
  public.end_assignment(uuid, date), public.reassign_unit(uuid, uuid, date, bigint, text), public.change_rate(uuid, bigint, date),
  public.is_authorized(), public.current_app_role(), public.list_app_users(), public.set_app_user(text, text), public.remove_app_user(uuid),
  public.open_user_creation(int) to authenticated, service_role;
grant execute on function public.authorize_admin(uuid), public.schedule_reminders(timestamptz, interval), public.claim_notification_jobs(int, timestamptz),
  public.requeue_stuck_notifications(interval, timestamptz), public.release_notification(uuid, interval, timestamptz),
  public.prepare_notification_send(uuid, timestamptz), public.complete_notification(uuid, text, text, boolean, text, timestamptz) to service_role;

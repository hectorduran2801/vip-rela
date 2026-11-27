-- VIP · 0001 · Núcleo de INSTANCIA ÚNICA: un solo negocio, una sola administradora autorizada.
-- No existen organizaciones, membresías ni jerarquía de roles. Todo el dinero va en centavos (bigint).
set search_path = public, extensions;

create extension if not exists pgcrypto with schema extensions;
create extension if not exists btree_gist with schema extensions;
create schema if not exists app_private;              -- helpers internos, NO expuesto por la API de Supabase

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default '',
  email text,
  created_at timestamptz not null default now()
);

-- La ÚNICA cuenta autorizada para usar VIP. El índice impide una segunda fila.
create table public.app_admins (
  user_id uuid primary key references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now()
);
create unique index app_admins_single on public.app_admins ((true));

-- Configuración del negocio (una sola fila).
create table public.app_settings (
  id boolean primary key default true check (id),
  business_name text not null default 'VIP' check (length(btrim(business_name)) > 0),
  timezone text not null default 'America/Panama',
  max_per_driver_per_day int not null default 3 check (max_per_driver_per_day between 1 and 20),
  min_minutes_between int not null default 60 check (min_minutes_between between 0 and 1440),
  grace_minutes int not null default 180 check (grace_minutes between 5 and 1440)   -- un horario vencido hace más no se crea
);
insert into public.app_settings default values;

-- Perfil automático al crear un usuario en Supabase Auth (el registro público debe estar desactivado en Supabase).
create function app_private.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, full_name, email)
  values (new.id, coalesce(nullif(new.raw_user_meta_data ->> 'full_name', ''), split_part(coalesce(new.email, ''), '@', 1)), new.email)
  on conflict (id) do nothing;
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function app_private.handle_new_user();
-- Cuentas que ya existían en Supabase Auth antes de instalar VIP (p. ej. la administradora): se les crea su perfil.
insert into public.profiles (id, full_name, email)
select u.id, coalesce(nullif(u.raw_user_meta_data ->> 'full_name', ''), split_part(coalesce(u.email, ''), '@', 1)), u.email from auth.users u
on conflict (id) do nothing;

-- ───────── Autorización ─────────
create function app_private.is_service() returns boolean
language sql stable set search_path = '' as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') = 'service_role'
$$;

create function app_private.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.app_admins a where a.user_id = auth.uid())
$$;

create function app_private.assert_admin() returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if not app_private.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
end $$;

create function app_private.tz() returns text
language sql stable security definer set search_path = '' as $$ select timezone from public.app_settings $$;

create function app_private.fmt_usd(p_cents bigint) returns text language sql immutable as $$
  select case when p_cents < 0 then '-' else '' end || '$' || (abs(p_cents) / 100)::text || '.' || lpad((abs(p_cents) % 100)::text, 2, '0')
$$;
create function app_private.week_start_of(p_date date) returns date language sql immutable as $$
  select p_date - (extract(isodow from p_date)::int - 1)
$$;

create function app_private.block_mutation() returns trigger language plpgsql as $$
begin
  raise exception '% sobre % no permitido: use las operaciones auditadas', tg_op, tg_table_name using errcode = '42501';
end $$;

-- Autoriza a la administradora. Solo servidor/SQL de administración (sin permiso para navegador).
create function public.authorize_admin(p_user_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.profiles where id = p_user_id) then raise exception 'user_not_found' using errcode = 'P0002'; end if;
  insert into public.app_admins(user_id) values (p_user_id) on conflict (user_id) do nothing;
exception when unique_violation then raise exception 'admin_already_set' using errcode = '23505';
end $$;

-- Defensa en profundidad contra el registro público: en cuanto hay una administradora autorizada, NO se crean más usuarios en Auth.
-- (La configuración de Auth «Allow new users to sign up» debe apagarse además en el panel de Supabase.)
-- Reversible: `drop trigger block_signups on auth.users;`
create function app_private.block_signups() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.app_admins) then
    raise exception 'signups_closed: VIP es privado, el registro de nuevos usuarios está cerrado' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger block_signups before insert on auth.users for each row execute function app_private.block_signups();

-- ───────── Conductores, unidades, asignaciones, tarifas ─────────
create table public.drivers (
  id uuid primary key default gen_random_uuid(),
  operator_code text not null unique check (length(btrim(operator_code)) > 0),
  national_id text not null unique check (length(btrim(national_id)) > 0),
  first_name text not null check (length(btrim(first_name)) > 0),
  last_name text not null default '',
  phone text check (phone ~ '^[0-9+() .-]{6,24}$'),                 -- llamadas
  phone_e164 text check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),      -- WhatsApp
  whatsapp_consent boolean not null default false,
  whatsapp_consent_at timestamptz,
  reminders_paused boolean not null default false,
  reminders_paused_reason text,
  license_number text,
  license_expires_on date,
  status text not null default 'active' check (status in ('active', 'inactive', 'suspended', 'pending_approval')),
  active boolean generated always as (status = 'active') stored,     -- derivado: no se escribe
  notes text,
  created_at timestamptz not null default now(),
  check (not whatsapp_consent or phone_e164 is not null)             -- no hay consentimiento sin teléfono
);
create index drivers_status_idx on public.drivers(status);

create table public.units (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (length(btrim(code)) > 0),
  plate text check (length(btrim(plate)) > 0),
  make text, model text,
  year smallint check (year between 1980 and 2100),
  vehicle_status text not null default 'active' check (vehicle_status in ('active', 'maintenance', 'out_of_service')),
  active boolean generated always as (vehicle_status = 'active') stored,
  notes text,
  created_at timestamptz not null default now()
);
create unique index units_plate_uq on public.units(upper(plate)) where plate is not null;

-- Historial: un vehículo cambia de conductor y viceversa, sin solaparse.
create table public.assignments (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid not null references public.drivers(id),
  unit_id uuid not null references public.units(id),
  valid_from date not null,
  valid_to date,
  agreement_note text,                       -- ACUERDO: texto, sin interpretar
  created_at timestamptz not null default now(),
  check (valid_to is null or valid_to >= valid_from),
  exclude using gist (driver_id with =, daterange(valid_from, coalesce(valid_to, 'infinity'::date), '[]') with &&),
  exclude using gist (unit_id with =, daterange(valid_from, coalesce(valid_to, 'infinity'::date), '[]') with &&)
);
create index assignments_driver_idx on public.assignments(driver_id);
create index assignments_unit_idx on public.assignments(unit_id);

create table public.rates (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references public.assignments(id),
  daily_amount_cents bigint not null check (daily_amount_cents >= 0),
  weekdays smallint[] not null default '{1,2,3,4,5,6}'
    check (weekdays <@ array[1,2,3,4,5,6]::smallint[] and cardinality(weekdays) > 0),   -- el domingo nunca genera cuota ordinaria
  valid_from date not null,
  valid_to date,
  created_at timestamptz not null default now(),
  check (valid_to is null or valid_to >= valid_from),
  exclude using gist (assignment_id with =, daterange(valid_from, coalesce(valid_to, 'infinity'::date), '[]') with &&)
);
create index rates_assignment_idx on public.rates(assignment_id);

create table public.rate_exceptions (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references public.assignments(id),
  on_date date not null,
  amount_cents bigint not null check (amount_cents >= 0),
  reason text,
  unique (assignment_id, on_date)
);

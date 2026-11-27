-- SOLO PARA PRUEBAS LOCALES: imita lo mínimo de Supabase (roles, auth.users, auth.uid()).
-- En Supabase real estos objetos ya existen. NO se incluye en supabase/migrations.
do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin bypassrls; exception when duplicate_object then null; end $$;

create schema if not exists extensions;
create schema if not exists auth;
create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  raw_user_meta_data jsonb not null default '{}',
  created_at timestamptz not null default now(),
  -- columnas de la tabla real que usa el alta directa de cuentas (sin clave de servicio)
  instance_id uuid, aud text, role text, encrypted_password text, email_confirmed_at timestamptz, raw_app_meta_data jsonb,
  updated_at timestamptz, confirmation_token text, recovery_token text, email_change_token_new text, email_change text
);
create table auth.identities (
  id uuid primary key default gen_random_uuid(), provider_id text not null, user_id uuid not null references auth.users(id) on delete cascade,
  identity_data jsonb not null, provider text not null, last_sign_in_at timestamptz, created_at timestamptz, updated_at timestamptz
);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', '')::uuid $$;
create function auth.role() returns text language sql stable as $$
  select coalesce(nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', ''), 'anon') $$;
grant usage on schema auth, extensions to anon, authenticated, service_role;
grant execute on function auth.uid(), auth.role() to anon, authenticated, service_role;

-- Supabase concede por defecto TODO a anon/authenticated/service_role sobre lo que se cree en public.
-- Se imita aquí para que las pruebas detecten migraciones que olviden revocar.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;

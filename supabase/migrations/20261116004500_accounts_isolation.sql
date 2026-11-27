-- VIP · 0045 · Datos separados por cuenta (entrega 1). WhatsApp sigue siendo una sola sesión (entrega 2).
--   · accounts + app_users.account_id. Lo que ya existe queda en la cuenta por defecto. El SUPER_ADMIN actual recibe una cuenta nueva (vacía).
--   · Cada tabla de datos tiene account_id y una política RESTRICTIVA: nadie ve ni toca filas de otra cuenta.
--   · Las funciones SECURITY DEFINER usadas por la app pasan a ser del rol vip_app (sin BYPASSRLS), así la separación también vale DENTRO de ellas.
--   · Sin usuario (worker, motor de cuotas, mantenimiento) no se filtra; las filas hijas heredan la cuenta de su padre.
--   · El SUPER_ADMIN puede CONSULTAR otra cuenta (solo lectura).
-- Reversible: restaurar backups-dev/pre-multicuenta-*.sql.
-- OJO para migraciones posteriores (o 0023/0025 si se aplican después): toda función SECURITY DEFINER nueva que use la app debe terminar con
-- `alter function … owner to vip_app`, o se saltará la separación. packages/db/test/accounts-isolation.test.ts lo vigila.
set search_path = public, extensions;

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'vip_app') then create role vip_app nologin nobypassrls; end if;
end $$;
grant vip_app to current_user;
grant authenticated to vip_app;
grant usage, create on schema public to vip_app;
grant usage, create on schema app_private to vip_app;

create table public.accounts (id uuid primary key default gen_random_uuid(), name text not null default '', is_default boolean not null default false, created_at timestamptz not null default now());
create unique index accounts_one_default on public.accounts(is_default) where is_default;
insert into public.accounts(id, name, is_default) values ('00000000-0000-4000-8000-000000000001', 'Principal', true);
alter table public.app_users add column account_id uuid not null default '00000000-0000-4000-8000-000000000001' references public.accounts(id);
create table public.account_view (user_id uuid primary key references auth.users(id) on delete cascade, account_id uuid not null references public.accounts(id) on delete cascade);
alter table public.accounts enable row level security;
alter table public.account_view enable row level security;
revoke all on public.accounts, public.account_view from anon, authenticated;

-- El SUPER_ADMIN que ya existe empieza con cuenta propia SOLO si además hay alguien más (la persona dueña de los datos actuales).
do $$ declare r record; v uuid; begin
  if exists (select 1 from public.app_users where role <> 'super_admin') then
    for r in select user_id from public.app_users where role = 'super_admin' loop
      insert into public.accounts(name) values ('Administración') returning id into v;
      update public.app_users set account_id = v where user_id = r.user_id;
    end loop;
  end if;
end $$;

-- Cuentas nuevas creadas desde la aplicación (traen quién las creó): cada una con su propio espacio.
create function app_private.new_user_account() returns trigger language plpgsql security definer set search_path = '' as $$
declare v uuid;
begin
  if new.created_by is not null and new.account_id = '00000000-0000-4000-8000-000000000001' then
    insert into public.accounts(name) values ('') returning id into v;
    new.account_id := v;
  end if;
  return new;
end $$;
create trigger new_account before insert on public.app_users for each row execute function app_private.new_user_account();

-- Cuenta de quien consulta. NULL = proceso del sistema (sin usuario): no se filtra. Usuario sin cuenta: una cuenta inexistente (no ve nada).
create function app_private.own_account() returns uuid language sql stable security definer set search_path = '' as $$
  select case when auth.uid() is null then null
              else coalesce((select u.account_id from public.app_users u where u.user_id = auth.uid()), '00000000-0000-0000-0000-000000000000'::uuid) end $$;
create function app_private.current_account() returns uuid language sql stable security definer set search_path = '' as $$
  select coalesce((select v.account_id from public.account_view v join public.app_users u on u.user_id = v.user_id where v.user_id = auth.uid() and u.role = 'super_admin'), app_private.own_account()) $$;

-- Las filas hijas heredan la cuenta de su padre (importa para el worker y el motor, que no tienen usuario).
create function app_private.inherit_account() returns trigger language plpgsql security definer set search_path = '' as $$
declare v uuid; j jsonb := to_jsonb(new);
begin
  if app_private.own_account() is not null then return new; end if;
  if j ->> 'assignment_id' is not null then select a.account_id into v from public.assignments a where a.id = (j ->> 'assignment_id')::uuid; end if;
  if v is null and j ->> 'driver_id' is not null then select d.account_id into v from public.drivers d where d.id = (j ->> 'driver_id')::uuid; end if;
  if v is null and j ->> 'unit_id' is not null then select u.account_id into v from public.units u where u.id = (j ->> 'unit_id')::uuid; end if;
  if v is null and j ->> 'import_id' is not null then select i.account_id into v from public.excel_imports i where i.id = (j ->> 'import_id')::uuid; end if;
  if v is null and j ->> 'block_id' is not null then select b.account_id into v from public.import_blocks b where b.id = (j ->> 'block_id')::uuid; end if;
  if v is null and j ->> 'payment_id' is not null then select p.account_id into v from public.payments p where p.id = (j ->> 'payment_id')::uuid; end if;
  if v is null and j ->> 'schedule_id' is not null then select s.account_id into v from public.send_schedules s where s.id = (j ->> 'schedule_id')::uuid; end if;
  if v is not null then new.account_id := v; end if;
  return new;
end $$;

do $$ declare t text; begin
  foreach t in array array['adjustments','assignments','candidate_payments','charges','collection_sync_runs','collection_week_unit_changes','collection_week_units','driver_consents','drivers',
    'excel_imports','excel_payment_changes','excel_payment_days','import_blocks','import_rows','message_templates','notification_jobs','payment_allocations','payments','rate_corrections',
    'rate_exceptions','rates','send_schedule_runs','send_schedules','template_text_settings','template_variable_settings','unit_agreement_history','units','weekly_closures','whatsapp_test_messages'] loop
    execute format('alter table public.%I add column account_id uuid not null default ''00000000-0000-4000-8000-000000000001'' references public.accounts(id)', t);
    execute format('alter table public.%I alter column account_id set default coalesce(app_private.current_account(), ''00000000-0000-4000-8000-000000000001''::uuid)', t);
    execute format('create index %I on public.%I(account_id)', t || '_account_idx', t);
    execute format('create trigger zz_account before insert on public.%I for each row execute function app_private.inherit_account()', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy tenant_read on public.%I as restrictive for select to authenticated using (app_private.current_account() is null or account_id = app_private.current_account())', t);
    execute format('create policy tenant_insert on public.%I as restrictive for insert to authenticated with check (app_private.own_account() is null or account_id = app_private.own_account())', t);
    execute format('create policy tenant_update on public.%I as restrictive for update to authenticated using (app_private.own_account() is null or account_id = app_private.own_account()) with check (app_private.own_account() is null or account_id = app_private.own_account())', t);
    execute format('create policy tenant_delete on public.%I as restrictive for delete to authenticated using (app_private.own_account() is null or account_id = app_private.own_account())', t);
  end loop;
end $$;

-- vip_app: mismos permisos de datos que tenían las funciones (todo), pero sujeto a las políticas restrictivas de arriba.
grant select, insert, update, delete on all tables in schema public to vip_app;
grant usage, select, update on all sequences in schema public to vip_app;
grant execute on all functions in schema public to vip_app;
grant execute on all functions in schema app_private to vip_app;
alter default privileges in schema public grant select, insert, update, delete on tables to vip_app;
alter default privileges in schema public grant execute on functions to vip_app;
alter default privileges in schema app_private grant execute on functions to vip_app;
do $$ declare r record; begin
  for r in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity loop
    execute format('create policy vip_app_all on public.%I to vip_app using (true) with check (true)', r.relname);
  end loop;
end $$;

-- Únicos POR CUENTA (P121 puede existir en dos cuentas).
do $$ declare r record; begin
  for r in select c.conrelid::regclass::text t, c.conname, c.contype, array_to_string(array(select a.attname from unnest(c.conkey) with ordinality k(n, o) join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.n order by k.o), ', ') cols
             from pg_constraint c where c.connamespace = 'public'::regnamespace and c.contype in ('u', 'p') loop
    if (r.t, r.cols) in (('drivers', 'national_id'), ('drivers', 'operator_code'), ('units', 'code'), ('message_templates', 'name'), ('send_schedules', 'name'), ('excel_imports', 'file_sha256'))
       or (r.t in ('template_variable_settings', 'template_text_settings') and r.contype = 'p') then
      execute format('alter table public.%s drop constraint %I', r.t, r.conname);
      execute format('alter table public.%s add constraint %I %s (account_id, %s)', r.t, r.conname, case when r.contype = 'p' then 'primary key' else 'unique' end, r.cols);
    end if;
  end loop;
end $$;
drop index public.units_code_normalized_uq;
create unique index units_code_normalized_uq on public.units (account_id, upper(btrim(code)));
drop index public.units_plate_uq;
create unique index units_plate_uq on public.units (account_id, upper(plate)) where plate is not null;

-- ON CONFLICT que apuntaban a los únicos antiguos.
do $$ declare r record; d text; begin
  for r in select p.oid, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'app_private') and p.proname in ('collection_sync', 'save_template_text', 'save_template_variable') loop
    d := pg_get_functiondef(r.oid);
    d := replace(d, 'on conflict (code) do nothing', 'on conflict do nothing');
    d := replace(d, 'on conflict (code) do update', 'on conflict (account_id, code) do update');
    d := replace(d, 'on conflict (key) do update', 'on conflict (account_id, key) do update');
    execute d;
  end loop;
end $$;

-- Consultar otra cuenta (solo SUPER_ADMIN, solo lectura).
create function public.list_accounts() returns table (id uuid, name text, own boolean, viewing boolean, drivers int)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app_private.assert_super();
  return query select a.id,
      coalesce((select string_agg(coalesce(nullif(p.full_name, ''), p.email, 'Cuenta'), ', ' order by p.email) from public.app_users u join public.profiles p on p.id = u.user_id where u.account_id = a.id), nullif(a.name, ''), 'Sin usuarios'),
      a.id = app_private.own_account(), a.id = app_private.current_account(), (select count(*)::int from public.drivers d where d.account_id = a.id)
    from public.accounts a order by a.created_at, a.id;
end $$;
create function public.set_account_view(p_account uuid) returns void language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.assert_super();
  if p_account is null or p_account = app_private.own_account() then delete from public.account_view where user_id = auth.uid(); return; end if;
  if not exists (select 1 from public.accounts where id = p_account) then raise exception 'account_not_found' using errcode = 'P0002'; end if;
  insert into public.account_view(user_id, account_id) values (auth.uid(), p_account) on conflict (user_id) do update set account_id = excluded.account_id;
  perform app_private.audit('account.viewed', 'accounts', p_account, '{}'::jsonb);
end $$;
revoke all on function public.list_accounts(), public.set_account_view(uuid) from public, anon;
grant execute on function public.list_accounts(), public.set_account_view(uuid) to authenticated, service_role;
revoke all on function app_private.own_account(), app_private.current_account(), app_private.inherit_account(), app_private.new_user_account() from public, anon;
grant execute on function app_private.own_account(), app_private.current_account() to authenticated, service_role, vip_app;

-- Las funciones de la aplicación pasan a vip_app (dejan de saltarse la separación).
do $$ declare r record; begin
  for r in select p.oid::regprocedure f from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where p.prosecdef and p.prorettype <> 'trigger'::regtype and p.prokind = 'f'
       and (n.nspname = 'app_private' or (n.nspname = 'public' and has_function_privilege('authenticated', p.oid, 'execute')))
       and p.prosrc not ilike '%auth.users%'
       and p.proname not in ('own_account', 'current_account', 'is_admin', 'is_staff', 'is_super', 'is_service', 'current_app_role', 'assert_admin', 'assert_staff', 'assert_super', 'audit',
                             'list_accounts', 'set_account_view', 'consume_invite', 'handle_new_user', 'list_app_users', 'set_app_user', 'invite_app_user', 'remove_app_user', 'authorize_admin', 'authorize_credentials_reset',
                             'suspend_app_user', 'reactivate_app_user', 'revoke_invite', 'list_user_invites', 'open_signup_window', 'close_signup_window') loop
    execute format('alter function %s owner to vip_app', r.f);
  end loop;
end $$;

-- El borrado en cascada auditado ahora lo ejecutan funciones de vip_app (antes, del dueño de la base): el candado acepta a ambos.
do $$ declare d text; old text := 'current_user = (select pg_get_userbyid(p.proowner) from pg_proc p where p.oid = ''app_private.block_mutation_unless_cascade()''::regprocedure)';
begin
  if to_regprocedure('app_private.block_mutation_unless_cascade()') is null then return; end if;      -- 0023 sin aplicar: no hay candado que ajustar
  d := pg_get_functiondef('app_private.block_mutation_unless_cascade()'::regprocedure);
  if position(old in d) = 0 then raise exception 'no se encontró el candado de borrado en cascada'; end if;
  execute replace(d, old, 'current_user in (''vip_app'', (select pg_get_userbyid(p.proowner) from pg_proc p where p.oid = ''app_private.block_mutation_unless_cascade()''::regprocedure))');
end $$;

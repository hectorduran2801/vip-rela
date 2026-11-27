-- Reversión de 0045 (cuentas separadas). NO se aplica sola. Conserva TODOS los datos: solo quita la separación.
-- Requisitos: (1) ninguna cuenta distinta de la principal tiene datos (si los tiene, aborta); (2) volver a poner en packages/excel-import/src/stage.ts `on conflict (file_sha256)`.
set search_path = public, extensions;
begin;
do $$ declare t text; n bigint; begin
  for t in select table_name from information_schema.columns where table_schema = 'public' and column_name = 'account_id' and table_name not in ('app_users', 'account_view') loop
    execute format('select count(*) from public.%I where account_id <> ''00000000-0000-4000-8000-000000000001''', t) into n;
    if n > 0 then raise exception 'La tabla % tiene % filas de otra cuenta: revisa antes de revertir', t, n; end if;
  end loop;
end $$;
do $$ declare r record; begin
  for r in select p.oid::regprocedure f from pg_proc p join pg_roles o on o.oid = p.proowner where o.rolname = 'vip_app' loop execute format('alter function %s owner to postgres', r.f); end loop;
  for r in select tablename, policyname from pg_policies where schemaname = 'public' and (policyname like 'tenant\_%' or policyname = 'vip_app_all') loop execute format('drop policy %I on public.%I', r.policyname, r.tablename); end loop;
  for r in select c.relname from pg_trigger g join pg_class c on c.oid = g.tgrelid where g.tgname = 'zz_account' loop execute format('drop trigger zz_account on public.%I', r.relname); end loop;
end $$;
drop function public.list_accounts();
drop function public.set_account_view(uuid);
drop trigger new_account on public.app_users;
drop function app_private.new_user_account();
drop function app_private.inherit_account();
-- ON CONFLICT y únicos originales.
do $$ declare r record; d text; begin
  for r in select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'app_private') and p.proname in ('save_template_text', 'save_template_variable') loop
    d := pg_get_functiondef(r.oid);
    d := replace(replace(d, 'on conflict (account_id, code) do update', 'on conflict (code) do update'), 'on conflict (account_id, key) do update', 'on conflict (key) do update');
    execute d;
  end loop;
end $$;
do $$ declare r record; begin
  for r in select c.conrelid::regclass::text t, c.conname, c.contype, array_to_string(array(select a.attname from unnest(c.conkey) with ordinality k(n, o) join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.n where a.attname <> 'account_id' order by k.o), ', ') cols
             from pg_constraint c where c.connamespace = 'public'::regnamespace and c.contype in ('u', 'p')
              and exists (select 1 from pg_attribute a where a.attrelid = c.conrelid and a.attnum = any (c.conkey) and a.attname = 'account_id') loop
    execute format('alter table public.%s drop constraint %I', r.t, r.conname);
    execute format('alter table public.%s add constraint %I %s (%s)', r.t, r.conname, case when r.contype = 'p' then 'primary key' else 'unique' end, r.cols);
  end loop;
end $$;
drop index public.units_code_normalized_uq;
create unique index units_code_normalized_uq on public.units (upper(btrim(code)));
drop index public.units_plate_uq;
create unique index units_plate_uq on public.units (upper(plate)) where plate is not null;
do $$ declare t text; begin
  for t in select table_name from information_schema.columns where table_schema = 'public' and column_name = 'account_id' and table_name <> 'account_view' loop
    execute format('alter table public.%I drop column account_id', t);
  end loop;
end $$;
drop table public.account_view;
drop function app_private.current_account();
drop function app_private.own_account();
drop table public.accounts;
commit;

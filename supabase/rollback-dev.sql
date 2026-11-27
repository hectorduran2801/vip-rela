-- ⚠ DESTRUCTIVO. Solo para el proyecto de DESARROLLO: elimina todo lo que crean las migraciones de VIP.
-- No toca auth.* ni storage.*. Ejecutar únicamente si se quiere volver a empezar.
begin;
drop trigger if exists on_auth_user_created on auth.users;
drop schema if exists app_private cascade;
do $$ declare r record; begin
  for r in select viewname from pg_views where schemaname = 'public' loop execute format('drop view if exists public.%I cascade', r.viewname); end loop;
  for r in select tablename from pg_tables where schemaname = 'public' loop execute format('drop table if exists public.%I cascade', r.tablename); end loop;
  for r in select p.oid::regprocedure as sig from pg_proc p where p.pronamespace = 'public'::regnamespace loop execute format('drop function if exists %s cascade', r.sig); end loop;
end $$;
commit;

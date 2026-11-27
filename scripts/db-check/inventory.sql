select 'fn ' || n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' k,
       md5(regexp_replace(regexp_replace(p.prosrc, '--[^\n]*', '', 'g'), '\s+', '', 'g')) || ' ' || pg_get_userbyid(p.proowner) || ' ' || p.prosecdef v
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public','app_private')
   and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
union all select 'col ' || table_name || '.' || column_name, data_type from information_schema.columns where table_schema = 'public'
union all select 'trg ' || c.relname || '.' || t.tgname, regexp_replace(pg_get_triggerdef(t.oid), '\s+', ' ', 'g') from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and not t.tgisinternal
union all select 'pol ' || tablename || '.' || policyname, cmd || ' ' || roles::text from pg_policies where schemaname = 'public'

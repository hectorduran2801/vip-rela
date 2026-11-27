-- Reversión de 0052: quita el resumen (solo datos derivados) y sus disparadores. La API vuelve sola a la consulta anterior. NO se aplica sola.
set search_path = public, extensions;
begin;
do $$ declare r record; begin
  for r in select g.tgname, c.relname from pg_trigger g join pg_class c on c.oid = g.tgrelid where g.tgname in ('summary_ins', 'summary_upd', 'summary_del', 'summary_import') and not g.tgisinternal loop
    execute format('drop trigger %I on public.%I', r.tgname, r.relname);
  end loop;
end $$;
drop function public.refresh_collection_summaries();
drop function public.collection_summary_rows(date);
drop function app_private.summary_after_import();
drop function app_private.mark_collection_dirty();
drop function app_private.ensure_collection_summary(uuid);
drop function app_private.refresh_collection_summary(uuid, date, uuid[]);
drop function app_private.collection_rows_reference(date);
drop function app_private.collection_rows(uuid, date, uuid[]);
drop table public.collection_summary, public.collection_summary_state, public.collection_summary_dirty;
drop index if exists public.payments_account_assignment_idx, public.charges_account_assignment_idx, public.excel_payment_days_account_idx;
commit;

-- Reversión de 0053: vuelve a la forma anterior de las políticas (mismo filtro) y quita los índices. No toca datos. NO se aplica sola.
set search_path = public, extensions;
begin;
do $$ declare r record; q text; c text; begin
  for r in select tablename, policyname, qual, with_check from pg_policies where schemaname = 'public' and policyname like 'tenant%' loop
    q := regexp_replace(r.qual, '\( SELECT app_private\.(\w+)\(\) AS \w+\)', 'app_private.\1()', 'g');
    c := regexp_replace(r.with_check, '\( SELECT app_private\.(\w+)\(\) AS \w+\)', 'app_private.\1()', 'g');
    execute format('alter policy %I on public.%I', r.policyname, r.tablename)
      || case when q is not null then format(' using (%s)', q) else '' end || case when c is not null then format(' with check (%s)', c) else '' end;
  end loop;
end $$;
drop index if exists public.units_account_code_norm_idx, public.audit_logs_entity_action_idx, public.drivers_account_operator_idx, public.drivers_account_nid_idx, public.assignments_unit_from_idx,
  public.rates_assignment_from_idx, public.charges_assignment_week_idx, public.adjustments_assignment_idx, public.payments_assignment_week_idx, public.payment_allocations_charge_idx,
  public.collection_week_units_asg_week_idx, public.rate_corrections_assignment_idx, public.import_rows_block_source_idx;
commit;

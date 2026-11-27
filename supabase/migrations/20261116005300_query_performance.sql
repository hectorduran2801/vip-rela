-- VIP · 0053 · NO APLICAR EN REMOTO sin autorización expresa.
-- Rendimiento sin cambiar ninguna regla:
--   · Las políticas por cuenta evalúan la cuenta UNA vez por consulta («(select …)») en lugar de una vez por fila. El filtro es el mismo.
--   · Índices para las búsquedas que la importación y los cálculos hacen por cada fila (antes recorrían la tabla entera cada vez).
set search_path = public, extensions;

do $$ declare r record; q text; c text; begin
  for r in select tablename, policyname, qual, with_check from pg_policies where schemaname = 'public' and (policyname like 'tenant%') loop
    q := regexp_replace(r.qual, '(?<!SELECT )app_private\.(current_account|own_account)\(\)', '( SELECT app_private.\1())', 'g');
    c := regexp_replace(r.with_check, '(?<!SELECT )app_private\.(current_account|own_account)\(\)', '( SELECT app_private.\1())', 'g');
    execute format('alter policy %I on public.%I', r.policyname, r.tablename)
      || case when q is not null then format(' using (%s)', q) else '' end
      || case when c is not null then format(' with check (%s)', c) else '' end;
  end loop;
end $$;

create index if not exists units_account_code_norm_idx on public.units (account_id, upper(regexp_replace(code, '\s+', '', 'g')));
create index if not exists audit_logs_entity_action_idx on public.audit_logs (entity_id, action) where entity_id is not null;
create index if not exists drivers_account_operator_idx on public.drivers (account_id, operator_code);
create index if not exists drivers_account_nid_idx on public.drivers (account_id, national_id) where national_id is not null;
create index if not exists assignments_unit_from_idx on public.assignments (unit_id, valid_from desc);
create index if not exists rates_assignment_from_idx on public.rates (assignment_id, valid_from);
create index if not exists charges_assignment_week_idx on public.charges (assignment_id, week_start);
create index if not exists adjustments_assignment_idx on public.adjustments (assignment_id);
create index if not exists payments_assignment_week_idx on public.payments (assignment_id, week_start) where voided_at is null;
create index if not exists payment_allocations_charge_idx on public.payment_allocations (charge_id);
create index if not exists collection_week_units_asg_week_idx on public.collection_week_units (assignment_id, week_start desc);
create index if not exists rate_corrections_assignment_idx on public.rate_corrections (assignment_id);
create index if not exists import_rows_block_source_idx on public.import_rows (block_id, source_row);

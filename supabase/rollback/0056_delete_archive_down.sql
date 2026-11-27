-- Reversión de 0056: quita las funciones de eliminar/dar de baja y deja los candados y la auditoría como antes. No toca filas
-- (lo que ya se haya eliminado o dado de baja con ellas no se recupera con este guion).
begin;
drop trigger if exists no_delete on public.charges;
create trigger no_delete before delete on public.charges for each row execute function app_private.block_mutation();
drop trigger if exists immutable_update on public.driver_consents;
drop trigger if exists immutable_delete on public.driver_consents;
create trigger immutable before update or delete on public.driver_consents for each row execute function app_private.block_mutation();
drop trigger if exists no_update on public.unit_agreement_history;
drop trigger if exists no_delete on public.unit_agreement_history;
create trigger no_mutation before update or delete on public.unit_agreement_history for each row execute function app_private.block_mutation();
drop function if exists public.driver_delete_check(uuid);
drop function if exists public.unit_delete_check(uuid);
drop function if exists public.delete_driver(uuid, text);
drop function if exists public.delete_unit(uuid, text);
drop function if exists public.archive_driver(uuid, text, date);
drop function if exists public.archive_unit(uuid, text, date);
drop function if exists public.reactivate_driver(uuid, text);
drop function if exists public.reactivate_unit(uuid, text);
drop function if exists app_private.delete_plan(text, uuid);
drop function if exists app_private.clean_reason(text);
drop function if exists app_private.complete_charges_for_archive(uuid, date);
drop function if exists app_private.end_open_assignments(uuid, uuid, date);
drop function if exists app_private.block_mutation_unless_cascade();
create or replace function app_private.audit_row() returns trigger language plpgsql security definer set search_path = '' as $$
declare v_row jsonb := to_jsonb(coalesce(new, old));
begin
  insert into public.audit_logs(actor, action, entity, entity_id, detail)
  values (auth.uid(), lower(tg_op), tg_table_name, case when (v_row ->> 'id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then (v_row ->> 'id')::uuid end,
          case tg_op when 'INSERT' then jsonb_build_object('new', to_jsonb(new)) when 'DELETE' then jsonb_build_object('old', to_jsonb(old))
                     else jsonb_build_object('old', to_jsonb(old), 'new', to_jsonb(new)) end);
  return coalesce(new, old);
end $$;
commit;

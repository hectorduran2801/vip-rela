-- VIP · 0048 · NO APLICAR EN REMOTO sin autorización expresa.
-- El SUPER_ADMIN puede consultar Y modificar la cuenta seleccionada (antes: solo lectura). Cada operación sobre una cuenta ajena queda auditada
-- (quién, qué tabla, qué operación, sobre qué cuenta). Los demás roles no cambian: solo su cuenta.
set search_path = public, extensions;

create function app_private.audit_cross_account() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is not null and app_private.current_account() is distinct from app_private.own_account() then
    insert into public.audit_logs(actor, action, entity, entity_id, detail, account_id)
    values (auth.uid(), 'super.account_write', tg_table_name, null, jsonb_build_object('operation', lower(tg_op)), app_private.current_account());
  end if;
  return null;
end $$;
revoke all on function app_private.audit_cross_account() from public, anon, authenticated;

do $$ declare r record; begin
  for r in select tablename t from pg_policies where schemaname = 'public' and policyname = 'tenant_insert' and tablename <> 'whatsapp_sessions' loop
    execute format('drop policy tenant_insert on public.%I', r.t);
    execute format('drop policy tenant_update on public.%I', r.t);
    execute format('drop policy tenant_delete on public.%I', r.t);
    execute format('create policy tenant_insert on public.%I as restrictive for insert to authenticated with check (app_private.current_account() is null or account_id = app_private.current_account())', r.t);
    execute format('create policy tenant_update on public.%I as restrictive for update to authenticated using (app_private.current_account() is null or account_id = app_private.current_account()) with check (app_private.current_account() is null or account_id = app_private.current_account())', r.t);
    execute format('create policy tenant_delete on public.%I as restrictive for delete to authenticated using (app_private.current_account() is null or account_id = app_private.current_account())', r.t);
    execute format('create trigger zz_cross_audit after insert or update or delete on public.%I for each statement execute function app_private.audit_cross_account()', r.t);
  end loop;
end $$;

-- VIP · 0046 · NO APLICAR EN REMOTO sin autorización expresa.
-- Requiere confirmar ANTES que el número de WhatsApp conectado es de la cuenta principal (Vanessa); si no, cambiar el dueño más abajo.
--   1. Auditoría por cuenta: cada registro pertenece a la cuenta sobre la que se actuó (actor = quién lo hizo). Nadie lee la de otra cuenta.
--   2. La sesión de WhatsApp tiene dueña: ninguna otra cuenta puede crear envíos; solo la dueña o el SUPER_ADMIN controlan la conexión.
set search_path = public, extensions;

alter table public.audit_logs add column account_id uuid not null default '00000000-0000-4000-8000-000000000001' references public.accounts(id);
alter table public.audit_logs alter column account_id set default coalesce(app_private.current_account(), '00000000-0000-4000-8000-000000000001'::uuid);
create index audit_logs_account_idx on public.audit_logs(account_id);
create policy tenant_read on public.audit_logs as restrictive for select to authenticated using (app_private.current_account() is null or account_id = app_private.current_account());

alter table public.whatsapp_sessions add column account_id uuid references public.accounts(id);
update public.whatsapp_sessions set account_id = '00000000-0000-4000-8000-000000000001';          -- ⚠ dueña = cuenta principal (confirmar)

create function app_private.whatsapp_owner() returns uuid language sql stable security definer set search_path = '' as $$
  select coalesce((select s.account_id from public.whatsapp_sessions s limit 1), '00000000-0000-4000-8000-000000000001'::uuid) $$;
create function app_private.guard_send_owner() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.account_id is distinct from app_private.whatsapp_owner() then
    raise exception 'whatsapp_other_account' using errcode = '42501', detail = 'El WhatsApp conectado pertenece a otra cuenta: no se puede enviar desde esta.';
  end if;
  return new;
end $$;
create trigger zzz_send_owner before insert on public.whatsapp_test_messages for each row execute function app_private.guard_send_owner();   -- después de zz_account

create function app_private.guard_whatsapp_control() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if app_private.own_account() is not null and app_private.own_account() <> app_private.whatsapp_owner() and not app_private.is_super()
     and (new.desired_state is distinct from old.desired_state or new.logout_requested_at is distinct from old.logout_requested_at) then
    raise exception 'whatsapp_other_account' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger guard_owner before update on public.whatsapp_sessions for each row execute function app_private.guard_whatsapp_control();
revoke all on function app_private.whatsapp_owner(), app_private.guard_send_owner(), app_private.guard_whatsapp_control() from public, anon, authenticated;
grant execute on function app_private.whatsapp_owner() to authenticated, service_role, vip_app;

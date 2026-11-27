-- VIP · 0047 · NO APLICAR EN REMOTO sin autorización expresa. Requiere 0046.
-- Una sesión de WhatsApp por cuenta. El `id` de la sesión existente NO cambia (es el sessionId de OpenWA y va en el cifrado del secreto):
-- solo se le asigna su cuenta (la que fijó 0046). Cada cuenta nueva recibe su fila (desconectada: no abre nada hasta pulsar «Conectar»).
set search_path = public, extensions;

drop index public.whatsapp_single_session;
update public.whatsapp_sessions set account_id = '00000000-0000-4000-8000-000000000001' where account_id is null;
alter table public.whatsapp_sessions alter column account_id set not null;
alter table public.whatsapp_sessions alter column account_id set default coalesce(app_private.current_account(), '00000000-0000-4000-8000-000000000001'::uuid);
alter table public.whatsapp_sessions add constraint whatsapp_sessions_one_per_account unique (account_id);

-- Sustituye al candado de 0046 («solo la dueña envía»): ahora cada cuenta envía solo por SU sesión (lo garantiza el worker por account_id).
drop trigger zzz_send_owner on public.whatsapp_test_messages;
drop trigger guard_owner on public.whatsapp_sessions;
drop function app_private.guard_send_owner();
drop function app_private.guard_whatsapp_control();
drop function app_private.whatsapp_owner();

-- Cada cuenta ve y controla solo su sesión. El SUPER_ADMIN controla la de la cuenta seleccionada (queda en auditoría).
create policy tenant_read on public.whatsapp_sessions as restrictive for select to authenticated using (app_private.current_account() is null or account_id = app_private.current_account());
create policy tenant_update on public.whatsapp_sessions as restrictive for update to authenticated
  using (app_private.current_account() is null or account_id = app_private.current_account()) with check (app_private.current_account() is null or account_id = app_private.current_account());
create policy tenant_insert on public.whatsapp_sessions as restrictive for insert to authenticated with check (app_private.current_account() is null or account_id = app_private.current_account());
create policy tenant_delete on public.whatsapp_sessions as restrictive for delete to authenticated using (app_private.own_account() is null);

create function app_private.account_session() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.whatsapp_sessions(label, account_id) values ('Principal', new.id) on conflict (account_id) do nothing;
  return new;
end $$;
create trigger account_session after insert on public.accounts for each row execute function app_private.account_session();
insert into public.whatsapp_sessions(label, account_id) select 'Principal', a.id from public.accounts a on conflict (account_id) do nothing;

-- Conectar / cerrar sesión: siempre sobre la cuenta en pantalla.
create or replace function public.request_whatsapp_connection(p_desired text) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_acc uuid;
begin
  perform app_private.assert_admin();
  v_acc := app_private.current_account();
  if p_desired not in ('connected', 'disconnected') then raise exception 'invalid_state' using errcode = '22023'; end if;
  update public.whatsapp_sessions set desired_state = p_desired, last_error = null, updated_at = now() where account_id = v_acc;
  if not found then raise exception 'session_not_found' using errcode = 'P0002'; end if;
  perform app_private.audit('request_whatsapp_' || p_desired, 'whatsapp_sessions', null, '{}');
  return (select jsonb_build_object('id', id, 'status', status, 'desired_state', desired_state, 'worker_heartbeat_at', worker_heartbeat_at) from public.whatsapp_sessions where account_id = v_acc);
end $$;
create or replace function public.request_whatsapp_logout() returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_acc uuid;
begin
  perform app_private.assert_admin();
  v_acc := app_private.current_account();
  update public.whatsapp_sessions set desired_state = 'disconnected', logout_requested_at = coalesce(logout_requested_at, now()), last_error = null, updated_at = now() where account_id = v_acc;
  if not found then raise exception 'session_not_found' using errcode = 'P0002'; end if;
  perform app_private.audit('request_whatsapp_logout', 'whatsapp_sessions', null, '{}');
  return (select jsonb_build_object('id', id, 'status', status, 'desired_state', desired_state, 'logout_requested_at', logout_requested_at) from public.whatsapp_sessions where account_id = v_acc);
end $$;

-- Cola: turno rotativo (primero la cuenta que lleva más tiempo sin ser atendida), para que una tanda grande no retrase en bloque a las otras.
do $$ declare d text; old text := 'select id from public.whatsapp_test_messages where status = ''prepared'' order by created_at limit 1 for update skip locked';
begin
  d := pg_get_functiondef('public.claim_test_message()'::regprocedure);
  if position(old in d) = 0 then raise exception 'no se encontró la reclamación de mensajes'; end if;
  execute replace(d, old, 'select q.id from public.whatsapp_test_messages q where q.status = ''prepared''
       order by (select max(p.claimed_at) from public.whatsapp_test_messages p where p.account_id = q.account_id) nulls first, q.created_at limit 1 for update skip locked');
end $$;
alter function public.request_whatsapp_connection(text) owner to vip_app;
alter function public.request_whatsapp_logout() owner to vip_app;
revoke all on function app_private.account_session() from public, anon, authenticated;

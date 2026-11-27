-- VIP · 0017 · «Resultado sin confirmar» para mensajes de prueba. Cuando OpenWA no puede determinar si WhatsApp aceptó el mensaje
-- (error `sendText could not confirm the result… may have been sent`, tiempo de espera, etc.) NO es un fallo definitivo: puede haberse enviado.
-- Estados: prepared (en cola) · processing (enviando) · simulated · sent (aceptado por el proveedor) · delivered (acuse real) ·
--          failed (fallo CONFIRMADO: no salió) · unconfirmed (incierto) · cancelled.
-- Un mensaje real incierto NO se reenvía ni se reintenta; bloquea nuevos envíos reales hasta que un SUPER_ADMIN lo resuelva tras revisar el chat.
set search_path = public, extensions;

alter table public.whatsapp_test_messages drop constraint whatsapp_test_messages_status_check;
alter table public.whatsapp_test_messages add constraint whatsapp_test_messages_status_check
  check (status in ('prepared', 'processing', 'simulated', 'sent', 'delivered', 'failed', 'unconfirmed', 'cancelled'));
alter table public.whatsapp_test_messages
  add column error_detail text check (length(error_detail) <= 1000),     -- detalle técnico (sin secretos) para mostrar plegado
  add column resolved_by uuid references public.profiles(id),
  add column resolved_at timestamptz,
  add column resolution_note text check (length(resolution_note) <= 300);

-- Lo que ya quedó como «failed» con el aviso de OpenWA era incierto, no un fallo confirmado.
update public.whatsapp_test_messages set status = 'unconfirmed'
 where status = 'failed' and requested_mode = 'real' and (error ilike '%could not confirm the result%' or error ilike '%timeout enviando%');

drop function public.complete_test_message(uuid, text, text, text, text);
create function public.complete_test_message(p_id uuid, p_outcome text, p_sender text default null, p_provider_id text default null,
  p_error text default null, p_detail text default null)
returns public.whatsapp_test_messages language plpgsql security definer set search_path = '' as $$
declare r public.whatsapp_test_messages;
begin
  if not app_private.is_service() then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_outcome not in ('simulated', 'sent', 'failed', 'unconfirmed') then raise exception 'invalid_outcome' using errcode = '22023'; end if;
  update public.whatsapp_test_messages set status = p_outcome, sender_phone = p_sender, provider_message_id = p_provider_id,
         error = left(p_error, 500), error_detail = left(p_detail, 1000), processed_at = now()
   where id = p_id and status = 'processing' returning * into r;
  if not found then raise exception 'not_processing' using errcode = '55000'; end if;
  if p_outcome = 'sent' and r.requested_mode <> 'real' then raise exception 'sent_requires_real_mode' using errcode = '22023'; end if;
  if p_outcome = 'unconfirmed' and r.requested_mode <> 'real' then raise exception 'unconfirmed_requires_real_mode' using errcode = '22023'; end if;
  perform app_private.audit('whatsapp.test_message.' || p_outcome, 'whatsapp_test_message', r.id, jsonb_build_object('mode', r.requested_mode, 'has_error', p_error is not null));
  return r;
end $$;

-- Un SUPER_ADMIN resuelve un resultado incierto TRAS REVISAR el chat: «sent» (llegó) o «failed» (no llegó). Queda constancia y auditoría.
create function public.resolve_test_message(p_id uuid, p_arrived boolean, p_note text default null)
returns public.whatsapp_test_messages language plpgsql security definer set search_path = '' as $$
declare r public.whatsapp_test_messages;
begin
  perform app_private.assert_super();
  update public.whatsapp_test_messages set status = case when p_arrived then 'sent' else 'failed' end, resolved_by = auth.uid(), resolved_at = now(),
         resolution_note = nullif(btrim(left(p_note, 300)), '')
   where id = p_id and status = 'unconfirmed' returning * into r;
  if not found then raise exception 'not_unconfirmed' using errcode = '55000'; end if;
  perform app_private.audit('whatsapp.test_message.resolved', 'whatsapp_test_message', r.id, jsonb_build_object('arrived', p_arrived));
  return r;
end $$;

-- create_test_message: un real incierto sin resolver bloquea nuevos envíos reales (evita duplicados).
create or replace function public.create_test_message(p_phone text, p_body text, p_mode text, p_idempotency_key text,
  p_recipient_authorization text default null, p_confirm_last4 text default null, p_kind text default 'test')
returns public.whatsapp_test_messages language plpgsql security definer set search_path = '' as $$
declare v_phone text; r public.whatsapp_test_messages; v_user uuid := auth.uid();
begin
  perform app_private.assert_super();
  if p_mode not in ('simulated', 'real') then raise exception 'invalid_mode' using errcode = '22023'; end if;
  select * into r from public.whatsapp_test_messages where idempotency_key = p_idempotency_key;
  if found then return r; end if;
  v_phone := app_private.normalize_phone(p_phone);
  if exists (select 1 from public.drivers d where d.phone_e164 = v_phone) then raise exception 'recipient_is_a_driver' using errcode = '42501'; end if;
  if p_mode = 'real' then
    if length(btrim(coalesce(p_recipient_authorization, ''))) < 3 then raise exception 'recipient_authorization_required' using errcode = '22023'; end if;
    if p_confirm_last4 is distinct from right(v_phone, 4) then raise exception 'confirm_last4_mismatch' using errcode = '22023'; end if;
    if exists (select 1 from public.whatsapp_test_messages where requested_mode = 'real' and status in ('prepared', 'processing')) then
      raise exception 'real_test_already_pending' using errcode = '55000'; end if;
    if exists (select 1 from public.whatsapp_test_messages where requested_mode = 'real' and status = 'unconfirmed') then
      raise exception 'unconfirmed_result_pending' using errcode = '55000'; end if;
  end if;
  insert into public.whatsapp_test_messages(kind, recipient_phone, body, requested_mode, authorized_by, recipient_authorization, idempotency_key)
    values (p_kind, v_phone, btrim(p_body), p_mode, v_user, nullif(btrim(p_recipient_authorization), ''), p_idempotency_key) returning * into r;
  perform app_private.audit('whatsapp.test_message.created', 'whatsapp_test_message', r.id, jsonb_build_object('mode', p_mode, 'recipient_last4', right(v_phone, 4), 'kind', p_kind));
  return r;
end $$;

-- fail_stuck_test_messages: un REAL atascado en «processing» tras una caída es INCIERTO (pudo salir), no un fallo.
create or replace function public.fail_stuck_test_messages(p_older interval default '5 minutes') returns int
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  if not app_private.is_service() then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.whatsapp_test_messages
     set status = case when requested_mode = 'real' then 'unconfirmed' else 'failed' end, processed_at = now(),
         error = case when requested_mode = 'real' then 'interrumpido durante el envío: el mensaje pudo haberse enviado; no se reintenta' else 'interrumpido: no se reintenta para evitar duplicados' end
   where status = 'processing' and claimed_at < now() - p_older;
  get diagnostics n = row_count; return n;
end $$;

revoke all on function public.complete_test_message(uuid, text, text, text, text, text), public.resolve_test_message(uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.complete_test_message(uuid, text, text, text, text, text) to service_role;
grant execute on function public.resolve_test_message(uuid, boolean, text) to authenticated, service_role;

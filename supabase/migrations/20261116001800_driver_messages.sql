-- VIP · 0018 · Mensajes individuales a conductores REGISTRADOS (flujo simple) y envío de prueba externo simplificado.
-- · El número sale de la ficha del conductor; la autorización es el consentimiento de COBRANZA documentado en la ficha (no se vuelve a pedir en cada envío).
-- · Sin consentimiento vigente, sin teléfono o con el conductor inactivo: el backend BLOQUEA el envío (aunque la interfaz lo permitiera).
-- · El modo (simulado/real) lo decide el worker según WHATSAPP_DRY_RUN: la administradora no elige ni ve «dry-run».
-- · Prueba externa (número no registrado): ya no exige los últimos 4 dígitos; sigue exigiendo la declaración del destinatario y un solo real pendiente.
-- · Se conservan idempotencia, historial, estados confirmados/inciertos, y el límite de separación mínima entre mensajes por conductor.
set search_path = public, extensions;

alter table public.whatsapp_test_messages drop constraint whatsapp_test_messages_kind_check;
alter table public.whatsapp_test_messages add constraint whatsapp_test_messages_kind_check check (kind in ('test', 'payment_receipt_preview', 'driver_message'));
alter table public.whatsapp_test_messages drop constraint whatsapp_test_messages_requested_mode_check;
alter table public.whatsapp_test_messages add constraint whatsapp_test_messages_requested_mode_check check (requested_mode in ('simulated', 'real', 'auto'));
alter table public.whatsapp_test_messages drop constraint whatsapp_test_messages_check;
alter table public.whatsapp_test_messages add constraint whatsapp_test_messages_check
  check (requested_mode in ('simulated', 'auto') or length(btrim(coalesce(recipient_authorization, ''))) >= 3);
alter table public.whatsapp_test_messages add column driver_id uuid references public.drivers(id);
alter table public.whatsapp_test_messages add constraint whatsapp_test_messages_driver_check
  check ((kind = 'driver_message') = (driver_id is not null) and (kind <> 'driver_message' or requested_mode = 'auto'));
create index whatsapp_test_messages_driver on public.whatsapp_test_messages(driver_id, created_at desc) where driver_id is not null;

-- ADMIN ve los mensajes a conductores; los de prueba externos siguen siendo solo de SUPER_ADMIN.
drop policy wtm_select on public.whatsapp_test_messages;
create policy wtm_select on public.whatsapp_test_messages for select to authenticated
  using (app_private.is_super() or (kind = 'driver_message' and app_private.is_admin()));

-- Prueba externa: sin últimos 4 dígitos (si se envían, deben coincidir).
create or replace function public.create_test_message(p_phone text, p_body text, p_mode text, p_idempotency_key text,
  p_recipient_authorization text default null, p_confirm_last4 text default null, p_kind text default 'test')
returns public.whatsapp_test_messages language plpgsql security definer set search_path = '' as $$
declare v_phone text; r public.whatsapp_test_messages; v_user uuid := auth.uid();
begin
  perform app_private.assert_super();
  if p_mode not in ('simulated', 'real') then raise exception 'invalid_mode' using errcode = '22023'; end if;
  if p_kind not in ('test', 'payment_receipt_preview') then raise exception 'invalid_kind' using errcode = '22023'; end if;
  select * into r from public.whatsapp_test_messages where idempotency_key = p_idempotency_key;
  if found then return r; end if;
  v_phone := app_private.normalize_phone(p_phone);
  if exists (select 1 from public.drivers d where d.phone_e164 = v_phone) then raise exception 'recipient_is_a_driver' using errcode = '42501'; end if;
  if p_mode = 'real' then
    if length(btrim(coalesce(p_recipient_authorization, ''))) < 3 then raise exception 'recipient_authorization_required' using errcode = '22023'; end if;
    if p_confirm_last4 is not null and p_confirm_last4 is distinct from right(v_phone, 4) then raise exception 'confirm_last4_mismatch' using errcode = '22023'; end if;
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

-- Mensaje individual a un conductor registrado (ADMIN o SUPER_ADMIN).
create function public.create_driver_message(p_driver uuid, p_body text, p_idempotency_key text) returns public.whatsapp_test_messages
language plpgsql security definer set search_path = '' as $$
declare d public.drivers; r public.whatsapp_test_messages; v_min int;
begin
  perform app_private.assert_admin();
  if p_idempotency_key is null or length(btrim(p_idempotency_key)) < 8 then raise exception 'idempotency_key_required' using errcode = '22023'; end if;
  select * into r from public.whatsapp_test_messages where idempotency_key = p_idempotency_key;
  if found then
    if r.driver_id is distinct from p_driver then raise exception 'idempotency_conflict' using errcode = '23505'; end if;
    return r;
  end if;
  if length(btrim(coalesce(p_body, ''))) = 0 or length(p_body) > 1000 then raise exception 'invalid_body' using errcode = '22023'; end if;
  select * into d from public.drivers where id = p_driver for update;                         -- serializa envíos al mismo conductor
  if not found then raise exception 'driver_not_found' using errcode = 'P0002'; end if;
  if d.status <> 'active' then raise exception 'driver_inactive' using errcode = '55000'; end if;
  if d.phone_e164 is null then raise exception 'driver_without_phone' using errcode = '23514'; end if;
  if not d.whatsapp_consent then raise exception 'consent_required' using errcode = '42501'; end if;       -- sin autorización de cobranza vigente: no se envía
  if exists (select 1 from public.whatsapp_test_messages where driver_id = p_driver and status = 'unconfirmed') then
    raise exception 'unconfirmed_result_pending' using errcode = '55000'; end if;                           -- hay un envío incierto a este conductor: revisar antes
  select min_minutes_between into v_min from public.app_settings;
  if exists (select 1 from public.whatsapp_test_messages where driver_id = p_driver and status in ('prepared', 'processing', 'sent', 'delivered', 'simulated', 'unconfirmed')
             and created_at > now() - make_interval(mins => v_min)) then
    raise exception 'too_soon' using errcode = '55000'; end if;                                             -- separación mínima configurada
  insert into public.whatsapp_test_messages(kind, recipient_phone, body, requested_mode, authorized_by, idempotency_key, driver_id)
    values ('driver_message', d.phone_e164, btrim(p_body), 'auto', auth.uid(), p_idempotency_key, p_driver) returning * into r;
  perform app_private.audit('whatsapp.driver_message.created', 'whatsapp_test_message', r.id, jsonb_build_object('driver_id', p_driver));
  return r;
end $$;

-- El worker: un mensaje a conductor cuyo consentimiento se retiró ANTES de enviarse se cancela (verificación final).
create or replace function public.claim_test_message() returns public.whatsapp_test_messages
language plpgsql security definer set search_path = '' as $$
declare r public.whatsapp_test_messages;
begin
  if not app_private.is_service() then raise exception 'forbidden' using errcode = '42501'; end if;
  loop
    update public.whatsapp_test_messages m set status = 'processing', claimed_at = now()
     where m.id = (select id from public.whatsapp_test_messages where status = 'prepared' order by created_at limit 1 for update skip locked)
    returning m.* into r;
    exit when r.id is null;
    if r.kind = 'driver_message' and not exists (select 1 from public.drivers d where d.id = r.driver_id and d.whatsapp_consent and d.status = 'active' and d.phone_e164 = r.recipient_phone) then
      update public.whatsapp_test_messages set status = 'cancelled', processed_at = now(), error = 'cancelado: el conductor ya no tiene autorización vigente' where id = r.id;
      continue;
    end if;
    return r;
  end loop;
  return null;
end $$;

create or replace function public.complete_test_message(p_id uuid, p_outcome text, p_sender text default null, p_provider_id text default null,
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
  if p_outcome = 'sent' and r.requested_mode = 'simulated' then raise exception 'sent_requires_real_mode' using errcode = '22023'; end if;
  if p_outcome = 'unconfirmed' and r.requested_mode = 'simulated' then raise exception 'unconfirmed_requires_real_mode' using errcode = '22023'; end if;
  perform app_private.audit('whatsapp.test_message.' || p_outcome, 'whatsapp_test_message', r.id, jsonb_build_object('mode', r.requested_mode, 'has_error', p_error is not null));
  return r;
end $$;

create or replace function public.fail_stuck_test_messages(p_older interval default '5 minutes') returns int
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  if not app_private.is_service() then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.whatsapp_test_messages
     set status = case when requested_mode in ('real', 'auto') then 'unconfirmed' else 'failed' end, processed_at = now(),
         error = case when requested_mode in ('real', 'auto') then 'interrumpido durante el envío: el mensaje pudo haberse enviado; no se reintenta' else 'interrumpido: no se reintenta para evitar duplicados' end
   where status = 'processing' and claimed_at < now() - p_older;
  get diagnostics n = row_count; return n;
end $$;

-- Resolver un incierto: ADMIN puede los de conductores; SUPER_ADMIN todos.
create or replace function public.resolve_test_message(p_id uuid, p_arrived boolean, p_note text default null)
returns public.whatsapp_test_messages language plpgsql security definer set search_path = '' as $$
declare r public.whatsapp_test_messages; k text;
begin
  select kind into k from public.whatsapp_test_messages where id = p_id;
  if k = 'driver_message' then perform app_private.assert_admin(); else perform app_private.assert_super(); end if;
  update public.whatsapp_test_messages set status = case when p_arrived then 'sent' else 'failed' end, resolved_by = auth.uid(), resolved_at = now(),
         resolution_note = nullif(btrim(left(p_note, 300)), '')
   where id = p_id and status = 'unconfirmed' returning * into r;
  if not found then raise exception 'not_unconfirmed' using errcode = '55000'; end if;
  perform app_private.audit('whatsapp.test_message.resolved', 'whatsapp_test_message', r.id, jsonb_build_object('arrived', p_arrived));
  return r;
end $$;

-- Cancelar un preparado: ADMIN los de conductores.
create or replace function public.cancel_test_message(p_id uuid) returns public.whatsapp_test_messages
language plpgsql security definer set search_path = '' as $$
declare r public.whatsapp_test_messages; k text;
begin
  select kind into k from public.whatsapp_test_messages where id = p_id;
  if k = 'driver_message' then perform app_private.assert_admin(); else perform app_private.assert_super(); end if;
  update public.whatsapp_test_messages set status = 'cancelled', processed_at = now() where id = p_id and status = 'prepared' returning * into r;
  if not found then raise exception 'not_cancellable' using errcode = '55000'; end if;
  return r;
end $$;

revoke all on function public.create_driver_message(uuid, text, text) from public, anon, authenticated;
grant execute on function public.create_driver_message(uuid, text, text) to authenticated, service_role;

-- VIP · 0012 · Mensajes de prueba individuales por WhatsApp (solo SUPER_ADMIN). No toca la cola de cobranza ni a los conductores.
-- Estados: prepared (creado y confirmado) → processing → simulated | sent (aceptado por el proveedor) | failed ; delivered SOLO si OpenWA informa un acuse.
-- "sent" NUNCA significa entregado. El envío REAL exige: modo real pedido + declaración de autorización del destinatario + confirmación de los
-- últimos 4 dígitos + interruptor explícito del worker (WHATSAPP_ALLOW_REAL_TEST). Cada mensaje real es una única operación para un único destinatario.
set search_path = public, extensions;

create table public.whatsapp_test_messages (
  id uuid primary key default gen_random_uuid(),
  kind text not null default 'test' check (kind in ('test', 'payment_receipt_preview')),
  recipient_phone text not null check (recipient_phone ~ '^\+[1-9][0-9]{7,14}$'),
  body text not null check (length(btrim(body)) > 0 and length(body) <= 1000),
  requested_mode text not null check (requested_mode in ('simulated', 'real')),
  status text not null default 'prepared' check (status in ('prepared', 'processing', 'simulated', 'sent', 'delivered', 'failed', 'cancelled')),
  sender_phone text,                          -- número emisor (el vinculado) en el momento del procesamiento
  provider_message_id text,                   -- id devuelto por OpenWA (o simulado)
  error text,                                 -- error técnico sin secretos
  authorized_by uuid not null references public.profiles(id),   -- quien autorizó la prueba
  recipient_authorization text,               -- quién autoriza recibirla (nombre) — obligatorio en modo real
  idempotency_key text not null unique,
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  processed_at timestamptz,
  delivered_at timestamptz,
  check (requested_mode = 'simulated' or length(btrim(coalesce(recipient_authorization, ''))) >= 3)
);
create index whatsapp_test_messages_status on public.whatsapp_test_messages(status, created_at);

-- Inmutable salvo lo que escribe el worker mediante las funciones de abajo (sin updates directos para nadie).
alter table public.whatsapp_test_messages enable row level security;
create policy wtm_select on public.whatsapp_test_messages for select to authenticated using (app_private.is_super());
revoke all on public.whatsapp_test_messages from public, anon, authenticated;
grant select on public.whatsapp_test_messages to authenticated;
grant all on public.whatsapp_test_messages to service_role;

-- Normaliza a E.164 (solo dígitos tras '+'); lanza invalid_phone si no es plausible.
create function app_private.normalize_phone(p text) returns text language plpgsql immutable set search_path = '' as $$
declare d text := regexp_replace(coalesce(p, ''), '[^0-9]', '', 'g');
begin
  if d !~ '^[1-9][0-9]{7,14}$' then raise exception 'invalid_phone' using errcode = '22023'; end if;
  return '+' || d;
end $$;

-- Texto del comprobante, idéntico al que genera prepare_notification_send (se verifica en pruebas).
create function app_private.receipt_body(p_unit text, p_method text, p_gross bigint, p_commission bigint, p_net bigint, p_pending bigint, p_credit bigint)
returns text language sql immutable set search_path = '' as $$
  select E'Estimado conductor, hemos registrado su pago correctamente.\nUnidad: ' || p_unit || E'\nMétodo: ' || p_method
    || E'\nMonto entregado: ' || app_private.fmt_usd(p_gross)
    || case when p_commission > 0 then E'\nComisión del proveedor: ' || app_private.fmt_usd(p_commission) else '' end
    || E'\nAbono a su cuenta: ' || app_private.fmt_usd(p_net)
    || case when p_pending > 0 then E'\nSaldo pendiente: ' || app_private.fmt_usd(p_pending)
            when p_credit > 0 then E'\nSaldo a favor: ' || app_private.fmt_usd(p_credit) else E'\nSu cuenta está al día.' end || E'\nGracias por su pago.'
$$;

-- Vista previa del comprobante con DATOS DE PRUEBA: no consulta ni modifica ningún conductor ni pago.
create function public.preview_payment_receipt(p_unit text, p_method_code text, p_gross_cents bigint, p_pending_before_cents bigint)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare pm record; v_comm bigint; v_net bigint; v_applied bigint; v_pending bigint; v_credit bigint;
begin
  perform app_private.assert_super();
  select * into pm from public.payment_methods where code = p_method_code and active;
  if not found then raise exception 'method_not_found' using errcode = 'P0002'; end if;
  if p_gross_cents <= 0 or p_pending_before_cents < 0 then raise exception 'invalid_amount' using errcode = '22023'; end if;
  v_comm := least(pm.commission_cents, p_gross_cents); v_net := p_gross_cents - v_comm;
  v_applied := least(v_net, p_pending_before_cents); v_pending := p_pending_before_cents - v_applied; v_credit := v_net - v_applied;
  return jsonb_build_object('gross_cents', p_gross_cents, 'commission_cents', v_comm, 'net_cents', v_net, 'pending_cents', v_pending, 'credit_cents', v_credit,
    'body', app_private.receipt_body(p_unit, pm.label, p_gross_cents, v_comm, v_net, v_pending, v_credit));
end $$;

-- Crear = confirmar el envío (la vista previa ocurre antes, en la pantalla). Idempotente por clave.
create function public.create_test_message(p_phone text, p_body text, p_mode text, p_idempotency_key text,
  p_recipient_authorization text default null, p_confirm_last4 text default null, p_kind text default 'test')
returns public.whatsapp_test_messages language plpgsql security definer set search_path = '' as $$
declare v_phone text; r public.whatsapp_test_messages; v_user uuid := auth.uid();
begin
  perform app_private.assert_super();
  if p_mode not in ('simulated', 'real') then raise exception 'invalid_mode' using errcode = '22023'; end if;
  select * into r from public.whatsapp_test_messages where idempotency_key = p_idempotency_key;
  if found then return r; end if;
  v_phone := app_private.normalize_phone(p_phone);
  -- Jamás a un conductor: si el número pertenece a alguien de la base, se rechaza.
  if exists (select 1 from public.drivers d where d.phone_e164 = v_phone) then raise exception 'recipient_is_a_driver' using errcode = '42501'; end if;
  if p_mode = 'real' then
    if length(btrim(coalesce(p_recipient_authorization, ''))) < 3 then raise exception 'recipient_authorization_required' using errcode = '22023'; end if;
    if p_confirm_last4 is distinct from right(v_phone, 4) then raise exception 'confirm_last4_mismatch' using errcode = '22023'; end if;
    -- Una sola operación real pendiente a la vez: evita cualquier ráfaga.
    if exists (select 1 from public.whatsapp_test_messages where requested_mode = 'real' and status in ('prepared', 'processing')) then
      raise exception 'real_test_already_pending' using errcode = '55000'; end if;
  end if;
  insert into public.whatsapp_test_messages(kind, recipient_phone, body, requested_mode, authorized_by, recipient_authorization, idempotency_key)
    values (p_kind, v_phone, btrim(p_body), p_mode, v_user, nullif(btrim(p_recipient_authorization), ''), p_idempotency_key) returning * into r;
  perform app_private.audit('whatsapp.test_message.created', 'whatsapp_test_message', r.id, jsonb_build_object('mode', p_mode, 'recipient_last4', right(v_phone, 4), 'kind', p_kind));
  return r;
end $$;

create function public.cancel_test_message(p_id uuid) returns public.whatsapp_test_messages
language plpgsql security definer set search_path = '' as $$
declare r public.whatsapp_test_messages;
begin
  perform app_private.assert_super();
  update public.whatsapp_test_messages set status = 'cancelled', processed_at = now() where id = p_id and status = 'prepared' returning * into r;
  if not found then raise exception 'not_cancellable' using errcode = '55000'; end if;
  return r;
end $$;

-- ───────── Worker (solo service_role) ─────────
create function public.claim_test_message() returns public.whatsapp_test_messages
language plpgsql security definer set search_path = '' as $$
declare r public.whatsapp_test_messages;
begin
  if not app_private.is_service() then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.whatsapp_test_messages m set status = 'processing', claimed_at = now()
   where m.id = (select id from public.whatsapp_test_messages where status = 'prepared' order by created_at limit 1 for update skip locked)
  returning m.* into r;
  return r;                                    -- null si no hay nada
end $$;

-- outcome: simulated | sent | failed. Solo desde 'processing' (una operación, un resultado).
create function public.complete_test_message(p_id uuid, p_outcome text, p_sender text default null, p_provider_id text default null, p_error text default null)
returns public.whatsapp_test_messages language plpgsql security definer set search_path = '' as $$
declare r public.whatsapp_test_messages;
begin
  if not app_private.is_service() then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_outcome not in ('simulated', 'sent', 'failed') then raise exception 'invalid_outcome' using errcode = '22023'; end if;
  update public.whatsapp_test_messages set status = p_outcome, sender_phone = p_sender, provider_message_id = p_provider_id,
         error = left(p_error, 500), processed_at = now()
   where id = p_id and status = 'processing' returning * into r;
  if not found then raise exception 'not_processing' using errcode = '55000'; end if;
  if p_outcome = 'sent' and r.requested_mode <> 'real' then raise exception 'sent_requires_real_mode' using errcode = '22023'; end if;
  perform app_private.audit('whatsapp.test_message.' || p_outcome, 'whatsapp_test_message', r.id, jsonb_build_object('mode', r.requested_mode, 'has_error', p_error is not null));
  return r;
end $$;

-- Acuse de entrega informado por el proveedor (si OpenWA lo entrega). Sin acuse, jamás se marca delivered.
create function public.ack_test_message(p_provider_id text) returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if not app_private.is_service() then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.whatsapp_test_messages set status = 'delivered', delivered_at = now() where provider_message_id = p_provider_id and status = 'sent';
  return found;
end $$;

-- Recupera mensajes atascados en processing tras una caída. NUNCA los reintenta (un real pudo haberse enviado): los marca failed.
create function public.fail_stuck_test_messages(p_older interval default '5 minutes') returns int
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  if not app_private.is_service() then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.whatsapp_test_messages set status = 'failed', processed_at = now(), error = 'interrumpido: no se reintenta para evitar duplicados'
   where status = 'processing' and claimed_at < now() - p_older;
  get diagnostics n = row_count; return n;
end $$;

-- Permisos: el cliente solo ve y crea; las funciones del worker son solo service_role.
revoke all on function app_private.normalize_phone(text), app_private.receipt_body(text, text, bigint, bigint, bigint, bigint, bigint) from public, anon;
grant execute on function app_private.normalize_phone(text), app_private.receipt_body(text, text, bigint, bigint, bigint, bigint, bigint) to authenticated, service_role;
revoke all on function public.preview_payment_receipt(text, text, bigint, bigint), public.create_test_message(text, text, text, text, text, text, text),
  public.cancel_test_message(uuid), public.claim_test_message(), public.complete_test_message(uuid, text, text, text, text),
  public.ack_test_message(text), public.fail_stuck_test_messages(interval) from public, anon, authenticated;
grant execute on function public.preview_payment_receipt(text, text, bigint, bigint), public.create_test_message(text, text, text, text, text, text, text),
  public.cancel_test_message(uuid) to authenticated, service_role;
grant execute on function public.claim_test_message(), public.complete_test_message(uuid, text, text, text, text),
  public.ack_test_message(text), public.fail_stuck_test_messages(interval) to service_role;

-- El worker informa en cada latido en qué modo de envío corre (la API y el encabezado lo muestran SEPARADO de «conectado»).
alter table public.whatsapp_sessions
  add column worker_dry_run boolean,                 -- true = los envíos de cobranza están simulados (WHATSAPP_DRY_RUN)
  add column worker_real_test_enabled boolean;       -- true = el worker admite UN mensaje de prueba real autorizado

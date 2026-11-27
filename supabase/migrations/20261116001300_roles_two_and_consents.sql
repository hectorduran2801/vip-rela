-- VIP · 0013 · Dos roles funcionales (SUPER_ADMIN y ADMIN) + consentimientos de WhatsApp con evidencia, retiro y finalidades separadas.
set search_path = public, extensions;

-- ───────── 1. Roles ─────────
-- El valor 'supervisor' del enum NO se elimina (Postgres no permite quitar valores y no se borra ninguna fila): queda como heredado.
-- Nadie puede ser asignado a 'supervisor' desde ahora. Quien lo tenga conserva SOLO lectura hasta que un SUPER_ADMIN lo reclasifique
-- a mano con set_app_user (ADMIN o SUPER_ADMIN): ningún permiso superior se otorga automáticamente.
create or replace function public.set_app_user(p_email text, p_role text) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_role public.app_role;
begin
  perform app_private.assert_super();
  begin v_role := p_role::public.app_role; exception when invalid_text_representation then raise exception 'invalid_role' using errcode = '22023'; end;
  if v_role = 'supervisor' then raise exception 'role_deprecated' using errcode = '22023'; end if;
  select p.id into v_id from public.profiles p where lower(p.email) = lower(btrim(p_email));
  if v_id is null then raise exception 'user_not_found' using errcode = 'P0002'; end if;
  if v_id = auth.uid() and v_role <> 'super_admin' and (select count(*) from public.app_users where role = 'super_admin') <= 1 then
    raise exception 'last_super_admin' using errcode = '23514'; end if;
  insert into public.app_users(user_id, role, created_by) values (v_id, v_role, auth.uid()) on conflict (user_id) do update set role = excluded.role;
  if not exists (select 1 from public.app_users where role = 'super_admin') then raise exception 'last_super_admin' using errcode = '23514'; end if;
  perform app_private.audit('set_app_user', 'app_users', v_id, jsonb_build_object('role', v_role));
  return jsonb_build_object('user_id', v_id, 'role', v_role);
end $$;

-- ───────── 2. Consentimientos ─────────
-- Finalidades distintas: 'collection' = recordatorios y comprobantes de cobranza; 'promotional' = campañas. Una NO implica la otra.
alter table public.drivers
  add column whatsapp_consent_source text,
  add column promotional_consent boolean not null default false,
  add column promotional_consent_at timestamptz;

create table public.driver_consents (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid not null references public.drivers(id),
  purpose text not null check (purpose in ('collection', 'promotional')),
  granted boolean not null,                              -- true = autoriza; false = retira
  source text not null check (source in ('verbal_admin', 'driver_message', 'signed_form', 'import_declaration', 'legacy_unverified', 'withdrawal', 'other')),
  evidence text check (length(evidence) <= 500),         -- referencia a la constancia (no el contenido privado)
  recorded_by uuid references public.profiles(id),
  recorded_at timestamptz not null default now(),
  check (granted or source in ('withdrawal', 'verbal_admin', 'driver_message', 'signed_form', 'other')),
  check (not granted or source <> 'withdrawal')
);
create index driver_consents_driver on public.driver_consents(driver_id, purpose, recorded_at desc);
create trigger immutable before update or delete on public.driver_consents for each row execute function app_private.block_mutation();
alter table public.driver_consents enable row level security;
create policy driver_consents_select on public.driver_consents for select to authenticated using (app_private.is_staff());
revoke all on public.driver_consents from public, anon, authenticated;
grant select on public.driver_consents to authenticated;
grant all on public.driver_consents to service_role;

-- Constancia para lo que ya estaba marcado antes de existir este registro (no se cambia su estado: solo se deja visible que NO tiene evidencia).
insert into public.driver_consents(driver_id, purpose, granted, source, evidence)
  select id, 'collection', true, 'legacy_unverified', 'marcado antes del registro de consentimientos; sin constancia verificada' from public.drivers where whatsapp_consent;
update public.drivers set whatsapp_consent_source = 'legacy_unverified' where whatsapp_consent;

-- Un cliente (authenticated) ya NO puede tocar las columnas de consentimiento directamente: solo con set_driver_consent (con origen).
create function app_private.guard_consent() returns trigger language plpgsql as $$
begin
  if current_user = 'authenticated' then
    if tg_op = 'INSERT' and (new.whatsapp_consent or new.promotional_consent) then raise exception 'consent_requires_declaration' using errcode = '42501'; end if;
    if tg_op = 'UPDATE' and (new.whatsapp_consent is distinct from old.whatsapp_consent or new.whatsapp_consent_at is distinct from old.whatsapp_consent_at
        or new.whatsapp_consent_source is distinct from old.whatsapp_consent_source or new.promotional_consent is distinct from old.promotional_consent
        or new.promotional_consent_at is distinct from old.promotional_consent_at) then raise exception 'consent_requires_declaration' using errcode = '42501'; end if;
  end if;
  return new;
end $$;
create trigger guard_consent before insert or update on public.drivers for each row execute function app_private.guard_consent();

-- Registrar o retirar un consentimiento. Obligatorio indicar el ORIGEN al autorizar. Retirar el de cobranza detiene YA los envíos pendientes.
create function public.set_driver_consent(p_driver uuid, p_purpose text, p_granted boolean, p_source text, p_evidence text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare d public.drivers; v_cancelled int := 0; v_src text := coalesce(p_source, case when p_granted then null else 'withdrawal' end);
begin
  perform app_private.assert_admin();
  if p_purpose not in ('collection', 'promotional') then raise exception 'invalid_purpose' using errcode = '22023'; end if;
  if v_src is null then raise exception 'consent_source_required' using errcode = '22023'; end if;
  if p_granted and v_src in ('withdrawal', 'legacy_unverified') then raise exception 'consent_source_required' using errcode = '22023'; end if;
  select * into d from public.drivers where id = p_driver for update;
  if not found then raise exception 'driver_not_found' using errcode = 'P0002'; end if;
  if p_granted and d.phone_e164 is null then raise exception 'consent_requires_phone' using errcode = '23514'; end if;
  insert into public.driver_consents(driver_id, purpose, granted, source, evidence, recorded_by)
    values (p_driver, p_purpose, p_granted, v_src, nullif(btrim(p_evidence), ''), auth.uid());
  if p_purpose = 'collection' then
    update public.drivers set whatsapp_consent = p_granted, whatsapp_consent_at = case when p_granted then now() else null end,
           whatsapp_consent_source = case when p_granted then v_src else null end where id = p_driver;
    if not p_granted then
      -- Detiene inmediatamente lo futuro (lo que ya está «processing» se frena en la verificación final del worker).
      update public.notification_jobs set status = 'cancelled', error = 'consentimiento retirado'
       where driver_id = p_driver and status in ('pending', 'awaiting_approval');
      get diagnostics v_cancelled = row_count;
    end if;
  else
    update public.drivers set promotional_consent = p_granted, promotional_consent_at = case when p_granted then now() else null end where id = p_driver;
  end if;
  perform app_private.audit('driver_consent.' || case when p_granted then 'granted' else 'withdrawn' end, 'driver', p_driver,
    jsonb_build_object('purpose', p_purpose, 'source', v_src, 'cancelled_jobs', v_cancelled));
  return jsonb_build_object('driver_id', p_driver, 'purpose', p_purpose, 'granted', p_granted, 'cancelled_jobs', v_cancelled);
end $$;

revoke all on function public.set_driver_consent(uuid, text, boolean, text, text) from public, anon, authenticated;
grant execute on function public.set_driver_consent(uuid, text, boolean, text, text) to authenticated, service_role;

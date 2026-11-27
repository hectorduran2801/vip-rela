-- VIP · 0016 · Alta de usuarios internos SIN depender de abrir/cerrar ventanas ni de editar PostgreSQL a mano, y suspensión de cuentas.
-- Causa del error «Database error creating new user» (SQLSTATE 42501, «signups_closed»): el disparador app_private.block_signups de auth.users
-- (0008) rechazaba TODA alta de identidad mientras no hubiera una ventana abierta. Aquí se separan tres cosas:
--   1) identidad (Supabase Auth)  2) autorización de acceso al CRM  3) rol.
-- Una invitación la crea un SUPER_ADMIN (email + rol); permite crear ESA identidad (y solo esa) durante un tiempo limitado y, al crearse, le
-- asigna el rol. Una cuenta de Auth sin invitación ni rol sigue sin acceso alguno al CRM (is_staff = false).
set search_path = public, extensions;

alter table public.app_users
  add column suspended_at timestamptz,
  add column suspended_by uuid references public.profiles(id);

-- Una cuenta suspendida pierde TODO acceso (RLS y funciones) de inmediato.
create or replace function app_private.current_role() returns public.app_role
language sql stable security definer set search_path = '' as $$ select u.role from public.app_users u where u.user_id = auth.uid() and u.suspended_at is null $$;
create or replace function app_private.is_staff() returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.app_users u where u.user_id = auth.uid() and u.suspended_at is null) $$;
create or replace function app_private.is_admin() returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.app_users u where u.user_id = auth.uid() and u.suspended_at is null and u.role in ('super_admin', 'admin')) $$;
create or replace function app_private.is_super() returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.app_users u where u.user_id = auth.uid() and u.suspended_at is null and u.role = 'super_admin') $$;

-- ───────── Invitaciones ─────────
create table public.user_invites (
  email text primary key check (email = lower(btrim(email)) and email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  role public.app_role not null check (role in ('admin', 'super_admin')),
  invited_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  consumed_by uuid
);
alter table public.user_invites enable row level security;                 -- sin políticas ni privilegios: solo vía funciones
revoke all on public.user_invites from public, anon, authenticated;
grant all on public.user_invites to service_role;

create or replace function app_private.block_signups() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.app_users) then return new; end if;                                               -- primera cuenta de la instancia
  if exists (select 1 from public.app_settings where user_creation_open_until > now()) then return new; end if;        -- ventana temporal (compatibilidad)
  if exists (select 1 from public.user_invites i where i.email = lower(btrim(new.email)) and i.consumed_at is null and i.expires_at > now()) then
    return new;                                                                                                          -- invitación vigente de un SUPER_ADMIN
  end if;
  raise exception 'signups_closed: VIP es privado; un SUPER_ADMIN debe invitar este correo desde Configuración → Usuarios' using errcode = '42501';
end $$;

-- Al crearse la identidad, si había invitación vigente se asigna el rol (después de que on_auth_user_created cree el perfil).
create function app_private.consume_invite() returns trigger language plpgsql security definer set search_path = '' as $$
declare inv public.user_invites;
begin
  select * into inv from public.user_invites i where i.email = lower(btrim(new.email)) and i.consumed_at is null and i.expires_at > now() for update;
  if found then
    insert into public.app_users(user_id, role, created_by) values (new.id, inv.role, inv.invited_by) on conflict (user_id) do nothing;
    update public.user_invites set consumed_at = now(), consumed_by = new.id where email = inv.email;
    perform app_private.audit('invite_consumed', 'app_users', new.id, jsonb_build_object('role', inv.role));
  end if;
  return new;
end $$;
create trigger z_consume_invite after insert on auth.users for each row execute function app_private.consume_invite();

-- Invitar (o, si la identidad ya existe, autorizar directamente). Solo SUPER_ADMIN.
create function public.invite_app_user(p_email text, p_role text, p_minutes int default 120) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_email text := lower(btrim(p_email)); v_role public.app_role; v_id uuid;
begin
  perform app_private.assert_super();
  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then raise exception 'invalid_email' using errcode = '22023'; end if;
  begin v_role := p_role::public.app_role; exception when invalid_text_representation then raise exception 'invalid_role' using errcode = '22023'; end;
  if v_role not in ('admin', 'super_admin') then raise exception 'role_deprecated' using errcode = '22023'; end if;
  if p_minutes < 5 or p_minutes > 1440 then raise exception 'invalid_minutes' using errcode = '22023'; end if;
  select p.id into v_id from public.profiles p where lower(p.email) = v_email;
  if v_id is not null then                                           -- la identidad ya existe en Auth: solo falta autorizarla
    if exists (select 1 from public.app_users where user_id = v_id) then raise exception 'user_already_authorized' using errcode = '23505'; end if;
    insert into public.app_users(user_id, role, created_by) values (v_id, v_role, auth.uid());
    perform app_private.audit('invite_assigned', 'app_users', v_id, jsonb_build_object('role', v_role));
    return jsonb_build_object('mode', 'assigned', 'email', v_email, 'role', v_role);
  end if;
  insert into public.user_invites(email, role, invited_by, expires_at) values (v_email, v_role, auth.uid(), now() + make_interval(mins => p_minutes))
    on conflict (email) do update set role = excluded.role, invited_by = excluded.invited_by, created_at = now(),
      expires_at = excluded.expires_at, consumed_at = null, consumed_by = null;
  perform app_private.audit('invite_created', 'user_invites', null, jsonb_build_object('email', v_email, 'role', v_role, 'minutes', p_minutes));
  return jsonb_build_object('mode', 'invited', 'email', v_email, 'role', v_role, 'expires_at', now() + make_interval(mins => p_minutes));
end $$;

create function public.cancel_user_invite(p_email text) returns void language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.assert_super();
  delete from public.user_invites where email = lower(btrim(p_email)) and consumed_at is null;
  if not found then raise exception 'invite_not_found' using errcode = 'P0002'; end if;
  perform app_private.audit('invite_cancelled', 'user_invites', null, jsonb_build_object('email', lower(btrim(p_email))));
end $$;

create function public.list_user_invites() returns table (email text, role text, created_at timestamptz, expires_at timestamptz, consumed_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app_private.assert_super();
  return query select i.email, i.role::text, i.created_at, i.expires_at, i.consumed_at from public.user_invites i order by i.created_at desc;
end $$;

-- ───────── Suspender / reactivar; nunca queda la instancia sin SUPER_ADMIN activo ─────────
create function public.set_app_user_suspended(p_user_id uuid, p_suspended boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare u public.app_users;
begin
  perform app_private.assert_super();
  select * into u from public.app_users where user_id = p_user_id for update;
  if not found then raise exception 'user_not_found' using errcode = 'P0002'; end if;
  if p_suspended and u.role = 'super_admin' and u.suspended_at is null
     and not exists (select 1 from public.app_users x where x.role = 'super_admin' and x.suspended_at is null and x.user_id <> p_user_id) then
    raise exception 'last_super_admin' using errcode = '23514'; end if;
  update public.app_users set suspended_at = case when p_suspended then now() else null end, suspended_by = case when p_suspended then auth.uid() end where user_id = p_user_id;
  perform app_private.audit(case when p_suspended then 'user_suspended' else 'user_reactivated' end, 'app_users', p_user_id, '{}');
  return jsonb_build_object('user_id', p_user_id, 'suspended', p_suspended);
end $$;

-- set_app_user / remove_app_user con la regla «último SUPER_ADMIN ACTIVO» (no solo el propio usuario).
create or replace function public.set_app_user(p_email text, p_role text) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_role public.app_role; v_cur public.app_role;
begin
  perform app_private.assert_super();
  begin v_role := p_role::public.app_role; exception when invalid_text_representation then raise exception 'invalid_role' using errcode = '22023'; end;
  if v_role = 'supervisor' then raise exception 'role_deprecated' using errcode = '22023'; end if;
  select p.id into v_id from public.profiles p where lower(p.email) = lower(btrim(p_email));
  if v_id is null then raise exception 'user_not_found' using errcode = 'P0002'; end if;
  select role into v_cur from public.app_users where user_id = v_id;
  if v_cur = 'super_admin' and v_role <> 'super_admin'
     and not exists (select 1 from public.app_users x where x.role = 'super_admin' and x.suspended_at is null and x.user_id <> v_id) then
    raise exception 'last_super_admin' using errcode = '23514'; end if;
  insert into public.app_users(user_id, role, created_by) values (v_id, v_role, auth.uid()) on conflict (user_id) do update set role = excluded.role;
  perform app_private.audit('set_app_user', 'app_users', v_id, jsonb_build_object('role', v_role));
  return jsonb_build_object('user_id', v_id, 'role', v_role);
end $$;

create or replace function public.remove_app_user(p_user_id uuid) returns void language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.assert_super();
  if (select role from public.app_users where user_id = p_user_id) = 'super_admin'
     and not exists (select 1 from public.app_users x where x.role = 'super_admin' and x.suspended_at is null and x.user_id <> p_user_id) then
    raise exception 'last_super_admin' using errcode = '23514'; end if;
  delete from public.app_users where user_id = p_user_id;
  if not found then raise exception 'user_not_found' using errcode = 'P0002'; end if;
  perform app_private.audit('remove_app_user', 'app_users', p_user_id, '{}');
end $$;

drop function public.list_app_users();
create function public.list_app_users() returns table (user_id uuid, email text, full_name text, role text, created_at timestamptz, suspended_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app_private.assert_super();
  return query select u.user_id, p.email, p.full_name, u.role::text, u.created_at, u.suspended_at
    from public.app_users u join public.profiles p on p.id = u.user_id order by u.role, p.email;
end $$;

revoke all on function public.invite_app_user(text, text, int), public.cancel_user_invite(text), public.list_user_invites(),
  public.set_app_user_suspended(uuid, boolean), public.list_app_users(), public.set_app_user(text, text), public.remove_app_user(uuid) from public, anon, authenticated;
grant execute on function public.invite_app_user(text, text, int), public.cancel_user_invite(text), public.list_user_invites(),
  public.set_app_user_suspended(uuid, boolean), public.list_app_users(), public.set_app_user(text, text), public.remove_app_user(uuid) to authenticated, service_role;

-- 0033 · Persistencia y cierre de la sesión de WhatsApp
-- · `whatsapp_session_secrets` (cifrada AES-256-GCM por el worker; sin permisos para anon/authenticated) guarda el sobre de sesión de OpenWA.
-- · «Desconectar» (desired_state = disconnected) CONSERVA la sesión; «Cerrar sesión» (logout_requested_at) la elimina por completo.
-- · Un lease en la base impide que dos instancias del worker usen la misma sesión a la vez (el bloqueo por archivo solo cubre una máquina).
alter table public.whatsapp_sessions
  add column session_persisted boolean not null default false,        -- el worker lo mantiene: hay un secreto cifrado guardado
  add column session_saved_at timestamptz,
  add column logout_requested_at timestamptz,                         -- la administradora pidió cerrar la sesión; solo el worker lo limpia
  add column lease_owner text,
  add column lease_expires_at timestamptz;

-- La administradora solo escribe desired_state (grant por columna existente); estas columnas son del worker.
create function public.request_whatsapp_logout() returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.assert_admin();
  update public.whatsapp_sessions set desired_state = 'disconnected', logout_requested_at = coalesce(logout_requested_at, now()), last_error = null, updated_at = now();
  perform app_private.audit('request_whatsapp_logout', 'whatsapp_sessions', null, '{}');
  return (select jsonb_build_object('id', id, 'status', status, 'desired_state', desired_state, 'logout_requested_at', logout_requested_at) from public.whatsapp_sessions);
end $$;
revoke all on function public.request_whatsapp_logout() from public, anon;
grant execute on function public.request_whatsapp_logout() to authenticated;

-- Defensa en profundidad: los secretos nunca son visibles ni escribibles desde el cliente.
revoke all on public.whatsapp_session_secrets from anon, authenticated;

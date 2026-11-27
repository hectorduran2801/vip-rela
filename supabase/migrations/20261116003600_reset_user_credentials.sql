-- 0036 · Restablecer las credenciales de una cuenta (solo SUPER_ADMIN)
-- La contraseña temporal NUNCA pasa por la base: la API la genera y la aplica en Supabase Auth. Esta función solo autoriza la operación
-- (SUPER_ADMIN, la cuenta existe en VIP, no es la propia) y deja el rastro en la auditoría. Aditiva: no modifica filas existentes.
create function public.authorize_credentials_reset(p_user_id uuid) returns jsonb language plpgsql security definer set search_path = '' as $$
declare u public.app_users; v_email text;
begin
  perform app_private.assert_super();
  if p_user_id = auth.uid() then raise exception 'cannot_reset_own_credentials' using errcode = '42501'; end if;
  select * into u from public.app_users where user_id = p_user_id;
  if not found then raise exception 'user_not_found' using errcode = 'P0002'; end if;
  select p.email into v_email from public.profiles p where p.id = p_user_id;
  perform app_private.audit('user_credentials_reset', 'app_users', p_user_id, jsonb_build_object('email', v_email));
  return jsonb_build_object('user_id', p_user_id, 'email', v_email);
end $$;
revoke all on function public.authorize_credentials_reset(uuid) from public, anon;
grant execute on function public.authorize_credentials_reset(uuid) to authenticated, service_role;

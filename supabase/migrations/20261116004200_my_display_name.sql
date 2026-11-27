-- VIP · 0042 · Nombre que cada cuenta quiere mostrar junto al logo (profiles.full_name). Cada quien lee y cambia SOLO el suyo.
-- También es el nombre que aparece como «enviado por» en el historial y la lista de usuarios. Reversible: borrar las dos funciones.
set search_path = public, extensions;

create function public.get_my_display_name() returns text language plpgsql stable security definer set search_path = '' as $$
begin
  perform app_private.assert_staff();
  return coalesce((select p.full_name from public.profiles p where p.id = auth.uid()), '');
end $$;

create function public.set_my_display_name(p_name text) returns text language plpgsql security definer set search_path = '' as $$
declare v text := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g');
begin
  perform app_private.assert_staff();
  if char_length(v) > 60 then raise exception 'invalid_name' using errcode = '22023'; end if;
  insert into public.profiles(id, full_name, email) values (auth.uid(), v, (select u.email from auth.users u where u.id = auth.uid()))
  on conflict (id) do update set full_name = excluded.full_name;
  perform app_private.audit('profile.name_changed', 'profiles', auth.uid(), '{}'::jsonb);
  return v;
end $$;
revoke all on function public.get_my_display_name(), public.set_my_display_name(text) from public, anon;
grant execute on function public.get_my_display_name(), public.set_my_display_name(text) to authenticated, service_role;

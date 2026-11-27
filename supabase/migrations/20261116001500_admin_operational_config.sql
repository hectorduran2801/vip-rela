-- VIP · 0015 · ADMIN gestiona la configuración OPERATIVA diaria: métodos de pago y comisiones, y límites de recordatorios.
-- (Horarios, plantillas y la configuración de la conexión de WhatsApp ya eran editables por ADMIN.)
-- SUPER_ADMIN conserva en exclusiva: usuarios, roles, auditoría completa y configuración técnica sensible (entorno, ventana de alta de
-- usuarios, zona horaria y nombre del negocio). Los permisos se aplican en PostgreSQL (RLS + privilegios de columna + disparador), no solo en Angular.
set search_path = public, extensions;

drop policy payment_methods_write on public.payment_methods;
create policy payment_methods_write on public.payment_methods for all to authenticated
  using (app_private.is_admin()) with check (app_private.is_admin());

drop policy app_settings_write on public.app_settings;
create policy app_settings_write on public.app_settings for all to authenticated
  using (app_private.is_admin()) with check (app_private.is_admin());

-- Columnas editables desde el cliente: solo los límites operativos. Zona horaria y nombre del negocio pasan a ser técnicos (SUPER_ADMIN).
revoke update on public.app_settings from authenticated;
grant update (business_name, timezone, max_per_driver_per_day, min_minutes_between, grace_minutes) on public.app_settings to authenticated;
create function app_private.guard_technical_settings() returns trigger language plpgsql as $$
begin
  if current_user = 'authenticated' and not app_private.is_super()
     and (new.timezone is distinct from old.timezone or new.business_name is distinct from old.business_name) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger guard_technical_settings before update on public.app_settings for each row execute function app_private.guard_technical_settings();

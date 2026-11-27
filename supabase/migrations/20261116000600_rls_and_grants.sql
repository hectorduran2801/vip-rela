-- VIP · 0006 · RLS y permisos de INSTANCIA ÚNICA: solo la administradora autorizada (app_admins) accede a algo.
-- anon no accede a nada. Las tablas financieras no admiten escritura directa: solo las funciones auditadas.
set search_path = public, extensions;

-- Supabase concede por defecto TODO a anon/authenticated/service_role: se revoca y se concede solo lo necesario.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;
revoke all on all functions in schema app_private from public, anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on functions from public, anon;

grant usage on schema public to authenticated, service_role;
grant usage on schema app_private to authenticated, service_role;
grant execute on function app_private.is_admin(), app_private.is_service(), app_private.tz() to authenticated, service_role;

alter table public.profiles enable row level security;
alter table public.app_admins enable row level security;            -- sin políticas: ningún acceso desde el navegador
alter table public.app_settings enable row level security;
alter table public.drivers enable row level security;
alter table public.units enable row level security;
alter table public.assignments enable row level security;
alter table public.rates enable row level security;
alter table public.rate_exceptions enable row level security;
alter table public.payment_methods enable row level security;
alter table public.adjustments enable row level security;
alter table public.charges enable row level security;
alter table public.payments enable row level security;
alter table public.payment_allocations enable row level security;
alter table public.weekly_closures enable row level security;
alter table public.whatsapp_sessions enable row level security;
alter table public.whatsapp_session_secrets enable row level security;   -- sin políticas ni permisos
alter table public.message_templates enable row level security;
alter table public.notification_schedules enable row level security;
alter table public.notification_jobs enable row level security;
alter table public.excel_imports enable row level security;
alter table public.import_blocks enable row level security;
alter table public.import_rows enable row level security;
alter table public.candidate_payments enable row level security;
alter table public.audit_logs enable row level security;

-- Lectura (solo la administradora)
grant select on public.profiles, public.app_settings, public.drivers, public.units, public.assignments, public.rates, public.rate_exceptions,
  public.payment_methods, public.adjustments, public.charges, public.payments, public.payment_allocations, public.weekly_closures,
  public.whatsapp_sessions, public.message_templates, public.notification_schedules, public.notification_jobs, public.excel_imports,
  public.import_blocks, public.import_rows, public.candidate_payments, public.audit_logs to authenticated;
grant select on public.v_assignment_position, public.v_collection_totals, public.v_movements to authenticated;   -- vistas security_invoker: RLS de las tablas base aplica
create policy profiles_select on public.profiles for select to authenticated using (id = auth.uid() and app_private.is_admin());
do $$ declare t text; begin
  foreach t in array array['app_settings','drivers','units','assignments','rates','rate_exceptions','payment_methods','adjustments','charges','payments',
    'payment_allocations','weekly_closures','whatsapp_sessions','message_templates','notification_schedules','notification_jobs','excel_imports',
    'import_blocks','import_rows','candidate_payments','audit_logs'] loop
    execute format('create policy %I on public.%I for select to authenticated using (app_private.is_admin())', t || '_select', t);
  end loop;
end $$;

-- Escritura de datos maestros y configuración (administradora)
grant insert, update on public.drivers, public.units, public.assignments, public.rates, public.notification_schedules,
  public.payment_methods, public.excel_imports, public.import_blocks, public.import_rows, public.candidate_payments to authenticated;
grant update on public.app_settings to authenticated;
grant insert, update, delete on public.rate_exceptions, public.message_templates to authenticated;
do $$ declare t text; begin
  foreach t in array array['drivers','units','assignments','rates','notification_schedules','payment_methods','excel_imports','import_blocks','import_rows',
    'candidate_payments','rate_exceptions','message_templates','app_settings'] loop
    execute format('create policy %I on public.%I for all to authenticated using (app_private.is_admin()) with check (app_private.is_admin())', t || '_write', t);
  end loop;
end $$;
-- app_settings: solo UPDATE (sin insert/delete): la fila única no se puede duplicar ni borrar
revoke insert, delete on public.app_settings from authenticated;

-- WhatsApp: la administradora solo pide conectar/desconectar y edita la etiqueta; el estado real lo escribe el worker.
grant update (label, desired_state) on public.whatsapp_sessions to authenticated;
create policy whatsapp_sessions_write on public.whatsapp_sessions for update to authenticated using (app_private.is_admin()) with check (app_private.is_admin());

-- service_role (servidor): acceso total, nunca expuesto al navegador.
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;

-- Ejecución de funciones: administradora y servidor
grant execute on function public.assignment_position(uuid, date, bigint), public.assignment_coverage(uuid, bigint), public.assignment_dues(uuid, date),
  public.register_payment(uuid, text, bigint, text, text, timestamptz, boolean, text), public.void_payment(uuid, text),
  public.create_adjustment(uuid, bigint, date, text, text), public.generate_daily_charges(date), public.close_week(date),
  public.review_notification(uuid, text, text), public.preview_template(uuid, text, date), public.dashboard_summary(),
  public.weekly_collection_table(date), public.period_summary(date, date), public.period_detail(date, date, text), public.period_series(date, date),
  public.apply_import(uuid, date, text), public.start_assignment(uuid, uuid, date, bigint, text), public.end_assignment(uuid, date),
  public.reassign_unit(uuid, uuid, date, bigint, text), public.change_rate(uuid, bigint, date) to authenticated, service_role;
grant execute on function app_private.assert_admin(), app_private.fmt_usd(bigint), app_private.week_start_of(date), app_private.payment_result(uuid, boolean),
  app_private.render_template(text, jsonb), app_private.template_vars(uuid, date) to authenticated, service_role;
-- ¿La cuenta autenticada es la administradora autorizada? (la web y la API lo usan tras iniciar sesión)
create function public.is_authorized() returns boolean language sql stable security definer set search_path = '' as $$ select app_private.is_admin() $$;
revoke all on function public.is_authorized() from public, anon;
grant execute on function public.is_authorized() to authenticated, service_role;
-- Solo servidor / administración de base de datos
grant execute on function public.authorize_admin(uuid), public.schedule_reminders(timestamptz, interval), public.claim_notification_jobs(int, timestamptz),
  public.requeue_stuck_notifications(interval, timestamptz), public.release_notification(uuid, interval, timestamptz),
  public.prepare_notification_send(uuid, timestamptz), public.complete_notification(uuid, text, text, boolean, text, timestamptz) to service_role;

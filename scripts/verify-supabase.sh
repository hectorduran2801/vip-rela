#!/usr/bin/env bash
# Verificación de SOLO LECTURA tras aplicar las migraciones. No modifica nada.
# Opcional: SUPABASE_DB_HOSTADDR=<IPv6> si tu red no resuelve el host IPv6.
# Uso: PGPASSWORD='…' SUPABASE_DB_HOST='<host del pooler o db.…>' ./scripts/verify-supabase.sh
set -euo pipefail
PSQL="${PSQL:-/opt/homebrew/opt/postgresql@16/bin/psql}"
HOST="${SUPABASE_DB_HOST:?define SUPABASE_DB_HOST}"; USER_="${SUPABASE_DB_USER:-postgres}"
: "${PGPASSWORD:?define PGPASSWORD}"
export PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=15000'
"$PSQL" "host=$HOST ${SUPABASE_DB_HOSTADDR:+hostaddr=$SUPABASE_DB_HOSTADDR} port=${SUPABASE_DB_PORT:-5432} dbname=postgres user=$USER_ sslmode=require connect_timeout=10" -X -A -F ' | ' -v ON_ERROR_STOP=1 <<'SQL'
select 'tablas public (esperado 25)', count(*)::text from information_schema.tables where table_schema='public' and table_type='BASE TABLE';
select 'tablas SIN RLS (esperado 0)', count(*)::text from pg_tables t join pg_class c on c.relname=t.tablename and c.relnamespace='public'::regnamespace where t.schemaname='public' and not c.relrowsecurity;
select 'rastro multiempresa (esperado 0)', count(*)::text from information_schema.columns where table_schema='public' and column_name='organization_id';
select 'anon con privilegios en tablas (esperado 0)', count(*)::text from information_schema.role_table_grants where table_schema='public' and grantee='anon';
select 'anon con EXECUTE en funciones public (esperado 0)', count(*)::text from information_schema.routine_privileges where routine_schema='public' and grantee in ('anon','PUBLIC');
select 'authenticated puede leer secretos de WhatsApp (esperado false)', has_table_privilege('authenticated','public.whatsapp_session_secrets','select')::text;
select 'authenticated puede leer app_users (esperado false)', has_table_privilege('authenticated','public.app_users','select')::text;
select 'authenticated puede editar el acuerdo de la unidad directo (esperado false)', has_column_privilege('authenticated','public.units','agreement','update')::text;
select 'authenticated puede editar estado real de WhatsApp (esperado false)', has_column_privilege('authenticated','public.whatsapp_sessions','status','update')::text;
select 'authenticated puede insertar pagos (esperado false)', has_table_privilege('authenticated','public.payments','insert')::text;
select 'cuentas internas / SUPER_ADMIN (esperado ≥1 / ≥1)', count(*)::text||' / '||count(*) filter (where role='super_admin')::text from public.app_users;
select 'entorno de la base (esperado development)', environment from public.app_settings;
select 'ventana de altas en Auth (esperado cerrada)', (coalesce(user_creation_open_until, now() - interval '1 second') > now())::text from public.app_settings;
select 'sesión WhatsApp única (esperado 1)', count(*)::text from public.whatsapp_sessions;
select 'envíos reales habilitados (esperado 0 horarios activos)', count(*)::text from public.notification_schedules where enabled;
SQL

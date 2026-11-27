#!/usr/bin/env bash
# Inspección de SOLO LECTURA del proyecto Supabase de desarrollo. No modifica nada.
# Opcional: SUPABASE_DB_HOSTADDR=<IPv6> si tu red no resuelve el host IPv6.
# Uso: PGPASSWORD='…' ./scripts/inspect-supabase.sh   (la contraseña NO se guarda en ningún archivo)
set -euo pipefail
PSQL="${PSQL:-/opt/homebrew/opt/postgresql@16/bin/psql}"
HOST="${SUPABASE_DB_HOST:-db.ekhxxedpqnjpibpmpcmf.supabase.co}"
: "${PGPASSWORD:?define PGPASSWORD}"
export PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=15000'
"$PSQL" "host=$HOST ${SUPABASE_DB_HOSTADDR:+hostaddr=$SUPABASE_DB_HOSTADDR} port=5432 dbname=postgres user=postgres sslmode=require connect_timeout=10" -X -A -F ' | ' -v ON_ERROR_STOP=1 <<'SQL'
select 'versión', version();
select 'tablas public', count(*)::text from information_schema.tables where table_schema = 'public';
select 'tabla', table_name from information_schema.tables where table_schema = 'public' order by 2;
select 'funciones public', count(*)::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public';
select 'schemas no estándar', string_agg(nspname, ', ') from pg_namespace where nspname !~ '^(pg_|information_schema|auth|storage|extensions|graphql|graphql_public|realtime|vault|pgsodium|pgsodium_masks|supabase_|net|cron|pgbouncer|_realtime|public)';
select 'usuarios auth', count(*)::text from auth.users;
select 'migraciones supabase', count(*)::text from supabase_migrations.schema_migrations;
select 'extensiones', string_agg(extname, ', ' order by extname) from pg_extension;
select 'usuarios con rol app', count(*)::text from pg_roles where rolname in ('anon','authenticated','service_role');
SQL

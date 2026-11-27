import { readFileSync } from 'node:fs';
import type pg from 'pg';

/**
 * Opciones de conexión a PostgreSQL con la MISMA semántica de `sslmode` que libpq/psql.
 * node-postgres interpreta `sslmode=require` como «verificar certificado completo», y el certificado del pooler de
 * Supabase no está en la cadena de confianza de Node (SELF_SIGNED_CERT_IN_CHAIN). Aquí:
 *   disable                → sin TLS (solo bases locales)
 *   require | prefer | (sin sslmode, host remoto) → TLS cifrado; sin verificar la cadena, SALVO que se indique DATABASE_SSL_CA
 *   verify-ca | verify-full → TLS verificado (con DATABASE_SSL_CA si se proporciona)
 * Para verificación estricta contra Supabase: descargar su CA del panel (Database → SSL) y definir DATABASE_SSL_CA=<ruta .crt>.
 */
export function poolOptions(databaseUrl: string, env: NodeJS.ProcessEnv = process.env): pg.PoolConfig {
  const u = new URL(databaseUrl);
  const mode = (u.searchParams.get('sslmode') ?? '').toLowerCase();
  const local = ['localhost', '127.0.0.1', '::1', ''].includes(u.hostname) || u.hostname.startsWith('/');
  u.searchParams.delete('sslmode'); u.searchParams.delete('uselibpqcompat');          // evita que pg lo reinterprete
  const base: pg.PoolConfig = { connectionString: u.toString() };
  if (mode === 'disable' || (local && mode === '')) return { ...base, ssl: false };
  const ca = env.DATABASE_SSL_CA ? readFileSync(env.DATABASE_SSL_CA, 'utf8') : undefined;
  const strict = mode === 'verify-ca' || mode === 'verify-full' || (ca !== undefined);
  return { ...base, ssl: strict ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: false } };
}

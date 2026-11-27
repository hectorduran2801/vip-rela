import { readFileSync } from 'node:fs';
import pg from 'pg';

/** Misma semántica de sslmode que libpq (ver apps/api/src/pool-options.ts): `require` cifra sin verificar la cadena salvo que se defina DATABASE_SSL_CA. */
export function poolOptions(databaseUrl: string, env: NodeJS.ProcessEnv = process.env): pg.PoolConfig {
  const u = new URL(databaseUrl);
  const mode = (u.searchParams.get('sslmode') ?? '').toLowerCase();
  const local = ['localhost', '127.0.0.1', '::1', ''].includes(u.hostname) || u.hostname.startsWith('/');
  u.searchParams.delete('sslmode'); u.searchParams.delete('uselibpqcompat');
  // Tiempos máximos: una conexión que se queda muda (corte de red sin error) NO debe dejar la cola esperando para siempre.
  const base: pg.PoolConfig = { connectionString: u.toString(), connectionTimeoutMillis: 15_000, query_timeout: 30_000, statement_timeout: 30_000,
    idle_in_transaction_session_timeout: 60_000, keepAlive: true, keepAliveInitialDelayMillis: 10_000 };
  if (mode === 'disable' || (local && mode === '')) return { ...base, ssl: false };
  const ca = env.DATABASE_SSL_CA ? readFileSync(env.DATABASE_SSL_CA, 'utf8') : undefined;
  const strict = mode === 'verify-ca' || mode === 'verify-full' || ca !== undefined;
  return { ...base, ssl: strict ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: false } };
}

export type Queryable = {
  rows: <T = any>(sql: string, params?: unknown[]) => Promise<T[]>;
  one: <T = any>(sql: string, params?: unknown[]) => Promise<T>;
};

const SERVICE_CLAIMS = JSON.stringify({ role: 'service_role' });

/**
 * Acceso a PostgreSQL. Cada transacción hace `SET LOCAL ROLE service_role` y fija
 * `request.jwt.claims` (como el arnés de pruebas y como lo haría PostgREST), de modo que las
 * funciones SECURITY DEFINER (`app_private.is_service()`) reconocen al worker.
 * DATABASE_URL es solo de servidor; nunca llega al navegador.
 */
export class Db {
  readonly pool: pg.Pool;

  constructor(config: string | pg.PoolConfig, max = 5) {
    this.pool = new pg.Pool(typeof config === 'string' ? { ...poolOptions(config), max } : { max, ...config });
    // Un error en un cliente inactivo no debe tumbar el proceso.
    this.pool.on('error', () => undefined);
  }

  async tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
    const cl = await this.pool.connect();
    // Un corte de red o un reinicio del servidor emite 'error' en el cliente: sin escucha, Node lo trata como excepción y TUMBA el worker
    // (y con él la sesión de WhatsApp). Aquí solo se descarta la conexión; la consulta en curso falla con su error normal.
    let broken = false;
    const onError = () => { broken = true; };
    cl.on('error', onError);
    try {
      await cl.query('begin');
      await cl.query('set local role service_role');
      await cl.query(`select set_config('request.jwt.claims', $1, true)`, [SERVICE_CLAIMS]);
      const q: Queryable = {
        rows: async (sql, params) => (await cl.query(sql, params as any[])).rows,
        one: async (sql, params) => (await cl.query(sql, params as any[])).rows[0],
      };
      const r = await fn(q);
      await cl.query('commit');
      return r;
    } catch (e) {
      await cl.query('rollback').catch(() => undefined);
      throw e;
    } finally {
      cl.removeListener('error', onError);
      cl.release(broken ? true : undefined);          // true = destruir la conexión rota en vez de devolverla al pool
    }
  }

  close(): Promise<void> { return this.pool.end(); }
}

import pg from 'pg';

export interface Tx {
  one<T = any>(sql: string, params?: unknown[]): Promise<T | undefined>;
  rows<T = any>(sql: string, params?: unknown[]): Promise<T[]>;
}

export interface Database {
  /** Ejecuta `fn` como el usuario autenticado: RLS y los permisos por rol se aplican en la base. */
  asUser<T>(userId: string, fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** Conexión de servicio (service_role) para el motor de cobranza; nunca se expone al navegador. */
  asService?<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** Conexión del propietario (sin cambio de rol), solo para altas en el esquema de Auth cuando no hay clave de servicio. */
  asOwner?<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/**
 * Transacción, rol e identidad en UN solo viaje (cada viaje a Supabase cuesta ~95 ms y esto lo paga cada petición).
 * El protocolo con varias sentencias no admite parámetros: la identidad va como literal escapado por el propio controlador.
 */
const open = (client: pg.PoolClient, role: 'authenticated' | 'service_role', claims: string) =>
  `begin; set local role ${role}; select set_config('request.jwt.claims', ${client.escapeLiteral(claims)}, true)`;

export function createDatabase(pool: pg.Pool): Database {
  // Un error de red (p. ej. ETIMEDOUT) en una conexión inactiva NO debe tumbar el proceso: el pool la descarta y abre otra.
  pool.on('error', () => undefined);
  return {
    async asUser(userId, fn) {
      const client = await pool.connect();
      let broken = false; const onError = () => { broken = true; };
      client.on('error', onError);          // una conexión en uso sin oyente de 'error' lanza la excepción y cae el proceso
      try {
        try {
          await client.query(open(client, 'authenticated', JSON.stringify({ sub: userId, role: 'authenticated' })));
          const tx: Tx = {
            one: async (sql, params) => (await client.query(sql, params as any[])).rows[0],
            rows: async (sql, params) => (await client.query(sql, params as any[])).rows,
          };
          const out = await fn(tx);
          await client.query('commit');
          return out;
        } catch (e) { await client.query('rollback').catch(() => undefined); throw e; }
      } finally { client.removeListener('error', onError); client.release(broken ? true : undefined); }
    },
    async asOwner(fn) {
      const client = await pool.connect();
      let broken = false; const onError = () => { broken = true; };
      client.on('error', onError);
      try {
        await client.query('begin');
        try {
          const out = await fn({
            one: async (sql, params) => (await client.query(sql, params as any[])).rows[0],
            rows: async (sql, params) => (await client.query(sql, params as any[])).rows,
          });
          await client.query('commit');
          return out;
        } catch (e) { await client.query('rollback').catch(() => undefined); throw e; }
      } finally { client.removeListener('error', onError); client.release(broken ? true : undefined); }
    },
    async asService(fn) {
      const client = await pool.connect();
      let broken = false; const onError = () => { broken = true; };
      client.on('error', onError);
      try {
        try {
          await client.query(open(client, 'service_role', JSON.stringify({ role: 'service_role' })));
          const out = await fn({
            one: async (sql, params) => (await client.query(sql, params as any[])).rows[0],
            rows: async (sql, params) => (await client.query(sql, params as any[])).rows,
          });
          await client.query('commit');
          return out;
        } catch (e) { await client.query('rollback').catch(() => undefined); throw e; }
      } finally { client.removeListener('error', onError); client.release(broken ? true : undefined); }
    },
    close: () => pool.end(),
  };
}

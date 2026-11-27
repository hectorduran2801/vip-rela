// Aplicación segura de migraciones sobre la base EN USO.
// Dentro de la transacción solo van los archivos: nada de comparaciones ni consultas largas mientras las tablas están bloqueadas.

/** Motivos para no aplicar ahora (lista vacía = se puede). Solo lectura. */
export async function preflight(client, { maxTxSeconds = 5 } = {}) {
  const problems = [];
  const count = async (sql, params) => Number((await client.query(sql, params)).rows[0].n);
  const long = await count(`select count(*) n from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid()
    and xact_start < clock_timestamp() - make_interval(secs => $1)`, [maxTxSeconds]);
  if (long) problems.push(`${long} transacción(es) abierta(s) hace más de ${maxTxSeconds} s`);
  const waiting = await count('select count(*) n from pg_locks where not granted');
  if (waiting) problems.push(`${waiting} bloqueo(s) en espera`);
  const has = async (t) => (await client.query('select to_regclass($1) is not null ok', [t])).rows[0].ok;
  if (await has('public.whatsapp_test_messages')) {
    const n = await count(`select count(*) n from public.whatsapp_test_messages where status::text in ('prepared', 'pending', 'processing')`);
    if (n) problems.push(`${n} mensaje(s) pendiente(s) o en envío`);
  }
  if (await has('public.notification_jobs')) {
    const n = await count(`select count(*) n from public.notification_jobs where status::text in ('pending', 'processing')`);
    if (n) problems.push(`${n} aviso(s) pendiente(s) o en envío`);
  }
  return problems;
}

/**
 * Aplica `migrations` ([{ name, sql }]) en UNA transacción.
 * - lockTimeoutMs: cuánto se espera para obtener un bloqueo (si no, se abandona).
 * - statementTimeoutMs / totalTimeoutMs: cuánto puede durar cada sentencia y la transacción completa (PostgreSQL 17+).
 * - signal + connect: al abortar, otra conexión cancela la sentencia en curso y todo se revierte.
 */
export async function applyMigrations(client, migrations, { lockTimeoutMs = 3000, statementTimeoutMs = 20000, totalTimeoutMs = 30000, signal, connect } = {}) {
  const ms = (v) => `${Math.max(1, Math.round(Number(v)))}ms`;
  const pid = (await client.query('select pg_backend_pid() pid')).rows[0].pid;
  const version = Number((await client.query(`select current_setting('server_version_num') v`)).rows[0].v);
  const cancel = async () => { const other = await connect(); await other.query('select pg_cancel_backend($1)', [pid]); };
  const onAbort = () => { void cancel().catch(() => {}); };
  if (signal?.aborted) throw new Error('cancelado antes de empezar');
  const applied = [];
  let current = 'inicio';
  const started = Date.now();
  try {
    if (signal && connect) signal.addEventListener('abort', onAbort, { once: true });
    await client.query('begin');
    await client.query(`set local lock_timeout = '${ms(lockTimeoutMs)}'`);
    await client.query(`set local statement_timeout = '${ms(statementTimeoutMs)}'`);
    await client.query(`set local idle_in_transaction_session_timeout = '10s'`);
    if (version >= 170000) await client.query(`set local transaction_timeout = '${ms(totalTimeoutMs)}'`);
    for (const m of migrations) {
      if (signal?.aborted) throw new Error('cancelado');
      current = m.name;
      await client.query(m.sql);
      await client.query('set local search_path = public, extensions');
      applied.push(m.name);
    }
    await client.query('commit');
    return { applied, lockedMs: Date.now() - started };
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw new Error(`${current}: ${e.message}`, { cause: e });
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

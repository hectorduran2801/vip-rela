// Uso: DATABASE_URL=… node scripts/db-apply/cli.mjs --backup <respaldo.sql> [--apply] <migración.sql>…
// Sin --apply solo revisa (solo lectura). Ctrl+C cancela y revierte.
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename } from 'node:path';
import { applyMigrations, preflight } from './lib.mjs';

const pg = createRequire(new URL('../../packages/db/package.json', import.meta.url))('pg');
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const backup = args[args.indexOf('--backup') + 1];
const files = args.filter((a, i) => a.endsWith('.sql') && args[i - 1] !== '--backup');
const stop = (msg) => { console.error(msg); process.exit(1); };

if (!process.env.DATABASE_URL) stop('Falta DATABASE_URL.');
if (!files.length) stop('Indique al menos una migración.');
if (!args.includes('--backup') || !existsSync(backup) || !readFileSync(backup, 'utf8').slice(-400).includes('dump complete')) stop('Falta un respaldo completo (--backup archivo de pg_dump).');

const connect = async () => {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL.replace(/[?&]sslmode=[^&]*/, ''), ssl: { rejectUnauthorized: false } });
  c.on('error', () => {});
  await c.connect();
  return c;
};
const client = await connect();
const extra = [];
try {
  const problems = await preflight(client);
  if (problems.length) stop(`No es buen momento:\n- ${problems.join('\n- ')}`);
  console.log(`Revisión previa correcta. Archivos: ${files.map((f) => basename(f)).join(', ')}`);
  if (!apply) { console.log('Solo revisión. Añada --apply para aplicar.'); process.exit(0); }
  const abort = new AbortController();
  process.on('SIGINT', () => abort.abort());
  const r = await applyMigrations(client, files.map((f) => ({ name: basename(f), sql: readFileSync(f, 'utf8') })), {
    signal: abort.signal, connect: async () => { const c = await connect(); extra.push(c); return c; },
  });
  console.log(`Aplicadas: ${r.applied.join(', ')} · bloqueo máximo ${r.lockedMs} ms. Compare ahora, fuera de la transacción.`);
} catch (e) {
  console.error(`REVERTIDO: ${e.message}`);
  process.exitCode = 1;
} finally {
  await Promise.all([client, ...extra].map((c) => c.end().catch(() => {})));
}

// Uso: DATABASE_URL=… node scripts/db-check/cli.mjs
// Solo lectura. Sale con código 1 si la base no es compatible con esta versión del sistema.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { compare, inventory } from './lib.mjs';

const pg = createRequire(new URL('../../apps/api/package.json', import.meta.url))('pg');
if (!process.env.DATABASE_URL) { console.error('Falta DATABASE_URL.'); process.exit(2); }
const expected = JSON.parse(readFileSync(new URL('../../supabase/schema-manifest.json', import.meta.url), 'utf8'));
const client = new pg.Client({ connectionString: process.env.DATABASE_URL.replace(/[?&]sslmode=[^&]*/, ''), ssl: /localhost|127\.0\.0\.1|@db:/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false } });
await client.connect();
try {
  await client.query('set default_transaction_read_only = on');
  const { missing, different } = compare(expected, await inventory(client));
  if (!missing.length && !different.length) console.log(`Esquema compatible: ${Object.keys(expected).length} objetos verificados.`);
  else {
    console.error('ESQUEMA INCOMPATIBLE: no habilite esta versión. Aplique las migraciones pendientes.');
    for (const k of missing.slice(0, 30)) console.error(`  falta     ${k}`);
    for (const k of different.slice(0, 30)) console.error(`  distinto  ${k}`);
    console.error(`  total: ${missing.length} faltan, ${different.length} distintos`);
    process.exitCode = 1;
  }
} finally { await client.end(); }

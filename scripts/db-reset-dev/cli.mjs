#!/usr/bin/env node
// pnpm db:reset:dev  ·  Uso:  DATABASE_URL='postgresql://postgres.<ref>:…@…' pnpm db:reset:dev [--dry-run] [--confirm="REINICIAR VIP DEV <ref>"]
// La contraseña NUNCA se pasa por argumentos ni se guarda: solo por la variable de entorno DATABASE_URL.
import pg from 'pg';
import readline from 'node:readline/promises';
import { assertDevTarget, confirmationPhrase, executeReset, planReset, RESET_TABLES, KEEP_TABLES, DEV } from './lib.mjs';

const args = process.argv.slice(2);
const dry = args.includes('--dry-run');
const flag = args.find((a) => a.startsWith('--confirm='))?.slice('--confirm='.length);
const url = process.env.DATABASE_URL;
if (!url) { console.error('Falta DATABASE_URL (conexión del proyecto de DESARROLLO).'); process.exit(2); }

let target;
try { target = assertDevTarget({ databaseUrl: url }); } catch (e) { console.error(`✖ ${e.message}`); process.exit(2); }

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
const out = (s = '') => console.log(s);
try {
  await client.connect();
  out(`Proyecto Supabase de destino: ${target.ref}  (${target.host})`);
  const plan = await planReset(client);
  out(`Entorno declarado por la base: ${plan.environment}\n`);
  out('SE ELIMINARÁN (filas):'); for (const t of Object.keys(plan.reset)) out(`  ${t.padEnd(24)} ${String(plan.reset[t]).padStart(7)}`);
  out(`  ${'TOTAL'.padEnd(24)} ${String(plan.total).padStart(7)}\n`);
  out('SE CONSERVAN (filas):'); for (const [t, n] of Object.entries(plan.keep)) out(`  ${t.padEnd(24)} ${String(n).padStart(7)}`);
  out(`  roles: ${plan.roles.map((r) => `${r.r}=${r.n}`).join(', ') || '—'}`);
  out('\nNo se ejecuta DROP SCHEMA, no se toca Supabase Auth, la estructura, las políticas RLS ni las funciones.');
  if (dry) { out('\n--dry-run: no se realizó ningún cambio.'); process.exit(0); }

  const phrase = confirmationPhrase(DEV.ref);
  let typed = flag;
  if (typed === undefined) {
    if (!process.stdin.isTTY) { console.error('\n✖ Sin terminal interactiva: usa --confirm="' + phrase + '".'); process.exit(2); }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    typed = await rl.question(`\nEscribe exactamente «${phrase}» para continuar: `); rl.close();
  }
  const res = await executeReset(client, { typed: typed.trim(), ref: DEV.ref });
  out(`\n✔ Reinicio completado. Filas eliminadas: ${res.total}. Tablas operativas verificadas vacías; Auth, roles y configuración intactos.`);
} catch (e) {
  console.error(`\n✖ ${e.message}\nNo se aplicó ningún cambio (transacción revertida).`); process.exitCode = 1;
} finally { await client.end().catch(() => {}); }

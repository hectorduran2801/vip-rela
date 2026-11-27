#!/usr/bin/env node
// pnpm dev:setup  ·  Guarda DATABASE_URL en .env pidiendo la contraseña EN PRIVADO (no se muestra ni pasa por ningún chat/argumento).
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Writable } from 'node:stream';
import readline from 'node:readline';
import pg from 'pg';

const root = fileURLToPath(new URL('..', import.meta.url));
const dev = JSON.parse(readFileSync(`${root}supabase/dev-project.json`, 'utf8'));
const host = process.env.SUPABASE_POOLER_HOST ?? 'aws-1-us-east-1.pooler.supabase.com';

const ask = (q) => new Promise((resolve) => {
  let muted = false;
  const out = new Writable({ write(chunk, _e, cb) { if (!muted) process.stdout.write(chunk); cb(); } });
  const rl = readline.createInterface({ input: process.stdin, output: out, terminal: true });
  rl.question(q, (a) => { rl.close(); process.stdout.write('\n'); resolve(a); });
  muted = true;
});

console.log(`Proyecto de desarrollo: ${dev.ref}  (pooler ${host})`);
const password = (await ask('Contraseña de PostgreSQL (no se mostrará): ')).trim();
if (!password) { console.error('✖ Contraseña vacía.'); process.exit(1); }
const url = `postgresql://postgres.${dev.ref}:${encodeURIComponent(password)}@${host}:5432/postgres?sslmode=require`;

const c = new pg.Client({ connectionString: url.replace('?sslmode=require', ''), ssl: { rejectUnauthorized: false } });
try {
  await c.connect();
  const env = (await c.query(`select environment from public.app_settings`)).rows[0]?.environment;
  if (env !== 'development') throw new Error(`la base declara environment='${env}': solo se admite 'development'.`);
  const who = (await c.query(`select count(*)::int n from public.app_users`)).rows[0].n;
  console.log(`✔ Conexión correcta (entorno ${env}, ${who} cuenta(s) interna(s)).`);
} catch (e) {
  console.error(`✖ No se pudo conectar: ${e.message}`); process.exit(1);
} finally { await c.end().catch(() => {}); }

const path = `${root}.env`;
let text = existsSync(path) ? readFileSync(path, 'utf8') : readFileSync(`${root}.env.example`, 'utf8');
text = /^DATABASE_URL=.*$/m.test(text) ? text.replace(/^DATABASE_URL=.*$/m, () => `DATABASE_URL=${url}`) : `${text.trimEnd()}\nDATABASE_URL=${url}\n`;
writeFileSync(path, text); chmodSync(path, 0o600);
console.log('✔ Guardado en .env (permisos 600, ignorado por Git). Ahora ejecuta:  pnpm dev');

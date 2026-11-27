import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';

const ROOT = resolve(import.meta.dirname, '../../..');
export const MIGRATIONS_DIR = join(ROOT, 'supabase/migrations');
export const STUB_SQL = join(ROOT, 'supabase/tests/support/supabase_stub.sql');

function findPgBin(): string {
  const candidates = [process.env.PG_BIN, '/opt/homebrew/opt/postgresql@16/bin', '/opt/homebrew/opt/postgresql@17/bin',
    '/usr/lib/postgresql/16/bin', '/usr/lib/postgresql/17/bin'].filter(Boolean) as string[];
  const found = candidates.find((d) => existsSync(join(d, 'initdb')));
  if (!found) throw new Error('No se encontró PostgreSQL local (initdb). Instálalo o define PG_BIN. Estas pruebas NUNCA usan el Supabase compartido.');
  return found;
}

export interface Cluster { dir: string; socketDir: string; port: number; stop: () => void }

/** Clúster PostgreSQL temporal, solo en socket Unix local (sin red). */
export function startCluster(): Cluster {
  const bin = findPgBin();
  const dir = mkdtempSync(join(tmpdir(), 'vip-pg-'));
  const data = join(dir, 'data');
  const port = 54000 + Math.floor(Math.random() * 900);
  execFileSync(join(bin, 'initdb'), ['-D', data, '-U', 'postgres', '--auth=trust', '-E', 'UTF8'], { stdio: 'ignore' });
  execFileSync(join(bin, 'pg_ctl'), ['-D', data, '-w', '-l', join(dir, 'pg.log'),
    '-o', `-p ${port} -k ${dir} -c listen_addresses='' -c fsync=off -c synchronous_commit=off -c max_connections=100`, 'start'], { stdio: 'ignore' });
  return {
    dir, socketDir: dir, port,
    stop: () => {
      try { execFileSync(join(bin, 'pg_ctl'), ['-D', data, '-m', 'immediate', 'stop'], { stdio: 'ignore' }); } catch { /* ya detenido */ }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export const connConfig = (c: { socketDir: string; port: number }, database: string): pg.ClientConfig =>
  ({ host: c.socketDir, port: c.port, user: 'postgres', database });

/** Crea la plantilla: stub de Supabase + TODAS las migraciones, en orden (`skip`: números como '2300' que se omiten, para imitar una base atrasada). */
export async function buildTemplate(c: Cluster, name = 'vip_template', skip: string[] = []): Promise<void> {
  const admin = new pg.Client(connConfig(c, 'postgres'));
  await admin.connect();
  await admin.query(`create database ${name}`);
  await admin.end();
  const db = new pg.Client(connConfig(c, name));
  await db.connect();
  try {
    await db.query(readFileSync(STUB_SQL, 'utf8'));
    for (const f of readdirSync(MIGRATIONS_DIR).filter((x) => x.endsWith('.sql') && !skip.some((n) => x.includes(`_${n}_`) || x.startsWith(`2026111600${n}`))).sort()) {
      try { await db.query(readFileSync(join(MIGRATIONS_DIR, f), 'utf8')); }
      catch (e) { throw new Error(`Migración ${f} falló: ${(e as Error).message}`); }
    }
  } finally { await db.end(); }
}

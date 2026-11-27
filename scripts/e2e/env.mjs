// Entorno AISLADO para pruebas de punta a punta: Postgres desechable (todas las migraciones) + PostgREST + API real + web compilada.
// Nunca usa Supabase real. Requiere Docker, `pnpm -r build`. Se queda en primer plano; Ctrl+C lo apaga y borra sus contenedores.
import { execFileSync, spawn } from 'node:child_process';
import { createReadStream, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { createRequire } from 'node:module';
import { extname, join } from 'node:path';

const ROOT = new URL('../..', import.meta.url).pathname;
const req = createRequire(join(ROOT, 'apps/api/package.json'));
const pg = req('pg');
const SECRET = 'e2e-'.repeat(12);
const PORT = Number(process.env.E2E_PORT ?? 8090), DB = 55432, REST = 55433, API = 55434;
const BASE = `http://localhost:${PORT}`;
export const USERS = { admin: { email: 'admin@e2e.local', password: 'e2e-clave-123', id: '11111111-1111-4111-8111-111111111111' } };
const docker = (...a) => execFileSync('docker', a, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
const clean = () => { for (const n of ['vip-e2e-rest', 'vip-e2e-db']) { try { docker('rm', '-f', n); } catch { /* no existe */ } } };

clean();
docker('run', '-d', '--name', 'vip-e2e-db', '-e', 'POSTGRES_PASSWORD=e2e', '-p', `127.0.0.1:${DB}:5432`, 'postgres:17-alpine');
const url = `postgres://postgres:e2e@127.0.0.1:${DB}/postgres`;
let db;
for (let i = 0; ; i++) {
  try { db = new pg.Client({ connectionString: url }); db.on('error', () => {}); await db.connect(); await db.query('select 1'); await new Promise((r) => setTimeout(r, 1500)); await db.query('select 1'); break; }
  catch (e) { if (i > 40) throw e; await db?.end().catch(() => {}); await new Promise((r) => setTimeout(r, 1000)); }
}
await db.query(readFileSync(join(ROOT, 'supabase/tests/support/supabase_stub.sql'), 'utf8'));
for (const f of readdirSync(join(ROOT, 'supabase/migrations')).filter((x) => x.endsWith('.sql')).sort()) await db.query(readFileSync(join(ROOT, 'supabase/migrations', f), 'utf8'));
await db.query('reset search_path');
const u = USERS.admin;
await db.query(`insert into auth.users(id, email, raw_user_meta_data) values ($1, $2, '{"full_name":"Administradora E2E"}')`, [u.id, u.email]);
await db.query(`insert into public.app_users(user_id, role) values ($1, 'admin')`, [u.id]);

docker('run', '-d', '--name', 'vip-e2e-rest', '-p', `127.0.0.1:${REST}:3000`, '-e', `PGRST_DB_URI=postgres://postgres:e2e@host.docker.internal:${DB}/postgres`,
  '-e', 'PGRST_DB_SCHEMAS=public', '-e', 'PGRST_DB_EXTRA_SEARCH_PATH=public,extensions', '-e', 'PGRST_DB_ANON_ROLE=anon', '-e', `PGRST_JWT_SECRET=${SECRET}`, '-e', 'PGRST_JWT_AUD=authenticated', 'public.ecr.aws/supabase/postgrest:v14.18');

const api = spawn(process.execPath, ['dist/server.js'], { cwd: join(ROOT, 'apps/api'), stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, PORT: String(API), HOST: '127.0.0.1',
  DATABASE_URL: url, SUPABASE_JWT_SECRET: SECRET, BILLING_ENGINE: 'false', RATE_LIMIT_PER_MINUTE: '100000', CORS_ORIGINS: BASE, APP_TIMEZONE: 'America/Panama' } });
let apiLog = ''; const keep = (d) => { apiLog = (apiLog + d).slice(-200_000); writeFileSync(join(ROOT, '.logs/e2e-api.log'), apiLog); };
api.stdout.on('data', keep); api.stderr.on('data', keep);

// ── Autenticación mínima (imita a Supabase Auth solo para este entorno) ──
const { SignJWT } = await import(req.resolve('jose'));
const userJson = { id: u.id, aud: 'authenticated', role: 'authenticated', email: u.email, user_metadata: {}, app_metadata: {}, created_at: new Date().toISOString() };
const session = async () => {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const access_token = await new SignJWT({ role: 'authenticated', email: u.email }).setProtectedHeader({ alg: 'HS256' }).setSubject(u.id).setAudience('authenticated').setIssuedAt().setExpirationTime(exp).sign(new TextEncoder().encode(SECRET));
  return { access_token, token_type: 'bearer', expires_in: 3600, expires_at: exp, refresh_token: 'e2e-refresh', user: userJson };
};
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml' };
const WEB = join(ROOT, 'apps/web/dist/web/browser');
const proxy = (rq, rs, port, path) => {
  const out = request({ host: '127.0.0.1', port, path, method: rq.method, headers: { ...rq.headers, host: `127.0.0.1:${port}` } }, (up) => { rs.writeHead(up.statusCode, up.headers); up.pipe(rs); });
  out.on('error', () => { rs.writeHead(502).end(); }); rq.pipe(out);
};
const server = createServer(async (rq, rs) => {
  const path = rq.url.split('?')[0];
  if (path.startsWith('/rest/v1/')) return proxy(rq, rs, REST, rq.url.slice('/rest/v1'.length));
  if (path.startsWith('/api/')) return proxy(rq, rs, API, rq.url);
  if (path.startsWith('/auth/v1/')) {
    let body = ''; for await (const c of rq) body += c;
    const json = (s, b) => rs.writeHead(s, { 'content-type': 'application/json' }).end(JSON.stringify(b));
    if (path.endsWith('/token')) { const b = JSON.parse(body || '{}'); return b.refresh_token || (b.email === u.email && b.password === u.password) ? json(200, await session()) : json(400, { error: 'invalid_grant', error_description: 'Invalid login credentials' }); }
    if (path.endsWith('/user')) return json(200, userJson);
    return json(path.endsWith('/logout') ? 204 : 404, {});
  }
  if (path === '/ngsw-worker.js' || path === '/ngsw.json') return rs.writeHead(404).end();       // sin caché de la PWA en las pruebas
  let file = join(WEB, path); if (!extname(path) || !existsSync(file)) file = join(WEB, 'index.html');
  rs.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
  if (extname(file) === '.js') return rs.end(readFileSync(file, 'utf8').replaceAll('https://ekhxxedpqnjpibpmpcmf.supabase.co', BASE));
  createReadStream(file).pipe(rs);
});
server.listen(PORT, '127.0.0.1', () => console.log(`E2E listo en ${BASE}`));
const stop = () => { api.kill(); server.close(); clean(); process.exit(0); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);

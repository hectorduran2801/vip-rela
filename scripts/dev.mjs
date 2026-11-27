#!/usr/bin/env node
// pnpm dev  ·  Arranca VIP COMPLETO con un solo comando: API (3100) + web (4300) + worker de WhatsApp. Lee .env.
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { readEnvFile } from './env.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const fileEnv = readEnvFile(`${root}.env`);
// Prioridad: variables reales del entorno > .env. Los valores vacíos del archivo se ignoran.
const env = { ...Object.fromEntries(Object.entries(fileEnv).filter(([, v]) => v !== '')), ...process.env };
const C = { api: '\x1b[36m', web: '\x1b[35m', worker: '\x1b[33m', dim: '\x1b[2m', red: '\x1b[31m', reset: '\x1b[0m' };
const say = (m = '') => console.log(m);

if (!env.DATABASE_URL) {
  say(`${C.red}✖ Falta DATABASE_URL en .env.${C.reset}\n  Ejecuta una sola vez:  pnpm dev:setup   (te pide la contraseña de la base de desarrollo en privado)\n  y luego:               pnpm dev`);
  process.exit(1);
}
if (/^(production|prod)$/i.test(env.VIP_ENV ?? '')) { say(`${C.red}✖ VIP_ENV=production: pnpm dev es solo para desarrollo.${C.reset}`); process.exit(1); }
env.WHATSAPP_DRY_RUN = env.WHATSAPP_DRY_RUN ?? 'true';          // por defecto NUNCA se envían mensajes reales
env.ALLOW_SHARED_DB = env.ALLOW_SHARED_DB ?? 'yes';

const free = (port, host = '127.0.0.1') => new Promise((res) => {
  const s = net.createServer().once('error', () => res(false)).once('listening', () => s.close(() => res(true))).listen(port, host);
});
const who = (port) => spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).stdout.split('\n')[1]?.trim().split(/\s+/).slice(0, 2).join(' pid ') ?? 'otro proceso';
for (const [name, port] of [['API', Number(env.PORT ?? 3100)], ['web', 4300]]) {
  if (!(await free(port))) {
    say(`${C.red}✖ El puerto ${port} (${name}) ya está en uso por: ${who(port)}.${C.reset}\n  Cierra ese proceso (Ctrl+C en su terminal) o termínalo, y vuelve a ejecutar pnpm dev.`);
    process.exit(1);
  }
}

say(`${C.dim}Preparando paquetes compartidos…${C.reset}`);
const built = spawnSync('pnpm', ['--filter', '@vip/shared', '--filter', '@vip/excel-import', '--filter', '@vip/excel-export', 'build'], { cwd: root, env, encoding: 'utf8' });
if (built.status !== 0) { say(`${C.red}✖ Falló la compilación de paquetes:${C.reset}\n${built.stdout}${built.stderr}`); process.exit(1); }

const procs = [];
const WORKER_RESTARTS = { max: 3, windowMs: 10 * 60_000, delaysMs: [5_000, 15_000, 30_000] };   // reintentos LIMITADOS: nunca un bucle infinito de Chrome
const restarts = [];
const start = (tag, args, extraEnv = {}, drop = []) => {
  const childEnv = { ...env, ...extraEnv }; for (const k of drop) delete childEnv[k];
  const p = spawn('pnpm', args, { cwd: root, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  const out = (d) => String(d).split('\n').filter(Boolean).forEach((l) => console.log(`${C[tag]}[${tag}]${C.reset} ${l}`));
  p.stdout.on('data', out); p.stderr.on('data', out);
  p.on('exit', (code) => {
    procs.splice(procs.indexOf(p), 1);
    say(`${C[tag]}[${tag}]${C.reset} terminó (código ${code})`);
    if (stopping) return;
    if (tag !== 'worker') { say(`${C.red}✖ ${tag} se detuvo: cerrando todo.${C.reset}`); shutdown(1); return; }
    // El worker es independiente: la API y la web siguen funcionando aunque caiga. Se reintenta pocas veces y con espera creciente.
    const now = Date.now();
    while (restarts.length && now - restarts[0] > WORKER_RESTARTS.windowMs) restarts.shift();
    if (code === 0 || restarts.length >= WORKER_RESTARTS.max) {
      say(`${C.red}✖ El worker de WhatsApp quedó detenido${code === 0 ? '' : ` tras ${restarts.length} reintentos`}. La API y la web siguen activas; revisa los registros; al volver a ejecutar pnpm dev se intentará de nuevo${C.reset}`);
      return;
    }
    const wait = WORKER_RESTARTS.delaysMs[restarts.length] ?? 30_000; restarts.push(now);
    say(`${C.worker}[worker]${C.reset} reintento ${restarts.length}/${WORKER_RESTARTS.max} en ${wait / 1000} s`);
    setTimeout(() => { if (!stopping) launchWorker(); }, wait);
  });
  procs.push(p);
  if (tag === 'worker') workerProc = p;
  return p;
};
const workerUrl = () => `http://127.0.0.1:${env.WORKER_HEALTH_PORT ?? 3199}/health`;
const probe = async (url) => { try { const r = await fetch(url, { signal: AbortSignal.timeout(2500) }); return r.ok ? await r.json() : null; } catch { return null; } };
const startWorker = async () => {
  // Una sola instancia: si ya hay un worker respondiendo (p. ej. levantado antes), NO se inicia otro sobre la misma sesión de WhatsApp.
  if (await probe(workerUrl())) { say(`${C.worker}[worker]${C.reset} ya hay un worker de WhatsApp en marcha; no se inicia otro (una sola sesión).`); return; }
  launchWorker();
};
// Supervisión de SALUD: si el worker deja de responder varias veces seguidas (proceso colgado, no solo caído) se reinicia, con el mismo límite de reintentos.
let unhealthy = 0;
setInterval(async () => {
  if (stopping || !workerProc) return;
  if (await probe(workerUrl())) { unhealthy = 0; return; }
  if (++unhealthy >= 4) { unhealthy = 0; say(`${C.red}[worker]${C.reset} no responde: se reinicia (reintentos limitados).`); try { process.kill(-workerProc.pid, 'SIGTERM'); } catch { /* ya terminó */ } }
}, 20_000).unref();
let workerProc = null;
const launchWorker = () => start('worker', ['--filter', '@vip/whatsapp-worker', 'dev'], { HEALTH_PORT: String(env.WORKER_HEALTH_PORT ?? 3199) }, ['PORT']);
let stopping = false;
const shutdown = (code = 0) => {
  if (stopping) return; stopping = true;
  for (const p of procs) { try { process.kill(-p.pid, 'SIGTERM'); } catch { /* ya terminó */ } }
  setTimeout(() => process.exit(code), 800);
};
process.on('SIGINT', () => shutdown(0)); process.on('SIGTERM', () => shutdown(0));

// Cada proceso recibe solo lo suyo: Angular (`ng serve`) lee la variable PORT del entorno y chocaría con la API.
start('api', ['--filter', '@vip/api', 'dev'], { PORT: String(env.PORT ?? 3100) });
start('web', ['--filter', '@vip/web', 'dev'], {}, ['PORT', 'HOST', 'DATABASE_URL', 'SESSION_ENCRYPTION_KEY']);       // el navegador nunca recibe secretos del servidor
await startWorker();
// Verificación de salud tras el arranque: API, worker (latido en la base) y modo de envío. Solo informa; no cambia nada.
setTimeout(async () => {
  const get = async (url) => { try { const r = await fetch(url, { signal: AbortSignal.timeout(3000) }); return r.ok ? await r.json() : null; } catch { return null; } };
  const api = await get(`http://127.0.0.1:${env.PORT ?? 3100}/health`);
  const wk = await get(`http://127.0.0.1:${env.WORKER_HEALTH_PORT ?? 3199}/health`);
  say(`${C.dim}Salud → API: ${api ? 'ok' : 'sin respuesta'} · Worker: ${wk ? `ok (envíos ${wk.dryRun ? 'en PRUEBA' : 'REALES'}, ${wk.sessions ? 'sesión gestionada' : ''})` : 'sin respuesta (la API sigue funcionando)'}${C.reset}`);
}, 20_000).unref();
say(`\n  ${C.web}VIP web${C.reset}   http://localhost:4300      ${C.api}API${C.reset}  http://127.0.0.1:${env.PORT ?? 3100}      ${C.worker}Worker WhatsApp${C.reset} (modo de pruebas: WHATSAPP_DRY_RUN=${env.WHATSAPP_DRY_RUN})\n  Ctrl+C detiene todo.\n`);

/**
 * Prueba de humo LOCAL con OpenWA REAL (Chrome real, WhatsApp Web real) contra un PostgreSQL TEMPORAL
 * (clúster del arnés de pruebas; nunca Supabase). NO vincula ninguna cuenta: solo comprueba que aparece un QR
 * real y que desconectar lo limpia. Uso: `pnpm --filter @vip/whatsapp-worker smoke:openwa`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/log.js';
import { Worker } from '../src/worker.js';
import { buildTemplate, connConfig, startCluster } from '../test/support/pg-cluster.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cluster = startCluster();
const sessions = mkdtempSync(join(tmpdir(), 'vip-openwa-smoke-'));
let worker: Worker | null = null;
let ok = false;
try {
  await buildTemplate(cluster);
  const cfgDb = connConfig(cluster, 'vip_template');
  const url = `postgresql://postgres@localhost/${cfgDb.database}?host=${encodeURIComponent(cluster.socketDir)}&port=${cluster.port}`;
  const admin = new pg.Client(cfgDb); await admin.connect();
  const row = async () => (await admin.query(`select status, desired_state, (qr_data is not null) has_qr, left(qr_data, 36) qr_head, length(qr_data) qr_len, qr_expires_at, phone_number, last_error, worker_heartbeat_at from public.whatsapp_sessions`)).rows[0];
  const waitFor = async (pred: (r: any) => boolean, ms: number, what: string) => {
    const t0 = Date.now();
    for (;;) { const r = await row(); if (pred(r)) return r; if (Date.now() - t0 > ms) throw new Error(`timeout (${what}); último=${JSON.stringify(r)}`); await sleep(300); }
  };
  const cfg = loadConfig({ DATABASE_URL: url, WHATSAPP_DRY_RUN: 'true', WHATSAPP_ADAPTER: 'openwa', OPENWA_SESSION_PATH: sessions, LOG_LEVEL: 'warn', SESSION_POLL_SECONDS: '1' });
  worker = new Worker(cfg, createLogger('warn'));
  await worker.start();
  console.log('worker iniciado (DRY_RUN=true, adaptador=openwa). Heartbeat:', (await waitFor((r) => r.worker_heartbeat_at !== null, 5000, 'heartbeat')).worker_heartbeat_at);

  await admin.query(`update public.whatsapp_sessions set desired_state = 'connected'`);
  const t0 = Date.now();
  const seen = new Set<string>();
  let r: any;
  for (;;) {
    r = await row(); if (!seen.has(r.status)) { seen.add(r.status); console.log(`+${((Date.now() - t0) / 1000).toFixed(1)}s status=${r.status}`); }
    if (r.status === 'awaiting_scan' && r.has_qr) break;
    if (r.status === 'failed') throw new Error(`failed: ${r.last_error}`);
    if (Date.now() - t0 > 90_000) throw new Error(`sin QR en 90 s; último=${JSON.stringify(r)}`);
    await sleep(300);
  }
  console.log(`QR REAL en base tras ${((Date.now() - t0) / 1000).toFixed(1)}s: status=${r.status}, longitud=${r.qr_len}, inicio=${r.qr_head}…, caduca=${r.qr_expires_at.toISOString()}`);
  const qr1 = (await admin.query(`select qr_data from public.whatsapp_sessions`)).rows[0].qr_data;
  // (NO se escanea nada.) Espera una renovación del QR para comprobar que se actualiza.
  const t1 = Date.now();
  for (;;) { const q = (await admin.query(`select qr_data from public.whatsapp_sessions`)).rows[0].qr_data; if (q && q !== qr1) { console.log(`QR renovado tras ${((Date.now() - t1) / 1000).toFixed(1)}s`); break; } if (Date.now() - t1 > 60_000) { console.log('(sin renovación de QR en 60 s)'); break; } await sleep(500); }

  await admin.query(`update public.whatsapp_sessions set desired_state = 'disconnected'`);
  const d = await waitFor((x) => x.status === 'disconnected', 30_000, 'disconnect');
  console.log(`desconectar: status=${d.status}, qr=${d.has_qr}, phone=${d.phone_number}`);
  if (d.has_qr || d.phone_number) throw new Error('el QR/teléfono no se limpiaron');
  await admin.end();
  ok = true;
} catch (e) {
  console.error('SMOKE FALLÓ:', (e as Error).message);
} finally {
  await worker?.stop().catch(() => undefined);
  cluster.stop();
  rmSync(sessions, { recursive: true, force: true });
}
console.log(ok ? 'SMOKE OK' : 'SMOKE FALLÓ');
process.exit(ok ? 0 : 1);

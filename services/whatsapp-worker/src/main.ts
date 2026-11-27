import { loadConfig } from './config.js';
import { createLogger } from './log.js';
import { Worker } from './worker.js';

const cfg = loadConfig();
const log = createLogger(cfg.LOG_LEVEL);
const worker = new Worker(cfg, log);

let shuttingDown = false;
const shutdown = (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, 'señal recibida');
  worker.stop().then(() => process.exit(0), (e) => { log.error({ err: String(e?.message ?? e) }, 'error al apagar'); process.exit(1); });
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
// Un fallo aislado (p. ej. del navegador) no debe tumbar el servicio.
process.on('unhandledRejection', (e) => log.error({ err: e instanceof Error ? e.message : 'unhandledRejection' }, 'promesa rechazada sin manejar'));

// Errores de red/base de datos pasajeros (ECONNRESET, ENOTFOUND… p. ej. portátil suspendido o Wi-Fi caído) NO deben tumbar el worker ni la sesión de WhatsApp.
// Cualquier otra excepción sin capturar sí es un fallo real: se registra y el proceso termina para que lo reinicie el supervisor.
const TRANSIENT = /ECONNRESET|ENOTFOUND|ETIMEDOUT|ECONNREFUSED|EPIPE|EAI_AGAIN|Connection terminated|57P01/i;
process.on('uncaughtException', (e) => {
  const msg = e instanceof Error ? `${(e as NodeJS.ErrnoException).code ?? ''} ${e.message}` : String(e);
  if (TRANSIENT.test(msg)) { log.error({ err: msg.trim() }, 'error de red/base de datos pasajero: el worker sigue en marcha'); return; }
  log.fatal({ err: msg.trim() }, 'excepción sin capturar: el worker se detiene'); process.exit(1);
});

worker.start().catch((e) => { log.fatal({ err: String(e?.message ?? e) }, 'no se pudo iniciar'); process.exit(1); });

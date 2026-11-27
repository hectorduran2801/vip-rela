import type { Server } from 'node:http';
import { FakeAdapter } from './adapters/fake.js';
import { DryRunAdapter } from './adapters/dry-run.js';
import { OpenWaAdapter } from './adapters/openwa.js';
import type { WhatsAppAdapter } from './adapters/types.js';
import { parseEncryptionKey, type Config } from './config.js';
import { Db } from './db.js';
import { startHealthServer } from './health.js';
import type { Log } from './log.js';
import { QueueProcessor } from './queue/processor.js';
import { TestMessageProcessor } from './queue/test-messages.js';
import { SessionManager } from './session/session-manager.js';

export interface WorkerOverrides {
  adapterFactory?: (sessionId: string) => WhatsAppAdapter;
}

/** Composición del worker: Db + SessionManager + QueueProcessor + health opcional. */
export class Worker {
  readonly db: Db;
  readonly sessions: SessionManager;
  readonly queue: QueueProcessor;
  readonly testMessages: TestMessageProcessor;
  private health: Server | null = null;

  constructor(private readonly cfg: Config, private readonly log: Log, over: WorkerOverrides = {}) {
    this.db = new Db(cfg.DATABASE_URL);
    // ENVÍO: dry-run => DryRunAdapter, jamás sendText real. CONEXIÓN: independiente (WHATSAPP_ADAPTER), real por defecto.
    const dryAdapter = new DryRunAdapter(log);
    const factory = over.adapterFactory ?? ((id: string) => cfg.WHATSAPP_ADAPTER === 'fake'
      ? new FakeAdapter({ autoScan: true })
      : new OpenWaAdapter(id, { sessionDataPath: cfg.OPENWA_SESSION_PATH, executablePath: cfg.CHROME_PATH || undefined, headless: cfg.OPENWA_HEADLESS }));
    this.sessions = new SessionManager({
      db: this.db, log, adapterFactory: factory,
      encryptionKey: cfg.SESSION_ENCRYPTION_KEY ? parseEncryptionKey(cfg.SESSION_ENCRYPTION_KEY) : undefined,
      pollMs: cfg.SESSION_POLL_SECONDS * 1000, heartbeatMs: cfg.HEARTBEAT_SECONDS * 1000,
      modes: { dryRun: cfg.WHATSAPP_DRY_RUN, realTestEnabled: cfg.WHATSAPP_ALLOW_REAL_TEST, automatic: cfg.AUTOMATIC_REMINDERS },
      backoff: { baseMs: cfg.RECONNECT_BASE_MS, maxMs: cfg.RECONNECT_MAX_MS },
    });
    this.queue = new QueueProcessor({
      db: this.db, log, dryRun: cfg.WHATSAPP_DRY_RUN, dryRunAdapter: dryAdapter, senders: this.sessions,
      automaticReminders: cfg.AUTOMATIC_REMINDERS, pollMs: cfg.POLL_INTERVAL_SECONDS * 1000, batchSize: cfg.BATCH_SIZE, concurrency: cfg.SEND_CONCURRENCY,
      ratePerMinute: cfg.RATE_LIMIT_PER_MINUTE, jitterMs: cfg.SEND_JITTER_MS, stuckAfterMs: cfg.STUCK_AFTER_MINUTES * 60_000,
      noSessionRetryMs: cfg.NO_SESSION_RETRY_SECONDS * 1000, sendTimeoutMs: cfg.SEND_TIMEOUT_SECONDS * 1000,
    });
    this.testMessages = new TestMessageProcessor({ db: this.db, log, dryRunAdapter: dryAdapter, senders: this.sessions,
      realTestEnabled: cfg.WHATSAPP_ALLOW_REAL_TEST, dryRun: cfg.WHATSAPP_DRY_RUN, sendTimeoutMs: cfg.SEND_TIMEOUT_SECONDS * 1000 });
  }

  async start(): Promise<void> {
    await this.sessions.start();
    this.queue.start();
    this.testMessages.start();
    if (this.cfg.HEALTH_PORT) this.health = await startHealthServer(this.cfg.HEALTH_PORT, () => this.status());
    this.log.info({ dryRun: this.cfg.WHATSAPP_DRY_RUN, adapter: this.cfg.WHATSAPP_ADAPTER, health: this.cfg.HEALTH_PORT ?? null }, 'whatsapp-worker iniciado');
  }

  /** Apagado ordenado: termina el lote actual, cierra sesiones y pool. */
  async stop(): Promise<void> {
    this.log.info('apagando whatsapp-worker');
    // Cada paso queda registrado con su duración y tiene límite: un paso atascado no puede dejar el proceso (y sus navegadores) vivo.
    const step = async (name: string, ms: number, fn: () => Promise<unknown>) => {
      const t0 = Date.now(); let t: NodeJS.Timeout | undefined;
      const late = new Promise<'late'>((r) => { t = setTimeout(() => r('late'), ms); });
      const res = await Promise.race([fn().then(() => 'ok' as const, () => 'error' as const), late]);
      clearTimeout(t);
      this.log.info({ step: name, ms: Date.now() - t0, result: res }, 'apagado: paso');
    };
    await step('cola', 10_000, () => this.queue.stop());
    await step('mensajes', 10_000, () => this.testMessages.stop());
    await step('sesiones', 30_000, () => this.sessions.stop());
    await step('salud', 3_000, () => new Promise<void>((r) => (this.health ? this.health.close(() => r()) : r())));
    await step('base', 5_000, () => this.db.close());
    this.log.info('whatsapp-worker detenido');
  }

  status() {
    return { ok: true, dryRun: this.cfg.WHATSAPP_DRY_RUN, realTestEnabled: this.cfg.WHATSAPP_ALLOW_REAL_TEST, queue: this.queue.status(), sessions: this.sessions.status() };
  }
}

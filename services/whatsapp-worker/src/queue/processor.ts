import type { SendResult, WhatsAppAdapter } from '../adapters/types.js';
import type { Db } from '../db.js';
import { maskPhone, sanitizeError, type Log } from '../log.js';
import { createLimit } from './limit.js';
import { isUncertain } from './test-messages.js';
import { RateLimiter } from './rate-limiter.js';

export interface SenderProvider {
  /** Adaptador conectado de la sesión de ESA cuenta (null si no hay: no se usa otra). */
  senderFor(accountId: string | null | undefined): WhatsAppAdapter | null;
  anyConnected(): boolean;
  /** Hay una sesión que estaba conectada y se está reconectando (hace poco). */
  recovering?(): boolean;
}

export interface ProcessorOptions {
  db: Db;
  log: Log;
  /** true => NUNCA se llama a `senders`; se usa `dryRunAdapter` y se marca dry_run=true. */
  dryRun: boolean;
  dryRunAdapter: WhatsAppAdapter;
  senders: SenderProvider;
  pollMs?: number;
  batchSize?: number;
  /** Recordatorios automáticos (horarios + trabajos de notificación). Por defecto FALSE: VIP envía solo lo que la administradora inicia a mano (cola de mensajes de prueba/cobranza). */
  automaticReminders?: boolean;
  concurrency?: number;
  ratePerMinute?: number;
  jitterMs?: number;
  stuckAfterMs?: number;
  noSessionRetryMs?: number;
  /** Aplazamiento de un job diferido (otro envío del mismo conductor en curso). */
  deferRetryMs?: number;
  sendTimeoutMs?: number;
  /** Reloj inyectable: se pasa como p_now a las funciones SQL. */
  clock?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** Ritmo entre envíos reales (por defecto el de config). */
  rateLimiter?: Pick<RateLimiter, 'acquire'>;
}

export interface JobRow { account_id?: string | null;
  id: string; driver_id: string; kind: string; attempts: number; local_date: string;
}
interface Prepared { action: 'send' | 'skip' | 'defer'; reason?: string; phone?: string; body?: string }

export interface BatchResult {
  requeued: number; scheduled: number; claimed: number;
  sent: number; skipped: number; failed: number; released: number; errors: number;
  idle?: 'no_session' | 'manual_only';
}
export interface QueueStats extends BatchResult { ticks: number; lastTickAt: string | null; running: boolean; lastError: string | null }

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Bucle de la cola. Toda la lógica de saldo y redacción vive en SQL (prepare_notification_send); este
 * código solo orquesta y nunca recalcula saldos.
 *
 * Instancia única: una sola sesión de WhatsApp. "Sin sesión conectada" (no dry-run): el trabajo se
 * DEVUELVE a `pending` con `release_notification` (sin consumir intento) aplazado `noSessionRetryMs`;
 * si la sesión no está conectada ni siquiera se reclaman jobs.
 *
 * Verificación final: inmediatamente antes de `sendText` (tras esperar el rate limiter) se vuelve a llamar
 * a `prepare_notification_send` con p_now = clock() y se usa SU resultado (puede haber cambiado el saldo
 * o llegado un pago). `defer` (otro envío del mismo conductor en curso) libera el job sin gastar intento.
 */
const TICK_WATCHDOG_MS = 120_000;

export class QueueProcessor {
  private stopping = false;
  private loop: Promise<void> | null = null;
  private wake: (() => void) | null = null;
  private current: Promise<unknown> | null = null;
  private readonly cfg: Required<Omit<ProcessorOptions, 'db' | 'log' | 'dryRunAdapter' | 'senders' | 'dryRun' | 'rateLimiter' | 'automaticReminders'>>;
  private readonly rate: Pick<RateLimiter, 'acquire'>;
  private stats: QueueStats = { requeued: 0, scheduled: 0, claimed: 0, sent: 0, skipped: 0, failed: 0, released: 0, errors: 0,
    ticks: 0, lastTickAt: null, running: false, lastError: null };

  constructor(private readonly o: ProcessorOptions) {
    this.cfg = {
      pollMs: o.pollMs ?? 15_000, batchSize: o.batchSize ?? 10, concurrency: o.concurrency ?? 2,
      ratePerMinute: o.ratePerMinute ?? 20, jitterMs: o.jitterMs ?? 1500, stuckAfterMs: o.stuckAfterMs ?? 600_000,
      noSessionRetryMs: o.noSessionRetryMs ?? 60_000, deferRetryMs: o.deferRetryMs ?? 30_000, sendTimeoutMs: o.sendTimeoutMs ?? 45_000,
      clock: o.clock ?? (() => new Date()), sleep: o.sleep ?? realSleep,
    };
    this.rate = o.rateLimiter ?? new RateLimiter(this.cfg.ratePerMinute, this.cfg.jitterMs);
  }

  start(): void {
    if (this.loop) return;
    this.stats.running = true;
    this.loop = (async () => {
      while (!this.stopping) {
        this.current = this.tick();
        // Vigilante: si un ciclo no termina en TICK_WATCHDOG_MS (consulta o envío colgados), se abandona y se sigue con el siguiente.
        let timer: NodeJS.Timeout | undefined;
        const stalled = new Promise<'stalled'>((r) => { timer = setTimeout(() => r('stalled'), TICK_WATCHDOG_MS); });
        const outcome = await Promise.race([this.current.then(() => 'ok' as const), stalled]);
        clearTimeout(timer);
        if (outcome === 'stalled') {
          this.stats.errors++; this.stats.lastError = `ciclo de la cola sin terminar tras ${TICK_WATCHDOG_MS / 1000}s: se abandona y se reinicia`;
          this.o.log.error({ afterMs: TICK_WATCHDOG_MS }, 'ciclo de la cola atascado; se continúa con el siguiente');
        }
        if (this.stopping) break;
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, this.cfg.pollMs);
          this.wake = () => { clearTimeout(t); resolve(); };
        });
        this.wake = null;
      }
      this.stats.running = false;
    })();
  }

  /** Apagado ordenado: termina el lote en curso y no inicia otro. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.wake?.();
    await this.loop;
  }

  status(): QueueStats { return { ...this.stats }; }

  /** Un ciclo completo; nunca lanza. */
  async tick(): Promise<BatchResult> {
    const r = await this.runBatch().catch((e) => {
      this.stats.errors++; this.stats.lastError = sanitizeError(e);
      this.o.log.error({ err: sanitizeError(e) }, 'tick de la cola falló');
      return empty();
    });
    this.stats.ticks++; this.stats.lastTickAt = new Date().toISOString();
    return r;
  }

  private async runBatch(): Promise<BatchResult> {
    const { db, log } = this.o;
    const now = this.cfg.clock();
    const res = empty();

    res.requeued = await this.guarded('requeue_stuck_notifications', () =>
      db.tx((q) => q.one<{ n: number }>(`select public.requeue_stuck_notifications($1::interval, $2) n`,
        [`${Math.round(this.cfg.stuckAfterMs / 1000)} seconds`, now])).then((r) => r.n), 0);
    await this.purgeOnNewDay(now);                                                   // mantenimiento diario (no depende de los recordatorios)
    if (!this.o.automaticReminders) { res.idle = 'manual_only'; return this.accumulate(res); }          // sin recordatorios automáticos: ni se programan ni se reclaman trabajos por tiempo
    // Horarios de envío (plantilla + audiencia + hora): crean los mensajes con el método de Cobranza; cada horario corre una sola vez por día.
    await this.guarded('run_send_schedules', () => db.tx((q) => q.rows(`select public.run_send_schedules($1::timestamptz) r`, [now])), []);
    res.scheduled = await this.guarded('schedule_reminders', () =>
      db.tx((q) => q.one<{ n: number }>(`select public.schedule_reminders($1) n`, [now])).then((r) => r.n), 0);

    if (!this.o.dryRun && !this.o.senders.anyConnected()) {
      res.idle = 'no_session';
      log.debug('sin sesión conectada: no se reclaman trabajos');
      return this.accumulate(res);
    }

    const jobs = await db.tx((q) => q.rows<JobRow>(`select * from public.claim_notification_jobs($1, $2)`, [this.cfg.batchSize, now]));
    res.claimed = jobs.length;
    if (jobs.length === 0) return this.accumulate(res);

    const limit = createLimit(this.cfg.concurrency);
    await Promise.all(jobs.map((j) => limit(() => this.handle(j, res))));
    log.info({ claimed: res.claimed, sent: res.sent, skipped: res.skipped, failed: res.failed, released: res.released }, 'lote procesado');
    return this.accumulate(res);
  }

  private async handle(job: JobRow, res: BatchResult): Promise<void> {
    const { log } = this.o;
    const dry = this.o.dryRun;
    try {
      const adapter = dry ? this.o.dryRunAdapter : this.o.senders.senderFor(job.account_id);
      if (!adapter) { await this.release(job, this.cfg.noSessionRetryMs); res.released++; log.info({ jobId: job.id, kind: job.kind }, 'sin sesión conectada: job devuelto a pending sin consumir intento'); return; }

      // 1ª preparación (decide si vale la pena esperar el turno del rate limiter).
      const first = await this.prepare(job, res);
      if (!first) return;

      let sendErr: unknown = null;
      let result: SendResult | null = null;
      let prep: Prepared = first;
      try {
        if (!dry) await this.rate.acquire();
        // VERIFICACIÓN FINAL: el saldo pudo cambiar mientras esperábamos; se usa el resultado más reciente.
        const final = await this.prepare(job, res);
        if (!final) return;
        prep = final;
        result = await this.withTimeout(adapter.sendText(prep.phone!, prep.body!), this.cfg.sendTimeoutMs);
      } catch (e) { sendErr = e; }

      if (sendErr === null) {
        // Resultado del proveedor SOLO de un envío real y solo lo que el adaptador devolvió: nunca se inventa un acuse ni se marca «entregado».
        const prov = dry || !result || result.simulated ? null : {
          messageId: result.messageId ?? null,
          sender: result.sender ?? adapter.getPhoneNumber?.() ?? null,
          recipient: prep.phone ?? null,
        };
        await this.completeWithRetry(job.id, 'sent', null, dry, prep.body!, prov);
        res.sent++;
        log.info({ jobId: job.id, kind: job.kind, to: maskPhone(prep.phone), dryRun: dry, messageId: result?.messageId }, 'enviado');
      } else {
        const msg = sanitizeError(sendErr);
        // Resultado INCIERTO (OpenWA outcome 'unknown', tiempo de espera): la solicitud ya salió hacia el proveedor y puede haberse entregado.
        // No se reintenta (duplicaría el mensaje), no se marca enviado ni entregado: queda `failed` con el motivo para revisión manual.
        const status = await this.completeWithRetry(job.id, isUncertain(sendErr) ? 'uncertain' : 'failed', msg, dry, null);
        res.failed++;
        log.warn({ jobId: job.id, kind: job.kind, to: maskPhone(prep.phone), attempt: job.attempts, next: status, err: msg }, 'envío falló');
      }
    } catch (e) {
      // Fallo de infraestructura (p. ej. base caída): el trabajo queda en processing y lo recupera requeue_stuck.
      res.errors++; this.stats.lastError = sanitizeError(e);
      log.error({ jobId: job.id, err: sanitizeError(e) }, 'error procesando trabajo');
    }
  }

  /**
   * Llama a prepare_notification_send. Devuelve la preparación solo si hay que enviar; si es `skip`,
   * `defer` o un error de negocio ya registra el resultado (y los contadores) y devuelve null.
   */
  private async prepare(job: JobRow, res: BatchResult): Promise<Prepared | null> {
    const { db, log } = this.o;
    let prep: Prepared;
    try {
      prep = await db.tx((q) => q.one<{ p: Prepared }>(`select public.prepare_notification_send($1, $2) p`, [job.id, this.cfg.clock()])).then((r) => r.p);
    } catch (e) {
      // Error de negocio al preparar (p. ej. not_approved): se registra como intento fallido.
      const msg = sanitizeError(e);
      await this.completeWithRetry(job.id, 'failed', msg, this.o.dryRun, null);
      res.failed++;
      log.warn({ jobId: job.id, kind: job.kind, err: msg }, 'prepare_notification_send falló');
      return null;
    }
    if (prep.action === 'skip') { res.skipped++; log.info({ jobId: job.id, kind: job.kind, outcome: prep.reason }, 'trabajo omitido'); return null; }
    if (prep.action === 'defer') {
      await this.release(job, this.cfg.deferRetryMs);
      res.released++;
      log.info({ jobId: job.id, kind: job.kind, reason: prep.reason }, 'trabajo diferido: otro envío del conductor en curso');
      return null;
    }
    return prep;
  }

  /** complete_notification con reintentos cortos: tras un envío real no queremos dejar el job en processing. */
  private async completeWithRetry(id: string, outcome: 'sent' | 'failed' | 'uncertain', error: string | null, dry: boolean, body: string | null,
    prov: { messageId: string | null; sender: string | null; recipient: string | null } | null = null): Promise<string> {
    let last: unknown;
    for (let i = 0; i < 4; i++) {
      try {
        return await this.o.db.tx((q) => q.one<{ s: string }>(
          `select public.complete_notification($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) s`,
          [id, outcome, error, dry, body, this.cfg.clock(), prov?.messageId ?? null, prov?.sender ?? null, prov?.recipient ?? null,
            prov?.messageId ? 'accepted' : null])).then((r) => r.s);        // 'accepted' = el proveedor aceptó el envío; «delivered/read» solo con acuse real (aún no hay)
      } catch (e) { last = e; await this.cfg.sleep(200 * 2 ** i); }
    }
    throw last;
  }

  /** Devuelve el job a pending sin consumir el intento y lo aplaza (release_notification). */
  private async release(job: JobRow, delayMs: number): Promise<void> {
    await this.o.db.tx((q) => q.rows(`select public.release_notification($1, $2 * interval '1 millisecond', $3)`, [job.id, delayMs, this.cfg.clock()]));
  }

  private lastPurgeDay: string | null = null;
  /** Jornada diaria de Cobranza: una vez por día local (America/Panama) se eliminan los mensajes de cobranza de días anteriores YA terminados.
   *  Nunca toca pendientes, en proceso ni sin confirmar. Si la función aún no existe en la base, se registra el aviso una vez al día y no se reintenta. */
  private async purgeOnNewDay(now: Date): Promise<void> {
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Panama', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
    if (this.lastPurgeDay === day) return;
    this.lastPurgeDay = day;
    const r = await this.guarded('purge_collection_messages', () => this.o.db.tx((q) => q.one<{ r: { deleted: number } }>(`select public.purge_collection_messages() r`)), null);
    if (r && r.r.deleted > 0) this.o.log.info({ deleted: r.r.deleted }, 'jornada nueva: mensajes de cobranza de días anteriores eliminados');
  }

  private async guarded<T>(name: string, fn: () => Promise<T>, fallback: T): Promise<T> {
    try { return await fn(); }
    catch (e) { this.stats.errors++; this.stats.lastError = sanitizeError(e); this.o.log.error({ step: name, err: sanitizeError(e) }, 'paso de la cola falló'); return fallback; }
  }

  private withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    let t: NodeJS.Timeout;
    const timeout = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error('timeout enviando mensaje')), ms); });
    // Si el adaptador cuelga y rechaza después, evita un unhandledRejection.
    p.catch(() => undefined);
    return Promise.race([p, timeout]).finally(() => clearTimeout(t));
  }

  private accumulate(r: BatchResult): BatchResult {
    for (const k of ['requeued', 'scheduled', 'claimed', 'sent', 'skipped', 'failed', 'released', 'errors'] as const) this.stats[k] += r[k];
    return r;
  }
}

const empty = (): BatchResult => ({ requeued: 0, scheduled: 0, claimed: 0, sent: 0, skipped: 0, failed: 0, released: 0, errors: 0 });

import type { Database } from './db.js';

interface EngineLog { info: (o: object, m?: string) => void; warn: (o: object, m?: string) => void; error: (o: object, m?: string) => void }

export interface BillingEngineOptions {
  db: Database;
  log: EngineLog;
  /** Intervalo entre comprobaciones (por defecto 5 min). Siempre se comprueba además justo después de la medianoche local. */
  intervalMs?: number;
  timezone?: string;
  /** Reloj y esperas inyectables para pruebas. */
  clock?: () => Date;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
}

export interface EnsureResult { created: number; from: string; to: string; days_checked: number; skipped: string | null; gaps_total: number }

/**
 * MOTOR DE COBRANZA (proceso de la API, independiente de OpenWA): ejecuta `ensure_daily_charges` al arrancar, luego cada `intervalMs`
 * y justo al cambiar de día local (America/Panama). Si la base no responde reintenta con backoff exponencial sin tumbar la API.
 * La exclusión mutua y la idempotencia viven en la base (advisory lock + índice único), así que varias instancias no duplican.
 */
export class BillingEngine {
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private failures = 0;
  private lastLocalDate: string | null = null;
  private running: Promise<EnsureResult | null> | null = null;
  readonly stats = { runs: 0, created: 0, failures: 0, locked: 0, lastRunAt: null as string | null, lastError: null as string | null, gapsTotal: 0 };

  constructor(private readonly o: BillingEngineOptions) {}

  private localDate(d: Date): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: this.o.timezone ?? 'America/Panama', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.cycle();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.running?.catch(() => undefined);
  }

  /** Una ejecución (también usada por las pruebas). Nunca lanza: devuelve null si falló. */
  runOnce(): Promise<EnsureResult | null> {
    if (this.running) return this.running;
    this.running = (async () => {
      const now = (this.o.clock ?? (() => new Date()))();
      try {
        if (!this.o.db.asService) throw new Error('db_without_service_connection');
        // p_through = hoy LOCAL (America/Panama), calculado aquí para respetar el reloj inyectado; la base valida y es idempotente.
        const through = this.localDate(now);
        const r = (await this.o.db.asService((tx) => tx.one<{ r: EnsureResult }>(`select public.ensure_daily_charges($1::date) r`, [through])))!.r;
        this.stats.runs++; this.stats.created += r.created; this.stats.lastRunAt = now.toISOString(); this.stats.lastError = null; this.stats.gapsTotal = r.gaps_total;
        if (r.skipped === 'locked') this.stats.locked++;
        this.failures = 0; this.lastLocalDate = through;
        // Resumen de cobranza al día sin navegador: tras la medianoche local (primer ciclo del día) y tras cualquier cambio pendiente. Si falla, la lectura lo recalcula sola.
        try {
          await this.o.db.asService(async (tx) => {
            const has = await tx.one<{ ok: boolean }>(`select to_regprocedure('public.refresh_collection_summaries()') is not null ok`);
            if (has?.ok) await tx.one(`select public.refresh_collection_summaries()`);
          });
        } catch (e) { this.o.log.warn({ err: e instanceof Error ? e.message.slice(0, 200) : 'error' }, 'no se pudo actualizar el resumen de cobranza'); }
        if (r.created > 0) this.o.log.info({ created: r.created, from: r.from, to: r.to }, 'motor de cobranza: cuotas generadas');
        if (r.gaps_total > 0) this.o.log.warn({ gaps: r.gaps_total }, 'motor de cobranza: hay cuotas sin generar fuera de la ventana de recuperación o en semanas cerradas');
        return r;
      } catch (e) {
        this.failures++; this.stats.failures++;
        this.stats.lastError = e instanceof Error ? e.message.slice(0, 200) : 'error';
        this.o.log.error({ err: this.stats.lastError, attempt: this.failures }, 'motor de cobranza: falló la generación (se reintenta)');
        return null;
      } finally { this.running = null; }
    })();
    return this.running;
  }

  private async cycle(): Promise<void> {
    if (this.stopped) return;
    await this.runOnce();
    if (this.stopped) return;
    const interval = this.o.intervalMs ?? 300_000;
    const backoff = this.failures > 0 ? Math.min((this.o.backoffBaseMs ?? 5_000) * 2 ** (this.failures - 1), this.o.backoffMaxMs ?? 300_000) : interval;
    // Si el próximo ciclo cruzaría la medianoche local, se adelanta a justo después (+5 s).
    const wait = Math.max(1_000, Math.min(backoff, this.msToLocalMidnight() + 5_000));
    this.timer = setTimeout(() => { void this.cycle(); }, wait);
    this.timer.unref?.();
  }

  private msToLocalMidnight(): number {
    const now = (this.o.clock ?? (() => new Date()))();
    const today = this.localDate(now);
    // Primer instante cuyo día local cambia: búsqueda por pasos de 1 min sobre las próximas 24 h (sin depender de la tabla de zonas).
    for (let m = 1; m <= 1440; m++) if (this.localDate(new Date(now.getTime() + m * 60_000)) !== today) return m * 60_000;
    return 3_600_000;
  }
}

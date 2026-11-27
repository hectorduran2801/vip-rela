import type { WhatsAppAdapter } from '../adapters/types.js';
import type { Db } from '../db.js';
import { maskPhone, sanitizeError, type Log } from '../log.js';
import type { SenderProvider } from './processor.js';

export interface TestMessageOptions {
  db: Db; log: Log;
  /** Adaptador de simulación (jamás envía). */
  dryRunAdapter: WhatsAppAdapter;
  senders: SenderProvider;
  /** Interruptor EXPLÍCITO del servidor (WHATSAPP_ALLOW_REAL_TEST). Sin él, un mensaje real pedido FALLA: no se simula como si se hubiera enviado. */
  realTestEnabled: boolean;
  /** WHATSAPP_DRY_RUN: decide el modo de los mensajes a conductores («auto»): true = simulado, false = real. La administradora no lo elige. */
  dryRun?: boolean;
  pollMs?: number;
  sendTimeoutMs?: number;
  stuckAfterMs?: number;
}

interface TestRow { account_id?: string | null; id: string; recipient_phone: string; body: string; requested_mode: 'simulated' | 'real' | 'auto' }
export interface TestOutcome { id: string; status: 'simulated' | 'sent' | 'failed' | 'unconfirmed'; error?: string }

/** ¿El error deja DUDA sobre si WhatsApp aceptó el mensaje? (OpenWA outcome 'unknown', texto «could not confirm», tiempo de espera). */
export function isUncertain(e: unknown): boolean {
  const o = (e as { outcome?: string })?.outcome; const m = e instanceof Error ? e.message : String(e);
  if (o === 'not_sent') return false;
  return o === 'unknown' || /could not confirm the result|may have been sent|timeout enviando mensaje/i.test(m);
}

/**
 * Cola APARTE de la de cobranza, de uno en uno: solo atiende `whatsapp_test_messages` (creados por SUPER_ADMIN, nunca a conductores).
 *  · simulated → DryRunAdapter, estado `simulated`.
 *  · real → solo si realTestEnabled Y hay sesión conectada; estado `sent` (= aceptado por el proveedor, NUNCA «entregado»).
 *  · Un fallo NO se reintenta: un envío real pudo haber salido. Lo atascado se marca failed.
 * La DB ya exigió: SUPER_ADMIN, destinatario no-conductor, declaración + últimos 4 dígitos, y una sola operación real pendiente.
 */
export class TestMessageProcessor {
  private timer: NodeJS.Timeout | null = null;
  private busy: Promise<unknown> | null = null;
  private stopping = false;

  constructor(private readonly o: TestMessageOptions) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, this.o.pollMs ?? 3000);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    await this.busy?.catch(() => undefined);
  }

  /** Procesa a lo sumo UN mensaje (nunca lanza). */
  tick(): Promise<TestOutcome | null> {
    if (this.busy || this.stopping) return Promise.resolve(null);
    const p = this.run().catch((e) => { this.o.log.error({ err: sanitizeError(e) }, 'cola de mensajes de prueba falló'); return null; })
      .finally(() => { this.busy = null; });
    this.busy = p;
    return p;
  }

  private async run(): Promise<TestOutcome | null> {
    const { db, log } = this.o;
    // WhatsApp reconectando: lo que está en cola espera en lugar de marcarse fallido uno tras otro.
    if (!(this.o.dryRun ?? true) && this.o.senders.recovering?.()) return null;
    await db.tx((q) => q.rows(`select public.fail_stuck_test_messages($1::interval)`, [`${Math.round((this.o.stuckAfterMs ?? 300_000) / 1000)} seconds`]));
    const m = await db.tx((q) => q.one<TestRow | null>(`select * from public.claim_test_message()`));
    if (!m?.id) return null;

    const finish = async (status: TestOutcome['status'], sender: string | null, providerId: string | null, error: string | null, detail: string | null = null): Promise<TestOutcome> => {
      await db.tx((q) => q.rows(`select public.complete_test_message($1,$2,$3,$4,$5,$6)`, [m.id, status, sender, providerId, error, detail]));
      log.info({ testMessageId: m.id, status, mode: m.requested_mode, to: maskPhone(m.recipient_phone) }, 'mensaje de prueba procesado');
      return { id: m.id, status, ...(error ? { error } : {}) };
    };

    try {
      const simulate = m.requested_mode === 'simulated' || (m.requested_mode === 'auto' && (this.o.dryRun ?? true));
      if (simulate) {
        const r = await this.o.dryRunAdapter.sendText(m.recipient_phone, m.body);
        return await finish('simulated', this.o.senders.senderFor(m.account_id)?.getPhoneNumber?.() ?? null, r.messageId ?? null, null);
      }
      // «real» (prueba externa) exige el interruptor explícito; «auto» (conductor registrado) real solo si el envío global está activo (WHATSAPP_DRY_RUN=false).
      if (m.requested_mode === 'real' && !this.o.realTestEnabled) return await finish('failed', null, null, 'real_send_disabled: el worker no tiene habilitado el envío real de prueba (WHATSAPP_ALLOW_REAL_TEST)');
      const adapter = this.o.senders.senderFor(m.account_id);
      if (!adapter) return await finish('failed', null, null, 'sin_sesion: WhatsApp no está conectado');
      // Antes de enviar se comprueba que WhatsApp responde: si no, el mensaje no sale y queda listo para reintentar.
      if (adapter.ping && !(await adapter.ping())) return await finish('failed', null, null, 'No salió: WhatsApp dejó de responder y se está reconectando. Usa «Reintentar» en un momento.');
      const sender = adapter.getPhoneNumber?.() ?? null;
      try {
        const r = await this.withTimeout(adapter.sendText(m.recipient_phone, m.body), this.o.sendTimeoutMs ?? 45_000);
        return await finish('sent', sender, r.messageId ?? null, null);
      } catch (e) {
        // Incierto ≠ fallido: WhatsApp pudo haberlo aceptado. No se reintenta y queda «sin confirmar» hasta que un SUPER_ADMIN revise el chat.
        const detail = (e as { detail?: string })?.detail ?? null;
        if (isUncertain(e)) return await finish('unconfirmed', sender, null, 'Resultado sin confirmar: WhatsApp pudo haber aceptado el mensaje. Revisa el chat antes de reintentar.', [sanitizeError(e), detail].filter(Boolean).join(' · '));
        return await finish('failed', sender, null, sanitizeError(e), detail);
      }
    } catch (e) {
      return await finish('failed', null, null, sanitizeError(e));
    }
  }

  private withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    let t: NodeJS.Timeout;
    const timeout = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error('timeout enviando mensaje')), ms); });
    p.catch(() => undefined);
    return Promise.race([p, timeout]).finally(() => clearTimeout(t));
  }
}

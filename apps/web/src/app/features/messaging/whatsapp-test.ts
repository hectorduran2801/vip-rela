import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { formatUSD, toCents } from '@vip/shared';
import { formatDateTime12h } from '../../core/dates';
import { errorMessage } from '../../core/errors';
import { TEST_STATUS_LABEL, TIMEZONE, type TestMessage, type TestMessageKind, type TestMessageStatus, type TestPreview } from '../../core/models';
import { formatPhone, maskPhone } from '../../core/phone';
import { ApiService, AuthService, DataService, NEW_KEY } from '../../core/services';
import { WhatsappState } from '../../core/whatsapp-state';
import { ErrText, Icon, LoadingState } from '../../shared/ui';
import { BusyButton } from '../../shared/busy';
import { IconButton } from '../../shared/icon-button';

export const TEST_MAX = 1000;
export const TEST_REFRESH_MS = 4000;
const OPEN: readonly TestMessageStatus[] = ['prepared', 'processing'];

/**
 * «Enviar mensaje de prueba» (solo SUPER_ADMIN; la ruta lleva `superGuard`). Un único destinatario, nunca conductores ni envíos masivos.
 * Flujo: Vista previa (valida y muestra emisor/modo) → Enviar. Simulado por defecto; el envío real exige casilla + quién autoriza +
 * últimos 4 dígitos + confirmación final, y solo se habilita si el worker lo informa (`real_test_enabled`). Independiente de la ruta.
 */
@Component({
  selector: 'app-whatsapp-test',
  imports: [IconButton, BusyButton, ErrText, Icon, LoadingState, RouterLink],
  templateUrl: './whatsapp-test.html',
})
export class WhatsappTest {
  private readonly api = inject(ApiService);
  private readonly data = inject(DataService);
  private readonly newKey = inject(NEW_KEY);
  protected readonly state = inject(WhatsappState);
  /** Misma fuente que el encabezado: solo se prueba con sesión conectada y servicio (worker) activo. */
  protected readonly gate = this.state.testGate;
  protected readonly labels = TEST_STATUS_LABEL;
  protected readonly max = TEST_MAX;

  protected readonly phone = signal('');
  protected readonly body = signal('');
  protected readonly kind = signal<TestMessageKind>('test');
  protected readonly mode = signal<'simulated' | 'real'>('simulated');
  protected readonly preview = signal<TestPreview | null>(null);
  private readonly previewFor = signal<{ phone: string; body: string } | null>(null);
  private idemKey = '';
  protected readonly own = signal(false);
  protected readonly finalStep = signal(false);
  protected readonly busy = signal(false);
  protected readonly sending = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly sent = signal<string | null>(null);
  protected readonly history = signal<TestMessage[]>([]);
  protected readonly historyError = signal<string | null>(null);
  protected readonly historyLoaded = signal(false);

  // Comprobante de prueba
  protected readonly usd = formatUSD;

  /** La vista previa solo vale para el número y el texto con que se pidió. */
  protected readonly fresh = computed(() => { const p = this.previewFor(); return !!p && p.phone === this.phone() && p.body === this.body(); });
  protected readonly blocked = computed(() => { const p = this.preview(); return !p || p.invalidPhone || p.recipientIsADriver || !p.recipient; });
  protected readonly realAllowed = computed(() => !!this.preview()?.realTestEnabled);
  /** Un envío REAL sin confirmar bloquea nuevos envíos reales (el simulado sigue disponible). */
  protected readonly realBlocked = computed(() => this.history().some((m) => m.status === 'unconfirmed' && m.requestedMode === 'real'));
  protected readonly real = computed(() => this.history().filter((m) => m.requestedMode === 'real'));
  protected readonly simulated = computed(() => this.history().filter((m) => m.requestedMode !== 'real'));
  protected readonly detailId = signal<string | null>(null);
  protected readonly resolving = signal<{ id: string; arrived: boolean } | null>(null);
  protected readonly resolveNote = signal('');
  protected readonly resolveBusy = signal(false);
  protected readonly realReady = computed(() => this.own());
  private readonly auth = inject(AuthService, { optional: true });
  protected readonly canSend = computed(() => this.fresh() && !this.blocked() && !this.sending() && (this.mode() === 'simulated' || (this.realAllowed() && !this.realBlocked() && this.realReady())));
  protected readonly masked = computed(() => maskPhone(this.preview()?.recipient ?? ''));
  protected readonly time = (iso: string) => formatDateTime12h(iso, TIMEZONE);
  protected readonly show = formatPhone;

  private timer: ReturnType<typeof setTimeout> | undefined;
  private destroyed = false;

  constructor() {
    inject(DestroyRef).onDestroy(() => { this.destroyed = true; clearTimeout(this.timer); });
    void this.loadHistory();
  }

  protected setPhone(v: string): void { this.phone.set(v); this.finalStep.set(false); }
  protected setBody(v: string): void { this.body.set(v); this.kind.set('test'); this.finalStep.set(false); }
  protected setMode(m: 'simulated' | 'real'): void { this.mode.set(m); this.finalStep.set(false); }

  protected async doPreview(): Promise<void> {
    if (this.busy() || !this.phone().trim() || !this.body().trim()) return;
    this.busy.set(true); this.error.set(null); this.sent.set(null); this.finalStep.set(false);
    try {
      const p = await this.api.whatsappTestPreview(this.phone(), this.body());
      this.preview.set(p); this.previewFor.set({ phone: this.phone(), body: this.body() });
      this.idemKey = this.newKey();   // una clave por vista previa: el doble clic en «Enviar» no duplica
      if (!p.realTestEnabled) this.mode.set('simulated');
    } catch (e) { this.error.set(errorMessage(e)); this.preview.set(null); this.previewFor.set(null); }
    finally { this.busy.set(false); }
  }

  /** Simulado: envía de una vez. Real: primero la confirmación final explícita. */
  protected send(): void {
    if (!this.canSend()) return;
    if (this.mode() === 'real' && !this.finalStep()) { this.finalStep.set(true); return; }
    void this.doSend();
  }
  protected async doSend(): Promise<void> {
    if (this.sending() || !this.canSend()) return;
    this.sending.set(true); this.error.set(null);
    const real = this.mode() === 'real';
    try {
      await this.api.whatsappTestSend({
        phone: this.phone(), body: this.body(), mode: this.mode(), idempotencyKey: this.idemKey, kind: this.kind(),
        ...(real ? { recipientAuthorization: `Confirmado por ${this.auth?.user()?.email ?? 'usuario'} en pantalla` } : {}),
      });
      this.sent.set(real ? 'Mensaje real puesto en cola. Aparece abajo con su estado.' : 'Mensaje simulado registrado: no se envió nada.');
      this.preview.set(null); this.previewFor.set(null); this.finalStep.set(false); this.own.set(false);
      await this.loadHistory();
    } catch (e) { this.error.set(errorMessage(e)); this.finalStep.set(false); }
    finally { this.sending.set(false); }
  }

  protected async loadHistory(): Promise<void> {
    clearTimeout(this.timer);
    try { this.history.set(await this.api.whatsappTestList()); this.historyError.set(null); }
    catch (e) { this.historyError.set(errorMessage(e)); }
    this.historyLoaded.set(true);
    if (!this.destroyed && this.history().some((m) => OPEN.includes(m.status))) this.timer = setTimeout(() => { if (!document.hidden) void this.loadHistory(); else this.timer = setTimeout(() => void this.loadHistory(), TEST_REFRESH_MS); }, TEST_REFRESH_MS);
  }
  protected async cancel(m: TestMessage): Promise<void> {
    try { await this.api.whatsappTestCancel(m.id); } catch (e) { this.historyError.set(errorMessage(e)); }
    await this.loadHistory();
  }
  /** Verde: simulado, enviado al proveedor, entregado. Ámbar: en curso y «sin confirmar» (advertencia, no error). Rojo: fallido confirmado. */
  protected tone(s: TestMessageStatus): string { return s === 'delivered' || s === 'sent' || s === 'simulated' ? 'paid' : s === 'failed' ? 'pending' : s === 'unconfirmed' || s === 'prepared' || s === 'processing' ? 'attn' : ''; }
  protected toggleDetail(m: TestMessage): void { this.detailId.set(this.detailId() === m.id ? null : m.id); }
  protected askResolve(m: TestMessage, arrived: boolean): void { this.resolveNote.set(''); this.resolving.set({ id: m.id, arrived }); }
  protected async confirmResolve(): Promise<void> {
    const r = this.resolving();
    if (!r || this.resolveBusy()) return;
    this.resolveBusy.set(true);
    let err: string | null = null;
    try { await this.api.whatsappTestResolve(r.id, r.arrived, this.resolveNote()); this.resolving.set(null); }
    catch (e) { err = errorMessage(e); }
    finally { this.resolveBusy.set(false); }
    await this.loadHistory();
    if (err) this.historyError.set(err);
  }

}

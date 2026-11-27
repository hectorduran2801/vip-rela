import { DestroyRef, Injectable, computed, effect, inject, signal } from '@angular/core';
import { errorMessage, splitError } from './errors';
import { WHATSAPP_TRANSITIONAL, type WhatsappSession } from './models';
import { ApiService, AuthService } from './services';

/** Ruta real de la pantalla de WhatsApp (el indicador del encabezado enlaza aquí). */
export const WHATSAPP_ROUTE = '/messages/whatsapp';
/** Sondeo normal, rápido (pantalla de WhatsApp abierta con estado transitorio / QR) y antigüedad máxima de un dato para confiar en él. */
export const WA_POLL_NORMAL_MS = 25_000;
export const WA_POLL_FAST_MS = 2_000;
/** Una solicitud de conectar/desconectar sin respuesta del servicio pasados estos ms se considera lenta («Está tardando más de lo normal»). */
export const WA_PENDING_TIMEOUT_MS = 30_000;
export const WA_STALE_MS = 90_000;

/** ok = verde (envío real posible) · test = azul tenue (conectado pero en pruebas) · warn = ámbar · danger = rojo · muted = gris (no se sabe). */
export type WaTone = 'ok' | 'test' | 'warn' | 'danger' | 'muted';
/** `technical` (solo en «no disponible») va únicamente en el «Detalle técnico» plegado. */
export interface WaView { tone: WaTone; label: string; detail: string; technical?: string }
/** Texto único de «WhatsApp no disponible»: el worker no responde, el latido caducó o la API no contesta. NO es una desconexión de la cuenta. */
export const WA_UNAVAILABLE_LABEL = 'WhatsApp no disponible';
export const WA_UNAVAILABLE_DETAIL = 'El servicio de WhatsApp no responde. Estamos intentando recuperarlo; si persiste, avisa a soporte.';

/**
 * ÚNICO estado compartido de WhatsApp (header + pantalla de WhatsApp). Consulta GET /whatsapp/session con sondeo discreto:
 * 25 s normal; 5 s si alguna pantalla lo pide (`watch()`) y el estado es transitorio/awaiting_scan o hay una solicitud sin cumplir;
 * pausa con la pestaña oculta; nunca solapa peticiones; no consulta sin sesión autorizada.
 * Regla de verdad: «Conectado» (verde/azul) SOLO con status==='connected' Y worker en línea Y dato fresco (< 90 s). `desired_state` no cuenta.
 */
@Injectable({ providedIn: 'root' })
export class WhatsappState {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  readonly session = signal<WhatsappSession | null>(null);
  readonly error = signal<string | null>(null);
  readonly loaded = signal(false);
  readonly requesting = signal(false);
  /** Momento (ms) de la última respuesta correcta. */
  readonly lastOkAt = signal<number | null>(null);
  readonly now = signal(Date.now());
  private readonly watchers = signal(0);
  private inflight: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private ticker: ReturnType<typeof setInterval> | undefined;
  private running = false;

  readonly stale = computed(() => { const t = this.lastOkAt(); return t === null || this.now() - t > WA_STALE_MS; });
  /**
   * Puerta del mensaje de prueba (una sola fuente para el botón, su aviso y el formulario). `operational` = se puede preparar y enviar SIMULADO.
   * `message` es el ÚNICO aviso que se muestra: sin sesión → conectar; worker apagado o sin respuesta → servicio no disponible;
   * conectado pero con envío real desactivado → solo simulados (esto NO es una desconexión: el simulado sigue habilitado).
   */
  readonly testGate = computed<{ operational: boolean; kind: 'ok' | 'disconnected' | 'unavailable' | 'real_off'; message: string | null }>(() => {
    const s = this.session();
    if (!this.loaded()) return { operational: false, kind: 'unavailable', message: null };
    if (!s || this.error() || this.stale() || !s.workerOnline) return { operational: false, kind: 'unavailable', message: 'El servicio de WhatsApp no está disponible' };
    if (s.status !== 'connected') return { operational: false, kind: 'disconnected', message: 'Conecta WhatsApp para habilitar el envío de mensajes' };
    if (s.sendingMode !== 'real' || !s.realTestEnabled) return { operational: true, kind: 'real_off', message: 'Envío real desactivado: solo puedes enviar mensajes simulados' };
    return { operational: true, kind: 'ok', message: null };
  });
  readonly connected = computed(() => { const s = this.session(); return !!s && s.status === 'connected' && s.workerOnline && !this.error() && !this.stale(); });
  /** Solicitud sin cumplir: lo pedido (desired_state) todavía no coincide con el estado real. */
  private readonly unmet = computed(() => { const s = this.session(); return !!s && ((s.desiredState === 'connected') !== (s.status === 'connected')) && s.workerOnline; });
  /**
   * «Solicitud en curso»: se activa AL INSTANTE al pulsar Conectar/Desconectar (antes de que responda el servidor) y se mantiene hasta que el estado
   * real avance (conectar: status deja de ser «disconnected»; desconectar: llega a «disconnected»). Mientras tanto la interfaz NO vuelve a ofrecer
   * «Conectar» aunque el servidor aún diga «Desconectado» (el worker consulta cada pocos segundos).
   */
  readonly pending = signal<{ kind: 'connect' | 'disconnect' | 'logout'; since: number } | null>(null);
  readonly pendingSlow = computed(() => { const p = this.pending(); return !!p && this.now() - p.since > WA_PENDING_TIMEOUT_MS; });
  private pendTicker: ReturnType<typeof setInterval> | undefined;
  private readonly fast = computed(() => {
    const s = this.session();
    // Sondeo rápido (2 s) mientras haya una conexión en curso, con o sin pantalla de WhatsApp abierta; vuelve al ritmo normal al conectar o fallar.
    return this.requesting() || this.pending() !== null || (!!s && (WHATSAPP_TRANSITIONAL.includes(s.status) || (this.watchers() > 0 && this.unmet())));
  });

  readonly view = computed<WaView>(() => {
    const s = this.session();
    if (!this.loaded()) return { tone: 'muted', label: 'Comprobando WhatsApp…', detail: 'Consultando el estado.' };
    if (this.error() || !s) return { tone: 'muted', label: WA_UNAVAILABLE_LABEL, detail: WA_UNAVAILABLE_DETAIL, technical: this.error() ? splitError(this.error()!).detail ?? splitError(this.error()!).message : 'sin respuesta de la API' };
    if (this.stale()) return { tone: 'muted', label: WA_UNAVAILABLE_LABEL, detail: WA_UNAVAILABLE_DETAIL, technical: `el último estado recibido tiene más de ${Math.round(WA_STALE_MS / 1000)} s` };
    if (!s.workerOnline) return { tone: 'muted', label: WA_UNAVAILABLE_LABEL, detail: WA_UNAVAILABLE_DETAIL, technical: `worker_online=false · último latido: ${s.workerHeartbeatAt ?? 'ninguno'}` };
    const p = this.pending();
    if (p?.kind === 'connect' && s.status === 'disconnected') return { tone: 'warn', label: 'Conectando WhatsApp', detail: 'Solicitud enviada. El servicio la recoge en unos segundos…' };
    if (p?.kind === 'logout' || s.logoutPending) return { tone: 'warn', label: 'Cerrando sesión de WhatsApp', detail: 'Eliminando las credenciales guardadas…' };
    if (p?.kind === 'disconnect' && s.status !== 'disconnected') return { tone: 'warn', label: 'Desconectando WhatsApp', detail: 'Solicitud enviada. Desconectando…' };
    switch (s.status) {
      case 'connected':
        return s.sendingMode === 'real' ? { tone: 'ok', label: 'WhatsApp conectado · Envíos reales', detail: 'Conectado y con envíos reales activados.' }
          : s.sendingMode === 'test' ? { tone: 'test', label: 'WhatsApp conectado · Envíos en prueba', detail: 'Conectado, pero los envíos están en modo de prueba: no se envía nada real.' }
          : { tone: 'test', label: 'WhatsApp conectado · Modo de envío desconocido', detail: 'Conectado; no se conoce el modo de envío.' };
      case 'awaiting_scan': return { tone: 'warn', label: 'Conectando WhatsApp · Esperando escaneo', detail: 'Escanea el código QR con el teléfono.' };
      case 'starting': return { tone: 'warn', label: 'Conectando WhatsApp', detail: 'Iniciando WhatsApp (puede tardar unos segundos)…' };
      case 'qr_pending': return { tone: 'warn', label: 'Conectando WhatsApp', detail: 'Generando el código QR…' };
      case 'connecting': return { tone: 'warn', label: 'Conectando WhatsApp', detail: 'Conectando con WhatsApp…' };
      case 'failed': return { tone: 'danger', label: 'Error del worker', detail: s.lastError ?? 'El servicio no informó el motivo.' };
      default: return { tone: 'danger', label: 'Desconectado', detail: 'No se envían recordatorios ni confirmaciones.' };
    }
  });

  constructor() {
    // Solo se consulta con una sesión autorizada; al cerrarla se limpia todo.
    effect(() => { if (this.auth.user()) this.start(); else this.stop(); });
    inject(DestroyRef).onDestroy(() => this.stop());
  }

  private readonly onVisibility = (): void => { if (!document.hidden && this.running) { clearTimeout(this.timer); void this.refresh(); } };

  private start(): void {
    if (this.running) return;
    this.running = true;
    this.ticker = setInterval(() => this.now.set(Date.now()), 5000);
    document.addEventListener('visibilitychange', this.onVisibility);
    void this.refresh();
  }
  private stop(): void {
    if (!this.running) return;
    this.running = false;
    clearTimeout(this.timer); clearInterval(this.ticker); this.endPending();
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.session.set(null); this.error.set(null); this.loaded.set(false); this.lastOkAt.set(null);
  }

  /** Una pantalla pide sondeo rápido mientras esté abierta; devuelve la función que lo libera. */
  watch(): () => void {
    this.watchers.update((n) => n + 1);
    if (this.running) { clearTimeout(this.timer); void this.refresh(); }
    let done = false;
    return () => { if (done) return; done = true; this.watchers.update((n) => Math.max(0, n - 1)); };
  }

  private schedule(): void {
    clearTimeout(this.timer);
    if (!this.running) return;
    this.timer = setTimeout(() => { if (document.hidden) { this.schedule(); return; } void this.refresh(); }, this.fast() ? WA_POLL_FAST_MS : WA_POLL_NORMAL_MS);
  }

  private adopt(s: WhatsappSession): void {
    this.session.set(s); this.error.set(null); this.loaded.set(true);
    this.lastOkAt.set(Date.now()); this.now.set(Date.now());
    const p = this.pending();
    if (p && ((p.kind === 'connect' && s.status !== 'disconnected') || (p.kind === 'disconnect' && s.status === 'disconnected') || (p.kind === 'logout' && s.status === 'disconnected' && !s.logoutPending))) this.endPending();
  }
  private startPending(kind: 'connect' | 'disconnect' | 'logout'): void {
    this.pending.set({ kind, since: Date.now() });
    clearInterval(this.pendTicker);
    this.pendTicker = setInterval(() => this.now.set(Date.now()), 1000);   // para detectar la demora (30 s)
  }
  private endPending(): void { this.pending.set(null); clearInterval(this.pendTicker); this.pendTicker = undefined; }

  /** Consulta el estado real. Sin solapar: si ya hay una petición en curso se reutiliza. */
  refresh(): Promise<void> {
    if (!this.running) return Promise.resolve();
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      try { this.adopt(await this.api.whatsappSession()); }
      catch (e) { this.error.set(errorMessage(e)); this.loaded.set(true); this.now.set(Date.now()); }
      finally { this.inflight = null; this.schedule(); }
    })();
    return this.inflight;
  }

  /** Pide conectar o desconectar. El header y la pantalla cambian al instante con el estado que devuelve la API (nunca «conectado» por haber pedido). */
  async request(kind: 'connect' | 'disconnect' | 'logout'): Promise<string | null> {
    if (this.requesting()) return null;
    this.requesting.set(true);
    this.startPending(kind);                          // respuesta INMEDIATA: antes de esperar al servidor
    this.schedule();
    try { this.adopt(kind === 'connect' ? await this.api.whatsappConnect() : kind === 'logout' ? await this.api.whatsappLogout() : await this.api.whatsappDisconnect()); return null; }
    catch (e) { this.endPending(); return errorMessage(e); }
    finally { this.requesting.set(false); this.schedule(); }
  }
}

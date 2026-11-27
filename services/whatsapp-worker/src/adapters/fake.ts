import { Emitter, type AdapterStatus, type SendResult, type Unsubscribe, type WhatsAppAdapter } from './types.js';

export interface FakeAdapterOptions {
  /** Latencia simulada de cada sendText (ms). */
  sendLatencyMs?: number;
  /** Latencia simulada de connect (ms). */
  connectLatencyMs?: number;
  /** Si true, connect() sin sesión restaurada conecta sin pasar por QR. */
  autoScan?: boolean;
  /** Número que "devuelve" getHostNumber al conectar. */
  phone?: string;
}

/** Adaptador para pruebas: fallos, latencia, QR y caídas controlables. No toca la red. */
export class FakeAdapter implements WhatsAppAdapter {
  readonly calls: Array<{ phone: string; body: string }> = [];
  connectCalls = 0;
  restored: Buffer | null = null;
  private status: AdapterStatus = 'disconnected';
  private qrEv = new Emitter<string>();
  private statusEv = new Emitter<AdapterStatus>();
  private sessEv = new Emitter<Buffer>();
  private failures: Array<Error> = [];
  private failAlways: Error | null = null;
  private connectFailures = 0;
  private qrN = 0;
  private paired = false;
  /** «Almacenamiento local» simulado de la sesión (lo que OpenWA dejaría en su archivo). */
  local: Buffer | null = null;
  loggedOut = false;
  logoutCalls = 0;
  private phone: string | null = null;
  private lastError: string | null = null;

  constructor(readonly opts: FakeAdapterOptions = {}) {}

  // ── interfaz ──
  async connect() {
    this.connectCalls++;
    if (this.opts.connectLatencyMs) await sleep(this.opts.connectLatencyMs);
    this.set('starting');
    if (this.connectFailures > 0) { this.connectFailures--; this.lastError = 'connect falló (simulado)'; this.set('failed'); throw new Error('connect falló (simulado)'); }
    if (this.restored || this.paired || this.opts.autoScan) { this.set('connecting'); this.markConnected(); return; }
    this.set('qr_pending');
    this.emitQr();
  }
  async disconnect() { this.phone = null; this.set('disconnected'); }
  getStatus() { return this.status; }
  getPhoneNumber() { return this.phone; }
  getLastError() { return this.lastError; }
  onQr(cb: (qr: string) => void): Unsubscribe { return this.qrEv.on(cb); }
  onStatus(cb: (s: AdapterStatus) => void): Unsubscribe { return this.statusEv.on(cb); }
  onSessionData(cb: (d: Buffer) => void): Unsubscribe { return this.sessEv.on(cb); }
  async restore(session: Buffer) { this.restored = session; this.local = session; }
  async exportSession() { return this.local; }
  async wipeLocalSession() { this.local = null; this.restored = null; this.paired = false; }
  wasLoggedOut() { return this.loggedOut; }
  async logout() { this.logoutCalls++; await this.wipeLocalSession(); this.phone = null; this.loggedOut = false; this.set('disconnected'); return { native: true }; }
  async sendText(phone: string, body: string): Promise<SendResult> {
    if (this.opts.sendLatencyMs) await sleep(this.opts.sendLatencyMs);
    if (this.status !== 'connected') throw new Error('sesión no conectada');
    const f = this.failures.shift() ?? this.failAlways;
    if (f) throw f;
    this.calls.push({ phone, body });
    return { messageId: `fake-${this.calls.length}` };
  }

  // ── control de pruebas ──
  /** Hace fallar los próximos `n` envíos. */
  failNextSends(n: number, message = 'fallo simulado') { for (let i = 0; i < n; i++) this.failures.push(new Error(message)); }
  failSendsAlways(message = 'fallo simulado') { this.failAlways = new Error(message); }
  failNextConnects(n: number) { this.connectFailures = n; }
  /** El usuario escanea el QR. */
  simulateScan() { this.paired = true; this.set('connecting'); this.markConnected(); }
  /** OpenWA emite un QR nuevo (el anterior caducó). */
  simulateQrRefresh() { this.emitQr(); }
  /** Fallo en caliente con un motivo real. */
  simulateFailure(message: string) { this.lastError = message; this.phone = null; this.set('failed'); }
  /** Caída inesperada de la sesión. */
  simulateDrop() { this.phone = null; this.set('disconnected'); }
  /** Fuerza el estado sin eventos de QR (para pruebas de la cola). */
  forceConnected() { this.phone = this.opts.phone ?? '+50760000000'; this.set('connected'); }

  private emitQr() { this.qrEv.emit(`fake-qr-${++this.qrN}`); this.set('awaiting_scan'); }
  private markConnected() { this.phone = this.opts.phone ?? '+50760000000'; this.lastError = null; this.loggedOut = false; this.set('connected'); this.local = this.local ?? Buffer.from('fake-session-data'); this.sessEv.emit(this.local); }
  /** OpenWA entrega credenciales renovadas. */
  simulateSessionData(d: Buffer) { this.local = d; this.sessEv.emit(d); }
  /** El teléfono cerró la sesión (WhatsApp invalidó las credenciales). */
  simulateLoggedOut() { this.loggedOut = true; this.local = null; this.restored = null; this.paired = false; this.phone = null; this.lastError = 'sesión cerrada desde el teléfono'; this.set('disconnected'); }
  private set(s: AdapterStatus) { this.status = s; this.statusEv.emit(s); }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

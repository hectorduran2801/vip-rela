import { maskPhone, type Log } from '../log.js';
import { Emitter, type AdapterStatus, type SendResult, type Unsubscribe, type WhatsAppAdapter } from './types.js';

/**
 * Adaptador por defecto: NO envía nada. Registra (sin cuerpo ni teléfono completo) y devuelve éxito
 * simulado. Siempre "conectado".
 */
export class DryRunAdapter implements WhatsAppAdapter {
  readonly sent: Array<{ phoneMasked: string; length: number; at: Date }> = [];
  private status: AdapterStatus = 'disconnected';
  private statusEv = new Emitter<AdapterStatus>();
  private qrEv = new Emitter<string>();
  private sessEv = new Emitter<Buffer>();
  private n = 0;

  constructor(private readonly log?: Log) {}

  async connect() { this.set('connected'); }
  async disconnect() { this.set('disconnected'); }
  getStatus() { return this.status; }
  onQr(cb: (qr: string) => void): Unsubscribe { return this.qrEv.on(cb); }
  onStatus(cb: (s: AdapterStatus) => void): Unsubscribe { return this.statusEv.on(cb); }
  onSessionData(cb: (d: Buffer) => void): Unsubscribe { return this.sessEv.on(cb); }
  async restore(): Promise<void> { /* nada que restaurar */ }

  async sendText(phone: string, body: string): Promise<SendResult> {
    this.sent.push({ phoneMasked: maskPhone(phone), length: body.length, at: new Date() });
    this.log?.info({ dryRun: true, to: maskPhone(phone), chars: body.length }, 'dry-run: mensaje NO enviado');
    return { messageId: `dryrun-${++this.n}`, simulated: true };
  }

  private set(s: AdapterStatus) { this.status = s; this.statusEv.emit(s); }
}

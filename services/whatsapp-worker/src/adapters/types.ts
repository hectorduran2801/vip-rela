/**
 * starting = cliente lanzado; qr_pending = esperando que WhatsApp genere el QR; awaiting_scan = QR disponible (se emite por
 * onQr); connecting = QR escaneado / reanudando; connected = confirmado por el cliente; failed = error (ver getLastError()).
 */
export type AdapterStatus = 'disconnected' | 'starting' | 'qr_pending' | 'awaiting_scan' | 'connecting' | 'connected' | 'failed';
export type Unsubscribe = () => void;

export interface SendResult {
  /** id del mensaje en el proveedor (o simulado en dry-run). */
  messageId?: string;
  /** Número emisor (vinculado) si el adaptador lo informa; si no, el worker usa getPhoneNumber() del adaptador. */
  sender?: string;
  simulated?: boolean;
}

/**
 * Frontera entre el worker y WhatsApp. TODO lo que toque un navegador (Puppeteer/Chrome) vive detrás
 * de esta interfaz. Contrato: los métodos pueden lanzar o rechazar; quien los llama (SessionManager,
 * QueueProcessor) los envuelve para que un fallo del adaptador nunca tumbe el bucle.
 */
export interface WhatsAppAdapter {
  /** Inicia la conexión. Si hubo `restore()`, intenta reanudar sin QR; si no, emite QR vía onQr. */
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getStatus(): AdapterStatus;
  /** Número vinculado (solo cuando está conectado). */
  getPhoneNumber?(): string | null;
  /** Motivo real del último fallo (sin secretos). */
  getLastError?(): string | null;
  /** Se invoca con el contenido del QR (efímero; no registrarlo en logs). */
  onQr(cb: (qr: string) => void): Unsubscribe;
  onStatus(cb: (status: AdapterStatus) => void): Unsubscribe;
  /** Se invoca cuando el proveedor entrega datos de sesión para persistir (el worker los cifra). */
  onSessionData(cb: (data: Buffer) => void): Unsubscribe;
  /** Carga datos de sesión previamente guardados (ya descifrados) antes de `connect()`. */
  restore(session: Buffer): Promise<void>;
  sendText(phone: string, body: string): Promise<SendResult>;
  /** ¿La página de WhatsApp responde de verdad? false = estaba caída (el adaptador ya se dio por caído y se reconectará). */
  ping?(): Promise<boolean>;
  getPingError?(): string | null;
  /** Contenido actual del almacenamiento local de la sesión (sobre de OpenWA ya cifrado por OpenWA), o null si no hay una sesión válida. */
  exportSession?(): Promise<Buffer | null>;
  /** Borra el almacenamiento local de la sesión (archivo y bloqueo). La sesión no podrá restaurarse. */
  wipeLocalSession?(): Promise<void>;
  /** Cierre definitivo: intenta el cierre nativo de OpenWA y detiene el cliente. Devuelve si el cierre nativo se pudo ejecutar. */
  logout?(): Promise<{ native: boolean }>;
  /** true si WhatsApp/el teléfono invalidó la sesión (ya no es restaurable; hace falta un QR nuevo). */
  wasLoggedOut?(): boolean;
}

/** Tipo auxiliar: emisor mínimo reutilizado por las implementaciones. */
export class Emitter<T> {
  private subs = new Set<(v: T) => void>();
  on(cb: (v: T) => void): Unsubscribe { this.subs.add(cb); return () => { this.subs.delete(cb); }; }
  emit(v: T): void { for (const s of [...this.subs]) { try { s(v); } catch { /* un suscriptor nunca rompe al emisor */ } } }
}

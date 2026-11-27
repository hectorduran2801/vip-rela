import type { AdapterStatus, WhatsAppAdapter, Unsubscribe } from '../adapters/types.js';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { decryptSession, encryptSession } from '../crypto.js';
import type { Db } from '../db.js';
import { sanitizeError, type Log } from '../log.js';
import { backoffDelay, type BackoffOptions } from './backoff.js';

export interface SessionRow {
  id: string; desired_state: 'connected' | 'disconnected'; status: AdapterStatus; logout_requested_at?: string | null;
  /** Cuenta dueña de la sesión; `scoped` = false con la base anterior a las cuentas. */
  account_id?: string | null; scoped?: boolean;
}

export interface SessionManagerOptions {
  db: Db;
  log: Log;
  /** Crea el adaptador de una sesión (OpenWA en producción, Fake/DryRun en pruebas y dry-run). */
  adapterFactory: (sessionId: string) => WhatsAppAdapter;
  /** 32 bytes. Opcional: solo cifra los datos de sesión que un adaptador entregue por `onSessionData` (OpenWA no lo hace). */
  encryptionKey?: Buffer;
  pollMs?: number;
  qrTtlMs?: number;
  /** Cada cuánto se escribe worker_heartbeat_at (≤ 10 s). */
  heartbeatMs?: number;
  /** Modo de envío que se informa en cada latido (la API/encabezado lo muestran aparte de «conectado»). */
  modes?: { dryRun: boolean; realTestEnabled: boolean; automatic?: boolean };
  backoff?: BackoffOptions;
  /** Identidad de esta instancia en el lease de la sesión (por defecto host:pid:aleatorio). */
  instanceId?: string;
  /** Vigencia del lease de la sesión; se renueva con cada latido. */
  leaseMs?: number;
}

const PING_EVERY_MS = 30_000;
/** Cuánto espera la cola a que una sesión vuelva antes de seguir (y marcar fallidos). */
const RECOVERY_WAIT_MS = 120_000;

interface Runtime {
  row: SessionRow;
  adapter: WhatsAppAdapter;
  unsubs: Unsubscribe[];
  sessUnsub: Unsubscribe | null;
  /** Aviso a conservar mientras no conecte (p. ej. «no se pudo restaurar la sesión guardada»). */
  note: string | null;
  attempt: number;
  /** Marca de tiempo del último cambio de estado/QR: el vigilante reinicia el cliente si el QR no llega o caduca sin renovarse. */
  progressAt?: number;
  timer: NodeJS.Timeout | null;
  stopping: boolean;
  connecting: boolean;
  status: AdapterStatus;
  /** Guardados serializados de ESTA sesión y bandera de borrado (no se guarda nada mientras se elimina). */
  saves: Promise<unknown>;
  wiping: boolean;
  /** ¿Llegó a estar conectada en esta ejecución? Si no, un «sesión cerrada» es una restauración rechazada: NO se borra nada guardado. */
  everConnected?: boolean;
  /** Cuándo dejó de estar conectada (null = bien) y cuándo se comprobó por última vez que responde. */
  downSince?: number | null;
  lastPing?: number;
  /** Ya se anotó en el registro si la comprobación funciona. */
  pingLogged?: string;
  /** Reinicios seguidos del vigilante sin que nadie escanee. */
  qrRestarts?: number;
}

interface WritePatch {
  status?: AdapterStatus; qr?: string; qrExpiresInMs?: number; clearQr?: boolean; seen?: boolean;
  /** undefined = no tocar; null = borrar. */
  phone?: string | null; lastError?: string | null;
}

export interface SessionInfo {
  sessionId: string; status: AdapterStatus; reconnectAttempt: number;
}

/**
 * Ciclo de vida de VARIAS sesiones de WhatsApp, una por cuenta (`whatsapp_sessions.account_id`). El `sessionId` de OpenWA es el `id` de la fila
 * (no cambia: también va en el cifrado del secreto). Cada sesión tiene adaptador, proceso, guardados, reconexión y lease propios; un fallo o un QR
 * sin escanear en una no detiene a las demás. Un envío solo puede salir por la sesión de SU cuenta. La API/PWA solo escribe `desired_state`; este gestor
 * (único dueño de `status`, `qr_data`, `qr_expires_at`, `last_seen_at`) reconcilia la base con la
 * realidad. El QR es efímero: se guarda con caducidad, se borra al conectar o desconectar y NUNCA se
 * registra en logs. Los datos de sesión se cifran (AES-256-GCM) antes de tocar la base.
 */
export class SessionManager {
  private readonly runtimes = new Map<string, Runtime>();   // por id de sesión
  private static readonly MAX_QR_RESTARTS = 5;
  private poll: NodeJS.Timeout | null = null;
  private beat: NodeJS.Timeout | null = null;
  private writes: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private reconciling: Promise<void> | null = null;
  /** true mientras se cierra la sesión: ningún dato de sesión tardío puede volver a guardarse. */
  private readonly instanceId: string;
  private readonly leaseMs: number;
  private readonly pollMs: number;
  private readonly qrTtlMs: number;
  private readonly heartbeatMs: number;
  private readonly backoff: BackoffOptions;

  constructor(private readonly o: SessionManagerOptions) {
    this.instanceId = o.instanceId ?? `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
    this.leaseMs = o.leaseMs ?? 60_000;
    this.pollMs = o.pollMs ?? 5000;
    this.qrTtlMs = o.qrTtlMs ?? 60_000;
    this.heartbeatMs = Math.min(o.heartbeatMs ?? 10_000, 10_000);
    this.backoff = o.backoff ?? { baseMs: 2000, maxMs: 300_000 };
  }

  /** Inicia el sondeo de `desired_state`. */
  async start(): Promise<void> {
    // El latido va aparte de la sesión: la API sabe que el worker corre aunque nadie haya pedido conectar.
    await this.heartbeatNow();
    this.beat = setInterval(() => { void this.heartbeatNow(); }, this.heartbeatMs);
    this.beat.unref?.();
    await this.reconcile();
    this.poll = setInterval(() => { void this.reconcile(); }, this.pollMs);
    this.poll.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.poll) clearInterval(this.poll);
    if (this.beat) clearInterval(this.beat);
    await this.reconciling?.catch(() => undefined);
    await Promise.allSettled([...this.runtimes.values()].map((rt) => this.teardown(rt, 'disconnected')));
    this.runtimes.clear();
    await this.writes.catch(() => undefined);
  }

  private async heartbeatNow(): Promise<void> {
    try { await this.o.db.tx((q) => q.rows(`update public.whatsapp_sessions set worker_heartbeat_at = now(), worker_dry_run = $1, worker_real_test_enabled = $2, worker_automatic = $3`, [this.o.modes?.dryRun ?? true, this.o.modes?.realTestEnabled ?? false, this.o.modes?.automatic ?? false])); }
    catch (e) { this.o.log.warn({ err: sanitizeError(e) }, 'no se pudo escribir el heartbeat'); return; }
    for (const rt of [...this.runtimes.values()]) {
      if (rt.stopping || this.stopped) continue;
      try {
        const ok = await this.renewLease(rt.row.id);
        if (!ok && this.runtimes.get(rt.row.id) === rt && !rt.stopping && !rt.wiping) {
          // Otra instancia tomó la sesión: esta deja de usarla de inmediato.
          this.o.log.error({ sessionId: rt.row.id }, 'se perdió el lease de la sesión; se detiene esta instancia');
          this.runtimes.delete(rt.row.id);
          await this.teardown(rt, 'disconnected', false);
          await this.write(rt.row.id, { status: 'failed', lastError: 'Otra instancia del worker está usando la sesión de WhatsApp.', phone: null });
        }
      } catch (e) { this.o.log.warn({ err: sanitizeError(e), sessionId: rt.row.id }, 'no se pudo renovar el lease de la sesión'); }
    }
  }

  private async acquireLease(id: string): Promise<boolean> {
    const r = await this.o.db.tx((q) => q.rows(
      `update public.whatsapp_sessions set lease_owner = $2, lease_expires_at = now() + ($3::int * interval '1 millisecond')
        where id = $1 and (lease_owner is null or lease_owner = $2 or lease_expires_at is null or lease_expires_at < now()) returning id`, [id, this.instanceId, this.leaseMs]));
    return r.length > 0;
  }
  /** Solo prolonga un lease que ya es de esta instancia (nunca lo vuelve a tomar si se soltó o lo tiene otra). */
  private async renewLease(id: string): Promise<boolean> {
    const r = await this.o.db.tx((q) => q.rows(
      `update public.whatsapp_sessions set lease_expires_at = now() + ($3::int * interval '1 millisecond') where id = $1 and lease_owner = $2 returning id`, [id, this.instanceId, this.leaseMs]));
    return r.length > 0;
  }
  private async releaseLease(id: string): Promise<void> {
    await this.o.db.tx((q) => q.rows(`update public.whatsapp_sessions set lease_owner = null, lease_expires_at = null where id = $1 and lease_owner = $2`, [id, this.instanceId])).catch(() => undefined);
  }

  /** Una pasada de reconciliación (idempotente; las llamadas simultáneas se comparten). */
  reconcile(): Promise<void> {
    if (this.reconciling) return this.reconciling;
    this.reconciling = this.doReconcile()
      .catch((e) => this.o.log.error({ err: sanitizeError(e) }, 'reconcile de sesiones falló'))
      .finally(() => { this.reconciling = null; });
    return this.reconciling;
  }

  private async doReconcile(): Promise<void> {
    if (this.stopped) return;
    // `to_jsonb(s) ->> 'account_id'` también funciona con la base anterior a la columna (una sola sesión).
    const rows = await this.o.db.tx((q) => q.rows<SessionRow>(
      `select id, desired_state, status, logout_requested_at, to_jsonb(s) ->> 'account_id' as account_id, to_jsonb(s) ? 'account_id' as scoped
         from public.whatsapp_sessions s order by updated_at`));
    const alive = new Set(rows.map((r) => r.id));
    for (const [id, rt] of this.runtimes) if (!alive.has(id)) { this.runtimes.delete(id); await this.teardown(rt, 'disconnected'); }   // sesión eliminada de la base
    // Cada sesión se atiende por separado: si una falla o tarda, las demás siguen.
    const done = await Promise.allSettled(rows.map((row) => this.reconcileOne(row)));
    for (const [i, d] of done.entries()) if (d.status === 'rejected') this.o.log.error({ sessionId: rows[i]!.id, err: sanitizeError(d.reason) }, 'reconcile de la sesión falló');
    // QR caducado: no dejar un QR muerto a la vista.
    await this.o.db.tx((q) => q.rows(
      `update public.whatsapp_sessions set qr_data = null, qr_expires_at = null, updated_at = now()
        where qr_data is not null and qr_expires_at < now()`));
  }

  private async reconcileOne(row: SessionRow): Promise<void> {
    if (row.logout_requested_at) { await this.logoutNow(row); return; }
    const cur = this.runtimes.get(row.id);
    if (row.desired_state === 'connected') {
      if (!cur) await this.startRuntime(row);
      else {
        cur.row = row;
        if (cur.status === 'connected') {
          await this.heartbeat(row.id);
          // «Conectada» se comprueba de verdad cada 30 s: si la página ya no responde, el adaptador se da por caído y se reconecta.
          if (cur.adapter.ping && Date.now() - (cur.lastPing ?? 0) >= PING_EVERY_MS) { cur.lastPing = Date.now(); void cur.adapter.ping().then(() => {
            const err = cur.adapter.getPingError?.() ?? null, seen = err ?? 'ok';
            if (cur.pingLogged === seen) return;
            cur.pingLogged = seen;                                     // una línea por cambio, no una cada 30 s
            if (err) this.o.log.warn({ sessionId: row.id, err }, 'la comprobación de WhatsApp no obtuvo respuesta limpia');
            else this.o.log.info({ sessionId: row.id }, 'WhatsApp responde a la comprobación');
          }).catch(() => undefined); }
        }
      }
    } else if (cur) {
      this.runtimes.delete(row.id);
      await this.teardown(cur, 'disconnected');
    } else if (row.status !== 'disconnected') {
      // Quedó 'connected'/'qr_pending' de una ejecución anterior y ya no se desea.
      await this.write(row.id, { status: 'disconnected', clearQr: true, phone: null });
    }
    await this.watchQr(row.id);
  }

  /** Sin QR nuevo (o atascado arrancando) se reinicia ese cliente; tras varios intentos sin escanear se detiene (no se relanza Chromium sin fin). */
  private async watchQr(id: string): Promise<void> {
    const w = this.runtimes.get(id);
    if (!w || w.stopping || w.connecting || w.timer || !w.progressAt || !['starting', 'qr_pending', 'awaiting_scan'].includes(w.status)) return;
    const limit = w.status === 'awaiting_scan' ? this.qrTtlMs + 15_000 : 60_000;
    if (Date.now() - w.progressAt <= limit) return;
    w.qrRestarts = (w.qrRestarts ?? 0) + 1;
    if (w.qrRestarts > SessionManager.MAX_QR_RESTARTS) {
      this.o.log.warn({ sessionId: id }, 'nadie escaneó el QR; se detiene este cliente');
      this.runtimes.delete(id);
      await this.teardown(w, 'disconnected', false);
      await this.o.db.tx((q) => q.rows(`update public.whatsapp_sessions set desired_state = 'disconnected', status = 'disconnected', status_changed_at = now(), qr_data = null, qr_expires_at = null,
        last_error = 'No se escaneó el código QR a tiempo. Pulsa «Conectar» para generar uno nuevo.', updated_at = now() where id = $1`, [id]));
      return;
    }
    this.o.log.warn({ sessionId: id, status: w.status }, 'sin código QR nuevo; reiniciando el cliente de WhatsApp');
    w.progressAt = Date.now();
    try { await w.adapter.disconnect(); } catch { /* se reintenta igual */ }
    await this.attemptConnect(w);
  }

  private async startRuntime(row: SessionRow): Promise<void> {
    // Una sola instancia por sesión, también entre máquinas: sin lease no se restaura ni se conecta nada.
    let leased = false;
    try { leased = await this.acquireLease(row.id); }
    catch (e) { this.o.log.warn({ err: sanitizeError(e) }, 'no se pudo adquirir el lease de la sesión'); return; }
    if (!leased) {
      await this.write(row.id, { status: 'failed', lastError: 'Otra instancia del worker está usando la sesión de WhatsApp. Esta no se conecta.' });
      return;
    }
    const adapter = this.o.adapterFactory(row.id);
    const rt: Runtime = { row, adapter, unsubs: [], sessUnsub: null, note: null, attempt: 0, timer: null, stopping: false, connecting: false, status: 'disconnected', saves: Promise.resolve(), wiping: false };
    this.runtimes.set(row.id, rt);

    rt.unsubs.push(
      adapter.onQr((qr) => { void this.onQr(rt, qr); }),
      adapter.onStatus((s) => { void this.onStatus(rt, s); }),
    );
    rt.sessUnsub = adapter.onSessionData((d) => { this.queueSave(rt, d); });
    await this.restoreSession(rt);
    await this.attemptConnect(rt);
  }

  /**
   * Recuperación al iniciar: la base (cifrada) es la fuente; si el almacenamiento local no existe o es distinto, se reescribe desde ella.
   * Si la base no responde, se usa lo que haya en disco SIN borrarlo. Si hay sesión local pero nada en la base, se adopta (se guarda cifrada).
   * Una sesión cerrada con «Cerrar sesión» no existe en ninguno de los dos sitios, por lo que no puede restaurarse.
   */
  private async restoreSession(rt: Runtime): Promise<void> {
    const key = this.o.encryptionKey;
    if (!key) return;                                   // sin clave no se persiste nada en la base (solo el almacenamiento local de OpenWA)
    const { adapter, row } = rt;
    let secret: { encrypted_session: Buffer } | undefined;
    try {
      secret = await this.o.db.tx((q) => q.one<{ encrypted_session: Buffer } | undefined>(`select encrypted_session from public.whatsapp_session_secrets where session_id = $1`, [row.id]));
    } catch (e) {
      this.o.log.warn({ sessionId: row.id, err: sanitizeError(e) }, 'no se pudo leer la sesión guardada (¿base no disponible?); se usa el almacenamiento local si existe');
      return;
    }
    const local = await adapter.exportSession?.().catch(() => null) ?? null;
    if (secret) {
      try {
        const plain = decryptSession(secret.encrypted_session, key, row.id);
        if (!local || !plain.equals(local)) await adapter.restore(plain);
        this.o.log.info({ sessionId: row.id }, 'sesión de WhatsApp restaurada desde el almacenamiento cifrado');
      } catch (e) {
        this.o.log.warn({ sessionId: row.id, err: sanitizeError(e) }, 'no se pudo restaurar la sesión guardada');
        rt.note = 'No se pudo restaurar la sesión guardada (¿cambió SESSION_ENCRYPTION_KEY o los datos están dañados?). Escanea un nuevo QR para vincular de nuevo.';
        await this.write(row.id, { lastError: rt.note });
      }
    } else if (local) {
      this.queueSave(rt, local);                        // había sesión solo en disco: se respalda cifrada en la base
    }
  }

  private async attemptConnect(rt: Runtime): Promise<void> {
    if (rt.stopping || this.stopped || rt.connecting) return;
    rt.connecting = true; rt.progressAt = Date.now();
    await this.setStatus(rt, 'starting');
    try {
      await rt.adapter.connect();
    } catch (e) {
      this.o.log.warn({ sessionId: rt.row.id, attempt: rt.attempt, err: sanitizeError(e) }, 'connect falló');
      rt.connecting = false;
      await this.setStatus(rt, 'failed', false, { lastError: rt.adapter.getLastError?.() ?? sanitizeError(e, 500) });
      this.scheduleReconnect(rt);
      return;
    }
    rt.connecting = false;
  }

  private scheduleReconnect(rt: Runtime): void {
    if (rt.stopping || this.stopped || rt.timer) return;
    const delay = backoffDelay(rt.attempt, this.backoff);
    rt.attempt++;
    this.o.log.info({ sessionId: rt.row.id, inMs: delay, attempt: rt.attempt }, 'reconexión programada');
    rt.timer = setTimeout(() => { rt.timer = null; void this.attemptConnect(rt); }, delay);
    rt.timer.unref?.();
  }

  private async onQr(rt: Runtime, qr: string): Promise<void> {
    if (rt.stopping) return;
    rt.status = 'awaiting_scan'; rt.progressAt = Date.now();
    // El QR solo viaja a la base (efímero, con caducidad); jamás al log. Cada QR nuevo reemplaza al anterior.
    await this.write(rt.row.id, { status: 'awaiting_scan', qr, qrExpiresInMs: this.qrTtlMs, lastError: rt.note });
  }

  private async onStatus(rt: Runtime, s: AdapterStatus): Promise<void> {
    if (rt.stopping || this.stopped) return;
    if (s === 'awaiting_scan') return;   // lo escribe onQr junto con el QR
    if (s === 'connected') {
      rt.attempt = 0; rt.note = null; rt.qrRestarts = 0; rt.everConnected = true; rt.downSince = null; rt.lastPing = Date.now();
      rt.connecting = false;
      // "connected" solo llega cuando el adaptador lo confirma; el número viene del propio cliente.
      await this.setStatus(rt, 'connected', true, { phone: rt.adapter.getPhoneNumber?.() ?? null, lastError: null });
      this.o.log.info({ sessionId: rt.row.id }, 'sesión conectada');
    } else if (s === 'disconnected' || s === 'failed') {
      if (rt.everConnected) rt.downSince ??= Date.now();
      if (rt.adapter.wasLoggedOut?.() && !rt.everConnected) {
        // La sesión guardada no llegó a restaurarse. Se conserva (cifrada) para investigarla: solo «Cerrar sesión» o un nuevo escaneo la reemplazan.
        this.o.log.warn({ sessionId: rt.row.id }, 'la sesión guardada no se pudo restaurar; las credenciales se conservan');
        rt.note = 'No se pudo restaurar la sesión guardada. Se conserva para revisarla; escanea el QR para vincular de nuevo.';
        await this.setStatus(rt, 'disconnected', true, { phone: null, lastError: rt.note });
        if (rt.row.desired_state === 'connected') { rt.connecting = false; this.scheduleReconnect(rt); }
        return;
      }
      if (rt.adapter.wasLoggedOut?.()) {
        // Cerrada desde el teléfono o invalidada por WhatsApp: se eliminan las credenciales y la próxima conexión pedirá un QR nuevo.
        await this.discardInvalidSession(rt);
        await this.setStatus(rt, 'disconnected', true, { phone: null, lastError: 'La sesión se cerró desde el teléfono o WhatsApp la invalidó. Escanea un nuevo QR para vincular de nuevo.' });
        if (rt.row.desired_state === 'connected') { rt.connecting = false; this.scheduleReconnect(rt); }
        return;
      }
      const reason = rt.adapter.getLastError?.() ?? undefined;
      await this.setStatus(rt, s, true, { phone: null, ...(reason !== undefined ? { lastError: reason } : {}) });
      if (rt.row.desired_state === 'connected') { rt.connecting = false; this.scheduleReconnect(rt); }
    } else {
      await this.setStatus(rt, s);
    }
  }

  /** Los guardados se serializan y se esperan al detener la sesión; nada se guarda mientras se cierra la sesión. */
  private queueSave(rt: Runtime, d: Buffer): void {
    const run = () => this.saveSecret(rt, d);
    rt.saves = rt.saves.then(run, run);
  }

  private async saveSecret(rt: Runtime, data: Buffer): Promise<void> {
    if (!this.o.encryptionKey || rt.wiping) return;     // sin clave no se persiste nada por esta vía
    try {
      const blob = encryptSession(data, this.o.encryptionKey, rt.row.id);      // AES-256-GCM, IV aleatorio por operación, AAD = id de la sesión
      await this.o.db.tx(async (q) => {
        await q.rows(
          `insert into public.whatsapp_session_secrets(session_id, encrypted_session) values ($1, $2)
           on conflict (session_id) do update set encrypted_session = excluded.encrypted_session, updated_at = now()`,
          [rt.row.id, blob]);
        await q.rows(`update public.whatsapp_sessions set session_persisted = true, session_saved_at = now() where id = $1`, [rt.row.id]);
      });
    } catch (e) {
      this.o.log.error({ sessionId: rt.row.id, err: sanitizeError(e) }, 'no se pudo guardar el secreto de sesión');
    }
  }

  /** «Cerrar sesión»: cierre nativo si existe, detiene el cliente, borra el almacenamiento local y los secretos, y deja la sesión desconectada. */
  private async logoutNow(row: SessionRow): Promise<void> {
    const rt = this.runtimes.get(row.id);
    if (rt) rt.wiping = true;
    {
      let adapter: WhatsAppAdapter;
      if (rt) {
        this.runtimes.delete(row.id); rt.stopping = true;
        if (rt.timer) clearTimeout(rt.timer); rt.timer = null;
        rt.unsubs.forEach((u) => u()); rt.sessUnsub?.(); rt.sessUnsub = null;
        adapter = rt.adapter;
      } else adapter = this.o.adapterFactory(row.id);
      await rt?.saves.catch(() => undefined);
      let native: boolean | undefined;
      try { native = (await adapter.logout?.())?.native; } catch (e) { this.o.log.warn({ sessionId: row.id, err: sanitizeError(e) }, 'el cierre de sesión del cliente falló; se borran igualmente los datos'); }
      if (rt) await adapter.disconnect().catch(() => undefined);
      await adapter.wipeLocalSession?.();
      await this.o.db.tx(async (q) => {
        await q.rows(`delete from public.whatsapp_session_secrets where session_id = $1`, [row.id]);
        await q.rows(
          `update public.whatsapp_sessions set desired_state = 'disconnected', status = 'disconnected', status_changed_at = now(), qr_data = null, qr_expires_at = null,
             phone_number = null, session_persisted = false, session_saved_at = null, logout_requested_at = null, last_error = null,
             lease_owner = null, lease_expires_at = null, updated_at = now() where id = $1`, [row.id]);
      });
      this.o.log.info({ sessionId: row.id, nativeLogout: native ?? false }, 'sesión de WhatsApp cerrada; credenciales eliminadas');
    }
  }

  /** WhatsApp o el teléfono invalidaron la sesión: las credenciales guardadas ya no sirven y se eliminan. */
  private async discardInvalidSession(rt: Runtime): Promise<void> {
    rt.wiping = true;
    try {
      await rt.saves.catch(() => undefined);
      await rt.adapter.wipeLocalSession?.();
      await this.o.db.tx(async (q) => {
        await q.rows(`delete from public.whatsapp_session_secrets where session_id = $1`, [rt.row.id]);
        await q.rows(`update public.whatsapp_sessions set session_persisted = false, session_saved_at = null where id = $1`, [rt.row.id]);
      });
    } catch (e) { this.o.log.error({ sessionId: rt.row.id, err: sanitizeError(e) }, 'no se pudo eliminar la sesión invalidada'); }
    finally { rt.wiping = false; }
  }

  private async teardown(rt: Runtime, status: AdapterStatus, writeState = true): Promise<void> {
    rt.stopping = true;
    if (rt.timer) clearTimeout(rt.timer);
    rt.timer = null;
    rt.unsubs.forEach((u) => u());
    try { await rt.adapter.disconnect(); }
    catch (e) { this.o.log.warn({ sessionId: rt.row.id, err: sanitizeError(e) }, 'disconnect falló'); }
    // Credenciales renovadas justo al cerrar: se guardan antes de soltar la sesión. Desconectar CONSERVA la sesión.
    await rt.saves.catch(() => undefined);
    rt.sessUnsub?.(); rt.sessUnsub = null;
    rt.status = status;
    await this.releaseLease(rt.row.id);
    // Cierra el cliente y limpia QR y número (los datos de sesión se conservan para reanudar sin QR).
    if (writeState) await this.write(rt.row.id, { status, clearQr: true, phone: null }).catch(() => undefined);
  }

  private async setStatus(rt: Runtime, s: AdapterStatus, seen = false, extra: { phone?: string | null; lastError?: string | null } = {}): Promise<void> {
    rt.status = s;
    await this.write(rt.row.id, { status: s, clearQr: true, seen: seen || s === 'connected', ...extra });
  }

  private heartbeat(id: string) { return this.write(id, {}, true); }

  /** Las escrituras se serializan: el orden de los estados en la base es el orden en que ocurrieron. */
  private write(id: string, p: WritePatch, onlySeen = false): Promise<void> {
    const run = () => this.doWrite(id, p, onlySeen);
    const next = this.writes.then(run, run);
    this.writes = next;
    return next;
  }

  private async doWrite(id: string, p: WritePatch, onlySeen: boolean): Promise<void> {
    try {
      await this.o.db.tx((q) => {
        if (onlySeen) return q.rows(`update public.whatsapp_sessions set last_seen_at = now(), updated_at = now() where id = $1`, [id]);
        return q.rows(
          `update public.whatsapp_sessions set
             status = coalesce($2, status),
             status_changed_at = case when $2::text is not null and $2::text is distinct from status then now() else status_changed_at end,
             qr_data = case when $3::text is not null then $3 when $4 then null else qr_data end,
             qr_expires_at = case when $3::text is not null then now() + ($5::int * interval '1 millisecond') when $4 then null else qr_expires_at end,
             last_seen_at = case when $6 then now() else last_seen_at end,
             phone_number = case when $7 then $8 else phone_number end,
             last_error = case when $9 then $10 else last_error end,
             updated_at = now()
           where id = $1`,
          [id, p.status ?? null, p.qr ?? null, p.clearQr ?? false, p.qrExpiresInMs ?? 0, p.seen ?? false,
           p.phone !== undefined, p.phone ?? null, p.lastError !== undefined, p.lastError == null ? null : sanitizeError(p.lastError, 500)]);
      });
    } catch (e) {
      this.o.log.error({ sessionId: id, err: sanitizeError(e) }, 'no se pudo escribir el estado de la sesión');
    }
  }

  // ── consulta de estado / envío ──
  status(): SessionInfo[] {
    return [...this.runtimes.values()].map((r) => ({ sessionId: r.row.id, status: r.adapter.getStatus(), reconnectAttempt: r.attempt }));
  }

  /**
   * Adaptador conectado DE ESA CUENTA, o null. No existe alternativa: sin cuenta o sin su sesión no se envía por ninguna otra.
   * (Solo con la base anterior a las cuentas —sin la columna— hay una única sesión y sirve a todos, como siempre.)
   */
  senderFor(accountId: string | null | undefined): WhatsAppAdapter | null {
    for (const r of this.runtimes.values()) {
      const mine = r.row.scoped === false ? true : !!accountId && r.row.account_id === accountId;
      if (mine && !r.stopping && r.adapter.getStatus() === 'connected') return r.adapter;
    }
    return null;
  }

  recovering(): boolean { return [...this.runtimes.values()].some((r) => !r.stopping && !!r.downSince && Date.now() - r.downSince < RECOVERY_WAIT_MS); }

  anyConnected(): boolean { return [...this.runtimes.values()].some((r) => !r.stopping && r.adapter.getStatus() === 'connected'); }
}

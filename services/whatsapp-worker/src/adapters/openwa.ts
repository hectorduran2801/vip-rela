import { fork, type ChildProcess } from 'node:child_process';
import { createHash, hkdfSync } from 'node:crypto';
import { existsSync, mkdirSync, openSync, rmSync } from 'node:fs';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitizeError } from '../log.js';
import { killTree } from './process-tree.js';
import type { FromChild, StartOptions, ToChild } from './openwa-protocol.js';
import { SessionLock } from '../session/lock.js';
import { Emitter, type AdapterStatus, type SendResult, type Unsubscribe, type WhatsAppAdapter } from './types.js';

/** Superficie mínima del proceso hijo (el `ChildProcess` real la cumple; las pruebas inyectan un doble). */
export interface ChildLike {
  pid?: number;
  send(m: ToChild): boolean | void;
  kill(signal?: NodeJS.Signals): boolean | void;
  on(ev: 'message', cb: (m: FromChild) => void): unknown;
  on(ev: 'exit', cb: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(ev: 'error', cb: (e: Error) => void): unknown;
}
export type ChildFactory = () => ChildLike;

export const MAC_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/** CHROME_PATH, o Chrome de macOS si existe; si no, undefined (OpenWA buscará uno del sistema y nunca descarga). */
/** Errores del navegador que indican que la página que usa el cliente ya no existe. */
const PAGE_GONE = /detached Frame|Session closed|Target closed|browser has disconnected/i;

/** puppeteer lanza esto ANTES de ejecutar la orden: el mensaje no salió, así que no queda «sin confirmar». */
const NEVER_RAN = /Attempted to use detached Frame/;

export function resolveChromePath(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync): string | undefined {
  const fromEnv = env.CHROME_PATH?.trim();
  if (fromEnv) return fromEnv;
  return exists(MAC_CHROME) ? MAC_CHROME : undefined;
}

/** Ruta del script hijo: .js compilado, o .ts cuando se ejecuta con tsx. */
function childScript(): string {
  const here = import.meta.url;
  return fileURLToPath(new URL(here.endsWith('.ts') ? './openwa-child.ts' : './openwa-child.js', here));
}

/**
 * Clave con la que OpenWA cifra SU sobre de sesión (auth/data). Sin una clave fija propia, OpenWA genera una distinta en cada arranque y el sobre guardado
 * no se puede descifrar después: WhatsApp pedía QR en cada reinicio. Se deriva de SESSION_ENCRYPTION_KEY (HKDF-SHA256, 32 bytes, base64): estable entre
 * reinicios y máquinas, sin guardar nada más y sin repetir la clave de la base.
 */
export function openwaDataKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const k = env.SESSION_ENCRYPTION_KEY;
  if (!k) return undefined;
  const raw = Buffer.from(k, 'base64');
  return Buffer.from(hkdfSync('sha256', raw, Buffer.from('vip-whatsapp'), Buffer.from('openwa-session-data-v1'), 32)).toString('base64');
}

export const forkChild: ChildFactory = () => {
  // Por defecto stdout/stderr se IGNORAN: OpenWA es muy verboso y podría imprimir datos de sesión. Solo viaja el IPC.
  // Diagnóstico explícito (OPENWA_DEBUG_LOG=/ruta/archivo.log): se vuelca a un archivo LOCAL 0600 fuera del repositorio; no revisar ni compartir sin filtrar.
  const dbg = process.env.OPENWA_DEBUG_LOG;
  const out: number | 'ignore' = dbg ? openSync(dbg, 'a', 0o600) : 'ignore';
  const key = openwaDataKey();
  const env = { ...process.env } as NodeJS.ProcessEnv;
  delete env.WA_SESSION_DATA_ENCRYPTION_KEY; delete env.WA_SESSION_DATA_ENCRYPTION_KEY_FILE; delete env.OPENWA_SESSION_DATA_ENCRYPTION_KEY_FILE;
  if (key) env.OPENWA_SESSION_DATA_ENCRYPTION_KEY = key;
  return fork(childScript(), [], { stdio: ['ignore', out, out, 'ipc'], execArgv: process.execArgv, env }) as ChildProcess;
};

export interface OpenWaAdapterOptions {
  sessionDataPath?: string;
  executablePath?: string;
  headless?: boolean;
  childFactory?: ChildFactory;
  /** Espera máxima a que el hijo salga tras `stop` antes de matarlo. */
  pingTimeoutMs?: number; killAfterMs?: number;
}

/**
 * Adaptador REAL de WhatsApp (OpenWA v5 sobre Chrome). Todo lo que toca el navegador corre en un proceso
 * hijo; si Chrome o el hijo mueren, aquí solo se ve `failed` + motivo y el SessionManager reconecta con backoff.
 *
 * Persistencia: OpenWA guarda su archivo de sesión en `sessionDataPath/{sessionId}.data.json`; al relanzar con el
 * mismo `sessionId` y ruta restaura la sesión sin QR. `restore()` no se usa (los datos NO viajan por el worker).
 * `connect()` retorna al lanzar el hijo; el progreso (starting → qr_pending → awaiting_scan → connecting → connected)
 * llega por `onStatus`/`onQr`. Nunca se pasa a `connected` sin confirmación del cliente.
 */
export class OpenWaAdapter implements WhatsAppAdapter {
  private child: ChildLike | null = null;
  private status: AdapterStatus = 'disconnected';
  private phone: string | null = null;
  private lastError: string | null = null;
  private qrEv = new Emitter<string>();
  private statusEv = new Emitter<AdapterStatus>();
  private sessEv = new Emitter<Buffer>();
  private pending = new Map<number, { res: (r: SendResult) => void; rej: (e: Error) => void }>();
  private seq = 0;
  private loggedOut = false;
  private lastSessionHash: string | null = null;
  private sessionWatch: NodeJS.Timeout | null = null;
  private logoutWaiter: ((native: boolean) => void) | null = null;
  private readonly o: Required<Pick<OpenWaAdapterOptions, 'sessionDataPath' | 'headless' | 'killAfterMs'>> & OpenWaAdapterOptions;

  constructor(private readonly sessionId: string, opts: OpenWaAdapterOptions = {}) {
    this.o = { sessionDataPath: resolve(opts.sessionDataPath ?? '.openwa-sessions'), headless: opts.headless ?? true, killAfterMs: 10_000,
      executablePath: opts.executablePath ?? resolveChromePath(), ...opts };
    this.o.sessionDataPath = resolve(this.o.sessionDataPath);
  }

  private lock: SessionLock | null = null;

  get profileDir(): string { return join(this.o.sessionDataPath, `profile-${this.sessionId}`); }
  private get sessionFile(): string { return join(this.o.sessionDataPath, `${this.sessionId}.data.json`); }
  /** Sobre portátil de OpenWA 5.10: JSON con exactamente `auth` y `data` (cadenas ya cifradas por OpenWA). `LOGGED OUT` = sesión cerrada. */
  static isValidEnvelope(b: Buffer): boolean {
    try { const v = JSON.parse(b.toString('utf8')); return !!v && !Array.isArray(v) && Object.keys(v).sort().join(',') === 'auth,data' && typeof v.auth === 'string' && !!v.auth && typeof v.data === 'string' && !!v.data && b.length <= 67_108_864; }
    catch { return false; }
  }
  private static hash(b: Buffer): string { return createHash('sha256').update(b).digest('hex'); }

  async connect(): Promise<void> {
    await this.killChild();
    this.phone = null; this.lastError = null; this.loggedOut = false;
    mkdirSync(this.o.sessionDataPath, { recursive: true, mode: 0o700 });
    // Una sola instancia por sesión: si otro worker vivo la usa, NO se lanza un segundo Chrome sobre los mismos archivos.
    try { this.lock ??= new SessionLock(join(this.o.sessionDataPath, `${this.sessionId}.lock`)); this.lock.acquire(); }
    catch (e) { this.fail(sanitizeError(e)); throw e; }
    let child: ChildLike;
    try { child = (this.o.childFactory ?? forkChild)(); }
    catch (e) { this.fail(`no se pudo lanzar el cliente de WhatsApp: ${sanitizeError(e)}`); throw e; }
    this.child = child;
    this.set('starting');
    child.on('message', (m) => { if (this.child === child) this.onMessage(m); });
    child.on('error', (e) => { if (this.child === child) this.fail(`error del proceso del cliente: ${sanitizeError(e)}`); });
    child.on('exit', (code, signal) => {
      if (this.child !== child) return;               // salida esperada (stop) o de un hijo anterior
      this.child = null;
      this.fail(`el cliente de WhatsApp/Chrome terminó inesperadamente (${signal ?? `código ${code}`})`);
    });
    // Perfil de Chromium FIJO por sesión: WhatsApp Web conserva su propia autenticación (IndexedDB, Local Storage) entre reinicios, como un navegador normal.
    // OpenWA usa por defecto un perfil temporal que se pierde al cerrar. Un cierre brusco puede dejar marcas de «en uso»: se quitan (ya tenemos el lock de la sesión).
    mkdirSync(this.profileDir, { recursive: true, mode: 0o700 });
    for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) rmSync(join(this.profileDir, f), { force: true });
    const opts: StartOptions = { sessionId: this.sessionId, sessionDataPath: this.o.sessionDataPath, executablePath: this.o.executablePath, headless: this.o.headless, profileDir: this.profileDir };
    child.send({ t: 'start', opts });
    // OpenWA reescribe su archivo cuando cambian las credenciales: se vigila para que el worker lo guarde cifrado en la base.
    void this.scanSession(true);
    this.sessionWatch = setInterval(() => { void this.scanSession(); }, 3000);
    this.sessionWatch.unref?.();
  }

  /** Lee el archivo de sesión: si es válido y cambió, lo entrega; si pasó a `LOGGED OUT`, marca la sesión como invalidada. */
  private async scanSession(baseline = false): Promise<void> {
    let b: Buffer;
    try { b = await readFile(this.sessionFile); } catch { return; }
    if (OpenWaAdapter.isValidEnvelope(b)) {
      const h = OpenWaAdapter.hash(b);
      if (h === this.lastSessionHash) return;
      this.lastSessionHash = h;
      if (!baseline) this.sessEv.emit(b);
    } else if (b.toString('utf8').trim() === 'LOGGED OUT' && this.lastSessionHash !== null) {
      this.lastSessionHash = null; this.loggedOut = true;
    }
  }

  async exportSession(): Promise<Buffer | null> {
    try { const b = await readFile(this.sessionFile); return OpenWaAdapter.isValidEnvelope(b) ? b : null; } catch { return null; }
  }

  async wipeLocalSession(): Promise<void> {
    this.lastSessionHash = null;
    await rm(this.sessionFile, { force: true }); await rm(`${this.sessionFile}.restore.tmp`, { force: true });
    await rm(this.profileDir, { recursive: true, force: true });      // «Cerrar sesión» no deja credenciales en el perfil
  }

  wasLoggedOut(): boolean { return this.loggedOut; }

  /** Cierre definitivo: cierre nativo (si esta versión de OpenWA lo ofrece), detiene el cliente y borra el archivo local. */
  async logout(): Promise<{ native: boolean }> {
    let native = false;
    if (this.child) {
      native = await new Promise<boolean>((done) => {
        const t = setTimeout(() => { this.logoutWaiter = null; done(false); }, 12_000); t.unref?.();
        this.logoutWaiter = (n) => { clearTimeout(t); this.logoutWaiter = null; done(n); };
        try { this.child!.send({ t: 'logout' }); } catch { clearTimeout(t); this.logoutWaiter = null; done(false); }
      });
    }
    await this.killChild(false);
    this.lock?.release();
    await this.wipeLocalSession();
    this.phone = null; this.loggedOut = false;
    this.set('disconnected');
    return { native };
  }

  async disconnect(): Promise<void> {
    await this.killChild();
    this.lock?.release();
    this.phone = null;
    this.set('disconnected');
  }

  getStatus() { return this.status; }
  getPhoneNumber() { return this.phone; }
  getLastError() { return this.lastError; }
  onQr(cb: (qr: string) => void): Unsubscribe { return this.qrEv.on(cb); }
  onStatus(cb: (s: AdapterStatus) => void): Unsubscribe { return this.statusEv.on(cb); }
  onSessionData(cb: (d: Buffer) => void): Unsubscribe { return this.sessEv.on(cb); }
  /** No-op: OpenWA persiste su propia sesión en disco (ver docs/whatsapp-worker.md). */
  /** Escribe el sobre guardado donde OpenWA lo espera (`<id>.data.json`, 0600) ANTES de `connect()`; así reanuda sin QR. */
  async restore(session: Buffer): Promise<void> {
    if (!OpenWaAdapter.isValidEnvelope(session)) throw new Error('los datos de sesión guardados no tienen el formato de OpenWA');
    mkdirSync(this.o.sessionDataPath, { recursive: true, mode: 0o700 });
    const tmp = `${this.sessionFile}.restore.tmp`;
    await writeFile(tmp, session, { mode: 0o600 });
    await rename(tmp, this.sessionFile);
    this.lastSessionHash = OpenWaAdapter.hash(session);
  }

  async sendText(phone: string, body: string): Promise<SendResult> {
    if (!this.child || this.status !== 'connected') throw new Error('sesión de WhatsApp no conectada');
    const id = ++this.seq;
    const chatId = `${phone.replace(/\D/g, '')}@c.us`;
    return new Promise<SendResult>((res, rej) => {
      this.pending.set(id, { res, rej });
      this.child!.send({ t: 'send', id, chatId, body });
    });
  }

  private pings = new Map<number, (r: string | null) => void>();      // null = respondió; texto = por qué no
  private pingError: string | null = null;
  /** Por qué la última comprobación no dio respuesta limpia (null = respondió). */
  getPingError(): string | null { return this.pingError; }

  async ping(): Promise<boolean> {
    if (!this.child || this.status !== 'connected') return false;
    const id = ++this.seq, child = this.child;
    const why = await new Promise<string | null>((done) => {
      const t = setTimeout(() => { this.pings.delete(id); done('sin respuesta'); }, this.o.pingTimeoutMs ?? 10_000);
      this.pings.set(id, (r) => { clearTimeout(t); this.pings.delete(id); done(r); });
      try { child.send({ t: 'ping', id }); } catch { done('sin respuesta'); }
    });
    this.pingError = why === null ? null : sanitizeError(why);
    // Solo se da por caída si la página ya no existe o no contesta; otro error de la consulta no justifica reiniciar la sesión.
    if (why === null || !(why === 'sin respuesta' || PAGE_GONE.test(why))) return true;
    if (this.child === child) { this.fail('WhatsApp Web dejó de responder; reconectando.'); void this.killChild(); }
    return false;
  }

  private onMessage(m: FromChild): void {
    switch (m.t) {
      case 'status': this.set(m.status); break;
      case 'qr': this.qrEv.emit(m.qr); this.set('awaiting_scan'); break;
      case 'connected': this.phone = m.phone; this.lastError = null; this.set('connected'); break;
      case 'logout_done': this.logoutWaiter?.(m.native); break;
      case 'lost': if (m.loggedOut) this.loggedOut = true; this.phone = null; this.lastError = sanitizeError(m.reason); this.set('disconnected'); break;
      case 'error': this.fail(sanitizeError(m.error)); void this.killChild(); break;
      case 'sent': { const p = this.pending.get(m.id); this.pending.delete(m.id); p?.res({ messageId: m.messageId }); break; }
      case 'pong': this.pings.get(m.id)?.(m.ok ? null : String(m.error ?? '')); break;
      case 'send_error': {
        const neverRan = NEVER_RAN.test(m.detail ?? '');
        const p = this.pending.get(m.id); this.pending.delete(m.id);
        p?.rej(Object.assign(new Error(neverRan ? 'No se envió: WhatsApp Web se había recargado. Vuelve a enviarlo.' : sanitizeError(m.error)),
          { outcome: neverRan ? 'not_sent' : m.outcome, detail: m.detail ? sanitizeError(m.detail) : undefined }));
        // Página recargada o cerrada: el cliente sigue «conectado» pero ningún envío saldrá. Se da por caído para que el gestor reconecte.
        if (PAGE_GONE.test(`${m.error} ${m.detail ?? ''}`)) { this.fail('WhatsApp Web se recargó y dejó de responder; reconectando.'); void this.killChild(); }
        break;
      }
    }
  }

  private fail(reason: string): void {
    this.phone = null; this.lastError = reason;
    this.rejectPending(new Error('sesión de WhatsApp caída'));
    this.set('failed');
  }

  private rejectPending(e: Error) { for (const p of this.pending.values()) p.rej(e); this.pending.clear(); }

  private async killChild(finalScan = true): Promise<void> {
    if (this.sessionWatch) { clearInterval(this.sessionWatch); this.sessionWatch = null; }
    const c = this.child; this.child = null;
    this.rejectPending(new Error('sesión de WhatsApp cerrada'));
    if (!c) return;
    await new Promise<void>((done) => {
      const t = setTimeout(() => { try { if (c.pid) killTree(c.pid); else c.kill('SIGKILL'); } catch { /* ya muerto */ } done(); }, this.o.killAfterMs);
      t.unref?.();
      c.on('exit', () => { clearTimeout(t); done(); });
      try { c.send({ t: 'stop' }); } catch { try { if (c.pid) killTree(c.pid); else c.kill('SIGKILL'); } catch { /* */ } }
    });
    if (finalScan) await this.scanSession();      // credenciales renovadas justo antes de cerrar
  }

  private set(s: AdapterStatus) { this.status = s; this.statusEv.emit(s); }
}

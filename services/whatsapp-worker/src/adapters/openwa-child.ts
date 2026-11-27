/**
 * Proceso hijo: ejecuta OpenWA (@open-wa/wa-automate v5) + Chrome. Vive aparte del worker para que un
 * cuelgue/crash de Chrome nunca tumbe la cola. Se comunica por IPC (ver openwa-protocol.ts).
 * Nunca imprime el QR ni datos de sesión.
 */
import type { FromChild, StartOptions, ToChild } from './openwa-protocol.js';

const send = (m: FromChild) => { if (process.connected) process.send?.(m); };
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

type Client = {
  getHostNumber(): Promise<string>;
  sendText(to: string, body: string): Promise<unknown>;
  stop(reason?: string): Promise<void>;
  onStateChanged(cb: (s: string) => void | Promise<void>): unknown;
  onLogout(cb: (p: { reason?: string }) => void | Promise<void>): unknown;
  /** No existe en todas las versiones de OpenWA: solo se usa si está. */
  logout?: () => Promise<unknown>;
};
let client: Client | null = null;
let stopping = false;

async function start(o: StartOptions): Promise<void> {
  send({ t: 'status', status: 'starting' });
  try {
    const mod = (await import('@open-wa/wa-automate')) as unknown as {
      create(opts: Record<string, unknown>): Promise<Client>;
      ev: { on(name: string, cb: (p: any) => void): unknown };
    };
    // Eventos reales del ciclo de autenticación de OpenWA.
    mod.ev.on('launch.auth.qr.requested', () => send({ t: 'status', status: 'qr_pending' }));
    mod.ev.on('launch.auth.qr.generated', (p) => { const qr = p?.details?.qr; if (typeof qr === 'string' && qr) send({ t: 'qr', qr }); });
    mod.ev.on('launch.auth.qr.scanned', () => send({ t: 'status', status: 'connecting' }));
    mod.ev.on('launch.auth.pairing', () => send({ t: 'status', status: 'connecting' }));

    // Diagnóstico opcional (OPENWA_DEBUG_EVENTS=1): solo NOMBRES de eventos del ciclo de autenticación/persistencia, jamás sus datos (pueden contener QR o claves).
    if (process.env.OPENWA_DEBUG_EVENTS === '1') {
      for (const name of ['launch.auth.qr.requested', 'launch.auth.qr.generated', 'launch.auth.qr.scanned', 'launch.auth.pairing', 'launch.auth.restored', 'launch.auth.failed', 'launch.ready',
        'persistence.session.save.before', 'persistence.session.save.after', 'persistence.session.load.before', 'persistence.session.load.after', 'core.stopping']) {
        try { mod.ev.on(name, () => process.stderr.write(`[openwa-evento] ${name}\n`)); } catch { /* evento desconocido en esta versión */ }
      }
    }
    const c = await mod.create({
      sessionId: o.sessionId,
      sessionDataPath: o.sessionDataPath,
      headless: o.headless,
      ...(o.profileDir ? { chromiumArgs: [`--user-data-dir=${o.profileDir}`] } : {}),
      ...(o.executablePath ? { executablePath: o.executablePath, browser: { source: 'system', download: 'never' } } : { browser: { download: 'never' } }),
      qrTimeout: 0,                      // espera el escaneo sin límite (el QR se renueva solo)
      authTimeout: 0,
      qrLogSkip: true, ezqr: false, logLevel: (process.env.OPENWA_LOG_LEVEL ?? 'ERROR'),   // diagnóstico opcional (INFO/DEBUG); por defecto solo errores
      killProcessOnBrowserClose: false, killProcessOnTimeout: false, killProcessOnBan: false,
    });
    client = c;
    if (stopping) { await c.stop('stopped during start').catch(() => undefined); return; }
    let phone: string | null = null;
    try { phone = String(await c.getHostNumber()) || null; } catch { /* el número es informativo */ }
    c.onStateChanged((s) => { if (s === 'DISCONNECTED' || s === 'STOPPED') send({ t: 'lost', reason: `estado ${s}` }); });
    c.onLogout((p) => send({ t: 'lost', loggedOut: true, reason: `sesión cerrada desde el teléfono${p?.reason ? ` (${p.reason})` : ''}` }));
    send({ t: 'connected', phone });
  } catch (e) {
    send({ t: 'error', error: msg(e) });
  }
}

async function shutdown(): Promise<void> {
  stopping = true;
  try { await Promise.race([client?.stop('worker stop'), new Promise((r) => setTimeout(r, 8000))]); } catch { /* ya cerrado */ }
  process.exit(0);
}

process.on('message', (m: ToChild) => {
  if (m.t === 'start') void start(m.opts);
  else if (m.t === 'stop') void shutdown();
  else if (m.t === 'logout') {
    // Cierre nativo si esta versión de OpenWA lo ofrece; si no, el padre borra la sesión local y los secretos (la sesión deja de ser restaurable).
    void (async () => {
      let native = false;
      try { if (client && typeof client.logout === 'function') { await Promise.race([client.logout(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 10_000))]); native = true; } } catch { /* sin cierre nativo */ }
      send({ t: 'logout_done', native });
    })();
  }
  else if (m.t === 'ping') {
    if (!client) { send({ t: 'pong', id: m.id, ok: false, error: 'sin respuesta' }); return; }
    // getHostNumber va a la página en cada llamada (getConnectionState figura como no admitido en esta versión de OpenWA).
    client.getHostNumber().then(
      () => send({ t: 'pong', id: m.id, ok: true }),
      (e) => { const cause = (e as { cause?: unknown })?.cause; send({ t: 'pong', id: m.id, ok: false, error: `${msg(e)} ${cause ? msg(cause) : ''}`.slice(0, 800) }); });
  }
  else if (m.t === 'send') {
    if (!client) { send({ t: 'send_error', id: m.id, error: 'cliente de WhatsApp no iniciado' }); return; }
    client.sendText(m.chatId, m.body).then(
      (r) => send({ t: 'sent', id: m.id, messageId: typeof r === 'string' ? r : undefined }),
      (e) => {
        // SendTextError de OpenWA trae `outcome` ('unknown' = no se sabe si salió; 'not_sent' = no salió) y la causa técnica.
        const o = (e as { outcome?: unknown })?.outcome; const cause = (e as { cause?: unknown })?.cause;
        send({ t: 'send_error', id: m.id, error: msg(e), outcome: o === 'unknown' || o === 'not_sent' ? o : undefined, detail: cause ? msg(cause).slice(0, 800) : undefined });
      });
  }
});
// Si el worker muere, el hijo (y su Chrome) también.
process.on('disconnect', () => { void shutdown(); });
// Un rechazo suelto de Chrome solo es fatal si aún no hay cliente; después se ignora (el estado lo informa onStateChanged).
process.on('unhandledRejection', (e) => { if (!client) send({ t: 'error', error: msg(e) }); });

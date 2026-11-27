/** Mensajes IPC entre el worker (padre) y el proceso hijo que ejecuta OpenWA + Chrome. */
export interface StartOptions {
  sessionId: string;
  /** Perfil de Chromium propio y persistente de esta sesión. */
  profileDir?: string;
  /** Directorio donde OpenWA guarda su archivo de sesión (`{sessionId}.data.json`). */
  sessionDataPath: string;
  /** Ejecutable de Chrome/Chromium del sistema (si falta, OpenWA busca uno y NUNCA descarga). */
  executablePath?: string;
  headless: boolean;
}

export type ToChild =
  | { t: 'start'; opts: StartOptions }
  | { t: 'send'; id: number; chatId: string; body: string }
  | { t: 'ping'; id: number }
  | { t: 'logout' }
  | { t: 'stop' };

export type FromChild =
  | { t: 'pong'; id: number; ok: boolean; error?: string }
  | { t: 'status'; status: 'starting' | 'qr_pending' | 'connecting' }
  | { t: 'qr'; qr: string }
  | { t: 'connected'; phone: string | null }
  | { t: 'lost'; reason: string; loggedOut?: boolean }              // la sesión se cayó o se desvinculó
  | { t: 'error'; error: string }              // fallo al arrancar/autenticar
  | { t: 'logout_done'; native: boolean }
  | { t: 'sent'; id: number; messageId?: string }
  | { t: 'send_error'; id: number; error: string; outcome?: 'unknown' | 'not_sent'; detail?: string };

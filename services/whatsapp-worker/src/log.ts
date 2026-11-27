import { pino, type Logger } from 'pino';

export type Log = Logger;

export function createLogger(level = 'info'): Log {
  return pino({
    level,
    base: { service: 'whatsapp-worker' },
    // Red de seguridad: estos campos jamás deben salir en logs aunque alguien los pase por error.
    redact: { paths: ['qr', 'qr_data', 'body', 'rendered_body', 'phone', 'session', 'encrypted_session', 'key', '*.qr', '*.body', '*.phone', '*.session'], censor: '[REDACTED]' },
  });
}

/** `+50761234567` -> `***4567`. */
export function maskPhone(phone: string | null | undefined): string {
  if (!phone) return '***';
  const d = phone.replace(/\D/g, '');
  return `***${d.slice(-4)}`;
}

/** Quita de un texto de error cualquier secuencia que parezca un teléfono (7+ dígitos) y lo acota. */
export function sanitizeError(e: unknown, max = 300): string {
  const raw = e instanceof Error ? e.message : String(e);
  return raw.replace(/\+?\d[\d\s().-]{5,}\d/g, '[num]').slice(0, max);
}

export const silentLogger = (): Log => pino({ level: 'silent' });

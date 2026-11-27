import { z } from 'zod';

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v.trim() === '') return def;
      const s = v.trim().toLowerCase();
      if (['true', '1', 'yes'].includes(s)) return true;
      if (['false', '0', 'no'].includes(s)) return false;
      ctx.addIssue({ code: 'custom', message: 'debe ser true o false' });
      return z.NEVER;
    });

const int = (def: number, min: number, max = Number.MAX_SAFE_INTEGER) =>
  z.coerce.number().int().min(min).max(max).default(def);

/** Clave AES-256: 32 bytes en base64. */
export function parseEncryptionKey(b64: string): Buffer {
  const key = Buffer.from(b64, 'base64');
  if (key.length !== 32 || key.toString('base64') !== b64.trim()) {
    throw new Error('SESSION_ENCRYPTION_KEY debe ser 32 bytes en base64 (p. ej. `openssl rand -base64 32`)');
  }
  return key;
}

const schema = z
  .object({
    DATABASE_URL: z.string().min(1, 'DATABASE_URL es obligatoria (solo servidor)'),
    /** Por defecto TRUE: ningún envío real sin autorización explícita. */
    WHATSAPP_DRY_RUN: bool(true),
    /** Interruptor EXPLÍCITO: permite enviar UN mensaje de prueba real autorizado por SUPER_ADMIN. NO activa envíos de cobranza (esos siguen en WHATSAPP_DRY_RUN). */
    WHATSAPP_ALLOW_REAL_TEST: bool(false),
    /** Recordatorios automáticos por horario. Por defecto FALSE: los mensajes los inicia la administradora (Cobranza). */
    AUTOMATIC_REMINDERS: bool(false),
    POLL_INTERVAL_SECONDS: int(15, 1),
    BATCH_SIZE: int(10, 1, 200),
    SEND_CONCURRENCY: int(2, 1, 20),
    RATE_LIMIT_PER_MINUTE: int(20, 1, 600),
    SEND_JITTER_MS: int(1500, 0, 60_000),
    STUCK_AFTER_MINUTES: int(10, 1),
    NO_SESSION_RETRY_SECONDS: int(60, 1),
    SEND_TIMEOUT_SECONDS: int(45, 1),
    SESSION_ENCRYPTION_KEY: z.string().optional(),
    SESSION_POLL_SECONDS: int(5, 1),
    /** Heartbeat del worker en whatsapp_sessions.worker_heartbeat_at (máx. 10 s: la API lo usa para saber si el servicio corre). */
    HEARTBEAT_SECONDS: int(10, 1, 10),
    /** SOLO la CONEXIÓN: openwa (real, por defecto) | fake (pruebas). El ENVÍO sigue gobernado por WHATSAPP_DRY_RUN. */
    WHATSAPP_ADAPTER: z.enum(['openwa', 'fake']).default('openwa'),
    CHROME_PATH: z.string().optional(),
    OPENWA_SESSION_PATH: z.string().default('.openwa-sessions'),
    OPENWA_HEADLESS: bool(true),
    RECONNECT_BASE_MS: int(2000, 1),
    RECONNECT_MAX_MS: int(300_000, 1),
    HEALTH_PORT: z.coerce.number().int().min(1).max(65535).optional(),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  })
  .superRefine((c, ctx) => {
    if (c.SESSION_ENCRYPTION_KEY) {
      try { parseEncryptionKey(c.SESSION_ENCRYPTION_KEY); }
      catch (e) { ctx.addIssue({ code: 'custom', path: ['SESSION_ENCRYPTION_KEY'], message: (e as Error).message }); }
    } else if (!c.WHATSAPP_DRY_RUN || c.WHATSAPP_ALLOW_REAL_TEST) {
      ctx.addIssue({ code: 'custom', path: ['SESSION_ENCRYPTION_KEY'], message: 'obligatoria cuando WHATSAPP_DRY_RUN=false o WHATSAPP_ALLOW_REAL_TEST=true' });
    }
    if (process.env.VITEST && !c.WHATSAPP_DRY_RUN) {
      ctx.addIssue({ code: 'custom', path: ['WHATSAPP_DRY_RUN'], message: 'las pruebas exigen WHATSAPP_DRY_RUN=true' });
    }
  });

export type Config = z.infer<typeof schema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const r = schema.safeParse(env);
  if (!r.success) {
    // Solo nombres de variable y motivo: nunca el valor (puede contener secretos).
    const msg = r.error.issues.map((i) => `${i.path.join('.') || '(config)'}: ${i.message}`).join('; ');
    throw new Error(`Configuración inválida: ${msg}`);
  }
  return r.data;
}

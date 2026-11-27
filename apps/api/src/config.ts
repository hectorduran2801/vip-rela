import { z } from 'zod';

const bool = (def: 'true' | 'false') =>
  z.enum(['true', 'false']).default(def).transform((v) => v === 'true');

const schema = z.object({
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('127.0.0.1'),
  APP_TIMEZONE: z.string().default('America/Panama'),
  WHATSAPP_DRY_RUN: bool('true'),
  /** Solo servidor. Nunca llega a Angular. */
  DATABASE_URL: z.string().optional(),
  /** Ruta a la CA de Supabase (.crt) para verificar el certificado de la base de datos. */
  DATABASE_SSL_CA: z.string().optional(),
  SUPABASE_URL: z.string().url().optional(),
  /** Verificación del JWT: secreto HS256 (proyectos con secreto heredado) o JWKS del proyecto (claves asimétricas). */
  SUPABASE_JWT_SECRET: z.string().min(16).optional(),
  SUPABASE_JWKS_URL: z.string().url().optional(),
  /** SOLO servidor: permite crear la identidad en Supabase Auth desde VIP (Admin API). Sin ella, VIP solo invita y la cuenta se crea en el panel. */
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20).optional(),
  /** Orígenes del frontend permitidos, separados por coma. Vacío = ninguno. */
  CORS_ORIGINS: z.string().default('').transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean)),
  /** Motor de cobranza: genera las cuotas diarias desde la API (independiente de OpenWA). false = desactivado (pruebas). */
  BILLING_ENGINE: bool('true'),
  BILLING_ENGINE_INTERVAL_SECONDS: z.coerce.number().int().min(5).max(3600).default(300),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().default(120),
});

export type Config = z.infer<typeof schema>;
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => {
  const c = schema.parse(env);
  if (/supabase\.(co|com)/.test(c.DATABASE_URL ?? '') && env.ALLOW_SHARED_DB !== 'yes') {
    throw new Error('DATABASE_URL apunta a Supabase: confirma explícitamente con ALLOW_SHARED_DB=yes (no se hace durante las pruebas).');
  }
  return c;
};

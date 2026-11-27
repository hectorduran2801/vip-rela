/**
 * Configuración pública. SOLO clave publicable de Supabase (nunca service_role ni secretos).
 * Se puede regenerar desde variables de entorno con `pnpm --filter @vip/web run config:env`
 * (SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, API_URL).
 */
export const environment = {
  supabaseUrl: 'https://ekhxxedpqnjpibpmpcmf.supabase.co',
  /** Clave PUBLICABLE del proyecto de DESARROLLO (pública por diseño; la seguridad la dan RLS y la API). */
  supabasePublishableKey: 'sb_publishable_jaC3yFzd_v5mHVYbbCDF8Q_yEbJ8aPy',
  apiUrl: '/api/v1',
};

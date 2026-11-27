// Genera src/environments/environment.ts desde variables de entorno (solo valores públicos).
import { writeFileSync } from 'node:fs';
const url = process.env.SUPABASE_URL ?? 'https://ekhxxedpqnjpibpmpcmf.supabase.co';
// Clave PUBLICABLE del proyecto de desarrollo (pública por diseño). Se puede sustituir con la variable de entorno.
const key = process.env.SUPABASE_PUBLISHABLE_KEY ?? 'sb_publishable_jaC3yFzd_v5mHVYbbCDF8Q_yEbJ8aPy';
const api = process.env.API_URL ?? '/api/v1';
if (/service_role|sb_secret/i.test(key)) throw new Error('Solo se admite la clave PUBLICABLE.');
writeFileSync(new URL('./src/environments/environment.ts', import.meta.url),
  `export const environment = ${JSON.stringify({ supabaseUrl: url, supabasePublishableKey: key, apiUrl: api }, null, 2)};\n`);
console.log('environment.ts generado');

import { InjectionToken } from '@angular/core';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { environment } from '../../environments/environment';

/** Cliente con la clave PUBLICABLE. null si aún no está configurada (no se inventa ninguna clave). */
export const SUPABASE = new InjectionToken<SupabaseClient | null>('SUPABASE', {
  providedIn: 'root',
  factory: () =>
    environment.supabaseUrl && environment.supabasePublishableKey
      ? createClient(environment.supabaseUrl, environment.supabasePublishableKey, {
          auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
        })
      : null,
});

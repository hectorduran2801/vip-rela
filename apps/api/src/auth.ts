import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { Config } from './config.js';

export interface AuthUser { id: string; email?: string }

export class AuthError extends Error {}

/** Verifica el access token emitido por Supabase Auth. No confía en nada que no esté firmado. */
export function makeVerifier(config: Config): (token: string) => Promise<AuthUser> {
  let key: Uint8Array | JWTVerifyGetKey;
  if (config.SUPABASE_JWT_SECRET) key = new TextEncoder().encode(config.SUPABASE_JWT_SECRET);
  else if (config.SUPABASE_JWKS_URL) key = createRemoteJWKSet(new URL(config.SUPABASE_JWKS_URL));
  else if (config.SUPABASE_URL) key = createRemoteJWKSet(new URL(`${config.SUPABASE_URL}/auth/v1/.well-known/jwks.json`));
  else return async () => { throw new AuthError('auth_not_configured'); };

  return async (token) => {
    try {
      const { payload } = await jwtVerify(token, key as never, { audience: 'authenticated' });
      if (!payload.sub || payload.role !== 'authenticated') throw new AuthError('invalid_token');
      return { id: payload.sub, email: typeof payload.email === 'string' ? payload.email : undefined };
    } catch (e) {
      throw e instanceof AuthError ? e : new AuthError('invalid_token');
    }
  };
}

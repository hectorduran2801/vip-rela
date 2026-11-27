import { Injectable, inject, signal } from '@angular/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ApiError, errorMessage } from './errors';
import { isRole, type AuthUser, type Role } from './models';
import { AuthService, NOT_AUTHORIZED_MESSAGE, type AuthStatus } from './services';
import { SUPABASE } from './supabase-client';

interface RpcError { code?: string; message?: string; status?: number }
const NOT_CONFIGURED = new Set(['PGRST202', 'PGRST205', '42883', '42P01']);

/**
 * Distingue por qué falló rpc('current_app_role'):
 * - 404 / PGRST202 (función inexistente) / PGRST205 (tabla inexistente): el esquema de Supabase aún no está aplicado → `db_not_configured`.
 * - red caída, 5xx o cualquier otro fallo → `auth_unreachable`.
 * (Que la cuenta no esté autorizada es otro caso: la función responde false.)
 */
export function classifyRpcError(e: RpcError, status?: number): 'db_not_configured' | 'auth_unreachable' {
  const st = status ?? e.status ?? 0;
  if ((e.code && NOT_CONFIGURED.has(e.code)) || st === 404 || /could not find the (function|table)/i.test(e.message ?? '')) return 'db_not_configured';
  return 'auth_unreachable';
}

/**
 * Supabase Auth para la instancia única: tras iniciar sesión (o restaurarla) se llama a
 * `rpc('current_app_role')`. Solo si devuelve true la sesión queda activa; si no, se cierra.
 */
@Injectable()
export class SupabaseAuthService extends AuthService {
  private readonly sb = inject(SUPABASE);
  private readonly _status = signal<AuthStatus>('loading');
  private readonly _user = signal<AuthUser | null>(null);
  private readonly _notice = signal<string | null>(null);
  private readonly _mustChange = signal(false);
  override readonly mustChangePassword = this._mustChange.asReadonly();
  readonly status = this._status.asReadonly();
  readonly user = this._user.asReadonly();
  readonly notice = this._notice.asReadonly();
  private readonly readyPromise: Promise<void>;

  constructor() {
    super();
    if (!this.sb) {
      this._status.set('unconfigured');
      this.readyPromise = Promise.resolve();
      return;
    }
    const sb = this.sb;
    this.readyPromise = (async () => {
      const { data } = await sb.auth.getSession();
      await this.restore(sb, data.session?.user.id, data.session?.user.email);
      sb.auth.onAuthStateChange((event, s) => {
        if (event === 'INITIAL_SESSION' || event === 'TOKEN_REFRESHED') return;
        // setTimeout evita llamar a Supabase dentro del callback (bloqueo interno de auth-js).
        if (event === 'SIGNED_OUT') setTimeout(() => this.clear(), 0);
        else if (event === 'SIGNED_IN' && this._user()?.userId !== s?.user.id && !this.signingIn) {
          setTimeout(() => void this.restore(sb, s?.user.id, s?.user.email), 0);
        }
      });
    })();
  }

  private signingIn = false;

  ready(): Promise<void> { return this.readyPromise; }

  private clear(): void { this._user.set(null); this._mustChange.set(false); this._status.set('anonymous'); }

  private async refreshMustChange(sb: SupabaseClient): Promise<void> {
    try { const { data } = await sb.auth.getUser(); this._mustChange.set(data.user?.user_metadata?.['must_change_password'] === true); } catch { /* sin red: no se bloquea */ }
  }

  /** Rol de la cuenta (rpc current_app_role: 'super_admin' | 'admin' | 'supervisor' | null). null = no autorizada. Lanza si falla. */
  private async checkAuthorized(sb: SupabaseClient): Promise<Role | null> {
    let res: Awaited<ReturnType<typeof sb.rpc>>;
    try { res = await sb.rpc('current_app_role'); } catch { throw new ApiError('auth_unreachable'); }
    if (res.error) throw new ApiError(classifyRpcError(res.error as RpcError, res.status));
    return isRole(res.data) ? res.data : null;
  }

  /** Restaura una sesión existente: autorizada → authenticated; si no, cierra sesión y deja un aviso. */
  private async restore(sb: SupabaseClient, userId?: string, email?: string): Promise<void> {
    if (!userId) { this.clear(); return; }
    try {
      const role = await this.checkAuthorized(sb);
      if (role) {
        this._notice.set(null);
        await this.refreshMustChange(sb);
        this._user.set({ userId, email: email ?? '', role });
        this._status.set('authenticated');
        return;
      }
      this._notice.set(NOT_AUTHORIZED_MESSAGE);
    } catch (e) {
      this._notice.set(e instanceof ApiError ? errorMessage(e) : NOT_AUTHORIZED_MESSAGE);
    }
    await sb.auth.signOut();
    this.clear();
  }

  private client(): SupabaseClient {
    if (!this.sb) throw new ApiError('not_configured');
    return this.sb;
  }

  async signIn(email: string, password: string): Promise<void> {
    const sb = this.client();
    this.signingIn = true;
    try {
      this._notice.set(null);
      const { data, error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
      let role: Role | null = null;
      try { role = await this.checkAuthorized(sb); } catch (e) { await sb.auth.signOut(); this.clear(); throw e; }
      if (!role) { await sb.auth.signOut(); this.clear(); throw new ApiError('not_authorized'); }
      this._mustChange.set(data.user?.user_metadata?.['must_change_password'] === true);
      this._user.set({ userId: data.user?.id ?? '', email: data.user?.email ?? email, role });
      this._status.set('authenticated');
    } finally {
      this.signingIn = false;
    }
  }

  async signOut(): Promise<void> {
    await this.client().auth.signOut();
    this.clear();
  }

  async requestPasswordReset(email: string): Promise<void> {
    const { error } = await this.client().auth.resetPasswordForEmail(email, { redirectTo: `${location.origin}/restablecer` });
    if (error) throw error;
  }

  async updatePassword(password: string): Promise<void> {
    const { error } = await this.client().auth.updateUser({ password, data: { must_change_password: false } });
    if (error) throw error;
    this._mustChange.set(false);
  }

  async accessToken(): Promise<string | null> {
    if (!this.sb) return null;
    const { data } = await this.sb.auth.getSession();
    return data.session?.access_token ?? null;
  }
}

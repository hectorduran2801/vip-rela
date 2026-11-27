import type { Role } from './models';
import { TestBed } from '@angular/core/testing';
import { ApiError, errorMessage as rawMessage, splitError } from './errors';
const errorMessage = (e: unknown) => splitError(rawMessage(e)).message;
import { NOT_AUTHORIZED_MESSAGE } from './services';
import { SUPABASE } from './supabase-client';
import { SupabaseAuthService } from './supabase-auth.service';

/**
 * SupabaseAuthService con un DOBLE del cliente de supabase-js (no se conecta a ningún Supabase real).
 * Verifica la regla de instancia única: tras iniciar/restaurar sesión se llama a rpc('current_app_role');
 * si devuelve false (o falla) se cierra la sesión.
 */
function fakeClient(opts: { session?: { id: string; email: string } | null; authorized?: boolean | Role | 'error' | 'notfound' | 'network' | 'schema'; signInError?: Error } = {}) {
  const user = opts.session ?? null;
  const calls: string[] = [];
  const client = {
    auth: {
      getSession: vi.fn(async () => ({ data: { session: user ? { user, access_token: 'tok' } : null } })),
      signInWithPassword: vi.fn(async (c: { email: string }) => {
        calls.push('signIn');
        return opts.signInError ? { data: {}, error: opts.signInError } : { data: { user: { id: 'u1', email: c.email } }, error: null };
      }),
      signOut: vi.fn(async () => { calls.push('signOut'); return { error: null }; }),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe() {} } } })),
      resetPasswordForEmail: vi.fn(async () => ({ error: null })),
      updateUser: vi.fn(async () => ({ error: null })),
    },
    rpc: vi.fn(async (fn: string) => {
      calls.push(`rpc:${fn}`);
      if (opts.authorized === 'notfound') return { data: null, status: 404, error: { code: 'PGRST202', message: 'Could not find the function public.is_authorized' } };
      if (opts.authorized === 'schema') return { data: null, status: 404, error: { code: 'PGRST205', message: 'Could not find the table' } };
      if (opts.authorized === 'network') throw new TypeError('Failed to fetch');
      return opts.authorized === 'error' ? { data: null, status: 503, error: { message: 'boom' } } : { data: opts.authorized === false ? null : opts.authorized === true || opts.authorized === undefined ? 'super_admin' : opts.authorized, error: null };
    }),
    from: vi.fn(() => { throw new Error('la autenticación no debe consultar tablas (organization_members)'); }),
  };
  return { client, calls };
}
async function make(opts: Parameters<typeof fakeClient>[0] = {}) {
  const f = fakeClient(opts);
  TestBed.configureTestingModule({ providers: [SupabaseAuthService, { provide: SUPABASE, useValue: f.client }] });
  const auth = TestBed.inject(SupabaseAuthService);
  await auth.ready();
  return { auth, ...f };
}

describe('SupabaseAuthService (instancia única, doble del cliente)', () => {
  it('sin clave publicable queda «unconfigured»', async () => {
    TestBed.configureTestingModule({ providers: [SupabaseAuthService, { provide: SUPABASE, useValue: null }] });
    const auth = TestBed.inject(SupabaseAuthService);
    await auth.ready();
    expect(auth.status()).toBe('unconfigured');
  });
  it('sin sesión guardada: anónimo y no consulta is_authorized', async () => {
    const { auth, client } = await make();
    expect(auth.status()).toBe('anonymous');
    expect(client.rpc).not.toHaveBeenCalled();
  });
  it('iniciar sesión con cuenta autorizada: llama a is_authorized y queda autenticada', async () => {
    const { auth, client, calls } = await make({ authorized: true });
    await auth.signIn('admin@example.test', 'x');
    expect(client.rpc).toHaveBeenCalledWith('current_app_role');
    expect(calls).toEqual(['signIn', 'rpc:current_app_role']);
    expect(auth.status()).toBe('authenticated');
    expect(auth.user()).toEqual({ userId: 'u1', email: 'admin@example.test', role: 'super_admin' });
  });
  it.each(['super_admin', 'admin', 'supervisor'] as const)('el rol %s llega a la sesión', async (role) => {
    const { auth } = await make({ authorized: role });
    await auth.signIn('a@x.co', 'x');
    expect(auth.user()?.role).toBe(role);
  });
  it('un valor de rol desconocido se trata como no autorizada', async () => {
    const { auth } = await make({ authorized: 'otro' as Role });
    await expect(auth.signIn('a@x.co', 'x')).rejects.toMatchObject({ code: 'not_authorized' });
  });
  it('cuenta NO autorizada: lanza not_authorized con el mensaje claro y CIERRA la sesión', async () => {
    const { auth, calls } = await make({ authorized: false });
    const err = await auth.signIn('otra@x.co', 'x').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(errorMessage(err)).toBe('Esta cuenta no está autorizada para usar VIP');
    expect(calls).toEqual(['signIn', 'rpc:current_app_role', 'signOut']);
    expect(auth.status()).toBe('anonymous');
    expect(auth.user()).toBeNull();
  });
  it('si la comprobación falla no deja pasar: cierra sesión y avisa', async () => {
    const { auth, calls } = await make({ authorized: 'error' });
    const err = await auth.signIn('a@x.co', 'x').catch((e) => e);
    expect(errorMessage(err)).toBe('No se pudo conectar con el servidor. Revisa tu conexión e inténtalo de nuevo.');
    expect(calls).toContain('signOut');
    expect(auth.status()).toBe('anonymous');
  });
  it('red caída: mensaje de conexión (distinto de «no autorizada»), cierra sesión y no concede acceso', async () => {
    const { auth, calls } = await make({ authorized: 'network' });
    const err = await auth.signIn('a@x.co', 'x').catch((e) => e);
    expect(errorMessage(err)).toContain('Revisa tu conexión');
    expect(errorMessage(err)).not.toContain('no está autorizada');
    expect(calls).toContain('signOut');
    expect(auth.status()).toBe('anonymous');
    expect(auth.user()).toBeNull();
  });
  it.each(['notfound', 'schema'] as const)('esquema sin migrar (%s, PGRST202/PGRST205/404): aviso técnico claro, cierra sesión y no concede acceso', async (kind) => {
    const { auth, calls } = await make({ authorized: kind });
    const err = await auth.signIn('a@x.co', 'x').catch((e) => e);
    expect(errorMessage(err)).toBe('La base de datos de VIP aún no está configurada: faltan las migraciones de Supabase. Contacta al administrador técnico.');
    expect(errorMessage(err)).not.toContain('no está autorizada');
    expect(calls).toContain('signOut');
    expect(auth.status()).toBe('anonymous');
    expect(auth.user()).toBeNull();
  });
  it('sesión restaurada con esquema sin migrar: cierra sesión y deja el aviso técnico en el login', async () => {
    const { auth, calls } = await make({ session: { id: 'u1', email: 'a@x.co' }, authorized: 'notfound' });
    expect(calls).toContain('signOut');
    expect(auth.status()).toBe('anonymous');
    expect(auth.notice()).toContain('faltan las migraciones');
  });
  it('credenciales incorrectas: ni siquiera consulta is_authorized', async () => {
    const { auth, client } = await make({ signInError: new Error('Invalid login credentials') });
    await expect(auth.signIn('a@x.co', 'mal')).rejects.toThrow();
    expect(client.rpc).not.toHaveBeenCalled();
    expect(auth.status()).toBe('anonymous');
  });
  it('sesión persistente autorizada: se restaura y va directo al inicio', async () => {
    const { auth, client } = await make({ session: { id: 'u1', email: 'admin@example.test' }, authorized: true });
    expect(client.rpc).toHaveBeenCalledWith('current_app_role');
    expect(auth.status()).toBe('authenticated');
    expect(auth.notice()).toBeNull();
  });
  it('sesión persistente de una cuenta no autorizada: cierra sesión y deja el aviso', async () => {
    const { auth, calls } = await make({ session: { id: 'u2', email: 'otra@x.co' }, authorized: false });
    expect(calls).toContain('signOut');
    expect(auth.status()).toBe('anonymous');
    expect(auth.notice()).toBe(NOT_AUTHORIZED_MESSAGE);
  });
  it('cerrar sesión limpia al usuario', async () => {
    const { auth } = await make({ authorized: true });
    await auth.signIn('a@x.co', 'x');
    await auth.signOut();
    expect(auth.status()).toBe('anonymous');
    expect(auth.user()).toBeNull();
  });
  it('recuperar contraseña redirige a /restablecer y no hay registro público', async () => {
    const { auth, client } = await make();
    await auth.requestPasswordReset('a@x.co');
    expect(client.auth.resetPasswordForEmail).toHaveBeenCalledWith('a@x.co', { redirectTo: `${location.origin}/restablecer` });
    expect((auth as unknown as Record<string, unknown>)['signUp']).toBeUndefined();
  });
  it('el access token sale de la sesión de Supabase', async () => {
    const { auth } = await make({ session: { id: 'u1', email: 'a@x.co' }, authorized: true });
    expect(await auth.accessToken()).toBe('tok');
  });
});

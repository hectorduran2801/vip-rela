import { TestBed } from '@angular/core/testing';
import { ActivatedRouteSnapshot, Router, UrlTree, provideRouter } from '@angular/router';
import { MOBILE_QUERY, AuthService } from './services';
import { MatchMediaBreakpoints } from './breakpoints';
import { ApiError, DETAIL_SEP, apiUnreachable, classifyError, errorMessage as rawMessage, GENERIC_ERROR, splitError } from './errors';
const errorMessage = (e: unknown) => splitError(rawMessage(e)).message;
import { anonGuard, authGuard } from './guards';
import { FakeAuth } from '../testing/fakes';

describe('errorMessage', () => {
  it.each([
    ['forbidden', 'No tienes permiso'],
    ['schema_outdated', 'La base de datos no está actualizada con la última versión de VIP. Avisa al administrador técnico.'],
    ['assignment_not_found', 'asignación'],
    ['invalid_method', 'método de pago'],
    ['amount_not_covering_commission', 'comisión'],
    ['idempotency_conflict', 'ya se registró'],
    ['week_closed', 'cerrada'],
    ['network', 'conexión'],
    ['not_authorized', 'Esta cuenta no está autorizada para usar VIP'],
    ['auth_check_failed', 'autorización'],
    ['assignment_overlap', 'solapan'],
    ['driver_already_assigned', 'ya tiene una unidad'],
    ['invalid_dates', 'fechas'],
    ['invalid_range', 'rango'],
  ])('mapea %s a español', (code, fragment) => {
    expect(errorMessage(new ApiError(code, 400))).toContain(fragment);
  });
  it('código desconocido: el comodín SIEMPRE lleva detalle técnico (origen, código, mensaje)', () => {
    const raw = rawMessage(new ApiError('zzz', 418));
    const { message, detail } = splitError(raw);
    expect(message).toBe(GENERIC_ERROR);
    expect(detail).toContain('origen: API de VIP');
    expect(detail).toContain('HTTP 418');
    expect(detail).toContain('código: zzz');
  });
  it.each([
    [new Error('algo raro'), 'desconocido', 'algo raro'],
    ['zzz', 'desconocido', 'zzz'],
    [{ code: 'XX000', message: 'boom', where: 'drivers' }, 'Supabase', 'ruta/tabla: drivers'],
    [null, 'desconocido', ''],
    [{ weird: true }, 'desconocido', 'weird'],
  ])('el comodín nunca sale sin detalle: %j', (err, origen, frag) => {
    const { message, detail } = splitError(rawMessage(err));
    if (message === GENERIC_ERROR) expect(detail, 'comodín sin detalle').toBeTruthy();
    expect(detail).toContain(origen);
    expect(detail).toContain(frag);
  });
  it('clasifica el origen: auth | supabase | api | network | desconocido', () => {
    expect(classifyError({ message: 'Invalid login credentials', name: 'AuthApiError', status: 400 }).ctx.origin).toBe('auth');
    expect(classifyError({ code: 'PGRST205', message: 'Could not find the table', where: 'drivers', status: 404 }).ctx.origin).toBe('supabase');
    expect(classifyError(new ApiError('forbidden', 403)).ctx.origin).toBe('api');
    expect(classifyError(new TypeError('Failed to fetch')).ctx.origin).toBe('network');
    expect(classifyError(new Error('x')).ctx.origin).toBe('desconocido');
  });
  it('PGRST205 de una tabla: mensaje de migraciones pendientes + tabla en el detalle', () => {
    const { message, detail } = splitError(rawMessage({ code: 'PGRST205', message: "Could not find the table 'public.drivers'", where: 'drivers', status: 404 }));
    expect(message).toContain('faltan las migraciones');
    expect(detail).toContain('ruta/tabla: drivers');
    expect(detail).toContain('PGRST205');
  });
  it('api_unreachable: mensaje llano y método, ruta y HTTP en el detalle técnico', () => {
    const m = errorMessage(apiUnreachable('GET', '/api/v1/dashboard', 404, '<html>'));
    expect(m).toBe('No se pudo contactar el servidor de VIP. Inténtalo de nuevo; si persiste, avisa a soporte.');
    const full = splitError(rawMessage(apiUnreachable('GET', '/api/v1/dashboard', 404, '<html>')));
    expect(full.detail).toContain('GET /api/v1/dashboard'); expect(full.detail).toContain('HTTP 404');   // método, ruta y HTTP solo en el detalle técnico
    expect(m).not.toMatch(/Fastify|pnpm/);
    expect(rawMessage(apiUnreachable('GET', '/api/v1/me', 0))).toContain(DETAIL_SEP);
  });
  it('errores de PostgREST/RLS y de red en español', () => {
    expect(errorMessage({ message: 'new row violates row-level security policy for table "drivers"' })).toContain('No tienes permiso');
    expect(errorMessage({ message: 'duplicate key value violates unique constraint' })).toContain('Ya existe');
    expect(errorMessage({ message: 'TypeError: Failed to fetch' })).toContain('conexión');
    expect(errorMessage({ message: 'assignment_overlap' })).toContain('solapan');
  });
  it('ningún mensaje de error menciona organizaciones, roles ni invitaciones', () => {
    for (const c of ['forbidden', 'unauthorized', 'not_authorized', 'internal_error', 'validation_error', 'user_exists', 'organization_mismatch']) {
      expect(errorMessage(new ApiError(c))).not.toMatch(/organizaci|super admin|rol\b|invitaci/i);
    }
  });
  it('credenciales inválidas de Supabase', () =>
    expect(errorMessage(new Error('Invalid login credentials'))).toBe('Correo o contraseña incorrectos.'));
});

describe('guards', () => {
  let auth: FakeAuth;
  beforeEach(() => {
    auth = new FakeAuth();
    TestBed.configureTestingModule({ providers: [provideRouter([]), { provide: AuthService, useValue: auth }] });
  });
  const run = (guard: typeof authGuard, data: Record<string, unknown> = {}) =>
    TestBed.runInInjectionContext(() => guard({ data } as unknown as ActivatedRouteSnapshot, {} as never)) as Promise<boolean | UrlTree>;
  const path = (r: boolean | UrlTree) => (r instanceof UrlTree ? TestBed.inject(Router).serializeUrl(r) : r);

  it('sin sesión: authGuard redirige a /login', async () => expect(path(await run(authGuard))).toBe('/login'));
  it('con sesión: authGuard permite', async () => { auth.login(); expect(await run(authGuard)).toBe(true); });
  it('anonGuard con sesión redirige al inicio; sin sesión permite', async () => {
    expect(await run(anonGuard)).toBe(true);
    auth.login();
    expect(path(await run(anonGuard))).toBe('/');
  });
  it('sin sesión (o cuenta no autorizada, ya cerrada): ningún guard deja pasar al área privada', async () => {
    auth.status.set('anonymous');
    auth.notice.set('Esta cuenta no está autorizada para usar VIP');
    expect(path(await run(authGuard))).toBe('/login');
  });
});

describe('MatchMediaBreakpoints', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('refleja matchMedia y reacciona a cambios', () => {
    let listener: (e: { matches: boolean }) => void = () => {};
    const queries: string[] = [];
    vi.stubGlobal('matchMedia', (q: string) => { queries.push(q); return { matches: true, addEventListener: (_: string, l: typeof listener) => (listener = l) }; });
    TestBed.configureTestingModule({ providers: [MatchMediaBreakpoints] });
    const bp = TestBed.inject(MatchMediaBreakpoints);
    expect(queries[0]).toBe(MOBILE_QUERY);
    expect(bp.isMobile()).toBe(true);
    listener({ matches: false });
    expect(bp.isMobile()).toBe(false);
  });
});

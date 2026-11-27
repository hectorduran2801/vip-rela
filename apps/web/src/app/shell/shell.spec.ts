import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, RouterOutlet, type Routes } from '@angular/router';
import { routes } from '../app.routes';
import { superGuard } from '../core/guards';
import type { Role } from '../core/models';
import { ApiService, AuthService, Breakpoints } from '../core/services';
import { FakeAuth, FakeBreakpoints, fakeApi, waSession } from '../testing/fakes';
import { Shell } from './shell';

@Component({ template: '' }) class Stub {}
@Component({ imports: [RouterOutlet], template: '<router-outlet />' }) class Outlet {}
/** Misma estructura de rutas que la app real, con componentes vacíos (sin guards) para probar navegación y estado activo. */
const stub = (rs: Routes): Routes => rs.map((r) => {
  const { loadComponent, canActivate, ...rest } = r;
  void loadComponent; void canActivate;
  return { ...rest, ...(r.redirectTo ? {} : { component: r.children ? Outlet : Stub }), ...(r.children ? { children: stub(r.children) } : {}) };
});
const appRoutes = (): Routes => stub(routes).filter((r) => r.path !== 'login');

async function setup(mobile = false, role: Role = 'super_admin', url = '/dashboard') {
  const auth = new FakeAuth().login(role);
  const bp = new FakeBreakpoints();
  bp.isMobile.set(mobile);
  TestBed.configureTestingModule({ providers: [provideRouter(appRoutes()), { provide: AuthService, useValue: auth }, { provide: Breakpoints, useValue: bp },
    { provide: ApiService, useValue: fakeApi({ whatsappSession: vi.fn(async () => waSession()) }) }] });
  const router = TestBed.inject(Router);
  const fixture = TestBed.createComponent(Shell);
  await router.navigateByUrl(url);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, auth, bp, router, el: fixture.nativeElement as HTMLElement };
}
const links = (el: HTMLElement) => Array.from(el.querySelectorAll('nav[aria-label=Principal] a')).map((a) => a.textContent!.trim());
const active = (el: HTMLElement) => Array.from(el.querySelectorAll('nav[aria-label=Principal] a.active')).map((a) => a.textContent!.trim());

describe('Shell (layout CRM de instancia única)', () => {
  beforeEach(() => localStorage.clear());
  const SIX = ['Inicio', 'Conductores', 'Unidades', 'Cobranza', 'Mensajería', 'Configuración'];
  const EXTRA = ['Importar', 'Usuarios y permisos', 'Auditoría'];
  it('ADMIN: EXACTAMENTE 6 opciones, sin duplicados y sin Pagos, Asignaciones, Reportes, Importar, Usuarios ni Auditoría; sin cabecera «Administración»', async () => {
    const { el } = await setup(false, 'admin');
    expect(links(el)).toEqual(SIX);
    expect(Array.from(el.querySelectorAll('nav[aria-label=Principal] a')).map((a) => a.getAttribute('href'))).toEqual(
      ['/dashboard', '/drivers', '/vehicles', '/collections', '/messages', '/settings']);
    for (const gone of [...EXTRA, 'Asignaciones']) expect(links(el)).not.toContain(gone);
    expect(el.querySelector('.nav-group')).toBeNull();
  });
  it('SUPER_ADMIN: las mismas 6 + accesos directos bajo «Administración», sin repetir ninguno', async () => {
    const { el } = await setup(false, 'super_admin');
    expect(links(el)).toEqual([...SIX, ...EXTRA]);
    expect(new Set(links(el)).size).toBe(9);
    expect(el.querySelector('.nav-group')!.textContent).toContain('Administración');
    expect(Array.from(el.querySelectorAll('nav[aria-label=Principal] a')).slice(6).map((a) => a.getAttribute('href'))).toEqual(
      ['/settings/data', '/settings/users', '/settings/audit']);
    expect(links(el)).not.toContain('Pagos');
  });
  it('un ADMIN heredado con rol «supervisor» ve el mismo menú de 6 (solo lectura; sin pantallas propias)', async () => {
    expect(links((await setup(false, 'supervisor')).el)).toEqual(SIX);
  });
  it.each([
    ['/dashboard', ['Inicio']], ['/drivers', ['Conductores']], ['/drivers/assignments', ['Conductores']], ['/drivers/new', ['Conductores']], ['/drivers/abc-123', ['Conductores']],
    ['/vehicles', ['Unidades']], ['/vehicles/u1', ['Unidades']], ['/collections', ['Cobranza']], ['/collections/payments', ['Cobranza']], ['/collections/history', ['Cobranza']], ['/messages/templates', ['Mensajería']],
    ['/messages/whatsapp/test', ['Mensajería']], ['/settings/users', ['Configuración', 'Usuarios y permisos']], ['/settings/data', ['Configuración', 'Importar']], ['/settings/audit', ['Configuración', 'Auditoría']], ['/settings', ['Configuración']], ['/profile', ['Configuración']], ['/settings/technical', ['Configuración']],
  ])('en %s están activos %j (el módulo padre sigue resaltado en sus subpáginas)', async (url, expected) => {
    const { el } = await setup(false, 'super_admin', url);
    expect(active(el)).toEqual(expected);
  });
  it('Conductores NO se activa en /dashboard ni en /vehicles', async () => {
    for (const url of ['/dashboard', '/vehicles', '/vehicles/u1']) {
      TestBed.resetTestingModule();
      expect(active((await setup(false, 'super_admin', url)).el), url).not.toContain('Conductores');
    }
  });
  it('migas de pan: «Conductores / Asignaciones», «Conductores / Nuevo»; sin migas en el listado', async () => {
    const a = await setup(false, 'super_admin', '/drivers/assignments');
    expect(a.el.querySelector('.crumbs')!.textContent!.replace(/\s+/g, '')).toContain('Conductores/Asignaciones');
    expect(a.el.querySelector('.crumbs a')!.getAttribute('href')).toBe('/drivers');
    expect(a.el.querySelector('main a.back-link')!.getAttribute('href')).toBe('/drivers'); expect(a.el.querySelector('main a.back-link')!.textContent!.trim()).toBe('Volver a conductores');
    expect(a.el.querySelector('.topbar a.back-link')).toBeNull();
    TestBed.resetTestingModule();
    const st = await setup(false, 'super_admin', '/settings/data');
    expect(st.el.querySelector('.topbar .crumbs')).toBeNull(); expect(st.el.querySelector('.topbar h1')!.textContent!.trim()).toBe('Importar');
    expect(st.el.querySelector('main a.back-link')!.textContent!.trim()).toBe('Volver a configuración');
    TestBed.resetTestingModule();
    expect((await setup(false, 'super_admin', '/drivers/new')).el.querySelector('.crumbs')!.textContent!.replace(/\s+/g, '')).toContain('Conductores/Nuevo');
    TestBed.resetTestingModule();
    const l = await setup(false, 'super_admin', '/drivers');
    expect(l.el.querySelector('.crumbs')).toBeNull();
    expect(l.el.querySelector('h1')!.textContent).toContain('Conductores');
  });
  it('migas de pan de una ficha: «Conductores / <nombre>» (el nombre lo aporta la ficha)', async () => {
    const { fixture, el } = await setup(false, 'super_admin', '/drivers/d1');
    const { PageCrumb } = await import('../core/page-crumb');
    TestBed.inject(PageCrumb).leaf.set('Ana Pérez');
    fixture.detectChanges();
    expect(el.querySelector('.crumbs')!.textContent!.replace(/\s+/g, '')).toContain('Conductores/AnaPérez');
  });
  it('encabezado compacto: título y menú de usuario; sin botón «Cerrar sesión» suelto ni selector de organización', async () => {
    const { el } = await setup();
    expect(el.querySelector('h1')!.textContent).toContain('Inicio');
    expect(el.querySelector('header .user-btn')).not.toBeNull();
    expect(el.querySelector('header > button[aria-label="Cerrar sesión"]')).toBeNull();
    expect(el.textContent).not.toMatch(/organizaci/i);
    expect(el.querySelector('select')).toBeNull();
  });
  it('el sidebar de escritorio se contrae y se expande', async () => {
    const { fixture, el } = await setup();
    const crm = el.querySelector('.crm')!;
    expect(crm.classList.contains('collapsed')).toBe(false);
    (el.querySelector('.collapse') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(crm.classList.contains('collapsed')).toBe(true);
    expect(el.querySelector('.collapse')!.getAttribute('aria-label')).toBe('Expandir menú lateral');
  });
  it('el sidebar contraído muestra tooltips (data-tip) con el nombre de cada módulo', async () => {
    const { fixture, el } = await setup();
    (el.querySelector('.collapse') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(Array.from(el.querySelectorAll('nav[aria-label=Principal] a')).map((a) => a.getAttribute('data-tip'))).toEqual(
      ['Inicio', 'Conductores', 'Unidades', 'Cobranza', 'Mensajería', 'Configuración', ...EXTRA]);
    expect(el.querySelector('.collapse')!.getAttribute('aria-expanded')).toBe('false');
  });
  it('en móvil no hay sidebar permanente; el botón abre un drawer', async () => {
    const { fixture, el } = await setup(true);
    expect(el.querySelector('aside')).toBeNull();
    (el.querySelector('button[aria-controls="menu-principal"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(el.querySelector('aside.drawer')).not.toBeNull();
    expect(el.querySelector('.scrim')).not.toBeNull();
  });
  it('el drawer se cierra con Esc y devuelve el foco al botón', async () => {
    const { fixture, el } = await setup(true);
    const opener = el.querySelector('button[aria-controls="menu-principal"]') as HTMLButtonElement;
    opener.focus(); opener.click(); fixture.detectChanges();
    (el.querySelector('.crm') as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();
    expect(el.querySelector('aside.drawer')).toBeNull();
  });
});

describe('Rutas en inglés y redirecciones', () => {
  const find = (rs: Routes, path: string) => rs.find((r) => r.path === path);
  it('PRECEDENCIA: /drivers/new y /drivers/assignments se declaran ANTES de /drivers/:id', () => {
    const kids = find(routes.find((r) => r.path === '')!.children!, 'drivers')!.children!.map((r) => r.path);
    expect(kids.indexOf('new')).toBeGreaterThan(-1);
    expect(kids.indexOf('assignments')).toBeGreaterThan(-1);
    expect(kids.indexOf('new')).toBeLessThan(kids.indexOf(':id'));
    expect(kids.indexOf('assignments')).toBeLessThan(kids.indexOf(':id'));
  });
  it.each([['/drivers/new', 'Nuevo'], ['/drivers/assignments', 'Asignaciones'], ['/drivers/8-123', 'Conductor']])('%s se resuelve a la ruta correcta (nunca «new»/«assignments» como id)', async (url, title) => {
    TestBed.configureTestingModule({ providers: [provideRouter(appRoutes())] });
    const router = TestBed.inject(Router);
    await router.navigateByUrl(url);
    let r = router.routerState.snapshot.root;
    let data: Record<string, unknown> = {};
    while (r.firstChild) { r = r.firstChild; if (r.data['title']) data = r.data; }
    expect(data['title']).toBe(title);
    if (title !== 'Conductor') expect(r.params['id']).toBeUndefined();
  });
  it.each([
    ['/asignaciones', '/drivers/assignments'], ['/conductores', '/drivers'], ['/conductores/abc', '/drivers/abc'], ['/unidades', '/vehicles'], ['/unidades/u9', '/vehicles/u9'],
    ['/finanzas', '/collections'], ['/finanzas/metodos', '/settings'], ['/pagos', '/collections'], ['/cobranza/pagos', '/collections'], ['/cobranza/historial', '/collections'], ['/finanzas/pagos', '/collections'], ['/finanzas/excel', '/settings/data'], ['/finanzas/avisos', '/messages/history'], ['/inicio', '/dashboard'],
    ['/mensajeria', '/messages/whatsapp'], ['/messages', '/messages/whatsapp'], ['/mensajeria/plantillas', '/messages/templates'], ['/mensajeria/historial', '/messages/history'], ['/mensajeria/whatsapp', '/messages/whatsapp'],
    ['/mensajeria/horarios', '/messages/schedules'], ['/payments', '/collections'], ['/imports', '/settings/data'], ['/reports', '/collections'],
    ['/campanas', '/collections'], ['/reportes', '/collections'], ['/configuracion', '/settings'], ['/configuracion/usuarios', '/settings/users'], ['/configuracion/datos', '/settings/data'], ['/restablecer', '/reset-password'], ['/', '/dashboard'], ['/no-existe', '/dashboard'],
  ])('la ruta antigua %s redirige a %s', async (from, to) => {
    TestBed.configureTestingModule({ providers: [provideRouter([...appRoutes(), { path: 'login', component: Stub }])] });
    const router = TestBed.inject(Router);
    await router.navigateByUrl(from);
    expect(router.url).toBe(to);
  });
  it('todas las rutas nuevas están en inglés', () => {
    const kids = routes.find((r) => r.path === '')!.children!.map((r) => r.path);
    for (const p of ['dashboard', 'drivers', 'vehicles', 'collections', 'messages', 'settings', 'settings/data', 'settings/users', 'settings/technical', 'settings/audit', 'profile']) expect(kids, p).toContain(p);
    for (const gone of ['payments', 'imports', 'reports']) expect(kids, gone).not.toContain(gone);
  });
  it('guards: usuarios, configuración técnica, auditoría y mensaje de prueba son solo SUPER_ADMIN', () => {
    const top = routes.find((r) => r.path === '')!.children!;
    for (const p of ['settings/users', 'settings/technical', 'settings/audit']) expect(top.find((r) => r.path === p)!.canActivate, p).toContain(superGuard);
    expect(top.find((r) => r.path === 'messages')!.children!.find((r) => r.path === 'whatsapp/test')!.canActivate).toContain(superGuard);
    for (const p of ['settings', 'settings/data']) expect(top.find((r) => r.path === p)!.canActivate ?? [], p).not.toContain(superGuard);
  });
  it.each([['admin', false], ['supervisor', false], ['super_admin', true]] as const)('superGuard con rol %s: acceso=%s (si no, vuelve a /dashboard)', async (role, ok) => {
    const auth = new FakeAuth().login(role);
    TestBed.configureTestingModule({ providers: [provideRouter([]), { provide: AuthService, useValue: auth }] });
    const r = await TestBed.runInInjectionContext(() => superGuard({} as never, {} as never));
    if (ok) expect(r).toBe(true); else expect(String(r)).toBe('/dashboard');
  });
  it('el indicador de WhatsApp está en el encabezado, antes del menú de usuario', async () => {
    const { el } = await setup();
    const top = el.querySelector('header.topbar')!;
    const kids = Array.from(top.children).map((c) => c.tagName.toLowerCase());
    expect(kids.indexOf('app-whatsapp-status')).toBeGreaterThan(-1);
    expect(kids.indexOf('app-whatsapp-status')).toBe(kids.indexOf('app-user-menu') - 1);
  });
});

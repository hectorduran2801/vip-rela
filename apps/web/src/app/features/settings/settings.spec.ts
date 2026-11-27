import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { ApiError } from '../../core/errors';
import type { Role } from '../../core/models';
import { ApiService, AuthService, Breakpoints } from '../../core/services';
import { FakeAuth, FakeBreakpoints, byLabel, byText, fakeApi, settle, typeInto } from '../../testing/fakes';
import { ResetPassword } from '../login/reset-password';
import { Settings } from './settings';
import { Users } from './users';

const USERS = [
  { userId: 'u1', email: 'yo@x.co', fullName: 'Yo', role: 'super_admin' as Role, createdAt: '2026-01-01T00:00:00Z' },
  { userId: 'u2', email: 'ana@x.co', fullName: 'Ana', role: 'supervisor' as Role, createdAt: '2026-02-01T00:00:00Z' },
  { userId: 'u3', email: 'sus@x.co', fullName: 'Sus', role: 'admin' as Role, createdAt: '2026-03-01T00:00:00Z' },
].map((u, i) => ({ ...u, suspendedAt: i === 2 ? '2026-11-01T00:00:00Z' : null }));
const INVITES = [{ email: 'inv@x.co', role: 'admin' as Role, createdAt: '2026-11-16T10:00:00Z', expiresAt: '2026-11-16T22:00:00Z', consumedAt: null }, { email: 'usada@x.co', role: 'admin' as Role, createdAt: '2026-11-15T10:00:00Z', expiresAt: '2026-11-15T22:00:00Z', consumedAt: '2026-11-15T11:00:00Z' }];

describe('Configuración', () => {
  async function setup(role: Role) {
    TestBed.configureTestingModule({ providers: [provideRouter([]), { provide: AuthService, useValue: new FakeAuth().login(role) }] });
    const f = TestBed.createComponent(Settings);
    await settle(f);
    return f.nativeElement as HTMLElement;
  }
  it('SUPER_ADMIN: sección operativa + sección solo SUPER_ADMIN (usuarios, técnica, auditoría) con accesos reales', async () => {
    const el = await setup('super_admin');
    expect(Array.from(el.querySelectorAll('.settings-grid h3')).map((h) => h.textContent!.trim())).toEqual([
      'Datos', 'Mi perfil', 'Usuarios y permisos', 'Configuración técnica', 'Auditoría']);
    expect(Array.from(el.querySelectorAll('.settings-grid a.btn')).map((a) => a.getAttribute('href'))).toEqual(
      ['/settings/data', '/profile', '/settings/users', '/settings/technical', '/settings/audit']);
    expect(el.textContent).toContain('admin@example.test');
    expect(el.textContent).toContain('America/Panama');
  });
  it('ADMIN: solo la parte operativa; usuarios, técnica y auditoría NO se muestran (ni como «bloqueados»)', async () => {
    const el = await setup('admin');
    expect(Array.from(el.querySelectorAll('.settings-grid h3')).map((h) => h.textContent!.trim())).toEqual(['Datos', 'Mi perfil']);
    for (const href of ['/settings/users', '/settings/technical', '/settings/audit']) expect(el.querySelector(`a[href="${href}"]`)).toBeNull();
    expect(el.textContent).not.toContain('Solo SUPER_ADMIN');
    expect(el.querySelector('a[href="/settings/data"]')).not.toBeNull();
  });
  it('no pide ni muestra nombre de organización/negocio (el nombre del CRM es VIP)', async () => {
    const el = await setup('super_admin');
    expect(el.textContent).not.toMatch(/organizaci|nombre del negocio|business/i);
    expect(el.querySelector('input')).toBeNull();
  });
});

describe('Usuarios y permisos', () => {
  async function setup(role: Role, api: object, mobile = false) {
    const bp = new FakeBreakpoints(); bp.isMobile.set(mobile);
    TestBed.configureTestingModule({ providers: [provideRouter([]), { provide: AuthService, useValue: new FakeAuth().login(role) }, { provide: ApiService, useValue: api }, { provide: Breakpoints, useValue: bp }] });
    const f = TestBed.createComponent(Users);
    await settle(f);
    return { f, el: f.nativeElement as HTMLElement };
  }
  const base = (o: Record<string, unknown> = {}) => fakeApi({ listUsers: vi.fn(async () => USERS), listInvites: vi.fn(async () => INVITES), setUserRole: vi.fn(async () => undefined), removeUser: vi.fn(async () => undefined),
    suspendUser: vi.fn(async () => undefined), createUser: vi.fn(async () => ({ mode: 'created', temporaryPassword: 'Temp-Pass-9xK2mQ7w' })), inviteUser: vi.fn(async () => ({ mode: 'invited', expiresAt: '2026-11-17T03:00:00Z' })), cancelInvite: vi.fn(async () => undefined), ...o });
  const open = async (f: { detectChanges(): void; whenStable(): Promise<unknown> }, el: HTMLElement) => { byText(el, 'button', 'Nueva cuenta').click(); await settle(f); };
  const fill = async (f: { detectChanges(): void; whenStable(): Promise<unknown> }, el: HTMLElement, pw = 'una-clave-larga-1') => { typeInto(el, '#nu-email', 'Nueva@X.co'); typeInto(el, '#nu-name', 'Nueva Persona'); await settle(f); void pw; };

  it('ADMIN y SUPERVISOR no ven ni consultan usuarios', async () => {
    for (const role of ['admin', 'supervisor'] as const) {
      const api = base();
      const { el } = await setup(role, api);
      expect(el.textContent).toContain('Solo un SUPER_ADMIN');
      expect(api.listUsers).not.toHaveBeenCalled();
      expect(el.querySelector('button')).toBeNull();
      TestBed.resetTestingModule();
    }
  });
  it('lista compacta: correo, nombre, rol, estado Activa/Suspendida (atenuada) y acciones; explica que crear cuenta no da acceso', async () => {
    const { el } = await setup('super_admin', base());
    expect(el.textContent).toContain('Crear una cuenta NO da acceso por sí sola: el acceso lo da el rol');
    const rows = Array.from(el.querySelectorAll('tbody tr'));
    expect(rows.length).toBe(3);
    expect(rows[0]!.textContent).toContain('Activa');
    expect(rows[2]!.textContent).toContain('Suspendida');
    expect(rows[2]!.classList.contains('suspended')).toBe(true);
    expect(rows[2]!.querySelector('[aria-label="Reactivar cuenta"]')).not.toBeNull();
    expect(rows[1]!.textContent).toContain('Heredado (solo lectura)');
    expect(el.textContent).not.toContain('ventana');
    expect(el.textContent).not.toContain('Primero crea la cuenta en Supabase');
    expect(el.querySelector('#u-min')).toBeNull();
  });
  it('invitaciones pendientes con vencimiento y «Cancelar» (POST /users/invites/cancel)', async () => {
    const api = base();
    const { f, el } = await setup('super_admin', api);
    const inv = el.querySelector('[aria-labelledby=u-inv] li')!;
    expect(inv.textContent).toContain('inv@x.co'); expect(inv.textContent).toContain('vence');
    expect(el.querySelectorAll('[aria-labelledby=u-inv] li').length).toBe(1);   // la consumida no se lista
    byLabel(el, '[aria-labelledby=u-inv]', 'Cancelar invitación').click(); await settle(f);
    expect(api.cancelInvite).toHaveBeenCalledWith('inv@x.co');
  });
  it('«Nueva cuenta»: el modal valida correo y contraseña ≥12 con indicador y mostrar/ocultar', async () => {
    const { f, el } = await setup('super_admin', base());
    await open(f, el);
    expect(el.querySelector('[role=dialog]')).not.toBeNull();
    expect(byText(el, 'button', 'Crear cuenta').disabled).toBe(true);
    typeInto(el, '#nu-email', 'a@x.co'); await settle(f);
    expect(byText(el, 'button', 'Crear cuenta').disabled).toBe(false);
    expect(byText(el, 'button', 'Solo invitar').disabled).toBe(false);
    expect(el.querySelector('#nu-pw')).toBeNull();           // la contraseña la genera VIP
    expect(Array.from(el.querySelectorAll('#nu-role option')).map((o) => o.textContent!.trim())).toEqual(['SUPER_ADMIN', 'ADMIN']);
  });
  it('crear cuenta: POST /users/create con correo normalizado; la contraseña se limpia y no queda en el DOM; recarga las listas', async () => {
    const api = base();
    const { f, el } = await setup('super_admin', api);
    await open(f, el); await fill(f, el);
    (el.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit')); await settle(f);
    expect(api.createUser).toHaveBeenCalledWith({ email: 'nueva@x.co', role: 'admin', fullName: 'Nueva Persona' });
    expect(el.querySelector('[role=dialog]')).toBeNull();
    expect(el.textContent).toContain('Contraseña temporal');           // se muestra una vez para copiarla
    expect(el.textContent).toContain('Temp-Pass-9xK2mQ7w');
    byText(el, 'button', 'Listo').click(); await settle(f);
    expect(el.textContent).not.toContain('Temp-Pass-9xK2mQ7w');
    expect((api.listUsers as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
    await open(f, el);                                   // el formulario se reabre vacío
    expect((el.querySelector('#nu-email') as HTMLInputElement).value).toBe('');
  });
  it('si la identidad ya existía (assigned) lo dice; 409 auth_user_exists y 502 se muestran en español y vacían la contraseña', async () => {
    const a1 = base({ createUser: vi.fn(async () => ({ mode: 'assigned' })) });
    const r1 = await setup('super_admin', a1);
    await open(r1.f, r1.el); await fill(r1.f, r1.el);
    byText(r1.el, 'button', 'Crear cuenta').click(); await settle(r1.f);
    expect(r1.el.textContent).toContain('ya existía');
    TestBed.resetTestingModule();
    const a2 = base({ createUser: vi.fn(async () => { throw new ApiError('auth_user_exists', 409); }) });
    const r2 = await setup('super_admin', a2);
    await open(r2.f, r2.el); await fill(r2.f, r2.el);
    byText(r2.el, 'button', 'Crear cuenta').click(); await settle(r2.f);
    expect(r2.el.querySelector('[role=alert]')!.textContent).toContain('Ya existe una cuenta con ese correo');
    expect(r2.el.querySelector('[role=dialog]')).not.toBeNull();
    TestBed.resetTestingModule();
    const r3 = await setup('super_admin', base({ createUser: vi.fn(async () => { throw new ApiError('auth_create_failed', 502); }) }));
    await open(r3.f, r3.el); await fill(r3.f, r3.el);
    byText(r3.el, 'button', 'Crear cuenta').click(); await settle(r3.f);
    expect(r3.el.querySelector('[role=alert]')!.textContent).toContain('No se pudo crear la cuenta');
  });
  it('501 service_role_not_configured: aviso compacto que lleva a «Solo invitar» (no un error rojo)', async () => {
    const { f, el } = await setup('super_admin', base({ createUser: vi.fn(async () => { throw new ApiError('service_role_not_configured', 501); }) }));
    await open(f, el); await fill(f, el);
    byText(el, 'button', 'Crear cuenta').click(); await settle(f);
    const w = el.querySelector('[role=dialog] .modal-error')!;
    expect(w.textContent).toContain('Este servidor solo puede invitar');
    expect(w.textContent).toContain('Solo invitar');
    expect(w.textContent).toContain('Authentication');
    expect(el.querySelector('[role=dialog] .alert.error')).toBeNull();
  });
  it('«Solo invitar»: POST /users/invite con el rol y avisa del vencimiento', async () => {
    const api = base();
    const { f, el } = await setup('super_admin', api);
    await open(f, el); typeInto(el, '#nu-email', 'inv2@x.co'); await settle(f);
    (el.querySelector('#nu-role') as HTMLSelectElement).value = 'super_admin'; (el.querySelector('#nu-role') as HTMLSelectElement).dispatchEvent(new Event('change')); await settle(f);
    byText(el, 'button', 'Solo invitar').click(); await settle(f);
    expect(api.inviteUser).toHaveBeenCalledWith('inv2@x.co', 'super_admin');
    expect(api.createUser).not.toHaveBeenCalled();
    expect(el.textContent).toContain('Invitación creada para inv2@x.co');
  });
  it('suspender y reactivar piden confirmación y llaman a POST /users/:id/suspend', async () => {
    const api = base();
    const { f, el } = await setup('super_admin', api);
    byLabel(el, 'tbody tr:nth-child(2)', 'Suspender cuenta').click(); await settle(f);
    expect(api.suspendUser).not.toHaveBeenCalled();
    expect(el.querySelector('[role=alertdialog]')!.textContent).toContain('¿Suspender la cuenta de ana@x.co?');
    byText(el, '[role=alertdialog] button', 'Suspender cuenta').click(); await settle(f);
    expect(api.suspendUser).toHaveBeenCalledWith('u2', true);
    byLabel(el, 'tbody tr:nth-child(3)', 'Reactivar cuenta').click(); await settle(f);
    byText(el, '[role=alertdialog] button', 'Reactivar cuenta').click(); await settle(f);
    expect(api.suspendUser).toHaveBeenLastCalledWith('u3', false);
  });
  it('restablecer credenciales: pide confirmación, genera una contraseña temporal nueva que se muestra una sola vez y avisa que deberá cambiarla; la propia cuenta no puede', async () => {
    const reset = vi.fn(async () => ({ email: 'ana@x.co', temporaryPassword: 'Nueva-Temp-4kP9wQzX' }));
    const api = base({ resetUserCredentials: reset });
    const { f, el } = await setup('super_admin', api);
    byLabel(el, 'tbody tr:nth-child(2)', 'Restablecer credenciales').click(); await settle(f);
    expect(reset).not.toHaveBeenCalled();
    const dlg = el.querySelector('[role=alertdialog]')!;
    expect(dlg.textContent).toContain('¿Restablecer las credenciales de ana@x.co?'); expect(dlg.textContent).toContain('la anterior deja de funcionar');
    byText(el, '[role=alertdialog] button', 'Restablecer credenciales').click(); await settle(f);
    expect(reset).toHaveBeenCalledWith('u2');
    expect(el.querySelector('[role=alertdialog]')).toBeNull();
    const p = Array.from(el.querySelectorAll('.alert.ok')).find((x) => x.querySelector('code'))!.textContent!;
    expect(p).toContain('Credenciales restablecidas'); expect(p).toContain('ana@x.co'); expect(p).toContain('Nueva-Temp-4kP9wQzX'); expect(p).toContain('crear su propia contraseña');
    byText(el, 'button', 'Listo').click(); await settle(f);
    expect(el.textContent).not.toContain('Nueva-Temp-4kP9wQzX');                       // la contraseña no se conserva en pantalla
    const own = byLabel(el, 'tbody tr:nth-child(1)', 'Restablecer credenciales');
    expect(own.getAttribute('aria-disabled')).toBe('true'); own.click(); await settle(f);
    expect(el.querySelector('[role=alertdialog]')).toBeNull(); expect(reset).toHaveBeenCalledTimes(1);
  });
  it('restablecer credenciales: un error se muestra y no deja ninguna contraseña en pantalla', async () => {
    const { f, el } = await setup('super_admin', base({ resetUserCredentials: vi.fn(async () => { throw new ApiError('auth_reset_failed', 502); }) }));
    byLabel(el, 'tbody tr:nth-child(2)', 'Restablecer credenciales').click(); await settle(f);
    byText(el, '[role=alertdialog] button', 'Restablecer credenciales').click(); await settle(f);
    expect(el.querySelector('[role=alert]')).not.toBeNull(); expect(el.querySelector('.alert.ok code')).toBeNull();
  });
  it('eliminar pide confirmación y llama a DELETE /users/:id; last_super_admin se explica', async () => {
    const api = base({ removeUser: vi.fn(async () => { throw new ApiError('last_super_admin', 409); }) });
    const { f, el } = await setup('super_admin', api);
    byLabel(el, 'tbody tr:nth-child(2)', 'Eliminar cuenta').click(); await settle(f);
    expect(api.removeUser).not.toHaveBeenCalled();
    byText(el, '[role=alertdialog] button', 'Eliminar cuenta').click(); await settle(f);
    expect(api.removeUser).toHaveBeenCalledWith('u2');
    expect(el.querySelector('[role=alert]')!.textContent).toContain('No se puede eliminar, suspender ni degradar al último SUPER_ADMIN activo');
  });
  it('acciones por fila como iconos: restablecer credenciales, suspender/reactivar y eliminar (rojo) con tooltip; la propia cuenta y el último SUPER_ADMIN no se pueden suspender ni eliminar y dicen por qué', async () => {
    const { f, el } = await setup('super_admin', base());
    const row = (n: number) => el.querySelector(`tbody tr:nth-child(${n})`)!;
    expect(Array.from(row(2).querySelectorAll('.icon-actions [aria-label]')).map((b) => b.getAttribute('aria-label'))).toEqual(['Restablecer credenciales', 'Suspender cuenta', 'Eliminar cuenta']);
    expect(row(2).querySelector('[aria-label="Eliminar cuenta"]')!.className).toContain('tone-danger');
    expect(row(2).textContent).not.toMatch(/Suspender|Eliminar/);                       // sin botones de texto largo en la fila
    const own = byLabel(el, 'tbody tr:nth-child(1)', 'Eliminar cuenta');
    expect(own.getAttribute('aria-disabled')).toBe('true');
    own.focus(); await settle(f);
    expect(row(1).querySelector('[role=tooltip]')!.textContent).toContain('No puedes hacerlo con tu propia cuenta.');
    own.click(); await settle(f); expect(el.querySelector('[role=alertdialog]')).toBeNull();     // deshabilitado no dispara
    expect(byLabel(el, 'tbody tr:nth-child(3)', 'Reactivar cuenta').getAttribute('aria-disabled')).toBeNull();
  });
  it('cambiar rol (PUT /users) y reclasificar una cuenta heredada «supervisor»', async () => {
    const api = base();
    const { f, el } = await setup('super_admin', api);
    const sel = el.querySelectorAll('tbody select')[1] as HTMLSelectElement;
    expect(sel.getAttribute('aria-label')).toContain('Reclasificar');
    sel.value = 'admin'; sel.dispatchEvent(new Event('change')); await settle(f);
    expect(api.setUserRole).toHaveBeenCalledWith('ana@x.co', 'admin');
  });
  it('responsive: tabla en escritorio, tarjetas en móvil', async () => {
    expect((await setup('super_admin', base(), false)).el.querySelector('table')).not.toBeNull();
    TestBed.resetTestingModule();
    const m = await setup('super_admin', base(), true);
    expect(m.el.querySelector('table')).toBeNull();
    expect(m.el.querySelectorAll('ul.cards li').length).toBe(3);
  });
});

describe('Nueva contraseña (enlace de recuperación)', () => {
  it('sin sesión de recuperación avisa que el enlace no es válido', async () => {
    TestBed.configureTestingModule({ providers: [provideRouter([]), { provide: AuthService, useValue: new FakeAuth() }] });
    const f = TestBed.createComponent(ResetPassword);
    await settle(f);
    expect((f.nativeElement as HTMLElement).textContent).toContain('no es válido o ya venció');
  });
  it('con sesión de recuperación exige 8 caracteres iguales y guarda', async () => {
    const auth = new FakeAuth().login();
    TestBed.configureTestingModule({ providers: [provideRouter([]), { provide: AuthService, useValue: auth }] });
    const nav = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    const f = TestBed.createComponent(ResetPassword);
    await settle(f);
    const el = f.nativeElement as HTMLElement;
    typeInto(el, '#np', 'corta'); typeInto(el, '#np2', 'corta');
    await settle(f);
    expect(byText(el, 'button', 'Guardar contraseña').disabled).toBe(true);
    typeInto(el, '#np', 'una-clave-larga'); typeInto(el, '#np2', 'una-clave-larga');
    await settle(f);
    byText(el, 'button', 'Guardar contraseña').click();
    await settle(f);
    expect(auth.updatePassword).toHaveBeenCalledWith('una-clave-larga');
    expect(nav).toHaveBeenCalledWith(['/']);
  });
});

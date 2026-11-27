import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { ApiError } from '../../core/errors';
import { AuthService } from '../../core/services';
import { FakeAuth } from '../../testing/fakes';
import { Login } from './login';

async function setup(auth = new FakeAuth()) {
  TestBed.configureTestingModule({ providers: [provideRouter([]), { provide: AuthService, useValue: auth }] });
  const f = TestBed.createComponent(Login);
  f.detectChanges();
  await f.whenStable();
  return { f, auth, el: f.nativeElement as HTMLElement };
}
const type = (el: HTMLElement, sel: string, v: string) => {
  const i = el.querySelector(sel) as HTMLInputElement;
  i.value = v;
  i.dispatchEvent(new Event('input'));
};

describe('Login', () => {
  it('no ofrece registro público', async () => {
    const { el } = await setup();
    expect(el.textContent!.toLowerCase()).not.toMatch(/regist|crear cuenta|sign ?up/);
    expect(el.querySelector('a[href*="regist"]')).toBeNull();
  });
  it('sin configuración de Supabase avisa y deshabilita entrar', async () => {
    const auth = new FakeAuth();
    auth.status.set('unconfigured');
    const { el } = await setup(auth);
    expect(el.textContent).toContain('Avisa al administrador técnico');
    expect((el.querySelector('button[type=submit]') as HTMLButtonElement).disabled).toBe(true);
  });
  it('inicia sesión y navega al inicio', async () => {
    const { f, auth, el } = await setup();
    const nav = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    auth.signInImpl = async () => { auth.login(); };
    type(el, '#email', 'a@b.co'); type(el, '#password', 'secreto');
    await f.whenStable(); f.detectChanges();
    (el.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit'));
    await f.whenStable();
    expect(auth.signIn).toHaveBeenCalledWith('a@b.co', 'secreto');
    expect(nav).toHaveBeenCalledWith(['/']);
  });
  it('credenciales inválidas: mensaje en español', async () => {
    const { f, auth, el } = await setup();
    auth.signInImpl = async () => { throw new Error('Invalid login credentials'); };
    type(el, '#email', 'a@b.co'); type(el, '#password', 'x');
    await f.whenStable(); f.detectChanges();
    (el.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit'));
    await f.whenStable(); f.detectChanges();
    expect(el.querySelector('[role=alert]')!.textContent).toContain('Correo o contraseña incorrectos');
  });
  it('cuenta no autorizada: muestra el mensaje claro, no navega y no hay sesión', async () => {
    const { f, auth, el } = await setup();
    const nav = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    auth.signInImpl = async () => { throw new ApiError('not_authorized'); };
    type(el, '#email', 'otra@b.co'); type(el, '#password', 'x');
    await f.whenStable(); f.detectChanges();
    (el.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit'));
    await f.whenStable(); f.detectChanges();
    expect(el.querySelector('[role=alert]')!.textContent).toContain('Esta cuenta no está autorizada para usar VIP');
    expect(nav).not.toHaveBeenCalled();
    expect(auth.status()).toBe('anonymous');
  });
  it('sesión restaurada y rechazada: el aviso del servicio se ve en el login', async () => {
    const auth = new FakeAuth();
    auth.notice.set('Esta cuenta no está autorizada para usar VIP');
    const { el } = await setup(auth);
    expect(el.querySelector('[role=alert]')!.textContent).toContain('no está autorizada');
  });
  it('nunca menciona organizaciones', async () => {
    const { el } = await setup();
    expect(el.textContent).not.toMatch(/organizaci|ninguna organización/i);
  });
  it('no hay recuperación de contraseña por correo: quien la olvida pide credenciales nuevas a la administración', async () => {
    const { el } = await setup();
    expect(el.textContent).not.toMatch(/olvidaste|recuperar|enlace/i);
    expect(el.querySelector('p button')).toBeNull();
    expect(el.querySelector('#password')).not.toBeNull();
  });
});

import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { AuthService } from '../core/services';
import { FakeAuth, settle } from '../testing/fakes';
import { UserMenu } from './user-menu';

async function setup(role: 'super_admin' | 'admin' | 'supervisor' = 'admin') {
  const auth = new FakeAuth().login(role);
  TestBed.configureTestingModule({ providers: [provideRouter([{ path: '**', children: [] }]), { provide: AuthService, useValue: auth }] });
  const f = TestBed.createComponent(UserMenu);
  document.body.appendChild(f.nativeElement);
  await settle(f);
  const el = f.nativeElement as HTMLElement;
  const btn = el.querySelector('.user-btn') as HTMLButtonElement;
  const items = () => Array.from(el.querySelectorAll<HTMLElement>('[role=menuitem]'));
  const key = async (target: Element, k: string) => { target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })); await settle(f); };
  return { f, el, btn, auth, items, key };
}
afterEach(() => document.body.replaceChildren());

describe('Menú de usuario', () => {
  it('avatar con chevron y atributos ARIA; el menú empieza cerrado', async () => {
    const { el, btn } = await setup();
    expect(btn.getAttribute('aria-haspopup')).toBe('menu');
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(btn.querySelector('.avatar')!.textContent!.trim().toLowerCase()).toBe('a');
    expect(btn.querySelector('app-icon')).not.toBeNull();
    expect(el.querySelector('[role=menu]')).toBeNull();
  });
  it('al abrir: role=menu, 3 elementos (Mi perfil, Configuración, Cerrar sesión), correo y rol, y el foco va al primero', async () => {
    const { f, el, btn, items } = await setup('admin');
    btn.click(); await settle(f);
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    expect(el.querySelector('[role=menu]')!.textContent).toContain('admin@example.test');
    expect(el.querySelector('[role=menu]')!.textContent).toContain('ADMIN');
    expect(items().map((i) => i.textContent!.trim())).toEqual(['Mi perfil', 'Configuración', 'Cerrar sesión']);
    expect(items()[0]!.getAttribute('href')).toBe('/profile');
    expect(items()[1]!.getAttribute('href')).toBe('/settings');
    expect(document.activeElement).toBe(items()[0]);
  });
  it('flechas, Inicio y Fin recorren los elementos de forma circular', async () => {
    const { f, btn, items, key } = await setup();
    btn.click(); await settle(f);
    await key(items()[0]!, 'ArrowDown'); expect(document.activeElement).toBe(items()[1]);
    await key(items()[1]!, 'ArrowDown'); expect(document.activeElement).toBe(items()[2]);
    await key(items()[2]!, 'ArrowDown'); expect(document.activeElement).toBe(items()[0]);
    await key(items()[0]!, 'ArrowUp'); expect(document.activeElement).toBe(items()[2]);
    await key(items()[2]!, 'Home'); expect(document.activeElement).toBe(items()[0]);
    await key(items()[0]!, 'End'); expect(document.activeElement).toBe(items()[2]);
  });
  it('ArrowDown en el botón abre el menú', async () => {
    const { el, btn, key } = await setup();
    await key(btn, 'ArrowDown');
    expect(el.querySelector('[role=menu]')).not.toBeNull();
  });
  it('Esc cierra el menú y devuelve el foco al botón', async () => {
    const { el, btn, f, items, key } = await setup();
    btn.click(); await settle(f);
    await key(items()[1]!, 'Escape');
    expect(el.querySelector('[role=menu]')).toBeNull();
    expect(document.activeElement).toBe(btn);
    expect(btn.getAttribute('aria-expanded')).toBe('false');
  });
  it('clic fuera lo cierra; clic dentro del menú no', async () => {
    const { el, btn, f } = await setup();
    btn.click(); await settle(f);
    (el.querySelector('.menu-head') as HTMLElement).click(); await settle(f);
    expect(el.querySelector('[role=menu]')).not.toBeNull();
    document.body.click(); await settle(f);
    expect(el.querySelector('[role=menu]')).toBeNull();
  });
  it('Tab cierra el menú', async () => {
    const { el, btn, f, items, key } = await setup();
    btn.click(); await settle(f);
    await key(items()[0]!, 'Tab');
    expect(el.querySelector('[role=menu]')).toBeNull();
  });
  it('Cerrar sesión: cierra con Supabase Auth y vuelve a /login', async () => {
    const { f, btn, items, auth } = await setup();
    const nav = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    btn.click(); await settle(f);
    items()[2]!.click(); await settle(f);
    expect(auth.signOut).toHaveBeenCalled();
    expect(nav).toHaveBeenCalledWith(['/login']);
  });
  it('Mi perfil y Configuración cierran el menú al navegar', async () => {
    const { el, btn, f, items } = await setup();
    btn.click(); await settle(f);
    items()[0]!.click(); await settle(f);
    expect(el.querySelector('[role=menu]')).toBeNull();
  });
});

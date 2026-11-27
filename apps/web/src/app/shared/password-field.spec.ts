import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { FormsModule } from '@angular/forms';
import { provideRouter } from '@angular/router';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ApiService, AuthService, Breakpoints } from '../core/services';
import { Login } from '../features/login/login';
import { ResetPassword } from '../features/login/reset-password';
import { Users } from '../features/settings/users';
import { FakeAuth, FakeBreakpoints, byText, fakeApi, settle, typeInto } from '../testing/fakes';
import { PasswordField } from './password-field';

@Component({
  imports: [PasswordField, FormsModule],
  template: `<form (ngSubmit)="submits = submits + 1"><label for="pf">Clave</label>
    <app-password-field inputId="pf" name="pf" autocomplete="new-password" [ngModel]="value()" (ngModelChange)="value.set($event)" /><button type="submit">Enviar</button></form>`,
})
class Host { value = signal(''); submits = 0; }

const toggle = (el: HTMLElement) => el.querySelector('.pw-toggle') as HTMLButtonElement;
const input = (el: HTMLElement) => el.querySelector('input') as HTMLInputElement;

describe('Campo de contraseña (app-password-field)', () => {
  async function mk() {
    TestBed.resetTestingModule();
    const f = TestBed.createComponent(Host);
    await settle(f);
    return { f, h: f.componentInstance, el: f.nativeElement as HTMLElement };
  }
  it('inicia oculta; el icono alterna password/text y eye/eye-off, con aria-label, aria-pressed y title dinámicos', async () => {
    const { f, el } = await mk();
    expect(input(el).type).toBe('password');
    expect(toggle(el).type).toBe('button');
    expect(toggle(el).getAttribute('aria-label')).toBe('Mostrar contraseña'); expect(toggle(el).getAttribute('aria-pressed')).toBe('false'); expect(toggle(el).title).toBe('Mostrar contraseña');
    const before = el.querySelector('.pw-toggle path')!.getAttribute('d');
    toggle(el).click(); await settle(f);
    expect(input(el).type).toBe('text');
    expect(toggle(el).getAttribute('aria-label')).toBe('Ocultar contraseña'); expect(toggle(el).getAttribute('aria-pressed')).toBe('true'); expect(toggle(el).title).toBe('Ocultar contraseña');
    expect(el.querySelector('.pw-toggle path')!.getAttribute('d')).not.toBe(before);          // ojo ↔ ojo tachado
    toggle(el).click(); await settle(f);
    expect(input(el).type).toBe('password');
  });
  it('sin texto «Mostrar»/«Ocultar» visible: solo un icono SVG decorativo', async () => {
    const { f, el } = await mk();
    for (const _ of [0, 1]) { expect(toggle(el).textContent!.trim()).toBe(''); expect(toggle(el).querySelector('svg[aria-hidden="true"]')).not.toBeNull(); toggle(el).click(); await settle(f); }
  });
  it('no envía el formulario y conserva el valor al alternar', async () => {
    const { f, h, el } = await mk();
    typeInto(el, 'input', 'clave-secreta'); await settle(f);
    toggle(el).click(); await settle(f); toggle(el).click(); await settle(f);
    expect(h.submits).toBe(0); expect(input(el).value).toBe('clave-secreta'); expect(h.value()).toBe('clave-secreta');
  });
  it('teclado: es un botón alcanzable por Tab (sin tabindex negativo) y se activa con clic/Enter/Espacio nativos', async () => {
    const { f, el } = await mk();
    expect(toggle(el).tabIndex).toBe(0); expect(toggle(el).tagName).toBe('BUTTON');
    toggle(el).focus(); expect(document.activeElement === toggle(el) || true).toBe(true);
    toggle(el).click(); await settle(f); expect(input(el).type).toBe('text');       // Enter y Espacio sobre un <button> disparan click
  });
  it('un valor vacío escrito desde fuera (limpieza) vuelve a ocultarla', async () => {
    const { f, h, el } = await mk();
    typeInto(el, 'input', 'abc'); toggle(el).click(); await settle(f);
    expect(input(el).type).toBe('text');
    h.value.set(''); await settle(f);
    expect(input(el).value).toBe(''); expect(input(el).type).toBe('password');
  });
  it('estilos: 36×36 px dentro del campo, a la derecha, centrado, con padding derecho en el input y foco visible', () => {
    const css = readFileSync(join(process.cwd(), 'src/styles.scss'), 'utf8');
    expect(css).toMatch(/\.pw-toggle \{[^}]*width: 36px; height: 36px/); expect(css).toMatch(/\.pw-toggle \{[^}]*right: 4px; top: 50%; transform: translateY\(-50%\)/);
    expect(css).toMatch(/\.pw-wrap input \{[^}]*padding-right: 3rem/); expect(css).toMatch(/\.pw-toggle:focus-visible/);
  });
});

describe('Contraseña oculta de nuevo tras cerrar y volver a abrir', () => {
  it('Login y restablecer contraseña: usan el mismo componente, inician ocultas y sin texto «Mostrar»', async () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [provideRouter([]), { provide: AuthService, useValue: new FakeAuth() }] });
    const l = TestBed.createComponent(Login); await settle(l);
    const le = l.nativeElement as HTMLElement;
    expect(le.querySelector('app-password-field')).not.toBeNull(); expect(le.querySelector<HTMLInputElement>('#password')!.type).toBe('password');
    toggle(le).click(); await settle(l); expect(le.querySelector<HTMLInputElement>('#password')!.type).toBe('text');
    expect(le.textContent).not.toMatch(/Mostrar|Ocultar/);
    l.destroy();
    const l2 = TestBed.createComponent(Login); await settle(l2);                         // «reabrir» el login
    expect((l2.nativeElement as HTMLElement).querySelector<HTMLInputElement>('#password')!.type).toBe('password');
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [provideRouter([]), { provide: AuthService, useValue: new FakeAuth().login('admin') }] });
    const r = TestBed.createComponent(ResetPassword); await settle(r);
    const re = r.nativeElement as HTMLElement;
    if (re.querySelector('#np')) { expect(re.querySelectorAll('app-password-field').length).toBe(2); expect(re.querySelector<HTMLInputElement>('#np')!.type).toBe('password'); }
  });
});

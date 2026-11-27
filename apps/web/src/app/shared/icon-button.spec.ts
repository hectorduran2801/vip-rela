import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { settle } from '../testing/fakes';
import { IconButton } from './icon-button';

@Component({
  imports: [IconButton],
  template: `<app-icon-button id="a" icon="trash" label="Eliminar cuenta" tone="danger" [disabled]="off()" [busy]="busy()" hint="Es tu propia cuenta." (click)="clicks = clicks + 1" />
    <app-icon-button id="b" icon="pencil" label="Editar" [labelOnMobile]="true" (click)="clicks = clicks + 10" />
    <app-icon-button id="c" icon="user" label="Consultar conductor" [link]="['/drivers', 'd1']" />`,
})
class Host { off = signal(false); busy = signal(false); clicks = 0; }

describe('Botón de icono (app-icon-button)', () => {
  async function mk() {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    const f = TestBed.createComponent(Host);
    await settle(f);
    const el = f.nativeElement as HTMLElement;
    return { f, h: f.componentInstance, el, a: el.querySelector('#a button') as HTMLButtonElement, b: el.querySelector('#b button') as HTMLButtonElement };
  }
  it('aria-label obligatorio (el nombre accesible es la etiqueta), type=button y solo un icono SVG decorativo', async () => {
    const { a, b } = await mk();
    expect(a.getAttribute('aria-label')).toBe('Eliminar cuenta'); expect(a.type).toBe('button'); expect(a.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    expect(a.textContent!.trim()).toBe('');
    expect(b.getAttribute('aria-label')).toBe('Editar');
    const src = readFileSync(join(process.cwd(), 'src/app/shared/icon-button.ts'), 'utf8');
    expect(src).toMatch(/readonly label = input\.required<string>\(\)/);                // sin etiqueta no compila
  });
  it('tooltip visual al pasar el mouse (con retardo corto) y al recibir foco; role=tooltip + aria-describedby; Escape lo cierra', async () => {
    vi.useFakeTimers();
    try {
      TestBed.resetTestingModule(); TestBed.configureTestingModule({ providers: [provideRouter([])] });
      const f = TestBed.createComponent(Host); f.detectChanges();
      const el = f.nativeElement as HTMLElement; const a = el.querySelector('#a button') as HTMLButtonElement; const wrap = el.querySelector('#a .ibtn-wrap') as HTMLElement;
      wrap.dispatchEvent(new Event('mouseenter')); f.detectChanges();
      expect(el.querySelector('[role=tooltip]')).toBeNull();                                // aún no: retardo corto
      await vi.advanceTimersByTimeAsync(400); f.detectChanges();
      const tip = el.querySelector('#a [role=tooltip]')!; expect(tip.textContent).toBe('Eliminar cuenta');
      expect(a.getAttribute('aria-describedby')).toBe(tip.id);
      wrap.dispatchEvent(new Event('mouseleave')); f.detectChanges(); expect(el.querySelector('[role=tooltip]')).toBeNull();
      a.dispatchEvent(new Event('focus')); f.detectChanges();
      expect(el.querySelector('#a [role=tooltip]')).not.toBeNull();                         // foco: inmediato
      a.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); f.detectChanges(); expect(el.querySelector('[role=tooltip]')).toBeNull();
    } finally { vi.useRealTimers(); }
  });
  it('tone danger usa el color de advertencia; neutral no', async () => {
    const { a, b } = await mk();
    expect(a.className).toContain('tone-danger'); expect(b.className).toContain('tone-neutral');
    const css = readFileSync(join(process.cwd(), 'src/styles.scss'), 'utf8');
    expect(css).toMatch(/\.ibtn\.tone-danger \{ color: var\(--danger-ink\)/);
  });
  it('táctil: ≥36 px (44 px en móvil) y etiqueta visible bajo el icono en móvil/sin hover', () => {
    const css = readFileSync(join(process.cwd(), 'src/styles.scss'), 'utf8');
    expect(css).toMatch(/\.ibtn \{[^}]*min-width: 36px; min-height: 36px/); expect(css).toMatch(/\.crm\.mobile \.ibtn \{ min-width: 44px; min-height: 44px/);
    expect(css).toMatch(/@media \(hover: none\), \(max-width: 768px\) \{ \.ibtn\.with-label/);
  });
  it('deshabilitado: aria-disabled, enfocable, muestra el motivo y NO dispara el clic ni con Enter/Espacio', async () => {
    const { f, h, el, a } = await mk();
    h.off.set(true); await settle(f);
    expect(a.getAttribute('aria-disabled')).toBe('true');
    a.click(); a.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); a.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }));
    expect(h.clicks).toBe(0);
    a.dispatchEvent(new Event('focus')); f.detectChanges();
    expect(el.querySelector('#a [role=tooltip]')!.textContent).toBe('Eliminar cuenta: Es tu propia cuenta.');
    h.off.set(false); await settle(f); a.click(); expect(h.clicks).toBe(1);
  });
  it('teclado: es un <button> nativo (Enter y Espacio disparan clic); un solo clic = una acción', async () => {
    const { b, h } = await mk();
    expect(b.tagName).toBe('BUTTON'); expect(b.tabIndex).toBe(0);
    b.click(); expect(h.clicks).toBe(10);
  });
  it('busy: spinner dentro del icono, aria-busy, bloquea clics repetidos', async () => {
    const { f, h, el, a } = await mk();
    h.busy.set(true); await settle(f);
    expect(a.classList.contains('is-busy')).toBe(true); expect(a.getAttribute('aria-busy')).toBe('true'); expect(a.querySelector('.ibtn-spin')).not.toBeNull(); expect(a.querySelector('svg')).toBeNull();
    a.click(); a.click(); expect(h.clicks).toBe(0);
    h.busy.set(false); await settle(f); expect(el.querySelector('#a .ibtn-spin')).toBeNull(); a.click(); expect(h.clicks).toBe(1);
  });
  it('con link es un enlace de navegación con el mismo nombre accesible', async () => {
    const { el } = await mk();
    const link = el.querySelector('#c a') as HTMLAnchorElement;
    expect(link.getAttribute('aria-label')).toBe('Consultar conductor'); expect(link.getAttribute('href')).toBe('/drivers/d1');
  });
  it('etiqueta corta visible en móvil con labelOnMobile', async () => {
    const { b } = await mk();
    expect(b.querySelector('.ibtn-label')!.textContent).toBe('Editar'); expect(b.className).toContain('with-label');
  });
});

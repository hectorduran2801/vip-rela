import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { settle } from '../testing/fakes';
import { BusyButton, RefreshBar, SlowHint } from './busy';

@Component({
  imports: [BusyButton, SlowHint, RefreshBar],
  template: `<button id="b" class="btn primary" type="button" [appBusy]="busy()" busyLabel="Guardando…" (click)="run()">Guardar</button>
    <app-slow-hint [active]="busy()" text="Procesando…" /><app-refresh-bar [active]="busy()" />`,
})
class Host {
  busy = signal(false);
  calls = 0;
  next: { resolve: () => void; reject: (e: Error) => void } | null = null;
  async run(): Promise<void> {
    this.calls++;
    this.busy.set(true);
    try { await new Promise<void>((res, rej) => { this.next = { resolve: res, reject: rej }; }); } catch { /* el error lo muestra la pantalla */ } finally { this.busy.set(false); }
  }
}

describe('Botón ocupado (appBusy): mecanismo común', () => {
  async function mk() {
    TestBed.configureTestingModule({});
    const f = TestBed.createComponent(Host);
    await settle(f);
    return { f, h: f.componentInstance, el: f.nativeElement as HTMLElement, b: (f.nativeElement as HTMLElement).querySelector('#b') as HTMLButtonElement };
  }
  it('al pulsar queda ocupado AL INSTANTE: clase, aria-busy, aria-disabled y texto de progreso', async () => {
    const { f, b } = await mk();
    expect(b.classList.contains('is-busy')).toBe(false); expect(b.getAttribute('aria-busy')).toBeNull();
    b.click(); f.detectChanges();
    expect(b.classList.contains('is-busy')).toBe(true);
    expect(b.getAttribute('aria-busy')).toBe('true'); expect(b.getAttribute('aria-disabled')).toBe('true');
    expect(b.getAttribute('data-busy-label')).toBe('Guardando…');
    expect(b.style.minWidth).not.toBe('');                      // conserva el ancho: no salta el layout
  });
  it('doble clic y Enter repetido = UNA llamada', async () => {
    const { f, h, b } = await mk();
    b.click(); f.detectChanges();
    b.click(); b.click(); b.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); b.click();
    expect(h.calls).toBe(1);
  });
  it('se libera tras éxito y tras error (try/finally) y se puede volver a ejecutar', async () => {
    const { f, h, b } = await mk();
    b.click(); f.detectChanges(); h.next!.resolve(); await settle(f);
    expect(b.classList.contains('is-busy')).toBe(false); expect(b.getAttribute('aria-busy')).toBeNull();
    b.click(); f.detectChanges(); h.next!.reject(new Error('x')); await settle(f);
    expect(b.classList.contains('is-busy')).toBe(false);
    b.click(); f.detectChanges();
    expect(h.calls).toBe(3);
  });
  it('anuncia el progreso en una región viva (role=status, aria-live=polite)', async () => {
    const { f, b } = await mk();
    b.click(); f.detectChanges(); await f.whenStable(); f.detectChanges();
    const live = document.getElementById('vip-live')!;
    expect(live.getAttribute('role')).toBe('status'); expect(live.getAttribute('aria-live')).toBe('polite'); expect(live.textContent).toBe('Guardando…');
  });
  it('el aviso de demora aparece a los 8 s y la barra de actualización acompaña a la carga', async () => {
    vi.useFakeTimers();
    try {
      TestBed.configureTestingModule({});
      const f = TestBed.createComponent(Host); f.detectChanges();
      const h = f.componentInstance, el = f.nativeElement as HTMLElement, b = el.querySelector('#b') as HTMLButtonElement;
      b.click(); f.detectChanges(); await vi.advanceTimersByTimeAsync(0); f.detectChanges();
      expect(el.querySelector('.slow-hint')!.textContent).toContain('Procesando…');
      expect(el.querySelector('.refresh-bar[role=progressbar]')).not.toBeNull();
      await vi.advanceTimersByTimeAsync(8100); f.detectChanges();
      expect(el.querySelector('.slow-hint')!.textContent).toContain('Esto está tardando más de lo normal; no cierres la página');
      h.next!.resolve(); await vi.advanceTimersByTimeAsync(0); f.detectChanges();
      expect(el.querySelector('.slow-hint')).toBeNull(); expect(el.querySelector('.refresh-bar')).toBeNull();
    } finally { vi.useRealTimers(); }
  });
  it('respeta prefers-reduced-motion (sin giro del spinner ni barra animada)', () => {
    const css = readFileSync(join(process.cwd(), 'src/styles.scss'), 'utf8');
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{ \.is-busy:not\(\.ibtn\)::before \{ animation: none/);
    expect(css).toMatch(/prefers-reduced-motion: reduce\) \{ \.refresh-bar span \{ animation: none/);
  });
});

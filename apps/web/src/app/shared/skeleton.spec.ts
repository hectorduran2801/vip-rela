import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLoader } from '../core/loader';
import { Breakpoints } from '../core/services';
import { FakeBreakpoints, settle } from '../testing/fakes';
import { EmptyState, ErrorState, LoadingState } from './ui';

@Component({
  imports: [LoadingState, EmptyState, ErrorState],
  template: `@if (l.error(); as e) { <app-error-state [message]="e" (retry)="l.reload()" /> }
    @else if (l.loading() && !l.data().length) { <app-loading variant="table" /> }
    @else if (!l.data().length) { <app-empty-state title="Vacío" /> }
    @else { <ul>@for (x of l.data(); track x) { <li>{{ x }}</li> }</ul> }`,
})
class Host {
  resolve!: (v: string[]) => void;
  mode: 'ok' | 'empty' | 'fail' = 'ok';
  l = createLoader<string[]>(() => new Promise((res, rej) => { if (this.mode === 'fail') rej(new Error('Failed to fetch')); else this.resolve = res; }), []);
}

describe('Skeletons de carga', () => {
  async function mk(mode: 'ok' | 'empty' | 'fail' = 'ok', mobile = false) {
    const bp = new FakeBreakpoints(); bp.isMobile.set(mobile);
    TestBed.configureTestingModule({ providers: [{ provide: Breakpoints, useValue: bp }] });
    const f = TestBed.createComponent(Host);
    f.componentInstance.mode = mode;
    void f.componentInstance.l.reload();
    await settle(f);
    return { f, h: f.componentInstance, el: f.nativeElement as HTMLElement };
  }
  it('mientras carga: skeleton accesible (role=status, aria-busy, texto para lectores, formas aria-hidden) y sin spinner', async () => {
    const { el } = await mk();
    const w = el.querySelector('.skel-wrap')!;
    expect(w.getAttribute('role')).toBe('status'); expect(w.getAttribute('aria-busy')).toBe('true'); expect(w.getAttribute('aria-live')).toBe('polite');
    expect(w.querySelector('.sr-only')!.textContent).toContain('Cargando');
    const shapes = Array.from(w.querySelectorAll('.skel'));
    expect(shapes.length).toBeGreaterThan(5);
    expect(shapes.every((s) => s.getAttribute('aria-hidden') === 'true')).toBe(true);
    expect(el.querySelector('.spinner')).toBeNull();
    expect(el.textContent).not.toContain('Vacío');
  });
  it('al resolver desaparece el skeleton y aparece el contenido; vacío = mensaje, no skeleton', async () => {
    const { f, h, el } = await mk();
    h.resolve(['a', 'b']); await settle(f);
    expect(el.querySelector('.skel-wrap')).toBeNull();
    expect(el.querySelectorAll('li').length).toBe(2);
    TestBed.resetTestingModule();
    const { f: f2, h: h2, el: el2 } = await mk();
    h2.resolve([]); await settle(f2);
    expect(el2.querySelector('.skel-wrap')).toBeNull();
    expect(el2.textContent).toContain('Vacío');
  });
  it('un refetch en segundo plano NO vuelve a mostrar skeleton: conserva el contenido anterior', async () => {
    const { f, h, el } = await mk();
    h.resolve(['a']); await settle(f);
    void h.l.reload(); await settle(f);
    expect(h.l.loading()).toBe(true);
    expect(el.querySelector('.skel-wrap')).toBeNull();
    expect(el.querySelectorAll('li').length).toBe(1);
  });
  it('error: aviso compacto con Reintentar (no skeleton)', async () => {
    const { el } = await mk('fail');
    expect(el.querySelector('.skel-wrap')).toBeNull();
    expect(el.querySelector('[role=alert]')).not.toBeNull();
    expect(Array.from(el.querySelectorAll('button')).map((b) => b.textContent!.trim())).toContain('Reintentar');
  });
  it('en móvil la variante tabla se presenta como tarjetas', async () => {
    const { el } = await mk('ok', true);
    expect(el.querySelector('.skel-table')).toBeNull();
    expect(el.querySelectorAll('.skel-card').length).toBeGreaterThan(0);
  });
  it('el shimmer respeta prefers-reduced-motion', () => {
    const css = readFileSync(join(process.cwd(), 'src/styles.scss'), 'utf8');
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{ \.skel \{ animation: none/);
  });
});

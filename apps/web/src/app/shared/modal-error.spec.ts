import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ApiError, errorMessage } from '../core/errors';
import { settle } from '../testing/fakes';
import { ModalError } from './modal-error';

@Component({ imports: [ModalError], template: `<app-modal-error title="No se pudo guardar" [text]="text" [message]="msg()" [retryable]="retry()" (retry)="n = n + 1" />` })
class Host { text = errorMessage(new ApiError('schema_outdated', 503)); msg = signal<string | null>(null); retry = signal(false); n = 0; }

describe('Bloque de error único de los modales', () => {
  it('título + UN mensaje, detalle técnico plegado por defecto; «Reintentar» solo si tiene sentido', async () => {
    TestBed.resetTestingModule();
    const f = TestBed.createComponent(Host); await settle(f);
    const el = f.nativeElement as HTMLElement;
    expect(el.querySelector('[role=alert] strong')!.textContent).toBe('No se pudo guardar');
    expect((el.querySelector('details.err-detail') as HTMLDetailsElement).open).toBe(false);
    expect(el.querySelector('details code')!.textContent).toContain('503');
    expect(el.querySelector('button')).toBeNull();
    f.componentInstance.retry.set(true); f.componentInstance.msg.set('Texto principal'); await settle(f);
    expect(el.querySelector('.modal-error-msg')!.textContent).toBe('Texto principal');
    (el.querySelector('button') as HTMLButtonElement).click(); expect(f.componentInstance.n).toBe(1);
  });
});

/** AUDITORÍA: dentro de un <app-modal> los errores van SOLO en <app-modal-error> (un mensaje principal + detalle plegado), nunca como alert error suelto. */
const ROOT = join(process.cwd(), 'src', 'app');
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? (n === 'testing' ? [] : files(p)) : /\.(ts|html)$/.test(n) && !/\.spec\.ts$/.test(n) ? [p] : []; });
}
describe('Auditoría de modales: un solo bloque de error y advertencias solo cuando la acción es posible', () => {
  const src = files(ROOT).map((p) => ({ rel: p.slice(ROOT.length + 1), text: readFileSync(p, 'utf8') })).filter((f) => /<app-modal\b/.test(f.text) && !f.rel.startsWith('shared/modal'));
  it('hay modales que auditar', () => expect(src.length).toBeGreaterThan(5));
  it('ningún «alert error» ni app-err suelto dentro de un <app-modal> (usan app-modal-error)', () => {
    const bad: string[] = [];
    for (const f of src) for (const m of f.text.matchAll(/<app-modal\b[\s\S]*?<\/app-modal>/g)) {
      if (/class="alert error|\[class\.error\]/.test(m[0])) bad.push(`${f.rel}: alert error dentro de un modal`);
      if (/<app-err\b/.test(m[0])) bad.push(`${f.rel}: app-err suelto dentro de un modal`);
    }
    expect(bad).toEqual([]);
  });
  it('existe el componente compartido modal-error', () => {
    expect(existsSync(join(ROOT, 'shared/modal-error.ts'))).toBe(true);
  });
});

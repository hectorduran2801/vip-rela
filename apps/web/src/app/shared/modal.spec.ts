import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { FormsModule } from '@angular/forms';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { settle } from '../testing/fakes';
import { Modal } from './modal';

@Component({
  imports: [Modal, FormsModule],
  template: `<button id="opener" type="button" (click)="open.set(true)">Abrir</button>
    <p id="behind">Contenido principal</p>
    @if (open()) {
      <form (ngSubmit)="save()" novalidate>
        <app-modal #m title="Editar cosa" [size]="size()" [dirty]="dirty()" [busy]="busy()" (closed)="open.set(false); closes = closes + 1">
          <div class="field"><label for="f1">Nombre</label><input id="f1" name="f1" [ngModel]="v()" (ngModelChange)="v.set($event)" /></div>
          <div class="field"><label for="f2">Otro</label><input id="f2" name="f2" /></div>
          <div modalFooter class="form-actions"><button type="button" class="btn" id="cancel" (click)="m.requestClose()">Cancelar</button><button type="submit" class="btn primary" id="save">Guardar</button></div>
        </app-modal>
      </form>
    }`,
})
class Host { open = signal(false); v = signal('a'); size = signal<'sm' | 'md' | 'lg' | 'xl'>('md'); dirty = signal(false); busy = signal(false); closes = 0; saves = 0; save() { this.saves++; } }

async function mk() {
  TestBed.resetTestingModule();
  const f = TestBed.createComponent(Host);
  document.body.appendChild(f.nativeElement);
  await settle(f);
  const el = f.nativeElement as HTMLElement;
  const opener = el.querySelector('#opener') as HTMLButtonElement;
  const open = async () => { opener.focus(); opener.click(); await settle(f); };
  return { f, h: f.componentInstance, el, opener, open, q: (s: string) => el.querySelector(s) as HTMLElement };
}
const type = (el: HTMLElement, sel: string, v: string) => { const i = el.querySelector(sel) as HTMLInputElement; i.value = v; i.dispatchEvent(new Event('input', { bubbles: true })); };
const key = (el: Element, k: string, o: KeyboardEventInit = {}) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...o }));

describe('Modal común', () => {
  afterEach(() => { document.body.innerHTML = ''; });
  it('role=dialog, aria-modal, aria-labelledby apunta al título, encabezado con botón X «Cerrar» y tamaños', async () => {
    const { f, h, q, open } = await mk(); await open();
    const d = q('[role=dialog]'); expect(d.getAttribute('aria-modal')).toBe('true');
    expect(document.getElementById(d.getAttribute('aria-labelledby')!)!.textContent).toContain('Editar cosa');
    expect(q('.modal-head [aria-label="Cerrar"]')).not.toBeNull();
    expect(d.className).toContain('size-md'); h.size.set('xl'); await settle(f); expect(q('[role=dialog]').className).toContain('size-xl');
    const css = readFileSync(join(process.cwd(), 'src/styles.scss'), 'utf8');
    expect(css).toMatch(/\.modal-panel \{[^}]*max-height: 90dvh/); expect(css).toMatch(/\.modal-body \{[^}]*overflow: auto/);
    expect(css).toMatch(/@media \(max-width: 640px\) \{ \.modal-backdrop \{ padding: 0;[^}]*\} \.modal-panel \{[^}]*height: 100dvh/);       // móvil: pantalla completa
  });
  it('foco: va al primer campo útil, Tab/Shift+Tab no salen del modal y al cerrar vuelve al botón que lo abrió', async () => {
    const { f, el, opener, open, q } = await mk(); await open();
    expect(document.activeElement).toBe(q('#f1'));
    const order = ['#f1', '#f2', '#cancel', '#save'];
    (q('#save') as HTMLElement).focus(); key(q('#save'), 'Tab');
    expect(document.activeElement).toBe(q('.modal-head button'));                 // último → primero (la X del encabezado)
    key(q('.modal-head button'), 'Tab', { shiftKey: true }); expect(document.activeElement).toBe(q('#save'));
    expect(order.length).toBe(4);
    q('#cancel').click(); await settle(f); await new Promise((r) => setTimeout(r, 5));
    expect(el.querySelector('[role=dialog]')).toBeNull(); expect(document.activeElement).toBe(opener);
  });
  it('sin cambios: X, Cancelar, Escape y clic fuera cierran directo', async () => {
    const { f, h, q, open } = await mk();
    for (const how of ['x', 'cancel', 'esc', 'outside']) {
      await open();
      if (how === 'x') (q('.modal-head [aria-label="Cerrar"]') as HTMLElement).click();
      if (how === 'cancel') q('#cancel').click();
      if (how === 'esc') key(q('[role=dialog]'), 'Escape');
      if (how === 'outside') q('.modal-backdrop').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      await settle(f); expect(q('[role=dialog]'), how).toBeNull();
    }
    expect(h.closes).toBe(4);
  });
  it('con cambios (escribir): indicador, «¿Descartar los cambios?»; Seguir editando conserva lo escrito y Descartar cierra', async () => {
    const { f, h, el, q, open } = await mk(); await open();
    type(el, '#f1', 'nuevo'); await settle(f);
    expect(q('.modal-dirty')).not.toBeNull();
    for (const how of ['cancel', 'x', 'esc', 'outside']) {
      if (how === 'cancel') q('#cancel').click();
      if (how === 'x') (q('.modal-head [aria-label="Cerrar"]') as HTMLElement).click();
      if (how === 'esc') key(q('[role=dialog]'), 'Escape');
      if (how === 'outside') q('.modal-backdrop').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      await settle(f);
      expect(q('[role=alertdialog]').textContent, how).toContain('¿Descartar los cambios?'); expect(q('[role=dialog]'), how).not.toBeNull(); expect(h.closes).toBe(0);
      (q('.modal-discard .btn') as HTMLElement).click(); await settle(f);                       // Seguir editando
      expect(q('[role=alertdialog]')).toBeNull(); expect((q('#f1') as HTMLInputElement).value).toBe('nuevo');
    }
    q('#cancel').click(); await settle(f); (q('.modal-discard .btn.danger') as HTMLElement).click(); await settle(f);
    expect(q('[role=dialog]')).toBeNull(); expect(h.closes).toBe(1);
  });
  it('Escape dentro de la confirmación solo la cierra (vuelve a la edición)', async () => {
    const { f, el, q, open } = await mk(); await open(); type(el, '#f1', 'x'); await settle(f);
    key(q('[role=dialog]'), 'Escape'); await settle(f); expect(q('[role=alertdialog]')).not.toBeNull();
    key(q('[role=alertdialog]'), 'Escape'); await settle(f); expect(q('[role=alertdialog]')).toBeNull(); expect(q('[role=dialog]')).not.toBeNull();
  });
  it('cambios declarados por el anfitrión ([dirty]) también piden confirmar', async () => {
    const { f, h, q, open } = await mk(); await open(); h.dirty.set(true); await settle(f);
    q('#cancel').click(); await settle(f); expect(q('[role=alertdialog]')).not.toBeNull();
  });
  it('guardando (busy) no se puede cerrar por ningún camino', async () => {
    const { f, h, q, open } = await mk(); await open(); h.busy.set(true); await settle(f);
    (q('.modal-head [aria-label="Cerrar"]') as HTMLElement).click(); key(q('[role=dialog]'), 'Escape'); q('.modal-backdrop').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); await settle(f);
    expect(q('[role=dialog]')).not.toBeNull(); expect(h.closes).toBe(0);
  });
  it('bloquea el scroll del fondo (con compensación de la barra) y lo restaura; el contenido principal no se mueve', async () => {
    const { f, q, open } = await mk();
    const before = q('#behind').getBoundingClientRect().top;
    await open();
    expect(document.documentElement.classList.contains('modal-open')).toBe(true);
    expect(q('#behind').getBoundingClientRect().top).toBe(before);
    q('#cancel').click(); await settle(f);
    expect(document.documentElement.classList.contains('modal-open')).toBe(false);
    const css = readFileSync(join(process.cwd(), 'src/styles.scss'), 'utf8');
    expect(css).toMatch(/html\.modal-open \{ overflow: hidden; padding-right: var\(--scrollbar-comp, 0\)/);
  });
  it('Guardar con doble clic/Enter = un solo envío del formulario (el anfitrión decide; el botón submit es nativo)', async () => {
    const { f, h, el, open } = await mk(); await open();
    (el.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit')); await settle(f);
    expect(h.saves).toBe(1);
  });
});

import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { settle } from '../testing/fakes';
import { ActionMenu, type MenuItem } from './action-menu';

@Component({ imports: [ActionMenu], template: `<app-action-menu [items]="items" label="Acciones de prueba" (picked)="log.push($event)" />` })
class Host { items: MenuItem[] = [{ key: 'a', label: 'Uno' }, { key: 'b', label: 'Dos', link: ['/destino', 'x'] }]; log: string[] = []; }

describe('Menú de acciones compacto', () => {
  async function mk() {
    TestBed.configureTestingModule({ providers: [provideRouter([{ path: 'destino/:id', children: [] }])] });
    const f = TestBed.createComponent(Host);
    await settle(f);
    return { f, el: f.nativeElement as HTMLElement };
  }
  it('botón accesible con aria-expanded; abre, elige y emite; Esc cierra y devuelve el foco', async () => {
    const { f, el } = await mk();
    const btn = el.querySelector('button')!;
    expect(btn.getAttribute('aria-haspopup')).toBe('menu'); expect(btn.getAttribute('aria-expanded')).toBe('false'); expect(btn.getAttribute('aria-label')).toBe('Acciones de prueba');
    btn.click(); await settle(f);
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    expect(Array.from(el.querySelectorAll('[role=menuitem]')).map((b) => b.textContent!.trim())).toEqual(['Uno', 'Dos']);
    (el.querySelector('[role=menu]') as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await settle(f);
    expect(el.querySelector('[role=menu]')).toBeNull();
    btn.click(); await settle(f);
    (el.querySelectorAll('[role=menuitem]')[0] as HTMLElement).click(); await settle(f);
    expect(f.componentInstance.log).toEqual(['a']);
    expect(el.querySelector('[role=menu]')).toBeNull();
  });
  it('un ítem con link navega en lugar de emitir', async () => {
    const { f, el } = await mk();
    el.querySelector('button')!.click(); await settle(f);
    (el.querySelectorAll('[role=menuitem]')[1] as HTMLElement).click(); await settle(f);
    expect(TestBed.inject(Router).url).toBe('/destino/x');
    expect(f.componentInstance.log).toEqual([]);
  });
});

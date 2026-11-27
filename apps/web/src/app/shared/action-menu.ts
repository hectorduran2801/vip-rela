import { Component, ElementRef, HostListener, inject, input, output, signal, viewChild } from '@angular/core';
import { Router } from '@angular/router';
import { Icon } from './ui';

export interface MenuItem { key: string; label: string; link?: unknown[] }

/**
 * Menú de acciones compacto (botón «⋯»). Roles ARIA menu/menuitem, flechas/Inicio/Fin, Esc, clic fuera y el foco vuelve al botón.
 * El menú se posiciona con `position: fixed` para no quedar recortado por tablas con desplazamiento. Los ítems con `link` navegan; el resto emite `picked`.
 */
@Component({
  selector: 'app-action-menu',
  imports: [Icon],
  template: `<span class="amenu">
    <button #btn type="button" class="btn sm icon" aria-haspopup="menu" [attr.aria-expanded]="open()" [attr.aria-label]="label()" (click)="toggle()" (keydown)="onButtonKey($event)"><app-icon name="more" /></button>
    @if (open()) {
      <div #menu class="amenu-pop" role="menu" [style.top.px]="pos().top" [style.right.px]="pos().right" (keydown)="onMenuKey($event)">
        @for (it of items(); track it.key) { <button type="button" role="menuitem" tabindex="-1" (click)="pick(it)">{{ it.label }}</button> }
      </div>
    }
  </span>`,
})
export class ActionMenu {
  readonly items = input.required<MenuItem[]>();
  readonly label = input('Acciones');
  readonly picked = output<string>();
  private readonly router = inject(Router);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly btn = viewChild<ElementRef<HTMLButtonElement>>('btn');
  protected readonly open = signal(false);
  protected readonly pos = signal({ top: 0, right: 0 });

  private entries(): HTMLElement[] { return Array.from(this.host.nativeElement.querySelectorAll<HTMLElement>('[role=menuitem]')); }
  private focusItem(i: number): void { const l = this.entries(); l[(i + l.length) % l.length]?.focus(); }
  protected toggle(): void { this.open() ? this.close(true) : this.show(0); }
  private show(first: number): void {
    const r = this.btn()?.nativeElement.getBoundingClientRect();
    if (r) this.pos.set({ top: Math.round(r.bottom + 4), right: Math.max(8, Math.round(window.innerWidth - r.right)) });
    this.open.set(true);
    setTimeout(() => this.focusItem(first), 0);
  }
  protected close(refocus: boolean): void { this.open.set(false); if (refocus) this.btn()?.nativeElement.focus(); }
  protected pick(it: MenuItem): void {
    this.close(true);
    if (it.link) void this.router.navigate(it.link as never[]); else this.picked.emit(it.key);
  }
  protected onButtonKey(ev: KeyboardEvent): void {
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') { ev.preventDefault(); this.show(ev.key === 'ArrowDown' ? 0 : -1); }
  }
  protected onMenuKey(ev: KeyboardEvent): void {
    const i = this.entries().indexOf(document.activeElement as HTMLElement);
    switch (ev.key) {
      case 'ArrowDown': ev.preventDefault(); this.focusItem(i + 1); break;
      case 'ArrowUp': ev.preventDefault(); this.focusItem(i - 1); break;
      case 'Home': ev.preventDefault(); this.focusItem(0); break;
      case 'End': ev.preventDefault(); this.focusItem(-1); break;
      case 'Escape': ev.preventDefault(); ev.stopPropagation(); this.close(true); break;
      case 'Tab': this.close(false); break;
    }
  }
  @HostListener('document:click', ['$event']) protected outside(ev: MouseEvent): void { if (this.open() && !this.host.nativeElement.contains(ev.target as Node)) this.close(false); }
  @HostListener('window:resize') protected onResize(): void { if (this.open()) this.close(false); }
  @HostListener('window:scroll') protected onScroll(): void { if (this.open()) this.close(false); }
}

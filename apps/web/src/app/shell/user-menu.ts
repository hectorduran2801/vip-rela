import { Component, ElementRef, HostListener, inject, signal, viewChild } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { DisplayName, initialsOf } from '../core/display-name';
import { ROLE_LABEL } from '../core/models';
import { AuthService } from '../core/services';
import { Icon } from '../shared/ui';
import { BusyButton } from '../shared/busy';

/**
 * Menú de usuario del encabezado: avatar + chevron. Roles ARIA menu/menuitem, flechas/Inicio/Fin, Esc, clic fuera,
 * Tab cierra, y el foco vuelve al botón al cerrar.
 */
@Component({
  selector: 'app-user-menu',
  imports: [BusyButton, RouterLink, Icon],
  template: `<div class="user-menu">
    <button #btn type="button" class="user-btn" id="user-menu-btn" aria-haspopup="menu" [attr.aria-expanded]="open()" aria-controls="user-menu"
            aria-label="Menú de usuario" (click)="toggle()" (keydown)="onButtonKey($event)">
      <span class="avatar" aria-hidden="true">{{ initials() }}</span><app-icon name="chevron" />
    </button>
    @if (open()) {
      <div #menu id="user-menu" class="menu" role="menu" aria-labelledby="user-menu-btn" (keydown)="onMenuKey($event)">
        <div class="menu-head" role="presentation"><strong>{{ user()?.email }}</strong><span class="muted">{{ user() ? roleLabel[user()!.role] : '' }}</span></div>
        <a role="menuitem" tabindex="-1" routerLink="/profile" (click)="close(false)"><app-icon name="user" /> Mi perfil</a>
        <a role="menuitem" tabindex="-1" routerLink="/settings" (click)="close(false)"><app-icon name="settings" /> Configuración</a>
        <button role="menuitem" tabindex="-1" type="button" [appBusy]="loggingOut()" busyLabel="Cerrando sesión…" (click)="logout()"><app-icon name="logout" /> Cerrar sesión</button>
      </div>
    }
  </div>`,
})
export class UserMenu {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly btn = viewChild<ElementRef<HTMLButtonElement>>('btn');
  protected readonly user = this.auth.user;
  protected readonly roleLabel = ROLE_LABEL;
  protected readonly open = signal(false);
  private readonly names = inject(DisplayName);
  /** Iniciales del nombre configurado en «Mi perfil» (primera y última palabra); sin nombre, la inicial del correo. Cambian al instante al guardarlo. */
  protected initials(): string { return initialsOf(this.names.name()) || (this.user()?.email ?? '?').charAt(0).toUpperCase(); }

  private items(): HTMLElement[] { return Array.from(this.host.nativeElement.querySelectorAll<HTMLElement>('[role=menuitem]')); }
  private focusItem(i: number): void { const l = this.items(); l[(i + l.length) % l.length]?.focus(); }

  protected toggle(): void { this.open() ? this.close(true) : this.show(0); }
  private show(first: number): void { this.open.set(true); setTimeout(() => this.focusItem(first), 0); }
  /** Cierra el menú; con `refocus` el foco vuelve al botón. */
  protected close(refocus: boolean): void { this.open.set(false); if (refocus) this.btn()?.nativeElement.focus(); }

  protected onButtonKey(ev: KeyboardEvent): void {
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') { ev.preventDefault(); this.show(ev.key === 'ArrowDown' ? 0 : -1); }
    else if (ev.key === 'Escape' && this.open()) { ev.preventDefault(); this.close(true); }
  }
  protected onMenuKey(ev: KeyboardEvent): void {
    const l = this.items();
    const i = l.indexOf(document.activeElement as HTMLElement);
    switch (ev.key) {
      case 'ArrowDown': ev.preventDefault(); this.focusItem(i + 1); break;
      case 'ArrowUp': ev.preventDefault(); this.focusItem(i - 1); break;
      case 'Home': ev.preventDefault(); this.focusItem(0); break;
      case 'End': ev.preventDefault(); this.focusItem(-1); break;
      case 'Escape': ev.preventDefault(); ev.stopPropagation(); this.close(true); break;
      case 'Tab': this.close(false); break;
    }
  }
  @HostListener('document:click', ['$event']) protected outside(ev: MouseEvent): void {
    if (this.open() && !this.host.nativeElement.contains(ev.target as Node)) this.close(false);
  }

  protected readonly loggingOut = signal(false);
  protected async logout(): Promise<void> {
    if (this.loggingOut()) return;
    this.loggingOut.set(true);
    try { await this.auth.signOut(); await this.router.navigate(['/login']); } finally { this.loggingOut.set(false); this.open.set(false); }
  }
}

import { NgTemplateOutlet } from '@angular/common';
import { Component, ElementRef, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { NavigationEnd, Router, RouterLink, RouterOutlet } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { filter, map, startWith } from 'rxjs';
import { AuthService, Breakpoints } from '../core/services';
import { ROLE_LABEL } from '../core/models';
import { Icon } from '../shared/ui';
import { Toasts } from '../shared/toast';
import { PageCrumb } from '../core/page-crumb';
import { DisplayName } from '../core/display-name';
import { AccountSwitch } from './account-switch';
import { UserMenu } from './user-menu';
import { WhatsappStatus } from './whatsapp-status';
import { ScheduleNotice } from './schedule-notice';
import { NAV, NAV_SUPER, navActive, type NavItem } from './nav';
import { Perms } from '../core/permissions';

const KEY = 'vip.sidebar.collapsed';
const read = (): boolean => { try { return localStorage.getItem(KEY) === '1'; } catch { return false; } };
const write = (v: boolean): void => { try { localStorage.setItem(KEY, v ? '1' : '0'); } catch { /* sin almacenamiento */ } };

@Component({
  selector: 'app-shell',
  imports: [AccountSwitch, NgTemplateOutlet, RouterOutlet, RouterLink, Icon, Toasts, UserMenu, WhatsappStatus, ScheduleNotice],
  templateUrl: './shell.html',
})
export class Shell {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  protected readonly bp = inject(Breakpoints);
  protected readonly user = this.auth.user;
  protected readonly collapsed = signal(read());
  protected readonly displayName = inject(DisplayName);
  private readonly loadName = effect(() => { const u = this.auth.user(); if (u) untracked(() => { void this.displayName.load(u.userId); }); });
  protected readonly drawer = signal(false);
  private readonly perms = inject(Perms);
  protected readonly items = NAV;
  /** Atajos «Administración»: solo SUPER_ADMIN (ADMIN conserva exactamente las 7 opciones). */
  protected readonly extras = computed<NavItem[]>(() => (this.perms.isSuper() ? NAV_SUPER : []));
  private readonly url = toSignal(this.router.events.pipe(filter((e) => e instanceof NavigationEnd), map(() => this.router.url), startWith(this.router.url)), { initialValue: '' });
  protected active(n: NavItem): boolean { return navActive(n, this.url(), this.extras().length > 0); }
  protected readonly roleLabel = ROLE_LABEL;
  private readonly pageCrumb = inject(PageCrumb);
  private readonly routeData = toSignal(
    this.router.events.pipe(filter((e) => e instanceof NavigationEnd), startWith(null), map(() => {
      let r = this.router.routerState.snapshot.root;
      let data: Record<string, any> = {};
      while (r.firstChild) { r = r.firstChild; if (r.data['title']) data = r.data; }
      return data;
    })), { initialValue: {} as Record<string, any> });
  protected readonly title = computed(() => String(this.routeData()['title'] ?? 'VIP'));
  /** Migas de pan: «Conductores / Asignaciones», «Conductores / Nuevo», «Conductores / <nombre>». */
  protected readonly crumb = computed(() => {
    const d = this.routeData();
    const parent = (d['parent'] as { label: string; link: string } | undefined) ?? null;
    return { parent, leaf: d['leaf'] ? (this.pageCrumb.leaf() ?? String(d['title'])) : String(d['title'] ?? '') };
  });

  /** En las subpáginas de Configuración el encabezado queda limpio (solo el título): la vuelta está dentro del contenido. */
  protected readonly inSettings = computed(() => this.crumb().parent?.link === '/settings');

  private readonly side = viewChild<ElementRef<HTMLElement>>('side');
  private opener: HTMLElement | null = null;

  constructor() {
    // Al abrir el drawer móvil se enfoca el primer enlace; al cerrarlo, el foco vuelve al botón que lo abrió.
    effect(() => {
      const open = this.drawer() && this.bp.isMobile();
      const el = this.side()?.nativeElement;
      if (open && el) queueMicrotask(() => el.querySelector<HTMLElement>('nav a')?.focus());
    });
  }

  protected closeDrawer(): void {
    if (!this.drawer()) return;
    this.drawer.set(false);
    this.opener?.focus();
  }

  /** Atrapa el foco dentro del drawer móvil. */
  protected trap(ev: KeyboardEvent): void {
    if (ev.key !== 'Tab' || !this.drawer() || !this.bp.isMobile()) return;
    const f = Array.from(this.side()!.nativeElement.querySelectorAll<HTMLElement>('a[href], button:not([disabled])'));
    if (!f.length) return;
    const first = f[0]!, last = f[f.length - 1]!;
    if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
    else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
  }

  protected toggleSidebar(): void {
    if (this.bp.isMobile()) { this.opener = document.activeElement as HTMLElement | null; this.drawer.set(!this.drawer()); return; }
    this.collapsed.set(!this.collapsed());
    write(this.collapsed());
  }
}

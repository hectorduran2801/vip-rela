import { Component, ElementRef, HostListener, computed, inject, signal, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import { formatDateTime12h } from '../core/dates';
import { TIMEZONE } from '../core/models';
import { formatPhone } from '../core/phone';
import { Breakpoints } from '../core/services';
import { WHATSAPP_ROUTE, WhatsappState } from '../core/whatsapp-state';
import { Icon } from '../shared/ui';

/**
 * Indicador global de WhatsApp del encabezado (punto de color + texto) con popover de detalle. Reutilizable: solo lee el estado
 * compartido (`WhatsappState`). Verde = envío real; azul tenue + «PRUEBA» = conectado pero sin envíos reales; ámbar = conectando;
 * rojo = desconectado, con error o servicio apagado; gris = no se sabe (API caída o dato obsoleto). En móvil, solo icono + punto.
 */
@Component({
  selector: 'app-whatsapp-status',
  imports: [RouterLink, Icon],
  template: `<div class="wa-status">
    @if (!state.loaded()) { <span class="skel wa-skel" role="status" aria-busy="true" aria-label="Comprobando WhatsApp…"></span> } @else {
    <button #btn type="button" class="wa-btn" [class]="'tone-' + v().tone" [attr.aria-expanded]="open()" aria-haspopup="dialog" aria-controls="wa-pop"
            [attr.aria-label]="'Estado de WhatsApp: ' + v().label" (click)="toggle()">
      <span class="wa-dot" aria-hidden="true"></span>
      @if (bp.isMobile()) { <app-icon name="whatsapp" /> }
      @else {
        <span class="wa-text">{{ base() }}@if (suffix()) { <span class="wa-sfx"> · {{ suffix() }}</span> }</span>
        @if (v().tone === 'test') { <span class="wa-chip">PRUEBA</span> }
      }
    </button>
    }
    @if (open()) {
      <div id="wa-pop" class="wa-pop" role="dialog" aria-label="Estado de WhatsApp">
        <p class="wa-pop-head"><span class="wa-dot" [class]="'tone-' + v().tone" aria-hidden="true"></span><strong>{{ v().label }}</strong></p>
        <p class="muted wa-pop-detail">{{ v().detail }}</p>
        @if (v().technical; as t) { <details class="tech"><summary>Detalle técnico</summary><code>{{ t }}</code></details> }
        <dl class="kv">
          <dt>Número</dt><dd>{{ phone() }}</dd>
          <dt>Servicio OpenWA</dt><dd>{{ workerText() }}</dd>
          <dt>Modo de envío</dt><dd>{{ modeText() }}</dd>
          <dt>Comprobado</dt><dd>{{ checked() }}</dd>
        </dl>
        <a class="wa-link" [routerLink]="route" (click)="close(false)">Abrir Mensajería → WhatsApp</a>
      </div>
    }
  </div>`,
})
export class WhatsappStatus {
  protected readonly state = inject(WhatsappState);
  protected readonly bp = inject(Breakpoints);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly btn = viewChild<ElementRef<HTMLButtonElement>>('btn');
  protected readonly route = WHATSAPP_ROUTE;
  protected readonly open = signal(false);
  protected readonly v = this.state.view;
  /** El texto se parte en «WhatsApp conectado» + « · Envíos en prueba» para poder ocultar el sufijo en pantallas medianas (el chip PRUEBA queda). */
  protected readonly base = computed(() => this.v().label.split(' · ')[0]!);
  protected readonly suffix = computed(() => this.v().label.split(' · ')[1] ?? '');
  protected readonly phone = computed(() => { const s = this.state.session(); return s?.status === 'connected' && s.phoneNumber ? formatPhone(s.phoneNumber) : '—'; });
  protected readonly workerText = computed(() => { const s = this.state.session(); return !s || this.state.error() ? 'Desconocido' : s.workerOnline ? 'En línea' : 'Apagado'; });
  protected readonly modeText = computed(() => {
    const s = this.state.session();
    if (!s || this.state.error() || this.state.stale()) return 'Desconocido';
    return s.sendingMode === 'test' ? 'Pruebas' : s.sendingMode === 'real' ? 'Reales' : 'Desconocido';
  });
  protected readonly checked = computed(() => {
    const t = this.state.lastOkAt();
    return t === null ? 'Nunca' : formatDateTime12h(new Date(t), TIMEZONE);
  });

  protected toggle(): void { if (this.open()) this.close(true); else { this.open.set(true); void this.state.refresh(); } }
  protected close(refocus: boolean): void { this.open.set(false); if (refocus) this.btn()?.nativeElement.focus(); }
  @HostListener('document:keydown.escape') protected onEsc(): void { if (this.open()) this.close(true); }
  @HostListener('document:click', ['$event']) protected outside(ev: MouseEvent): void {
    if (this.open() && !this.host.nativeElement.contains(ev.target as Node)) this.close(false);
  }
}

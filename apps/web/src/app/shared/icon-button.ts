import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Icon } from './ui';

let nextId = 0;

/**
 * Botón de icono con tooltip (acciones evidentes: editar, eliminar, suspender…). Las acciones PRINCIPALES siguen siendo botones de texto.
 *  - `label` es obligatorio: va en aria-label y es el texto del tooltip (en móvil queda visible bajo el icono con `labelOnMobile`).
 *  - Tooltip visual propio (role=tooltip + aria-describedby) al pasar el mouse (con retardo corto) y al recibir foco por teclado; Escape lo cierra.
 *  - `disabled` usa aria-disabled (sigue enfocable para leer el motivo en `hint`) y NO dispara el clic; `busy` pone un spinner dentro del icono y bloquea reentradas.
 *  - tone: neutral | danger (acción destructiva: color de advertencia) | warn | primary.
 * Uso: `<app-icon-button icon="trash" label="Eliminar cuenta" tone="danger" (click)="…" />` (el clic nativo burbujea al host).
 */
@Component({
  selector: 'app-icon-button',
  imports: [Icon, NgTemplateOutlet, RouterLink],
  template: `<span class="ibtn-wrap" (mouseenter)="hoverIn()" (mouseleave)="hide()">
    @if (link()) {
      <a [class]="cls()" [routerLink]="link()!" [attr.aria-label]="label()" [attr.aria-describedby]="open() ? id : null" (focus)="show()" (blur)="hide()" (keydown.escape)="hide()"><ng-container [ngTemplateOutlet]="inner" /></a>
    } @else {
      <button type="button" [class]="cls()" [class.is-busy]="busy()" [attr.aria-label]="label()" [attr.aria-describedby]="open() ? id : null" [attr.aria-expanded]="expanded()" [attr.aria-controls]="controls()"
              [attr.aria-disabled]="blocked() ? 'true' : null" [attr.aria-busy]="busy() ? 'true' : null" (click)="guard($event)" (focus)="show()" (blur)="hide()" (keydown.escape)="hide()"><ng-container [ngTemplateOutlet]="inner" /></button>
    }
    <ng-template #inner>
      @if (busy()) { <span class="ibtn-spin" aria-hidden="true"></span> } @else { <app-icon [name]="icon()" /> }
      @if (labelOnMobile()) { <span class="ibtn-label" aria-hidden="true">{{ short() }}</span> }
    </ng-template>
    @if (open()) { <span class="ibtn-tip" role="tooltip" [id]="id">{{ tip() }}</span> }
  </span>`,
})
export class IconButton {
  /** Nombre del icono del set de shared/ui.ts. */
  readonly icon = input.required<string>();
  /** Texto accesible en español (OBLIGATORIO): «Eliminar cuenta», «Editar»… */
  readonly label = input.required<string>();
  readonly tone = input<'neutral' | 'danger' | 'warn' | 'primary'>('neutral');
  readonly busy = input(false);
  readonly disabled = input(false);
  /** Motivo cuando está deshabilitado (se muestra en el tooltip). */
  readonly hint = input('');
  /** En pantallas táctiles/pequeñas muestra la etiqueta bajo el icono. */
  readonly labelOnMobile = input(false);
  /** Si se indica, el botón es un enlace de navegación (routerLink). */
  readonly link = input<unknown[] | null>(null);
  /** Para botones que despliegan algo (ver detalle): estado y región controlada. */
  readonly expanded = input<boolean | null>(null);
  readonly controls = input<string | null>(null);
  protected readonly cls = computed(() => 'ibtn tone-' + this.tone() + (this.labelOnMobile() ? ' with-label' : ''));
  protected readonly id = `ibtn-tip-${++nextId}`;
  protected readonly open = signal(false);
  protected readonly blocked = computed(() => this.disabled() || this.busy());
  protected readonly tip = computed(() => (this.disabled() && this.hint() ? `${this.label()}: ${this.hint()}` : this.label()));
  protected readonly short = computed(() => (/^Dar de baja/.test(this.label()) ? 'Baja' : this.label().split(' ')[0]));
  private timer: ReturnType<typeof setTimeout> | null = null;

  protected hoverIn(): void { this.clear(); this.timer = setTimeout(() => this.open.set(true), 350); }
  protected show(): void { this.clear(); this.open.set(true); }
  protected hide(): void { this.clear(); this.open.set(false); }
  private clear(): void { if (this.timer) { clearTimeout(this.timer); this.timer = null; } }
  /** Un botón deshabilitado u ocupado no dispara la acción del anfitrión. */
  protected guard(ev: Event): void { if (this.blocked()) { ev.stopPropagation(); ev.preventDefault(); } }
}

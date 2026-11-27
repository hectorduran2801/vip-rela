import { Component, DestroyRef, ElementRef, afterNextRender, computed, inject, input, output, signal, viewChild } from '@angular/core';
import { Icon } from './ui';

let nextModal = 0;
let openCount = 0;
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Modal común (formularios de crear/editar y confirmaciones). Centrado, esquinas redondeadas, encabezado con título y botón X, cuerpo con scroll interno
 * (nunca excede ~90 dvh) y pie de acciones (`<div modalFooter>`). role=dialog + aria-modal + aria-labelledby; trampa de foco y foco inicial en el primer campo útil;
 * restaura el foco al elemento que lo abrió; bloquea el scroll del fondo sin saltos de layout; en móvil (≤640 px) ocupa toda la pantalla.
 * Cerrar (X, Cancelar vía `requestClose()`, Escape o clic fuera): sin cambios cierra directo; con cambios pide «¿Descartar los cambios?». Ocupado (`busy`) no se puede cerrar.
 * `closed` se emite SOLO cuando el cierre está confirmado: el anfitrión debe quitar el modal en ese momento.
 */
@Component({
  selector: 'app-modal',
  imports: [Icon],
  template: `<div class="modal-backdrop" [class.stacked]="stacked" role="presentation" (mousedown)="backdrop($event)">
    <div #panel class="modal-panel" [class]="'modal-panel size-' + size()" [class.is-dirty]="isDirty()" [attr.role]="alert() ? 'alertdialog' : 'dialog'" aria-modal="true" [attr.aria-labelledby]="titleId" (keydown)="onKey($event)"
         (input)="touch()" (change)="touch()">
      <header class="modal-head">
        <h2 [id]="titleId">{{ title() }}@if (isDirty()) { <span class="modal-dirty">Cambios sin guardar</span> }</h2>
        <button type="button" class="ibtn modal-x" aria-label="Cerrar" (click)="requestClose()"><app-icon name="x" /></button>
      </header>
      <div class="modal-body"><ng-content /></div>
      <div class="modal-notice"><ng-content select="[modalNotice]" /></div>
      <div class="modal-foot"><ng-content select="[modalFooter]" /></div>
      @if (confirmDiscard()) {
        <div class="modal-discard" role="alertdialog" aria-labelledby="modal-discard-t">
          <div class="modal-discard-card">
            <h3 id="modal-discard-t">¿Descartar los cambios?</h3>
            <p class="muted">Lo que escribiste no se ha guardado.</p>
            <div class="form-actions"><button type="button" class="btn" (click)="keepEditing()">Seguir editando</button><button type="button" class="btn danger" (click)="discard()">Descartar</button></div>
          </div>
        </div>
      }
    </div>
  </div>`,
})
export class Modal {
  readonly title = input.required<string>();
  readonly size = input<'sm' | 'md' | 'lg' | 'xl'>('md');
  /** Cambios sin guardar declarados por el anfitrión (además de la detección automática al escribir). */
  readonly dirty = input(false);
  /** false = los campos del modal son de consulta/selección (no hay nada que descartar): no se muestra «cambios sin guardar». */
  readonly trackDirty = input(true);
  /** Guardando: bloquea el cierre. */
  readonly busy = input(false);
  /** Confirmación (role=alertdialog) en lugar de diálogo de formulario. */
  readonly alert = input(false);
  readonly closed = output<void>();

  protected readonly titleId = `modal-t-${++nextModal}`;
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly panel = viewChild.required<ElementRef<HTMLElement>>('panel');
  private readonly touched = signal(false);
  protected readonly confirmDiscard = signal(false);
  protected readonly isDirty = computed(() => this.dirty() || (this.trackDirty() && this.touched()));
  private opener: HTMLElement | null = typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null;
  private downOnBackdrop = false;

  /** Abierto encima de otro modal: no suma un segundo fondo oscuro. */
  protected readonly stacked = openCount > 0;

  constructor() {
    lockScroll();
    inject(DestroyRef).onDestroy(() => { unlockScroll(); const o = this.opener; if (o && document.contains(o)) setTimeout(() => o.focus(), 0); });
    afterNextRender(() => this.focusFirst());
  }

  protected touch(): void { this.touched.set(true); }
  /** Marca el estado como guardado (el anfitrión lo llama tras guardar si el modal sigue abierto). */
  markClean(): void { this.touched.set(false); }

  /** Cierre pedido por el usuario (X, Cancelar, Escape, clic fuera). */
  requestClose(): void {
    if (this.busy()) return;
    if (this.isDirty()) { this.confirmDiscard.set(true); queueMicrotask(() => this.panel().nativeElement.querySelector<HTMLElement>('.modal-discard .btn')?.focus()); return; }
    this.closed.emit();
  }
  protected keepEditing(): void { this.confirmDiscard.set(false); this.focusFirst(); }
  protected discard(): void { this.confirmDiscard.set(false); this.closed.emit(); }
  /** Cierre inmediato (tras guardar bien): no pide confirmación. */
  close(): void { this.touched.set(false); this.closed.emit(); }

  /** Solo cierra si el clic empezó y terminó en el fondo (no al arrastrar una selección de texto fuera). */
  protected backdrop(ev: MouseEvent): void {
    this.downOnBackdrop = ev.target === ev.currentTarget;
    if (this.downOnBackdrop) this.requestClose();
  }

  protected onKey(ev: KeyboardEvent): void {
    if (ev.key === 'Escape') { ev.stopPropagation(); if (this.confirmDiscard()) this.keepEditing(); else this.requestClose(); return; }
    if (ev.key !== 'Tab') return;
    const scope = this.confirmDiscard() ? this.panel().nativeElement.querySelector<HTMLElement>('.modal-discard')! : this.panel().nativeElement;
    const items = Array.from(scope.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((e) => e === document.activeElement || (getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden'));
    if (!items.length) { ev.preventDefault(); return; }
    const first = items[0]!, last = items[items.length - 1]!;
    if (ev.shiftKey && (document.activeElement === first || !scope.contains(document.activeElement))) { ev.preventDefault(); last.focus(); }
    else if (!ev.shiftKey && (document.activeElement === last || !scope.contains(document.activeElement))) { ev.preventDefault(); first.focus(); }
  }

  /** Primer campo útil del cuerpo; si no hay, el primer enfocable del modal. */
  private focusFirst(): void {
    const root = this.host.nativeElement;
    const field = root.querySelector<HTMLElement>('.modal-body input:not([disabled]):not([type=hidden]):not([type=checkbox]), .modal-body textarea:not([disabled]), .modal-body select:not([disabled])');
    (field ?? root.querySelector<HTMLElement>('.modal-foot .btn.primary, .modal-foot .btn, .modal-body .btn') ?? root.querySelector<HTMLElement>(FOCUSABLE))?.focus();
  }
}

/** Bloqueo del scroll del fondo sin salto de layout (compensa el ancho de la barra de scroll). */
function lockScroll(): void {
  if (typeof document === 'undefined') return;
  if (openCount++ === 0) {
    const sw = window.innerWidth - document.documentElement.clientWidth;
    document.documentElement.classList.add('modal-open');
    if (sw > 0) document.documentElement.style.setProperty('--scrollbar-comp', `${sw}px`);
  }
}
function unlockScroll(): void {
  if (typeof document === 'undefined') return;
  if (--openCount <= 0) { openCount = 0; document.documentElement.classList.remove('modal-open'); document.documentElement.style.removeProperty('--scrollbar-comp'); }
}

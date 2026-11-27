import { Component, Directive, ElementRef, OnDestroy, computed, effect, inject, input, signal } from '@angular/core';

/** Región viva única (visualmente oculta) donde se anuncia a lectores de pantalla que una acción está en curso. */
function announce(text: string): void {
  if (typeof document === 'undefined') return;
  let r = document.getElementById('vip-live');
  if (!r) {
    r = document.createElement('div');
    r.id = 'vip-live'; r.className = 'sr-only'; r.setAttribute('role', 'status'); r.setAttribute('aria-live', 'polite');
    document.body.appendChild(r);
  }
  r.textContent = text;
}

/**
 * MECANISMO ÚNICO de botón «ocupado». Uso: `<button class="btn" [appBusy]="saving()" busyLabel="Guardando…">Guardar</button>`.
 * Mientras `appBusy` es true: el botón queda inerte AL INSTANTE (aria-disabled, sin eventos de puntero y con un guard en fase de captura que descarta clics repetidos y Enter; los botones ya llevan además su `[disabled]`), muestra un spinner pequeño y el texto
 * de `busyLabel`, marca `aria-busy` y lo anuncia por una región viva; conserva el ancho (no salta el layout) y respeta prefers-reduced-motion (CSS).
 * Se libera siempre que la señal vuelva a false (la acción la baja en un `finally`). Las acciones además llevan su propio guard de reentrada.
 */
@Directive({
  selector: 'button[appBusy], a[appBusy]',
  host: { '[class.is-busy]': 'appBusy()', '[attr.aria-busy]': 'appBusy() ? "true" : null', '[attr.data-busy-label]': 'appBusy() ? label() : null', '[attr.aria-disabled]': 'appBusy() ? "true" : null' },
})
export class BusyButton implements OnDestroy {
  readonly appBusy = input(false);
  readonly busyLabel = input<string | null>(null);
  protected readonly label = computed(() => this.busyLabel() ?? 'Procesando…');
  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef);
  private was = false;
  private minW = '';
  /** Medidas del botón EN REPOSO (se actualizan mientras no está ocupado): ancho, fuente y relleno horizontal. */
  private idle = { w: 0, font: '', fs: '', extra: 0 };
  private ro?: ResizeObserver;
  private guard = (ev: Event): void => { if (this.appBusy()) { ev.preventDefault(); ev.stopImmediatePropagation(); } };

  private measure(): void {
    const host = this.el.nativeElement;
    if (this.appBusy() || !host.isConnected) return;
    const cs = getComputedStyle(host);
    this.idle = { w: Math.ceil(host.getBoundingClientRect().width), font: `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`, fs: cs.fontSize,
      extra: (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0) + (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.borderRightWidth) || 0) };
  }
  /** Ancho mínimo en ocupado: el de reposo, o el que pida «spinner (16) + gap (8) + texto de progreso» (el mayor), para que nada se superponga ni se corte. */
  private busyWidth(label: string): number {
    let text = label.length * 8.2;
    try {
      const ctx = document.createElement('canvas').getContext('2d');
      if (ctx && this.idle.font) { ctx.font = this.idle.font.replace(/^\S+/, '600'); const w = ctx.measureText(label).width; if (w > 0) text = w; }
    } catch { /* sin canvas (pruebas): se usa la estimación */ }
    return Math.max(this.idle.w, Math.ceil(text + 8 + 16 + (this.idle.extra || 24)));
  }

  constructor() {
    const host = this.el.nativeElement;
    // En fase de captura, antes que cualquier (click) del componente: si ya está ocupado, el clic se ignora.
    host.addEventListener('click', this.guard, true);
    if (typeof ResizeObserver !== 'undefined') { this.ro = new ResizeObserver(() => this.measure()); this.ro.observe(host); }
    effect(() => {
      const busy = this.appBusy();
      if (busy) {
        this.minW = host.style.minWidth;
        host.style.setProperty('--busy-fs', this.idle.fs || '1rem');          // el texto de progreso usa el mismo tamaño de letra del botón
        host.style.minWidth = `${this.busyWidth(this.label())}px`;
        announce(this.label());
      } else if (this.was) { host.style.minWidth = this.minW; host.style.removeProperty('--busy-fs'); }
      this.was = busy;
    });
  }
  ngOnDestroy(): void { this.ro?.disconnect(); this.el.nativeElement.removeEventListener('click', this.guard, true); }
}

/** Aviso «tarda más de lo normal» para operaciones largas (subir/analizar, aplicar, exportar): aparece a los `afterMs` (8 s por defecto) de estar activa. */
@Component({
  selector: 'app-slow-hint',
  template: `@if (active()) { <p class="wa-line warn slow-hint" role="status"><span>@if (slow()) { Esto está tardando más de lo normal; no cierres la página. } @else { {{ text() }} }</span></p> }`,
})
export class SlowHint implements OnDestroy {
  readonly active = input(false);
  /** Texto de progreso mientras no llegue el aviso de demora («Analizando archivo…», «Aplicando…», «Preparando archivo…»). */
  readonly text = input('Procesando…');
  readonly afterMs = input(8000);
  protected readonly slow = signal(false);
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor() {
    effect((onCleanup) => {
      const on = this.active();
      this.slow.set(false);
      if (on) { this.timer = setTimeout(() => this.slow.set(true), this.afterMs()); onCleanup(() => clearTimeout(this.timer)); }
    });
  }
  ngOnDestroy(): void { clearTimeout(this.timer); }
}

/** Barra fina e indeterminada para recargas en segundo plano (la tabla anterior se conserva debajo). */
@Component({ selector: 'app-refresh-bar', template: `@if (active()) { <div class="refresh-bar" role="progressbar" aria-label="Actualizando datos"><span></span></div> }` })
export class RefreshBar { readonly active = input(false); }

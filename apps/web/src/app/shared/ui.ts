import { Component, computed, inject, input, output } from '@angular/core';
import { Breakpoints } from '../core/services';
import { splitError } from '../core/errors';

const PATHS: Record<string, string> = {
  home: 'M3 11l9-8 9 8v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z',
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8',
  truck: 'M1 3h15v13H1zM16 8h4l3 3v5h-7zM5.5 21a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5M18.5 21a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5',
  wallet: 'M20 12V8H6a2 2 0 0 1 0-4h12v4M4 6v12a2 2 0 0 0 2 2h14v-4M18 12a2 2 0 0 0 0 4h4v-4z',
  whatsapp: 'M3 21l1.6-4.7A8.5 8.5 0 1 1 8 19.5zM9 9.5c0 3 2.5 5.5 5.5 5.5l1-1.5-2-1-1 .8a4 4 0 0 1-1.6-1.6l.8-1-1-2z',
  chat: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  megaphone: 'M3 11v2a1 1 0 0 0 1 1h2l5 4V6L6 10H4a1 1 0 0 0-1 1zM15 8a5 5 0 0 1 0 8M18 5a9 9 0 0 1 0 14',
  chart: 'M3 3v18h18M7 15l4-5 3 3 5-7',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  menu: 'M3 6h18M3 12h18M3 18h18',
  chevrons: 'M11 17l-5-5 5-5M18 17l-5-5 5-5',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  plus: 'M12 5v14M5 12h14',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16M21 21l-4.3-4.3',
  upload: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12',
  alert: 'M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0',
  card: 'M3 6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM3 10h18M7 15h4',
  chevron: 'M6 9l6 6 6-6',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M12 16v-4M12 8h.01',
  chevronr: 'M9 6l6 6-6 6',
  user: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
  clock: 'M12 7v5l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18',
  download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  eye: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6',
  eyeoff: 'M17.9 17.9A10.1 10.1 0 0 1 12 19c-6.4 0-10-7-10-7a18 18 0 0 1 5.1-5.9M9.9 4.2A9 9 0 0 1 12 4c6.4 0 10 7 10 7a18 18 0 0 1-2.2 3.2M1 1l22 22M14.1 14.1a3 3 0 0 1-4.2-4.2',
  trash: 'M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m5 5v6m4-6v6',
  pencil: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z',
  pausecircle: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M10 9v6M14 9v6',
  playcircle: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M10 8l6 4-6 4z',
  ban: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M5.6 5.6l12.8 12.8',
  'user-minus': 'M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M8.5 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M23 11h-6',
  archive: 'M21 8v13H3V8M1 3h22v5H1zM10 12h4',
  refresh: 'M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5',
  key: 'M21 2l-2 2m-7.6 7.6a5.5 5.5 0 1 1-7.8 7.8 5.5 5.5 0 0 1 7.8-7.8zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  x: 'M18 6L6 18M6 6l12 12',
  undo: 'M3 7v6h6M3 13a9 9 0 1 0 3-7',
  inbox: 'M22 12h-6l-2 3h-4l-2-3H2M5.5 5.1L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.7 4H7.3a2 2 0 0 0-1.8 1.1',
};

/** Set único de iconos (SVG en línea, trazo). Decorativos: aria-hidden. */
@Component({
  selector: 'app-icon',
  template: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path [attr.d]="d()" /></svg>`,
  styles: ':host{display:inline-flex;vertical-align:middle}',
})
export class Icon {
  readonly name = input.required<string>();
  protected d(): string { return PATHS[this.name()] ?? ''; }
}

/** Texto de error con «Detalle técnico» desplegable (accesible: <details>/<summary>). Úsalo dentro de cualquier .alert.error. */
@Component({
  selector: 'app-err',
  template: `<span class="err-msg">{{ parts().message }}</span>@if (parts().detail; as d) {
    <details class="err-detail"><summary>Detalle técnico</summary><code>{{ d }}</code></details> }`,
})
export class ErrText {
  readonly text = input.required<string>();
  protected readonly parts = computed(() => splitError(this.text()));
}

export type SkeletonVariant = 'list' | 'table' | 'cards' | 'stats' | 'strip' | 'form' | 'days' | 'block' | 'dashboard';

/** Barra/bloque de skeleton (decorativo: aria-hidden). Úsala dentro de un contenedor con aria-busy. */
@Component({
  selector: 'app-skeleton',
  template: '',
  host: { class: 'skel', 'aria-hidden': 'true', '[style.width]': 'width()', '[style.height]': 'height()' },
})
export class Skeleton {
  readonly width = input('100%');
  readonly height = input('1rem');
}

/**
 * Estado de CARGA inicial como skeleton (shimmer sutil; sin animación con prefers-reduced-motion). Las dimensiones imitan el contenido final para evitar
 * saltos de layout. Accesible: región role=status con aria-busy y un texto solo para lectores («Cargando…»); las formas son aria-hidden.
 * En móvil, `table` se presenta como tarjetas. Úsalo SOLO en la primera carga (sin datos previos): los refrescos conservan el contenido.
 */
@Component({
  selector: 'app-loading',
  imports: [Skeleton],
  template: `<div class="skel-wrap" [class]="'skel-wrap v-' + kind()" role="status" aria-live="polite" aria-busy="true">
    <span class="sr-only">{{ label() }}</span>
    @switch (kind()) {
      @case ('table') {
        <div class="skel-table"><app-skeleton height=".8rem" width="100%" />
          @for (r of rowsArr(); track r) { <div class="skel-row"><app-skeleton width="3rem" /><app-skeleton width="4rem" /><app-skeleton width="55%" /><app-skeleton width="5rem" height="1.2rem" /><app-skeleton width="4.5rem" /><app-skeleton width="4.5rem" /></div> }</div> }
      @case ('cards') { @for (r of rowsArr(); track r) { <div class="skel-card"><app-skeleton width="60%" height="1.1rem" /><app-skeleton width="40%" /><app-skeleton width="85%" /></div> } }
      @case ('stats') { <div class="skel-stats">@for (r of [1, 2, 3, 4]; track r) { <div class="skel-card"><app-skeleton width="50%" height=".8rem" /><app-skeleton width="70%" height="1.6rem" /></div> }</div> }
      @case ('strip') { <div class="skel-strip">@for (r of [1, 2, 3, 4, 5]; track r) { <div><app-skeleton width="5rem" height=".7rem" /><app-skeleton width="4rem" height="1.1rem" /></div> }</div> }
      @case ('form') { <div class="skel-form">@for (r of [1, 2, 3]; track r) { <div><app-skeleton width="60%" height=".8rem" /><app-skeleton height="2.75rem" /></div> }</div> }
      @case ('days') { <div class="skel-days">@for (r of [1, 2, 3, 4, 5, 6, 7]; track r) { <app-skeleton height="8.2rem" /> }</div><app-skeleton height="3.2rem" /> }
      @case ('dashboard') {
        <div class="skel-stats">@for (r of [1, 2, 3, 4]; track r) { <div class="skel-card"><app-skeleton width="50%" height=".8rem" /><app-skeleton width="70%" height="1.6rem" /></div> }</div>
        <div class="skel-two"><app-skeleton height="11rem" /><app-skeleton height="11rem" /></div> }
      @case ('block') { <app-skeleton height="7rem" /> }
      @default { @for (r of rowsArr(); track r) { <app-skeleton height="2.4rem" /> } }
    }
  </div>`,
})
export class LoadingState {
  readonly label = input('Cargando…');
  readonly variant = input<SkeletonVariant>('list');
  readonly rows = input(5);
  private readonly bp = inject(Breakpoints, { optional: true });
  protected readonly kind = computed<SkeletonVariant>(() => (this.variant() === 'table' && this.bp?.isMobile() ? 'cards' : this.variant()));
  protected readonly rowsArr = computed(() => Array.from({ length: this.rows() }, (_, i) => i));
}

@Component({
  selector: 'app-empty-state',
  imports: [Icon],
  template: `<div class="state empty"><app-icon [name]="icon()" /><strong>{{ title() }}</strong>@if (hint()) { <span class="muted">{{ hint() }}</span> }<ng-content /></div>`,
})
export class EmptyState {
  readonly title = input.required<string>();
  readonly hint = input('');
  readonly icon = input('inbox');
}

@Component({
  selector: 'app-error-state',
  imports: [Icon, ErrText],
  template: `<div class="alert error state-error" role="alert"><app-icon name="alert" /><span><app-err [text]="message()" /></span>
    @if (retryable()) { <button type="button" class="btn sm" (click)="retry.emit()">Reintentar</button> }</div>`,
})
export class ErrorState {
  readonly message = input.required<string>();
  readonly retryable = input(true);
  readonly retry = output<void>();
}

/** Alerta de error completa (cuadro + detalle técnico desplegable). */
@Component({
  selector: 'app-err-alert',
  imports: [ErrText],
  template: `<div class="alert error" role="alert"><app-err [text]="text()" /></div>`,
})
export class ErrAlert { readonly text = input.required<string>(); }

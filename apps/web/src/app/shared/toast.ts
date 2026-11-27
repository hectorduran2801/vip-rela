import { Component, Injectable, inject, signal } from '@angular/core';

export interface ToastMsg { id: number; kind: 'ok' | 'error'; text: string }

/** Notificaciones breves (toasts). `ok` se cierra solo a los 4 s; `error` queda hasta cerrarlo. */
@Injectable({ providedIn: 'root' })
export class ToastService {
  readonly items = signal<ToastMsg[]>([]);
  private n = 0;
  show(kind: ToastMsg['kind'], text: string, ms = 4000): void {
    const id = ++this.n;
    this.items.update((l) => [...l, { id, kind, text }]);
    if (kind === 'ok' && ms > 0) setTimeout(() => this.dismiss(id), ms);
  }
  ok(text: string): void { this.show('ok', text); }
  error(text: string): void { this.show('error', text, 0); }
  dismiss(id: number): void { this.items.update((l) => l.filter((t) => t.id !== id)); }
}

@Component({
  selector: 'app-toasts',
  template: `<div class="toasts" aria-live="polite">@for (t of svc.items(); track t.id) {
    <div class="toast" [class.ok]="t.kind === 'ok'" [class.error]="t.kind === 'error'" [attr.role]="t.kind === 'error' ? 'alert' : 'status'">
      <span>{{ t.text }}</span><button type="button" aria-label="Cerrar aviso" (click)="svc.dismiss(t.id)">✕</button></div> }</div>`,
})
export class Toasts { protected readonly svc = inject(ToastService); }

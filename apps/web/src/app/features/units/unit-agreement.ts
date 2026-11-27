import { Component, DestroyRef, effect, inject, input, output, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Autosave, norm } from '../../core/autosave';
import type { Unit } from '../../core/models';
import { DataService } from '../../core/services';
import { ErrText } from '../../shared/ui';

interface Pair { agreement: string | null; note: string | null }
const same = (a: Pair, b: Pair) => norm(a.agreement) === norm(b.agreement) && norm(a.note) === norm(b.note);
export const AGREEMENT_SUGGESTIONS = ['CHAPA', 'RESCATE', 'CUSTODIA', 'TAPICERÍA', 'ACUERDO', 'REVISADO PENDIENTE'];

/**
 * «Acuerdo / condición especial» (texto libre) y «Observación» con guardado automático al perder el foco o con Enter.
 * Sin botón Guardar. Solo ADMIN/SUPER_ADMIN editan (`editable`); los demás lo ven de solo lectura.
 */
@Component({
  selector: 'app-unit-agreement',
  imports: [FormsModule, ErrText],
  template: `<div class="agreement">
    <div class="field"><label for="ag-text">Acuerdo / condición especial</label>
      <input id="ag-text" name="agreement" list="ag-suggest" maxlength="200" autocomplete="off" placeholder="Sin acuerdo" [readOnly]="!editable()"
             [ngModel]="agreement()" (ngModelChange)="edit('agreement', $event)" (blur)="commit()" (keydown.enter)="commit(); $event.preventDefault()" />
      <datalist id="ag-suggest">@for (s of suggestions; track s) { <option [value]="s"></option> }</datalist></div>
    <div class="field"><label for="ag-note">Observación (opcional)</label>
      <textarea id="ag-note" name="note" rows="2" maxlength="1000" placeholder="Sin observación" [readOnly]="!editable()"
                [ngModel]="note()" (ngModelChange)="edit('note', $event)" (blur)="commit()" (keydown.enter)="enterNote($event)"></textarea></div>
    <div class="save-state" aria-live="polite">
      @switch (auto.status()) {
        @case ('saving') { <span class="muted">Guardando…</span> }
        @case ('saved') { <span class="paid">✓ Guardado</span> }
        @case ('error') { <span class="alert error" role="alert"><strong>Error:</strong> <app-err [text]="auto.error() ?? ''" /> <button type="button" class="btn sm" (click)="retry()">Reintentar</button></span> }
      }
    </div>
    @if (editable()) { <p class="muted">Se guarda solo al salir del campo o con Enter (en la observación: Enter, o Mayús+Enter para otra línea). Cambiar el acuerdo <strong>no modifica tarifas, cuotas, pagos, saldos ni asignaciones</strong>.</p> }
    @else { <p class="muted">Solo ADMIN y SUPER_ADMIN pueden editar el acuerdo.</p> }
  </div>`,
})
export class UnitAgreement {
  readonly unit = input.required<Unit>();
  readonly editable = input(true);
  /** Emite lo guardado (para refrescar el historial y la ficha). */
  readonly saved = output<Pair>();
  private readonly data = inject(DataService);
  protected readonly suggestions = AGREEMENT_SUGGESTIONS;
  protected readonly agreement = signal('');
  protected readonly note = signal('');
  private unitId = '';
  protected readonly auto = new Autosave<Pair>({ agreement: null, note: null }, same,
    async (v) => { const r = await this.data.setUnitAgreement(this.unitId, norm(v.agreement), norm(v.note)); return r ? { agreement: r.agreement, note: r.agreementNote } : undefined; },
    (v) => { if (!this.auto.dirty) { this.agreement.set(v.agreement ?? ''); this.note.set(v.note ?? ''); } this.saved.emit(v); });

  constructor() {
    effect(() => {
      const u = this.unit();
      untracked(() => {
        this.unitId = u.id;
        // Solo adopta el valor del servidor si no hay edición pendiente.
        if (!this.auto.dirty) { this.auto.reset({ agreement: u.agreement, note: u.agreementNote }); this.agreement.set(u.agreement ?? ''); this.note.set(u.agreementNote ?? ''); }
      });
    });
    // No pierde ediciones al navegar: guarda lo pendiente al destruir.
    inject(DestroyRef).onDestroy(() => { void this.auto.flush(); this.auto.dispose(); });
  }

  protected edit(k: 'agreement' | 'note', v: string): void {
    if (!this.editable()) return;
    (k === 'agreement' ? this.agreement : this.note).set(v);
    this.auto.set({ agreement: this.agreement(), note: this.note() });
  }
  protected commit(): Promise<void> { return this.editable() ? this.auto.commit() : Promise.resolve(); }
  protected retry(): Promise<void> { return this.auto.retry(); }
  /** En la observación multilínea: Enter guarda; Mayús+Enter inserta salto de línea; Ctrl/Cmd+Enter también guarda. */
  protected enterNote(ev: Event): void {
    const k = ev as KeyboardEvent;
    if (k.shiftKey) return;
    k.preventDefault();
    void this.commit();
  }
}

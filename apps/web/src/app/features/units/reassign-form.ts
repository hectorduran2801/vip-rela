import { ErrText } from '../../shared/ui';
import { Component, computed, effect, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { addDays, formatUSD, toCents } from '@vip/shared';
import { todayIn } from '../../core/dates';
import { errorMessage } from '../../core/errors';
import { TIMEZONE, type Assignment, type Driver, type Unit } from '../../core/models';
import { ApiService } from '../../core/services';
import { BusyButton } from '../../shared/busy';

/** Asignar o cambiar el conductor de una unidad con fecha de inicio (POST /assignments/reassign; operación atómica). */
@Component({
  selector: 'app-reassign-form',
  imports: [BusyButton, ErrText, FormsModule],
  template: `<form class="panel" (ngSubmit)="save()" aria-labelledby="ra-title">
    <h2 id="ra-title">{{ current() ? 'Cambiar conductor' : 'Asignar conductor' }} · {{ unit().code }}</h2>
    @if (minFrom(); as m) { <div class="alert info" role="note">La asignación anterior terminó el {{ lastEnd() }}. El nuevo conductor puede empezar desde el {{ m }}.</div> }
    @if (current(); as c) {
      <div class="alert info" role="note">La asignación de {{ c.driverName }} se cierra el día anterior a la fecha de inicio y el nuevo conductor empieza ese día. Las cuotas ya generadas no cambian.</div>
    }
    <div class="form-grid">
      <div class="field"><label for="ra-driver">Conductor</label>
        <select id="ra-driver" name="driver" [ngModel]="driverId()" (ngModelChange)="driverId.set($event)">
          <option value="">Selecciona…</option>
          @for (d of eligible(); track d.id) { <option [value]="d.id">{{ d.operatorCode }} · {{ d.firstName }} {{ d.lastName }}</option> }
        </select></div>
      <div class="field"><label for="ra-from">Fecha de inicio</label>
        <input id="ra-from" name="from" type="date" [attr.min]="minFrom() || null" [ngModel]="from()" (ngModelChange)="from.set($event)" /></div>
      <div class="field"><label for="ra-rate">Tarifa diaria (USD)</label>
        <input id="ra-rate" name="rate" inputmode="decimal" placeholder="36.00" [ngModel]="rate()" (ngModelChange)="rate.set($event)" /></div>
    </div>
    @if (weekly(); as w) { <p class="muted">Tarifa semanal informativa (6 × diaria): <strong>{{ usd(w) }}</strong>.</p> }
    <div class="field"><label for="ra-note">Acuerdo (nota, opcional)</label><input id="ra-note" name="note" autocomplete="off" [ngModel]="note()" (ngModelChange)="note.set($event)" /></div>
    @if (dateError(); as m) { <p class="pending" role="alert">{{ m }}</p> }
    <div aria-live="polite">@if (error(); as e) { <div class="alert error" role="alert"><app-err [text]="e" /></div> }</div>
    <div class="form-actions"><button type="button" class="btn" (click)="cancelled.emit()">Cancelar</button> <button type="submit" class="btn primary" [disabled]="saving() || !valid()" [appBusy]="saving()" busyLabel="Guardando…">{{ saving() ? 'Guardando…' : (current() ? 'Cambiar conductor' : 'Asignar') }}</button></div>
  </form>`,
})
export class ReassignForm {
  readonly unit = input.required<Unit>();
  readonly current = input<Assignment | null>(null);
  readonly drivers = input.required<Driver[]>();
  /** Fin de la última asignación terminada de la unidad (inclusive): el nuevo conductor solo puede empezar al día siguiente. */
  readonly lastEnd = input<string | null>(null);
  readonly done = output<string>();
  readonly cancelled = output<void>();
  private readonly api = inject(ApiService);
  protected readonly usd = formatUSD;
  protected readonly driverId = signal('');
  protected readonly from = signal(todayIn(TIMEZONE));
  protected readonly minFrom = computed(() => { const e = this.lastEnd(); return !this.current() && e ? addDays(e, 1) : ''; });
  protected readonly rate = signal('');
  protected readonly note = signal('');
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly eligible = computed(() => this.drivers().filter((d) => d.status !== 'inactive' && d.id !== this.current()?.driverId));
  protected readonly rateOk = computed(() => !this.rate().trim() || /^\d+([.,]\d{1,2})?$/.test(this.rate().trim()));
  protected readonly weekly = computed(() => (this.rate().trim() && this.rateOk() ? toCents(this.rate()) * 6 : null));
  protected readonly dateError = computed(() => {
    const c = this.current();
    const min = this.minFrom();
    if (min && this.from() && this.from() < min) return 'La asignación anterior terminó el ' + this.lastEnd() + ' (inclusive). La nueva debe empezar desde el día siguiente.';
    return c && this.from() && this.from() <= c.validFrom ? 'La fecha de inicio debe ser posterior al inicio de la asignación actual.' : null;
  });
  private readonly bump = effect(() => { const m = this.minFrom(); if (m && this.from() < m) this.from.set(m); });
  protected readonly valid = computed(() => !!this.driverId() && !!this.from() && this.rateOk() && !this.dateError());

  protected async save(): Promise<void> {
    if (this.saving() || !this.valid()) return;
    this.saving.set(true);
    this.error.set(null);
    try {
      const note = this.note().trim();
      await this.api.reassignUnit({
        unitId: this.unit().id, newDriverId: this.driverId(), validFrom: this.from(),
        ...(this.rate().trim() ? { dailyCents: toCents(this.rate()) } : {}), ...(note ? { agreementNote: note } : {}),
      });
      this.done.emit('Asignación guardada.');
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.saving.set(false);
    }
  }
}

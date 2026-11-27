import { ErrText } from '../../shared/ui';
import { Component, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { formatUSD, toCents } from '@vip/shared';
import { dmy, todayIn } from '../../core/dates';
import { errorMessage } from '../../core/errors';
import { TIMEZONE, type Assignment } from '../../core/models';
import { ApiService } from '../../core/services';
import { BusyButton } from '../../shared/busy';

/** Cambio de tarifa diaria (POST /assignments/:id/rate {dailyCents, from, reason?}). Aplica desde esa fecha hacia adelante; no cambia cuotas ya generadas. */
@Component({
  selector: 'app-rate-change',
  imports: [BusyButton, ErrText, FormsModule],
  template: `<form class="panel" (ngSubmit)="submit()" novalidate aria-labelledby="rc-title">
    <h2 id="rc-title">Cambiar tarifa · {{ assignment().unitCode }} · {{ assignment().driverName }}</h2>
    <div class="alert info" role="note">Aplica desde esa fecha hacia adelante; <strong>no cambia cuotas ya generadas</strong> (si necesitas corregir alguna, registra un ajuste).</div>
    <div class="form-grid">
      <div class="field"><label for="rc-amount">Nueva tarifa diaria (USD)</label>
        <input id="rc-amount" name="amount" inputmode="decimal" placeholder="36.00" [ngModel]="amount()" (ngModelChange)="amount.set($event); confirming.set(false)" /></div>
      <div class="field"><label for="rc-from">Vigente desde</label>
        <input id="rc-from" name="from" type="date" [min]="minFrom()" [ngModel]="from()" (ngModelChange)="from.set($event); confirming.set(false)" /></div>
    </div>
    <div class="field"><label for="rc-reason">Motivo (opcional)</label>
      <input id="rc-reason" name="reason" autocomplete="off" maxlength="200" [ngModel]="reason()" (ngModelChange)="reason.set($event)" /></div>
    @if (assignment().dailyRateCents !== null) { <p class="muted">Tarifa actual: {{ usd(assignment().dailyRateCents!) }} por día.</p> }
    @if (confirming()) { <div class="alert warn" role="note">Vas a cambiar la tarifa de <strong>{{ usd(assignment().dailyRateCents ?? 0) }}</strong> a <strong>{{ usd(newCents()) }}</strong> por día desde el <strong>{{ dmy(from()) }}</strong>. Las cuotas ya generadas desde esa fecha no se modifican.</div> }
    <div aria-live="polite">
      @if (problem(); as p) { @if (tried()) { <div class="alert warn" role="alert">{{ p }}</div> } }
      @if (error(); as e) { <div class="alert error" role="alert"><app-err [text]="e" /></div> }
    </div>
    <div class="form-actions"><button type="button" class="btn" [disabled]="saving()" (click)="cancelled.emit()">Cancelar</button>
      @if (confirming()) { <button type="button" class="btn" [disabled]="saving()" (click)="confirming.set(false)">Volver</button> }
      <button type="submit" class="btn primary" [appBusy]="saving()" busyLabel="Guardando…">{{ confirming() ? 'Confirmar cambio de tarifa' : 'Revisar cambio' }}</button></div>
  </form>`,
})
export class RateChange {
  readonly assignment = input.required<Assignment>();
  readonly done = output<string>();
  readonly cancelled = output<void>();
  private readonly api = inject(ApiService);
  protected readonly usd = formatUSD;
  protected readonly dmy = dmy;
  protected readonly amount = signal('');
  protected readonly from = signal(todayIn(TIMEZONE));
  protected readonly reason = signal('');
  protected readonly saving = signal(false);
  protected readonly confirming = signal(false);
  protected readonly tried = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly minFrom = computed(() => this.assignment().validFrom);
  protected readonly valid = computed(() => /^\d+([.,]\d{1,2})?$/.test(this.amount().trim()) && toCents(this.amount()) > 0 && !!this.from());
  protected readonly newCents = computed(() => (this.valid() ? toCents(this.amount()) : 0));
  protected readonly problem = computed<string | null>(() => (!/^\d+([.,]\d{1,2})?$/.test(this.amount().trim()) || toCents(this.amount()) <= 0 ? 'Ingresa una tarifa válida, por ejemplo 40 o 40.50.' : !this.from() ? 'Elige la fecha desde la que rige la tarifa.' : null));

  /** Primer envío: revisa y pide confirmación; segundo: guarda. */
  protected async submit(): Promise<void> {
    if (this.saving()) return;
    this.tried.set(true);
    if (!this.valid()) return;
    if (!this.confirming()) { this.error.set(null); this.confirming.set(true); return; }
    this.saving.set(true);
    this.error.set(null);
    try {
      const r = await this.api.changeRate(this.assignment().id, toCents(this.amount()), this.from(), this.reason().trim() || undefined);
      const kept = r?.existingChargesFromDateUnchanged ?? 0;
      this.done.emit('Tarifa actualizada. ' + (kept === 0 ? 'No había cuotas generadas desde esa fecha.'
        : kept === 1 ? '1 cuota ya generada desde esa fecha no se modificó.' : `${kept} cuotas ya generadas desde esa fecha no se modificaron.`));
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.saving.set(false);
    }
  }
}

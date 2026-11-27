import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { errorMessage } from '../../core/errors';
import { createLoader } from '../../core/loader';
import type { AppSettings } from '../../core/models';
import { Perms } from '../../core/permissions';
import { DataService } from '../../core/services';
import { ErrText, ErrorState, LoadingState } from '../../shared/ui';
import { BusyButton } from '../../shared/busy';

export interface LimitsForm { maxPerDriverPerDay: number; minMinutesBetween: number; graceMinutes: number; chargeRecoveryDays: number }
export function validateLimits(l: LimitsForm): Record<string, string> {
  const e: Record<string, string> = {};
  const int = (v: number) => Number.isInteger(v);
  if (!int(l.maxPerDriverPerDay) || l.maxPerDriverPerDay < 1 || l.maxPerDriverPerDay > 20) e['max'] = 'Debe ser un número entre 1 y 20.';
  if (!int(l.minMinutesBetween) || l.minMinutesBetween < 0 || l.minMinutesBetween > 1440) e['min'] = 'Debe estar entre 0 y 1440 minutos.';
  if (!int(l.graceMinutes) || l.graceMinutes < 5 || l.graceMinutes > 1440) e['grace'] = 'Debe estar entre 5 y 1440 minutos.';
  if (!int(l.chargeRecoveryDays) || l.chargeRecoveryDays < 1 || l.chargeRecoveryDays > 90) e['recovery'] = 'Debe ser un número entre 1 y 90 días.';
  return e;
}

/** Límites de mensajes (app_settings). Cuatro campos en cuadrícula, con una línea de ayuda cada uno. ADMIN y SUPER_ADMIN pueden guardar. */
@Component({
  selector: 'app-message-limits',
  imports: [BusyButton, ErrText, ErrorState, LoadingState, FormsModule],
  template: `<section class="panel limits" aria-labelledby="lim-title" id="limites">
    <div class="row"><h2 id="lim-title">Límites de mensajes</h2>
      @if (!perms.canOperate()) { <span class="muted">Solo lectura para tu rol.</span> }</div>
    @if (settings.error(); as e) { <app-error-state [message]="e" (retry)="load()" /> }
    @else if (!limits()) { <app-loading variant="form" label="Cargando límites…" /> }
    @if (limits(); as l) {
      <form (ngSubmit)="save()" novalidate>
        <div class="limits-grid">
          <div class="field"><label for="lm-max">Máximo de recordatorios por conductor al día</label>
            <input id="lm-max" name="max" type="number" inputmode="numeric" min="1" max="20" [disabled]="!perms.canOperate()" [ngModel]="l.maxPerDriverPerDay" (ngModelChange)="patch('maxPerDriverPerDay', $event)" />
            <small class="hint">Cuenta solo recordatorios de cobro; no cuenta comprobantes de pago ni otras notificaciones.</small>
            @if (errors()['max']; as m) { <small class="pending">{{ m }}</small> }</div>
          <div class="field"><label for="lm-min">Separación mínima entre mensajes (min)</label>
            <input id="lm-min" name="min" type="number" inputmode="numeric" min="0" max="1440" [disabled]="!perms.canOperate()" [ngModel]="l.minMinutesBetween" (ngModelChange)="patch('minMinutesBetween', $event)" />
            <small class="hint">Tiempo mínimo entre dos recordatorios al mismo conductor.</small>
            @if (errors()['min']; as m) { <small class="pending">{{ m }}</small> }</div>
          <div class="field"><label for="lm-grace">Tolerancia de horarios vencidos (min)</label>
            <input id="lm-grace" name="grace" type="number" inputmode="numeric" min="5" max="1440" [disabled]="!perms.canOperate()" [ngModel]="l.graceMinutes" (ngModelChange)="patch('graceMinutes', $event)" />
            <small class="hint">Un horario vencido hace más de este tiempo ya no se crea.</small>
            @if (errors()['grace']; as m) { <small class="pending">{{ m }}</small> }</div>
          <div class="field"><label for="lm-recovery">Días de recuperación de cuotas</label>
            <input id="lm-recovery" name="recovery" type="number" inputmode="numeric" min="1" max="90" [disabled]="!perms.canOperate()" [ngModel]="l.chargeRecoveryDays" (ngModelChange)="patch('chargeRecoveryDays', $event)" />
            <small class="hint">Días hacia atrás que el sistema recupera automáticamente si hubo una interrupción; lo anterior se reporta para revisión.</small>
            @if (errors()['recovery']; as m) { <small class="pending">{{ m }}</small> }</div>
        </div>
        <div aria-live="polite">@if (msg(); as m) { <div class="alert" [class.ok]="m.kind === 'ok'" [class.error]="m.kind === 'error'" [attr.role]="m.kind === 'error' ? 'alert' : null"><app-err [text]="m.text" /></div> }</div>
        @if (perms.canOperate()) { <div class="actions"><button type="submit" class="btn primary" [disabled]="saving() || !!errorKeys().length" [appBusy]="saving()" busyLabel="Guardando…">{{ saving() ? 'Guardando…' : 'Guardar límites' }}</button></div> }
      </form>
    }
  </section>`,
})
export class MessageLimits {
  protected readonly perms = inject(Perms);
  private readonly data = inject(DataService);
  protected readonly settings = createLoader(() => this.data.getSettings(), null as AppSettings | null);
  protected readonly limits = signal<LimitsForm | null>(null);
  protected readonly errors = computed(() => { const l = this.limits(); return l ? validateLimits(l) : {}; });
  protected readonly errorKeys = computed(() => Object.keys(this.errors()));
  protected readonly saving = signal(false);
  protected readonly msg = signal<{ kind: 'ok' | 'error'; text: string } | null>(null);

  constructor() { void this.load(); }

  protected async load(): Promise<void> {
    await this.settings.reload();
    const s = this.settings.data();
    if (s) this.limits.set({ maxPerDriverPerDay: s.maxPerDriverPerDay, minMinutesBetween: s.minMinutesBetween, graceMinutes: s.graceMinutes, chargeRecoveryDays: s.chargeRecoveryDays });
  }
  protected patch(k: keyof LimitsForm, v: string | number): void { this.limits.update((l) => (l ? { ...l, [k]: v === '' || v === null ? NaN : Number(v) } : l)); }
  protected async save(): Promise<void> {
    const l = this.limits();
    if (!l || this.saving() || this.errorKeys().length || !this.perms.canOperate()) return;
    this.saving.set(true);
    this.msg.set(null);
    try { await this.data.saveSettings({ ...l }); this.msg.set({ kind: 'ok', text: 'Límites guardados.' }); }
    catch (e) { this.msg.set({ kind: 'error', text: errorMessage(e) }); }
    finally { this.saving.set(false); }
  }
}

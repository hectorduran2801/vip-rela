import { Component, effect, inject, input, untracked } from '@angular/core';
import { formatUSD } from '@vip/shared';
import { dateTime, dmy } from '../../core/dates';
import { createLoader } from '../../core/loader';
import { TIMEZONE, type RateHistoryItem } from '../../core/models';
import { Perms } from '../../core/permissions';
import { ApiService, Breakpoints } from '../../core/services';
import { EmptyState, ErrorState, LoadingState } from '../../shared/ui';

/**
 * Historial de tarifas (GET /assignments/:id/rate-history o GET /rate-history), más reciente primero. Solo ADMIN+ (la API lo exige).
 * Muestra lo que dice el servidor: tarifa anterior → nueva, vigencia, quién y cuándo (12 h) y el motivo; no se calcula nada aquí.
 */
@Component({
  selector: 'app-rate-history',
  imports: [EmptyState, ErrorState, LoadingState],
  template: `@if (perms.canOperate()) {
    <section class="rate-history" aria-labelledby="rh-title">
      <h2 id="rh-title">Historial de tarifas</h2>
      @if (list.error(); as e) { <app-error-state [message]="e" (retry)="list.reload()" /> }
      @else if (list.loading() && !list.data().length) { <app-loading variant="table" [rows]="3" /> }
      @else if (!list.data().length) { <app-empty-state class="compact" title="Sin cambios de tarifa" hint="Aún no se ha registrado ningún cambio de tarifa." /> }
      @else if (bp.isMobile()) {
        <ul class="cards" aria-label="Historial de tarifas">
          @for (r of list.data(); track r.rateId) {
            <li class="card">
              <div class="row"><strong>{{ prev(r) }} → {{ usd(r.newDailyCents) }}</strong>@if (r.isCurrent) { <span class="chip-s paid">Vigente</span> }</div>
              @if (!assignmentId()) { <div class="muted">{{ r.unitCode }} · {{ r.operatorCode }} · {{ r.driverName }}</div> }
              <div class="muted">Desde {{ dmy(r.validFrom) }}{{ r.validTo ? ' hasta ' + dmy(r.validTo) : '' }}</div>
              <div class="muted">{{ when(r) }}{{ r.changedByName ? ' · ' + r.changedByName : '' }}</div>
              @if (r.reason) { <div>{{ r.reason }}</div> }
            </li>
          }
        </ul>
      } @else {
        <div class="table-wrap"><table aria-label="Historial de tarifas">
          <thead><tr>@if (!assignmentId()) { <th scope="col">Unidad</th><th scope="col">Operario</th><th scope="col">Conductor</th> }
            <th scope="col">Tarifa anterior → nueva</th><th scope="col">Vigencia</th><th scope="col">Usuario</th><th scope="col">Fecha y hora</th><th scope="col">Motivo</th></tr></thead>
          <tbody>
            @for (r of list.data(); track r.rateId) {
              <tr>@if (!assignmentId()) { <td>{{ r.unitCode }}</td><td>{{ r.operatorCode }}</td><td>{{ r.driverName }}</td> }
                <td class="nowrap">{{ prev(r) }} → <strong>{{ usd(r.newDailyCents) }}</strong>@if (r.isCurrent) { <span class="chip-s paid">Vigente</span> }</td>
                <td class="nowrap">{{ dmy(r.validFrom) }} → {{ r.validTo ? dmy(r.validTo) : 'vigente' }}</td>
                <td>{{ r.changedByName ?? '—' }}</td><td class="nowrap">{{ when(r) }}</td><td>{{ r.reason ?? '—' }}</td></tr>
            }
          </tbody></table></div>
      }
    </section>
  }`,
})
export class RateHistory {
  protected readonly perms = inject(Perms);
  protected readonly bp = inject(Breakpoints);
  private readonly api = inject(ApiService);
  /** Asignación concreta; sin ella se lista el historial de todas (GET /rate-history). */
  readonly assignmentId = input<string | null>(null);
  /** Cambia para forzar una nueva lectura (p. ej. tras guardar una tarifa). */
  readonly reloadKey = input<unknown>(null);
  protected readonly usd = formatUSD;
  protected readonly dmy = dmy;
  protected readonly list = createLoader(async () => (await this.api.rateHistory(this.assignmentId() ?? undefined)) ?? [], [] as RateHistoryItem[]);
  constructor() { effect(() => { this.assignmentId(); this.reloadKey(); untracked(() => { if (this.perms.canOperate()) void this.list.reload(); }); }); }
  protected prev(r: RateHistoryItem): string { return r.previousDailyCents === null ? 'Tarifa inicial' : formatUSD(r.previousDailyCents); }
  protected when(r: RateHistoryItem): string { return dateTime(r.changedAt, TIMEZONE); }
}

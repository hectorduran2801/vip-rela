import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { actionLabel, entityLabel } from '../../core/audit-labels';
import { dateTime } from '../../core/dates';
import { createLoader } from '../../core/loader';
import { TIMEZONE, type AuditEntry } from '../../core/models';
import { Breakpoints, DataService } from '../../core/services';
import { EmptyState, ErrorState, LoadingState } from '../../shared/ui';

const norm = (v: string): string => v.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

/** Auditoría completa (solo SUPER_ADMIN): últimos 300 movimientos de audit_logs, con búsqueda por acción o entidad. */
@Component({
  selector: 'app-audit',
  imports: [FormsModule, EmptyState, ErrorState, LoadingState],
  template: `<div class="page">
    <div class="filterbar"><div class="field"><label for="au-q">Buscar en la auditoría</label>
      <input id="au-q" type="search" placeholder="Acción o entidad" autocomplete="off" [ngModel]="query()" (ngModelChange)="query.set($event)" /></div>
      <span class="muted">Últimos 300 movimientos.</span></div>
    @if (list.error(); as e) { <app-error-state [message]="e" (retry)="list.reload()" /> }
    @if (list.loading() && !list.data().length) { <app-loading variant="table" /> }
    @else if (!list.error() && !shown().length) { <app-empty-state icon="inbox" title="Sin movimientos" hint="No hay registros que coincidan." /> }
    @else if (bp.isMobile()) {
      <ul class="cards" aria-label="Auditoría">@for (a of shown(); track a.id) {
        <li class="card"><div class="row"><strong>{{ action(a) }}</strong><span class="chip-s">{{ entity(a) }}</span></div><div class="muted">{{ when(a.at) }} · {{ actor(a) }}</div>
          <details class="tech"><summary>Detalle técnico</summary><code>{{ tech(a) }}</code></details></li> }</ul>
    } @else {
      <div class="table-wrap"><table aria-label="Auditoría">
        <thead><tr><th scope="col">Cuándo</th><th scope="col">Acción</th><th scope="col">Entidad</th><th scope="col">Responsable</th></tr></thead>
        <tbody>@for (a of shown(); track a.id) { <tr><td class="nowrap">{{ when(a.at) }}</td><td>{{ action(a) }}<details class="tech"><summary>Detalle técnico</summary><code>{{ tech(a) }}</code></details></td><td>{{ entity(a) }}</td><td class="muted">{{ actor(a) }}</td></tr> }</tbody></table></div>
    }
  </div>`,
})
export class Audit {
  private readonly data = inject(DataService);
  protected readonly bp = inject(Breakpoints);
  protected readonly list = createLoader(() => this.data.listAudit(), [] as AuditEntry[]);
  protected readonly query = signal('');
  protected readonly shown = computed(() => { const q = norm(this.query()); return this.list.data().filter((a) => !q || norm(`${a.action} ${a.entity} ${actionLabel(a.action)} ${entityLabel(a.entity)}`).includes(q)); });
  constructor() { void this.list.reload(); }
  protected when(iso: string): string { return dateTime(iso, TIMEZONE); }
  protected action(a: AuditEntry): string { return actionLabel(a.action); }
  protected entity(a: AuditEntry): string { return entityLabel(a.entity); }
  protected tech(a: AuditEntry): string { return `acción: ${a.action} · entidad: ${a.entity}${a.entityId ? ` · id: ${a.entityId}` : ''}${Object.keys(a.detail ?? {}).length ? ` · detalle: ${JSON.stringify(a.detail)}` : ''}`; }
  protected actor(a: AuditEntry): string { return a.actor ? `usuario ${a.actor.slice(0, 8)}` : 'servidor'; }
}

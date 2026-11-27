import { Component, inject, input, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { RouterLink } from '@angular/router';
import { formatUSD } from '@vip/shared';
import { dmy } from '../core/dates';
import { createLoader } from '../core/loader';
import type { FormerDebt } from '../core/models';
import { ApiService } from '../core/services';

/**
 * Deuda de conductores desvinculados: no cuenta en la cartera activa, pero siempre se puede consultar. Inicio, Cobranza y Conductores usan
 * este mismo componente, así que el número es el mismo en los tres. `detail` muestra la lista (Conductores); sin él, «Ver cuáles» la despliega ahí mismo.
 */
@Component({
  selector: 'app-former-debts',
  imports: [NgTemplateOutlet, RouterLink],
  template: `@if (list.error()) { <p class="muted" role="status">No se pudo consultar la deuda de desvinculados.</p> }
  @else if (list.data().length) {
    @if (detail()) {
      <section class="panel" aria-labelledby="fd-title">
        <h2 id="fd-title">Desvinculados con saldo pendiente · {{ usd(total()) }}</h2>
        <p class="muted">Ya no tienen esa unidad. No cuentan en la cartera activa ni reciben mensajes de cobranza.</p>
        <ng-container [ngTemplateOutlet]="rows" />
      </section>
    } @else {
      <p class="alert info">Aparte de la cartera activa, desvinculados con saldo pendiente: {{ list.data().length }} · <strong>{{ usd(total()) }}</strong>. <button type="button" class="btn ghost sm" [attr.aria-expanded]="open()" (click)="open.set(!open())">{{ open() ? 'Ocultar' : 'Ver cuáles' }}</button></p>
      @if (open()) { <ng-container [ngTemplateOutlet]="rows" /> }
    }
  }
  <ng-template #rows>
    <ul class="plain" aria-label="Desvinculados con saldo">
      @for (d of list.data(); track d.assignmentId) {
        <li><a [routerLink]="['/drivers', d.driverId]">{{ d.fullName }}</a> · operario {{ d.operatorCode }} · unidad {{ d.unitCode }} hasta {{ dmy(d.endedOn) }} · <strong>{{ usd(d.pendingCents) }}</strong></li>
      }
    </ul>
  </ng-template>`,
})
export class FormerDebts {
  private readonly api = inject(ApiService, { optional: true });
  readonly detail = input(false);
  protected readonly open = signal(false);
  protected readonly usd = formatUSD;
  protected readonly dmy = dmy;
  protected readonly list = createLoader(async () => (await this.api?.formerDebts()) ?? [], [] as FormerDebt[]);
  protected total(): number { return this.list.data().reduce((t, d) => t + d.pendingCents, 0); }
  constructor() { void this.list.reload(); }
}

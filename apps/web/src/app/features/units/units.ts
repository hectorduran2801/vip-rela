import { Perms } from '../../core/permissions';
import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { formatUSD } from '@vip/shared';
import { createLoader } from '../../core/loader';
import { VEHICLE_STATUS_LABEL, type Assignment, type Unit } from '../../core/models';
import { Breakpoints, DataService } from '../../core/services';
import { EmptyState, ErrorState, LoadingState } from '../../shared/ui';
import { UnitForm } from './unit-form';
import { Modal } from '../../shared/modal';
import { ManageEntity } from '../../shared/manage-entity';

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

@Component({ selector: 'app-units', imports: [ManageEntity, Modal, FormsModule, RouterLink, UnitForm, EmptyState, ErrorState, LoadingState], templateUrl: './units.html' })
export class Units {
  protected readonly perms = inject(Perms);
  private readonly data = inject(DataService);
  protected readonly bp = inject(Breakpoints);
  protected readonly labels = VEHICLE_STATUS_LABEL;
  protected readonly usd = formatUSD;
  protected readonly list = createLoader(async () => { const [units, assignments] = await Promise.all([this.data.listUnits(), this.data.listAssignments()]); return { units, assignments }; },
    { units: [] as Unit[], assignments: [] as Assignment[] });
  /** Filtro del acuerdo: texto «contiene…» (sin distinguir mayúsculas) y/o solo unidades «Sin acuerdo». */
  protected readonly agFilter = signal('');
  protected readonly noAgreement = signal(false);
  protected readonly query = signal('');
  protected readonly creating = signal(false);
  protected readonly rows = computed(() => {
    const q = norm(this.query());
    const cur = new Map(this.list.data().assignments.filter((a) => !a.validTo).map((a) => [a.unitId, a]));
    return this.list.data().units
      .map((u) => ({ unit: u, driver: cur.get(u.id) ?? null }))
      .filter((r) => !this.noAgreement() || !r.unit.agreement)
      .filter((r) => !this.agFilter().trim() || norm(r.unit.agreement ?? '').includes(norm(this.agFilter())))
      .filter((r) => !q || [r.unit.code, r.unit.plate ?? '', r.unit.make ?? '', r.unit.model ?? '', r.unit.agreement ?? '', r.driver?.driverName ?? ''].some((f) => norm(f).includes(q)));
  });
  constructor() { void this.list.reload(); }
  protected saved(): void { this.creating.set(false); void this.list.reload(); }
}

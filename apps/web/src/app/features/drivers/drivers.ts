import { Perms } from '../../core/permissions';
import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { createLoader } from '../../core/loader';
import { DRIVER_STATUS_LABEL, type Driver, type DriverStatus } from '../../core/models';
import { Breakpoints, DataService } from '../../core/services';
import { EmptyState, ErrorState, LoadingState } from '../../shared/ui';
import { ManageEntity } from '../../shared/manage-entity';

export const norm = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

/** Búsqueda por operador, nombre, cédula o teléfono + filtro de estado. */
export function filterDrivers(list: Driver[], query: string, status: DriverStatus | 'all'): Driver[] {
  const q = norm(query);
  return list.filter((d) => (status === 'all' || d.status === status)
    && (!q || [d.operatorCode, d.nationalId ?? '', `${d.firstName} ${d.lastName}`, d.phone ?? '', d.phoneE164 ?? ''].some((f) => norm(f).includes(q))));
}

import { FormerDebts } from '../../shared/former-debts';

@Component({
  selector: 'app-drivers',
  imports: [FormerDebts, ManageEntity, FormsModule, RouterLink, EmptyState, ErrorState, LoadingState],
  templateUrl: './drivers.html',
})
export class Drivers {
  protected readonly perms = inject(Perms);
  private readonly data = inject(DataService);
  protected readonly bp = inject(Breakpoints);
  protected readonly labels = DRIVER_STATUS_LABEL;
  protected readonly statusOptions = Object.keys(DRIVER_STATUS_LABEL) as DriverStatus[];
  protected readonly list = createLoader(() => this.data.listDrivers(), [] as Driver[]);
  protected readonly query = signal('');
  protected readonly status = signal<DriverStatus | 'all'>('all');
  protected readonly filtered = computed(() => filterDrivers(this.list.data(), this.query(), this.status()));

  constructor() { void this.list.reload(); }
}

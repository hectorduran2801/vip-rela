import { PageCrumb } from '../../core/page-crumb';
import { Perms } from '../../core/permissions';
import { ErrText } from '../../shared/ui';
import { DestroyRef, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { formatUSD } from '@vip/shared';
import { dateTime, dmy, todayIn } from '../../core/dates';
import { errorMessage } from '../../core/errors';
import { createLoader } from '../../core/loader';
import { IconButton } from '../../shared/icon-button';
import {
  DRIVER_STATUS_LABEL, TIMEZONE, type Assignment, type AssignmentSaldo, type Driver, type Dues, type Movement, type PaymentMethod, type Position, type Unit,
} from '../../core/models';
import { ApiService, DataService } from '../../core/services';
import { RouterLink as RL } from '@angular/router';
import { MovementList } from '../movements/movement-list';
import { RateHistory } from '../units/rate-history';
import { EmptyState, ErrorState, LoadingState } from '../../shared/ui';
import { DriverForm } from './driver-form';
import { Modal } from '../../shared/modal';
import { ManageEntity } from '../../shared/manage-entity';

interface Bundle { driver: Driver | null; assignments: Assignment[]; units: Unit[] }
interface Money { position: Position | null; dues: Dues | null; movements: Movement[]; saldo: AssignmentSaldo | null }

@Component({
  selector: 'app-driver-detail',
  imports: [ManageEntity, Modal, IconButton, ErrText, FormsModule, RL, DriverForm, MovementList, RateHistory, EmptyState, ErrorState, LoadingState],
  templateUrl: './driver-detail.html',
})
export class DriverDetail {
  private readonly router = inject(Router);
  protected goBack(path: string): void { void this.router.navigate([path]); }
  protected readonly perms = inject(Perms);
  readonly id = input.required<string>();
  private readonly data = inject(DataService);
  private readonly api = inject(ApiService);
  protected readonly when = (iso: string): string => dateTime(iso, TIMEZONE);
  protected readonly usd = formatUSD;
  protected readonly dmy = dmy;
  protected readonly labels = DRIVER_STATUS_LABEL;
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly editing = signal(false);

  protected readonly bundle = createLoader<Bundle>(async () => {
    const [drivers, assignments, units] = await Promise.all([
      this.data.listDrivers(), this.data.listAssignments(), this.data.listUnits(),
    ]);
    return { driver: drivers.find((d) => d.id === this.id()) ?? null, assignments: assignments.filter((a) => a.driverId === this.id()), units };
  }, { driver: null, assignments: [], units: [] });
  protected readonly money = createLoader<Money>(async () => {
    const a = this.current() ?? this.last();                      // sin unidad vigente: se conservan los movimientos de la última
    if (!a) return { position: null, dues: null, movements: [], saldo: null };
    const [position, dues, movements, saldo] = await Promise.all([
      this.data.position(a.id), this.data.dues(a.id, todayIn(TIMEZONE)), this.data.movements(a.id), this.api.assignmentSaldo(a.id).catch(() => null)]);
    return { position, dues, movements, saldo };
  }, { position: null, dues: null, movements: [], saldo: null });

  protected readonly max0 = (n: number): number => Math.max(n, 0);
  protected readonly driver = computed(() => this.bundle.data().driver);
  protected readonly current = computed(() => this.bundle.data().assignments.find((a) => !a.validTo) ?? null);
  /** Última asignación terminada (solo cuando no hay una vigente). */
  protected readonly last = computed(() => (this.current() ? null : this.bundle.data().assignments.filter((a) => !!a.validTo).sort((a, b) => b.validTo!.localeCompare(a.validTo!))[0] ?? null));
  protected readonly unit = computed(() => this.bundle.data().units.find((u) => u.id === this.current()?.unitId) ?? null);

  private readonly crumb = inject(PageCrumb);

  constructor() {
    effect(() => { const x = this.driver(); this.crumb.leaf.set(x ? `${x.firstName} ${x.lastName}`.trim() : null); });
    inject(DestroyRef).onDestroy(() => this.crumb.leaf.set(null));
    effect(() => { this.id(); untracked(() => { void this.bundle.reload(); }); });
    effect(() => { this.current(); this.last(); untracked(() => void this.money.reload()); });
  }

  protected saved(): void { this.editing.set(false); void this.bundle.reload(); }
}

import { Perms } from '../../core/permissions';
import { ErrText } from '../../shared/ui';
import { PageCrumb } from '../../core/page-crumb';
import { DestroyRef, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { formatUSD, toCents } from '@vip/shared';
import { dateTime, dmy, todayIn } from '../../core/dates';
import { errorMessage } from '../../core/errors';
import { createLoader } from '../../core/loader';
import { TIMEZONE, VEHICLE_STATUS_LABEL, type Assignment, type Driver, type RateException, type Unit, type UnitAgreementChange, type VehicleStatus } from '../../core/models';
import { ApiService, DataService } from '../../core/services';
import { EmptyState, ErrorState, LoadingState } from '../../shared/ui';
import { UnitAgreement } from './unit-agreement';
import { RateChange } from './rate-change';
import { RateHistory } from './rate-history';
import { ReassignForm } from './reassign-form';
import { UnitForm } from './unit-form';
import { BusyButton } from '../../shared/busy';
import { IconButton } from '../../shared/icon-button';
import { Modal } from '../../shared/modal';
import { ManageEntity } from '../../shared/manage-entity';

type Panel = 'none' | 'reassign' | 'rate' | 'end';
interface Bundle { unit: Unit | null; assignments: Assignment[]; drivers: Driver[]; exceptions: RateException[]; history: UnitAgreementChange[] }

/** Ficha de unidad: datos, estado del vehículo, conductor y tarifa vigentes, historial y excepciones/acuerdos. */
@Component({
  selector: 'app-unit-detail',
  imports: [ManageEntity, Modal, IconButton, BusyButton, ErrText, FormsModule, RouterLink, UnitForm, UnitAgreement, RateChange, RateHistory, ReassignForm, EmptyState, ErrorState, LoadingState],
  templateUrl: './unit-detail.html',
})
export class UnitDetail {
  private readonly router = inject(Router);
  protected goBack(path: string): void { void this.router.navigate([path]); }
  protected readonly perms = inject(Perms);
  readonly id = input.required<string>();
  private readonly data = inject(DataService);
  private readonly api = inject(ApiService);
  protected readonly usd = formatUSD;
  protected readonly dmy = dmy;
  protected readonly labels = VEHICLE_STATUS_LABEL;
  protected readonly editing = signal(false);
  protected readonly panel = signal<Panel>('none');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly ok = signal<string | null>(null);
  protected readonly endDate = signal(todayIn(TIMEZONE));
  protected readonly exDate = signal(todayIn(TIMEZONE));
  protected readonly exAmount = signal('');
  protected readonly exReason = signal('');

  protected readonly load = createLoader<Bundle>(async () => {
    const [units, asg, drivers, history] = await Promise.all([this.data.listUnits(), this.data.listAssignments(), this.data.listDrivers(), this.data.listAgreementHistory(this.id())]);
    const mine = asg.filter((a) => a.unitId === this.id());
    const cur = mine.find((a) => !a.validTo);
    return { unit: units.find((u) => u.id === this.id()) ?? null, assignments: mine, drivers, exceptions: cur ? await this.data.listRateExceptions(cur.id) : [], history: history ?? [] };
  }, { unit: null, assignments: [], drivers: [], exceptions: [], history: [] });
  protected readonly unit = computed(() => this.load.data().unit);
  protected readonly lastEnd = computed(() => this.load.data().assignments.reduce<string | null>((m, a) => (a.validTo && (!m || a.validTo > m) ? a.validTo : m), null));
  protected readonly current = computed(() => this.load.data().assignments.find((a) => !a.validTo) ?? null);

  private readonly crumb = inject(PageCrumb);
  constructor() {
    effect(() => this.crumb.leaf.set(this.unit()?.code ?? null));
    inject(DestroyRef).onDestroy(() => this.crumb.leaf.set(null));
    effect(() => { this.id(); untracked(() => void this.load.reload()); }); }

  protected readonly show = (v: string | null): string => v ?? 'sin acuerdo';
  /** Tras guardar el acuerdo se relee el historial y la unidad (lo mostrado sale de la base de datos). */
  protected agreementSaved(): void { void this.load.reload(); }
  protected when(iso: string): string { return dateTime(iso, TIMEZONE); }

  protected saved(): void { this.editing.set(false); void this.load.reload(); }
  protected finished(msg: string): void { this.panel.set('none'); this.ok.set(msg); void this.load.reload(); }

  private async run(fn: () => Promise<string>): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    this.ok.set(null);
    try { this.ok.set(await fn()); await this.load.reload(); } catch (e) { this.error.set(errorMessage(e)); } finally { this.busy.set(false); }
  }

  /** Suspender (mantenimiento), desactivar (fuera de servicio) o reactivar la unidad. */
  protected readonly confirmOut = signal(false);
  protected readonly confirmEx = signal<string | null>(null);
  protected outOfService(): Promise<void> { this.confirmOut.set(false); return this.setVehicleStatus('out_of_service'); }
  protected setVehicleStatus(status: VehicleStatus): Promise<void> {
    const u = this.unit();
    if (!u) return Promise.resolve();
    return this.run(async () => { await this.data.saveUnit({ ...u, vehicleStatus: status }); return `Estado de la unidad: ${VEHICLE_STATUS_LABEL[status]}.`; });
  }

  protected endCurrent(): Promise<void> {
    const c = this.current();
    if (!c || !this.endDate()) return Promise.resolve();
    return this.run(async () => { await this.api.endAssignment(c.id, this.endDate()); this.panel.set('none'); return 'Conductor desvinculado: la unidad quedó disponible. Los registros anteriores se conservaron.'; });
  }

  protected exValid(): boolean { return /^\d+([.,]\d{1,2})?$/.test(this.exAmount().trim()) && !!this.exDate(); }
  protected addException(): Promise<void> {
    const c = this.current();
    if (!c || !this.exValid()) return Promise.resolve();
    return this.run(async () => {
      await this.data.saveRateException({ assignmentId: c.id, onDate: this.exDate(), amountCents: toCents(this.exAmount()), reason: this.exReason().trim() || null });
      this.exAmount.set(''); this.exReason.set('');
      return 'Excepción guardada. Solo aplica a cuotas que aún no se hayan generado.';
    });
  }
  protected removeException(e: RateException): Promise<void> {
    this.confirmEx.set(null);
    return this.run(async () => { await this.data.deleteRateException(e.id); return 'Excepción eliminada.'; });
  }
}

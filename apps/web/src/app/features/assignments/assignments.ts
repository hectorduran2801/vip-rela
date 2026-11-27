import { Perms } from '../../core/permissions';
import { ErrText } from '../../shared/ui';
import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { formatUSD, toCents } from '@vip/shared';
import { dmy, todayIn } from '../../core/dates';
import { errorMessage } from '../../core/errors';
import { createLoader } from '../../core/loader';
import { TIMEZONE, type Assignment, type Driver, type Unit } from '../../core/models';
import { ApiService, Breakpoints, DataService } from '../../core/services';
import { RouterLink } from '@angular/router';
import { LoadingState } from '../../shared/ui';
import { RateChange } from '../units/rate-change';
import { BusyButton } from '../../shared/busy';
import { IconButton } from '../../shared/icon-button';
import { Modal } from '../../shared/modal';

/** Asignaciones: alta atómica (start), cambio de tarifa (rate) y cierre (end) mediante la API; nada se escribe por partes. */
@Component({ selector: 'app-assignments', imports: [Modal, IconButton, BusyButton, ErrText, FormsModule, RouterLink, RateChange, LoadingState], templateUrl: './assignments.html' })
export class Assignments {
  protected readonly perms = inject(Perms);
  private readonly data = inject(DataService);
  private readonly api = inject(ApiService);
  protected readonly bp = inject(Breakpoints);
  protected readonly usd = formatUSD;
  protected readonly dmy = dmy;
  protected readonly list = createLoader(() => this.data.listAssignments(), [] as Assignment[]);
  protected readonly drivers = createLoader(() => this.data.listDrivers(), [] as Driver[]);
  protected readonly units = createLoader(() => this.data.listUnits(), [] as Unit[]);
  /** Acuerdo / condición especial de la unidad de la asignación (texto libre). */
  protected condOf(a: Assignment): string | null { return this.units.data().find((u) => u.id === a.unitId)?.agreement ?? null; }
  protected readonly onlyCurrent = signal(true);
  protected readonly shown = computed(() => this.list.data().filter((a) => !this.onlyCurrent() || !a.validTo));

  protected readonly creating = signal(false);
  protected readonly driverId = signal('');
  protected readonly unitId = signal('');
  protected readonly validFrom = signal(todayIn(TIMEZONE));
  protected readonly rate = signal('');
  protected readonly note = signal('');
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly ok = signal<string | null>(null);
  protected readonly rateFor = signal<Assignment | null>(null);

  constructor() { void this.list.reload(); void this.drivers.reload(); void this.units.reload(); }

  protected rateOk(): boolean { return !this.rate().trim() || /^\d+([.,]\d{1,2})?$/.test(this.rate().trim()); }
  protected valid(): boolean { return !!this.driverId() && !!this.unitId() && !!this.validFrom() && this.rateOk(); }
  protected weekly(): number | null { return this.rate().trim() && this.rateOk() ? toCents(this.rate()) * 6 : null; }

  protected async create(): Promise<void> {
    if (this.saving() || !this.valid()) return;
    this.saving.set(true);
    this.error.set(null);
    this.ok.set(null);
    try {
      const note = this.note().trim();
      await this.api.startAssignment({
        driverId: this.driverId(), unitId: this.unitId(), validFrom: this.validFrom(),
        ...(this.rate().trim() ? { dailyCents: toCents(this.rate()) } : {}), ...(note ? { agreementNote: note } : {}),
      });
      this.creating.set(false);
      this.rate.set(''); this.note.set('');
      this.ok.set('Asignación creada.');
      await this.list.reload();
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.saving.set(false);
    }
  }

  protected rateChanged(msg: string): void { this.rateFor.set(null); this.ok.set(msg); void this.list.reload(); }

  protected readonly confirmEnd = signal<Assignment | null>(null);
  protected doEnd(a: Assignment): void { this.confirmEnd.set(null); void this.end(a); }
  protected async end(a: Assignment): Promise<void> {
    this.error.set(null);
    this.ok.set(null);
    try {
      await this.api.endAssignment(a.id, todayIn(TIMEZONE));
      this.ok.set('Conductor desvinculado: la unidad quedó disponible. Los registros anteriores se conservaron.');
      await this.list.reload();
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }
}

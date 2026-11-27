import { ErrText } from '../../shared/ui';
import { Component, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { errorMessage } from '../../core/errors';
import { VEHICLE_STATUS_LABEL, type Unit, type UnitInput, type VehicleStatus } from '../../core/models';
import { norm } from '../../core/autosave';
import { DataService } from '../../core/services';
import { AGREEMENT_SUGGESTIONS, UnitAgreement } from './unit-agreement';
import { BusyButton } from '../../shared/busy';

const EMPTY: UnitInput = { code: '', plate: null, make: null, model: null, year: null, vehicleStatus: 'active', notes: null };
/** Los códigos de unidad se comparan sin mayúsculas ni espacios: «P300» = «p300». */
export const normCode = (c: string): string => c.replace(/\s+/g, '').toLowerCase();

export function validateUnit(f: UnitInput, others: Unit[] = []): Record<string, string> {
  const e: Record<string, string> = {};
  if (!f.code.trim()) e['code'] = 'El código de la unidad es obligatorio.';
  else if (others.some((u) => u.id !== (f as { id?: string }).id && normCode(u.code) === normCode(f.code))) e['code'] = 'Ya existe una unidad con ese código (se ignoran mayúsculas y espacios: «P300» = «p300»).';
  if (f.year !== null && (!Number.isInteger(f.year) || f.year < 1980 || f.year > 2100)) e['year'] = 'El año debe estar entre 1980 y 2100.';
  return e;
}

@Component({ selector: 'app-unit-form', imports: [BusyButton, ErrText, FormsModule, UnitAgreement], templateUrl: './unit-form.html' })
export class UnitForm {
  readonly unit = input<Unit | null>(null);
  readonly saved = output<void>();
  readonly cancelled = output<void>();
  private readonly data = inject(DataService);
  protected readonly statuses = (Object.keys(VEHICLE_STATUS_LABEL) as VehicleStatus[]).map((v) => ({ v, label: VEHICLE_STATUS_LABEL[v] }));
  protected readonly form = signal<UnitInput>({ ...EMPTY });
  protected readonly touched = signal(false);
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly existing = signal<Unit[]>([]);
  /** Acuerdo y observación al CREAR (se envían tras crear la unidad con set_unit_agreement). Al editar se usa el editor con guardado automático. */
  protected readonly agreement = signal('');
  protected readonly agreementNote = signal('');
  protected readonly suggestions = AGREEMENT_SUGGESTIONS;
  protected readonly errors = computed(() => validateUnit(this.form(), this.existing()));

  ngOnInit(): void {
    const u = this.unit();
    this.form.set(u ? { ...u } : { ...EMPTY });
    void this.data.listUnits().then((l) => this.existing.set(l)).catch(() => undefined);
  }
  protected patch<K extends keyof UnitInput>(k: K, v: UnitInput[K]): void { this.form.update((f) => ({ ...f, [k]: v })); }
  protected text(k: 'plate' | 'make' | 'model' | 'notes', v: string): void { this.patch(k, v || null); }
  protected year(v: string): void { this.patch('year', v === '' ? null : Number(v)); }

  async save(): Promise<void> {
    this.touched.set(true);
    if (this.saving() || Object.keys(this.errors()).length) return;
    this.saving.set(true);
    this.error.set(null);
    try {
      const id = (await this.data.saveUnit(this.form())) ?? this.form().id;
      if (!this.unit() && id && (norm(this.agreement()) || norm(this.agreementNote()))) await this.data.setUnitAgreement(id, norm(this.agreement()), norm(this.agreementNote()));
      this.saved.emit();
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.saving.set(false);
    }
  }
}

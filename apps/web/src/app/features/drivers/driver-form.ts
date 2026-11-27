import { Component, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { errorMessage, SAVE_TIMEOUT_MS, timedOut, withTimeout } from '../../core/errors';
import {
  DRIVER_STATUS_LABEL, type ConsentPurpose, type ConsentSource, type Driver, type DriverInput, type DriverStatus,
} from '../../core/models';
import { DataService } from '../../core/services';
import { ErrText } from '../../shared/ui';
import { normalizeWhatsapp } from '../../core/phone';
import { BusyButton } from '../../shared/busy';

const EMPTY: DriverInput = {
  operatorCode: '', nationalId: '', firstName: '', lastName: '', phone: null, phoneE164: null,
  licenseNumber: null, licenseExpiresOn: null, remindersPaused: false, remindersPausedReason: null, status: 'active', notes: null,
};
export const E164 = /^\+[1-9][0-9]{7,14}$/;
export const PHONE = /^[0-9+() .-]{6,24}$/;

/** Una finalidad de WhatsApp en el formulario: casilla + origen + referencia. Son independientes entre sí. */
export interface ConsentChoice { grant: boolean; source: ConsentSource | ''; evidence: string }
export interface ConsentForm { collection: ConsentChoice; promotional: ConsentChoice }
export const PURPOSES: ConsentPurpose[] = ['collection', 'promotional'];

/** Validación del formulario de conductor (espejo de los checks de la base de datos y de las reglas de autorización). */
export function validateDriver(f: DriverInput, c?: ConsentForm, already?: Partial<Record<ConsentPurpose, boolean>>): Record<string, string> {
  const e: Record<string, string> = {};
  if (!f.operatorCode.trim()) e['operatorCode'] = 'Indica el código de operador.';
  if (!f.firstName.trim()) e['firstName'] = 'Indica el nombre completo.';
  if (f.phoneE164?.trim() && !normalizeWhatsapp(f.phoneE164)) e['phoneE164'] = 'WhatsApp no válido: 8 dígitos de Panamá (6000-0000) o formato internacional con + (por ejemplo +50760000000).';
  if (c) for (const p of PURPOSES) {
    if (already?.[p] || !c[p].grant) continue;
    if (!c[p].source) e[`${p}Source`] = 'Indica el origen de la autorización para poder guardarla.';
    if (!f.phoneE164?.trim() || e['phoneE164']) e[`${p}Phone`] = 'No hay autorización sin un número de WhatsApp válido: indícalo o desmarca la casilla.';
  }
  return e;
}

@Component({ selector: 'app-driver-form', imports: [BusyButton, ErrText, FormsModule], templateUrl: './driver-form.html' })
export class DriverForm {
  readonly driver = input<Driver | null>(null);
  readonly saved = output<void>();
  readonly cancelled = output<void>();
  private readonly data = inject(DataService);
  protected readonly statuses = (Object.keys(DRIVER_STATUS_LABEL) as DriverStatus[]).map((v) => ({ v, label: DRIVER_STATUS_LABEL[v] }));
  protected readonly form = signal<DriverInput>({ ...EMPTY });
  protected readonly touched = signal(false);
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly errors = computed(() => validateDriver(this.form()));

  ngOnInit(): void {
    const d = this.driver();
    this.form.set(d ? { ...d, firstName: `${d.firstName} ${d.lastName}`.replace(/\s+/g, ' ').trim(), lastName: '' } : { ...EMPTY });
  }
  protected patch<K extends keyof DriverInput>(k: K, v: DriverInput[K]): void { this.form.update((f) => ({ ...f, [k]: v })); }
  protected text(k: 'phone' | 'phoneE164' | 'licenseNumber' | 'licenseExpiresOn' | 'notes', v: string): void { this.patch(k, v || null); }

  /** Se agotó el tiempo y no se pudo comprobar: no se permite repetir hasta saber qué pasó. */
  protected readonly unverified = signal(false);

  /** Lee el estado real: si lo escrito ya está guardado, se da por hecho; si no, se permite reintentar. */
  async verifySaved(): Promise<void> {
    const f = this.form(), name = f.firstName.replace(/\s+/g, ' ').trim();
    try {
      const list = await withTimeout(this.data.listDrivers(), SAVE_TIMEOUT_MS);
      const d = list.find((x) => (f.id ? x.id === f.id : x.operatorCode === f.operatorCode.trim()));
      const same = !!d && `${d.firstName} ${d.lastName}`.replace(/\s+/g, ' ').trim() === name && d.operatorCode === f.operatorCode.trim()
        && d.status === f.status && normalizeWhatsapp(d.phoneE164) === normalizeWhatsapp(f.phoneE164) && (d.notes ?? '') === (f.notes ?? '').trim();
      this.unverified.set(false);
      if (same) { this.error.set(null); this.saved.emit(); }
      else this.error.set('El servidor tardó demasiado y el cambio no aparece guardado. Puedes intentarlo de nuevo.');
    } catch {
      this.unverified.set(true);
      this.error.set('El servidor tardó demasiado y no se pudo comprobar si se guardó. Compruébalo antes de repetirlo.');
    }
  }

  async save(): Promise<void> {
    this.touched.set(true);
    if (this.saving() || this.unverified() || Object.keys(this.errors()).length) return;
    this.saving.set(true);
    this.error.set(null);
    try {
      const f = this.form();
      await withTimeout(this.data.saveDriver({ ...f, firstName: f.firstName.replace(/\s+/g, ' ').trim(), lastName: '' }), SAVE_TIMEOUT_MS);
      this.saved.emit();
    } catch (e) {
      if (timedOut(e)) await this.verifySaved(); else this.error.set(errorMessage(e));
    } finally {
      this.saving.set(false);
    }
  }
}

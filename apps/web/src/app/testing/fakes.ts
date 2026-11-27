/**
 * Dobles de prueba de las INTERFACES (AuthService, DataService, ApiService, Breakpoints).
 * Supabase real no está conectado: las pruebas de componentes usan estos dobles.
 */
import { signal } from '@angular/core';
import type { AuthUser, Role } from '../core/models';
import { ApiService, AuthService, Breakpoints, DataService, type AuthStatus } from '../core/services';

export const testUser = (role: Role = 'super_admin'): AuthUser => ({ userId: 'u1', email: 'admin@example.test', role });

/** Doble de AuthService: instancia única, sin organizaciones ni roles. */
export class FakeAuth extends AuthService {
  status = signal<AuthStatus>('anonymous');
  user = signal<AuthUser | null>(null);
  notice = signal<string | null>(null);
  signedOut = false;
  signInImpl: (e: string, p: string) => Promise<void> = async () => {};
  signIn = vi.fn((e: string, p: string) => this.signInImpl(e, p));
  signOut = vi.fn(async () => { this.signedOut = true; this.status.set('anonymous'); this.user.set(null); });
  requestPasswordReset = vi.fn(async () => {});
  updatePassword = vi.fn(async () => {});
  async ready() {}
  async accessToken() { return 'token'; }
  login(role: Role = 'super_admin') {
    this.status.set('authenticated');
    this.user.set(testUser(role));
    return this;
  }
}

export class FakeBreakpoints extends Breakpoints {
  isMobile = signal(false);
}

/** Doble genérico: cada método es un vi.fn() sobrescribible con mockResolvedValue. */
export function fake<T extends object>(proto: abstract new () => T, overrides: Partial<Record<keyof T, unknown>> = {}): T {
  return new Proxy({} as T, {
    get: (target, prop: string) => {
      if (!(prop in target)) (target as Record<string, unknown>)[prop] = overrides[prop as keyof T] ?? vi.fn(async () => undefined);
      return (target as Record<string, unknown>)[prop];
    },
  });
}
export const fakeApi = (o: Partial<Record<keyof ApiService, unknown>> = {}) => fake(ApiService as abstract new () => ApiService, o);
export const fakeData = (o: Partial<Record<keyof DataService, unknown>> = {}) => fake(DataService as abstract new () => DataService, o);

/** Espera a que terminen las cargas asíncronas (loaders) y refresca la vista. */
export async function settle(f: { detectChanges(): void; whenStable(): Promise<unknown> }, rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) { f.detectChanges(); await f.whenStable(); await new Promise((r) => setTimeout(r, 1)); }
  f.detectChanges();
}
export const typeInto = (el: HTMLElement, sel: string, v: string): void => {
  const i = el.querySelector(sel) as HTMLInputElement;
  i.value = v;
  i.dispatchEvent(new Event('input'));
};
export const click = (el: HTMLElement, sel: string): void => (el.querySelector(sel) as HTMLElement).click();
export const byText = (el: HTMLElement, sel: string, text: string): HTMLButtonElement =>
  Array.from(el.querySelectorAll(sel)).find((b) => b.textContent!.includes(text)) as HTMLButtonElement;

import type { Driver, Unit, WeekDetail, WeeklyRow } from '../core/models';
export const driver = (o: Partial<Driver> = {}): Driver => ({
  id: 'd1', operatorCode: '101', nationalId: '8-123-456', firstName: 'Ana', lastName: 'Pérez', phone: null, phoneE164: null,
  whatsappConsent: false, whatsappConsentSource: null, promotionalConsent: false, promotionalConsentAt: null, licenseNumber: null, licenseExpiresOn: null, remindersPaused: false, remindersPausedReason: null, status: 'active', notes: null, ...o,
});
export const unit = (o: Partial<Unit> = {}): Unit => ({ id: 'u1', code: 'T-1', plate: null, make: null, model: null, year: null, vehicleStatus: 'active', notes: null, agreement: null, agreementNote: null, ...o });
export const wrow = (o: Partial<WeeklyRow> = {}): WeeklyRow => ({
  assignmentId: 'a1', driverId: 'd1', unitId: 'u1', unitCode: 'T-1', operatorCode: '101', nationalId: '8-123-456', fullName: 'Ana Pérez',
  driverStatus: 'active', dailyRateCents: 3600, weekChargedCents: 21600, dayNetCents: [3600, 3600, 0, 0, 0, 0, 0], grossCents: 7300,
  commissionCents: 100, netCents: 7200, weekDiffCents: 0, previousPendingCents: 0, previousCreditCents: 0, openingCents: 0, pendingCents: 14400, creditCents: 0, weekClosed: false, plannedCents: 21600, missingDays: 0, ...o,
});

import type { WhatsappSession } from '../core/models';
/** Sesión de WhatsApp de PRUEBA (estado real de la API ya mapeado). Por defecto: desconectada, worker en línea, envíos en prueba. */
export const waSession = (o: Partial<WhatsappSession> = {}): WhatsappSession => ({
  id: 's1', label: 'Principal', status: 'disconnected', desiredState: 'disconnected', phoneNumber: null, lastError: null, workerHeartbeatAt: '2026-11-16T15:00:00Z',
  statusChangedAt: '2026-11-16T14:00:00Z', workerOnline: true, qrData: null, qrExpiresAt: null, sendingMode: 'test', realTestEnabled: false,
  checkedAt: '2026-11-16T15:00:30Z', updatedAt: '2026-11-16T14:00:00Z', automaticEnabled: false, lastSeenAt: null, sessionPersisted: false, sessionSavedAt: null, logoutPending: false, ...o,
});

/** Detalle semanal de PRUEBA (lunes 16/11/2026): lun pagado, mar parcial, mié pendiente, jue–sáb sin cuota aún (pendiente), dom sin cuota. */
export const wdetail = (o: Partial<WeekDetail> = {}): WeekDetail => ({
  assignmentId: 'a1', previousPendingCents: 0, previousCreditCents: 0,
  days: [
    { date: '2026-11-16', weekday: 1, plannedCents: 3600, chargeGenerated: true, chargeCents: 3600, netPaidCents: 3600, remainingCents: 0, status: 'paid' },
    { date: '2026-11-17', weekday: 2, plannedCents: 3600, chargeGenerated: true, chargeCents: 3600, netPaidCents: 1800, remainingCents: 1800, status: 'partial' },
    { date: '2026-11-18', weekday: 3, plannedCents: 3600, chargeGenerated: true, chargeCents: 3600, netPaidCents: 0, remainingCents: 3600, status: 'pending' },
    { date: '2026-11-19', weekday: 4, plannedCents: 3600, chargeGenerated: true, chargeCents: 3600, netPaidCents: 0, remainingCents: 3600, status: 'pending' },
    { date: '2026-11-20', weekday: 5, plannedCents: 3600, chargeGenerated: true, chargeCents: 3600, netPaidCents: 0, remainingCents: 3600, status: 'pending' },
    { date: '2026-11-21', weekday: 6, plannedCents: 3600, chargeGenerated: true, chargeCents: 3600, netPaidCents: 0, remainingCents: 3600, status: 'pending' },
    { date: '2026-11-22', weekday: 7, plannedCents: 0, chargeGenerated: false, chargeCents: 0, netPaidCents: 0, remainingCents: 0, status: 'no_charge' },
  ], ...o,
});

/** Botón o enlace por su nombre accesible (aria-label; acepta un sufijo: «Editar horario X» coincide con «Editar horario»). `sel` acota la búsqueda ('' = todo). */
export const byLabel = (el: HTMLElement, sel: string, label: string): HTMLButtonElement => {
  const scopes: ParentNode[] = sel ? Array.from(el.querySelectorAll(sel)) : [el];
  for (const sc of scopes) {
    const hit = Array.from(sc.querySelectorAll<HTMLButtonElement>('button[aria-label], a[aria-label]')).find((b) => { const a = b.getAttribute('aria-label')!; return a === label || a.startsWith(label + ' '); });
    if (hit) return hit;
  }
  throw new Error(`No hay botón «${label}» en «${sel || 'el documento'}»`);
};

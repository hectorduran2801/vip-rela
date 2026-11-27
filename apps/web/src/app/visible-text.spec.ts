import { Type } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { SAVE_FILE } from './core/download';
import { KNOWN_AUDIT_ACTIONS, KNOWN_AUDIT_ENTITIES } from './core/audit-labels';
import { KNOWN_WARNING_BASES } from './core/import-warnings';
import type { AuditEntry, CollectionMessage, CollectionRow, ImportRow, MatchStatus, TestMessage, TestMessageStatus } from './core/models';
import { ApiService, AuthService, Breakpoints, DataService } from './core/services';
import { Collection } from './features/collection/collection';
import { MessageHistory } from './features/messaging/message-history';
import { Audit } from './features/settings/audit';
import { WhatsappTest } from './features/messaging/whatsapp-test';
import { Users } from './features/settings/users';
import { Drivers } from './features/drivers/drivers';
import { FakeAuth, FakeBreakpoints, driver, fakeApi, fakeData, settle, waSession } from './testing/fakes';

/**
 * Barrido de TEXTO VISIBLE: renderiza pantallas con datos de prueba que cubren todos los estados y falla si aparece una clave técnica
 * (snake_case, códigos de API, estados en inglés) fuera del «Detalle técnico» plegado. Se ejecuta en escritorio y en móvil.
 */
const ENGLISH = /\b(pending|matched|unmatched|approved|rejected|previewed|confirmed|applied|failed|processing|prepared|simulated|delivered|cancelled|unconfirmed|insert|update|delete|undefined|null|NaN|true|false|created|skipped|duplicate|conflict|ignored|warning|loading)\b|\[object Object\]/;
const SNAKE = /\b[a-z]{2,}_[a-z0-9_]+\b/;

function visibleText(el: HTMLElement): string {
  const c = el.cloneNode(true) as HTMLElement;
  c.querySelectorAll('details.tech, details.err-detail, code, pre, script, style, svg, .sr-only').forEach((n) => n.remove());
  c.querySelectorAll('select').forEach((s) => s.querySelectorAll('option').forEach((o) => { o.textContent = o.textContent ?? ''; }));
  return c.textContent!.replace(/\s+/g, ' ');
}
function assertClean(el: HTMLElement, where: string): void {
  const t = visibleText(el);
  const a = SNAKE.exec(t), b = ENGLISH.exec(t);
  expect(a ? `${where}: clave técnica «${a[0]}» en «…${t.slice(Math.max(0, a.index - 40), a.index + 50)}…»` : null, where).toBeNull();
  expect(b ? `${where}: texto en inglés «${b[0]}» en «…${t.slice(Math.max(0, b.index - 40), b.index + 50)}…»` : null, where).toBeNull();
}

async function render<T>(cmp: Type<T>, providers: unknown[], mobile: boolean, inputs: Record<string, unknown> = {}) {
  const bp = new FakeBreakpoints(); bp.isMobile.set(mobile);
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [provideRouter([]), { provide: Breakpoints, useValue: bp }, { provide: SAVE_FILE, useValue: () => undefined }, ...providers] as never[] });
  const f = TestBed.createComponent(cmp);
  for (const [k, v] of Object.entries(inputs)) f.componentRef.setInput(k, v);
  await settle(f);
  return { f, el: f.nativeElement as HTMLElement };
}
const auth = (role: 'admin' | 'super_admin' = 'super_admin') => ({ provide: AuthService, useValue: new FakeAuth().login(role) });

const MATCHES: MatchStatus[] = ['unmatched', 'matched', 'conflict', 'duplicate', 'ignored'];
const importRow = (i: number, o: Partial<ImportRow> = {}): ImportRow => ({ id: `r${i}`, blockIndex: 0, sourceRow: i + 2, unitCode: `T-${i}`, operatorCode: `${100 + i}`, nationalId: `8-${i}-1`, fullName: `Conductor ${i}`, firstName: null, lastName: null, phoneE164: null,
  rowStatus: null, dailyRateCents: 3900, rawAgreement: null, rawSaldo: null, dayAmountsCents: [4500, 3900, 5000, 3900, 6000, 4000, 2000], warnings: [], matchStatus: MATCHES[i % 5]!, reviewStatus: 'pending', appliedAction: null, appliedNote: null,
  changes: null, consentRequest: null, consentOrigin: null, blockId: 'b1', rawPhone: null, saldoState: null, saldoCents: null, ...o });
const ALL_WARNINGS = [...KNOWN_WARNING_BASES.filter((w) => w !== 'placeholder'), 'amount_over_rate:monday', 'amount_over_rate:saturday', 'atypical_formula:weekly_expected', 'consent_ignored:missing_origin', 'consent_ignored:no_driver',
  'formula_ref_error:rate', 'error_value:saldo', 'text_in_numeric_cell:monday', 'filled_from_existing:unit', 'invalid_rate:weekly', 'fixed_value_instead_of_formula:weekly_diff', 'placeholder_full_name'];

const SCREENS: { name: string; run: (mobile: boolean) => Promise<HTMLElement> }[] = [
  { name: 'Auditoría (todas las acciones y entidades)', run: async (m) => {
    const entries: AuditEntry[] = KNOWN_AUDIT_ACTIONS.concat('whatsapp.test_message.sent', 'whatsapp.test_message.unconfirmed').map((a, i) => ({ id: i, actor: i % 2 ? 'a1b2c3d4-0000' : null, action: a, entity: KNOWN_AUDIT_ENTITIES[i % KNOWN_AUDIT_ENTITIES.length]!, entityId: null, detail: { x: 1 }, at: '2026-11-16T15:00:00Z' }));
    return (await render(Audit, [{ provide: DataService, useValue: fakeData({ listAudit: vi.fn(async () => entries) }) }], m)).el;
  } },
  { name: 'Cobranza (unidades y mensajes)', run: async (m) => {
    const row = (o: Partial<CollectionRow> = {}): CollectionRow => ({ assignmentId: 'a1', driverId: 'd1', unitCode: 'T-1', operatorCode: '101', fullName: 'Ana Pérez', driverStatus: 'active', phone: '+50760000001', dailyRateCents: 3600, paidTodayCents: 0, paidWeekCents: 1000, pendingCents: 2600,
      creditCents: 0, previousPendingCents: 0, agreement: null, saldoSource: 'excel', saldoMissing: false, saldoWeek: '2026-11-23', ended: false, days: [{ date: '2026-11-23', dueCents: 3000, paidCents: 3000 }, { date: '2026-11-24', dueCents: 3000, paidCents: 2500 }, { date: '2026-11-25', dueCents: 0, paidCents: 0 }], totalCents: 10500, collectCommission: true, commissionCents: 0, messagesToday: [{ id: 'm1', template: 'Cobro', status: 'delivered', at: '2026-11-16T15:00:00Z', body: 'Hola', error: null }, { id: 'm2', template: 'Aviso', status: 'failed', at: '2026-11-16T16:00:00Z', body: 'Otro', error: 'falló' }], ...o });
    const api = fakeApi({ collectionBoard: vi.fn(async () => [row(), row({ assignmentId: 'a2', unitCode: 'T-2', phone: null, messagesToday: [] })]) });
    return (await render(Collection, [auth('admin'), { provide: ApiService, useValue: api }, { provide: DataService, useValue: fakeData({ listTemplates: vi.fn(async () => []) }) }], m)).el;
  } },
  { name: 'Historial de mensajes', run: async (m) => {
    const st: TestMessageStatus[] = ['prepared', 'processing', 'simulated', 'sent', 'delivered', 'failed', 'unconfirmed', 'cancelled'];
    const list: CollectionMessage[] = st.map((s, i) => ({ id: `m${i}`, template: 'Cobro', status: s, body: 'Hola', error: s === 'failed' ? 'Falló el envío' : null, at: '2026-11-16T15:00:00Z', phone: '+50760000001', operatorCode: '101', name: 'Ana Pérez', unitCode: 'T-1', sentBy: 'Admin', importFile: 'DATOS.xlsx', importAppliedAt: '2026-11-16T15:00:00Z', variables: { unidad: 'T-1' }, batchId: 'lote-1' }));
    return (await render(MessageHistory, [{ provide: ApiService, useValue: fakeApi({ collectionBatches: vi.fn(async () => []), collectionMessages: vi.fn(async () => list) }) }], m)).el;
  } },
  { name: 'Mensaje de prueba externo: historial con los 8 estados', run: async (m) => {
    const st: TestMessageStatus[] = ['prepared', 'processing', 'simulated', 'sent', 'delivered', 'failed', 'unconfirmed', 'cancelled'];
    const list: TestMessage[] = st.map((s, i) => ({ id: `t${i}`, kind: 'test', recipientPhone: '+50760009999', body: 'Hola', requestedMode: i % 2 ? 'real' : 'simulated', status: s, senderPhone: null, providerMessageId: null, error: 'boom_error', recipientAuthorization: null,
      createdAt: '2026-11-16T15:00:00Z', processedAt: null, deliveredAt: null, authorizedBy: null, claimedAt: null, errorDetail: 'stack_trace', resolvedBy: null, resolvedAt: null, resolutionNote: null }));
    const api = fakeApi({ whatsappSession: vi.fn(async () => waSession({ status: 'connected' })), whatsappTestList: vi.fn(async () => list) });
    return (await render(WhatsappTest, [auth(), { provide: ApiService, useValue: api }, { provide: DataService, useValue: fakeData() }], m)).el;
  } },
  { name: 'Usuarios y roles', run: async (m) => {
    const api = fakeApi({ listUsers: vi.fn(async () => [{ userId: 'u1', email: 'a@x.co', fullName: 'A', role: 'super_admin', createdAt: '2026-01-01T00:00:00Z', suspendedAt: null }, { userId: 'u2', email: 'b@x.co', fullName: 'B', role: 'supervisor', createdAt: '2026-01-01T00:00:00Z', suspendedAt: '2026-02-01T00:00:00Z' }]),
      listInvites: vi.fn(async () => [{ email: 'c@x.co', role: 'admin', createdAt: '2026-11-16T10:00:00Z', expiresAt: '2026-11-16T22:00:00Z', consumedAt: null }]) });
    return (await render(Users, [auth(), { provide: ApiService, useValue: api }], m)).el;
  } },
  { name: 'Conductores (estados y autorizaciones)', run: async (m) => {
    const list = [driver({ whatsappConsent: true, whatsappConsentSource: 'legacy_unverified', phoneE164: '+50760000001' }), driver({ id: 'd2', status: 'suspended', remindersPaused: true }), driver({ id: 'd3', status: 'pending_approval' }), driver({ id: 'd4', status: 'inactive' })];
    return (await render(Drivers, [auth(), { provide: DataService, useValue: fakeData({ listDrivers: vi.fn(async () => list) }) }], m)).el;
  } },
];

describe.each([['escritorio', false], ['móvil', true]] as const)('Texto visible sin claves técnicas ni inglés (%s)', (_n, mobile) => {
  it.each(SCREENS.map((s) => [s.name, s] as const))('%s', async (_name, s) => {
    const el = await s.run(mobile);
    expect(visibleText(el).length).toBeGreaterThan(40);
    assertClean(el, `${s.name} (${mobile ? 'móvil' : 'escritorio'})`);
  });
});

describe('El barrido detecta lo que debe', () => {
  it('falla ante una clave técnica o un estado en inglés', () => {
    const div = document.createElement('div');
    div.innerHTML = '<p>Estado: pending </p><p> skipped_paid </p><details class="tech"><summary>Detalle técnico</summary><code>amount_over_rate:monday</code></details>';
    const t = visibleText(div);
    expect(ENGLISH.test(t)).toBe(true);
    expect(SNAKE.test(t)).toBe(true);
    div.innerHTML = '<p>Estado: Pendiente</p><details class="tech"><code>skipped_paid</code></details>';
    expect(ENGLISH.test(visibleText(div)) || SNAKE.test(visibleText(div))).toBe(false);
  });
});

/* ───────── Barrido ampliado: el resto de pantallas, con los 4 estados (datos, vacío, error, cargando) ───────── */
import { ApiError } from './core/errors';
import { Assignments } from './features/assignments/assignments';
import { Dashboard } from './features/dashboard/dashboard';
import { Login } from './features/login/login';
import { Profile } from './features/profile/profile';
import { Templates } from './features/messaging/templates';
import { Settings } from './features/settings/settings';
import { Technical } from './features/settings/technical';
import { Units } from './features/units/units';

type Kind = 'datos' | 'vacío' | 'error' | 'cargando';
const KINDS: Kind[] = ['datos', 'vacío', 'error', 'cargando'];
const never = () => new Promise<never>(() => undefined);
const boom = () => Promise.reject(new ApiError('api_unreachable', 0));
/** Devuelve el valor según el estado: datos / vacío / error de red / pendiente (skeleton). */
const by = <T,>(k: Kind, data: T, empty: T) => vi.fn(async () => (k === 'datos' ? data : k === 'vacío' ? empty : k === 'error' ? await boom() : await never())) as unknown as () => Promise<T>;

const A = { id: 'a1', driverId: 'd1', unitId: 'u1', unitCode: 'T-1', operatorCode: '101', driverName: 'Ana Pérez', validFrom: '2026-01-01', validTo: null, agreementNote: 'Acuerdo', dailyRateCents: 3600 };
const UNIT = { id: 'u1', code: 'T-1', plate: 'AB-123', make: 'Toyota', model: 'Corolla', year: 2020, vehicleStatus: 'maintenance' as const, notes: null, agreement: 'CUSTODIA', agreementNote: null };
const SUMMARY = { from: '2026-11-16', to: '2026-11-22', chargesGeneratedCents: 100, adjustmentsChargedCents: 0, expectedCents: 100, paymentsCount: 1, grossCents: 100, commissionCents: 0, netCents: 100, appliedCents: 100, appliedToPeriodCents: 100, priorDebtRecoveredCents: 0,
  creditsGeneratedCents: 0, pendingEndCents: 0, creditsEndCents: 0, driversWithDebtEnd: 0, differenceCents: 0, recoveryPct: 100 };

const MORE: { name: string; run: (m: boolean, k: Kind) => Promise<HTMLElement> }[] = [
  { name: 'Unidades', run: async (m, k) => (await render(Units, [auth(), { provide: DataService, useValue: fakeData({ listUnits: by(k, [UNIT], []), listAssignments: by(k, [A], []) }) }], m)).el },
  { name: 'Plantillas', run: async (m, k) => (await render(Templates, [auth(), { provide: ApiService, useValue: fakeApi() }, { provide: DataService, useValue: fakeData({ listTemplates: by(k, [{ id: 't', name: 'Cobro', body: 'Hola {{nombre}}' }], []), listAssignments: by(k, [A], []) }) }], m)).el },
  { name: 'Perfil', run: async (m) => (await render(Profile, [auth('admin'), { provide: ApiService, useValue: fakeApi({ myProfile: vi.fn(async () => ({ fullName: 'Ana Pérez' })) }) }], m)).el },
  { name: 'Configuración técnica', run: async (m, k) => (await render(Technical, [auth(), { provide: ApiService, useValue: fakeApi({ whatsappSession: by(k, waSession({ status: 'connected', workerOnline: false }), waSession()) }) }], m)).el },
  { name: 'Configuración (inicio)', run: async (m) => (await render(Settings, [auth()], m)).el },
  { name: 'Asignaciones', run: async (m, k) => (await render(Assignments, [auth(), { provide: ApiService, useValue: fakeApi() }, { provide: DataService, useValue: fakeData({ listAssignments: by(k, [A, { ...A, id: 'a0', validTo: '2026-02-01' }], []), listDrivers: by(k, [driver()], []), listUnits: by(k, [UNIT], []) }) }], m)).el },
  { name: 'Inicio', run: async (m, k) => (await render(Dashboard, [auth(), { provide: ApiService, useValue: fakeApi({ dashboard: by(k, {
    drivers: { total: 3, active: 2, inactive: 0, suspended: 1, pending_approval: 0 }, collections: { pending_total_cents: 100, drivers_with_debt: 1, collected_today_gross_cents: 0, collected_today_commission_cents: 0, collected_today_net_cents: 0, week_charged_cents: 0, week_net_cents: 0, credits_total_cents: 0 },
    by_method: [{ method_code: 'metodo_raro', payments: 1, gross_cents: 100, commission_cents: 0, net_cents: 100 }], reminders: { scheduled_today: 0, pending_total: 0 }, whatsapp: { sessions: [{ id: 'w', label: 'Principal', status: 'connected' }] } } as never,
    { drivers: { total: 0, active: 0, inactive: 0, suspended: 0, pending_approval: 0 }, collections: { pending_total_cents: 0, drivers_with_debt: 0, collected_today_gross_cents: 0, collected_today_commission_cents: 0, collected_today_net_cents: 0, week_charged_cents: 0, week_net_cents: 0, credits_total_cents: 0 }, by_method: [], reminders: { scheduled_today: 0, pending_total: 0 }, whatsapp: { sessions: [] } } as never) }) }], m)).el },
];

describe.each([['escritorio', false], ['móvil', true]] as const)('Barrido ampliado sin claves técnicas ni inglés (%s)', (_n, mobile) => {
  for (const s of MORE) {
    it.each(KINDS.map((k) => [`${s.name} · ${k}`, k] as const))(`%s`, async (_name, k) => {
      const el = await s.run(mobile, k);
      expect(visibleText(el).length).toBeGreaterThan(8);
      assertClean(el, `${s.name} · ${k} (${mobile ? 'móvil' : 'escritorio'})`);
    });
  }
  it('Inicio de sesión (con aviso de error y sin configurar)', async () => {
    for (const mode of ['normal', 'sin configurar'] as const) {
      const a = new FakeAuth(); if (mode === 'sin configurar') a.status.set('unconfigured'); else a.notice.set('Esta cuenta no está autorizada para usar VIP');
      const { el } = await render(Login, [{ provide: AuthService, useValue: a }], mobile);
      assertClean(el, `Login · ${mode} (${mobile ? 'móvil' : 'escritorio'})`);
      expect(visibleText(el)).toContain('Iniciar sesión');
    }
  });
});

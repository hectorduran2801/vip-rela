import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { ApiError } from './errors';
import { HttpApiService } from './http-api.service';

/** Contrato de la API /api/v1: rutas, métodos y cuerpos; NINGUNA lleva organizationId. */
describe('HttpApiService (contrato de la API, sin organizationId)', () => {
  let api: HttpApiService;
  let http: HttpTestingController;
  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [HttpApiService, provideHttpClient(), provideHttpClientTesting()] });
    api = TestBed.inject(HttpApiService);
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());

  async function expectCall<T>(p: Promise<T>, method: string, url: string, reply: unknown, body?: unknown): Promise<T> {
    await Promise.resolve();
    const req = http.expectOne(url);
    expect(req.request.method).toBe(method);
    if (body !== undefined) expect(req.request.body).toEqual(body);
    expect(JSON.stringify(req.request.body ?? '') + req.request.url).not.toMatch(/organization/i);
    req.flush(reply as object);
    return p;
  }

  it('GET /me', async () => {
    expect(await expectCall(api.me(), 'GET', '/api/v1/me', { userId: 'u', email: 'a@x.co', authorized: true })).toEqual({ userId: 'u', email: 'a@x.co', authorized: true });
  });
  it('GET /dashboard sin parámetros', async () => { await expectCall(api.dashboard(), 'GET', '/api/v1/dashboard', {}); });
  it('GET /weekly-collection?weekStart= mapea snake_case y centavos', async () => {
    const r = await expectCall(api.weeklyCollection('2026-11-16'), 'GET', '/api/v1/weekly-collection?weekStart=2026-11-16', [{
      assignment_id: 'a1', driver_id: 'd1', unit_id: 'u1', unit_code: 'T-1', operator_code: '101', national_id: '8-1', full_name: 'Ana', driver_status: 'active',
      daily_rate_cents: '3600', week_charged_cents: '21600', day_net_cents: ['3600', 0, 0, 0, 0, 0, 0], gross_cents: 3700, commission_cents: 100, net_cents: 3600,
      week_diff_cents: -18000, previous_pending_cents: '11900', previous_credit_cents: 0, opening_cents: 11900, pending_cents: 18000, credit_cents: 0, week_closed: false, planned_cents: '25500', missing_days: 2 }]);
    expect(r[0]).toMatchObject({ assignmentId: 'a1', dailyRateCents: 3600, dayNetCents: [3600, 0, 0, 0, 0, 0, 0], pendingCents: 18000, previousPendingCents: 11900, previousCreditCents: 0, openingCents: 11900, plannedCents: 25500, missingDays: 2 });
  });
  it('GET /weekly-collection/detail?weekStart=&assignmentId= mapea los días (lunes a domingo) y el saldo anterior', async () => {
    const reply = [{ assignment_id: 'a1', previous_pending_cents: '1200', previous_credit_cents: 0,
      days: [{ date: '2026-11-16', weekday: 1, planned_cents: 3600, charge_generated: true, charge_cents: 3600, net_paid_cents: 1800, remaining_cents: 1800, status: 'partial' }, { date: '2026-11-22', weekday: 7, planned_cents: 0, charge_generated: false, charge_cents: 0, net_paid_cents: 0, remaining_cents: 0, status: 'no_charge' }] }];
    const r = await expectCall(api.weeklyCollectionDetail('2026-11-16', 'a1'), 'GET', '/api/v1/weekly-collection/detail?weekStart=2026-11-16&assignmentId=a1', reply);
    expect(r).toEqual([{ assignmentId: 'a1', previousPendingCents: 1200, previousCreditCents: 0, days: [
      { date: '2026-11-16', weekday: 1, plannedCents: 3600, chargeGenerated: true, chargeCents: 3600, netPaidCents: 1800, remainingCents: 1800, status: 'partial' },
      { date: '2026-11-22', weekday: 7, plannedCents: 0, chargeGenerated: false, chargeCents: 0, netPaidCents: 0, remainingCents: 0, status: 'no_charge' }] }]);
  });
  it('GET /weekly-collection/detail sin assignmentId pide todas las asignaciones de la semana', async () => {
    expect(await expectCall(api.weeklyCollectionDetail('2026-11-16'), 'GET', '/api/v1/weekly-collection/detail?weekStart=2026-11-16', [])).toEqual([]);
  });
  it('consentimiento: PUT /drivers/:id/consent con origen y referencia; la respuesta trae cancelled_jobs', async () => {
    const r = await expectCall(api.setDriverConsent('d1', { purpose: 'collection', granted: true, source: 'signed_form', evidence: 'Folio 12' }), 'PUT', '/api/v1/drivers/d1/consent',
      { driver_id: 'd1', purpose: 'collection', granted: true, cancelled_jobs: 0 }, { purpose: 'collection', granted: true, source: 'signed_form', evidence: 'Folio 12' });
    expect(r).toEqual({ driverId: 'd1', purpose: 'collection', granted: true, cancelledJobs: 0 });
  });
  it('retirar: el cuerpo no lleva origen y se devuelven los recordatorios cancelados', async () => {
    const r = await expectCall(api.setDriverConsent('d1', { purpose: 'collection', granted: false }), 'PUT', '/api/v1/drivers/d1/consent',
      { driver_id: 'd1', purpose: 'collection', granted: false, cancelled_jobs: 4 }, { purpose: 'collection', granted: false });
    expect(r.cancelledJobs).toBe(4);
  });
  it('GET /drivers/:id/consents mapea el historial', async () => {
    const r = await expectCall(api.driverConsents('d1'), 'GET', '/api/v1/drivers/d1/consents', [{ id: 7, purpose: 'promotional', granted: true, source: 'other', evidence: null, recorded_by: 'u1', recorded_at: '2026-11-16T10:00:00Z' }]);
    expect(r).toEqual([{ id: '7', purpose: 'promotional', granted: true, source: 'other', evidence: null, recordedBy: 'u1', recordedAt: '2026-11-16T10:00:00Z' }]);
  });
  it('pagos: preview, registrar (con notes) y anular', async () => {
    await expectCall(api.previewPayment({ assignmentId: 'a1', methodCode: 'cash', grossCents: 3600 }), 'POST', '/api/v1/payments/preview', {}, { assignmentId: 'a1', methodCode: 'cash', grossCents: 3600 });
    const req = { assignmentId: 'a1', methodCode: 'cash', grossCents: 3600, idempotencyKey: 'k-1', notes: 'Verificado', sendReceipt: false };
    await expectCall(api.registerPayment(req), 'POST', '/api/v1/payments', {}, req);
    await expectCall(api.voidPayment('p1', 'Error'), 'POST', '/api/v1/payments/p1/void', {}, { reason: 'Error' });
  });
  it('ajustes y cerrar semana solo llevan sus datos', async () => {
    const adj = { assignmentId: 'a1', amountCents: 500, effectiveDate: '2026-11-16', reason: 'Descuento', idempotencyKey: 'k' };
    await expectCall(api.createAdjustment(adj), 'POST', '/api/v1/adjustments', {}, adj);
    await expectCall(api.closeWeek('2026-11-16'), 'POST', '/api/v1/weeks/close', {}, { weekStart: '2026-11-16' });
  });
  it('eliminar / dar de baja / reactivar: delete-check, DELETE con ?reason= sin cuerpo, archive y reactivate; el 409 conserva blockers', async () => {
    const c = await expectCall(api.deleteCheck('drivers', 'd1'), 'GET', '/api/v1/drivers/d1/delete-check', { can_delete: false, blocked_by: ['payments'], blockers: { payments: 2 }, will_delete: {}, active_assignments: [], suggestion: 'archive' });
    expect(c).toMatchObject({ canDelete: false, blockers: { payments: 2 }, suggestion: 'archive' });
    const d = await expectCall(api.deleteEntity('units', 'u1', ' Duplicada '), 'DELETE', '/api/v1/units/u1?reason=Duplicada', { deleted: true, deleted_counts: { rates: 1 } });
    expect(d).toEqual({ deleted: true, deletedCounts: { rates: 1 } });
    const ar = await expectCall(api.archiveEntity('drivers', 'd1', { reason: 'Baja', effectiveDate: '2026-11-20' }), 'POST', '/api/v1/drivers/d1/archive', { archived: true, ended_assignments: [{}], charges_completed: 2, cancelled_jobs: 1, cancelled_messages: 0, pending_cents: 500 }, { reason: 'Baja', effectiveDate: '2026-11-20' });
    expect(ar).toMatchObject({ archived: true, chargesCompleted: 2, cancelledJobs: 1, pendingCents: 500 });
    expect(await expectCall(api.reactivateEntity('units', 'u1'), 'POST', '/api/v1/units/u1/reactivate', { reactivated: true, has_active_assignment: true }, {})).toEqual({ reactivated: true, hasActiveAssignment: true });
    const p = api.deleteEntity('drivers', 'd1'); await Promise.resolve();
    http.expectOne('/api/v1/drivers/d1').flush({ error: 'delete_blocked_has_history', blockers: { payments: 1 }, suggestion: 'archive' }, { status: 409, statusText: 'Conflict' });
    await expect(p).rejects.toMatchObject({ code: 'delete_blocked_has_history', payload: { blockers: { payments: 1 } } });
  });
  it('horarios con plantilla: texto base, crear desde el texto base y uso de una plantilla', async () => {
    const d = await expectCall(api.defaultTemplates(), 'GET', '/api/v1/schedules/default-templates', [{ kind: 'debt_first', suggested_name: 'Primer recordatorio', body: 'Buenos días' }]);
    expect(d).toEqual([{ kind: 'debt_first', suggestedName: 'Primer recordatorio', body: 'Buenos días' }]);
    expect(await expectCall(api.templateFromDefault({ kind: 'debt_first', name: 'Base', scheduleId: 's1' }), 'POST', '/api/v1/templates/from-default', { id: 't9', name: 'Base', body: 'x' }, { kind: 'debt_first', name: 'Base', scheduleId: 's1' })).toEqual({ id: 't9', name: 'Base', body: 'x' });
    expect(await expectCall(api.templateUsage('t9'), 'GET', '/api/v1/templates/t9/usage', [{ id: 's1', kind: 'debt_first', label: 'Primero', local_time: '11:00:00', weekdays: [1, 2], enabled: true }])).toEqual([{ id: 's1', kind: 'debt_first', label: 'Primero', localTime: '11:00', weekdays: [1, 2], enabled: true }]);
  });
  it('activación explícita de horarios: vista previa, activar con confirm:true y desactivar', async () => {
    const r = await expectCall(api.activationPreview('s1'), 'GET', '/api/v1/schedules/s1/activation-preview', { schedule: { id: 's1', kind: 'debt_first', label: 'Primero', local_time: '16:20:00', weekdays: [1, 2], scope: 'total', enabled: false, timezone: 'America/Panama', armed_at: '2026-11-16T20:00:00Z', next_occurrence: '2026-11-17T21:20:00Z', next_occurrence_local: '2026-11-17 16:20', deactivated_reason: 'config_changed', deactivated_at: '2026-11-16T19:00:00Z', next_is_today: true, minutes_until_next: 25 },
      template: { id: 't1', name: 'Cobro', body: 'x' }, text_example: 'Hola', uses_variables: ['nombre'], unknown_variables: [], eligible_drivers: null, eligible_drivers_reason: 'sin datos', can_activate: true, blockers: [] });
    expect(r).toMatchObject({ schedule: { localTime: '16:20', timezone: 'America/Panama', armedAt: '2026-11-16T20:00:00Z', nextOccurrence: '2026-11-17T21:20:00Z', nextOccurrenceLocal: '2026-11-17 16:20' }, nextIsToday: true, minutesUntilNext: 25, deactivatedReason: 'config_changed', deactivatedAt: '2026-11-16T19:00:00Z', template: { name: 'Cobro' }, textExample: 'Hola', eligibleDrivers: null, eligibleReason: 'sin datos', canActivate: true });
    await expectCall(api.activateSchedule('s1'), 'POST', '/api/v1/schedules/s1/activate', {}, { confirm: true });
    await expectCall(api.deactivateSchedule('s1'), 'POST', '/api/v1/schedules/s1/deactivate', {}, {});
  });
  it('POST /charges/ensure y GET /charges/gaps: mapean la recuperación de cuotas y los huecos', async () => {
    const gap = { assignment_id: 'a1', unit_code: '4321', operator_code: '77', driver_name: 'Ana', gap_date: '2026-11-10', planned_cents: 4000, reason: 'outside_window' };
    const r = await expectCall(api.ensureCharges({ from: '2026-11-10', through: '2026-11-16' }), 'POST', '/api/v1/charges/ensure', { created: 2, from: '2026-11-10', to: '2026-11-16', days_checked: 7, skipped: null, gaps: [gap], gaps_total: 1, recovery_days: 14 }, { from: '2026-11-10', through: '2026-11-16' });
    expect(r).toEqual({ created: 2, from: '2026-11-10', to: '2026-11-16', daysChecked: 7, skipped: null, gapsTotal: 1, recoveryDays: 14,
      gaps: [{ assignmentId: 'a1', unitCode: '4321', operatorCode: '77', driverName: 'Ana', gapDate: '2026-11-10', plannedCents: 4000, reason: 'outside_window' }] });
    const g = await expectCall(api.chargeGaps('2026-11-16'), 'GET', '/api/v1/charges/gaps?through=2026-11-16', [gap]);
    expect(g[0]).toMatchObject({ unitCode: '4321', plannedCents: 4000, reason: 'outside_window' });
    await expectCall(api.ensureCharges(), 'POST', '/api/v1/charges/ensure', { created: 0, from: 'a', to: 'b', days_checked: 0, skipped: 'locked', gaps: [], gaps_total: 0, recovery_days: 14 }, {});
  });
  it('historial de tarifas: por asignación y global; cambio de tarifa con motivo', async () => {
    const row = { rate_id: 'r2', assignment_id: 'a1', unit_id: 'u1', unit_code: '4321', driver_id: 'd1', operator_code: '77', driver_name: 'Ana', previous_rate_id: 'r1', previous_daily_cents: 4000, new_daily_cents: 4500,
      valid_from: '2026-11-19', previous_valid_to: '2026-11-18', valid_to: null, changed_by: 'u9', changed_by_name: 'Admin', changed_at: '2026-11-16T15:00:00Z', reason: 'Ajuste', is_current: true };
    const r = await expectCall(api.rateHistory('a1'), 'GET', '/api/v1/assignments/a1/rate-history', [row]);
    expect(r[0]).toMatchObject({ rateId: 'r2', previousDailyCents: 4000, newDailyCents: 4500, validFrom: '2026-11-19', validTo: null, changedByName: 'Admin', reason: 'Ajuste', isCurrent: true });
    await expectCall(api.rateHistory(), 'GET', '/api/v1/rate-history', []);
    const c = await expectCall(api.changeRate('a1', 4500, '2026-11-19', ' Ajuste '), 'POST', '/api/v1/assignments/a1/rate', { assignment_id: 'a1', rate_id: 'r2', from: '2026-11-19', previous_daily_cents: 4000, new_daily_cents: 4500, existing_charges_from_date_unchanged: 0 }, { dailyCents: 4500, from: '2026-11-19', reason: 'Ajuste' });
    expect(c).toMatchObject({ rateId: 'r2', previousDailyCents: 4000, newDailyCents: 4500 });
  });
  it('avisos: approve / edit / discard', async () => {
    await expectCall(api.reviewNotification('n1', 'edit', 'Hola'), 'POST', '/api/v1/notifications/n1/review', {}, { action: 'edit', body: 'Hola' });
    await expectCall(api.reviewNotification('n1', 'discard'), 'POST', '/api/v1/notifications/n1/review', {}, { action: 'discard' });
  });
  it('WhatsApp: UNA sola sesión; estado real mapeado y connect/disconnect devuelven requested + estado', async () => {
    const full = { id: 's', label: 'Principal', status: 'awaiting_scan', desired_state: 'connected', phone_number: null, last_error: null, worker_heartbeat_at: '2026-11-16T15:00:00Z', status_changed_at: '2026-11-16T15:00:00Z', worker_online: true, qr_data: 'abc', qr_expires_at: '2026-11-16T15:01:00Z', sending_mode: 'test', real_test_enabled: false, checked_at: '2026-11-16T15:00:31Z', updated_at: '2026-11-16T15:00:00Z', last_seen_at: '2026-11-16T14:59:00Z', session_persisted: true, session_saved_at: '2026-11-16T14:00:00Z', logout_pending: false };
    const s = await expectCall(api.whatsappSession(), 'GET', '/api/v1/whatsapp/session', full);
    expect(s).toEqual({ id: 's', label: 'Principal', status: 'awaiting_scan', desiredState: 'connected', phoneNumber: null, lastError: null, workerHeartbeatAt: '2026-11-16T15:00:00Z', statusChangedAt: '2026-11-16T15:00:00Z', workerOnline: true, qrData: 'abc', qrExpiresAt: '2026-11-16T15:01:00Z', sendingMode: 'test', realTestEnabled: false, checkedAt: '2026-11-16T15:00:31Z', updatedAt: '2026-11-16T15:00:00Z', lastSeenAt: '2026-11-16T14:59:00Z', sessionPersisted: true, sessionSavedAt: '2026-11-16T14:00:00Z', logoutPending: false, automaticEnabled: false });
    const c = await expectCall(api.whatsappConnect(), 'POST', '/api/v1/whatsapp/session/connect', { requested: true, ...full, status: 'disconnected', worker_online: false, qr_data: null });
    expect(c).toMatchObject({ requested: true, status: 'disconnected', workerOnline: false, qrData: null });
    const d = await expectCall(api.whatsappDisconnect(), 'POST', '/api/v1/whatsapp/session/disconnect', { requested: true, ...full, desired_state: 'disconnected' });
    expect(d).toMatchObject({ requested: true, desiredState: 'disconnected' });
    const l = await expectCall(api.whatsappLogout(), 'POST', '/api/v1/whatsapp/session/logout', { requested: true, ...full, desired_state: 'disconnected', logout_pending: true, session_persisted: false });
    expect(l).toMatchObject({ requested: true, logoutPending: true, sessionPersisted: false });
  });
  it('WhatsApp: modo de envío desconocido si la API no lo informa', async () => {
    const s = await expectCall(api.whatsappSession(), 'GET', '/api/v1/whatsapp/session', { status: 'connected', worker_online: false });
    expect(s).toMatchObject({ sendingMode: 'unknown', realTestEnabled: false, workerOnline: false });
  });
  it('mensajes de prueba (SUPER_ADMIN): vista previa, envío, historial, cancelar y comprobante', async () => {
    const p = await expectCall(api.whatsappTestPreview('6000-0000', 'Hola'), 'POST', '/api/v1/whatsapp/test-messages/preview',
      { recipient: '+50760000000', invalid_phone: false, recipient_is_a_driver: true, body: 'Hola', chars: 4, sender: '+50761112222', session_status: 'connected', sending_mode: 'test', real_test_enabled: false }, { phone: '6000-0000', body: 'Hola' });
    expect(p).toEqual({ recipient: '+50760000000', invalidPhone: false, recipientIsADriver: true, body: 'Hola', chars: 4, sender: '+50761112222', sessionStatus: 'connected', sendingMode: 'test', realTestEnabled: false });
    const row = { id: 'm1', kind: 'test', recipient_phone: '+50760000000', body: 'Hola', requested_mode: 'simulated', status: 'prepared', sender_phone: null, provider_message_id: null, error: null, recipient_authorization: null, created_at: '2026-11-16T15:00:00Z', processed_at: null, delivered_at: null };
    const req = { phone: '6000-0000', body: 'Hola', mode: 'simulated' as const, idempotencyKey: 'key-12345678' };
    expect(await expectCall(api.whatsappTestSend(req), 'POST', '/api/v1/whatsapp/test-messages', row, req)).toMatchObject({ id: 'm1', status: 'prepared', requestedMode: 'simulated', recipientPhone: '+50760000000' });
    expect(await expectCall(api.whatsappTestList(), 'GET', '/api/v1/whatsapp/test-messages', [row])).toHaveLength(1);
    expect(await expectCall(api.whatsappTestCancel('m1'), 'POST', '/api/v1/whatsapp/test-messages/m1/cancel', { ...row, status: 'cancelled' }, {})).toMatchObject({ status: 'cancelled' });
    const rc = await expectCall(api.whatsappReceiptPreview({ unit: 'P811', methodCode: 'yappy', grossCents: 3000, pendingBeforeCents: 3600 }), 'POST', '/api/v1/whatsapp/test-messages/receipt-preview',
      { gross_cents: 3000, commission_cents: 100, net_cents: 2900, pending_cents: 700, credit_cents: 0, body: 'texto' }, { unit: 'P811', methodCode: 'yappy', grossCents: 3000, pendingBeforeCents: 3600 });
    expect(rc).toEqual({ grossCents: 3000, commissionCents: 100, netCents: 2900, pendingCents: 700, creditCents: 0, body: 'texto' });
  });
  it('catálogo de variables y vista previa con variables sin resolver', async () => {
    const v = await expectCall(api.templateVariables(), 'GET', '/api/v1/templates/variables', [{ group: 'Fechas', code: 'fecha', label: 'Fecha', description: 'Fecha completa', example: 'lunes 16 de noviembre de 2026' }]);
    expect(v).toEqual([{ group: 'Fechas', code: 'fecha', label: 'Fecha', description: 'Fecha completa', example: 'lunes 16 de noviembre de 2026' }]);
    expect(await expectCall(api.previewTemplateDetailed('a1', 'Hola {{x}}'), 'POST', '/api/v1/templates/preview', { text: 'Hola {{x}}', unresolved: ['x'] }, { assignmentId: 'a1', body: 'Hola {{x}}' })).toEqual({ text: 'Hola {{x}}', unresolved: ['x'] });
    expect(await expectCall(api.previewTemplateDetailed('a1', 'x'), 'POST', '/api/v1/templates/preview', { text: 'x' }, { assignmentId: 'a1', body: 'x' })).toEqual({ text: 'x', unresolved: [] });
  });
  it('vista previa de plantilla con datos reales', async () => {
    expect(await expectCall(api.previewTemplate('a1', 'Hola {{nombre}}', '2026-11-16'), 'POST', '/api/v1/templates/preview', { text: 'Hola Ana' }, { assignmentId: 'a1', body: 'Hola {{nombre}}', date: '2026-11-16' })).toBe('Hola Ana');
    await expectCall(api.previewTemplate('a1', 'x'), 'POST', '/api/v1/templates/preview', { text: 'x' }, { assignmentId: 'a1', body: 'x' });
  });
  it('importación sin organización', async () => {
    const f = new File([new Uint8Array(3)], 'a.xlsx');
    await expectCall(api.uploadImport(f), 'POST', '/api/v1/imports/excel', {});
    await expectCall(api.listImports(), 'GET', '/api/v1/imports', []);
    await expectCall(api.importRows('i1', { matchStatus: 'conflict', onlyWithWarnings: true }), 'GET', '/api/v1/imports/i1/rows?matchStatus=conflict&onlyWithWarnings=true', []);
    await expectCall(api.confirmImport('i1', 'clean'), 'POST', '/api/v1/imports/i1/confirm', {}, { approve: 'clean' });
    await expectCall(api.rejectImport('i1'), 'POST', '/api/v1/imports/i1/reject', {});
    await expectCall(api.applyImport('i1', { initialStatus: 'active' }), 'POST', '/api/v1/imports/i1/apply', {}, { validFrom: null, initialStatus: 'active' });
  });
  it('exportaciones: /exports/{tipo}.xlsx con los parámetros de siempre', async () => {
    const p = api.downloadExport('payments', { from: '2026-11-01', to: '2026-11-07' });
    await Promise.resolve();
    const req = http.expectOne('/api/v1/exports/payments.xlsx?from=2026-11-01&to=2026-11-07');
    expect(req.request.responseType).toBe('blob');
    req.flush(new Blob(['x']), { headers: { 'content-disposition': 'attachment; filename="pagos.xlsx"' } });
    expect((await p).filename).toBe('pagos.xlsx');
  });
  it('informes: period, detail (con indicador) y series', async () => {
    const s = await expectCall(api.reportPeriod('2026-11-16', '2026-11-22'), 'GET', '/api/v1/reports/period?from=2026-11-16&to=2026-11-22', {
      from: '2026-11-16', to: '2026-11-22', expected_cents: 21600, gross_cents: 7300, commission_cents: 100, net_cents: 7200, applied_cents: 7200, prior_debt_recovered_cents: 0,
      credits_generated_cents: 400, pending_end_cents: 14400, credits_end_cents: 400, difference_cents: -14400, recovery_pct: '33.3', payments_count: 2, drivers_with_debt_end: 1 });
    expect(s).toMatchObject({ expectedCents: 21600, netCents: 7200, recoveryPct: 33.3, differenceCents: -14400, driversWithDebtEnd: 1 });
    const d = await expectCall(api.reportDetail('2026-11-16', '2026-11-22', 'prior_debt_recovered'), 'GET', '/api/v1/reports/period/detail?from=2026-11-16&to=2026-11-22&indicator=prior_debt_recovered',
      [{ occurred_on: '2026-11-17', kind: 'allocation', unit_code: 'T-1', operator_code: '101', full_name: 'Ana', amount_cents: 1000, detail: 'cuota del 2026-11-10' }]);
    expect(d[0]).toMatchObject({ occurredOn: '2026-11-17', amountCents: 1000, fullName: 'Ana' });
    const ser = await expectCall(api.reportSeries('2026-11-02', '2026-11-22'), 'GET', '/api/v1/reports/series?from=2026-11-02&to=2026-11-22',
      [{ week_start: '2026-11-02', expected_cents: 100, gross_cents: 100, commission_cents: 0, net_cents: 100, pending_end_cents: 0, credits_end_cents: 0, difference_cents: 0, recovery_pct: null }]);
    expect(ser[0]!.recoveryPct).toBeNull();
  });
  it('asignaciones atómicas: start, reassign, end y rate (con existing_charges_from_date_unchanged)', async () => {
    const start = { driverId: 'd1', unitId: 'u1', validFrom: '2026-11-16', dailyCents: 3600 };
    await expectCall(api.startAssignment(start), 'POST', '/api/v1/assignments/start', {}, start);
    const re = { unitId: 'u1', newDriverId: 'd2', validFrom: '2026-11-20', agreementNote: 'Nuevo acuerdo' };
    await expectCall(api.reassignUnit(re), 'POST', '/api/v1/assignments/reassign', {}, re);
    await expectCall(api.endAssignment('a1', '2026-11-30'), 'POST', '/api/v1/assignments/a1/end', {}, { endDate: '2026-11-30' });
    const r = await expectCall(api.changeRate('a1', 4000, '2026-11-23'), 'POST', '/api/v1/assignments/a1/rate', { assignment_id: 'a1', from: '2026-11-23', existing_charges_from_date_unchanged: 3 }, { dailyCents: 4000, from: '2026-11-23' });
    expect(r.existingChargesFromDateUnchanged).toBe(3);
  });
  it('respuesta que NO es JSON (HTML del dev-server sin proxy), 404/502/503/504 sin {error}: api_unreachable con método, ruta y HTTP', async () => {
    const p = api.dashboard();
    await Promise.resolve();
    http.expectOne('/api/v1/dashboard').flush('<!doctype html><html></html>', { status: 200, statusText: 'OK' });
    const e1 = await p.catch((e) => e);
    expect(e1).toMatchObject({ code: 'api_unreachable' });
    expect(e1.userMessage).toBe('No se pudo contactar el servidor de VIP. Inténtalo de nuevo; si persiste, avisa a soporte.');
    expect(e1.ctx).toMatchObject({ http: 200, where: 'GET /api/v1/dashboard' });
    for (const status of [404, 502, 503, 504]) {
      const q = api.weeklyCollection('2026-11-16');
      await Promise.resolve();
      http.expectOne('/api/v1/weekly-collection?weekStart=2026-11-16').flush('<h1>Not found</h1>', { status, statusText: 'x' });
      const e = await q.catch((x) => x);
      expect(e, String(status)).toMatchObject({ code: 'api_unreachable', status });
      expect(e.ctx).toMatchObject({ http: status, where: 'GET /api/v1/weekly-collection' });   // método, ruta y HTTP: solo en el detalle técnico
      expect(e.userMessage).not.toMatch(/HTTP|Fastify|pnpm/);
    }
  });
  it('404 CON cuerpo {error} sigue siendo un error de la API (no api_unreachable)', async () => {
    const p = api.previewPayment({ assignmentId: 'a', methodCode: 'cash', grossCents: 1 });
    await Promise.resolve();
    http.expectOne('/api/v1/payments/preview').flush({ error: 'assignment_not_found' }, { status: 404, statusText: 'Not Found' });
    await expect(p).rejects.toMatchObject({ code: 'assignment_not_found', status: 404 });
  });
  it('contrato de usuarios y roles', async () => {
    const u = await expectCall(api.listUsers(), 'GET', '/api/v1/users', [{ user_id: 'u1', email: 'a@x.co', full_name: 'A', role: 'admin', created_at: '2026-01-01', suspended_at: '2026-02-01' }]);
    expect(u[0]).toMatchObject({ userId: 'u1', role: 'admin', suspendedAt: '2026-02-01' });
    await expectCall(api.setUserRole('a@x.co', 'supervisor'), 'PUT', '/api/v1/users', {}, { email: 'a@x.co', role: 'supervisor' });
    await expectCall(api.removeUser('u1'), 'DELETE', '/api/v1/users/u1', {});
    expect(await expectCall(api.createUser({ email: 'a@x.co', role: 'admin', fullName: 'A' }), 'POST', '/api/v1/users/create', { mode: 'created', temporaryPassword: 'Tmp-123' }, { email: 'a@x.co', role: 'admin', fullName: 'A' })).toEqual({ mode: 'created', temporaryPassword: 'Tmp-123' });
    expect(await expectCall(api.inviteUser('b@x.co', 'super_admin'), 'POST', '/api/v1/users/invite', { mode: 'invited', expires_at: '2026-11-17T00:00:00Z' }, { email: 'b@x.co', role: 'super_admin' })).toEqual({ mode: 'invited', expiresAt: '2026-11-17T00:00:00Z' });
    expect((await expectCall(api.listInvites(), 'GET', '/api/v1/users/invites', [{ email: 'b@x.co', role: 'admin', created_at: 'c', expires_at: 'e', consumed_at: null }]))[0]).toMatchObject({ email: 'b@x.co', expiresAt: 'e', consumedAt: null });
    await expectCall(api.cancelInvite('b@x.co'), 'POST', '/api/v1/users/invites/cancel', {}, { email: 'b@x.co' });
    await expectCall(api.suspendUser('u1', true), 'POST', '/api/v1/users/u1/suspend', {}, { suspended: true });
  });
  it('SALDO: GET /imports/:id/opening-balances mapea resumen y filas; POST apply envía blockId y weekStart', async () => {
    const reply = { import_id: 'i1', block_id: 'b1', week_start: '2026-11-16', summary: { rows: 2, create: 1, unchanged: 0, conflict: 1, skip_empty: 0, skip_zero: 0, skip_text: 0, no_assignment: 0, ambiguous: 0, create_cents: 11900 },
      rows: [{ assignment_id: 'a1', import_row_id: 'r1', source_row: '2', unit_code: 'P280', operator_code: '280', raw_saldo: '119', saldo_excel_cents: '11900', saldo_state: 'amount', pending_before_cents: 0, credit_before_cents: 0,
        existing_opening_cents: null, existing_opening_week_start: null, prior_records: true, week_activity_cents: 3900, action: 'create', note: null }] };
    const r = await expectCall(api.openingBalances('i1', 'b1', '2026-11-16'), 'GET', '/api/v1/imports/i1/opening-balances?blockId=b1&weekStart=2026-11-16', reply);
    expect(r.summary).toMatchObject({ create: 1, conflict: 1, createCents: 11900 });
    expect(r.rows[0]).toMatchObject({ unitCode: 'P280', saldoExcelCents: 11900, saldoState: 'amount', priorRecords: true, weekActivityCents: 3900, existingOpeningCents: null, action: 'create' });
    const a = await expectCall(api.applyOpeningBalances('i1', { blockId: 'b1', weekStart: '2026-11-16' }), 'POST', '/api/v1/imports/i1/opening-balances/apply',
      { created: 1, created_cents: 11900, unchanged: 0, conflicts: 1, skipped_empty: 2, skipped_zero: 0, skipped_text: 0, no_assignment: 0, ambiguous: 0 }, { blockId: 'b1', weekStart: '2026-11-16' });
    expect(a).toEqual({ created: 1, createdCents: 11900, unchanged: 0, conflicts: 1, skippedEmpty: 2, skippedZero: 0, skippedText: 0, noAssignment: 0, ambiguous: 0 });
  });
  it('importación: plantilla, kind y opciones de apply', async () => {
    const t = api.downloadImportTemplate();
    await Promise.resolve();
    const req = http.expectOne('/api/v1/imports/template.xlsx');
    req.flush(new Blob(['x']), { headers: { 'content-disposition': 'attachment; filename="plantilla.xlsx"' } });
    expect((await t).filename).toBe('plantilla.xlsx');
    const r = await expectCall(api.uploadImport(new File([new Uint8Array(1)], 'a.xlsx')), 'POST', '/api/v1/imports/excel', { created: true, importId: 'i1', status: 'previewed', kind: 'directory', summary: { rows: 2, warningsByType: {} } });
    expect(r.kind).toBe('directory');
    await expectCall(api.applyImport('i1', { validFrom: '2026-11-16', initialStatus: 'active', resolve: 'latest_block' }), 'POST', '/api/v1/imports/i1/apply', {}, { validFrom: '2026-11-16', initialStatus: 'active', resolve: 'latest_block' });
    await expectCall(api.applyImport('i1', { initialStatus: 'active', applyRateChanges: true }), 'POST', '/api/v1/imports/i1/apply', {}, { validFrom: null, initialStatus: 'active', applyRateChanges: true });
  });
  it('exportaciones nuevas sin parámetros: drivers, units, assignments', async () => {
    for (const k of ['drivers', 'units', 'assignments'] as const) {
      const p = api.downloadExport(k, {});
      await Promise.resolve();
      http.expectOne(`/api/v1/exports/${k}.xlsx`).flush(new Blob(['x']));
      await p;
    }
  });
  it('errores: código de la API, red y sesión vencida', async () => {
    const p = api.dashboard();
    await Promise.resolve();
    http.expectOne('/api/v1/dashboard').flush({ error: 'forbidden' }, { status: 403, statusText: 'Forbidden' });
    await expect(p).rejects.toMatchObject({ code: 'forbidden', status: 403 });
    const q = api.me();
    await Promise.resolve();
    http.expectOne('/api/v1/me').flush(null, { status: 401, statusText: 'Unauthorized' });
    await expect(q).rejects.toBeInstanceOf(ApiError);
    const n = api.me();
    await Promise.resolve();
    http.expectOne('/api/v1/me').error(new ProgressEvent('error'));
    await expect(n).rejects.toMatchObject({ code: 'api_unreachable', status: 0 });
  });
});

import { TestBed } from '@angular/core/testing';
import { SupabaseDataService } from './supabase-data.service';
import { SUPABASE } from './supabase-client';

/** SupabaseDataService contra un DOBLE del cliente (registra cada consulta; no se conecta a Supabase). */
function recorder(tables: Record<string, unknown[]> = {}, rpcData: unknown = []) {
  const log: { table: string; ops: [string, unknown[]][] }[] = [];
  const client = {
    from: (table: string) => {
      const entry = { table, ops: [] as [string, unknown[]][] };
      log.push(entry);
      const chain: Record<string, unknown> = new Proxy({}, {
        get: (_t, prop: string) => {
          if (prop === 'then') return (res: (v: unknown) => void) => res({ data: tables[table] ?? [], error: null });
          return (...args: unknown[]) => { entry.ops.push([prop, args]); return chain; };
        },
      });
      return chain;
    },
    rpc: vi.fn(async (_fn: string, _args: unknown) => ({ data: rpcData, error: null })),
  };
  return { client, log };
}
function make(tables?: Record<string, unknown[]>, rpcData?: unknown) {
  const r = recorder(tables, rpcData);
  TestBed.configureTestingModule({ providers: [SupabaseDataService, { provide: SUPABASE, useValue: r.client }] });
  return { svc: TestBed.inject(SupabaseDataService), ...r };
}
const ops = (log: ReturnType<typeof recorder>['log'], table: string) => log.filter((l) => l.table === table).flatMap((l) => l.ops);

describe('SupabaseDataService (instancia única, doble del cliente)', () => {
  it('ninguna consulta ni escritura filtra o envía organization_id', async () => {
    const { svc, log } = make({ drivers: [], units: [], assignments: [], rates: [], payment_methods: [], notification_jobs: [], message_templates: [], notification_schedules: [], app_settings: [] });
    await svc.listDrivers(); await svc.listUnits(); await svc.listAssignments(); await svc.listJobs();
    await svc.listTemplates(); await svc.listSchedules(); await svc.getSettings(); await svc.positionTotals();
    await svc.saveDriver({ operatorCode: '1', nationalId: '2', firstName: 'A', lastName: '', phone: null, phoneE164: null, licenseNumber: null, licenseExpiresOn: null, remindersPaused: false, remindersPausedReason: null, status: 'active', notes: null });
    await svc.saveUnit({ code: 'T', plate: null, make: null, model: null, year: null, vehicleStatus: 'active', notes: null });
    expect(JSON.stringify(log)).not.toMatch(/organization/i);
  });
  it('ningún guardado de conductor envía columnas de consentimiento (el servidor las rechaza con consent_requires_declaration)', async () => {
    const { svc, log } = make();
    const base = { operatorCode: '1', nationalId: '2', firstName: 'A', lastName: 'B', phone: null, phoneE164: '+50760000000', licenseNumber: null, licenseExpiresOn: null, remindersPaused: false, remindersPausedReason: null, status: 'active' as const, notes: null };
    await svc.saveDriver(base);
    await svc.saveDriver({ ...base, id: 'd1', ...({ whatsappConsent: true, promotionalConsent: true } as object) });
    const bodies = ops(log, 'drivers').filter(([op]) => op === 'insert' || op === 'update').map(([, a]) => Object.keys(a[0] as object));
    expect(bodies.length).toBe(2);
    for (const keys of bodies) expect(keys.filter((k) => /consent/.test(k))).toEqual([]);
  });
  it('listDrivers refleja whatsapp_consent_source, promotional_consent y promotional_consent_at', async () => {
    const { svc } = make({ drivers: [{ id: 'd1', operator_code: '1', national_id: '2', first_name: 'A', last_name: 'B', whatsapp_consent: true, whatsapp_consent_source: 'legacy_unverified',
      promotional_consent: true, promotional_consent_at: '2026-11-01T10:00:00Z', status: 'active' }] });
    expect((await svc.listDrivers())[0]).toMatchObject({ whatsappConsent: true, whatsappConsentSource: 'legacy_unverified', promotionalConsent: true, promotionalConsentAt: '2026-11-01T10:00:00Z' });
  });
  it('cierres: usa las columnas reales de weekly_closures, agrega por semana, resuelve al responsable solo si el perfil se lee y no inventa si no', async () => {
    const rows = [
      { assignment_id: 'a1', week_start: '2026-11-09', charged_cents: '21600', gross_cents: '21700', commission_cents: '100', net_cents: '21600', pending_cents: '0', credit_cents: '0', closed_by: 'u1', closed_at: '2026-11-16T15:00:00Z' },
      { assignment_id: 'a2', week_start: '2026-11-09', charged_cents: '21600', gross_cents: '7300', commission_cents: '100', net_cents: '7200', pending_cents: '14400', credit_cents: '0', closed_by: 'u1', closed_at: '2026-11-16T15:01:00Z' },
    ];
    const a = make({ weekly_closures: rows, profiles: [{ id: 'u1', email: 'ana@x.co', full_name: 'Ana Admin' }] });
    const r = await a.svc.listClosures();
    expect(r).toEqual([{ weekStart: '2026-11-09', drivers: 2, chargedCents: 43200, grossCents: 29000, commissionCents: 200, netCents: 28800, pendingCents: 14400, creditCents: 0, closedAt: '2026-11-16T15:01:00Z', closedByName: 'Ana Admin' }]);
    const sel = ops(a.log, 'weekly_closures').find(([op]) => op === 'select')![1][0] as string;
    for (const col of ['week_start', 'charged_cents', 'gross_cents', 'commission_cents', 'net_cents', 'pending_cents', 'credit_cents', 'closed_by', 'closed_at']) expect(sel).toContain(col);
    TestBed.resetTestingModule();
    const b = make({ weekly_closures: rows, profiles: [] });   // RLS: profiles solo deja leer el propio perfil
    expect((await b.svc.listClosures())[0]!.closedByName).toBeNull();
    TestBed.resetTestingModule();
    expect(await make({ weekly_closures: [] }).svc.listClosures()).toEqual([]);   // sin cierres: lista vacía, nada inventado
  });
  it('detalle de un cierre: filtra por semana y trae unidad, operario y nombre desde las asignaciones', async () => {
    const { svc, log } = make({
      weekly_closures: [{ assignment_id: 'a1', charged_cents: 21600, gross_cents: 21700, commission_cents: 100, net_cents: 21600, pending_cents: 0, credit_cents: 0, closed_at: '2026-11-16T15:00:00Z' }],
      assignments: [{ id: 'a1', driver_id: 'd1', unit_id: 'u1', valid_from: '2026-01-01', valid_to: null, agreement_note: null }],
      drivers: [{ id: 'd1', operator_code: '101', national_id: '1', first_name: 'Ana', last_name: 'Pérez', status: 'active' }], units: [{ id: 'u1', code: 'T-1', vehicle_status: 'active' }], rates: [],
    });
    const r = await svc.listClosureDetail('2026-11-09');
    expect(r).toEqual([{ assignmentId: 'a1', unitCode: 'T-1', operatorCode: '101', driverName: 'Ana Pérez', chargedCents: 21600, grossCents: 21700, commissionCents: 100, netCents: 21600, pendingCents: 0, creditCents: 0, closedAt: '2026-11-16T15:00:00Z' }]);
    expect(ops(log, 'weekly_closures')).toContainEqual(['eq', ['week_start', '2026-11-09']]);
  });
  it('assignment_dues se lee con rpc y parámetros p_assignment / p_date', async () => {
    const { svc, client } = make({}, [{ today_cents: '1000', overdue_cents: 2600, future_cents: 0, total_pending_cents: 3600, credit_cents: 0 }]);
    expect(await svc.dues('a1', '2026-11-16')).toEqual({ todayCents: 1000, overdueCents: 2600, futureCents: 0, totalPendingCents: 3600, creditCents: 0 });
    expect(client.rpc).toHaveBeenCalledWith('assignment_dues', { p_assignment: 'a1', p_date: '2026-11-16' });
  });
  it('pausar recordatorios actualiza reminders_paused y su motivo', async () => {
    const { svc, log } = make();
    await svc.setRemindersPaused('d1', true, ' Viaje ');
    expect(ops(log, 'drivers')).toContainEqual(['update', [{ reminders_paused: true, reminders_paused_reason: 'Viaje' }]]);
    await svc.setRemindersPaused('d1', false, 'x');
    expect(ops(log, 'drivers')).toContainEqual(['update', [{ reminders_paused: false, reminders_paused_reason: null }]]);
  });
  it('horarios: lee hora HH:MM, días ordenados y guarda con template_id / scope / enabled', async () => {
    const { svc, log } = make({ notification_schedules: [{ id: 's1', kind: 'debt_first', label: 'Primero', local_time: '11:00:00', weekdays: [3, 1, 2], template_id: null, scope: 'total', enabled: false }] });
    expect((await svc.listSchedules())[0]).toEqual({ id: 's1', kind: 'debt_first', label: 'Primero', localTime: '11:00', weekdays: [1, 2, 3], templateId: null, scope: 'total', enabled: false });
    await svc.saveSchedule({ id: 's1', kind: 'debt_first', label: ' Primero ', localTime: '12:30', weekdays: [5, 1], templateId: 't1', scope: 'overdue', enabled: true });
    // el formulario NUNCA envía `enabled` (activar es una acción aparte con confirmación); crear siempre nace desactivado
    expect(ops(log, 'notification_schedules')).toContainEqual(['update', [{ kind: 'debt_first', label: 'Primero', local_time: '12:30', weekdays: [1, 5], template_id: 't1', scope: 'overdue' }]]);
    await svc.saveSchedule({ kind: 'debt_first', label: 'Nuevo', localTime: '12:30', weekdays: [1], templateId: null, scope: 'total', enabled: true });
    expect(ops(log, 'notification_schedules')).toContainEqual(['insert', [expect.objectContaining({ label: 'Nuevo', enabled: false })]]);
  });
  it('límites de frecuencia se guardan en la fila única de app_settings', async () => {
    const { svc, log } = make();
    await svc.saveSettings({ maxPerDriverPerDay: 2, minMinutesBetween: 90, graceMinutes: 120, chargeRecoveryDays: 30 });
    const o = ops(log, 'app_settings');
    expect(o).toContainEqual(['update', [{ max_per_driver_per_day: 2, min_minutes_between: 90, grace_minutes: 120, charge_recovery_days: 30 }]]);
    expect(o).toContainEqual(['eq', ['id', true]]);
  });
  it('lee los campos de pausa del conductor', async () => {
    const { svc } = make({ drivers: [{ id: 'd1', operator_code: '1', national_id: '2', first_name: 'A', last_name: 'B', reminders_paused: true, reminders_paused_reason: 'Viaje', status: 'active' }] });
    expect((await svc.listDrivers())[0]).toMatchObject({ remindersPaused: true, remindersPausedReason: 'Viaje' });
  });
  it('excepciones de tarifa: upsert por (assignment_id, on_date)', async () => {
    const { svc, log } = make();
    await svc.saveRateException({ assignmentId: 'a1', onDate: '2026-11-20', amountCents: 2000, reason: 'Acuerdo' });
    expect(ops(log, 'rate_exceptions')).toContainEqual(['upsert', [{ assignment_id: 'a1', on_date: '2026-11-20', amount_cents: 2000, reason: 'Acuerdo' }, { onConflict: 'assignment_id,on_date' }]]);
  });
  it('set_unit_agreement por rpc con p_unit_id / p_agreement / p_note; vacío o espacios = null; devuelve lo guardado', async () => {
    const { svc, client } = make();
    client.rpc = vi.fn(async () => ({ data: { unit_id: 'u1', agreement: 'CHAPA', agreement_note: 'taller', changed: true }, error: null })) as never;
    const r = await svc.setUnitAgreement('u1', '  CHAPA ', ' taller ');
    expect(client.rpc).toHaveBeenCalledWith('set_unit_agreement', { p_unit_id: 'u1', p_agreement: 'CHAPA', p_note: 'taller' });
    expect(r).toEqual({ unitId: 'u1', agreement: 'CHAPA', agreementNote: 'taller', changed: true });
    await svc.setUnitAgreement('u1', '   ', '');
    expect(client.rpc).toHaveBeenLastCalledWith('set_unit_agreement', { p_unit_id: 'u1', p_agreement: null, p_note: null });
  });
  it('un error del rpc de acuerdo lleva el rpc en el detalle técnico', async () => {
    const { svc, client } = make();
    client.rpc = vi.fn(async () => ({ data: null, error: { code: 'P0001', message: 'agreement_too_long' } })) as never;
    const err = await svc.setUnitAgreement('u1', 'x', null).catch((e) => e);
    expect(err.where).toBe('rpc set_unit_agreement');
  });
  it('guardar una unidad NUNCA escribe acuerdo ni observación (UPDATE directo bloqueado)', async () => {
    const { svc, log } = make();
    await svc.saveUnit({ id: 'u1', code: 'T', plate: null, make: null, model: null, year: null, vehicleStatus: 'active', notes: null });
    expect(JSON.stringify(log)).not.toContain('agreement');
  });
  it('lee el acuerdo de la unidad y el historial con el nombre de quien cambió', async () => {
    const { svc } = make({
      units: [{ id: 'u1', code: 'T', vehicle_status: 'active', agreement: 'CUSTODIA', agreement_note: 'x' }],
      unit_agreement_history: [{ id: 5, unit_id: 'u1', agreement: 'CHAPA', note: null, previous_agreement: null, previous_note: null, source: 'import', changed_by: 'p', changed_by_profile: { full_name: '', email: 'a@x.co' }, changed_at: '2026-11-02T00:00:00Z' }],
    });
    expect((await svc.listUnits())[0]).toMatchObject({ agreement: 'CUSTODIA', agreementNote: 'x' });
    expect((await svc.listAgreementHistory('u1'))[0]).toMatchObject({ id: '5', agreement: 'CHAPA', source: 'import', changedByName: 'a@x.co' });
  });
  it('plantillas: un UPDATE/DELETE que RLS deja en 0 filas NO se da por guardado (error de permiso); con filas, sí', async () => {
    const sin = make({ message_templates: [] });
    await expect(sin.svc.saveTemplate({ id: 't1', name: 'n', body: 'b' })).rejects.toMatchObject({ where: 'message_templates' });
    await expect(sin.svc.deleteTemplate('t1')).rejects.toMatchObject({ where: 'message_templates' });
    TestBed.resetTestingModule();
    const con = make({ message_templates: [{ id: 't1' }] });
    await expect(con.svc.saveTemplate({ id: 't1', name: ' n ', body: ' b ' })).resolves.toBeUndefined();
    expect(ops(con.log, 'message_templates').find(([o]) => o === 'update')![1][0]).toEqual({ name: 'n', body: 'b' });
    expect(ops(con.log, 'message_templates').some(([o]) => o === 'eq')).toBe(true);
  });
  it('AUDITORÍA: todo update/delete lleva un filtro .eq (pg_safeupdate rechaza los masivos)', async () => {
    const { svc, log } = make({ message_templates: [{ id: 't1' }] });
    const d = { operatorCode: '1', nationalId: '2', firstName: 'A', lastName: '', phone: null, phoneE164: null, whatsappConsent: false, licenseNumber: null, licenseExpiresOn: null, remindersPaused: false, remindersPausedReason: null, status: 'active' as const, notes: null };
    await svc.saveDriver({ ...d, id: 'd1' }); await svc.setRemindersPaused('d1', true, 'x');
    await svc.saveUnit({ id: 'u1', code: 'T', plate: null, make: null, model: null, year: null, vehicleStatus: 'active', notes: null });
    await svc.saveTemplate({ id: 't1', name: 'n', body: 'b' }); await svc.deleteTemplate('t1'); await svc.deleteRateException('x1');
    await svc.saveSchedule({ id: 's1', kind: 'debt_first', label: 'l', localTime: '11:00', weekdays: [1], templateId: null, scope: 'total', enabled: false });
    await svc.saveSettings({ maxPerDriverPerDay: 3, minMinutesBetween: 60, graceMinutes: 180, chargeRecoveryDays: 14 });
    const writes = log.filter((l) => l.ops.some(([o]) => o === 'update' || o === 'delete'));
    expect(writes.length).toBeGreaterThanOrEqual(8);
    for (const w of writes) expect(w.ops.some(([o]) => o === 'eq'), `${w.table}: update/delete sin .eq`).toBe(true);
  });
  it('un error de PostgREST lleva la tabla en el detalle técnico', async () => {
    const { svc, client } = make();
    client.from = (() => ({ select: () => ({ order: () => Promise.resolve({ data: null, error: { code: 'PGRST205', message: 'Could not find the table', status: 404 } }) }) })) as never;
    const err = await svc.listDrivers().catch((e) => e);
    expect(err.where).toBe('drivers');
    expect(err.code).toBe('PGRST205');
  });
  it('peticiones idénticas simultáneas comparten la consulta (units y drivers una sola vez); después vuelve a consultar', async () => {
    const r = recorder();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [SupabaseDataService, { provide: SUPABASE, useValue: r.client }] });
    const svc = TestBed.inject(SupabaseDataService);
    await Promise.all([svc.listUnits(), svc.listAssignments()]);
    expect(r.log.filter((x) => x.table === 'units').length).toBe(1);
    await svc.listUnits();
    expect(r.log.filter((x) => x.table === 'units').length).toBe(2);
  });
});

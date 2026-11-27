import { Injectable, inject } from '@angular/core';
import { normalizeWhatsapp } from './phone';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ApiError } from './errors';
import type {
  ClosureRow, WeekClosure, AppSettings, Assignment, AuditEntry, CollectionTotal, Driver, DriverInput, Dues, MessageTemplate, MessageTemplateInput, Movement,
  NotificationJob, NotificationSchedule, NotificationScheduleInput, PaymentMethod, PaymentMethodInput, Position, PositionTotals,
  RateException, RateExceptionInput, Unit, UnitAgreementChange, UnitAgreementResult, UnitInput,
} from './models';
import { DataService } from './services';
import { SUPABASE } from './supabase-client';

type Row = Record<string, any>; // filas crudas de PostgREST; se mapean a modelos tipados abajo
const n = (v: unknown): number => Number(v ?? 0);
const t = (v: string | null | undefined): string | null => (v?.trim() ? v.trim() : null);

/**
 * Lecturas y CRUD de datos maestros con RLS vía supabase-js (clave publicable; solo la administradora autorizada).
 * Instancia única: ninguna consulta lleva organización. Los saldos vienen de v_assignment_position / assignment_dues.
 */
@Injectable()
export class SupabaseDataService extends DataService {
  private readonly sb = inject(SUPABASE);

  private get client(): SupabaseClient {
    if (!this.sb) throw new ApiError('not_configured');
    return this.sb;
  }

  /** Adjunta tabla/RPC al error para el «Detalle técnico» (origen Supabase, código PostgREST, tabla). */
  private tag<E extends object>(error: E, where: string): E { return Object.assign(error, { where }); }
  private async rows(where: string, q: PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<Row[]> {
    const { data, error } = await q;
    if (error) throw this.tag(error, where);
    return (data as Row[]) ?? [];
  }
  private async exec(where: string, q: PromiseLike<{ error: { message: string } | null }>): Promise<void> {
    const { error } = await q;
    if (error) throw this.tag(error, where);
  }

  private toDriver = (r: Row): Driver => ({
    id: r['id'], operatorCode: r['operator_code'], nationalId: r['national_id'], firstName: r['first_name'],
    lastName: r['last_name'] ?? '', phone: r['phone'] ?? null, phoneE164: r['phone_e164'] ?? null,
    whatsappConsent: !!r['whatsapp_consent'], whatsappConsentSource: r['whatsapp_consent_source'] ?? null,
    promotionalConsent: !!r['promotional_consent'], promotionalConsentAt: r['promotional_consent_at'] ?? null, licenseNumber: r['license_number'] ?? null,
    licenseExpiresOn: r['license_expires_on'] ?? null, remindersPaused: !!r['reminders_paused'],
    remindersPausedReason: r['reminders_paused_reason'] ?? null, status: r['status'], notes: r['notes'] ?? null,
  });
  private toUnit = (r: Row): Unit => ({
    id: r['id'], code: r['code'], plate: r['plate'] ?? null, make: r['make'] ?? null, model: r['model'] ?? null,
    year: r['year'] ?? null, vehicleStatus: r['vehicle_status'], notes: r['notes'] ?? null,
    agreement: r['agreement'] ?? null, agreementNote: r['agreement_note'] ?? null,
  });

  /** Peticiones idénticas simultáneas comparten una sola consulta (p. ej. Unidades pedía «units» dos veces). No es caché: al terminar se olvida. */
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private shared<T>(key: string, run: () => Promise<T>): Promise<T> {
    const cur = this.inFlight.get(key) as Promise<T> | undefined;
    if (cur) return cur;
    const p = run().finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, p);
    return p;
  }
  listDrivers(): Promise<Driver[]> {
    return this.shared('drivers', async () => (await this.rows('drivers', this.client.from('drivers').select('*').order('operator_code'))).map(this.toDriver));
  }
  /**
   * Datos del conductor SIN columnas de consentimiento: el servidor (trigger guard_consent) rechaza cualquier escritura directa de
   * whatsapp_consent*, promotional_consent*. El consentimiento se registra aparte con ApiService.setDriverConsent (con origen).
   */
  async saveDriver(i: DriverInput): Promise<string> {
    const body = {
      operator_code: i.operatorCode.trim(), national_id: t(i.nationalId), first_name: i.firstName.trim(),
      last_name: i.lastName.trim(), phone: null, phone_e164: normalizeWhatsapp(i.phoneE164),
      license_number: t(i.licenseNumber), license_expires_on: t(i.licenseExpiresOn), status: i.status, notes: t(i.notes),
    };
    if (i.id) { await this.exec('drivers', this.client.from('drivers').update(body).eq('id', i.id)); return i.id; }
    const { data, error } = await this.client.from('drivers').insert(body).select('id').single();
    if (error) throw this.tag(error, 'drivers');
    return (data as Row)['id'];
  }
  async setRemindersPaused(driverId: string, paused: boolean, reason: string | null): Promise<void> {
    await this.exec('drivers', this.client.from('drivers')
      .update({ reminders_paused: paused, reminders_paused_reason: paused ? t(reason) : null }).eq('id', driverId));
  }

  listUnits(): Promise<Unit[]> {
    return this.shared('units', async () => (await this.rows('units', this.client.from('units').select('*').order('code'))).map(this.toUnit));
  }
  async saveUnit(i: UnitInput): Promise<string> {
    const body = { code: i.code.trim(), plate: t(i.plate), make: t(i.make), model: t(i.model), year: i.year, vehicle_status: i.vehicleStatus, notes: t(i.notes) };
    if (i.id) { await this.exec('units', this.client.from('units').update(body).eq('id', i.id)); return i.id; }
    const { data, error } = await this.client.from('units').insert(body).select('id').single();
    if (error) throw this.tag(error, 'units');
    return (data as Row)['id'];
  }

  async setUnitAgreement(unitId: string, agreement: string | null, note: string | null): Promise<UnitAgreementResult> {
    const { data, error } = await this.client.rpc('set_unit_agreement', { p_unit_id: unitId, p_agreement: t(agreement), p_note: t(note) });
    if (error) throw this.tag(error, 'rpc set_unit_agreement');
    const r = (Array.isArray(data) ? data[0] : data) as Row | null;
    return { unitId: r?.['unit_id'] ?? unitId, agreement: r ? (r['agreement'] ?? null) : t(agreement), agreementNote: r ? (r['agreement_note'] ?? null) : t(note), changed: !!r?.['changed'] };
  }
  async listAgreementHistory(unitId: string): Promise<UnitAgreementChange[]> {
    const rows = await this.rows('unit_agreement_history', this.client.from('unit_agreement_history').select('*, changed_by_profile:profiles!changed_by(full_name, email)').eq('unit_id', unitId).order('changed_at', { ascending: false }));
    return rows.map((r) => ({
      id: String(r['id']), unitId: r['unit_id'], agreement: r['agreement'] ?? null, note: r['note'] ?? null, previousAgreement: r['previous_agreement'] ?? null,
      previousNote: r['previous_note'] ?? null, source: r['source'] === 'import' ? 'import' : 'manual', changedBy: r['changed_by'] ?? null,
      changedByName: r['changed_by_profile']?.full_name || r['changed_by_profile']?.email || null, changedAt: r['changed_at'],
    }));
  }

  async listAssignments(): Promise<Assignment[]> {
    const [asg, drivers, units, rates] = await Promise.all([
      this.rows('assignments', this.client.from('assignments').select('*').order('valid_from', { ascending: false })),
      this.listDrivers(), this.listUnits(),
      this.rows('rates', this.client.from('rates').select('assignment_id, daily_amount_cents, valid_from').order('valid_from', { ascending: false })),
    ]);
    const dm = new Map(drivers.map((d) => [d.id, d]));
    const um = new Map(units.map((u) => [u.id, u]));
    const rm = new Map<string, number>();
    for (const r of rates) if (!rm.has(r['assignment_id'])) rm.set(r['assignment_id'], n(r['daily_amount_cents']));
    return asg.map((a) => {
      const d = dm.get(a['driver_id']);
      return {
        id: a['id'], driverId: a['driver_id'], unitId: a['unit_id'], unitCode: um.get(a['unit_id'])?.code ?? '—',
        operatorCode: d?.operatorCode ?? '—', driverName: d ? `${d.firstName} ${d.lastName}`.trim() : '—',
        validFrom: a['valid_from'], validTo: a['valid_to'], agreementNote: a['agreement_note'],
        dailyRateCents: rm.get(a['id']) ?? null,
      };
    });
  }

  async listRateExceptions(assignmentId: string): Promise<RateException[]> {
    return (await this.rows('rate_exceptions', this.client.from('rate_exceptions').select('*').eq('assignment_id', assignmentId).order('on_date', { ascending: false })))
      .map((r) => ({ id: r['id'], assignmentId: r['assignment_id'], onDate: r['on_date'], amountCents: n(r['amount_cents']), reason: r['reason'] ?? null }));
  }
  async saveRateException(i: RateExceptionInput): Promise<void> {
    await this.exec('rate_exceptions', this.client.from('rate_exceptions').upsert(
      { assignment_id: i.assignmentId, on_date: i.onDate, amount_cents: i.amountCents, reason: t(i.reason) }, { onConflict: 'assignment_id,on_date' }));
  }
  async deleteRateException(id: string): Promise<void> {
    await this.exec('rate_exceptions', this.client.from('rate_exceptions').delete().eq('id', id));
  }

  async collectionTotals(weekStart: string): Promise<CollectionTotal[]> {
    return (await this.rows('v_collection_totals', this.client.from('v_collection_totals').select('*').eq('week_start', weekStart)))
      .map((r) => ({
        weekStart: r['week_start'], methodCode: r['method_code'], payments: n(r['payments']),
        grossCents: n(r['gross_cents']), commissionCents: n(r['commission_cents']), netCents: n(r['net_cents']),
      }));
  }

  async listClosures(): Promise<WeekClosure[]> {
    const rows = await this.rows('weekly_closures', this.client.from('weekly_closures').select('week_start, charged_cents, gross_cents, commission_cents, net_cents, pending_cents, credit_cents, closed_by, closed_at').order('week_start', { ascending: false }).limit(3000));
    const m = new Map<string, WeekClosure & { by: Set<string> }>();
    for (const r of rows) {
      const k = r['week_start'] as string;
      const c = m.get(k) ?? { weekStart: k, drivers: 0, chargedCents: 0, grossCents: 0, commissionCents: 0, netCents: 0, pendingCents: 0, creditCents: 0, closedAt: r['closed_at'], closedByName: null, by: new Set<string>() };
      c.drivers++; c.chargedCents += n(r['charged_cents']); c.grossCents += n(r['gross_cents']); c.commissionCents += n(r['commission_cents']); c.netCents += n(r['net_cents']);
      c.pendingCents += n(r['pending_cents']); c.creditCents += n(r['credit_cents']); if (r['closed_at'] > c.closedAt) c.closedAt = r['closed_at']; if (r['closed_by']) c.by.add(r['closed_by']);
      m.set(k, c);
    }
    // Nombres: profiles solo permite leer el PROPIO perfil (RLS). Si no se puede resolver quién cerró, no se inventa: queda null.
    const names = new Map<string, string>();
    const ids = [...new Set([...m.values()].flatMap((c) => [...c.by]))];
    if (ids.length) {
      try { for (const p of await this.rows('profiles', this.client.from('profiles').select('id, email, full_name').in('id', ids))) names.set(p['id'], (p['full_name'] || p['email'] || '').trim()); } catch { /* sin permiso: se muestra solo la fecha */ }
    }
    return [...m.values()].map(({ by, ...c }) => ({ ...c, closedByName: by.size === 1 ? (names.get([...by][0]!) || null) : null })).sort((a, b) => (a.weekStart < b.weekStart ? 1 : -1));
  }

  async listClosureDetail(weekStart: string): Promise<ClosureRow[]> {
    const [rows, asg] = await Promise.all([
      this.rows('weekly_closures', this.client.from('weekly_closures').select('assignment_id, charged_cents, gross_cents, commission_cents, net_cents, pending_cents, credit_cents, closed_at').eq('week_start', weekStart)),
      this.listAssignments(),
    ]);
    const am = new Map(asg.map((a) => [a.id, a]));
    return rows.map((r) => {
      const a = am.get(r['assignment_id']);
      return { assignmentId: r['assignment_id'], unitCode: a?.unitCode ?? '—', operatorCode: a?.operatorCode ?? '—', driverName: a?.driverName ?? '—', chargedCents: n(r['charged_cents']), grossCents: n(r['gross_cents']),
        commissionCents: n(r['commission_cents']), netCents: n(r['net_cents']), pendingCents: n(r['pending_cents']), creditCents: n(r['credit_cents']), closedAt: r['closed_at'] };
    }).sort((x, y) => x.unitCode.localeCompare(y.unitCode, 'es', { numeric: true }));
  }

  async positionTotals(): Promise<PositionTotals> {
    const rows = await this.rows('v_assignment_position', this.client.from('v_assignment_position').select('pending_cents, credit_cents'));
    return {
      assignments: rows.length,
      pendingCents: rows.reduce((s, r) => s + n(r['pending_cents']), 0),
      creditCents: rows.reduce((s, r) => s + n(r['credit_cents']), 0),
    };
  }

  async position(assignmentId: string): Promise<Position | null> {
    const r = (await this.rows('v_assignment_position', this.client.from('v_assignment_position').select('*').eq('assignment_id', assignmentId)))[0];
    return r ? {
      assignmentId, chargedCents: n(r['charged_cents']), grossCents: n(r['gross_cents']), commissionCents: n(r['commission_cents']),
      netCents: n(r['net_cents']), pendingCents: n(r['pending_cents']), creditCents: n(r['credit_cents']), balanceCents: n(r['balance_cents']),
    } : null;
  }

  async dues(assignmentId: string, date: string): Promise<Dues | null> {
    const { data, error } = await this.client.rpc('assignment_dues', { p_assignment: assignmentId, p_date: date });
    if (error) throw this.tag(error, 'rpc assignment_dues');
    const r = (Array.isArray(data) ? data[0] : data) as Row | undefined;
    return r ? {
      todayCents: n(r['today_cents']), overdueCents: n(r['overdue_cents']), futureCents: n(r['future_cents']),
      totalPendingCents: n(r['total_pending_cents']), creditCents: n(r['credit_cents']),
    } : null;
  }

  async movements(assignmentId: string): Promise<Movement[]> {
    return (await this.rows('v_movements', this.client.from('v_movements').select('*').eq('assignment_id', assignmentId).order('occurred_at', { ascending: false }).limit(300)))
      .map((r) => ({
        occurredAt: r['occurred_at'], kind: r['kind'], refId: r['ref_id'], amountCents: n(r['amount_cents']),
        commissionCents: r['commission_cents'] == null ? null : n(r['commission_cents']), detail: r['detail'],
      }));
  }

  async listTemplates(): Promise<MessageTemplate[]> {
    return (await this.rows('message_templates', this.client.from('message_templates').select('*').order('name')))
      .map((r) => ({ id: r['id'], name: r['name'], body: r['body'] }));
  }
  async saveTemplate(i: MessageTemplateInput): Promise<void> {
    const body = { name: i.name.trim(), body: i.body.trim() };
    const t = this.client.from('message_templates');
    // `.select('id')` devuelve las filas tocadas: con RLS, un UPDATE/DELETE sin permiso NO da error, solo 0 filas (antes se decía «guardada» sin haber guardado nada).
    const { data, error } = await (i.id ? t.update(body).eq('id', i.id).select('id') : t.insert(body).select('id'));
    if (error) throw this.tag(error, 'message_templates');
    if (!data || !data.length) throw this.tag({ message: 'permission denied: row-level security (0 filas afectadas)' }, 'message_templates');
  }
  async deleteTemplate(id: string): Promise<void> {
    const { data, error } = await this.client.from('message_templates').delete().eq('id', id).select('id');
    if (error) throw this.tag(error, 'message_templates');
    if (!data || !data.length) throw this.tag({ message: 'permission denied: row-level security (0 filas afectadas)' }, 'message_templates');
  }

  async listSchedules(): Promise<NotificationSchedule[]> {
    return (await this.rows('notification_schedules', this.client.from('notification_schedules').select('*').order('local_time')))
      .map((r) => ({
        id: r['id'], kind: r['kind'], label: r['label'], localTime: String(r['local_time']).slice(0, 5),
        weekdays: ((r['weekdays'] ?? []) as unknown[]).map(Number).sort((a, b) => a - b),
        templateId: r['template_id'] ?? null, scope: r['scope'], enabled: !!r['enabled'],
        ...(r['deactivated_reason'] ? { deactivatedReason: r['deactivated_reason'], deactivatedAt: r['deactivated_at'] ?? null } : {}),
      }));
  }
  async saveSchedule(i: NotificationScheduleInput): Promise<void> {
    const body = {
      kind: i.kind, label: i.label.trim(), local_time: i.localTime, weekdays: [...i.weekdays].sort((a, b) => a - b),
      template_id: i.templateId, scope: i.scope,
    };
    // Activar/desactivar NO pasa por aquí: es una acción aparte con confirmación (POST /schedules/:id/activate|deactivate). Crear siempre nace DESACTIVADO.
    await this.exec('notification_schedules', i.id ? this.client.from('notification_schedules').update(body).eq('id', i.id) : this.client.from('notification_schedules').insert({ ...body, enabled: false }));
  }

  async getSettings(): Promise<AppSettings | null> {
    const r = (await this.rows('app_settings', this.client.from('app_settings').select('*').limit(1)))[0];
    return r ? {
      timezone: r['timezone'], maxPerDriverPerDay: n(r['max_per_driver_per_day']),
      minMinutesBetween: n(r['min_minutes_between']), graceMinutes: n(r['grace_minutes']), chargeRecoveryDays: r['charge_recovery_days'] == null ? 14 : n(r['charge_recovery_days']),
    } : null;
  }
  async saveSettings(i: Pick<AppSettings, 'maxPerDriverPerDay' | 'minMinutesBetween' | 'graceMinutes' | 'chargeRecoveryDays'>): Promise<void> {
    await this.exec('app_settings', this.client.from('app_settings').update({
      max_per_driver_per_day: i.maxPerDriverPerDay,
      min_minutes_between: i.minMinutesBetween, grace_minutes: i.graceMinutes, charge_recovery_days: i.chargeRecoveryDays,
    }).eq('id', true));
  }

  async listJobs(): Promise<NotificationJob[]> {
    const [jobs, drivers] = await Promise.all([
      this.rows('notification_jobs', this.client.from('notification_jobs').select('*').order('scheduled_for', { ascending: false }).limit(300)),
      this.listDrivers(),
    ]);
    const dm = new Map(drivers.map((d) => [d.id, d]));
    return jobs.map((j) => {
      const d = dm.get(j['driver_id']);
      return {
        id: j['id'], scheduleId: j['schedule_id'] ?? null, driverId: j['driver_id'], driverName: d ? `${d.firstName} ${d.lastName}`.trim() : '—',
        operatorCode: d?.operatorCode ?? '—', kind: j['kind'], localDate: j['local_date'], status: j['status'],
        suggestedBody: j['suggested_body'], renderedBody: j['rendered_body'], error: j['error'],
        scheduledFor: j['scheduled_for'], sentAt: j['sent_at'], dryRun: j['dry_run'],
      };
    });
  }

  async listAudit(): Promise<AuditEntry[]> {
    return (await this.rows('audit_logs', this.client.from('audit_logs').select('*').order('at', { ascending: false }).limit(300)))
      .map((r) => ({ id: Number(r['id']), actor: r['actor'] ?? null, action: r['action'], entity: r['entity'], entityId: r['entity_id'] ?? null, detail: r['detail'] ?? {}, at: r['at'] }));
  }

  async getJob(id: string): Promise<NotificationJob | null> {
    return (await this.listJobs()).find((j) => j.id === id) ?? null;
  }

}

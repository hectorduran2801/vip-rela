import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../environments/environment';
import { ApiError, apiUnreachable } from './errors';
import type {
  AdjustmentRequest, AppUser, ActivationPreview, DefaultTemplate, MessageTemplate, TemplateUsage, EntityKind, DeleteCheck, DeleteResult, ArchiveResult, ReactivateResult, TemplatePreview, TemplateVariable, VariableEditorItem, TemplateTextItem, ChargeGap, EnsureChargesRequest, EnsureChargesResult, RateHistoryItem, DashboardData, ImportApplyOptions, Role, DriverStatus, ExportKind, ExportParams, ImportApplyResult, ImportHistoryItem, ImportRow,
  ImportStageResult, MatchStatus, Me, PaymentPreview, PaymentPreviewRequest, PeriodDetailRow, PeriodIndicator, PeriodSeriesRow,
  PeriodSummary, RateChangeResult, ReassignRequest, RegisterPaymentRequest, RegisterPaymentResult, ReviewAction,
  StartAssignmentRequest, WeeklyRow, WhatsappRequestResult, WhatsappSession,
  OpeningApplyResult, OpeningPreview, OpeningAction, DriverMessage, DriverMessageRequest, CreateUserMode, CreateUserRequest, CreateUserResult, SyncResult, CollectionRow, CollectionMessage, AssignmentSaldo, CollectionBatch, ImportRowPatch, CollectionPreview, CollectionLastSync, CollectionSendResult, UserInvite, ReceiptPreview, ReceiptPreviewRequest, TestMessage, TestMessageRequest, TestPreview, ConsentRecord, ConsentRequest, ConsentResult, WeekDetail,
  SendSchedule, SendScheduleInput, FormerDebt, SendAudience, ResetCredentialsResult, AccountInfo, Recipient,
} from './models';
import { ApiService } from './services';

/** Cliente de la API Fastify. El token Bearer lo agrega el interceptor (auth.interceptor.ts). */
@Injectable()
export class HttpApiService extends ApiService {
  private readonly http = inject(HttpClient);
  private readonly base = environment.apiUrl;

  /** Clasifica un fallo HTTP: la API responde JSON {error}; cualquier otra cosa (HTML, 404/502/503/504 sin cuerpo, red) = api_unreachable. */
  private fail(method: string, path: string, e: HttpErrorResponse, body?: unknown): ApiError {
    const code = (body as { error?: unknown } | null | undefined)?.error;
    const url = `${this.base}${path}`.split('?')[0]!;
    const hasCode = typeof code === 'string' && code.length > 0;
    const raw = typeof e.error === 'string' ? e.error.slice(0, 160) : (e.message ?? '').slice(0, 160);
    if (e.status === 0) return apiUnreachable(method, url, 0, raw);
    if (!hasCode && (e.status === 200 || [404, 502, 503, 504].includes(e.status) || typeof e.error === 'string')) return apiUnreachable(method, url, e.status, raw);
    return Object.assign(new ApiError(hasCode ? code : e.status === 401 ? 'unauthorized' : e.status === 403 ? 'forbidden' : 'unknown', e.status,
      { origin: 'api', http: e.status, where: `${method} ${url}`, message: hasCode ? undefined : raw || undefined }), { payload: body });
  }

  private async call<T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
    try {
      const res = await firstValueFrom(this.http.request<T>(method, `${this.base}${path}`, { body }));
      if (typeof res === 'string' && /^\s*</.test(res)) throw apiUnreachable(method, `${this.base}${path}`.split('?')[0]!, 200, res.slice(0, 160));
      return res;
    } catch (e) {
      if (e instanceof HttpErrorResponse) throw this.fail(method, path, e, e.error);
      throw e;
    }
  }

  me() { return this.call<Me>('GET', '/me'); }
  listAccounts() { return this.call<AccountInfo[]>('GET', '/accounts'); }
  async setAccountView(accountId: string | null): Promise<void> { await this.call('PUT', '/account-view', { accountId }); }
  myProfile() { return this.call<{ fullName: string }>('GET', '/me/profile'); }
  saveMyName(fullName: string) { return this.call<{ fullName: string }>('PUT', '/me/profile', { fullName }); }
  dashboard() { return this.call<DashboardData>('GET', '/dashboard'); }
  formerDebts() { return this.call<FormerDebt[]>('GET', '/former-debts'); }
  previewPayment(req: PaymentPreviewRequest) { return this.call<PaymentPreview>('POST', '/payments/preview', req); }
  registerPayment(req: RegisterPaymentRequest) { return this.call<RegisterPaymentResult>('POST', '/payments', req); }
  async voidPayment(id: string, reason: string) { await this.call('POST', `/payments/${id}/void`, { reason }); }
  async createAdjustment(req: AdjustmentRequest) { await this.call('POST', '/adjustments', req); }
  async deleteCheck(kind: EntityKind, id: string): Promise<DeleteCheck> {
    const r = await this.call<Record<string, any>>('GET', `/${kind}/${id}/delete-check`);
    return { canDelete: !!r['can_delete'], blockedBy: r['blocked_by'] ?? [], blockers: r['blockers'] ?? {}, willDelete: r['will_delete'] ?? {}, activeAssignments: r['active_assignments'] ?? [], archived: !!r['entity']?.archived, suggestion: r['suggestion'] === 'archive' ? 'archive' : 'delete' };
  }
  async deleteEntity(kind: EntityKind, id: string, reason?: string): Promise<DeleteResult> {
    const r = await this.call<Record<string, any>>('DELETE', `/${kind}/${id}${reason?.trim() ? `?reason=${encodeURIComponent(reason.trim())}` : ''}`);
    return { deleted: !!r['deleted'], deletedCounts: r['deleted_counts'] ?? {} };
  }
  async archiveEntity(kind: EntityKind, id: string, opts: { reason?: string; effectiveDate?: string } = {}): Promise<ArchiveResult> {
    const r = await this.call<Record<string, any>>('POST', `/${kind}/${id}/archive`, { ...(opts.reason?.trim() ? { reason: opts.reason.trim() } : {}), ...(opts.effectiveDate ? { effectiveDate: opts.effectiveDate } : {}) });
    return { archived: !!r['archived'], endedAssignments: r['ended_assignments'] ?? [], chargesCompleted: Number(r['charges_completed'] ?? 0), cancelledJobs: Number(r['cancelled_jobs'] ?? 0), cancelledMessages: Number(r['cancelled_messages'] ?? 0), pendingCents: Number(r['pending_cents'] ?? 0) };
  }
  async reactivateEntity(kind: EntityKind, id: string): Promise<ReactivateResult> {
    const r = await this.call<Record<string, any>>('POST', `/${kind}/${id}/reactivate`, {});
    return { reactivated: !!r['reactivated'], hasActiveAssignment: !!r['has_active_assignment'] };
  }
  private toGap = (g: Record<string, any>): ChargeGap => ({ assignmentId: g['assignment_id'], unitCode: g['unit_code'], operatorCode: g['operator_code'], driverName: g['driver_name'], gapDate: g['gap_date'], plannedCents: Number(g['planned_cents']), reason: g['reason'] });
  async ensureCharges(req: EnsureChargesRequest = {}): Promise<EnsureChargesResult> {
    const r = await this.call<Record<string, any>>('POST', '/charges/ensure', req);
    return { created: Number(r['created'] ?? 0), from: r['from'], to: r['to'], daysChecked: Number(r['days_checked'] ?? 0), skipped: r['skipped'] ?? null,
      gaps: ((r['gaps'] ?? []) as Record<string, any>[]).map(this.toGap), gapsTotal: Number(r['gaps_total'] ?? 0), recoveryDays: Number(r['recovery_days'] ?? 0) };
  }
  async chargeGaps(through?: string): Promise<ChargeGap[]> {
    return (await this.call<Record<string, any>[]>('GET', `/charges/gaps${through ? `?through=${through}` : ''}`)).map(this.toGap);
  }
  async rateHistory(assignmentId?: string): Promise<RateHistoryItem[]> {
    const rows = await this.call<Record<string, any>[]>('GET', assignmentId ? `/assignments/${assignmentId}/rate-history` : '/rate-history');
    return rows.map((r) => ({
      rateId: r['rate_id'], assignmentId: r['assignment_id'], unitId: r['unit_id'], unitCode: r['unit_code'], driverId: r['driver_id'], operatorCode: r['operator_code'], driverName: r['driver_name'],
      previousRateId: r['previous_rate_id'] ?? null, previousDailyCents: r['previous_daily_cents'] == null ? null : Number(r['previous_daily_cents']), newDailyCents: Number(r['new_daily_cents']),
      validFrom: r['valid_from'], previousValidTo: r['previous_valid_to'] ?? null, validTo: r['valid_to'] ?? null, changedBy: r['changed_by'] ?? null, changedByName: r['changed_by_name'] ?? null,
      changedAt: r['changed_at'], reason: r['reason'] ?? null, isCurrent: !!r['is_current'],
    }));
  }
  async closeWeek(weekStart: string) { await this.call('POST', '/weeks/close', { weekStart }); }
  async reviewNotification(id: string, action: ReviewAction, body?: string) {
    await this.call('POST', `/notifications/${id}/review`, body === undefined ? { action } : { action, body });
  }

  /** Estado real de la única sesión (snake_case de la API → modelo). */
  private toSession(r: Record<string, any>): WhatsappSession {
    return {
      id: r['id'] ?? 'principal', label: r['label'] ?? 'Principal', status: r['status'], desiredState: r['desired_state'] === 'connected' ? 'connected' : 'disconnected',
      phoneNumber: r['phone_number'] ?? null, lastError: r['last_error'] ?? null, workerHeartbeatAt: r['worker_heartbeat_at'] ?? null,
      statusChangedAt: r['status_changed_at'] ?? null, workerOnline: !!r['worker_online'], qrData: r['qr_data'] ?? null, qrExpiresAt: r['qr_expires_at'] ?? null,
      sendingMode: r['sending_mode'] === 'test' || r['sending_mode'] === 'real' ? r['sending_mode'] : 'unknown', realTestEnabled: !!r['real_test_enabled'],
      checkedAt: r['checked_at'] ?? null, updatedAt: r['updated_at'] ?? null,
      automaticEnabled: !!r['automatic_enabled'], lastSeenAt: r['last_seen_at'] ?? null, sessionPersisted: !!r['session_persisted'], sessionSavedAt: r['session_saved_at'] ?? null, logoutPending: !!r['logout_pending'],
    };
  }
  async whatsappSession(): Promise<WhatsappSession> { return this.toSession(await this.call<Record<string, any>>('GET', '/whatsapp/session')); }
  async whatsappConnect(): Promise<WhatsappRequestResult> { const r = await this.call<Record<string, any>>('POST', '/whatsapp/session/connect', {}); return { ...this.toSession(r), requested: !!r['requested'] }; }
  async whatsappDisconnect(): Promise<WhatsappRequestResult> { const r = await this.call<Record<string, any>>('POST', '/whatsapp/session/disconnect', {}); return { ...this.toSession(r), requested: !!r['requested'] }; }
  async whatsappLogout(): Promise<WhatsappRequestResult> { const r = await this.call<Record<string, any>>('POST', '/whatsapp/session/logout', {}); return { ...this.toSession(r), requested: !!r['requested'] }; }
  private toTest(r: Record<string, any>): TestMessage {
    return {
      id: r['id'], kind: r['kind'] ?? 'test', recipientPhone: r['recipient_phone'], body: r['body'], requestedMode: r['requested_mode'], status: r['status'],
      senderPhone: r['sender_phone'] ?? null, providerMessageId: r['provider_message_id'] ?? null, error: r['error'] ?? null, recipientAuthorization: r['recipient_authorization'] ?? null,
      createdAt: r['created_at'], processedAt: r['processed_at'] ?? null, deliveredAt: r['delivered_at'] ?? null,
      authorizedBy: r['authorized_by'] ?? null, claimedAt: r['claimed_at'] ?? null, errorDetail: r['error_detail'] ?? null, resolvedBy: r['resolved_by'] ?? null, resolvedAt: r['resolved_at'] ?? null, resolutionNote: r['resolution_note'] ?? null,
    };
  }
  async whatsappTestPreview(phone: string, body: string): Promise<TestPreview> {
    const r = await this.call<Record<string, any>>('POST', '/whatsapp/test-messages/preview', { phone, body });
    return {
      recipient: r['recipient'] ?? null, invalidPhone: !!r['invalid_phone'], recipientIsADriver: !!r['recipient_is_a_driver'], body: r['body'], chars: r['chars'] ?? String(r['body'] ?? '').length,
      sender: r['sender'] ?? null, sessionStatus: r['session_status'] ?? null, sendingMode: r['sending_mode'] === 'test' || r['sending_mode'] === 'real' ? r['sending_mode'] : 'unknown', realTestEnabled: !!r['real_test_enabled'],
    };
  }
  async whatsappTestSend(req: TestMessageRequest): Promise<TestMessage> { return this.toTest(await this.call<Record<string, any>>('POST', '/whatsapp/test-messages', req)); }
  async whatsappTestList(): Promise<TestMessage[]> { return (await this.call<Record<string, any>[]>('GET', '/whatsapp/test-messages')).map((r) => this.toTest(r)); }
  private toDriverMsg(r: Record<string, any>): DriverMessage {
    return {
      id: r['id'], driverId: r['driver_id'], recipientPhone: r['recipient_phone'], body: r['body'], status: r['status'], senderPhone: r['sender_phone'] ?? null,
      providerMessageId: r['provider_message_id'] ?? null, error: r['error'] ?? null, errorDetail: r['error_detail'] ?? null, authorizedBy: r['authorized_by'] ?? null,
      createdAt: r['created_at'], claimedAt: r['claimed_at'] ?? null, processedAt: r['processed_at'] ?? null, deliveredAt: r['delivered_at'] ?? null,
      resolvedBy: r['resolved_by'] ?? null, resolvedAt: r['resolved_at'] ?? null, resolutionNote: r['resolution_note'] ?? null,
      firstName: r['first_name'] ?? null, lastName: r['last_name'] ?? null, operatorCode: r['operator_code'] ?? null,
    };
  }
  async sendDriverMessage(req: DriverMessageRequest): Promise<DriverMessage> { return this.toDriverMsg(await this.call<Record<string, any>>('POST', '/messages/driver', req)); }
  async listDriverMessages(driverId?: string): Promise<DriverMessage[]> {
    return (await this.call<Record<string, any>[]>('GET', `/messages/driver${driverId ? `?driverId=${driverId}` : ''}`)).map((r) => this.toDriverMsg(r));
  }
  async resolveDriverMessage(id: string, arrived: boolean, note?: string): Promise<DriverMessage> {
    return this.toDriverMsg(await this.call<Record<string, any>>('POST', `/messages/driver/${id}/resolve`, { arrived, ...(note?.trim() ? { note: note.trim() } : {}) }));
  }
  async cancelDriverMessage(id: string): Promise<DriverMessage> { return this.toDriverMsg(await this.call<Record<string, any>>('POST', `/messages/driver/${id}/cancel`, {})); }
  async whatsappTestResolve(id: string, arrived: boolean, note?: string): Promise<TestMessage> {
    return this.toTest(await this.call<Record<string, any>>('POST', `/whatsapp/test-messages/${id}/resolve`, { arrived, ...(note?.trim() ? { note: note.trim() } : {}) }));
  }
  async whatsappTestCancel(id: string): Promise<TestMessage> { return this.toTest(await this.call<Record<string, any>>('POST', `/whatsapp/test-messages/${id}/cancel`, {})); }
  async whatsappReceiptPreview(req: ReceiptPreviewRequest): Promise<ReceiptPreview> {
    const r = await this.call<Record<string, any>>('POST', '/whatsapp/test-messages/receipt-preview', req);
    return { grossCents: r['gross_cents'], commissionCents: r['commission_cents'], netCents: r['net_cents'], pendingCents: r['pending_cents'], creditCents: r['credit_cents'], body: r['body'] };
  }
  async previewTemplate(assignmentId: string, body: string, date?: string): Promise<string> {
    return (await this.previewTemplateDetailed(assignmentId, body, date)).text;
  }
  async previewTemplateDetailed(assignmentId: string, body: string, date?: string): Promise<TemplatePreview> {
    const r = await this.call<{ text: string; unresolved?: string[] }>('POST', '/templates/preview', { assignmentId, body, ...(date ? { date } : {}) });
    return { text: r.text, unresolved: r.unresolved ?? [] };
  }
  async defaultTemplates(): Promise<DefaultTemplate[]> {
    return (await this.call<Record<string, string>[]>('GET', '/schedules/default-templates')).map((r) => ({ kind: r['kind']!, suggestedName: r['suggested_name'] ?? '', body: r['body'] ?? '' }));
  }
  async templateFromDefault(req: { kind: string; name?: string; scheduleId?: string }): Promise<MessageTemplate> {
    const r = await this.call<Record<string, string>>('POST', '/templates/from-default', req);
    return { id: r['id']!, name: r['name']!, body: r['body']! };
  }
  async activationPreview(id: string): Promise<ActivationPreview> {
    const r = await this.call<Record<string, any>>('GET', `/schedules/${id}/activation-preview`);
    const s = r['schedule'] ?? {};
    return {
      schedule: { id: s.id ?? id, kind: s.kind, label: s.label, localTime: String(s.local_time ?? '').slice(0, 5), weekdays: ((s.weekdays ?? []) as unknown[]).map(Number), scope: s.scope, enabled: !!s.enabled, timezone: s.timezone ?? 'America/Panama', armedAt: s.armed_at ?? null, nextOccurrence: s.next_occurrence ?? null, nextOccurrenceLocal: s.next_occurrence_local ?? null },
      template: r['template'] ? { id: r['template'].id, name: r['template'].name, body: r['template'].body } : null,
      textExample: r['text_example'] ?? null, usesVariables: r['uses_variables'] ?? [], unknownVariables: r['unknown_variables'] ?? [],
      eligibleDrivers: r['eligible_drivers'] == null ? null : Number(r['eligible_drivers']), eligibleReason: r['eligible_drivers_reason'] ?? r['eligible_reason'] ?? null, canActivate: !!r['can_activate'], blockers: r['blockers'] ?? [],
      nextIsToday: !!(r['next_is_today'] ?? s.next_is_today), minutesUntilNext: (r['minutes_until_next'] ?? s.minutes_until_next) == null ? null : Number(r['minutes_until_next'] ?? s.minutes_until_next),
      deactivatedReason: r['deactivated_reason'] ?? s.deactivated_reason ?? null, deactivatedAt: r['deactivated_at'] ?? s.deactivated_at ?? null,
    };
  }
  async activateSchedule(id: string): Promise<void> { await this.call('POST', `/schedules/${id}/activate`, { confirm: true }); }
  async deactivateSchedule(id: string): Promise<void> { await this.call('POST', `/schedules/${id}/deactivate`, {}); }
  async templateUsage(id: string): Promise<TemplateUsage[]> {
    return (await this.call<Record<string, any>[]>('GET', `/templates/${id}/usage`)).map((r) => ({ id: r['id'], kind: r['kind'], label: r['label'], localTime: String(r['local_time'] ?? '').slice(0, 5), weekdays: ((r['weekdays'] ?? []) as unknown[]).map(Number), enabled: !!r['enabled'] }));
  }
  private toSchedule(r: Record<string, any>): SendSchedule {
    return { id: r['id'], name: r['name'], localTime: String(r['local_time'] ?? '').slice(0, 5), weekdays: ((r['weekdays'] ?? []) as unknown[]).map(Number), templateId: r['template_id'] ?? null,
      templateName: r['template_name'] ?? null, audience: r['audience'], enabled: !!r['enabled'], lastRunDate: r['last_run_date'] ?? null, lastRunStatus: r['last_run_status'] ?? null,
      lastRunCreated: r['last_run_created'] ?? null, lastRunTotal: r['last_run_total'] ?? null, assignmentIds: r['assignment_ids'] ?? [] };
  }
  sendScheduleRecipients(): Promise<Recipient[]> { return this.call<Recipient[]>('GET', '/send-schedules/recipients'); }
  async listSendSchedules(): Promise<SendSchedule[]> { return (await this.call<Record<string, any>[]>('GET', '/send-schedules')).map((r) => this.toSchedule(r)); }
  async saveSendSchedule(i: SendScheduleInput): Promise<SendSchedule> {
    const body = { name: i.name, localTime: i.localTime, weekdays: i.weekdays, templateId: i.templateId, audience: i.audience, enabled: i.enabled, assignmentIds: i.assignmentIds ?? [] };
    return this.toSchedule(await this.call<Record<string, any>>(i.id ? 'PUT' : 'POST', i.id ? `/send-schedules/${i.id}` : '/send-schedules', body));
  }
  async deleteSendSchedule(id: string): Promise<void> { await this.call('DELETE', `/send-schedules/${id}`); }
  async sendScheduleAudienceCount(audience: SendAudience): Promise<number> { return (await this.call<{ count: number }>('GET', `/send-schedules/audience-count?audience=${audience}`)).count; }
  async templateVariables(): Promise<TemplateVariable[]> {
    return (await this.call<Record<string, string>[]>('GET', '/templates/variables')).map((r) => ({ group: r['group']!, code: r['code']!, label: r['label']!, description: r['description'] ?? '', example: r['example'] ?? '' }));
  }

  async setCommission(assignmentId: string, on: boolean): Promise<void> { await this.call('PUT', `/collection/assignments/${assignmentId}/commission`, { on }); }
  async variableEditor(): Promise<VariableEditorItem[]> {
    return (await this.call<Record<string, unknown>[]>('GET', '/templates/variables/editor')).map((r) => ({ group: String(r['group']), code: String(r['code']), label: String(r['label']), description: String(r['description'] ?? ''), example: String(r['example'] ?? ''),
      customized: !!r['customized'], defaultLabel: String(r['default_label']), defaultDescription: String(r['default_description'] ?? ''), defaultExample: String(r['default_example'] ?? '') }));
  }
  async saveVariable(code: string, label: string, description: string, example: string): Promise<void> { await this.call('PUT', `/templates/variables/${code}`, { label, description, example }); }
  async resetVariable(code: string): Promise<void> { await this.call('DELETE', `/templates/variables/${code}`); }
  async templateTexts(): Promise<TemplateTextItem[]> {
    return (await this.call<Record<string, unknown>[]>('GET', '/templates/texts')).map((r) => ({ key: String(r['key']), title: String(r['title']), text: String(r['text']), defaultText: String(r['default_text']), customized: !!r['customized'], example: String(r['example'] ?? '') }));
  }
  async saveTemplateText(key: string, text: string): Promise<void> { await this.call('PUT', `/templates/texts/${key}`, { text }); }
  async resetTemplateText(key: string): Promise<void> { await this.call('DELETE', `/templates/texts/${key}`); }

  async startAssignment(req: StartAssignmentRequest) { await this.call('POST', '/assignments/start', req); }
  async reassignUnit(req: ReassignRequest) { await this.call('POST', '/assignments/reassign', req); }
  async endAssignment(id: string, endDate: string) { await this.call('POST', `/assignments/${id}/end`, { endDate }); }
  async changeRate(id: string, dailyCents: number, from: string, reason?: string): Promise<RateChangeResult> {
    const r = await this.call<Record<string, any>>('POST', `/assignments/${id}/rate`, { dailyCents, from, ...(reason?.trim() ? { reason: reason.trim() } : {}) });
    return { assignmentId: r['assignment_id'] ?? id, rateId: r['rate_id'] ?? null, from: r['from'] ?? from, previousDailyCents: r['previous_daily_cents'] == null ? null : Number(r['previous_daily_cents']),
      newDailyCents: r['new_daily_cents'] == null ? null : Number(r['new_daily_cents']), existingChargesFromDateUnchanged: Number(r['existing_charges_from_date_unchanged'] ?? 0) };
  }

  async reportPeriod(from: string, to: string): Promise<PeriodSummary> {
    const r = await this.call<Record<string, any>>('GET', `/reports/period?from=${from}&to=${to}`);
    const c = (k: string) => Number(r[k] ?? 0);
    return {
      from: r['from'] ?? from, to: r['to'] ?? to, chargesGeneratedCents: c('charges_generated_cents'), adjustmentsChargedCents: c('adjustments_charged_cents'),
      expectedCents: c('expected_cents'), paymentsCount: c('payments_count'), grossCents: c('gross_cents'), commissionCents: c('commission_cents'),
      netCents: c('net_cents'), appliedCents: c('applied_cents'), appliedToPeriodCents: c('applied_to_period_cents'),
      priorDebtRecoveredCents: c('prior_debt_recovered_cents'), creditsGeneratedCents: c('credits_generated_cents'),
      pendingEndCents: c('pending_end_cents'), creditsEndCents: c('credits_end_cents'), driversWithDebtEnd: c('drivers_with_debt_end'),
      differenceCents: c('difference_cents'), recoveryPct: r['recovery_pct'] == null ? null : Number(r['recovery_pct']),
    };
  }
  async reportDetail(from: string, to: string, indicator: PeriodIndicator): Promise<PeriodDetailRow[]> {
    const rows = await this.call<Record<string, any>[]>('GET', `/reports/period/detail?from=${from}&to=${to}&indicator=${indicator}`);
    return rows.map((r) => ({
      occurredOn: r['occurred_on'], kind: r['kind'], unitCode: r['unit_code'], operatorCode: r['operator_code'], fullName: r['full_name'],
      amountCents: Number(r['amount_cents']), detail: r['detail'] ?? null,
    }));
  }
  async reportSeries(from: string, to: string): Promise<PeriodSeriesRow[]> {
    const rows = await this.call<Record<string, any>[]>('GET', `/reports/series?from=${from}&to=${to}`);
    return rows.map((r) => ({
      weekStart: r['week_start'], expectedCents: Number(r['expected_cents']), grossCents: Number(r['gross_cents']), commissionCents: Number(r['commission_cents']),
      netCents: Number(r['net_cents']), pendingEndCents: Number(r['pending_end_cents']), creditsEndCents: Number(r['credits_end_cents']),
      differenceCents: Number(r['difference_cents']), recoveryPct: r['recovery_pct'] == null ? null : Number(r['recovery_pct']),
    }));
  }

  async weeklyCollection(weekStart: string): Promise<WeeklyRow[]> {
    const rows = await this.call<Record<string, any>[]>('GET', `/weekly-collection?weekStart=${weekStart}`);
    return rows.map((r) => ({
      assignmentId: r['assignment_id'], driverId: r['driver_id'], unitId: r['unit_id'], unitCode: r['unit_code'],
      operatorCode: r['operator_code'], nationalId: r['national_id'], fullName: r['full_name'],
      driverStatus: r['driver_status'] as DriverStatus, dailyRateCents: Number(r['daily_rate_cents']),
      weekChargedCents: Number(r['week_charged_cents']), dayNetCents: (r['day_net_cents'] as unknown[]).map(Number),
      grossCents: Number(r['gross_cents']), commissionCents: Number(r['commission_cents']), netCents: Number(r['net_cents']),
      weekDiffCents: Number(r['week_diff_cents']), previousPendingCents: Number(r['previous_pending_cents'] ?? 0), previousCreditCents: Number(r['previous_credit_cents'] ?? 0), openingCents: Number(r['opening_cents'] ?? 0), pendingCents: Number(r['pending_cents']), creditCents: Number(r['credit_cents']),
      weekClosed: !!r['week_closed'], plannedCents: Number(r['planned_cents'] ?? 0), missingDays: Number(r['missing_days'] ?? 0),
    }));
  }

  async weeklyCollectionDetail(weekStart: string, assignmentId?: string): Promise<WeekDetail[]> {
    const rows = await this.call<Record<string, any>[]>('GET', `/weekly-collection/detail?weekStart=${weekStart}${assignmentId ? `&assignmentId=${assignmentId}` : ''}`);
    return rows.map((r) => ({
      assignmentId: r['assignment_id'], previousPendingCents: Number(r['previous_pending_cents'] ?? 0), previousCreditCents: Number(r['previous_credit_cents'] ?? 0),
      days: ((r['days'] ?? []) as Record<string, any>[]).map((d) => ({
        date: d['date'], weekday: Number(d['weekday']), plannedCents: Number(d['planned_cents'] ?? 0), chargeGenerated: !!d['charge_generated'], chargeCents: Number(d['charge_cents']), netPaidCents: Number(d['net_paid_cents']),
        remainingCents: Number(d['remaining_cents']), status: d['status'],
      })),
    }));
  }
  async setDriverConsent(driverId: string, req: ConsentRequest): Promise<ConsentResult> {
    const r = await this.call<Record<string, any>>('PUT', `/drivers/${driverId}/consent`, {
      purpose: req.purpose, granted: req.granted, ...(req.source ? { source: req.source } : {}), ...(req.evidence ? { evidence: req.evidence } : {}),
    });
    return { driverId: r['driver_id'] ?? driverId, purpose: r['purpose'] ?? req.purpose, granted: !!r['granted'], cancelledJobs: Number(r['cancelled_jobs'] ?? 0) };
  }
  async driverConsents(driverId: string): Promise<ConsentRecord[]> {
    const rows = await this.call<Record<string, any>[]>('GET', `/drivers/${driverId}/consents`);
    return rows.map((r) => ({ id: String(r['id']), purpose: r['purpose'], granted: !!r['granted'], source: r['source'], evidence: r['evidence'] ?? null, recordedBy: r['recorded_by'] ?? null, recordedAt: r['recorded_at'] }));
  }

  uploadImport(file: File) {
    const form = new FormData();
    form.append('file', file);
    return this.call<Record<string, any>>('POST', '/imports/excel', form).then((r): ImportStageResult => ({
      created: !!r['created'], importId: r['importId'] ?? r['import_id'], status: r['status'], kind: r['kind'] === 'directory' ? 'directory' : r['kind'] === 'collection_flat' ? 'collection_flat' : 'cobranza',
      fileSha256: r['fileSha256'], summary: r['summary'] ?? { rows: 0, warningsByType: {} } }));
  }
  collectionMessages(f: { date?: string; batch?: string } = {}): Promise<CollectionMessage[]> {
    const qs = new URLSearchParams(); if (f.date) qs.set('date', f.date); if (f.batch) qs.set('batch', f.batch);
    return this.call<CollectionMessage[]>('GET', `/collection/messages${qs.size ? `?${qs}` : ''}`);
  }
  collectionBatches(date?: string): Promise<CollectionBatch[]> { return this.call<CollectionBatch[]>('GET', `/collection/batches${date ? `?date=${date}` : ''}`); }
  async updateImportRow(importId: string, rowId: string, patch: ImportRowPatch): Promise<void> { await this.call('PATCH', `/imports/${importId}/rows/${rowId}`, patch); }
  collectionBoard(weekStart: string): Promise<CollectionRow[]> { return this.call<CollectionRow[]>('GET', `/collection/board?weekStart=${weekStart}`); }
  previewCollectionMessages(templateId: string, assignmentIds: string[]): Promise<CollectionPreview> { return this.call<CollectionPreview>('POST', '/collection/messages/preview', { templateId, assignmentIds }); }
  assignmentSaldo(assignmentId: string): Promise<AssignmentSaldo> { return this.call<AssignmentSaldo>('GET', `/assignments/${assignmentId}/saldo`); }
  collectionLastSync(): Promise<CollectionLastSync | null> { return this.call<CollectionLastSync | null>('GET', '/collection/last-sync'); }
  resolveCollectionMessages(ids: string[], arrived: boolean) { return this.call<{ resolved: number }>('POST', '/collection/resolve', { ids, arrived }); }
  sendCollectionMessages(req: { templateId: string; assignmentIds: string[]; batchKey: string; repeat?: boolean }): Promise<CollectionSendResult> { return this.call<CollectionSendResult>('POST', '/collection/messages/send', req); }
  syncPreview(importId: string, weekStart: string, dataDate?: string): Promise<SyncResult> {
    return this.call<Record<string, any>>('GET', `/imports/${importId}/sync-preview?weekStart=${weekStart}${dataDate ? `&dataDate=${dataDate}` : ''}`).then(toSync);
  }
  syncApply(importId: string, weekStart: string, note?: string, confirmHistorical?: boolean, dataDate?: string): Promise<SyncResult> {
    return this.call<Record<string, any>>('POST', `/imports/${importId}/sync-apply`, { weekStart, ...(note?.trim() ? { note: note.trim() } : {}), ...(confirmHistorical ? { confirmHistorical: true } : {}), ...(dataDate ? { dataDate } : {}) }).then(toSync);
  }
  async listImports(): Promise<ImportHistoryItem[]> {
    const rows = await this.call<Record<string, any>[]>('GET', '/imports');
    return rows.map((r) => ({ id: r['id'], fileName: r['file_name'], status: r['status'], createdAt: r['created_at'],
      appliedAt: r['applied_at'] ?? null, createdByName: r['created_by_name'] ?? null, summary: r['summary'] ?? {} }));
  }
  async importRows(importId: string, f: { matchStatus?: MatchStatus; onlyWithWarnings?: boolean }): Promise<ImportRow[]> {
    const qs = new URLSearchParams();
    if (f.matchStatus) qs.set('matchStatus', f.matchStatus);
    if (f.onlyWithWarnings) qs.set('onlyWithWarnings', 'true');
    const rows = await this.call<Record<string, any>[]>('GET', `/imports/${importId}/rows?${qs}`);
    const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
    return rows.map((r) => ({
      id: r['id'], blockIndex: r['block_index'] ?? null, sourceRow: r['source_row'], unitCode: r['unit_code'] ?? null, operatorCode: r['operator_code'] ?? null,
      nationalId: r['national_id'] ?? null, fullName: r['full_name'] ?? null, firstName: r['first_name'] ?? null, lastName: r['last_name'] ?? null,
      phoneE164: r['phone_e164'] ?? null, rowStatus: r['row_status'] ?? null, dailyRateCents: num(r['daily_rate_cents']), rawAgreement: r['raw_agreement'] ?? null,
      rawSaldo: r['raw_saldo'] ?? null, dayAmountsCents: ((r['day_amounts_cents'] ?? []) as unknown[]).map(num), warnings: r['warnings'] ?? [],
      matchStatus: r['match_status'], reviewStatus: r['review_status'], appliedAction: r['applied_action'] ?? null, appliedNote: r['applied_note'] ?? null,
      blockId: r['block_id'] ?? null, rawPhone: r['raw_phone'] ?? null, saldoState: r['saldo_state'] ?? null, saldoCents: num(r['saldo_cents']),
      changes: r['changes'] ?? null, consentRequest: r['consent_request'] === 'grant' || r['consent_request'] === 'withdraw' ? r['consent_request'] : null, consentOrigin: r['consent_origin'] ?? null,
    }));
  }
  async confirmImport(id: string, approve: 'clean' | string[]) { await this.call('POST', `/imports/${id}/confirm`, { approve }); }
  async rejectImport(id: string) { await this.call('POST', `/imports/${id}/reject`, {}); }
  applyImport(id: string, opts: ImportApplyOptions) {
    return this.call<ImportApplyResult>('POST', `/imports/${id}/apply`, {
      validFrom: opts.validFrom ?? null, initialStatus: opts.initialStatus,
      ...(opts.resolve ? { resolve: opts.resolve } : {}), ...(opts.applyRateChanges !== undefined ? { applyRateChanges: opts.applyRateChanges } : {}),
    });
  }

  async downloadExport(kind: ExportKind, params: ExportParams): Promise<{ blob: Blob; filename: string }> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) qs.set(k, v);
    return this.download(`/exports/${kind}.xlsx${qs.size ? `?${qs}` : ''}`, `vip-${kind}.xlsx`);
  }
  async openingBalances(importId: string, blockId: string, weekStart: string): Promise<OpeningPreview> {
    const r = await this.call<Record<string, any>>('GET', `/imports/${importId}/opening-balances?blockId=${blockId}&weekStart=${weekStart}`);
    const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
    const s = (r['summary'] ?? {}) as Record<string, any>;
    return {
      importId: r['import_id'], blockId: r['block_id'], weekStart: r['week_start'],
      summary: { rows: Number(s['rows'] ?? 0), create: Number(s['create'] ?? 0), unchanged: Number(s['unchanged'] ?? 0), conflict: Number(s['conflict'] ?? 0), skipEmpty: Number(s['skip_empty'] ?? 0), skipZero: Number(s['skip_zero'] ?? 0),
        skipText: Number(s['skip_text'] ?? 0), noAssignment: Number(s['no_assignment'] ?? 0), ambiguous: Number(s['ambiguous'] ?? 0), createCents: Number(s['create_cents'] ?? 0) },
      rows: ((r['rows'] ?? []) as Record<string, any>[]).map((x) => ({
        assignmentId: x['assignment_id'] ?? null, importRowId: x['import_row_id'], sourceRow: Number(x['source_row']), unitCode: x['unit_code'] ?? null, operatorCode: x['operator_code'] ?? null, rawSaldo: x['raw_saldo'] ?? null,
        saldoExcelCents: n(x['saldo_excel_cents']), saldoState: x['saldo_state'], pendingBeforeCents: n(x['pending_before_cents']), creditBeforeCents: n(x['credit_before_cents']),
        existingOpeningCents: n(x['existing_opening_cents']), existingOpeningWeekStart: x['existing_opening_week_start'] ?? null, priorRecords: !!x['prior_records'], weekActivityCents: n(x['week_activity_cents']),
        action: x['action'] as OpeningAction, note: x['note'] ?? null,
      })),
    };
  }
  async applyOpeningBalances(importId: string, req: { blockId: string; weekStart: string; note?: string }): Promise<OpeningApplyResult> {
    const r = await this.call<Record<string, any>>('POST', `/imports/${importId}/opening-balances/apply`, { blockId: req.blockId, weekStart: req.weekStart, ...(req.note?.trim() ? { note: req.note.trim() } : {}) });
    const c = (k: string) => Number(r[k] ?? 0);
    return { created: c('created'), createdCents: c('created_cents'), unchanged: c('unchanged'), conflicts: c('conflicts'), skippedEmpty: c('skipped_empty'), skippedZero: c('skipped_zero'), skippedText: c('skipped_text'), noAssignment: c('no_assignment'), ambiguous: c('ambiguous') };
  }
  downloadImportTemplate() { return this.download('/imports/template.xlsx', 'plantilla-importacion.xlsx'); }

  private async download(path: string, fallbackName: string): Promise<{ blob: Blob; filename: string }> {
    try {
      const res = await firstValueFrom(this.http.get(`${this.base}${path}`, { responseType: 'blob', observe: 'response' }));
      const cd = res.headers.get('content-disposition') ?? '';
      const type = res.body?.type ?? '';
      if (/text\/html/.test(type)) throw apiUnreachable('GET', `${this.base}${path}`.split('?')[0]!, res.status);
      return { blob: res.body as Blob, filename: /filename="?([^";]+)"?/.exec(cd)?.[1] ?? fallbackName };
    } catch (e) {
      if (e instanceof HttpErrorResponse) {
        let body: unknown = null;
        try { body = JSON.parse(await (e.error as Blob).text()); } catch { /* sin cuerpo JSON */ }
        throw this.fail('GET', path, e, body);
      }
      throw e;
    }
  }

  async listUsers(): Promise<AppUser[]> {
    const rows = await this.call<Record<string, any>[]>('GET', '/users');
    return rows.map((r) => ({ userId: r['user_id'], email: r['email'] ?? '', fullName: r['full_name'] ?? '', role: r['role'], createdAt: r['created_at'], suspendedAt: r['suspended_at'] ?? null }));
  }
  async setUserRole(email: string, role: Role) { await this.call('PUT', '/users', { email, role }); }
  async removeUser(userId: string) { await this.call('DELETE', `/users/${userId}`); }
  /** Crea la cuenta completa (Auth + rol). La contraseña solo viaja en esta petición: nunca se guarda ni se registra. */
  async resetUserCredentials(userId: string): Promise<ResetCredentialsResult> { return this.call<ResetCredentialsResult>('POST', `/users/${userId}/reset-credentials`, {}); }
  async createUser(req: CreateUserRequest): Promise<CreateUserResult> {
    const r = await this.call<Record<string, any>>('POST', '/users/create', { email: req.email, role: req.role, ...(req.fullName?.trim() ? { fullName: req.fullName.trim() } : {}) });
    return r['mode'] === 'assigned' ? { mode: 'assigned' } : { mode: 'created', temporaryPassword: typeof r['temporaryPassword'] === 'string' ? r['temporaryPassword'] : undefined };
  }
  async inviteUser(email: string, role: 'admin' | 'super_admin'): Promise<{ mode: CreateUserMode; expiresAt: string | null }> {
    const r = await this.call<Record<string, any>>('POST', '/users/invite', { email, role });
    return { mode: r['mode'] === 'assigned' ? 'assigned' : 'invited', expiresAt: r['expires_at'] ?? null };
  }
  async listInvites(): Promise<UserInvite[]> {
    const rows = await this.call<Record<string, any>[]>('GET', '/users/invites');
    return rows.map((r) => ({ email: r['email'], role: r['role'], createdAt: r['created_at'], expiresAt: r['expires_at'], consumedAt: r['consumed_at'] ?? null }));
  }
  async cancelInvite(email: string) { await this.call('POST', '/users/invites/cancel', { email }); }
  async suspendUser(userId: string, suspended: boolean) { await this.call('POST', `/users/${userId}/suspend`, { suspended }); }
}

const n = (v: unknown): number => Number(v ?? 0);
/** snake_case de la base → modelo de la web. */
function toSync(r: Record<string, any>): SyncResult {
  const u = r['units'] ?? {}, p = r['payments'] ?? {}, sd = r['saldo'] ?? {}, d = r['drivers'] ?? {};
  return {
    guard: (r['guard'] as SyncResult['guard']) ?? null,
    rateChanges: ((r['rate_changes'] ?? []) as Record<string, any>[]).map((x) => ({ row: n(x['row']), unitCode: String(x['unit_code'] ?? ''), previousCents: n(x['previous_cents']), newCents: n(x['new_cents']), kind: x['kind'] === 'correction' ? 'correction' as const : 'contract' as const })),
    weekStart: r['week_start'], applied: !!r['applied'], alreadyUpToDate: !!r['already_up_to_date'],
    units: { total: n(u.total), unchanged: n(u.unchanged), changed: n(u.changed), new: n(u.new), withoutDriver: n(u.without_driver), errors: n(u.errors) },
    payments: { new: n(p.new), changed: n(p.changed), zeroed: n(p.zeroed), unchanged: n(p.unchanged), skippedEmpty: n(p.skipped_empty), rejected: n(p.rejected), netDeltaCents: n(p.net_delta_cents) },
    saldo: { create: n(sd.create), unchanged: n(sd.unchanged), adjust: n(sd.adjust), skipEmpty: n(sd.skip_empty), skippedInvalid: n(sd.skipped_invalid), skippedNoAssignment: n(sd.skipped_no_assignment), deltaCents: n(sd.delta_cents) },
    drivers: { created: n(d.created), updated: n(d.updated) }, assignmentsCreated: n(r['assignments_created']), assignmentsEnded: n(r['assignments_ended'] ?? 0), blocked: n(r['blocked']),
    warnings: (r['warnings'] ?? []) as SyncResult['warnings'],
  };
}

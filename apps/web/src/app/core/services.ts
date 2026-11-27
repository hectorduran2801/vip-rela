import { Injectable, InjectionToken, signal, type Signal } from '@angular/core';
import type {
  ClosureRow, WeekClosure, AdjustmentRequest, AppSettings, AppUser, ImportApplyOptions, Role, Assignment, AuthUser, CollectionTotal, DashboardData, FormerDebt, Driver, DriverInput, Dues, ExportKind,
  ExportParams, ActivationPreview, DefaultTemplate, TemplateUsage, EntityKind, DeleteCheck, DeleteResult, ArchiveResult, ReactivateResult, TemplatePreview, TemplateVariable, VariableEditorItem, TemplateTextItem, ChargeGap, EnsureChargesRequest, EnsureChargesResult, RateHistoryItem, ImportApplyResult, ImportHistoryItem, ImportRow, ImportStageResult, MatchStatus, Me, MessageTemplate,
  MessageTemplateInput, Movement, NotificationJob, NotificationSchedule, NotificationScheduleInput, PaymentMethod,
  PaymentMethodInput, PaymentPreview, PaymentPreviewRequest, PeriodDetailRow, PeriodIndicator, PeriodSeriesRow, PeriodSummary,
  Position, PositionTotals, RateChangeResult, RateException, RateExceptionInput, ReassignRequest, RegisterPaymentRequest,
  RegisterPaymentResult, ReviewAction, StartAssignmentRequest, Unit, UnitAgreementChange, UnitAgreementResult, UnitInput, WeeklyRow, WhatsappRequestResult, WhatsappSession,
  OpeningApplyResult, OpeningPreview, DriverMessage, DriverMessageRequest, CreateUserMode, CreateUserRequest, CreateUserResult, SyncResult, CollectionRow, CollectionMessage, AssignmentSaldo, CollectionBatch, ImportRowPatch, CollectionPreview, CollectionLastSync, CollectionSendResult, UserInvite, ReceiptPreview, ReceiptPreviewRequest, TestMessage, TestMessageRequest, TestPreview, AuditEntry, ConsentRecord, ConsentRequest, ConsentResult, WeekDetail,
  SendSchedule, SendScheduleInput, SendAudience, ResetCredentialsResult, AccountInfo, Recipient,
} from './models';

export type AuthStatus = 'loading' | 'anonymous' | 'authenticated' | 'unconfigured';

/** Mensaje cuando la cuenta existe en Supabase pero no está autorizada en la base (is_authorized() = false). */
export const NOT_AUTHORIZED_MESSAGE = 'Esta cuenta no está autorizada para usar VIP';

/**
 * Autenticación (Supabase Auth). Instancia única, sin organizaciones: roles internos SUPER_ADMIN / ADMIN / SUPERVISOR.
 * Tras iniciar sesión se consulta `rpc('current_app_role')`; null = cuenta no autorizada y se cierra la sesión.
 */
@Injectable()
export abstract class AuthService {
  abstract readonly status: Signal<AuthStatus>;
  /** Usuario autenticado Y autorizado; null en cualquier otro caso. */
  abstract readonly user: Signal<AuthUser | null>;
  /** Aviso para el login (p. ej. «cuenta no autorizada» cuando la sesión restaurada fue rechazada). */
  abstract readonly notice: Signal<string | null>;
  /** Se resuelve cuando se conoce el estado inicial de la sesión. */
  abstract ready(): Promise<void>;
  /** Lanza ApiError('not_authorized') (y cierra la sesión) si la cuenta no está autorizada. */
  abstract signIn(email: string, password: string): Promise<void>;
  abstract signOut(): Promise<void>;
  abstract requestPasswordReset(email: string): Promise<void>;
  /** Fija una contraseña nueva (tras abrir el enlace de recuperación). */
  abstract updatePassword(password: string): Promise<void>;
  abstract accessToken(): Promise<string | null>;
  /** true si la cuenta entró con una contraseña temporal y debe cambiarla antes de usar VIP. */
  readonly mustChangePassword: Signal<boolean> = signal(false);
}

/** Lecturas (RLS) y escrituras de datos maestros/configuración permitidas por RLS. Nada financiero se escribe aquí. */
@Injectable()
export abstract class DataService {
  abstract listDrivers(): Promise<Driver[]>;
  /** Inserta/actualiza datos del conductor (SIN consentimiento: eso va por ApiService.setDriverConsent). Devuelve el id. */
  abstract saveDriver(input: DriverInput): Promise<string>;
  /** Pausa o reanuda los recordatorios de cobro de un conductor. */
  abstract setRemindersPaused(driverId: string, paused: boolean, reason: string | null): Promise<void>;
  abstract listUnits(): Promise<Unit[]>;
  /** Inserta/actualiza datos de la unidad (sin condición). Devuelve el id. */
  abstract saveUnit(input: UnitInput): Promise<string>;
  /** rpc('set_unit_agreement'): texto libre; vacío = sin acuerdo. Solo ADMIN/SUPER_ADMIN. Devuelve lo guardado. */
  abstract setUnitAgreement(unitId: string, agreement: string | null, note: string | null): Promise<UnitAgreementResult>;
  abstract listAgreementHistory(unitId: string): Promise<UnitAgreementChange[]>;
  abstract listAssignments(): Promise<Assignment[]>;
  abstract listRateExceptions(assignmentId: string): Promise<RateException[]>;
  abstract saveRateException(input: RateExceptionInput): Promise<void>;
  abstract deleteRateException(id: string): Promise<void>;
  abstract collectionTotals(weekStart: string): Promise<CollectionTotal[]>;
  /** Cierres semanales (más recientes primero), agregados por semana. */
  abstract listClosures(): Promise<WeekClosure[]>;
  /** Detalle por conductor de la semana cerrada (weekly_closures de esa semana + unidad/operario/nombre). */
  abstract listClosureDetail(weekStart: string): Promise<ClosureRow[]>;
  abstract positionTotals(): Promise<PositionTotals>;
  abstract position(assignmentId: string): Promise<Position | null>;
  /** rpc('assignment_dues'): cuota de hoy / deuda anterior / total a una fecha (lo calcula PostgreSQL). */
  abstract dues(assignmentId: string, date: string): Promise<Dues | null>;
  abstract movements(assignmentId: string): Promise<Movement[]>;
  abstract listTemplates(): Promise<MessageTemplate[]>;
  abstract saveTemplate(input: MessageTemplateInput): Promise<void>;
  abstract deleteTemplate(id: string): Promise<void>;
  abstract listSchedules(): Promise<NotificationSchedule[]>;
  abstract saveSchedule(input: NotificationScheduleInput): Promise<void>;
  abstract getSettings(): Promise<AppSettings | null>;
  abstract saveSettings(input: Pick<AppSettings, 'maxPerDriverPerDay' | 'minMinutesBetween' | 'graceMinutes' | 'chargeRecoveryDays'>): Promise<void>;
  abstract listJobs(): Promise<NotificationJob[]>;
  abstract getJob(id: string): Promise<NotificationJob | null>;
  /** Últimos movimientos de auditoría (solo se muestran a SUPER_ADMIN). */
  abstract listAudit(): Promise<AuditEntry[]>;
}

/** Operaciones que cambian dinero o estado sensible: SIEMPRE por la API Fastify (/api/v1, sin organizationId). */
@Injectable()
export abstract class ApiService {
  abstract me(): Promise<Me>;
  abstract listAccounts(): Promise<AccountInfo[]>;
  abstract setAccountView(accountId: string | null): Promise<void>;
  abstract myProfile(): Promise<{ fullName: string }>;
  abstract saveMyName(fullName: string): Promise<{ fullName: string }>;
  abstract dashboard(): Promise<DashboardData>;
  abstract formerDebts(): Promise<FormerDebt[]>;
  abstract previewPayment(req: PaymentPreviewRequest): Promise<PaymentPreview>;
  abstract registerPayment(req: RegisterPaymentRequest): Promise<RegisterPaymentResult>;
  abstract voidPayment(paymentId: string, reason: string): Promise<void>;
  abstract createAdjustment(req: AdjustmentRequest): Promise<void>;
  abstract deleteCheck(kind: EntityKind, id: string): Promise<DeleteCheck>;
  abstract deleteEntity(kind: EntityKind, id: string, reason?: string): Promise<DeleteResult>;
  abstract archiveEntity(kind: EntityKind, id: string, opts?: { reason?: string; effectiveDate?: string }): Promise<ArchiveResult>;
  abstract reactivateEntity(kind: EntityKind, id: string): Promise<ReactivateResult>;
  abstract ensureCharges(req?: EnsureChargesRequest): Promise<EnsureChargesResult>;
  abstract chargeGaps(through?: string): Promise<ChargeGap[]>;
  abstract rateHistory(assignmentId?: string): Promise<RateHistoryItem[]>;
  abstract closeWeek(weekStart: string): Promise<void>;
  abstract reviewNotification(id: string, action: ReviewAction, body?: string): Promise<void>;
  /** Estado real de la única sesión de WhatsApp (incluye worker_online y, a ADMIN+, el QR). */
  abstract whatsappSession(): Promise<WhatsappSession>;
  abstract whatsappConnect(): Promise<WhatsappRequestResult>;
  abstract whatsappDisconnect(): Promise<WhatsappRequestResult>;
  abstract whatsappLogout(): Promise<WhatsappRequestResult>;
  /** Mensajes de prueba (solo SUPER_ADMIN). Nunca masivos ni a conductores. */
  abstract whatsappTestPreview(phone: string, body: string): Promise<TestPreview>;
  abstract whatsappTestSend(req: TestMessageRequest): Promise<TestMessage>;
  abstract whatsappTestList(): Promise<TestMessage[]>;
  abstract whatsappTestCancel(id: string): Promise<TestMessage>;
  /** SUPER_ADMIN: tras revisar el chat, pasa «sin confirmar» a enviado (llegó) o fallido (no llegó). */
  /** ADMIN+: mensaje a un conductor (número y autorización salen de su ficha). */
  abstract sendDriverMessage(req: DriverMessageRequest): Promise<DriverMessage>;
  abstract listDriverMessages(driverId?: string): Promise<DriverMessage[]>;
  abstract resolveDriverMessage(id: string, arrived: boolean, note?: string): Promise<DriverMessage>;
  abstract cancelDriverMessage(id: string): Promise<DriverMessage>;
  abstract whatsappTestResolve(id: string, arrived: boolean, note?: string): Promise<TestMessage>;
  abstract whatsappReceiptPreview(req: ReceiptPreviewRequest): Promise<ReceiptPreview>;
  abstract previewTemplate(assignmentId: string, body: string, date?: string): Promise<string>;
  abstract previewTemplateDetailed(assignmentId: string, body: string, date?: string): Promise<TemplatePreview>;
  abstract templateVariables(): Promise<TemplateVariable[]>;
  abstract setCommission(assignmentId: string, on: boolean): Promise<void>;
  abstract variableEditor(): Promise<VariableEditorItem[]>;
  abstract saveVariable(code: string, label: string, description: string, example: string): Promise<void>;
  abstract resetVariable(code: string): Promise<void>;
  abstract templateTexts(): Promise<TemplateTextItem[]>;
  abstract saveTemplateText(key: string, text: string): Promise<void>;
  abstract resetTemplateText(key: string): Promise<void>;
  abstract defaultTemplates(): Promise<DefaultTemplate[]>;
  abstract templateFromDefault(req: { kind: string; name?: string; scheduleId?: string }): Promise<MessageTemplate>;
  abstract templateUsage(id: string): Promise<TemplateUsage[]>;
  abstract sendScheduleRecipients(): Promise<Recipient[]>;
  abstract listSendSchedules(): Promise<SendSchedule[]>;
  abstract saveSendSchedule(input: SendScheduleInput): Promise<SendSchedule>;
  abstract deleteSendSchedule(id: string): Promise<void>;
  abstract sendScheduleAudienceCount(audience: SendAudience): Promise<number>;
  abstract activationPreview(scheduleId: string): Promise<ActivationPreview>;
  abstract activateSchedule(scheduleId: string): Promise<void>;
  abstract deactivateSchedule(scheduleId: string): Promise<void>;
  abstract weeklyCollection(weekStart: string): Promise<WeeklyRow[]>;
  /** Detalle diario (lunes a domingo) calculado por la base de datos. Sin `assignmentId` devuelve todas las asignaciones de la semana. */
  abstract weeklyCollectionDetail(weekStart: string, assignmentId?: string): Promise<WeekDetail[]>;
  /** ADMIN+. Autoriza (con origen) o retira el consentimiento de WhatsApp; al retirar cobranza se cancelan los recordatorios pendientes. */
  abstract setDriverConsent(driverId: string, req: ConsentRequest): Promise<ConsentResult>;
  abstract driverConsents(driverId: string): Promise<ConsentRecord[]>;
  abstract uploadImport(file: File): Promise<ImportStageResult>;
  abstract listImports(): Promise<ImportHistoryItem[]>;
  abstract importRows(importId: string, filter: { matchStatus?: MatchStatus; onlyWithWarnings?: boolean }): Promise<ImportRow[]>;
  abstract confirmImport(importId: string, approve: 'clean' | string[]): Promise<void>;
  abstract rejectImport(importId: string): Promise<void>;
  abstract collectionMessages(filter?: { date?: string; batch?: string }): Promise<CollectionMessage[]>;
  abstract collectionBatches(date?: string): Promise<CollectionBatch[]>;
  abstract updateImportRow(importId: string, rowId: string, patch: ImportRowPatch): Promise<void>;
  abstract collectionBoard(weekStart: string): Promise<CollectionRow[]>;
  abstract previewCollectionMessages(templateId: string, assignmentIds: string[]): Promise<CollectionPreview>;
  abstract assignmentSaldo(assignmentId: string): Promise<AssignmentSaldo>;
  abstract collectionLastSync(): Promise<CollectionLastSync | null>;
  /** Resolver los «sin confirmar» tras revisar el chat: llegaron o no (si no, se pueden volver a enviar). */
  abstract resolveCollectionMessages(ids: string[], arrived: boolean): Promise<{ resolved: number }>;
  abstract sendCollectionMessages(req: { templateId: string; assignmentIds: string[]; batchKey: string; repeat?: boolean }): Promise<CollectionSendResult>;
  abstract syncPreview(importId: string, weekStart: string, dataDate?: string): Promise<SyncResult>;
  abstract syncApply(importId: string, weekStart: string, note?: string, confirmHistorical?: boolean, dataDate?: string): Promise<SyncResult>;
  abstract applyImport(importId: string, opts: ImportApplyOptions): Promise<ImportApplyResult>;
  /** Conciliación (solo lectura) del SALDO de un bloque como deuda anterior de la semana indicada (lunes). */
  abstract openingBalances(importId: string, blockId: string, weekStart: string): Promise<OpeningPreview>;
  /** Registra la deuda anterior (idempotente: reaplicar no duplica ni sobrescribe). */
  abstract applyOpeningBalances(importId: string, req: { blockId: string; weekStart: string; note?: string }): Promise<OpeningApplyResult>;
  abstract downloadImportTemplate(): Promise<{ blob: Blob; filename: string }>;
  abstract listUsers(): Promise<AppUser[]>;
  abstract setUserRole(email: string, role: Role): Promise<void>;
  abstract removeUser(userId: string): Promise<void>;
  /** Crea la cuenta (Auth + rol) o, si la identidad ya existía, solo asigna el rol. 501 service_role_not_configured si el servidor no puede crear en Auth. */
  abstract createUser(req: CreateUserRequest): Promise<CreateUserResult>;
  abstract resetUserCredentials(userId: string): Promise<ResetCredentialsResult>;
  abstract inviteUser(email: string, role: 'admin' | 'super_admin'): Promise<{ mode: CreateUserMode; expiresAt: string | null }>;
  abstract listInvites(): Promise<UserInvite[]>;
  abstract cancelInvite(email: string): Promise<void>;
  abstract suspendUser(userId: string, suspended: boolean): Promise<void>;
  /** Descarga con Authorization (fetch+blob). */
  abstract downloadExport(kind: ExportKind, params: ExportParams): Promise<{ blob: Blob; filename: string }>;
  abstract reportPeriod(from: string, to: string): Promise<PeriodSummary>;
  abstract reportDetail(from: string, to: string, indicator: PeriodIndicator): Promise<PeriodDetailRow[]>;
  abstract reportSeries(from: string, to: string): Promise<PeriodSeriesRow[]>;
  abstract startAssignment(req: StartAssignmentRequest): Promise<void>;
  abstract reassignUnit(req: ReassignRequest): Promise<void>;
  abstract endAssignment(assignmentId: string, endDate: string): Promise<void>;
  abstract changeRate(assignmentId: string, dailyCents: number, from: string, reason?: string): Promise<RateChangeResult>;
}

/** Breakpoints (matchMedia). Abstracto para poder sustituirlo en pruebas. */
@Injectable()
export abstract class Breakpoints {
  /** true si el ancho es < 768px. */
  abstract readonly isMobile: Signal<boolean>;
}

export const MOBILE_QUERY = '(max-width: 767.98px)';
export const NEW_KEY = new InjectionToken<() => string>('NEW_IDEMPOTENCY_KEY', {
  providedIn: 'root',
  factory: () => () => globalThis.crypto.randomUUID(),
});

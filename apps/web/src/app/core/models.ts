import type { Cents, PaymentMethodCode } from '@vip/shared';

/** Zona horaria de la instancia (app_settings.timezone; VIP opera en Panamá). */
export const TIMEZONE = 'America/Panama';

/** Usuario autenticado y autorizado (instancia única: no hay roles ni organizaciones). */
export type Role = 'super_admin' | 'admin' | 'supervisor';
export const ROLE_LABEL: Record<Role, string> = { super_admin: 'SUPER_ADMIN', admin: 'ADMIN', supervisor: 'SUPERVISOR' };
export const isRole = (v: unknown): v is Role => v === 'super_admin' || v === 'admin' || v === 'supervisor';
export interface AuthUser { userId: string; email: string; role: Role }
/** Usuario interno (cuenta de Supabase Auth con rol). Los conductores NO son usuarios. */
export interface AppUser { userId: string; email: string; fullName: string; role: Role; createdAt: string; suspendedAt: string | null }
/** Invitación pendiente (GET /users/invites): autoriza ese correo hasta `expiresAt`. */
export interface UserInvite { email: string; role: Role; createdAt: string; expiresAt: string; consumedAt: string | null }
export type CreateUserMode = 'created' | 'assigned' | 'invited';
export interface CreateUserRequest { email: string; role: Exclude<Role, 'supervisor'>; fullName?: string }
/** Resultado del alta: la contraseña temporal solo viene en la respuesta de creación (se muestra una vez). */
export interface CreateUserResult { mode: CreateUserMode; temporaryPassword?: string }
/** POST /users/:id/reset-credentials: contraseña temporal nueva (se muestra una sola vez; la persona debe cambiarla al entrar). */
export interface ResetCredentialsResult { email: string; temporaryPassword: string }

/** Respuesta de GET /api/v1/dashboard. */
/** Deuda de una asignación ya finalizada (fuera de la cartera activa). */
export interface FormerDebt { assignmentId: string; driverId: string; unitCode: string; operatorCode: string; fullName: string; endedOn: string; pendingCents: Cents }

export interface DashboardData {
  drivers: { total: number; active: number; inactive: number; suspended: number; pending_approval: number };
  collections: {
    pending_total_cents: Cents; drivers_with_debt: number; collected_today_gross_cents: Cents;
    collected_today_commission_cents: Cents; collected_today_net_cents: Cents;
    week_charged_cents: Cents; week_net_cents: Cents; credits_total_cents: Cents;
  };
  by_method: { method_code: string; payments: number; gross_cents: Cents; commission_cents: Cents; net_cents: Cents }[];
  reminders: { scheduled_today: number; pending_total: number };
  whatsapp: { sessions: { id: string; label: string; status: WhatsappStatus }[] };
}

export type DriverStatus = 'active' | 'inactive' | 'suspended' | 'pending_approval';
export const DRIVER_STATUS_LABEL: Record<DriverStatus, string> = {
  active: 'Activo', inactive: 'Inactivo', suspended: 'Suspendido', pending_approval: 'Pendiente de aprobación',
};
export interface Driver {
  id: string;
  operatorCode: string;
  nationalId: string | null;
  firstName: string;
  lastName: string;
  /** Teléfono de llamadas. */
  phone: string | null;
  /** WhatsApp, formato +507... */
  phoneE164: string | null;
  /** Autorización de WhatsApp para mensajes de COBRANZA (recordatorios y comprobantes). SOLO LECTURA: se cambia con PUT /drivers/:id/consent. */
  whatsappConsent: boolean;
  /** Origen de la autorización de cobranza ('legacy_unverified' = marcada antes de existir el registro, sin constancia). */
  whatsappConsentSource: ConsentSource | null;
  /** Autorización para campañas promocionales (independiente de la de cobranza). SOLO LECTURA. */
  promotionalConsent: boolean;
  promotionalConsentAt: string | null;
  licenseNumber: string | null;
  licenseExpiresOn: string | null;
  /** Recordatorios de cobro pausados para este conductor (no se programan envíos). */
  remindersPaused: boolean;
  remindersPausedReason: string | null;
  status: DriverStatus;
  notes: string | null;
}
/** Datos del conductor que se guardan con insert/update. Las columnas de consentimiento NO van aquí: el servidor las rechaza (consent_requires_declaration). */
export type DriverInput = Omit<Driver, 'id' | 'whatsappConsent' | 'whatsappConsentSource' | 'promotionalConsent' | 'promotionalConsentAt'> & { id?: string };

export type ConsentPurpose = 'collection' | 'promotional';
export type ConsentSource = 'verbal_admin' | 'driver_message' | 'signed_form' | 'import_declaration' | 'legacy_unverified' | 'withdrawal' | 'other';
/** Orígenes que la administradora puede elegir al autorizar. */
export const CONSENT_SOURCE_CHOICES: { value: Extract<ConsentSource, 'verbal_admin' | 'driver_message' | 'signed_form' | 'other'>; label: string }[] = [
  { value: 'verbal_admin', label: 'Declaración verbal de la administradora' },
  { value: 'driver_message', label: 'Mensaje del conductor' },
  { value: 'signed_form', label: 'Formulario firmado' },
  { value: 'other', label: 'Otro' },
];
export const CONSENT_SOURCE_LABEL: Record<ConsentSource, string> = {
  verbal_admin: 'Declaración verbal de la administradora', driver_message: 'Mensaje del conductor', signed_form: 'Formulario firmado',
  import_declaration: 'Declaración en la importación de Excel', legacy_unverified: 'Sin constancia (marcada antes del registro)', withdrawal: 'Retiro de la autorización', other: 'Otro',
};
export const CONSENT_PURPOSE_LABEL: Record<ConsentPurpose, string> = { collection: 'Mensajes de cobranza', promotional: 'Campañas promocionales' };
export interface ConsentRequest { purpose: ConsentPurpose; granted: boolean; source?: ConsentSource; evidence?: string }
/** Respuesta de PUT /drivers/:id/consent. */
export interface ConsentResult { driverId: string; purpose: ConsentPurpose; granted: boolean; cancelledJobs: number }
/** Fila de GET /drivers/:id/consents (la más reciente primero). */
export interface ConsentRecord { id: string; purpose: ConsentPurpose; granted: boolean; source: ConsentSource; evidence: string | null; recordedBy: string | null; recordedAt: string }

export type VehicleStatus = 'active' | 'maintenance' | 'out_of_service';
export const VEHICLE_STATUS_LABEL: Record<VehicleStatus, string> = {
  active: 'Activa', maintenance: 'En mantenimiento', out_of_service: 'Fuera de servicio',
};
export interface Unit {
  id: string;
  code: string;
  plate: string | null;
  make: string | null;
  model: string | null;
  year: number | null;
  vehicleStatus: VehicleStatus;
  notes: string | null;
  /** «Acuerdo / condición especial»: texto libre ≤200 (null = sin acuerdo). Se edita SOLO con set_unit_agreement. */
  agreement: string | null;
  /** Observación opcional (≤1000), independiente del acuerdo. */
  agreementNote: string | null;
}
/** Datos de la unidad que se guardan con insert/update (el acuerdo está bloqueado para UPDATE directo: ver `set_unit_agreement`). */
export type UnitInput = Omit<Unit, 'id' | 'agreement' | 'agreementNote'> & { id?: string };
/** Respuesta de set_unit_agreement. */
export interface UnitAgreementResult { unitId: string; agreement: string | null; agreementNote: string | null; changed: boolean }
export interface UnitAgreementChange {
  id: string; unitId: string; agreement: string | null; note: string | null; previousAgreement: string | null; previousNote: string | null;
  source: 'manual' | 'import'; changedBy: string | null; changedByName: string | null; changedAt: string;
}

export interface Assignment {
  id: string;
  driverId: string;
  unitId: string;
  unitCode: string;
  operatorCode: string;
  driverName: string;
  validFrom: string;
  validTo: string | null;
  agreementNote: string | null;
  dailyRateCents: Cents | null;
}
/** POST /assignments/start. */
export interface StartAssignmentRequest { driverId: string; unitId: string; validFrom: string; dailyCents?: Cents; agreementNote?: string }
/** POST /assignments/reassign. */
export interface ReassignRequest { unitId: string; newDriverId: string; validFrom: string; dailyCents?: Cents; agreementNote?: string }
/** Respuesta de POST /assignments/:id/rate. */
export interface RateChangeResult { assignmentId: string; rateId: string | null; from: string; previousDailyCents: Cents | null; newDailyCents: Cents | null; existingChargesFromDateUnchanged: number }
export interface RateException { id: string; assignmentId: string; onDate: string; amountCents: Cents; reason: string | null }
export type RateExceptionInput = Omit<RateException, 'id'>;

export interface PaymentMethod {
  id: string;
  code: PaymentMethodCode | string;
  label: string;
  commissionCents: Cents;
  active: boolean;
}
export type PaymentMethodInput = Omit<PaymentMethod, 'id'> & { id?: string };

/** Fila de GET /weekly-collection. Los saldos los calcula la base de datos; aquí solo se muestran. */
export interface WeeklyRow {
  assignmentId: string;
  driverId: string;
  unitId: string;
  unitCode: string;
  operatorCode: string;
  nationalId: string;
  fullName: string;
  driverStatus: DriverStatus;
  dailyRateCents: Cents;
  weekChargedCents: Cents;
  /** Neto recibido por día (lun..dom). */
  dayNetCents: Cents[];
  grossCents: Cents;
  commissionCents: Cents;
  netCents: Cents;
  weekDiffCents: Cents;
  /** Deuda con la que el conductor ENTRA a la semana (arrastre de semanas anteriores / apertura del SALDO del Excel). */
  previousPendingCents: Cents;
  previousCreditCents: Cents;
  /** Apertura registrada para la semana (no está incluida en weekChargedCents). */
  openingCents: Cents;
  pendingCents: Cents;
  creditCents: Cents;
  weekClosed: boolean;
  /** Tarifa semanal PREVISTA según el servidor: suma día a día por las vigencias reales de tarifa (ya no es tarifa × 6 en el cliente). */
  plannedCents: Cents;
  /** Días ya ocurridos con cuota prevista y SIN cargo guardado (el generador no corrió). */
  missingDays: number;
}

/** paid|partial|pending: hay cargo guardado · planned: día futuro con cuota prevista y sin cargo · missing: día ocurrido con cuota prevista y SIN cargo · no_charge: no corresponde cuota. */
export type DayStatus = 'no_charge' | 'paid' | 'partial' | 'pending' | 'planned' | 'missing';
/** Un día (lunes a domingo) de GET /weekly-collection/detail. Lo calcula la base de datos; la interfaz solo lo muestra. */
export interface WeekDay { date: string; weekday: number; plannedCents: Cents; chargeGenerated: boolean; chargeCents: Cents; netPaidCents: Cents; remainingCents: Cents; status: DayStatus }
export interface WeekDetail { assignmentId: string; previousPendingCents: Cents; previousCreditCents: Cents; days: WeekDay[] }

export interface AuditEntry { id: number; actor: string | null; action: string; entity: string; entityId: string | null; detail: Record<string, unknown>; at: string }

/** Cierre semanal agregado (suma de los cierres por conductor de esa semana; son instantáneas guardadas, no se recalculan). */
export interface WeekClosure { weekStart: string; drivers: number; chargedCents: Cents; grossCents: Cents; commissionCents: Cents; netCents: Cents; pendingCents: Cents; creditCents: Cents; closedAt: string;
  /** Quién cerró, SOLO si el perfil se puede resolver (profiles solo deja leer el propio bajo RLS); si no, null y se muestra solo la fecha. */
  closedByName: string | null }
/** Cierre de UN conductor en una semana (instantánea de weekly_closures; nunca se recalcula). */
export interface ClosureRow { assignmentId: string; unitCode: string; operatorCode: string; driverName: string; chargedCents: Cents; grossCents: Cents; commissionCents: Cents; netCents: Cents; pendingCents: Cents; creditCents: Cents; closedAt: string }
export interface CollectionTotal {
  weekStart: string;
  methodCode: string;
  payments: number;
  grossCents: Cents;
  commissionCents: Cents;
  netCents: Cents;
}

export interface PositionTotals { pendingCents: Cents; creditCents: Cents; assignments: number }

export interface Position {
  assignmentId: string;
  chargedCents: Cents;
  grossCents: Cents;
  commissionCents: Cents;
  netCents: Cents;
  pendingCents: Cents;
  creditCents: Cents;
  balanceCents: Cents;
}

export type MovementKind = 'charge' | 'payment' | 'payment_void' | 'adjustment' | 'opening';
export interface Movement {
  occurredAt: string;
  kind: MovementKind;
  refId: string;
  amountCents: Cents;
  commissionCents: Cents | null;
  detail: string | null;
}

export type JobStatus =
  | 'pending' | 'awaiting_approval' | 'processing' | 'sent' | 'failed' | 'skipped_paid'
  | 'skipped_credit' | 'skipped_no_consent' | 'skipped_paused' | 'skipped_frequency' | 'skipped_unresolved' | 'skipped_no_template' | 'cancelled' | 'discarded';

export interface NotificationJob {
  id: string;
  scheduleId: string | null;
  driverId: string;
  driverName: string;
  operatorCode: string;
  kind: string;
  localDate: string;
  status: JobStatus;
  suggestedBody: string | null;
  renderedBody: string | null;
  error: string | null;
  scheduledFor: string;
  sentAt: string | null;
  dryRun: boolean | null;
}

export type WhatsappStatus = 'disconnected' | 'starting' | 'qr_pending' | 'awaiting_scan' | 'connecting' | 'connected' | 'failed';
export const WHATSAPP_STATUS_LABEL: Record<WhatsappStatus, string> = {
  disconnected: 'Desconectado', starting: 'Iniciando', qr_pending: 'Esperando QR', awaiting_scan: 'Esperando escaneo', connecting: 'Conectando', connected: 'Conectado', failed: 'Error del worker',
};
/** Estados en los que el worker está trabajando: se sondea cada 2 s. */
export const WHATSAPP_TRANSITIONAL: readonly WhatsappStatus[] = ['starting', 'qr_pending', 'awaiting_scan', 'connecting'];
/** Estado REAL de la única sesión (GET /whatsapp/session). `qrData` solo viene con status awaiting_scan, sin vencer y rol ADMIN+. */
export interface WhatsappSession {
  id: string; label: string; status: WhatsappStatus; desiredState: 'connected' | 'disconnected';
  phoneNumber: string | null; lastError: string | null; workerHeartbeatAt: string | null; statusChangedAt: string | null;
  workerOnline: boolean; qrData: string | null; qrExpiresAt: string | null;
  /** Modo de envío informado por el worker (SEPARADO de «conectado»): 'test' = simulado, 'real', 'unknown' = worker apagado o sin dato. */
  sendingMode: SendingMode; realTestEnabled: boolean;
  /** Hora del servidor al responder (ISO) y última modificación de la fila. */
  checkedAt: string | null; updatedAt: string | null;
  /** Última vez que el servicio confirmó la sesión conectada. */
  lastSeenAt: string | null;
  /** Hay una sesión guardada (cifrada) que permite reconectar sin QR; el contenido nunca llega al navegador. */
  sessionPersisted: boolean; sessionSavedAt: string | null;
  /** Se pidió «Cerrar sesión» y el servicio aún no lo completó. */
  logoutPending: boolean;
  /** El worker ejecuta los horarios de envío (AUTOMATIC_REMINDERS=true). Si es false, los horarios quedan guardados pero no corren. */
  automaticEnabled: boolean;
}
export type SendingMode = 'test' | 'real' | 'unknown';
/** connect/disconnect: `requested` significa SOLO «solicitud registrada», nunca que esté conectado. */
export interface WhatsappRequestResult extends WhatsappSession { requested: boolean }

// ---- Contrato de la API (centavos enteros) ----
export interface PaymentPreviewRequest { assignmentId: string; methodCode: string; grossCents: Cents }
export interface PaymentPreview {
  grossCents: Cents;
  commissionCents: Cents;
  netCents: Cents;
  companyReceivesCents: Cents;
  balanceBeforeCents: Cents;
  balanceAfterCents: Cents;
  pendingAfterCents: Cents;
  creditAfterCents: Cents;
  creditGeneratedCents: Cents;
}
export interface RegisterPaymentRequest {
  assignmentId: string;
  methodCode: string;
  grossCents: Cents;
  idempotencyKey: string;
  reference?: string;
  paidAt?: string;
  sendReceipt?: boolean;
  notes?: string;
}
export interface RegisterPaymentResult {
  payment_id: string;
  duplicate: boolean;
  gross_cents: Cents;
  commission_cents: Cents;
  net_cents: Cents;
  applied_cents: Cents;
  credit_generated_cents: Cents;
  pending_cents: Cents;
  credit_cents: Cents;
  balance_cents: Cents;
  credit_notice_job_id: string | null;
  receipt_job_id: string | null;
}
export interface AdjustmentRequest {
  assignmentId: string;
  amountCents: Cents;
  effectiveDate: string;
  reason: string;
  idempotencyKey: string;
}
export type ReviewAction = 'approve' | 'edit' | 'discard';

export type MatchStatus = 'unmatched' | 'matched' | 'conflict' | 'duplicate' | 'ignored';
export type ImportKind = 'cobranza' | 'directory' | 'collection_flat';
export const IMPORT_KIND_LABEL: Record<ImportKind, string> = { cobranza: 'Planilla de cobranza (Excel actual)', directory: 'Plantilla de conductores y unidades', collection_flat: 'Datos de cobranza (Excel diario)' };
/** Resumen por categorías (buckets) que entrega la API al previsualizar. Todo opcional: según el tipo no aplican todos. */
export interface ImportSummary {
  kind?: ImportKind;
  blocks?: number; rows: number; emptyRowsSkipped?: number; rowsWithWarnings?: number; candidatePayments?: number;
  drivers?: { new: number; existing: number; toUpdate: number; unchanged: number };
  units?: { new: number; existing: number; withoutDriver?: number; withAgreement?: number };
  /** Ambigüedades detectadas (p. ej. acuerdos distintos para la misma unidad en varios bloques). */
  ambiguity?: { agreementAmbiguous?: number };
  assignments?: { new: number; same: number; conflicts: number };
  rates?: { new: number; same: number; differs: number };
  /** Solo plantilla de directorio: resumen de consentimientos de WhatsApp. */
  consents?: ImportConsentSummary;
  phones?: ImportPhoneSummary;
  /** Solo cobranza. */
  saldo?: ImportSaldoSummary;
  errors?: number; conflicts?: number; duplicates?: number; skipped?: number;
  /** Solo cobranza: conductores con unidad/tarifa ambiguas y cuántos resuelve cada criterio. */
  assignmentsResolvable?: { skip: number; latestBlock: number };
  warningsByType: Record<string, number>;
  matchCounts?: Partial<Record<MatchStatus, number>>;
  blockSummaries?: { blockIndex: number; startColumn: string; rows: number; warnings: number }[];
}
/** Resumen de teléfonos de la vista previa de BLOQUES. Importar un teléfono NO equivale a consentimiento. */
export interface ImportPhoneSummary { withValue: number; valid: number; invalid: number; added507: number; empty: number; sharedByDrivers: number }
/** Resumen del SALDO (deuda anterior) del Excel. Una celda vacía NO es cero. */
export interface ImportSaldoSummary { empty: number; zero: number; amount: number; text: number; totalAmountCents: Cents }
export type OpeningAction = 'create' | 'unchanged' | 'conflict' | 'skip_empty' | 'skip_zero' | 'skip_text' | 'no_assignment' | 'ambiguous';
export interface OpeningRow {
  assignmentId: string | null; importRowId: string; sourceRow: number; unitCode: string | null; operatorCode: string | null; rawSaldo: string | null;
  saldoExcelCents: Cents | null; saldoState: 'empty' | 'zero' | 'amount' | 'text'; pendingBeforeCents: Cents | null; creditBeforeCents: Cents | null;
  existingOpeningCents: Cents | null; existingOpeningWeekStart: string | null; priorRecords: boolean; weekActivityCents: Cents | null; action: OpeningAction; note: string | null;
}
export interface OpeningSummary { rows: number; create: number; unchanged: number; conflict: number; skipEmpty: number; skipZero: number; skipText: number; noAssignment: number; ambiguous: number; createCents: Cents }
export interface OpeningPreview { importId: string; blockId: string; weekStart: string; summary: OpeningSummary; rows: OpeningRow[] }
export interface OpeningApplyResult { created: number; createdCents: Cents; unchanged: number; conflicts: number; skippedEmpty: number; skippedZero: number; skippedText: number; noAssignment: number; ambiguous: number }
export interface ImportConsentSummary {
  toGrant: number; toWithdraw: number; unchanged: number;
  ignored: { total: number; missingOrigin: number; missingPhone: number; invalidValue: number; noDriver: number };
}
/** Resultado de `preview_collection_sync` / `apply_collection_sync` (Excel de cobranza plano). */
export interface SyncWarning { row: number; column: string; code: string; message: string; level: 'error' | 'blocking' | 'warning' | 'info' }
export interface SyncGuard {
  historical: boolean; reasons: ('older_week' | 'older_file_for_week' | 'older_data_date')[]; latestWeek: string | null; dataDate?: string; newerData?: { dataDate: string; appliedAt: string; fileName: string } | null;
  lastRun: { weekStart: string; appliedAt: string; fileName: string } | null;
  import: { fileName: string; sha256: string; uploadedAt: string; uploadedBy: string | null };
  priorRuns: { weekStart: string; appliedAt: string; appliedBy: string | null }[];
}
export interface SyncRateChange { row: number; unitCode: string; previousCents: number; newCents: number; kind: 'correction' | 'contract' }
export interface SyncResult {
  guard: SyncGuard | null; rateChanges: SyncRateChange[];
  weekStart: string; applied: boolean; alreadyUpToDate: boolean;
  units: { total: number; unchanged: number; changed: number; new: number; withoutDriver: number; errors: number };
  payments: { new: number; changed: number; zeroed: number; unchanged: number; skippedEmpty: number; rejected: number; netDeltaCents: number };
  saldo: { create: number; unchanged: number; adjust: number; skipEmpty: number; skippedInvalid: number; skippedNoAssignment: number; deltaCents: number };
  drivers: { created: number; updated: number }; assignmentsCreated: number; assignmentsEnded?: number; blocked: number; warnings: SyncWarning[];
}
export interface TodayMessage { id: string; template: string; at: string; status: string; body: string; error: string | null }
/** Una fila de la tabla de cobranza (una unidad con operario). Importes en centavos, calculados por la base de datos. */
export interface CollectionRow {
  assignmentId: string; driverId: string; unitCode: string; operatorCode: string; fullName: string; driverStatus: string; phone: string | null;
  dailyRateCents: number; paidWeekCents: number; paidTodayCents: number; pendingCents: number; creditCents: number; previousPendingCents: number; agreement: string | null;
  /** El saldo mostrado (pendingCents) es el SALDO del Excel; `saldoMissing` = el Excel nunca trajo saldo para la unidad. */
  saldoSource: 'excel' | 'calculado'; saldoMissing: boolean; saldoWeek: string | null;
  /** Unidad desvinculada (fecha de fin ≤ hoy): sin mensajes de cobranza. */
  ended: boolean;
  /** TODOS los mensajes de cobranza de HOY (America/Panama) de esta unidad, del más antiguo al más reciente. La jornada se reinicia a las 12:00 a. m. */
  messagesToday: TodayMessage[];
  /** Informativo: cada día de la semana (lun–dom) con la cuota prevista y lo que el Excel dice que pagó. */
  days: { date: string; dueCents: number; paidCents: number }[];
  /** Lo que debe hoy: SALDO del Excel + cuotas de la semana hasta hoy − pagos (null si el Excel no trae saldo). */
  totalCents: number | null;
  /** Comisión de pago ($1.00 Yappy / Punto Pago): con el check activo (por defecto) el importe comunicado la incluye. */
  collectCommission: boolean; commissionCents: number;
  /** Columna MENSAJE del Excel, guardada en la asignación: true = llega marcado. Solo es la selección inicial: no envía nada. */
  sendByExcel?: boolean | null;
}
export interface CollectionBatch { batchId: string; firstAt: string; lastAt: string; template: string | null; sentBy: string | null; total: number; queued: number; sent: number; failed: number }
export interface CollectionMessage { batchId: string | null; id: string; template: string | null; status: string; body: string; error: string | null; at: string; phone: string; operatorCode: string; name: string; unitCode: string | null; sentBy: string | null; importFile: string | null; importAppliedAt: string | null; variables: Record<string, string | null> | null }
/** Corrección de una fila del archivo antes de guardar. Solo se envían los campos cambiados. */
export interface ImportRowPatch { unitCode?: string | null; operatorCode?: string | null; fullName?: string | null; nationalId?: string | null; phone?: string | null; dailyRateCents?: number | null; rawAgreement?: string | null; rawSaldo?: string | null; dayAmountsCents?: (number | null)[] }
/** Saldo de una asignación: el del Excel (último SALDO válido importado) si la gestiona el Excel; si no, `managed=false` y rige el cálculo anterior. */
export interface AssignmentSaldo { managed: boolean; saldoCents: number | null; weekStart: string | null }
export interface CollectionPreviewItem { assignmentId: string; unitCode: string; operatorCode: string; fullName: string; phone: string | null; text: string | null; unresolved: string[]; reason: string | null; alreadySentAt: string | null }
export interface CollectionLastSync { importId: string; fileName: string; appliedAt: string }
export interface CollectionPreview { lastSync: CollectionLastSync | null; whatsappConnected: boolean; simulated?: boolean; items: CollectionPreviewItem[] }
export interface CollectionSendResult { sent: number; failed: number; results: { assignmentId: string; ok: boolean; status?: string; error?: string }[] }
export interface ImportStageResult { created: boolean; importId: string; status: string; kind: ImportKind; fileSha256?: string; summary: ImportSummary }
export interface ImportHistoryItem {
  id: string; fileName: string; status: string; createdAt: string; appliedAt: string | null; createdByName: string | null;
  summary: Partial<ImportSummary> & { applied?: Record<string, unknown> };
}
export type DriverChangeAction = 'create' | 'update' | 'unchanged';
export interface ImportChanges {
  driver?: { action: DriverChangeAction; from?: Record<string, unknown>; to?: Record<string, unknown> };
  unit?: 'new' | 'existing';
  assignment?: 'new' | 'same' | 'conflict';
  rate?: 'new' | 'same' | 'differs';
  consent?: { action: 'grant' | 'withdraw' | 'unchanged' | 'ignored'; reason?: string; current?: boolean | null; origin?: string | null };
}
export interface ImportRow {
  id: string; blockIndex: number | null; sourceRow: number; unitCode: string | null; operatorCode: string | null; nationalId: string | null;
  fullName: string | null; firstName: string | null; lastName: string | null; phoneE164: string | null; rowStatus: string | null;
  dailyRateCents: Cents | null; rawAgreement: string | null; rawSaldo: string | null;
  dayAmountsCents: (Cents | null)[]; warnings: string[]; matchStatus: MatchStatus; reviewStatus: string;
  appliedAction: string | null; appliedNote: string | null; changes: ImportChanges | null;
  /** Solo directorio: lo que pide el Excel sobre la autorización de cobranza. */
  consentRequest: 'grant' | 'withdraw' | null; consentOrigin: string | null;
  /** Id del bloque del Excel (para conciliar el SALDO por bloque). */
  blockId: string | null; rawPhone: string | null; saldoState: 'empty' | 'zero' | 'amount' | 'text' | null; saldoCents: Cents | null;
}
export interface ImportApplyOptions {
  validFrom?: string | null; initialStatus: 'active' | 'inactive' | 'pending_approval';
  /** Solo cobranza: cómo resolver unidad/tarifa ambiguas. */
  resolve?: 'skip' | 'latest_block';
  /** Solo plantilla: aplicar las tarifas que difieren de las vigentes. */
  applyRateChanges?: boolean;
}
export interface ImportApplyResult {
  drivers_created: number; drivers_linked?: number; drivers_updated?: number; drivers_unchanged?: number; units_created: number; assignments_created: number;
  rates_created: number; rates_changed?: number; units_without_driver?: number; agreements_set?: number; agreements_skipped?: number; skipped: number; rows_rejected: number; rows_excluded: number;
  drivers_pending_review?: number; units_without_driver_created?: number; phones_set?: number; phone_conflicts?: number; consents_granted?: number; consents_withdrawn?: number; consents_unchanged?: number; consents_ignored?: number; consent_jobs_cancelled?: number; issues: { operator: string; issue: string }[];
}
export type ExportKind = 'weekly' | 'day' | 'payments' | 'payments-by-method' | 'pending' | 'credits' | 'directory' | 'movements' | 'drivers' | 'units' | 'assignments';
export interface ExportParams { weekStart?: string; date?: string; from?: string; to?: string; assignmentId?: string }

/** Respuesta de GET /me. */
export interface AccountInfo { id: string; name: string; own: boolean; viewing: boolean; drivers: number }
export interface Me { userId: string; email: string; authorized: boolean; role: Role | null }

/** Desglose a una fecha (supabase.rpc('assignment_dues')): lo calcula la base de datos. */
export interface Dues { todayCents: Cents; overdueCents: Cents; futureCents: Cents; totalPendingCents: Cents; creditCents: Cents }

/** Fila única de app_settings. */
export interface AppSettings {
  timezone: string; maxPerDriverPerDay: number; minMinutesBetween: number; graceMinutes: number;
  /** Días hacia atrás que el motor de cobranza recupera solo tras una interrupción (1–90, por defecto 14). */
  chargeRecoveryDays: number;
}

/** Revisión previa de «Eliminar» (GET /drivers|units/:id/delete-check). */
export type EntityKind = 'drivers' | 'units';
export interface DeleteCheck {
  canDelete: boolean; blockedBy: string[]; blockers: Record<string, number>; willDelete: Record<string, number>;
  activeAssignments: { id?: string; unit_code?: string; driver_name?: string; operator_code?: string; valid_to?: string | null }[]; suggestion: 'delete' | 'archive';
  /** ¿Está dado de baja ahora mismo? (para comprobar el estado real tras un tiempo agotado) */
  archived?: boolean;
}
export interface DeleteResult { deleted: boolean; deletedCounts: Record<string, number> }
export interface ArchiveResult { archived: boolean; endedAssignments: unknown[]; chargesCompleted: number; cancelledJobs: number; cancelledMessages: number; pendingCents: number }
export interface ReactivateResult { reactivated: boolean; hasActiveAssignment: boolean }
export type ChargeGapReason = 'outside_window' | 'closed_week' | 'not_generated';
/** Cuota que debía existir y no tiene cargo guardado (GET /charges/gaps). */
export interface ChargeGap { assignmentId: string; unitCode: string; operatorCode: string; driverName: string; gapDate: string; plannedCents: Cents; reason: ChargeGapReason }
/** Respuesta de POST /charges/ensure. */
export interface EnsureChargesResult { created: number; from: string; to: string; daysChecked: number; skipped: 'locked' | null; gaps: ChargeGap[]; gapsTotal: number; recoveryDays: number }
export interface EnsureChargesRequest { through?: string; from?: string }

/** Una fila del historial de tarifas (GET /assignments/:id/rate-history y GET /rate-history). */
export interface RateHistoryItem {
  rateId: string; assignmentId: string; unitId: string; unitCode: string; driverId: string; operatorCode: string; driverName: string;
  previousRateId: string | null; previousDailyCents: Cents | null; newDailyCents: Cents; validFrom: string; previousValidTo: string | null; validTo: string | null;
  changedBy: string | null; changedByName: string | null; changedAt: string; reason: string | null; isCurrent: boolean;
}

/** Variable del catálogo de plantillas (GET /templates/variables). */
export interface VariableEditorItem { group: string; code: string; label: string; description: string; example: string; customized: boolean; defaultLabel: string; defaultDescription: string; defaultExample: string }
export interface TemplateTextItem { key: string; title: string; text: string; defaultText: string; customized: boolean; example: string }
export interface TemplateVariable { group: string; code: string; label: string; description: string; example: string }
/** Vista previa de ACTIVACIÓN de un horario (GET /schedules/:id/activation-preview). Nada se activa solo: el usuario confirma. */
export interface ActivationPreview {
  schedule: { id: string; kind: string; label: string; localTime: string; weekdays: number[]; scope: string; enabled: boolean; timezone: string; armedAt: string | null; nextOccurrence: string | null; nextOccurrenceLocal: string | null };
  template: { id: string; name: string; body: string } | null;
  textExample: string | null; usesVariables: string[]; unknownVariables: string[];
  /** null = el servidor no pudo calcularlo (se muestra «No se pudo calcular»). */
  eligibleDrivers: number | null; eligibleReason: string | null; canActivate: boolean; blockers: string[];
  /** La próxima ejecución es HOY (y en cuántos minutos): se destaca en la confirmación. */
  nextIsToday: boolean; minutesUntilNext: number | null; deactivatedReason: string | null; deactivatedAt: string | null;
}
/** Horario que usa una plantilla (GET /templates/:id/usage). */
export interface TemplateUsage { id: string; kind: string; label: string; localTime: string; weekdays: number[]; enabled: boolean }
/** Texto base (antes «predeterminado») de un tipo de horario (GET /schedules/default-templates). */
export interface DefaultTemplate { kind: string; suggestedName: string; body: string }
/** Vista previa con el MISMO resolvedor que el envío: `unresolved` lista variables desconocidas o vacías (ese mensaje no se enviaría). */
export interface TemplatePreview { text: string; unresolved: string[] }
export interface MessageTemplate { id: string; name: string; body: string }
export type MessageTemplateInput = Omit<MessageTemplate, 'id'> & { id?: string };

export type ScheduleKind = 'debt_first' | 'debt_update' | 'debt_last' | 'debt_reminder' | 'weekly_summary';
export type ScheduleScope = 'total' | 'today' | 'overdue';
export interface NotificationSchedule {
  id: string; kind: ScheduleKind; label: string;
  /** 'HH:MM' en hora local de Panamá. */
  localTime: string;
  /** 1 = lunes … 7 = domingo. */
  weekdays: number[];
  templateId: string | null; scope: ScheduleScope; enabled: boolean;
  /** El servidor desactiva un horario activo cuyo contenido cambió: motivo ('config_changed') y cuándo. Ausentes si el servidor no los trae. */
  deactivatedReason?: string | null; deactivatedAt?: string | null;
}
export type NotificationScheduleInput = Omit<NotificationSchedule, 'id'> & { id?: string };

// ---- Informes de cobranza (period_summary / period_detail / period_series) ----
export interface PeriodSummary {
  from: string; to: string;
  chargesGeneratedCents: Cents; adjustmentsChargedCents: Cents; expectedCents: Cents;
  paymentsCount: number; grossCents: Cents; commissionCents: Cents; netCents: Cents;
  appliedCents: Cents; appliedToPeriodCents: Cents; priorDebtRecoveredCents: Cents; creditsGeneratedCents: Cents;
  pendingEndCents: Cents; creditsEndCents: Cents; driversWithDebtEnd: number;
  differenceCents: Cents; recoveryPct: number | null;
}
export type PeriodIndicator =
  'charges' | 'gross' | 'commission' | 'net' | 'applied' | 'credits_generated' | 'prior_debt_recovered' | 'pending' | 'credits';
export interface PeriodDetailRow {
  occurredOn: string; kind: string; unitCode: string; operatorCode: string; fullName: string; amountCents: Cents; detail: string | null;
}
export interface PeriodSeriesRow {
  weekStart: string; expectedCents: Cents; grossCents: Cents; commissionCents: Cents; netCents: Cents;
  pendingEndCents: Cents; creditsEndCents: Cents; differenceCents: Cents; recoveryPct: number | null;
}

// ---- Mensajes de prueba de WhatsApp (solo SUPER_ADMIN) ----
export type TestMessageStatus = 'prepared' | 'processing' | 'simulated' | 'sent' | 'delivered' | 'failed' | 'unconfirmed' | 'cancelled';
export type TestMessageKind = 'test' | 'payment_receipt_preview';
/** Rótulos honestos: «sent» = lo aceptó el proveedor (OpenWA), NO que se haya entregado. */
export const TEST_STATUS_LABEL: Record<TestMessageStatus, string> = {
  prepared: 'Preparado / En cola', processing: 'Enviando', simulated: 'Simulado', sent: 'Enviado al proveedor', delivered: 'Entregado', failed: 'Fallido (confirmado)', unconfirmed: 'Resultado sin confirmar', cancelled: 'Cancelado',
};
export interface TestPreview {
  recipient: string | null; invalidPhone: boolean; recipientIsADriver: boolean; body: string; chars: number;
  sender: string | null; sessionStatus: WhatsappStatus | null; sendingMode: SendingMode; realTestEnabled: boolean;
}
export interface TestMessageRequest {
  phone: string; body: string; mode: 'simulated' | 'real'; idempotencyKey: string; kind?: TestMessageKind; recipientAuthorization?: string; confirmLast4?: string;
}
export interface TestMessage {
  id: string; kind: TestMessageKind; recipientPhone: string; body: string; requestedMode: 'simulated' | 'real'; status: TestMessageStatus;
  senderPhone: string | null; providerMessageId: string | null; error: string | null; recipientAuthorization: string | null;
  createdAt: string; processedAt: string | null; deliveredAt: string | null;
  authorizedBy: string | null; claimedAt: string | null; errorDetail: string | null; resolvedBy: string | null; resolvedAt: string | null; resolutionNote: string | null;
}
/** Mensaje a un conductor (POST /messages/driver). El número y la autorización salen de la ficha. Mismos estados que los de prueba. */
export interface DriverMessage {
  id: string; driverId: string; recipientPhone: string; body: string; status: TestMessageStatus; senderPhone: string | null; providerMessageId: string | null;
  error: string | null; errorDetail: string | null; authorizedBy: string | null; createdAt: string; claimedAt: string | null; processedAt: string | null; deliveredAt: string | null;
  resolvedBy: string | null; resolvedAt: string | null; resolutionNote: string | null; firstName: string | null; lastName: string | null; operatorCode: string | null;
}
export interface DriverMessageRequest { driverId: string; body: string; idempotencyKey: string }
/** Rótulos de estado de un mensaje a conductor. «Entregado» solo con delivered. */
export const DRIVER_MESSAGE_LABEL: Record<TestMessageStatus, string> = {
  prepared: 'En cola', processing: 'Enviando', simulated: 'Simulado (modo de pruebas)', sent: 'Enviado', delivered: 'Entregado',
  failed: 'No enviado (fallo confirmado)', unconfirmed: 'Resultado sin confirmar', cancelled: 'Cancelado',
};
export interface ReceiptPreviewRequest { unit: string; methodCode: string; grossCents: number; pendingBeforeCents: number }
export interface ReceiptPreview { grossCents: number; commissionCents: number; netCents: number; pendingCents: number; creditCents: number; body: string }

// ---- Horarios de envío (0035): a la hora indicada, esta plantilla a esta audiencia ----
export type SendAudience = 'all' | 'with_balance' | 'without_balance' | 'not_paid_today' | 'paid_today' | 'selected';
export const SEND_AUDIENCES: ReadonlyArray<{ value: SendAudience; label: string; hint: string }> = [
  { value: 'all', label: 'Todos los conductores', hint: 'Todos los operarios activos con WhatsApp.' },
  { value: 'with_balance', label: 'Con saldo pendiente', hint: 'SALDO del Excel mayor que $0.' },
  { value: 'without_balance', label: 'Sin saldo pendiente', hint: 'SALDO del Excel en $0 o a favor.' },
  { value: 'not_paid_today', label: 'No pagaron hoy', hint: 'Sin pago del día en el Excel (solo unidades del Excel).' },
  { value: 'paid_today', label: 'Pagaron hoy', hint: 'Con pago del día en el Excel.' },
  { value: 'selected', label: 'Conductores que yo elija', hint: 'Se envía a la lista que marques, hayan pagado o no, hasta que la cambies.' },
];
export interface Recipient { assignmentId: string; unitCode: string; operatorCode: string; fullName: string; phone: string; saldoCents: number | null }
export interface SendSchedule {
  id: string; name: string; localTime: string; weekdays: number[]; templateId: string | null; templateName: string | null; audience: SendAudience; enabled: boolean;
  lastRunDate: string | null; lastRunStatus: 'running' | 'done' | 'missed' | 'error' | null; lastRunCreated: number | null; lastRunTotal: number | null;
  /** Lista marcada a mano (solo audiencia «selected»). */
  assignmentIds?: string[];
}
export type SendScheduleInput = Pick<SendSchedule, 'name' | 'localTime' | 'weekdays' | 'templateId' | 'audience' | 'enabled' | 'assignmentIds'> & { id?: string };

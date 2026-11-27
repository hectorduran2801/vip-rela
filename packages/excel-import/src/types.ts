/** Tipos públicos del importador. Todo el dinero está en centavos enteros. */

export type SaldoState = 'empty' | 'zero' | 'amount' | 'text';

export type MatchStatus = 'unmatched' | 'matched' | 'conflict' | 'duplicate' | 'ignored';

/** Conductor existente contra el que se concilia (solo lectura). */
export interface DriverRef { id: string; operatorCode: string; nationalId: string }

/** Contexto de la vista previa (instancia única; sin base de datos: los conductores se pasan ya cargados). */
export interface PreviewContext {
  /** Conductores existentes; si se omite, todas las filas quedan 'unmatched'. */
  drivers?: DriverRef[];
  /** Directorio completo (conductores, unidades, asignaciones vigentes): habilita las diferencias y los buckets. Tiene prioridad sobre `drivers`. */
  directory?: Directory;
}

export type ImportKind = 'cobranza' | 'directory' | 'collection_flat';

export interface DirectoryDriver extends DriverRef { firstName: string; lastName: string; phoneE164: string | null; status: string; /** Consentimiento de cobranza por WhatsApp vigente (omitido = false). */ whatsappConsent?: boolean }
/** Asignación vigente (valid_to nulo) con su tarifa diaria vigente (null si no tiene). */
export interface DirectoryAssignment { driverId: string; unitCode: string; dailyRateCents: number | null }
export interface Directory {
  drivers: DirectoryDriver[]; units: string[]; assignments: DirectoryAssignment[];
  /** Acuerdo registrado por unidad (clave = código en MAYÚSCULAS). Omitido = se desconoce. */
  unitAgreements?: Record<string, string | null>;
}

export type FieldDiff = { from: string | null; to: string | null };
/** Diferencias de una fila frente a lo existente (solo informativo; se guarda en import_rows.changes). */
export interface RowChanges {
  /** pending_review = falta código de operario, cédula o nombre para CREAR el conductor: se crea la unidad (si hay) y el conductor queda PENDIENTE DE REVISIÓN (`reasons`), sin inventar datos ni asignación. */
  driver?: { action: 'create' | 'update' | 'unchanged' | 'pending_review'; fields?: Record<string, FieldDiff>; reasons?: DriverReviewReason[] };
  unit?: { action: 'new' | 'existing' | 'none' };
  /** `change` (solo cobranza plana) = la unidad cambia de operario (currentOperator → el del archivo); la BD decide si es aplicable (semana cerrada, cuotas generadas...). */
  assignment?: { action: 'new' | 'same' | 'conflict' | 'none' | 'change'; currentUnit?: string | null; currentOperator?: string | null; reason?: string };
  rate?: { action: 'new' | 'same' | 'differs' | 'none'; from?: number | null; to?: number | null };
  /** Acuerdo / condición especial de la unidad (texto libre): set (no tenía), change (otro texto), same, clear ('-'), none (vacío = sin cambio). */
  agreement?: { action: 'none' | 'set' | 'change' | 'same' | 'clear'; from?: string | null; to?: string | null };
  /**
   * Consentimiento de WhatsApp (solo cobranza): grant (se registrará), withdraw (se retirará: cambio destacado), unchanged (ya estaba así),
   * ignored (se pidió pero NO se aplica; `reason`), none (celda vacía). `current` = consentimiento vigente del conductor.
   */
  consent?: { action: 'none' | 'grant' | 'withdraw' | 'unchanged' | 'ignored'; reason?: ConsentIgnoreReason; current?: boolean; origin?: string | null };
}
/** Motivo por el que un conductor queda pendiente de revisión (faltan datos obligatorios para crearlo). */
export type DriverReviewReason = 'missing_operator' | 'missing_national_id' | 'missing_first_name';
export type ConsentIgnoreReason = 'missing_origin' | 'missing_phone' | 'invalid_value' | 'no_driver';

/** Contexto de escritura a preparación. */
export interface StageContext {
  /** auth.users.id de quien importa (created_by). */
  userId: string;
}

/** Cliente mínimo (pg.Client, PoolClient o el `Q` del arnés). El llamador controla transacción y rol/RLS. */
export interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

export const DAY_KEYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;
export type DayKey = (typeof DAY_KEYS)[number];

/** Una fila del Excel ya interpretada (nada de esto es un movimiento financiero). */
export interface ParsedRow {
  sourceRow: number;
  unitCode: string | null;
  operatorCode: string | null;
  nationalId: string | null;
  fullName: string | null;
  dailyRateCents: number | null;
  rawAgreement: string | null;
  rawSaldo: string | null;
  /** Columna MENSAJE del Excel de cobranza (null = el archivo no la trae). */
  sendFlag?: boolean | null;
  /**
   * SALDO interpretado (NUNCA es un movimiento por sí solo): empty = celda vacía (NO es un cero confirmado), zero = 0 explícito,
   * amount = deuda arrastrada > 0, text = no numérico / negativo / ambiguo. `saldoCents` solo para zero/amount.
   */
  saldoState?: SaldoState;
  saldoCents?: number | null;
  /** lun..dom en centavos; null = vacío */
  dayAmountsCents: (number | null)[];
  excelWeeklyDiffCents: number | null;
  excelWeeklyExpectedCents: number | null;
  /** Fórmula original por campo lógico (rate, saldo, monday, ..., weekly_diff, weekly_expected). */
  originalFormulas: Record<string, string>;
  /** Formato `codigo` o `codigo:detalle`. */
  warnings: string[];
  matchStatus: MatchStatus;
  matchedDriverId: string | null;
  // Solo formato plantilla:
  firstName?: string | null;
  lastName?: string | null;
  /** Celda WhatsApp original (bloques y plantilla), sin normalizar. */
  rawPhone?: string | null;
  /** E.164 normalizado (null = vacío o inválido: ver advertencia `invalid_phone`). */
  phoneE164?: string | null;
  /** Estado normalizado al enum de BD (active|inactive|suspended|pending_approval) o null = sin cambio. */
  rowStatus?: string | null;
  changes?: RowChanges;
  /** Acuerdo / condición especial de la unidad: TEXTO LIBRE original (solo recortado). En plantilla '-' = quitar; null = sin dato / sin cambio. */
  unitAgreement?: string | null;
  /** Observación independiente del acuerdo (solo plantilla). */
  unitAgreementNote?: string | null;
  /** Consentimiento de cobranza pedido en el Excel y VÁLIDO en el análisis: grant = «SI» con origen; withdraw = «NO»; null = vacío/ignorado. Solo plantilla. */
  consentRequest?: 'grant' | 'withdraw' | null;
  /** Origen declarado del consentimiento (texto libre recortado). */
  consentOrigin?: string | null;
}

export interface ParsedBlock {
  blockIndex: number;
  startColumn: string;
  headerVariant: 'sem_corriente' | 'pago_semanal' | 'desconocida' | 'plantilla' | 'plana';
  /** Campos resueltos por posición relativa porque el texto de la cabecera no se reconoció. */
  positionalFallbackFields: string[];
  /** Siempre null: el Excel no trae fechas. */
  detectedWeekStart: null;
  rows: ParsedRow[];
}

export interface Buckets {
  /** Cobranza plana: `total` = operarios únicos del archivo; `withSeveralUnits` = operarios con 2+ unidades (válido). */
  drivers: { new: number; existing: number; toUpdate: number; unchanged: number; total?: number; withSeveralUnits?: number };
  /** withoutDriver: unidades del archivo que quedarán sin conductor; withAgreement: unidades únicas con acuerdo no ambiguo. */
  /** Cobranza plana: `total` = unidades únicas; `unchanged`/`changed` = unidades existentes sin/con cambios (acuerdo, operario, cuota) frente al directorio. */
  units: { new: number; existing: number; withoutDriver: number; withAgreement: number; total?: number; unchanged?: number; changed?: number };
  assignments: { new: number; same: number; conflicts: number };
  rates: { new: number; same: number; differs: number };
  /** Filas con errores que impiden aprobarlas con 'clean' (cédula/operador/nombre faltante, estado inválido, #REF...). */
  errors: number;
  /** Conductores PENDIENTES DE REVISIÓN: filas con unidad a las que les falta código de operario, cédula (o nombre) para crear el conductor. La unidad sí se importa; no se crea conductor ni asignación. */
  driversPendingReview: number;
  conflicts: number;
  duplicates: number;
  /** Filas que no se importan (totales, ignoradas). */
  skipped: number;
}

export interface ImportSummary extends Buckets {
  kind: ImportKind;
  /** Cobranza: conductores/unidades ÚNICOS (un conductor en 21 bloques cuenta una vez). Plantilla: filas válidas. */
  uniqueDrivers: number;
  /** Solo plantilla: contadores del consentimiento de WhatsApp (cobranza) de las filas aplicables. */
  consents?: ConsentSummary;
  /** Solo cobranza: conductores cuya unidad/tarifa se resuelve sin adivinar, por política de apply_import. */
  assignmentsResolvable?: { skip: number; latestBlock: number };
  /** Solo cobranza. */
  ambiguity?: { unitAmbiguous: number; rateAmbiguous: number; nationalIdsDiffer: number; unitsWithSeveralDrivers: number; agreementAmbiguous: number };
  /** Teléfonos de WhatsApp de las filas aplicables: con valor, válidos, inválidos, normalizados agregando +507 y números repartidos entre varios operarios. */
  phones?: { withValue: number; valid: number; invalid: number; added507: number; empty: number; sharedByDrivers: number };
  /** Solo cobranza: SALDO por estado (una celda vacía NO es un cero) y suma de los importes (deuda arrastrada informada; todavía no es un movimiento). */
  saldo?: { empty: number; zero: number; amount: number; text: number; totalAmountCents: number };
  /** Solo cobranza plana: pagos LUN–DOM presentes en el archivo (celda vacía = sin dato; 0 explícito cuenta aparte). */
  paymentsInFile?: { cells: number; nonZero: number; explicitZero: number; totalCents: number; unitsWithPayments: number };
  /** Solo cobranza plana: errores/avisos con fila de Excel, columna (cabecera) y motivo en español (máx. 1000; `issuesTotal` = total real). */
  issues?: FlatIssue[];
  issuesTotal?: number;
  blocks: number;
  rows: number;
  /** Filas totalmente vacías que no se importan. */
  emptyRowsSkipped: number;
  warningsByType: Record<string, number>;
  rowsWithWarnings: number;
  matchCounts: Record<MatchStatus, number>;
  candidatePayments: number;
  hoja2: { present: boolean; units: number; duplicates: string[]; onlyInHoja2: string[]; unitsNotInHoja2: number };
  blockSummaries: { blockIndex: number; startColumn: string; headerVariant: string; rows: number; warnings: number }[];
}

export interface FlatIssue { row: number; column: string; code: string; level: 'error' | 'warning' | 'info'; message: string }

export interface ConsentSummary {
  /** Consentimientos que se registrarán («SI» + origen + teléfono). */
  toGrant: number;
  /** Consentimientos que se retirarán («NO» sobre un conductor con consentimiento): cambio destacado. */
  toWithdraw: number;
  /** «SI»/«NO» que ya coinciden con el estado actual (no cambia nada). */
  unchanged: number;
  /** Filas con consentimiento ignorado, por motivo. */
  ignored: { total: number; missingOrigin: number; missingPhone: number; invalidValue: number; noDriver: number };
}

export interface ImportPreview {
  kind: ImportKind;
  fileName: string;
  fileSha256: string;
  blocks: ParsedBlock[];
  summary: ImportSummary;
}

export interface StageResult {
  /** false = el archivo (sha256) ya estaba importado; se devuelve el existente sin escribir nada. */
  created: boolean;
  importId: string;
  status: 'previewed' | 'confirmed' | 'rejected';
  fileSha256: string;
  summary: ImportSummary;
}

export interface ConfirmOptions {
  /** Ids de import_rows a aprobar, o 'clean' = sin conflicto/duplicado/ignorada ni advertencias de error. */
  approve: string[] | 'clean';
}
export interface ConfirmResult { importId: string; approvedRows: number; status: 'confirmed' }

/** Advertencias que impiden aprobar automáticamente una fila ('clean'). */
/** Advertencias informativas del consentimiento (no bloquean la fila): consent_ignored:<motivo>, consent_withdrawal. */
export const CONSENT_WARNING = 'consent_ignored';
export const DIRECTORY_BLOCKING_WARNINGS = ['missing_first_name', 'missing_unit', 'invalid_status', 'agreement_too_long', 'agreement_note_too_long', 'totals_row'] as const;
/** Advertencias que cuentan como error en el bucket `errors`. */
/** «Requiere revisión» (ya NO son errores ni bloquean 'clean'): la unidad se importa, el conductor queda pendiente y no se inventa ningún dato. */
export const REVIEW_WARNINGS = ['missing_operator', 'missing_national_id'] as const;
export const ERROR_WARNINGS = ['formula_ref_error', 'totals_row', 'missing_first_name', 'missing_unit', 'invalid_status', 'agreement_too_long', 'agreement_note_too_long'] as const;
/** Cobranza plana: códigos de error (impiden aplicar la fila; `apply_collection_sync` no los conoce, la API/UI debe bloquear). */
export const FLAT_ERROR_WARNINGS = ['missing_unit', 'duplicate_unit', 'invalid_amount', 'invalid_rate', 'formula_ref_error', 'cell_error', 'agreement_too_long'] as const;
export const BLOCKING_WARNINGS = ['agreement_too_long', 'formula_ref_error', 'totals_row', 'duplicate_operator_in_block', 'duplicate_national_id_in_block'] as const;

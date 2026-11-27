/**
 * Catálogo CENTRAL de advertencias del importador de Excel (packages/excel-import): convierte cada código técnico en mensaje español, gravedad y ayuda.
 * Los códigos técnicos solo se muestran en el «Detalle técnico» plegado. Una prueba recorre el código fuente del importador y falla si aparece un código sin traducción.
 *
 * Gravedad (3 niveles):
 *  - info   → INFORMACIÓN: el dato es válido y se conserva (p. ej. un pago mayor que la cuota puede ser recuperación de deuda anterior).
 *  - review → REQUIERE REVISIÓN: no bloquea, pero conviene mirarlo antes de aprobar.
 *  - error  → ERROR que bloquea el registro de esa fila (BLOCKING_WARNINGS / DIRECTORY_BLOCKING_WARNINGS / ERROR_WARNINGS del importador y conflictos/duplicados sin resolver).
 */
export type WarningSeverity = 'info' | 'review' | 'error';
export const SEVERITY_ORDER: WarningSeverity[] = ['error', 'review', 'info'];
export const SEVERITY_LABEL: Record<WarningSeverity, string> = { error: 'Error: bloquea el registro', review: 'Requiere revisión', info: 'Información' };
export const SEVERITY_SHORT: Record<WarningSeverity, string> = { error: 'Errores', review: 'A revisar', info: 'Información' };
/** Clase de color (chip) por gravedad. */
export const SEVERITY_TONE: Record<WarningSeverity, string> = { error: 'pending', review: 'attn', info: 'credit' };

export const DAY_ES: Record<string, string> = { monday: 'lunes', tuesday: 'martes', wednesday: 'miércoles', thursday: 'jueves', friday: 'viernes', saturday: 'sábado', sunday: 'domingo' };
export const DAY_ORDER = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const FIELD_ES: Record<string, string> = {
  und: 'Und', operator: 'Operario', national_id: 'Cédula', full_name: 'Nombre', rate: 'Cuenta (cuota diaria)', agreement: 'Acuerdo', saldo: 'SALDO', weekly_diff: 'Pago semanal',
  weekly_expected: 'Cuenta semanal', phone: 'WhatsApp', weekly: 'tarifa semanal', daily: 'tarifa diaria', unit: 'unidad', first_name: 'nombre', ...DAY_ES,
};
const fieldEs = (f: string): string => FIELD_ES[f] ?? 'una columna';

interface Def { title: string; message: (s: string) => string; help: string; severity: WarningSeverity }
const d = (severity: WarningSeverity, title: string, help: string, message?: (s: string) => string): Def => ({ severity, title, help, message: message ?? (() => title) });

const DEFS: Record<string, Def> = {
  // ── Informativas (válidas) ──
  amount_over_rate: d('info', 'Importe superior a la cuota diaria', 'Puede ser recuperación de deuda anterior. Los importes se conservan para conciliación; no se registran como pagos definitivos sin validar el período.',
    (s) => (DAY_ES[s] ? `El pago del ${DAY_ES[s]} supera la cuota diaria` : 'Importe superior a la cuota diaria')),
  sunday_amount: d('info', 'Pago registrado el domingo', 'El domingo no tiene cuota, pero puede haber abonos. Se conserva para conciliación.'),
  unit_vacated: d('review', 'Unidad sin operario: se finaliza la asignación', 'La fila no trae operario, nombre, cédula ni WhatsApp. VIP cierra la asignación vigente y conserva su historial; la unidad no recibe pagos ni mensajes.'),
  phone_updated: d('info', 'WhatsApp actualizado', 'El número del Excel sustituye al registrado.'),
  operator_with_several_units: d('info', 'Operario con varias unidades', 'Es válido: cada unidad conserva su propia cobranza, pagos y saldo.'),
  rate_zero: d('info', 'Cuota diaria en cero', 'La unidad se importa igual, pero no se generan cuotas mientras la cuenta sea 0.'),
  weekly_account_differs: d('info', 'La cuenta semanal no es cuota × 6', 'El Excel trae una cuenta semanal distinta a la cuota diaria por seis. Se usa solo como referencia; VIP calcula con la cuota diaria.'),
  duplicate_unit: d('error', 'Unidad repetida en el archivo', 'El código de unidad aparece en más de una fila. Deja una sola fila por unidad.'),
  invalid_amount: d('error', 'Importe no válido', 'La celda debe ser un número positivo (o quedar vacía). Corrige el valor y vuelve a cargar.'),
  cell_error: d('error', 'Celda con error', 'La celda contiene un error de Excel (por ejemplo #REF!). Corrígela y vuelve a cargar.'),
  unit_without_driver: d('info', 'Unidad sin conductor asignado', 'Es válido: la unidad se crea o se conserva sin conductor.'),
  phone_added_507: d('info', 'Se agregó +507 al WhatsApp', 'WhatsApp se acepta con o sin 507: los números de 8 dígitos se completan con +507.'),
  operator_in_other_blocks: d('info', 'Operario presente en otros bloques', 'Es normal: el mismo conductor aparece en varias semanas del Excel.'),
  filled_from_existing: d('info', 'Dato completado con el registro existente', 'La celda estaba vacía y se usó el valor que VIP ya tiene.', (s) => `Se completó ${fieldEs(s)} con el valor existente`),
  // ── Requieren revisión ──
  zero_rate: d('review', 'Tarifa diaria en cero', 'La fila tiene conductor pero la cuota diaria es 0: revisa la tarifa antes de aprobar.'),
  zero_rate_empty_row: d('review', 'Fila sin conductor y con tarifa cero', 'Parece una fila vacía o de relleno; se ignora si no la apruebas.'),
  placeholder_operator: d('review', 'Código de operario provisional o inválido', 'Valores como «0», «-» o «.» no son un operario real: la celda se tomó como vacía.'),
  placeholder_national_id: d('review', 'Cédula provisional o inválida', 'Valores como «0», «-» o «.» no son una cédula real: la celda se tomó como vacía.'),
  placeholder: d('review', 'Valor provisional o inválido', 'Un marcador de posición («0», «-», «.») se tomó como celda vacía.', (s) => `Valor provisional o inválido en ${fieldEs(s)}`),
  operator_with_several_national_ids: d('review', 'Operario asociado a varias cédulas', 'El mismo código de operario aparece con cédulas distintas en el archivo: confirma cuál es la correcta.'),
  national_id_with_several_operators: d('review', 'Cédula asociada a varios operarios', 'La misma cédula aparece con códigos de operario distintos en el archivo.'),
  atypical_formula: d('review', 'Fórmula de Excel no habitual', 'La celda no usa la fórmula acostumbrada; el valor se muestra tal cual y no se recalcula.', (s) => `Fórmula de Excel no habitual en ${fieldEs(s)}`),
  fixed_value_instead_of_formula: d('review', 'Valor fijo en lugar de fórmula', 'La celda trae un número escrito a mano donde se esperaba una fórmula.', (s) => `Valor fijo en lugar de fórmula en ${fieldEs(s)}`),
  weekly_diff_mismatch: d('review', 'El pago semanal del Excel no cuadra', 'La diferencia semanal del Excel no coincide con la suma de los importes diarios; no se usa para registrar nada.'),
  saldo_text: d('review', 'SALDO con texto', 'El SALDO no es un número: no se puede usar como deuda anterior y se omite en la conciliación.'),
  saldo_negative: d('info', 'SALDO negativo (crédito)', 'Un SALDO negativo se interpreta como crédito a favor del operario.'),
  ambiguous_thousands: d('review', 'SALDO con separador de miles ambiguo', 'Un valor como «1,234» puede ser 1.234 o 1234: se trata como texto y se omite.'),
  invalid_phone: d('review', 'WhatsApp inválido', 'El número no tiene un formato válido: se ignora y no se guarda.', () => 'WhatsApp inválido: se ignora'),
  text_in_numeric_cell: d('review', 'Texto en una celda numérica', 'La celda debía ser un número pero trae texto.', (s) => `Texto en una celda numérica (${fieldEs(s)})`),
  error_value: d('review', 'Celda con error de Excel', 'La celda muestra un error de Excel (por ejemplo #DIV/0!): se toma como vacía.', (s) => `Celda con error de Excel en ${fieldEs(s)}`),
  unit_not_in_hoja2: d('review', 'Unidad que no está en la lista de unidades (Hoja2)', 'La hoja de unidades del Excel no incluye esta unidad: revisa si está bien escrita.'),
  agreement_ambiguous_across_blocks: d('review', 'Acuerdo distinto entre bloques', 'La misma unidad trae acuerdos distintos en varios bloques: no se aplica ninguno.'),
  agreement_differs_from_existing: d('review', 'El acuerdo difiere del actual de la unidad', 'Se respeta el acuerdo que VIP ya tiene; el del Excel no lo cambia.'),
  invalid_rate: d('review', 'Tarifa inválida', 'La tarifa no es un número mayor que cero: se ignora.', (s) => `Tarifa inválida (${fieldEs(s)})`),
  weekly_rate_inconsistent: d('review', 'Tarifa semanal distinta de la diaria × 6', 'La tarifa semanal no coincide con la diaria por 6 días: revisa cuál es la correcta.'),
  partial_identifier_match: d('review', 'Coincidencia por un solo identificador', 'Se encontró el conductor por el operario o la cédula, pero falta el otro dato en el Excel.'),
  consent_withdrawal: d('review', 'Retira autorización de cobranza', 'Al aplicar se retira la autorización y se cancelan los recordatorios pendientes de ese conductor.'),
  consent_ignored: d('review', 'Consentimiento ignorado', 'La autorización pedida en el Excel no se registra.', (s) => ({
    missing_origin: 'Consentimiento ignorado: falta el origen', missing_phone: 'Consentimiento ignorado: falta el teléfono', invalid_value: 'Consentimiento ignorado: valor no válido', no_driver: 'Consentimiento ignorado: no hay conductor' } as Record<string, string>)[s] ?? 'Consentimiento ignorado'),
  agreement_differs: d('review', 'El acuerdo del Excel difiere del actual', 'Se respetó el acuerdo actual de la unidad.'),
  // ── Errores: bloquean el registro de la fila ──
  formula_ref_error: d('error', 'Fórmula con #REF!', 'La referencia de la fórmula está rota: esa fila no se puede importar hasta corregir el Excel.', (s) => (s ? `Fórmula con #REF! en ${fieldEs(s)}` : 'Fórmula con #REF!')),
  totals_row: d('error', 'Fila de totales', 'Es una fila de totales del Excel, no un conductor: no se importa.'),
  missing_unit: d('error', 'Falta el código de unidad', 'La unidad es obligatoria: la fila no se puede importar sin ella.'),
  missing_operator: d('review', 'Falta el código de operario', 'Se importará la unidad sin crear conductor; el conductor queda pendiente de revisión; no se inventan códigos ni documentos.'),
  missing_national_id: d('review', 'Falta la cédula', 'Se importará la unidad sin crear conductor; el conductor queda pendiente de revisión; no se inventan códigos ni documentos.'),
  missing_first_name: d('error', 'Falta el nombre', 'El nombre es obligatorio para crear un conductor nuevo.'),
  invalid_status: d('error', 'Estado del conductor no válido', 'Usa uno de los estados permitidos (activo, inactivo, suspendido, pendiente).'),
  agreement_too_long: d('error', 'Acuerdo de más de 200 caracteres', 'El acuerdo es demasiado largo: acórtalo en el Excel.'),
  agreement_note_too_long: d('error', 'Observación de más de 1000 caracteres', 'La observación es demasiado larga: acórtala en el Excel.'),
  duplicate_operator_in_block: d('error', 'Operario repetido en el bloque', 'El mismo operario aparece más de una vez en el bloque: no se importa hasta resolver el duplicado.'),
  duplicate_national_id_in_block: d('error', 'Cédula repetida en el bloque', 'La misma cédula aparece más de una vez en el bloque: no se importa hasta resolver el duplicado.'),
  duplicate_operator_in_file: d('error', 'Operario repetido en el archivo', 'El mismo operario aparece en varias filas del archivo: todas quedan sin importar hasta resolverlo.'),
  duplicate_national_id_in_file: d('error', 'Cédula repetida en el archivo', 'La misma cédula aparece en varias filas del archivo: todas quedan sin importar hasta resolverlo.'),
  conflict_operator_and_national_id_belong_to_different_drivers: d('error', 'Operario y cédula pertenecen a conductores distintos', 'El operario y la cédula del Excel corresponden a dos conductores diferentes en VIP: corrige el Excel.'),
  conflict_operator_exists_with_other_national_id: d('error', 'El operario ya existe con otra cédula', 'VIP ya tiene ese operario con una cédula distinta: corrige el Excel o el conductor.'),
  conflict_national_id_exists_with_other_operator: d('error', 'La cédula ya existe con otro operario', 'VIP ya tiene esa cédula con otro código de operario: corrige el Excel o el conductor.'),
  // ── Observaciones del resultado al aplicar (issues) que también se mapean aquí ──
  phone_conflict: d('review', 'El WhatsApp del Excel difiere del de la ficha', 'Se respetó el teléfono actual; el del Excel no lo sobrescribe.'),
  phone_ambiguous: d('review', 'WhatsApp distinto entre bloques', 'El mismo operario trae números distintos: no se adivina cuál usar.'),
};

/** Códigos base conocidos (para pruebas y para decidir si un código se puede traducir). */
export const KNOWN_WARNING_BASES: readonly string[] = Object.keys(DEFS);

export interface WarningInfo {
  code: string; base: string; suffix: string; known: boolean;
  /** Nombre del TIPO de advertencia (para agrupar). */
  title: string;
  /** Mensaje de esta ocurrencia (con el día o la columna si el código lleva sufijo). */
  message: string;
  help: string; severity: WarningSeverity;
}

/** Separa «amount_over_rate:monday» → base + sufijo; «placeholder_operator» se resuelve por su nombre completo o como «placeholder» + campo. */
export function splitWarning(code: string): { base: string; suffix: string } {
  const i = code.indexOf(':');
  const base = i < 0 ? code : code.slice(0, i), suffix = i < 0 ? '' : code.slice(i + 1);
  if (!DEFS[base] && base.startsWith('placeholder_')) return { base: 'placeholder', suffix: base.slice('placeholder_'.length) };
  return { base, suffix };
}

/** Traduce un código del importador. Un código desconocido NO se muestra crudo: sale como «Aviso sin traducir» (el código solo va en el detalle técnico). */
export function describeWarning(code: string): WarningInfo {
  const { base, suffix } = splitWarning(code);
  const def = DEFS[base] ?? DEFS[code];
  if (!def) return { code, base, suffix, known: false, title: 'Aviso sin traducir', message: 'Aviso sin traducir', help: 'El importador devolvió un aviso que esta versión no reconoce: revisa la fila.', severity: 'review' };
  return { code, base, suffix, known: true, title: def.title, message: def.message(suffix), help: def.help, severity: def.severity };
}

export interface WarningGroup { base: string; title: string; help: string; severity: WarningSeverity; count: number; codes: string[] }
/** Agrupa por TIPO (una línea por tipo con conteo, aunque el código lleve sufijo de día o columna). `counts` = ocurrencias por código. */
export function groupByType(counts: Record<string, number>): WarningGroup[] {
  const m = new Map<string, WarningGroup>();
  for (const [code, n] of Object.entries(counts)) {
    const w = describeWarning(code);
    const g = m.get(w.title) ?? { base: w.base, title: w.title, help: w.help, severity: w.severity, count: 0, codes: [] };
    g.count += n; g.codes.push(code); m.set(w.title, g);
  }
  return [...m.values()].sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) || b.count - a.count);
}
export function severityTotals(groups: WarningGroup[]): Record<WarningSeverity, number> {
  const t: Record<WarningSeverity, number> = { error: 0, review: 0, info: 0 };
  for (const g of groups) t[g.severity] += g.count;
  return t;
}
/** Gravedad más alta de un conjunto de códigos. */
export function topSeverity(codes: string[]): WarningSeverity | null {
  let best: WarningSeverity | null = null;
  for (const c of codes) { const s = describeWarning(c).severity; if (best === null || SEVERITY_ORDER.indexOf(s) < SEVERITY_ORDER.indexOf(best)) best = s; }
  return best;
}

/** Días (lunes…domingo) con importe superior a la cuota diaria, según los importes de la fila (valores tal cual: no se alteran). */
export function daysOverRate(dayAmountsCents: (number | null)[], dailyRateCents: number | null): { day: string; amountCents: number }[] {
  if (!dailyRateCents || dailyRateCents <= 0) return [];
  return dayAmountsCents.flatMap((a, i) => (i < 6 && a !== null && a > dailyRateCents ? [{ day: DAY_ES[DAY_ORDER[i]!]!, amountCents: a }] : []));
}

/** Observaciones del resultado de aplicar (issues del servidor). */
export const ISSUE_LABEL: Record<string, string> = {
  national_id_ambiguous: 'Cédulas distintas para el mismo operario',
  agreement_ambiguous: 'Acuerdo ambiguo (valores distintos para la misma unidad): no se aplicó',
  agreement_differs: 'El acuerdo del Excel difiere del actual de la unidad: se respetó el actual',
  agreement_invalid: 'Acuerdo inválido (supera 200 caracteres): no se aplicó',
  condition_ambiguous: 'Condición ambigua (valores distintos para la misma unidad): no se aplicó',
  condition_differs: 'La condición del Excel difiere de la actual de la unidad: se respetó la actual',
  condition_invalid: 'Condición inválida: no se aplicó',
  assignment_conflict: 'Conflicto de asignación: el conductor o la unidad ya tienen otra asignación vigente',
  consent_ignored_missing_origin: 'Consentimiento ignorado: falta el origen',
  consent_ignored_missing_phone: 'Consentimiento ignorado: falta el teléfono',
  driver_incomplete: 'Conductor incompleto: faltan datos obligatorios',
  driver_pending_review: 'Conductor pendiente de revisión: falta el código de operario o la cédula; no se inventaron datos',
  identity_conflict: 'Conflicto de identidad: el operario y la cédula no coinciden con el mismo conductor',
  phone_ambiguous: 'WhatsApp distinto entre bloques: no se adivinó cuál usar',
  phone_conflict: 'El WhatsApp del Excel difiere del de la ficha: se respetó el actual',
  rate_ambiguous: 'Tarifa ambigua (distintas entre bloques): se omitió',
  rate_differs: 'La tarifa del Excel difiere de la vigente',
  resolved_by_latest_block: 'Resuelto con el bloque más reciente',
  row_failed: 'La fila no se pudo procesar',
  unit_already_assigned: 'La unidad ya tiene otro conductor asignado',
  unit_ambiguous: 'Unidad ambigua: hay varias coincidencias',
};
export const issueLabel = (code: string): string => ISSUE_LABEL[code] ?? 'Observación del importador (ver detalle técnico)';

/** Estados de revisión de una fila del Excel. */
export const REVIEW_LABEL: Record<string, string> = { pending: 'Pendiente de revisión', approved: 'Aprobada', rejected: 'Rechazada', skipped: 'Omitida' };
export const reviewLabel = (s: string | null | undefined): string => (s ? (REVIEW_LABEL[s] ?? 'Sin clasificar') : '—');
/** Acción que aplicó el servidor sobre una fila. */
export const APPLIED_LABEL: Record<string, string> = {
  created: 'Creado', linked: 'Vinculado', updated: 'Actualizado', unchanged: 'Sin cambios', skipped: 'Omitido', rejected: 'Rechazado', excluded: 'Excluido',
  create: 'Crear', update: 'Actualizar', link: 'Vincular', skip: 'Omitir',
};
export const appliedLabel = (s: string | null | undefined): string => (s ? (APPLIED_LABEL[s] ?? 'Procesado') : '—');

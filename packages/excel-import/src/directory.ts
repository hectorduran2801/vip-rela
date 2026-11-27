import ExcelJS from 'exceljs';
import { toCents } from '@vip/shared';
import { parsePhone, normalizePhone } from './phone.js';
import { asText, cleanText, normalizeHeader, readCell, summarize, type BaseSummary } from './parser.js';
import type { ConsentIgnoreReason, DriverReviewReason, Directory, DirectoryAssignment, DirectoryDriver, ParsedBlock, ParsedRow, RowChanges } from './types.js';

/** Hoja de la plantilla (la única que se lee; 'Instrucciones' y 'Ejemplo' se ignoran). */
export const TEMPLATE_SHEET = 'Plantilla';

type TField = 'unit' | 'operator' | 'first_name' | 'last_name' | 'national_id' | 'phone' | 'daily_rate' | 'weekly_rate' | 'status' | 'agreement' | 'agreement_note' | 'consent' | 'consent_origin';

/** [campo, cabecera normalizada, distancia máxima de Levenshtein tolerada]. */
const TDICT: [TField, string, number][] = [
  ['unit', 'unidad', 2], ['unit', 'und', 0], ['unit', 'unit', 1],
  ['operator', 'codigodeoperador', 3], ['operator', 'codigodeoperario', 3], ['operator', 'codigooperario', 3], ['operator', 'operario', 2], ['operator', 'codigooperador', 3], ['operator', 'operador', 2], ['operator', 'codigo', 1], ['operator', 'codoperador', 2], ['operator', 'cod', 0],
  ['first_name', 'nombre', 1], ['first_name', 'nombres', 1],
  ['last_name', 'apellido', 2], ['last_name', 'apellidos', 2],
  ['national_id', 'cedula', 2], ['national_id', 'documento', 2], ['national_id', 'identificacion', 3],
  ['phone', 'whatsapp', 2], ['phone', 'telefono', 2], ['phone', 'celular', 2], ['phone', 'wsp', 0], ['phone', 'tel', 0], ['phone', 'cel', 0], ['phone', 'movil', 1],
  ['daily_rate', 'tarifadiaria', 3], ['daily_rate', 'tarifa', 1], ['daily_rate', 'cuentadiaria', 3],
  ['weekly_rate', 'tarifasemanal', 3], ['weekly_rate', 'tarifasemana', 3],
  ['status', 'estado', 1], ['status', 'status', 1],
  ['agreement', 'acuerdocondicionespecial', 6], ['agreement', 'acuerdo', 1], ['agreement', 'condicionespecial', 3], ['agreement', 'condicion', 2],
  ['consent', 'consentimientocobranzawhatsapp', 8], ['consent', 'consentimientowhatsapp', 6], ['consent', 'consentimientocobranza', 5], ['consent', 'consentimiento', 3],
  ['consent_origin', 'origendelconsentimiento', 6], ['consent_origin', 'origenconsentimiento', 5], ['consent_origin', 'origendeconsentimiento', 5], ['consent_origin', 'origen', 1],
  ['agreement_note', 'observacion', 2], ['agreement_note', 'observaciones', 2], ['agreement_note', 'comentariodelacondicion', 5], ['agreement_note', 'comentario', 2],
];

function lev(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)] as number[]);
  for (let j = 1; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length]![b.length]!;
}

/** Clasifica una cabecera de la plantilla (tolera acentos, mayúsculas, espacios, erratas y sinónimos). */
export function classifyTemplateHeader(raw: string): TField | null {
  const h = normalizeHeader(raw);
  if (!h) return null;
  let best: { f: TField; d: number } | null = null;
  for (const [f, w, max] of TDICT) {
    const d = lev(h, w);
    if (d <= max && (!best || d < best.d)) best = { f, d };
  }
  return best?.f ?? null;
}

/** Busca la fila de cabeceras (primeras 5 filas): debe reconocer al menos operador, cédula y otra columna. */
export function findTemplateHeader(ws: ExcelJS.Worksheet): { row: number; cols: Map<TField, number> } | null {
  for (let r = 1; r <= Math.min(5, ws.rowCount); r++) {
    const cols = new Map<TField, number>();
    for (let c = 1; c <= ws.columnCount; c++) {
      const f = classifyTemplateHeader(asText(readCell(ws.getRow(r).getCell(c))) ?? '');
      if (f && !cols.has(f)) cols.set(f, c);
    }
    if (cols.has('operator') && cols.has('national_id') && cols.size >= 3) return { row: r, cols };
  }
  return null;
}

// ───────── normalización de valores ─────────
/** Estado en español/inglés → enum de BD. undefined = no reconocido. */
export function normalizeStatus(raw: string): string | undefined {
  const k = normalizeHeader(raw);
  const map: Record<string, string> = {
    activo: 'active', active: 'active', activa: 'active',
    inactivo: 'inactive', inactive: 'inactive', inactiva: 'inactive',
    suspendido: 'suspended', suspended: 'suspended', suspendida: 'suspended',
    pendientedeaprobacion: 'pending_approval', pendiente: 'pending_approval', pendingapproval: 'pending_approval', pending: 'pending_approval',
  };
  return map[k];
}

const key = (s: string) => s.trim().toUpperCase();

// ───────── parser ─────────
export function parseDirectorySheet(ws: ExcelJS.Worksheet, dir: Directory = { drivers: [], units: [], assignments: [] }): { blocks: ParsedBlock[]; summary: BaseSummary } {
  const hdr = findTemplateHeader(ws);
  if (!hdr) throw new Error('No se reconocieron las cabeceras de la plantilla (se esperan al menos Código de operador y Cédula).');
  const { row: hrow, cols } = hdr;

  // Última fila con datos: las vacías intermedias se cuentan, las de formato posteriores no.
  let last = hrow;
  for (let r = hrow + 1; r <= ws.rowCount; r++)
    for (const c of cols.values()) if (readCell(ws.getRow(r).getCell(c)).kind !== 'empty') { last = r; break; }

  const rows: ParsedRow[] = [];
  let empty = 0;
  for (let r = hrow + 1; r <= last; r++) {
    const get = (f: TField) => (cols.has(f) ? readCell(ws.getRow(r).getCell(cols.get(f)!)) : { kind: 'empty' as const });
    if ([...cols.keys()].every((f) => get(f).kind === 'empty')) { empty++; continue; }
    const warnings: string[] = [];
    const txt = (f: TField): string | null => { const t = asText(get(f)); return t === null ? null : cleanText(t) || null; };
    const money = (f: TField): number | null => {
      const cv = get(f);
      if (cv.kind === 'empty') return null;
      let n: number | null = null;
      if (cv.kind === 'number') n = cv.num!;
      else if (cv.kind === 'text' && /^-?\d+([.,]\d+)?$/.test(cv.text!.replace(/^\$/, '').trim())) { n = Number(cv.text!.replace(/^\$/, '').trim().replace(',', '.')); warnings.push(`text_in_numeric_cell:${f}`); }
      if (n === null || !Number.isFinite(n) || n <= 0) { warnings.push(`invalid_rate:${f === 'weekly_rate' ? 'weekly' : 'daily'}`); return null; }
      return toCents(n);
    };

    const unit = txt('unit'), op = txt('operator'), nid = txt('national_id');
    const first = txt('first_name'), lastN = txt('last_name');
    let phone: string | null = null;
    const phoneRaw = txt('phone');
    if (phoneRaw) {
      const cv = get('phone'); const pr = parsePhone(cv.kind === 'number' ? cv.num : phoneRaw);
      phone = pr.e164; if (!phone) warnings.push('invalid_phone'); else if (pr.added507) warnings.push('phone_added_507');
    }
    let status: string | null = null;
    const statusRaw = txt('status');
    if (statusRaw) { status = normalizeStatus(statusRaw) ?? null; if (!status) warnings.push('invalid_status'); }
    // Acuerdo / condición especial: texto libre tal cual (recortado). '-' = quitar; vacío = sin cambio.
    const agreement = txt('agreement'); const agreementNote = txt('agreement_note');
    if (agreement && agreement.length > 200) warnings.push('agreement_too_long');
    if (agreementNote && agreementNote.length > 1000) warnings.push('agreement_note_too_long');
    // Consentimiento de cobranza por WhatsApp: SI/SÍ → grant (exige origen); NO → withdraw; vacío = sin cambio. Nunca se infiere del teléfono.
    const consentRaw = txt('consent'); const origin = txt('consent_origin');
    let consentRequest: 'grant' | 'withdraw' | null = null;
    if (consentRaw) {
      const v = normalizeHeader(consentRaw);
      if (v === 'si') { if (origin) consentRequest = 'grant'; else warnings.push('consent_ignored:missing_origin'); }
      else if (v === 'no') { consentRequest = 'withdraw'; }
      else warnings.push('consent_ignored:invalid_value');
    }
    const daily = money('daily_rate');
    const weekly = money('weekly_rate');
    if (daily !== null && weekly !== null && weekly !== daily * 6) warnings.push('weekly_rate_inconsistent');

    rows.push({
      sourceRow: r, unitCode: unit, operatorCode: op, nationalId: nid, fullName: [first, lastN].filter(Boolean).join(' ') || null,
      dailyRateCents: daily, rawAgreement: null, rawSaldo: null, dayAmountsCents: [], excelWeeklyDiffCents: null,
      excelWeeklyExpectedCents: weekly, originalFormulas: {}, warnings, matchStatus: 'unmatched', matchedDriverId: null,
      firstName: first, lastName: lastN, rawPhone: phoneRaw, phoneE164: phone, rowStatus: status, changes: {},
      unitAgreement: agreement, unitAgreementNote: agreementNote, consentRequest, consentOrigin: origin,
    });
  }

  markDuplicates(rows);
  diffAgainstDirectory(rows, dir);
  const block: ParsedBlock = { blockIndex: 1, startColumn: 'A', headerVariant: 'plantilla', positionalFallbackFields: [], detectedWeekStart: null, rows };
  const summary = summarize([block], empty, { present: false, units: 0, duplicates: [], onlyInHoja2: [], unitsNotInHoja2: 0 });
  return { blocks: [block], summary };
}

/** Mismo operador o misma cédula en varias filas del archivo: TODAS las apariciones quedan 'duplicate'. */
function markDuplicates(rows: ParsedRow[]): void {
  const by = (pick: (r: ParsedRow) => string | null, warn: string) => {
    const m = new Map<string, ParsedRow[]>();
    for (const r of rows) { const v = pick(r); if (v) (m.get(key(v)) ?? m.set(key(v), []).get(key(v))!).push(r); }
    for (const g of m.values()) if (g.length > 1) g.forEach((r) => { r.matchStatus = 'duplicate'; r.warnings.push(warn); });
  };
  by((r) => r.operatorCode, 'duplicate_operator_in_file');
  by((r) => r.nationalId, 'duplicate_national_id_in_file');
}

/** Consentimiento: decide qué se hará con el pedido del Excel según el estado ACTUAL del conductor. Un teléfono nunca consiente por sí solo. */
function consentChange(r: ParsedRow, driver: DirectoryDriver | undefined, hasDriver: boolean): RowChanges['consent'] | undefined {
  const prior = r.warnings.find((w) => w.startsWith('consent_ignored:'));
  if (prior) return { action: 'ignored', reason: prior.split(':')[1] as ConsentIgnoreReason };
  if (!r.consentRequest) return undefined;
  const current = !!driver?.whatsappConsent;
  if (!hasDriver) { r.warnings.push('consent_ignored:no_driver'); r.consentRequest = null; return { action: 'ignored', reason: 'no_driver', current: false }; }
  if (r.consentRequest === 'grant') {
    if (!(r.phoneE164 ?? driver?.phoneE164)) { r.warnings.push('consent_ignored:missing_phone'); r.consentRequest = null; return { action: 'ignored', reason: 'missing_phone', current }; }
    return { action: current ? 'unchanged' : 'grant', current, origin: r.consentOrigin ?? null };
  }
  if (current) { r.warnings.push('consent_withdrawal'); return { action: 'withdraw', current, origin: r.consentOrigin ?? null }; }
  return { action: 'unchanged', current };
}

/** Concilia por operador+cédula, completa lo vacío con lo existente (celda vacía = sin cambio) y calcula `changes`. */
function diffAgainstDirectory(rows: ParsedRow[], dir: Directory): void {
  const byOp = new Map<string, DirectoryDriver>(dir.drivers.map((d) => [key(d.operatorCode), d]));
  const byId = new Map<string, DirectoryDriver>(dir.drivers.map((d) => [key(d.nationalId), d]));
  const unitSet = new Set(dir.units.map(key));
  const asgByDriver = new Map<string, DirectoryAssignment>(dir.assignments.map((a) => [a.driverId, a]));
  const unitTaken = new Set(dir.assignments.map((a) => key(a.unitCode)));
  const claimed = new Set<string>();
  const agrChange = (r: ParsedRow, uk: string): RowChanges['agreement'] => {
    if (!r.unitAgreement) return { action: 'none' };
    const cur = dir.unitAgreements?.[uk] ?? null;
    if (r.unitAgreement === '-') return cur ? { action: 'clear', from: cur, to: null } : { action: 'same', from: null, to: null };
    return cur === null ? { action: 'set', from: null, to: r.unitAgreement } : cur === r.unitAgreement ? { action: 'same', from: cur, to: r.unitAgreement } : { action: 'change', from: cur, to: r.unitAgreement };
  };

  for (const r of rows) {
    // Fila de UNIDAD SIN CONDUCTOR: solo unidad (+ acuerdo); no se inventa ningún operario.
    if (r.unitCode && !r.operatorCode && !r.nationalId && !r.firstName && !r.lastName && !r.phoneE164 && !r.rowStatus && !r.dailyRateCents) {
      const uk = key(r.unitCode);
      r.warnings.push('unit_without_driver');
      r.matchStatus = unitSet.has(uk) ? 'matched' : 'unmatched';
      r.changes = { unit: { action: unitSet.has(uk) ? 'existing' : 'new' }, assignment: { action: 'none', currentUnit: null }, rate: { action: 'none' }, agreement: agrChange(r, uk), consent: consentChange(r, undefined, false) };
      continue;
    }
    const dOp = r.operatorCode ? byOp.get(key(r.operatorCode)) : undefined;
    const dId = r.nationalId ? byId.get(key(r.nationalId)) : undefined;
    let driver: DirectoryDriver | undefined;
    let conflict: string | null = null;
    if (dOp && dId) { if (dOp.id === dId.id) driver = dOp; else conflict = 'conflict_operator_and_national_id_belong_to_different_drivers'; }
    else if (dOp) { if (r.nationalId) conflict = 'conflict_operator_exists_with_other_national_id'; else driver = dOp; }
    else if (dId) { if (r.operatorCode) conflict = 'conflict_national_id_exists_with_other_operator'; else driver = dId; }
    if (conflict) { r.warnings.push(conflict); r.matchStatus = 'conflict'; continue; }
    if (r.matchStatus === 'duplicate') continue;

    const changes: RowChanges = {};
    if (driver) {
      r.matchStatus = 'matched'; r.matchedDriverId = driver.id;
      // celda vacía = sin cambio: se completan los datos de identidad con lo existente (así apply_directory_import los acepta)
      if (!r.operatorCode) { r.operatorCode = driver.operatorCode; r.warnings.push('filled_from_existing:operator'); }
      if (!r.nationalId) { r.nationalId = driver.nationalId; r.warnings.push('filled_from_existing:national_id'); }
      if (!r.firstName) { r.firstName = driver.firstName; r.warnings.push('filled_from_existing:first_name'); }
      const fields: Record<string, { from: string | null; to: string | null }> = {};
      if (r.firstName !== driver.firstName) fields.first_name = { from: driver.firstName, to: r.firstName };
      if (r.lastName && r.lastName !== driver.lastName) fields.last_name = { from: driver.lastName, to: r.lastName };
      if (r.phoneE164 && r.phoneE164 !== driver.phoneE164) fields.phone_e164 = { from: driver.phoneE164, to: r.phoneE164 };
      if (r.rowStatus && r.rowStatus !== driver.status) fields.status = { from: driver.status, to: r.rowStatus };
      changes.driver = Object.keys(fields).length ? { action: 'update', fields } : { action: 'unchanged' };
    } else {
      r.matchStatus = 'unmatched';
      if (!r.operatorCode) r.warnings.push('missing_operator');
      if (!r.nationalId) r.warnings.push('missing_national_id');
      if (!r.firstName) r.warnings.push('missing_first_name');
      changes.driver = { action: 'create' };
      // Con unidad pero sin datos para CREAR el conductor: la unidad se importa y el conductor queda PENDIENTE DE REVISIÓN (nada inventado, sin asignación).
      const reasons: DriverReviewReason[] = [];
      if (!r.operatorCode) reasons.push('missing_operator');
      if (!r.nationalId) reasons.push('missing_national_id');
      if (!r.firstName) reasons.push('missing_first_name');
      if (r.unitCode && reasons.length) changes.driver = { action: 'pending_review', reasons };
    }
    if (r.matchStatus === 'matched' && !r.operatorCode) r.warnings.push('missing_operator');

    // unidad / asignación / tarifa
    const cur = driver ? asgByDriver.get(driver.id) : undefined;
    if (!r.unitCode) {     // la unidad es obligatoria: un conductor existente conserva la suya (celda vacía = sin cambio)
      if (cur) { r.unitCode = cur.unitCode; r.warnings.push('filled_from_existing:unit'); } else r.warnings.push('missing_unit');
    }
    let curRate: number | undefined | null;     // undefined = sin asignación efectiva (la tarifa no se evalúa)
    if (changes.driver?.action === 'pending_review') {
      // Sin conductor no hay asignación ni tarifa (la tarifa pertenece a la asignación): solo la unidad (y su acuerdo).
      changes.unit = { action: unitSet.has(key(r.unitCode!)) ? 'existing' : 'new' };
      changes.assignment = { action: 'none', currentUnit: null };
    } else if (r.unitCode) {
      const uk = key(r.unitCode);
      changes.unit = { action: unitSet.has(uk) ? 'existing' : 'new' };
      if (cur) {
        if (key(cur.unitCode) === uk) { changes.assignment = { action: 'same', currentUnit: cur.unitCode }; curRate = cur.dailyRateCents; }
        else changes.assignment = { action: 'conflict', currentUnit: cur.unitCode, reason: 'el conductor ya tiene otra unidad' };
      } else if (unitTaken.has(uk) || claimed.has(uk)) {
        changes.assignment = { action: 'conflict', currentUnit: null, reason: 'la unidad ya está asignada a otro conductor' };
      } else { changes.assignment = { action: 'new', currentUnit: null }; claimed.add(uk); curRate = null; }
    } else {
      changes.unit = { action: 'none' };
      changes.assignment = { action: 'none', currentUnit: cur?.unitCode ?? null };
      if (cur) curRate = cur.dailyRateCents;
    }
    if (r.dailyRateCents && curRate !== undefined) {
      changes.rate = curRate === null ? { action: 'new', from: null, to: r.dailyRateCents }
        : curRate === r.dailyRateCents ? { action: 'same', from: curRate, to: r.dailyRateCents } : { action: 'differs', from: curRate, to: r.dailyRateCents };
    } else changes.rate = { action: 'none' };
    if (r.unitCode) changes.agreement = agrChange(r, key(r.unitCode));
    const consent = consentChange(r, driver, true);
    if (consent) changes.consent = consent;
    r.changes = changes;
  }
}

// ───────── generador de la plantilla ─────────
export { normalizePhone };
export const TEMPLATE_HEADERS = ['Unidad', 'Código de operario', 'Nombre', 'Apellido', 'Cédula', 'WhatsApp', 'Tarifa diaria', 'Estado', 'Acuerdo / condición especial', 'Observación', 'Consentimiento cobranza WhatsApp', 'Origen del consentimiento'] as const;
export const TEMPLATE_STATUSES = ['Activo', 'Inactivo', 'Suspendido', 'Pendiente de aprobación'] as const;

/** Plantilla .xlsx vacía: hoja 'Plantilla' (cabeceras), 'Instrucciones' (español) y 'Ejemplo' (2 filas ficticias). */
export async function buildDirectoryTemplate(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'VIP';
  const widths = [14, 22, 20, 20, 18, 18, 16, 26, 30, 40, 22, 40];
  const header = (ws: ExcelJS.Worksheet) => {
    ws.addRow([...TEMPLATE_HEADERS]);
    const row = ws.getRow(1);
    row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E79' } };
    row.alignment = { vertical: 'middle', horizontal: 'center' };
    row.height = 22;
    widths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    // texto para conservar ceros iniciales; tarifa con 2 decimales
    for (const c of [1, 2, 5, 6]) ws.getColumn(c).numFmt = '@';
    ws.getColumn(7).numFmt = '0.00';
  };

  const pl = wb.addWorksheet(TEMPLATE_SHEET);
  header(pl);
  for (let r = 2; r <= 501; r++) {
    pl.getCell(r, 8).dataValidation = { type: 'list', allowBlank: true, formulae: [`"${TEMPLATE_STATUSES.join(',')}"`] };
    pl.getCell(r, 11).dataValidation = { type: 'list', allowBlank: true, formulae: ['"SI,NO"'] };
  }

  const ins = wb.addWorksheet('Instrucciones');
  ins.getColumn(1).width = 28; ins.getColumn(2).width = 100;
  ins.addRow(['Plantilla de importación del directorio']).font = { bold: true, size: 14 };
  ins.addRow([]);
  const lines: [string, string][] = [
    ['Cómo usarla', 'Llene la hoja «Plantilla» (una fila por unidad o por conductor) y súbala en Importar. Primero verá una vista previa con las diferencias; nada se aplica hasta que usted lo confirme.'],
    ['Unidad (OBLIGATORIA)', 'Código de la unidad (placa/identificador); es único. Si no existe se crea al aplicar. Si el conductor ya tiene otra unidad asignada, el cambio NO se aplica: se informa para hacerlo con «cambiar conductor/unidad».'],
    ['Fila solo de unidad', 'Una fila con solo la Unidad (y, si quiere, su Acuerdo) crea la unidad SIN conductor. No se inventa ningún operario.'],
    ['Código de operario', 'Identifica al conductor y es independiente de la unidad. Solo se pide si la fila es de un conductor (junto con Nombre y Cédula para conductores nuevos). No se repite.'],
    ['Nombre / Apellido', 'Nombre y apellido del conductor. Nombre es obligatorio para conductores nuevos.'],
    ['Cédula', 'Obligatoria para conductores nuevos (no se repite).'],
    ['WhatsApp', 'Número del conductor. Con 8 dígitos se asume Panamá y se COMPLETA con +507 (la vista previa lo informa); también se acepta 507..., +507... y 00507..., con espacios, guiones o paréntesis. Los números inválidos se avisan y se ignoran. Tener un número NO significa que el conductor autorizó mensajes.'],
    ['Tarifa diaria', 'Importe diario en dólares (por ejemplo 36 o 34.50). Se aplica a la asignación del conductor; una tarifa distinta de la vigente solo se cambia si usted lo autoriza al aplicar.'],
    ['Estado', 'Estado del conductor. Valores válidos: ' + TEMPLATE_STATUSES.join(', ') + '. Vacío = sin cambio (para conductores nuevos se usa el estado inicial que elija al aplicar).'],
    ['Acuerdo / condición especial', 'Texto LIBRE de la UNIDAD (no del conductor), por ejemplo CHAPA, RESCATE, CUSTODIA o cualquier otro texto: se guarda tal cual lo escribe (solo se recortan los espacios de los extremos), sin lista cerrada ni cambios. Máximo 200 caracteres. Vacío = sin cambio; escriba «-» para quitar el acuerdo. Es independiente del estado operativo y NO cambia cuotas ni suspende la cobranza. Cada cambio queda en el historial.'],
    ['Observación', 'Texto libre opcional (máximo 1000 caracteres), independiente del acuerdo. Vacío = sin cambio.'],
    ['Consentimiento cobranza WhatsApp', 'OPCIONAL. Solo para recordatorios y comprobantes de COBRANZA (no promociones). SI = el conductor autorizó recibirlos; NO = retira la autorización (se detienen los envíos pendientes); vacío = sin cambio. Tener un número en «WhatsApp» NO significa que autorizó nada.'],
    ['Origen del consentimiento', 'Obligatorio para que un «SI» cuente: de dónde sale la autorización, por ejemplo «declaración de la administradora 2026-11-10» o «formulario firmado». Sin origen, o sin un teléfono válido, el «SI» se ignora y la vista previa lo avisa; el resto de la fila se importa igual. Queda registrado con el origen, el nombre del archivo y quién aplicó la importación.'],
    ['Celda vacía', 'Una celda vacía significa «sin cambio»: nunca borra datos existentes.'],
    ['Columna opcional', 'Puede agregar «Tarifa semanal» (= 6 × tarifa diaria); solo se usa para avisar si es inconsistente.'],
    ['Duplicados', 'Si un código de operario o una cédula aparece en más de una fila, todas esas filas se marcan como duplicadas y no se aplican.'],
    ['Cuentas de acceso', 'Importar NO crea cuentas de acceso ni usuarios: los conductores son solo registros del directorio.'],
    ['Pagos y saldos', 'Importar NO crea ni modifica pagos, cargos, saldos ni deudas.'],
    ['SALDO', 'Esta plantilla NO importa SALDO. El SALDO del Excel de cobranza es la DEUDA arrastrada de la semana anterior y se registra aparte, como «apertura» auditada, desde el Excel de cobranza: primero una conciliación con el saldo ya registrado y solo después de confirmarla.'],
  ];
  for (const [a, b] of lines) {
    const r = ins.addRow([a, b]);
    r.getCell(1).font = { bold: true };
    r.getCell(2).alignment = { wrapText: true, vertical: 'top' };
    r.getCell(1).alignment = { vertical: 'top' };
  }

  const ex = wb.addWorksheet('Ejemplo');
  header(ex);
  ex.addRow(['EJ-001', 'EJEMPLO-1', 'Nombre (EJEMPLO)', 'Ficticio Uno', '0-000-0001', '60000001', 36, 'Activo', 'CUSTODIA', 'Hasta el viernes', 'SI', 'EJEMPLO: formulario firmado']);
  ex.addRow(['EJ-002', 'EJEMPLO-2', 'Nombre (EJEMPLO)', 'Ficticio Dos', '0-000-0002', '60000002', 34.5, 'Pendiente de aprobación', null, null]);
  ex.addRow(['EJ-003', null, null, null, null, null, null, null, 'CHAPA', 'EJEMPLO: unidad sin conductor']);
  ex.addRow([]);
  ex.addRow(['DATOS FICTICIOS DE EJEMPLO: no copie estas filas; escriba sus datos en la hoja «Plantilla».']).font = { bold: true, color: { argb: 'FFC00000' } };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

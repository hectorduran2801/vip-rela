import type ExcelJS from 'exceljs';
import { toCents } from '@vip/shared';
import { asText, classifyHeader, cleanText, normalizeHeader, parseSaldo, readCell, summarize, type BaseSummary } from './parser.js';
import { parsePhone } from './phone.js';
import {
  DAY_KEYS, FLAT_ERROR_WARNINGS, type Buckets, type Directory, type FlatIssue, type ImportSummary, type ParsedBlock, type ParsedRow, type RowChanges,
} from './types.js';

/**
 * Cobranza PLANA (`source_kind = 'collection_flat'`): una fila = una unidad; LUNES…DOMINGO = pagos recibidos; la semana NO viene en el archivo.
 * Solo lectura: nada de aquí escribe en drivers/units/assignments/charges/payments (eso lo hace `apply_collection_sync`, tras confirmar).
 */
type FFlat = 'und' | 'operator' | 'national_id' | 'full_name' | 'phone' | 'rate' | 'agreement' | 'saldo' | 'send' | (typeof DAY_KEYS)[number] | 'weekly_diff' | 'weekly_expected';

const HEADER_SCAN_ROWS = 10;
const MAX_ISSUES = 1000;
const WEEKDAYS_ES = ['LUNES', 'MARTES', 'MIÉRCOLES', 'JUEVES', 'VIERNES', 'SÁBADO', 'DOMINGO'];

/** Cabecera de la cobranza plana → campo (tolera erratas: OERADOR, AELLIDO, MIÉRCOLES…). */
function classifyFlat(raw: string): FFlat | null {
  const h = normalizeHeader(raw);
  if (!h) return null;
  if (h === 'operario' || h === 'operarios') return 'operator';
  if (h === 'mensaje' || h === 'enviar') return 'send';          // columna MENSAJE (sí/no); «ENVIAR» se acepta como sinónimo
  if (h === 'nombre' || h === 'nombres') return 'full_name';
  return classifyHeader(raw);
}

export interface FlatHeader { row: number; cols: Map<FFlat, number>; labels: Map<FFlat, string> }

/**
 * Busca la fila de cabeceras (primeras filas): exactamente UNA 'und' + operador + CUENTA + al menos 5 días de la semana.
 * Por cabeceras, no por posición ni nombre de hoja. Las plantillas (sin días) y los bloques con varias 'und' no coinciden.
 */
export function findFlatHeader(ws: ExcelJS.Worksheet): FlatHeader | null {
  for (let r = 1; r <= Math.min(HEADER_SCAN_ROWS, ws.rowCount); r++) {
    const cols = new Map<FFlat, number>(); const labels = new Map<FFlat, string>();
    let unds = 0;
    for (let c = 1; c <= ws.columnCount; c++) {
      const text = asText(readCell(ws.getRow(r).getCell(c))) ?? '';
      const f = classifyFlat(text);
      if (!f) continue;
      if (f === 'und') unds++;
      if (!cols.has(f)) { cols.set(f, c); labels.set(f, cleanText(text).replace(/\s+/g, ' ')); }
    }
    const days = DAY_KEYS.filter((d) => cols.has(d)).length;
    if (unds === 1 && cols.has('und') && cols.has('operator') && cols.has('rate') && days >= 5) return { row: r, cols, labels };
  }
  return null;
}

const key = (s: string) => s.trim().toUpperCase();
const isNo = (v: string | null): boolean => (v ?? '').normalize('NFD').replace(/[\u0300-\u036f\s]/g, '').toLowerCase() === 'no';
const unitKey = (s: string) => s.replace(/\s+/g, '').toUpperCase();
const PLACEHOLDER = /^[-–—_.0?\s]+$/;
const NUMERIC_TEXT = /^\$?\s*-?\d+([.,]\d+)?$/;

interface Out { blocks: ParsedBlock[]; summary: BaseSummary; issues: FlatIssue[]; issuesTotal: number }

export function parseFlatSheet(ws: ExcelJS.Worksheet, hdr: FlatHeader, dir: Directory = { drivers: [], units: [], assignments: [] }): Out {
  const { cols, labels } = hdr;
  const label = (f: FFlat): string => labels.get(f) ?? (f === 'rate' ? 'CUENTA' : f.toUpperCase());
  const dayLabel = (i: number): string => labels.get(DAY_KEYS[i]!) ?? WEEKDAYS_ES[i]!;
  const issues: FlatIssue[] = [];
  let issuesTotal = 0;
  const rows: ParsedRow[] = [];
  let empty = 0;
  const addIssue = (i: FlatIssue) => { issuesTotal++; if (issues.length < MAX_ISSUES) issues.push(i); };

  for (let r = hdr.row + 1; r <= ws.rowCount; r++) {
    const cv = (f: FFlat) => (cols.has(f) ? readCell(ws.getRow(r).getCell(cols.get(f)!)) : { kind: 'empty' as const });
    const warnings: string[] = [];
    const formulas: Record<string, string> = {};
    const issue = (code: string, column: string, level: FlatIssue['level'], message: string, detail = true) => {
      warnings.push(detail ? `${code}:${column}` : code);
      addIssue({ row: r, column, code, level, message });
    };
    for (const f of cols.keys()) { const c = cv(f); if (c.formula) formulas[f] = c.formula; }

    const placeholder = (t: string | null) => (t !== null && PLACEHOLDER.test(t) ? null : t);
    const unitRaw = asText(cv('und')); const unit = unitRaw ? cleanText(unitRaw) || null : null;
    const operator = placeholder(asText(cv('operator'))); const nationalId = placeholder(asText(cv('national_id')));
    const nameRaw = asText(cv('full_name')); const fullName = nameRaw ? cleanText(nameRaw).replace(/\s+/g, ' ') || null : null;
    const phoneCv = cv('phone'); const rawPhone = placeholder(asText(phoneCv));   // «0»/«-» = sin teléfono
    const agrRaw = asText(cv('agreement')); const agreement = agrRaw ? cleanText(agrRaw) || null : null;
    const saldoCv = cv('saldo');
    const rateCv = cv('rate');
    const dayCvs = DAY_KEYS.map((d) => cv(d));
    const rateNum = rateCv.kind === 'number' ? rateCv.num! : null;

    const hasData = !!(unit || operator || nationalId || fullName || rawPhone || agreement || saldoCv.kind !== 'empty'
      || dayCvs.some((c) => c.kind !== 'empty') || (rateCv.kind !== 'empty' && rateNum !== 0));
    if (!hasData) { empty++; continue; }

    const row: ParsedRow = {
      sourceRow: r, unitCode: unit, operatorCode: operator, nationalId, fullName, dailyRateCents: null, rawAgreement: agrRaw, rawSaldo: asText(saldoCv),
      dayAmountsCents: DAY_KEYS.map(() => null), excelWeeklyDiffCents: null, excelWeeklyExpectedCents: null, originalFormulas: formulas, warnings,
      matchStatus: 'unmatched', matchedDriverId: null, changes: {},
      // MENSAJE: solo preselecciona en Cobranza; no envía nada. Solo «NO» deja sin marcar (SÍ y vacío quedan marcados). Sin la columna = null (se conserva lo guardado).
      sendFlag: cols.has('send') ? !isNo(asText(cv('send'))) : null,
    };

    // Cualquier celda con error de fórmula (#REF!...) es un error de celda con su columna.
    for (const f of cols.keys()) {
      const c = cv(f);
      if (c.kind === 'error') issue(c.error === '#REF!' ? 'formula_ref_error' : 'cell_error', label(f), 'error', `La celda tiene un error de fórmula (${c.error}).`);
      else if (c.formula && /#REF!/i.test(c.formula)) issue('formula_ref_error', label(f), 'error', 'La fórmula de la celda contiene #REF!.');
    }

    if (!unit) issue('missing_unit', label('und'), 'error', 'La fila tiene datos pero no código de unidad.');

    // Importes: vacío = null (sin dato), 0 explícito = 0. Texto numérico se acepta con aviso; texto o negativo = error de celda.
    const money = (c: ReturnType<typeof cv>, column: string, code: 'invalid_amount' | 'invalid_rate'): number | null => {
      if (c.kind === 'empty' || c.kind === 'error') return null;
      let n: number;
      if (c.kind === 'number') n = c.num!;
      else if (NUMERIC_TEXT.test(c.text!)) { n = Number(c.text!.replace(/^\$\s*/, '').replace(',', '.')); issue('text_in_numeric_cell', column, 'warning', `El importe está escrito como texto («${c.text}»): se interpretó como número.`); }
      else { issue(code, column, 'error', `El valor «${c.text}» no es un importe numérico: se ignora.`); return null; }
      if (!Number.isFinite(n) || n < 0) { issue(code, column, 'error', `El importe ${c.kind === 'number' ? c.num : c.text} es negativo o inválido: se ignora.`); return null; }
      return toCents(n);
    };
    row.dailyRateCents = money(rateCv, label('rate'), 'invalid_rate');
    row.dayAmountsCents = dayCvs.map((c, i) => money(c, dayLabel(i), 'invalid_amount'));
    if (row.dailyRateCents === 0) issue('rate_zero', label('rate'), 'info', 'La cuota (CUENTA) es 0: la unidad se importa igual, sin tarifa ni cargos.');

    // SALDO: vacío ≠ 0. Texto/negativo = aviso (la base no concilia ese SALDO).
    const sd = parseSaldo(row.rawSaldo);
    row.saldoState = saldoCv.kind === 'error' ? 'text' : sd.state; row.saldoCents = saldoCv.kind === 'error' ? null : sd.cents;
    if (saldoCv.kind !== 'error') {
      if (sd.reason === 'negative') issue('saldo_negative', label('saldo'), 'info', 'El SALDO es negativo: se interpreta como crédito a favor.');
      else if (sd.state === 'text') issue('saldo_text', label('saldo'), 'warning', `El SALDO «${row.rawSaldo}» no es un importe numérico: no se concilia.`);
    }

    // ACUERDO: texto libre (recortado, máx. 200).
    row.unitAgreement = agreement;
    if (agreement && agreement.length > 200) issue('agreement_too_long', label('agreement'), 'error', `El acuerdo tiene ${agreement.length} caracteres (máximo 200).`);

    // Nombre COMPLETO en una sola columna: no se divide (firstName/lastName quedan sin definir; el nombre vive en fullName).

    // WhatsApp (8 dígitos = +507). Inválido = aviso, nunca error. Jamás concede consentimiento.
    if (phoneCv.kind !== 'empty' && rawPhone) {
      row.rawPhone = rawPhone;
      const pr = parsePhone(phoneCv.kind === 'number' ? phoneCv.num : rawPhone);
      row.phoneE164 = pr.e164;
      if (!pr.e164) issue('invalid_phone', label('phone'), 'warning', `El WhatsApp «${rawPhone}» no es un número válido: se ignora.`);
      else if (pr.added507) issue('phone_added_507', label('phone'), 'info', 'El número tenía 8 dígitos: se agregó +507.');
    }

    // Unidad sin operario (0 / vacío): válida. Datos de conductor sin operario: aviso.
    if (unit && !operator) {
      issue('unit_without_driver', label('operator'), 'info', 'La unidad no tiene operario (0 o vacío): se importa sin conductor.', false);
      if (fullName || nationalId) issue('driver_data_without_operator', label('operator'), 'warning', 'Hay nombre o cédula pero no código de operario: no se crea conductor.');
    }

    // PAGO SEMANAL / Cuenta semanal: fórmulas, solo para conciliar (valor en caché; si no hay, se ignoran).
    const wd = cv('weekly_diff'), we = cv('weekly_expected');
    if (wd.kind === 'number') row.excelWeeklyDiffCents = toCents(wd.num!);
    if (we.kind === 'number') row.excelWeeklyExpectedCents = toCents(we.num!);
    if (row.excelWeeklyExpectedCents !== null && row.dailyRateCents && row.excelWeeklyExpectedCents !== row.dailyRateCents * 6)
      issue('weekly_account_differs', label('weekly_expected'), 'info', `La cuenta semanal del Excel (${(row.excelWeeklyExpectedCents / 100).toFixed(2)}) no es CUENTA × 6 (${(row.dailyRateCents * 6 / 100).toFixed(2)}): puede ser una condición especial.`);
    if (row.excelWeeklyDiffCents !== null && row.excelWeeklyExpectedCents !== null) {
      const sum = row.dayAmountsCents.reduce<number>((a, b) => a + (b ?? 0), 0);
      if (Math.abs(sum - row.excelWeeklyExpectedCents - row.excelWeeklyDiffCents) > 1)
        issue('weekly_diff_mismatch', label('weekly_diff'), 'warning', 'El PAGO SEMANAL del Excel no coincide con (suma de los días − cuenta semanal): el valor en caché puede estar desactualizado.');
    }
    rows.push(row);
  }

  // Unidades duplicadas: error en TODAS las apariciones, con las filas.
  const byUnit = new Map<string, ParsedRow[]>();
  for (const x of rows) if (x.unitCode) { const k = unitKey(x.unitCode); (byUnit.get(k) ?? byUnit.set(k, []).get(k)!).push(x); }
  for (const g of byUnit.values()) if (g.length > 1) for (const x of g) {
    const others = g.filter((y) => y !== x).map((y) => y.sourceRow).join(', ');
    x.warnings.push(`duplicate_unit:${label('und')}`); x.matchStatus = 'duplicate';
    addIssue({ row: x.sourceRow, column: label('und'), code: 'duplicate_unit', level: 'error', message: `La unidad ${x.unitCode} está repetida (también en la fila ${others}).` });
  }
  // Un operario con 2+ unidades es VÁLIDO (aviso informativo).
  const byOp = new Map<string, ParsedRow[]>();
  for (const x of rows) if (x.operatorCode && x.matchStatus !== 'duplicate' && x.unitCode) { const k = key(x.operatorCode); (byOp.get(k) ?? byOp.set(k, []).get(k)!).push(x); }
  for (const g of byOp.values()) if (g.length > 1) for (const x of g) {
    x.warnings.push('operator_with_several_units');
    addIssue({ row: x.sourceRow, column: label('operator'), code: 'operator_with_several_units', level: 'info', message: `El operario ${x.operatorCode} lleva ${g.length} unidades (válido).` });
  }

  diffFlat(rows, dir);
  const block: ParsedBlock = { blockIndex: 1, startColumn: ws.getColumn(cols.get('und')!).letter, headerVariant: 'plana', positionalFallbackFields: [], detectedWeekStart: null, rows };
  const base = summarize([block], empty, { present: false, units: 0, duplicates: [], onlyInHoja2: [], unitsNotInHoja2: 0 });
  issues.sort((a, b) => a.row - b.row);
  return { blocks: [block], summary: { ...base, candidatePayments: 0 }, issues, issuesTotal };
}

/** Concilia contra el directorio (solo lectura): match de unidad/operario y `changes` por fila. */
function diffFlat(rows: ParsedRow[], dir: Directory): void {
  const unitSet = new Set(dir.units.map(key));
  const driverByOp = new Map(dir.drivers.map((d) => [key(d.operatorCode), d]));
  const driverById = new Map(dir.drivers.map((d) => [d.id, d]));
  const asgByUnit = new Map(dir.assignments.map((a) => [key(a.unitCode), a]));
  for (const r of rows) {
    if (!r.unitCode) continue;
    const uk = key(r.unitCode);
    const exists = unitSet.has(uk);
    const ch: RowChanges = { unit: { action: exists ? 'existing' : 'new' } };
    if (r.matchStatus !== 'duplicate') r.matchStatus = exists ? 'matched' : 'unmatched';
    const cur = asgByUnit.get(uk);
    const curDriver = cur ? driverById.get(cur.driverId) : undefined;
    const drv = r.operatorCode ? driverByOp.get(key(r.operatorCode)) : undefined;
    if (drv) r.matchedDriverId = drv.id;
    if (r.operatorCode) {
      if (!drv) ch.driver = { action: 'create' };
      else {
        const fields: Record<string, { from: string | null; to: string | null }> = {};
        if (r.nationalId && !drv.nationalId) fields.national_id = { from: null, to: r.nationalId };
        // Nombre completo: se compara contra nombre+apellido guardados (sin mayúsculas ni espacios repetidos); vacío en el Excel nunca cambia.
        const curName = `${drv.firstName ?? ''} ${drv.lastName ?? ''}`.trim().replace(/\s+/g, ' ');
        if (r.fullName && curName.toLowerCase() !== r.fullName.toLowerCase()) fields.full_name = { from: curName || null, to: r.fullName };
        if (r.phoneE164 && !drv.phoneE164) fields.phone_e164 = { from: null, to: r.phoneE164 };
        ch.driver = Object.keys(fields).length ? { action: 'update', fields } : { action: 'unchanged' };
      }
      if (!cur) ch.assignment = { action: 'new', currentUnit: null };
      else if (drv && cur.driverId === drv.id) ch.assignment = { action: 'same', currentUnit: cur.unitCode };
      else ch.assignment = { action: 'change', currentUnit: cur.unitCode, currentOperator: curDriver?.operatorCode ?? null, reason: 'la unidad cambia de operario' };
    } else ch.assignment = { action: 'none', currentUnit: cur?.unitCode ?? null, currentOperator: curDriver?.operatorCode ?? null };
    if (r.dailyRateCents && r.dailyRateCents > 0) {
      const c = cur?.dailyRateCents;
      ch.rate = c == null ? { action: 'new', from: null, to: r.dailyRateCents } : c === r.dailyRateCents ? { action: 'same', from: c, to: c } : { action: 'differs', from: c, to: r.dailyRateCents };
    } else ch.rate = { action: 'none' };
    const curAg = dir.unitAgreements?.[uk] ?? null;
    const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toUpperCase();
    if (!r.unitAgreement || r.unitAgreement.length > 200) ch.agreement = { action: 'none' };
    else if (!curAg) ch.agreement = { action: 'set', from: null, to: r.unitAgreement };
    else ch.agreement = norm(curAg) === norm(r.unitAgreement) ? { action: 'same', from: curAg, to: r.unitAgreement } : { action: 'change', from: curAg, to: r.unitAgreement };
    r.changes = ch;
  }
}

const hasFlatError = (r: ParsedRow) => r.warnings.some((w) => (FLAT_ERROR_WARNINGS as readonly string[]).includes(w.split(':')[0]!));

/** Buckets y totales de la cobranza plana (puro, sobre las filas ya conciliadas). */
export function flatBuckets(base: BaseSummary, blocks: ParsedBlock[]): Buckets & Pick<ImportSummary, 'uniqueDrivers' | 'paymentsInFile'> {
  const rows = blocks.flatMap((b) => b.rows);
  const units = new Map<string, ParsedRow[]>();
  for (const r of rows) if (r.unitCode) { const k = key(r.unitCode); (units.get(k) ?? units.set(k, []).get(k)!).push(r); }
  const b: Buckets = {
    drivers: { new: 0, existing: 0, toUpdate: 0, unchanged: 0, total: 0, withSeveralUnits: 0 },
    units: { new: 0, existing: 0, withoutDriver: 0, withAgreement: 0, total: units.size, unchanged: 0, changed: 0 },
    assignments: { new: 0, same: 0, conflicts: 0 }, rates: { new: 0, same: 0, differs: 0 },
    errors: rows.filter(hasFlatError).length, driversPendingReview: 0, conflicts: base.matchCounts.conflict, duplicates: base.matchCounts.duplicate,
    skipped: base.emptyRowsSkipped,
  };
  const seenDrivers = new Map<string, { units: Set<string>; action?: string }>();
  for (const [k, rs] of units) {
    const r = rs[0]!; const c = r.changes ?? {};
    const isNew = c.unit?.action === 'new';
    if (isNew) b.units.new++; else b.units.existing++;
    if (!r.operatorCode) b.units.withoutDriver++;
    if (r.unitAgreement) b.units.withAgreement++;
    if (!isNew) {
      const changed = c.agreement?.action === 'set' || c.agreement?.action === 'change' || c.assignment?.action === 'new' || c.assignment?.action === 'change'
        || c.rate?.action === 'new' || c.rate?.action === 'differs';
      if (changed) b.units.changed!++; else b.units.unchanged!++;
    }
    if (c.assignment?.action === 'new') b.assignments.new++; else if (c.assignment?.action === 'same') b.assignments.same++; else if (c.assignment?.action === 'change') b.assignments.conflicts++;
    if (c.rate?.action === 'new') b.rates.new++; else if (c.rate?.action === 'same') b.rates.same++; else if (c.rate?.action === 'differs') b.rates.differs++;
    if (r.operatorCode) {
      const e = seenDrivers.get(key(r.operatorCode)) ?? { units: new Set<string>(), action: c.driver?.action };
      e.units.add(k); seenDrivers.set(key(r.operatorCode), e);
    }
  }
  for (const e of seenDrivers.values()) {
    b.drivers.total!++;
    if (e.units.size > 1) b.drivers.withSeveralUnits!++;
    if (e.action === 'create') b.drivers.new++; else { b.drivers.existing++; if (e.action === 'update') b.drivers.toUpdate++; else b.drivers.unchanged++; }
  }
  const pay = { cells: 0, nonZero: 0, explicitZero: 0, totalCents: 0, unitsWithPayments: 0 };
  for (const r of rows) {
    let any = false;
    for (const a of r.dayAmountsCents) if (a != null) { pay.cells++; any = true; if (a > 0) { pay.nonZero++; pay.totalCents += a; } else pay.explicitZero++; }
    if (any) pay.unitsWithPayments++;
  }
  return { ...b, uniqueDrivers: seenDrivers.size, paymentsInFile: pay };
}

import { createHash } from 'node:crypto';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { toCents } from '@vip/shared';
import {
  DAY_KEYS, type SaldoState, type Buckets, type Directory, type DriverRef, type ImportSummary, type MatchStatus, type ParsedBlock, type ParsedRow,
} from './types.js';
import { reconcile } from './reconcile.js';
import { parsePhone } from './phone.js';

/** Advertencias solo informativas (no cuentan como "fila con advertencias"). */
/** Situaciones VÁLIDAS (no son error ni requieren revisión): un importe mayor que la cuota puede ser recuperación de deuda anterior, el domingo se permiten abonos y una unidad puede estar sin conductor. */
export const INFO_WARNINGS = new Set(['operator_in_other_blocks', 'filled_from_existing', 'phone_added_507', 'amount_over_rate', 'sunday_amount', 'unit_without_driver', 'rate_zero', 'weekly_account_differs', 'operator_with_several_units']);

// ───────── utilidades ─────────
export const sha256Hex = (buf: Uint8Array): string => createHash('sha256').update(buf).digest('hex');

/** minúsculas, sin acentos ni espacios/\xa0/puntuación. */
export function normalizeHeader(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}
function lev(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)] as number[]);
  for (let j = 1; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length]![b.length]!;
}

type Field = 'und' | 'operator' | 'national_id' | 'full_name' | 'rate' | 'agreement' | 'saldo' | (typeof DAY_KEYS)[number] | 'weekly_diff' | 'weekly_expected' | 'phone';
const DICT: [Field, string, number][] = [
  ['und', 'und', 0], ['operator', 'operador', 2], ['national_id', 'cedula', 2], ['full_name', 'nombreyapellido', 4], ['full_name', 'nombrecompleto', 1], ['full_name', 'nombresyapellidos', 2],
  ['rate', 'cuenta', 1], ['agreement', 'acuerdo', 2], ['saldo', 'saldo', 1],
  ['monday', 'lunes', 1], ['tuesday', 'martes', 1], ['wednesday', 'miercoles', 2], ['thursday', 'jueves', 1],
  ['friday', 'viernes', 1], ['saturday', 'sabado', 1], ['sunday', 'domingo', 2],
  ['weekly_diff', 'pagosemanal', 3], ['weekly_diff', 'semcorriente', 3], ['weekly_expected', 'cuentasemanal', 3],
  // Columna OPCIONAL de WhatsApp (solo por cabecera; no hay posición de respaldo): las cabeceras cortas exigen coincidencia exacta.
  ['phone', 'whatsapp', 2], ['phone', 'wsp', 0], ['phone', 'telefono', 2], ['phone', 'tel', 0], ['phone', 'celular', 2], ['phone', 'cel', 0], ['phone', 'movil', 1],
];
/** Posición relativa de respaldo dentro del bloque (0 = 'und'). */
const POSITIONS: Field[] = ['und', 'operator', 'national_id', 'full_name', 'rate', 'agreement', 'saldo',
  ...DAY_KEYS, 'weekly_diff', 'weekly_expected'];   // WhatsApp NO está aquí: es opcional y solo se detecta por cabecera
const BLOCK_WIDTH = POSITIONS.length; // 16

/**
 * SALDO del Excel → estado y centavos. Una celda VACÍA no es un cero confirmado. Mismas reglas que public.preview_opening_balances:
 * '$' inicial permitido; «1,234» (separador de miles ambiguo), negativos y texto → 'text'.
 */
export function parseSaldo(raw: string | null | undefined): { state: SaldoState; cents: number | null; reason?: string } {
  const v = (raw ?? '').trim();
  if (v === '') return { state: 'empty', cents: null };
  const n = v.replace(/^\$\s*/, '');
  if (/^-?\d+,\d{3}$/.test(n)) return { state: 'text', cents: null, reason: 'ambiguous_thousands' };
  if (/^-?\d+([.,]\d+)?$/.test(n)) {
    const x = Number(n.replace(',', '.'));
    const cents = toCents(x);                                    // negativo = CRÉDITO a favor (importe con signo)
    return { state: cents === 0 ? 'zero' : 'amount', cents, ...(x < 0 ? { reason: 'negative' } : {}) };
  }
  return { state: 'text', cents: null, reason: 'not_numeric' };
}

export function classifyHeader(raw: string): Field | null {
  const h = normalizeHeader(raw);
  if (!h) return null;
  let best: { f: Field; d: number } | null = null;
  for (const [f, w, max] of DICT) {
    const d = lev(h, w);
    if (d <= max && (!best || d < best.d)) best = { f, d };
  }
  return best?.f ?? null;
}

interface Cv { kind: 'empty' | 'number' | 'text' | 'error'; num?: number; text?: string; formula?: string; error?: string }

export function cleanText(s: string): string { return s.replace(/[ ​]/g, ' ').trim(); }

export function readCell(cell: ExcelJS.Cell): Cv {
  let v: any = cell.value;
  let formula: string | undefined;
  if (v && typeof v === 'object' && ('formula' in v || 'sharedFormula' in v)) {
    const f = (cell as any).formula ?? v.formula;
    formula = f ? (String(f).startsWith('=') ? String(f) : `=${f}`) : '=';
    v = v.result ?? null;
  }
  if (v === null || v === undefined) return { kind: 'empty', formula };
  if (typeof v === 'object' && 'error' in v) return { kind: 'error', error: String(v.error), formula };
  if (typeof v === 'object' && 'richText' in v) v = (v.richText as { text: string }[]).map((t) => t.text).join('');
  else if (typeof v === 'object' && 'text' in v) v = String(v.text);
  else if (v instanceof Date) return { kind: 'text', text: v.toISOString(), formula };
  if (typeof v === 'number') return { kind: 'number', num: v, formula };
  if (typeof v === 'boolean') return { kind: 'text', text: String(v), formula };
  const t = cleanText(String(v));
  return t === '' ? { kind: 'empty', formula } : { kind: 'text', text: t, formula };
}
export const asText = (c: Cv): string | null => (c.kind === 'number' ? String(c.num) : c.kind === 'text' ? c.text! : null);

// ───────── bloques ─────────
interface BlockLayout { startCol: number; cols: Map<Field, number>; fallback: Field[]; variant: ParsedBlock['headerVariant'] }

function detectLayouts(ws: ExcelJS.Worksheet): BlockLayout[] {
  const header = ws.getRow(1);
  const starts: number[] = [];
  for (let c = 1; c <= ws.columnCount; c++) {
    if (normalizeHeader(asText(readCell(header.getCell(c))) ?? '') === 'und') starts.push(c);
  }
  return starts.map((s, i) => {
    const nextStart = (starts[i + 1] ?? Infinity) - 1;
    const end = Math.min(s + BLOCK_WIDTH - 1, nextStart);
    const cols = new Map<Field, number>();
    const used = new Set<number>();
    // Las cabeceras se buscan una columna más allá del ancho base (hasta el siguiente bloque): una columna WhatsApp insertada
    // desplaza «Cuenta semanal» y no debe perderse. El respaldo por posición sigue limitado al ancho base.
    for (let c = s; c <= Math.min(s + BLOCK_WIDTH, nextStart); c++) {
      const f = classifyHeader(asText(readCell(header.getCell(c))) ?? '');
      if (f && !cols.has(f)) { cols.set(f, c); used.add(c); }
    }
    const fallback: Field[] = [];
    POSITIONS.forEach((f, off) => {
      const c = s + off;
      if (!cols.has(f) && c <= end && !used.has(c)) { cols.set(f, c); used.add(c); fallback.push(f); }
    });
    const wd = normalizeHeader(asText(readCell(header.getCell(cols.get('weekly_diff') ?? 0))) ?? '');
    const variant = wd.includes('corr') ? 'sem_corriente' : wd.includes('pago') ? 'pago_semanal' : 'desconocida';
    return { startCol: s, cols, fallback, variant };
  });
}

const PLACEHOLDER = /^[-–—_.0?\s]+$/;
const TYPICAL_WEEKLY_EXPECTED = /^=?(\[@?[^\]]*\]|\$?[A-Za-z]{1,3}\$?\d+|[A-Za-z_]+)\*6$/;

function parseBlock(ws: ExcelJS.Worksheet, lay: BlockLayout, blockIndex: number): { block: ParsedBlock; empty: number } {
  const cell = (r: number, f: Field): Cv => {
    const c = lay.cols.get(f);
    return c ? readCell(ws.getRow(r).getCell(c)) : { kind: 'empty' };
  };
  const rows: ParsedRow[] = [];
  const raw: { weeklyExpected: Cv; weeklyDiff: Cv; skip: boolean }[] = [];
  let empty = 0;

  for (let r = 2; r <= ws.rowCount; r++) {
    const warnings: string[] = [];
    const formulas: Record<string, string> = {};
    const cvs = new Map<Field, Cv>();
    for (const f of lay.cols.keys()) cvs.set(f, cell(r, f));
    const g = (f: Field): Cv => cvs.get(f) ?? { kind: 'empty' };

    for (const [f, cv] of cvs) {
      if (cv.formula) {
        formulas[f] = cv.formula;
        if (/#REF!/i.test(cv.formula) || cv.error === '#REF!') warnings.push(`formula_ref_error:${f}`);
      } else if (cv.error === '#REF!') warnings.push(`formula_ref_error:${f}`);
    }

    const money = (f: Field): number | null => {
      const cv = g(f);
      if (cv.kind === 'number') return toCents(cv.num!);
      if (cv.kind === 'error') { if (cv.error !== '#REF!') warnings.push(`error_value:${f}`); return null; }
      if (cv.kind === 'text') {
        warnings.push(`text_in_numeric_cell:${f}`);
        return /^-?\d+([.,]\d+)?$/.test(cv.text!) ? toCents(cv.text!) : null;
      }
      return null;
    };

    const hasFormulaSubtotal = [...cvs.values()].some((cv) => cv.formula && /SUBTOTAL/i.test(cv.formula));
    const labelTotal = [g('und'), g('operator'), g('full_name')].some((cv) => cv.kind === 'text' && /^total/i.test(normalizeHeader(cv.text!)));
    const rateCv = g('rate');
    const dayCvs = DAY_KEYS.map((d) => g(d));
    const identity = [g('und'), g('operator'), g('national_id'), g('full_name'), g('agreement'), g('saldo')].some((cv) => cv.kind !== 'empty');
    const anyDay = dayCvs.some((cv) => cv.kind !== 'empty');
    const rateVal = rateCv.kind === 'number' ? rateCv.num! : 0;

    const isTotals = hasFormulaSubtotal || labelTotal;
    if (!isTotals && !identity && !anyDay && rateVal === 0) { empty++; raw.push({ weeklyExpected: g('weekly_expected'), weeklyDiff: g('weekly_diff'), skip: true }); continue; }

    // Marcadores de posición ('0', '-', '.') no son operador/cédula reales.
    const ident = (f: Field): string | null => {
      const t = asText(g(f));
      if (t !== null && PLACEHOLDER.test(t)) { warnings.push(`placeholder_${f}`); return null; }
      return t;
    };
    const unit = asText(g('und')), op = ident('operator'), nid = ident('national_id');
    const row: ParsedRow = {
      sourceRow: r, unitCode: unit, operatorCode: op, nationalId: nid, fullName: asText(g('full_name')),
      dailyRateCents: null, rawAgreement: asText(g('agreement')), rawSaldo: asText(g('saldo')),
      dayAmountsCents: [], excelWeeklyDiffCents: null, excelWeeklyExpectedCents: null,
      originalFormulas: formulas, warnings, matchStatus: 'unmatched', matchedDriverId: null,
    };
    if (isTotals) {
      warnings.push('totals_row');
      row.matchStatus = 'ignored';
      row.dayAmountsCents = DAY_KEYS.map(() => null);
      rows.push(row); raw.push({ weeklyExpected: g('weekly_expected'), weeklyDiff: g('weekly_diff'), skip: true });
      continue;
    }

    row.dailyRateCents = money('rate');
    row.dayAmountsCents = DAY_KEYS.map((d) => money(d));
    row.excelWeeklyExpectedCents = money('weekly_expected');
    row.excelWeeklyDiffCents = money('weekly_diff');
    if (g('saldo').kind === 'text' && !/^-?\d+([.,]\d+)?$/.test(g('saldo').text!)) warnings.push('saldo_text');
    if (g('saldo').kind === 'error') warnings.push('saldo_text');
    // SALDO = deuda arrastrada: se interpreta y se conserva el crudo, pero NO se convierte en movimiento (eso es la apertura, tras conciliar).
    const sd = parseSaldo(row.rawSaldo);
    row.saldoState = sd.state; row.saldoCents = sd.cents;
    if (g('saldo').kind === 'error') { row.saldoState = 'text'; row.saldoCents = null; }
    if (sd.reason === 'negative') warnings.push('saldo_negative');
    // WhatsApp (columna opcional): se conserva la celda original y se normaliza a E.164.
    const phoneCv = g('phone');
    if (phoneCv.kind !== 'empty') {
      row.rawPhone = asText(phoneCv);
      const pr = parsePhone(phoneCv.kind === 'number' ? phoneCv.num : row.rawPhone);
      row.phoneE164 = pr.e164;
      if (!pr.e164) warnings.push('invalid_phone'); else if (pr.added507) warnings.push('phone_added_507');
    }

    if (!row.dailyRateCents) warnings.push(rateCv.kind === 'empty' || !identity ? 'zero_rate_empty_row' : 'zero_rate');
    // La unidad es obligatoria; el operario es independiente: una unidad sin operario ni cédula es una «unidad sin conductor».
    if (!unit) warnings.push('missing_unit');
    if (!op && !nid && unit) warnings.push('unit_without_driver');
    else { if (!op) warnings.push('missing_operator'); if (!nid) warnings.push('missing_national_id'); }
    // ACUERDO = acuerdo / condición especial de la UNIDAD: texto libre, se conserva el original (solo recortado).
    row.unitAgreement = row.rawAgreement?.trim() || null;
    if (row.unitAgreement && row.unitAgreement.length > 200) warnings.push('agreement_too_long');
    const rate = row.dailyRateCents ?? 0;
    DAY_KEYS.forEach((d, i) => {
      const amt = row.dayAmountsCents[i];
      if (amt == null) return;
      if (rate > 0 && amt > rate && d !== 'sunday') warnings.push(`amount_over_rate:${d}`);
      if (d === 'sunday' && amt > 0) warnings.push('sunday_amount');
      else if (d === 'sunday' && rate > 0 && amt > rate) warnings.push('amount_over_rate:sunday');
    });
    rows.push(row);
    raw.push({ weeklyExpected: g('weekly_expected'), weeklyDiff: g('weekly_diff'), skip: false });
  }

  // Fórmulas atípicas frente a la mayoría del bloque.
  const dataIdx = rows.map((_, i) => i).filter((i) => rows[i]!.matchStatus !== 'ignored');
  const dataRaw = raw.filter((x) => !x.skip);
  const share = (pick: (x: (typeof raw)[number]) => Cv) => {
    const filled = dataRaw.map(pick).filter((c) => c.kind !== 'empty' || c.formula);
    return filled.length ? filled.filter((c) => c.formula).length / filled.length : 0;
  };
  const expShare = share((x) => x.weeklyExpected);
  const diffShare = share((x) => x.weeklyDiff);
  dataIdx.forEach((ri, k) => {
    const row = rows[ri]!; const x = dataRaw[k]!;
    const ex = x.weeklyExpected, df = x.weeklyDiff;
    if (ex.formula) { if (!TYPICAL_WEEKLY_EXPECTED.test(ex.formula.replace(/\s+/g, ''))) row.warnings.push('atypical_formula:weekly_expected'); }
    else if (ex.kind === 'number' && expShare >= 0.5) row.warnings.push('fixed_value_instead_of_formula:weekly_expected');
    if (df.formula) { if (df.formula.indexOf('=', 1) > 0) row.warnings.push('atypical_formula:weekly_diff'); }
    else if (df.kind === 'number' && diffShare >= 0.5) row.warnings.push('fixed_value_instead_of_formula:weekly_diff');
    if (row.excelWeeklyDiffCents != null && row.excelWeeklyExpectedCents != null && !row.warnings.some((w) => w.startsWith('formula_ref_error'))) {
      const sum = row.dayAmountsCents.reduce<number>((a, b) => a + (b ?? 0), 0);
      if (Math.abs(sum - row.excelWeeklyExpectedCents - row.excelWeeklyDiffCents) > 1) row.warnings.push('weekly_diff_mismatch');
    }
  });

  const hv = lay.variant;
  return {
    empty,
    block: {
      blockIndex, startColumn: ws.getColumn(lay.startCol).letter, headerVariant: hv, detectedWeekStart: null,
      positionalFallbackFields: lay.fallback, rows,
    },
  };
}

function readUnitList(wb: ExcelJS.Workbook): string[] | null {
  const ws = wb.getWorksheet('Hoja2') ?? (wb.worksheets.length > 1 ? wb.worksheets[1] : undefined);
  if (!ws) return null;
  const out: string[] = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const t = asText(readCell(ws.getRow(r).getCell(1)));
    if (t) out.push(t);
  }
  return out;
}
const unitKey = (s: string) => cleanText(s).toUpperCase();

/** Análisis global: duplicados, inconsistencias entre bloques y unidades vs Hoja2. */
function crossChecks(blocks: ParsedBlock[], hoja2: string[] | null): ImportSummary['hoja2'] {
  const live = blocks.flatMap((b) => b.rows.map((row) => ({ b, row }))).filter((x) => x.row.matchStatus !== 'ignored');
  const add = (row: ParsedRow, w: string) => { if (!row.warnings.includes(w)) row.warnings.push(w); };

  // Duplicados dentro del bloque.
  for (const b of blocks) {
    const ops = new Map<string, ParsedRow[]>(), ids = new Map<string, ParsedRow[]>();
    for (const row of b.rows) {
      if (row.matchStatus === 'ignored') continue;
      if (row.operatorCode) (ops.get(row.operatorCode) ?? ops.set(row.operatorCode, []).get(row.operatorCode)!).push(row);
      if (row.nationalId) (ids.get(row.nationalId) ?? ids.set(row.nationalId, []).get(row.nationalId)!).push(row);
    }
    for (const g of ops.values()) if (g.length > 1) g.forEach((r) => { add(r, 'duplicate_operator_in_block'); r.matchStatus = 'duplicate'; });
    for (const g of ids.values()) if (g.length > 1) g.forEach((r) => { add(r, 'duplicate_national_id_in_block'); r.matchStatus = 'duplicate'; });
  }
  // Entre bloques.
  const opBlocks = new Map<string, Set<number>>(), opIds = new Map<string, Set<string>>(), idOps = new Map<string, Set<string>>();
  for (const { b, row } of live) {
    if (row.operatorCode) {
      (opBlocks.get(row.operatorCode) ?? opBlocks.set(row.operatorCode, new Set()).get(row.operatorCode)!).add(b.blockIndex);
      if (row.nationalId) {
        (opIds.get(row.operatorCode) ?? opIds.set(row.operatorCode, new Set()).get(row.operatorCode)!).add(row.nationalId);
        (idOps.get(row.nationalId) ?? idOps.set(row.nationalId, new Set()).get(row.nationalId)!).add(row.operatorCode);
      }
    }
  }
  for (const { row } of live) {
    if (row.operatorCode && (opBlocks.get(row.operatorCode)?.size ?? 0) > 1) add(row, 'operator_in_other_blocks');
    if (row.operatorCode && (opIds.get(row.operatorCode)?.size ?? 0) > 1) add(row, 'operator_with_several_national_ids');
    if (row.nationalId && (idOps.get(row.nationalId)?.size ?? 0) > 1) add(row, 'national_id_with_several_operators');
  }

  // Unidades vs Hoja2.
  const info: ImportSummary['hoja2'] = { present: hoja2 !== null, units: 0, duplicates: [], onlyInHoja2: [], unitsNotInHoja2: 0 };
  if (hoja2) {
    const keys = hoja2.map(unitKey);
    const set = new Set(keys);
    info.units = set.size;
    const seen = new Set<string>();
    for (const k of keys) { if (seen.has(k) && !info.duplicates.includes(k)) info.duplicates.push(k); seen.add(k); }
    const inSheet1 = new Set<string>();
    const missing = new Set<string>();
    for (const { row } of live) {
      if (!row.unitCode) continue;
      const k = unitKey(row.unitCode);
      inSheet1.add(k);
      if (!set.has(k)) { add(row, 'unit_not_in_hoja2'); missing.add(k); }
    }
    info.unitsNotInHoja2 = missing.size;
    info.onlyInHoja2 = [...set].filter((k) => !inSheet1.has(k));
  }
  return info;
}

/** Resumen base (sin buckets): lo calcula el parser; los buckets/diferencias los agrega preview.ts. */
export type BaseSummary = Omit<ImportSummary, keyof Buckets | 'kind' | 'uniqueDrivers' | 'assignmentsResolvable' | 'ambiguity'>;

export function summarize(blocks: ParsedBlock[], emptyRowsSkipped: number, hoja2: ImportSummary['hoja2']): BaseSummary {
  const warningsByType: Record<string, number> = {};
  const matchCounts: Record<MatchStatus, number> = { unmatched: 0, matched: 0, conflict: 0, duplicate: 0, ignored: 0 };
  let rows = 0, rowsWithWarnings = 0, candidates = 0;
  for (const b of blocks) for (const r of b.rows) {
    rows++; matchCounts[r.matchStatus]++;
    if (r.warnings.some((w) => !INFO_WARNINGS.has(w.split(':')[0]!))) rowsWithWarnings++;
    for (const w of r.warnings) { const t = w.split(':')[0]!; warningsByType[t] = (warningsByType[t] ?? 0) + 1; }
    if (r.matchStatus !== 'ignored') candidates += r.dayAmountsCents.filter((a) => a != null && a > 0).length;
  }
  const live = blocks.flatMap((b) => b.rows).filter((r) => r.matchStatus !== 'ignored');
  const phones = { withValue: 0, valid: 0, invalid: 0, added507: 0, empty: 0, sharedByDrivers: 0 };
  const byPhone = new Map<string, Set<string>>();
  for (const r of live) {
    if (!r.rawPhone) { phones.empty++; continue; }
    phones.withValue++;
    if (r.phoneE164) {
      phones.valid++;
      if (r.warnings.includes('phone_added_507')) phones.added507++;
      if (r.operatorCode) (byPhone.get(r.phoneE164) ?? byPhone.set(r.phoneE164, new Set()).get(r.phoneE164)!).add(r.operatorCode);
    } else phones.invalid++;
  }
  phones.sharedByDrivers = [...byPhone.values()].filter((s) => s.size > 1).length;
  const isCobranza = blocks.some((b) => b.headerVariant !== 'plantilla');
  const saldo = isCobranza ? { empty: 0, zero: 0, amount: 0, text: 0, totalAmountCents: 0 } : undefined;
  if (saldo) for (const r of live) {
    const st = r.saldoState ?? parseSaldo(r.rawSaldo).state;
    saldo[st]++;
    if (st === 'amount') saldo.totalAmountCents += r.saldoCents ?? 0;
  }
  return {
    phones, ...(saldo ? { saldo } : {}),
    blocks: blocks.length, rows, emptyRowsSkipped, warningsByType, rowsWithWarnings, matchCounts, candidatePayments: candidates, hoja2,
    blockSummaries: blocks.map((b) => ({
      blockIndex: b.blockIndex, startColumn: b.startColumn, headerVariant: b.headerVariant, rows: b.rows.length,
      warnings: b.rows.reduce((n, r) => n + r.warnings.length, 0),
    })),
  };
}

/**
 * exceljs falla con algunas "tablas de Excel" (p. ej. sin autoFilter). Si ocurre, se reintenta en memoria
 * con las definiciones de tabla eliminadas (las celdas y fórmulas no cambian). El archivo original no se toca.
 */
export async function loadWorkbook(buffer: Uint8Array): Promise<ExcelJS.Workbook> {
  try {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as any);
    return wb;
  } catch (e) {
    const zip = await JSZip.loadAsync(buffer);
    for (const name of Object.keys(zip.files)) {
      if (/^xl\/tables\//.test(name)) zip.remove(name);
      else if (/^xl\/worksheets\/_rels\/.*\.rels$/.test(name))
        zip.file(name, (await zip.file(name)!.async('string')).replace(/<Relationship\b[^>]*\/relationships\/table"[^>]*\/>/g, ''));
      else if (/^xl\/worksheets\/[^/]+\.xml$/.test(name))
        zip.file(name, (await zip.file(name)!.async('string')).replace(/<tableParts\b[^>]*?(\/>|>[\s\S]*?<\/tableParts>)/g, ''));
      else if (name === '[Content_Types].xml')
        zip.file(name, (await zip.file(name)!.async('string')).replace(/<Override\b[^>]*\/xl\/tables\/[^>]*\/>/g, ''));
    }
    const wb = new ExcelJS.Workbook();
    try { await wb.xlsx.load((await zip.generateAsync({ type: 'nodebuffer' })) as any); } catch (e2) { throw new Error(`No se pudo leer el .xlsx: ${(e2 as Error).message}`); }
    return wb;
  }
}

/** Cobranza ya cargada: bloques y filas interpretadas, conciliadas con `drivers`. */
export function parseCobranzaSheet(wb: ExcelJS.Workbook, drivers: DriverRef[] = [], dir?: Directory): { blocks: ParsedBlock[]; summary: BaseSummary } {
  const ws = wb.getWorksheet('Hoja1') ?? wb.worksheets[0];
  if (!ws) throw new Error('El archivo no contiene hojas.');
  const layouts = detectLayouts(ws);
  if (layouts.length === 0) throw new Error("No se encontró ningún bloque: la fila 1 de la hoja no tiene ninguna cabecera 'und'.");
  let empty = 0;
  const blocks = layouts.map((l, i) => { const r = parseBlock(ws, l, i + 1); empty += r.empty; return r.block; });
  const hoja2 = crossChecks(blocks, readUnitList(wb));
  reconcile(blocks, drivers);
  unitOnlyAndAgreements(blocks, dir);
  return { blocks, summary: summarize(blocks, empty, hoja2) };
}

/**
 * Unidades sin conductor (con unidad pero sin operario ni cédula): 'matched' si la unidad ya existe, si no 'unmatched' (nunca 'ignored');
 * y advertencias del acuerdo entre bloques / frente a lo ya registrado.
 */
function unitOnlyAndAgreements(blocks: ParsedBlock[], dir?: Directory): void {
  const known = new Set((dir?.units ?? []).map((u) => u.trim().toUpperCase()));
  const live = blocks.flatMap((b) => b.rows).filter((r) => r.matchStatus !== 'ignored');
  for (const r of live) if (r.unitCode && !r.operatorCode && !r.nationalId && r.matchStatus === 'unmatched') {
    if (known.has(r.unitCode.trim().toUpperCase())) r.matchStatus = 'matched';
  }
  const byUnit = new Map<string, ParsedRow[]>();
  for (const r of live) if (r.unitCode && r.unitAgreement) { const k = r.unitCode.trim().toUpperCase(); (byUnit.get(k) ?? byUnit.set(k, []).get(k)!).push(r); }
  for (const [k, rows] of byUnit) {
    if (new Set(rows.map((r) => r.unitAgreement!.toUpperCase())).size > 1) rows.forEach((r) => r.warnings.push('agreement_ambiguous_across_blocks'));
    const cur = dir?.unitAgreements?.[k];
    if (cur) rows.forEach((r) => { if (r.unitAgreement!.toUpperCase() !== cur.trim().toUpperCase()) r.warnings.push('agreement_differs_from_existing'); });
  }
}

/** Lee el .xlsx de cobranza (sin modificarlo) y devuelve bloques y filas interpretadas, ya conciliadas con `drivers`. */
export async function parseWorkbook(buffer: Uint8Array, drivers: DriverRef[] = []): Promise<{ blocks: ParsedBlock[]; summary: BaseSummary }> {
  return parseCobranzaSheet(await loadWorkbook(buffer), drivers);
}

/** ¿La hoja tiene cabeceras 'und' en la fila 1 (formato cobranza)? */
export const hasCobranzaBlocks = (ws: ExcelJS.Worksheet): boolean => detectLayouts(ws).length > 0;
export const cobranzaSheet = (wb: ExcelJS.Workbook): ExcelJS.Worksheet | undefined => wb.getWorksheet('Hoja1') ?? wb.worksheets[0];

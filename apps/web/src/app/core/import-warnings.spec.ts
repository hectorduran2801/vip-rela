import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  DAY_ES, ISSUE_LABEL, KNOWN_WARNING_BASES, SEVERITY_LABEL, daysOverRate, describeWarning, groupByType, issueLabel, severityTotals, splitWarning, topSeverity,
} from './import-warnings';

const SRC = join(process.cwd(), '..', '..', 'packages', 'excel-import', 'src');
const files = readdirSync(SRC).filter((f) => f.endsWith('.ts')).map((f) => ({ f, s: readFileSync(join(SRC, f), 'utf8') }));

/** Contenido de la llamada que empieza en `open` (índice del «(»), con paréntesis balanceados. */
function call(s: string, open: number): string {
  let depth = 0;
  for (let i = open; i < s.length; i++) { if (s[i] === '(') depth++; else if (s[i] === ')' && --depth === 0) return s.slice(open + 1, i); }
  return '';
}
/** Todos los códigos de advertencia que el importador puede generar (extraídos del código fuente). */
function sourceCodes(): Set<string> {
  const out = new Set<string>();
  const addTokens = (text: string) => {
    for (const m of text.matchAll(/'([a-z][a-z0-9]*_[a-z0-9_]*(?::[a-z0-9_]+)?)'/g)) out.add(m[1]!);
    for (const m of text.matchAll(/`([a-z][a-z0-9_]*?)(?::\$\{|_\$\{|:[a-z_]+`)/g)) out.add(m[1]!.replace(/_$/, ''));
    for (const m of text.matchAll(/`([a-z][a-z0-9_]*:[a-z_]+)`/g)) out.add(m[1]!);
  };
  for (const { s } of files) {
    for (const m of s.matchAll(/(?:warnings\.push|\badd)\(/g)) addTokens(call(s, m.index! + m[0].length - 1));
    for (const m of s.matchAll(/\bby\(([^;]*)\);/g)) addTokens(m[1]!);
    for (const m of s.matchAll(/conflict = '([a-z_]+)'/g)) out.add(m[1]!);
    for (const m of s.matchAll(/(?:ERROR_WARNINGS|BLOCKING_WARNINGS|DIRECTORY_BLOCKING_WARNINGS|INFO_WARNINGS)\s*=\s*(?:new Set\()?\[([^\]]*)\]/g)) addTokens(m[1]!);
    for (const m of s.matchAll(/'(consent_ignored:[a-z_]+|consent_withdrawal)'/g)) out.add(m[1]!);
  }
  // Solo advertencias reales: descarta literales de otros contextos que contengan guion bajo (nombres de columnas, etc.).
  return new Set([...out].filter((c) => !['national_id', 'full_name', 'weekly_expected', 'weekly_diff', 'first_name', 'weekly_rate', 'op', 'id'].includes(c)));
}

describe('Catálogo de advertencias del importador', () => {
  it('encuentra el código del importador (hay códigos que revisar)', () => {
    expect(files.length).toBeGreaterThan(3);
    expect(sourceCodes().size).toBeGreaterThan(40);
  });
  it('TODO código que el importador puede generar tiene traducción (falla si aparece uno nuevo sin traducir)', () => {
    const missing = [...sourceCodes()].filter((c) => !describeWarning(c).known);
    expect(missing).toEqual([]);
  });
  it('TODA observación (issue) del servidor al aplicar tiene texto en español', () => {
    const sql = readdirSync(join(process.cwd(), '..', '..', 'supabase', 'migrations')).map((f) => readFileSync(join(process.cwd(), '..', '..', 'supabase', 'migrations', f), 'utf8')).join('\n');
    const issues = new Set([...sql.matchAll(/'issue', '([a-z_0-9]+)'/g)].map((m) => m[1]!));
    expect(issues.size).toBeGreaterThan(10);
    expect([...issues].filter((i) => !ISSUE_LABEL[i])).toEqual([]);
    expect(issueLabel('algo_nuevo')).not.toContain('algo_nuevo');
  });
  it('los mínimos pedidos', () => {
    const t = (c: string) => describeWarning(c).message;
    expect(t('sunday_amount')).toBe('Pago registrado el domingo');
    expect(t('zero_rate')).toBe('Tarifa diaria en cero');
    expect(t('unit_without_driver')).toBe('Unidad sin conductor asignado');
    expect(t('amount_over_rate')).toBe('Importe superior a la cuota diaria');
    expect(t('atypical_formula:weekly_expected')).toContain('Fórmula de Excel no habitual');
    expect(t('placeholder_operator')).toBe('Código de operario provisional o inválido');
    expect(t('placeholder_national_id')).toBe('Cédula provisional o inválida');
    expect(t('operator_with_several_national_ids')).toBe('Operario asociado a varias cédulas');
    expect(t('zero_rate_empty_row')).toBe('Fila sin conductor y con tarifa cero');
    expect(t('missing_operator')).toBe('Falta el código de operario');
  });
  it('amount_over_rate con sufijo de día: «El pago del lunes… sábado supera la cuota diaria»', () => {
    for (const [en, es] of Object.entries(DAY_ES)) if (en !== 'sunday') expect(describeWarning(`amount_over_rate:${en}`).message).toBe(`El pago del ${es} supera la cuota diaria`);
    expect(describeWarning('amount_over_rate:monday').title).toBe('Importe superior a la cuota diaria');
  });
  it('gravedad: pagos mayores que la cuota, domingo, unidad sin conductor y +507 son INFORMACIÓN; tarifa cero y provisionales, REVISIÓN', () => {
    for (const c of ['amount_over_rate:friday', 'sunday_amount', 'unit_without_driver', 'phone_added_507', 'operator_in_other_blocks', 'filled_from_existing:unit']) expect(describeWarning(c).severity, c).toBe('info');
    for (const c of ['missing_operator', 'missing_national_id', 'zero_rate', 'placeholder_operator', 'placeholder_national_id', 'operator_with_several_national_ids', 'atypical_formula:weekly_diff', 'invalid_phone', 'saldo_text', 'weekly_diff_mismatch']) expect(describeWarning(c).severity, c).toBe('review');
  });
  it('gravedad ERROR solo para los bloqueantes del importador (BLOCKING / DIRECTORY_BLOCKING / ERROR_WARNINGS) y conflictos/duplicados', () => {
    const consts = files.map((x) => x.s).join('\n');
    const list = (name: string) => [...(new RegExp(`(?<![A-Z_])${name}\\s*=\\s*\\[([^\\]]*)\\]`).exec(consts)?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
    const blocking = new Set([...list('ERROR_WARNINGS'), ...list('BLOCKING_WARNINGS'), ...list('DIRECTORY_BLOCKING_WARNINGS'), ...list('FLAT_ERROR_WARNINGS')]);
    expect(blocking.size).toBeGreaterThan(8);
    // …y ningún error fuera de esos (salvo conflictos y duplicados en el archivo, que dejan la fila sin importar)
    // missing_operator / missing_national_id: decisión del dueño → «Requiere revisión» (la unidad se importa sin conductor; no se inventan datos). missing_unit sigue siendo error.
    const reviewed = ['missing_operator', 'missing_national_id'];
    blocking.delete('invalid_rate');   // en el formato plano bloquea la fila, pero el catálogo la comparte con los bloques (donde solo pide revisión)
    for (const c of blocking) if (!reviewed.includes(c)) expect(describeWarning(c).severity, c).toBe('error');
    for (const c of reviewed) expect(describeWarning(c).severity, c).toBe('review');
    expect(describeWarning('missing_unit').severity).toBe('error');
    expect(describeWarning('missing_operator').help).toBe('Se importará la unidad sin crear conductor; el conductor queda pendiente de revisión; no se inventan códigos ni documentos.');
    const extra = KNOWN_WARNING_BASES.filter((b) => describeWarning(b).severity === 'error' && !blocking.has(b));
    expect(extra.sort()).toEqual(['conflict_national_id_exists_with_other_operator', 'conflict_operator_and_national_id_belong_to_different_drivers', 'conflict_operator_exists_with_other_national_id', 'duplicate_national_id_in_file', 'duplicate_operator_in_file']);
  });
  it('un código desconocido no se muestra crudo', () => {
    const w = describeWarning('algo_inventado_nuevo');
    expect(w.known).toBe(false);
    expect(w.message).toBe('Aviso sin traducir');
    expect(w.message).not.toContain('algo_inventado');
  });
  it('agrupa por tipo (una línea por tipo con conteo, uniendo sufijos de día) y totaliza por gravedad', () => {
    const g = groupByType({ 'amount_over_rate:monday': 3, 'amount_over_rate:friday': 2, sunday_amount: 4, zero_rate: 1, totals_row: 2, 'formula_ref_error:rate': 1 });
    expect(g.find((x) => x.base === 'amount_over_rate')).toMatchObject({ count: 5, severity: 'info', codes: ['amount_over_rate:monday', 'amount_over_rate:friday'] });
    expect(g.map((x) => x.severity)).toEqual(['error', 'error', 'review', 'info', 'info']);   // errores primero
    expect(severityTotals(g)).toEqual({ error: 3, review: 1, info: 9 });
    expect(topSeverity(['sunday_amount', 'zero_rate'])).toBe('review');
    expect(topSeverity(['sunday_amount', 'zero_rate', 'totals_row'])).toBe('error');
    expect(topSeverity([])).toBeNull();
  });
  it('días con importe superior a la tarifa, sin alterar los valores', () => {
    const amounts = [4500, 3900, 5000, 3900, 6000, 4000, 2000];
    const r = daysOverRate(amounts, 3900);
    expect(r).toEqual([{ day: 'lunes', amountCents: 4500 }, { day: 'miércoles', amountCents: 5000 }, { day: 'viernes', amountCents: 6000 }, { day: 'sábado', amountCents: 4000 }]);
    expect(amounts).toEqual([4500, 3900, 5000, 3900, 6000, 4000, 2000]);
    expect(daysOverRate(amounts, null)).toEqual([]);
  });
  it('separa base y sufijo', () => {
    expect(splitWarning('amount_over_rate:sunday')).toEqual({ base: 'amount_over_rate', suffix: 'sunday' });
    expect(splitWarning('placeholder_operator')).toEqual({ base: 'placeholder_operator', suffix: '' });
    expect(SEVERITY_LABEL.error).toContain('bloquea');
  });
});

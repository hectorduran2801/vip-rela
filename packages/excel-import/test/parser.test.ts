import { describe, expect, it } from 'vitest';
import { classifyHeader, normalizeHeader, previewImport, sha256Hex } from '../src/index.js';
import { buildFixture, buildNoBlocks, buildPositional } from './fixture.js';

const W = (r: { warnings: string[] }, w: string) => r.warnings.some((x) => x === w || x.startsWith(`${w}:`));

describe('cabeceras', () => {
  it('normaliza erratas, acentos y \\xa0', () => {
    expect(normalizeHeader('NOMBRE Y  APELLIDO')).toBe('nombreyapellido');
    expect(classifyHeader('OERADOR')).toBe('operator');
    expect(classifyHeader('DOMINDO')).toBe('sunday');
    expect(classifyHeader('MIÉRCOLES')).toBe('wednesday');
    expect(classifyHeader('SEM. CORRRIENTE')).toBe('weekly_diff');
    expect(classifyHeader('PAGO SEMANAL')).toBe('weekly_diff');
    expect(classifyHeader('Cuenta semanal')).toBe('weekly_expected');
    expect(classifyHeader('CUENTA')).toBe('rate');
    expect(classifyHeader('ZZZ')).toBeNull();
  });
});

describe('previewImport (sintético)', async () => {
  const buf = await buildFixture();
  const p = await previewImport(buf, 'sintetico.xlsx', {});
  const [b1, b2] = p.blocks;
  const find = (b: typeof b1, op: string) => b!.rows.filter((r) => r.operatorCode === op);

  it('detecta bloques, variantes, columnas y NO inventa fechas', () => {
    expect(p.blocks).toHaveLength(2);
    expect(b1!.startColumn).toBe('A'); expect(b2!.startColumn).toBe('S');
    expect(b1!.headerVariant).toBe('sem_corriente'); expect(b2!.headerVariant).toBe('pago_semanal');
    expect(b1!.positionalFallbackFields).toEqual([]);
    expect(p.blocks.every((b) => b.detectedWeekStart === null)).toBe(true);
    expect(p.fileSha256).toBe(sha256Hex(buf));
  });
  it('dinero en centavos enteros y crudos sin interpretar', () => {
    const r = find(b1, 'OP1')[0]!;
    expect(r.dailyRateCents).toBe(3450);
    expect(r.dayAmountsCents).toEqual([3450, 3450, 3450, 3450, 3450, 3450, null]);
    expect(r.excelWeeklyExpectedCents).toBe(20700);
    expect(r.rawSaldo).toBe('12'); expect(r.rawAgreement).toBe('CUSTODIA');
    expect(r.originalFormulas.weekly_expected).toBe('=E2*6');
  });
  it('marca anomalías por fila sin abortar', () => {
    const op2 = find(b1, 'OP2')[0]!;
    expect(W(op2, 'amount_over_rate:wednesday')).toBe(true);
    expect(W(op2, 'sunday_amount')).toBe(true);
    expect(W(op2, 'saldo_text')).toBe(true);
    expect(W(op2, 'atypical_formula:weekly_expected')).toBe(true);
    expect(W(find(b1, 'OP3')[0]!, 'zero_rate')).toBe(true);
    const op4 = find(b1, 'OP4')[0]!;
    expect(W(op4, 'formula_ref_error:weekly_diff')).toBe(true);
    expect(W(op4, 'text_in_numeric_cell:monday')).toBe(true);
    expect(op4.dayAmountsCents[0]).toBeNull();
    const totals = b1!.rows.find((r) => r.warnings.includes('totals_row'))!;
    expect(totals.matchStatus).toBe('ignored');
    expect(W(find(b1, 'OP5')[0]!, 'unit_not_in_hoja2')).toBe(true);
    expect(W(find(b2, 'OP6')[0]!, 'fixed_value_instead_of_formula:weekly_expected')).toBe(true);
  });
  it('duplicados dentro del bloque y entre bloques', () => {
    const dups = find(b1, 'OP1');
    expect(dups).toHaveLength(2);
    expect(dups.every((r) => W(r, 'duplicate_operator_in_block') && r.matchStatus === 'duplicate')).toBe(true);
    expect(W(find(b2, 'OP2')[0]!, 'operator_in_other_blocks')).toBe(true);
    expect(W(find(b1, 'OP1')[0]!, 'operator_with_several_national_ids')).toBe(true);
  });
  it('Hoja2: unidades de más, de menos y duplicadas', () => {
    expect(p.summary.hoja2.duplicates).toEqual(['101']);
    expect(p.summary.hoja2.onlyInHoja2).toEqual(['107']);
    expect(p.summary.hoja2.unitsNotInHoja2).toBe(1);
  });
  it('resumen coherente y filas vacías omitidas', () => {
    expect(p.summary.blocks).toBe(2);
    expect(p.summary.emptyRowsSkipped).toBeGreaterThanOrEqual(1);
    expect(p.summary.matchCounts.ignored).toBe(1);
    expect(p.summary.warningsByType.totals_row).toBe(1);
    expect(p.summary.candidatePayments).toBeGreaterThan(20);
  });
  it('concilia con conductores existentes (solo lectura)', async () => {
    const q = await previewImport(buf, 'x', { drivers: [
      { id: 'd1', operatorCode: 'OP2', nationalId: 'C-002' },       // matched
      { id: 'd2', operatorCode: 'OP4', nationalId: 'OTRA' },       // conflicto: operador con otra cédula
      { id: 'd3', operatorCode: 'OTRO', nationalId: 'C-005' },     // conflicto: cédula con otro operador
    ] });
    const f = (op: string) => q.blocks[0]!.rows.find((r) => r.operatorCode === op)!;
    expect(f('OP2')).toMatchObject({ matchStatus: 'matched', matchedDriverId: 'd2'.replace('d2', 'd1') });
    expect(f('OP4').matchStatus).toBe('conflict');
    expect(f('OP5').matchStatus).toBe('conflict');
    expect(f('OP3').matchStatus).toBe('unmatched');
    expect(q.summary.matchCounts.conflict).toBeGreaterThanOrEqual(2);
  });
  it('rechaza libros sin cabecera und y usa posición relativa si el texto no se reconoce', async () => {
    await expect(previewImport(await buildNoBlocks(), 'n.xlsx', {})).rejects.toThrow(/und/);
    const pos = await previewImport(await buildPositional(), 'p.xlsx', {});
    const r = pos.blocks[0]!.rows[0]!;
    expect(pos.blocks[0]!.positionalFallbackFields.length).toBeGreaterThan(10);
    expect(r).toMatchObject({ operatorCode: 'OPQ', nationalId: 'C-Q', dailyRateCents: 3100, excelWeeklyExpectedCents: 18600 });
    expect(r.dayAmountsCents[0]).toBe(3100);
  });
});

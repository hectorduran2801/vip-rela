import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { buildDirectoryTemplate, detectImportKind, previewImport, normalizePhone, type Directory } from '../src/index.js';
import { buildFixture } from './fixture.js';
import { buildFlat, FLAT_HEADERS, HAPPY_ROWS } from './flat-fixture.js';

const byUnit = (p: Awaited<ReturnType<typeof previewImport>>, u: string) => p.blocks[0]!.rows.find((r) => r.unitCode === u)!;
const issues = (p: Awaited<ReturnType<typeof previewImport>>, code: string) => (p.summary.issues ?? []).filter((i) => i.code === code);

describe('cobranza plana: detección del formato', () => {
  it('detecta collection_flat por cabeceras (fila 2, columna A vacía) y no se confunde con los otros formatos', async () => {
    expect(await detectImportKind(await buildFlat(HAPPY_ROWS))).toBe('collection_flat');
    expect(await detectImportKind(await buildFixture())).toBe('cobranza');                 // bloques con 'und' en la fila 1
    expect(await detectImportKind(await buildDirectoryTemplate())).toBe('directory');      // plantilla
  });
  it('tolera otro nombre de hoja, otra fila de cabeceras y variantes (OPERARIO, APELLIDO, MIÉRCOLES)', async () => {
    const headers = ['UND', 'OPERARIO', 'Cédula', 'NOMBRE Y APELLIDO', 'Whatsapp', 'Cuenta', 'Acuerdo', 'Saldo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo', 'Pago semanal', 'CUENTA  SEMANAL'];
    const buf = await buildFlat(HAPPY_ROWS, { sheet: 'Datos', headerRow: 4, firstCol: 3, headers });
    expect(await detectImportKind(buf)).toBe('collection_flat');
    const p = await previewImport(buf, 'x.xlsx');
    expect(p.summary.rows).toBe(6);
    expect(byUnit(p, 'P360').excelWeeklyExpectedCents).toBe(20400);
  });
  it('una hoja con operador/cédula pero sin días de la semana es la plantilla, no la plana', async () => {
    const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Hoja1');
    ws.addRow([]); ws.addRow(['und', 'OPERADOR', 'CEDULA', 'CUENTA']);
    expect(await detectImportKind(Buffer.from(await wb.xlsx.writeBuffer()))).toBe('directory');
  });
});

describe('cobranza plana: lectura de filas', () => {
  it('vacío vs 0 explícito en los 7 días, CUENTA y SALDO; semana no inventada', async () => {
    const p = await previewImport(await buildFlat(HAPPY_ROWS), 'plana.xlsx');
    expect(p.kind).toBe('collection_flat');
    expect(p.blocks).toHaveLength(1);
    expect(p.blocks[0]!.detectedWeekStart).toBeNull();
    expect(p.blocks[0]!.headerVariant).toBe('plana');
    const r = byUnit(p, 'P101');
    expect(r.sourceRow).toBe(3);                                  // número real de Excel
    expect(r.dayAmountsCents).toEqual([2900, 0, null, null, null, null, null]);
    expect(r.dailyRateCents).toBe(2900);
    expect(r.rawSaldo).toBe('0'); expect(r.saldoState).toBe('zero');
    expect(byUnit(p, 'P103').rawSaldo).toBe('199'); expect(byUnit(p, 'P103').saldoState).toBe('amount');
    expect(byUnit(p, 'P104').rawSaldo).toBeNull(); expect(byUnit(p, 'P104').saldoState).toBe('empty');   // vacío ≠ 0
    expect(byUnit(p, 'P102').dailyRateCents).toBe(0);
    expect(p.summary.saldo).toMatchObject({ empty: 3, zero: 1, amount: 2 });
    expect(p.summary.emptyRowsSkipped).toBe(1);
  });
  it('ACUERDO: texto libre recortado; operador/cédula 0 = ausentes (nunca error)', async () => {
    const p = await previewImport(await buildFlat(HAPPY_ROWS), 'plana.xlsx');
    expect(byUnit(p, 'P101').unitAgreement).toBe('CHAPA');
    const z = byUnit(p, 'P102');
    expect(z.operatorCode).toBeNull(); expect(z.nationalId).toBeNull();
    expect(p.summary.errors).toBe(0);
    expect(byUnit(p, 'P103').nationalId).toBeNull();               // cédula opcional
    expect(issues(p, 'missing_national_id')).toHaveLength(0);
  });
  it('cuota 0: aviso informativo, no bloquea y la unidad con conductor se importa igual', async () => {
    const p = await previewImport(await buildFlat(HAPPY_ROWS), 'plana.xlsx');
    expect(issues(p, 'rate_zero').map((i) => i.row)).toEqual([4, 5]);
    expect(p.summary.errors).toBe(0);
    expect(byUnit(p, 'P103').operatorCode).toBe('OP2');
    expect(p.summary.units.total).toBe(6);
  });
  it('un operario con 2 unidades es válido (ni error ni advertencia bloqueante)', async () => {
    const p = await previewImport(await buildFlat(HAPPY_ROWS), 'plana.xlsx');
    expect(p.summary.errors).toBe(0);
    expect(p.summary.drivers).toMatchObject({ total: 4, new: 4, withSeveralUnits: 1 });
    expect(byUnit(p, 'P103').warnings).toContain('operator_with_several_units');
    expect(byUnit(p, 'P103').matchStatus).toBe('unmatched');
    expect(p.summary.matchCounts.duplicate).toBe(0);
  });
  it('fórmulas: usa el valor en caché; sin caché se ignoran; P360 ≠ CUENTA×6 es solo informativo', async () => {
    const p = await previewImport(await buildFlat(HAPPY_ROWS), 'plana.xlsx');
    const r = byUnit(p, 'P360');
    expect(r.excelWeeklyExpectedCents).toBe(20400); expect(r.excelWeeklyDiffCents).toBe(-2900);
    expect(r.originalFormulas.weekly_expected).toMatch(/G7\*5\+29/);
    expect(issues(p, 'weekly_account_differs')).toEqual([expect.objectContaining({ row: 7, level: 'info', column: 'Cuenta semanal' })]);
    const nc = byUnit(p, 'P105');
    expect(nc.excelWeeklyExpectedCents).toBeNull(); expect(nc.excelWeeklyDiffCents).toBeNull();
    expect(p.summary.errors).toBe(0);
  });
  it('nombre COMPLETO en una sola columna: se conserva exacto y no se divide', async () => {
    const p = await previewImport(await buildFlat(HAPPY_ROWS), 'plana.xlsx');
    expect(byUnit(p, 'P101').fullName).toBe('CARLOS ANDRES PRUEBA EJEMPLO');
    for (const u of ['P101', 'P103', 'P360', 'P105']) { expect(byUnit(p, u).firstName ?? null).toBeNull(); expect(byUnit(p, u).lastName ?? null).toBeNull(); }
    expect(byUnit(p, 'P103').fullName).toBe('VICTOR MUESTRA DEMO');
    expect(byUnit(p, 'P360').fullName).toBe('ANA DE LA CRUZ');
    expect(byUnit(p, 'P105').fullName).toBe('LUIS');
  });
  it.each(['NOMBRE Y AELLIDO', 'NOMBRE Y APELLIDO', 'NOMBRE COMPLETO', 'NOMBRES Y APELLIDOS', 'Nombre  y   Apellido', 'nómbre completo', 'NOMBRE\u00a0COMPLETO'])('cabecera «%s» → nombre completo', async (h) => {
    const headers = FLAT_HEADERS.map((x) => (x === 'NOMBRE Y AELLIDO' ? h : x));
    const buf = await buildFlat(HAPPY_ROWS, { headers });
    expect(await detectImportKind(buf)).toBe('collection_flat');
    const p = await previewImport(buf, 'x.xlsx');
    expect(byUnit(p, 'P101').fullName).toBe('CARLOS ANDRES PRUEBA EJEMPLO');
    expect(p.summary.errors).toBe(0);
  });
  it('nombres de 2+ nombres y 2+ apellidos, ñ/acentos y espacios sobrantes: solo se recorta y se colapsa', async () => {
    const p = await previewImport(await buildFlat([
      { unit: 'N1', op: 'A1', name: '  CARLOS   ANDRES \u00a0 PRUEBA  EJEMPLO  ', rate: 30 },
      { unit: 'N2', op: 'A2', name: 'María José de la Cruz Peña-Núñez', rate: 30 },
      { unit: 'N3', op: 'A3', name: '   ', rate: 30 }]), 'x.xlsx');
    expect(byUnit(p, 'N1').fullName).toBe('CARLOS ANDRES PRUEBA EJEMPLO');
    expect(byUnit(p, 'N2').fullName).toBe('María José de la Cruz Peña-Núñez');
    expect(byUnit(p, 'N3').fullName).toBeNull();
  });
  it('WhatsApp: 8 dígitos → +507, con +, numérico; 0 = vacío; inválido = aviso (no error); sin consentimiento', async () => {
    const p = await previewImport(await buildFlat([...HAPPY_ROWS.slice(0, 4), { unit: 'P900', op: 'OP9', wsp: '12345', rate: 30 }, { unit: 'P901', wsp: 0, rate: 30 }, { unit: 'P902', wsp: '00573001234567', rate: 30 }]), 'p.xlsx');
    expect(byUnit(p, 'P101').phoneE164).toBe('+50760000101');
    expect(byUnit(p, 'P103').phoneE164).toBe('+50760000102');
    expect(byUnit(p, 'P104').phoneE164).toBe('+50760000101');
    expect(byUnit(p, 'P900').phoneE164).toBeNull(); expect(byUnit(p, 'P900').rawPhone).toBe('12345');
    expect(byUnit(p, 'P901').rawPhone ?? null).toBeNull();
    expect(byUnit(p, 'P902').phoneE164).toBe('+573001234567');
    expect(issues(p, 'invalid_phone')).toEqual([expect.objectContaining({ row: 7, level: 'warning', column: 'WHATSAPP' })]);
    expect(p.summary.errors).toBe(0);
    expect(normalizePhone('6000-0101')).toBe('+50760000101');
    expect(p.blocks[0]!.rows.every((r) => r.consentRequest == null && !r.changes?.consent)).toBe(true);
  });
  it('paymentsInFile cuenta celdas con dato (0 explícito aparte) y SALDO vacío no es 0', async () => {
    const p = await previewImport(await buildFlat(HAPPY_ROWS), 'plana.xlsx');
    expect(p.summary.paymentsInFile).toEqual({ cells: 2 + 6 + 5, nonZero: 1 + 6 + 5, explicitZero: 1, totalCents: 2900 + 6 * 3000 + 5 * 3500, unitsWithPayments: 3 });
  });
});

describe('cobranza plana: errores con fila y columna', () => {
  const bad = [
    { unit: 'P201', op: 'OP1', rate: 30, days: ['abc', 30, -5, null, null, null, null] as any },
    { op: 'OPX', name: 'SIN UNIDAD', rate: 30 },                                                                                        // sin unidad
    { unit: 'P202', rate: 'mucho' as any },
    { unit: 'P203', op: 'OP5', rate: 30, diff: { formula: '+#REF!+P2:P22', result: { error: '#REF!' } } as any },
    { unit: 'P204', rate: 30, agr: 'x'.repeat(201) },
    { unit: 'P205', rate: 30, saldo: 'ver nota' },
    { unit: 'p300', rate: 30 }, { unit: ' P300 ', rate: 30 },
  ];
  it('celdas inválidas, unidad faltante, #REF!, duplicados', async () => {
    const p = await previewImport(await buildFlat(bad), 'malo.xlsx');
    const at = (code: string) => issues(p, code).map((i) => [i.row, i.column]);
    expect(at('invalid_amount')).toEqual([[3, 'LUNES'], [3, 'MIERCOLES']]);
    expect(at('missing_unit')).toEqual([[4, 'und']]);
    expect(at('invalid_rate')).toEqual([[5, 'CUENTA']]);
    expect(at('formula_ref_error')).toEqual([[6, 'PAGO SEMANAL']]);
    expect(at('agreement_too_long')).toEqual([[7, 'ACUERDO']]);
    expect(at('saldo_text')).toEqual([[8, 'SALDO']]);
    expect(at('duplicate_unit').map((x) => x[0])).toEqual([9, 10]);
    expect(issues(p, 'duplicate_unit')[0]!.message).toContain('fila 10');
    expect(issues(p, 'missing_unit')[0]!.message).toMatch(/código de unidad/);
    expect(p.summary.errors).toBe(7);                      // filas 3,4,5,6,7,9,10 (el SALDO con texto es solo aviso)
    expect(p.summary.matchCounts.duplicate).toBe(2);
    expect(byUnit(p, 'P201').dayAmountsCents).toEqual([null, 3000, null, null, null, null, null]);
  });
});

describe('cobranza plana: diferencias contra el directorio (solo lectura)', () => {
  it('unidades nuevas/existentes, sin cambios/con cambios y operario que cambia', async () => {
    const dir: Directory = {
      drivers: [{ id: 'd1', operatorCode: 'OP1', nationalId: '8-100-1', firstName: 'CARLOS ANDRES', lastName: 'PRUEBA EJEMPLO', phoneE164: '+50760000101', status: 'active' },
        { id: 'd2', operatorCode: 'OP2', nationalId: 'X', firstName: 'V', lastName: 'M', phoneE164: null, status: 'active' }],
      units: ['P101', 'P103', 'P104'],
      assignments: [{ driverId: 'd1', unitCode: 'P101', dailyRateCents: 2900 }, { driverId: 'd1', unitCode: 'P103', dailyRateCents: 3000 }],
      unitAgreements: { P101: 'CHAPA' },
    };
    const p = await previewImport(await buildFlat(HAPPY_ROWS), 'plana.xlsx', { directory: dir });
    expect(p.summary.units).toMatchObject({ total: 6, new: 3, existing: 3, unchanged: 1, changed: 2, withoutDriver: 1 });
    expect(byUnit(p, 'P101').changes).toMatchObject({ unit: { action: 'existing' }, assignment: { action: 'same' }, rate: { action: 'same' }, agreement: { action: 'same' }, driver: { action: 'unchanged' } });
    expect(byUnit(p, 'P103').changes?.assignment).toMatchObject({ action: 'change', currentOperator: 'OP1' });
    expect(byUnit(p, 'P103').matchedDriverId).toBe('d2');
    expect(byUnit(p, 'P104').changes?.assignment?.action).toBe('new');
    expect(p.summary.drivers).toMatchObject({ total: 4, existing: 2, new: 2, toUpdate: 1 });   // OP2 recibe teléfono y cambia de nombre (V M → VICTOR MUESTRA DEMO)
    expect(byUnit(p, 'P103').changes?.driver).toMatchObject({ action: 'update', fields: { full_name: { from: 'V M', to: 'VICTOR MUESTRA DEMO' } } });
    expect(byUnit(p, 'P102').matchStatus).toBe('unmatched');
    expect(byUnit(p, 'P101').matchStatus).toBe('matched');
  });
});

describe('cobranza plana: el nombre completo en la vista previa de cambios', () => {
  const mk = (firstName: string, lastName: string): Directory => ({
    drivers: [{ id: 'd1', operatorCode: 'OP1', nationalId: '8-100-1', firstName, lastName, phoneE164: '+50760000101', status: 'active' }],
    units: ['P101'], assignments: [{ driverId: 'd1', unitCode: 'P101', dailyRateCents: 2900 }], unitAgreements: { P101: 'CHAPA' } });
  const drv = async (dir: Directory, name: string | null) => byUnit(await previewImport(await buildFlat([{ unit: 'P101', op: 'OP1', ced: '8-100-1', name, wsp: '6000-0101', rate: 29, agr: 'CHAPA' }]), 'x.xlsx', { directory: dir }), 'P101').changes?.driver;
  it('igual (mayúsculas/espacios aparte) o con first/last históricos separados que concatenan igual = sin cambio', async () => {
    expect(await drv(mk('CARLOS ANDRES PRUEBA EJEMPLO', ''), 'CARLOS ANDRES PRUEBA EJEMPLO')).toMatchObject({ action: 'unchanged' });
    expect(await drv(mk('Carlos  Andres', 'Prueba Ejemplo'), ' CARLOS ANDRES   PRUEBA EJEMPLO ')).toMatchObject({ action: 'unchanged' });
  });
  it('distinto = update con valor anterior y nuevo; vacío en el Excel = nunca cambia', async () => {
    expect(await drv(mk('Carlos', 'Prueba'), 'CARLOS ANDRES PRUEBA EJEMPLO')).toMatchObject({ action: 'update', fields: { full_name: { from: 'Carlos Prueba', to: 'CARLOS ANDRES PRUEBA EJEMPLO' } } });
    expect(await drv(mk('Carlos', 'Prueba'), null)).toMatchObject({ action: 'unchanged' });
  });
});

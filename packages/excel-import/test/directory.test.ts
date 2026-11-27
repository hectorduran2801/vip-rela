import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { buildDirectoryTemplate, classifyTemplateHeader, detectImportKind, normalizePhone, normalizeStatus, previewImport, type Directory } from '../src/index.js';
import { buildDirectoryFile, buildFixture, buildNoBlocks, fillTemplate } from './fixture.js';

const W = (r: { warnings: string[] }, w: string) => r.warnings.some((x) => x === w || x.startsWith(`${w}:`));

describe('plantilla: generador', () => {
  it('trae las hojas Plantilla, Instrucciones y Ejemplo, con cabeceras con formato', async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await buildDirectoryTemplate()) as any);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Plantilla', 'Instrucciones', 'Ejemplo']);
    const pl = wb.getWorksheet('Plantilla')!;
    expect((pl.getRow(1).values as string[]).slice(1)).toEqual(['Unidad', 'Código de operario', 'Nombre', 'Apellido', 'Cédula', 'WhatsApp', 'Tarifa diaria', 'Estado', 'Acuerdo / condición especial', 'Observación', 'Consentimiento cobranza WhatsApp', 'Origen del consentimiento']);
    expect(pl.getRow(1).font?.bold).toBe(true);
    expect(pl.getColumn(2).width).toBeGreaterThan(15);
    const text = wb.getWorksheet('Instrucciones')!.getSheetValues().flat().map(String).join('\n');
    for (const t of ['sin cambio', 'Pendiente de aprobación', 'NO crea cuentas de acceso', 'pagos, cargos, saldos', 'Unidad (OBLIGATORIA)', 'SIN conductor', 'Texto LIBRE', 'escriba «-» para quitar']) expect(text).toContain(t);
    const ex = wb.getWorksheet('Ejemplo')!;
    expect(String(ex.getCell('C2').value)).toContain('EJEMPLO');
    expect(String(ex.getCell('A6').value)).toContain('FICTICIOS');
  });

  it('ida y vuelta: generar → rellenar → parsear (la hoja Ejemplo se ignora)', async () => {
    const tpl = await buildDirectoryTemplate();
    expect(await detectImportKind(tpl)).toBe('directory');
    const empty = await previewImport(tpl, 'plantilla.xlsx');
    expect(empty.kind).toBe('directory'); expect(empty.summary.rows).toBe(0);
    const filled = await fillTemplate(tpl, [['U1', 'OP1', 'Ana', 'Pérez', '8-111-111', '66123456', 34.5, 'Activo'], ['U2', 'OP2', 'Luis', null, '8-222-222', null, 36, 'Pendiente de aprobación']]);
    const p = await previewImport(filled, 'f.xlsx');
    expect(p.kind).toBe('directory');
    expect(p.blocks).toHaveLength(1);
    const [a, b] = p.blocks[0]!.rows;
    expect(a).toMatchObject({ unitCode: 'U1', operatorCode: 'OP1', firstName: 'Ana', lastName: 'Pérez', nationalId: '8-111-111', phoneE164: '+50766123456', dailyRateCents: 3450, rowStatus: 'active', matchStatus: 'unmatched' });
    expect(b).toMatchObject({ lastName: null, phoneE164: null, dailyRateCents: 3600, rowStatus: 'pending_approval' });
    expect(p.summary).toMatchObject({ kind: 'directory', rows: 2, uniqueDrivers: 2, drivers: { new: 2, existing: 0 }, units: { new: 2, existing: 0 }, assignments: { new: 2 }, rates: { new: 2 }, errors: 0 });
  });
});

describe('plantilla: parser', () => {
  it('cabeceras tolerantes: acentos, mayúsculas, erratas, espacios y sinónimos', () => {
    expect(classifyTemplateHeader(' CÓDIGO  DE OPERADOR ')).toBe('operator');
    expect(classifyTemplateHeader('Codigo')).toBe('operator');
    expect(classifyTemplateHeader('Operador')).toBe('operator');
    expect(classifyTemplateHeader('CEDULA ')).toBe('national_id');
    expect(classifyTemplateHeader('Cedúla')).toBe('national_id');
    expect(classifyTemplateHeader('Whatsapp')).toBe('phone');
    expect(classifyTemplateHeader('Tarifa  Diaria')).toBe('daily_rate');
    expect(classifyTemplateHeader('tarifa semanal')).toBe('weekly_rate');
    expect(classifyTemplateHeader('ESTADO')).toBe('status');
    expect(classifyTemplateHeader('Apellidos')).toBe('last_name');
    expect(classifyTemplateHeader('Unidad')).toBe('unit');
  });

  it('lee archivos con cabeceras con erratas y orden distinto', async () => {
    const f = await buildDirectoryFile([['OPX', 'X-1', 'Ana', 'U9', 40]], ['codigo', 'CEDULA', 'nombres', 'unidad', 'tarifa']);
    const p = await previewImport(f, 'x.xlsx');
    expect(p.blocks[0]!.rows[0]).toMatchObject({ operatorCode: 'OPX', nationalId: 'X-1', firstName: 'Ana', unitCode: 'U9', dailyRateCents: 4000 });
  });

  it('detecta el tipo de archivo: plantilla vs cobranza; rechaza lo desconocido', async () => {
    expect(await detectImportKind(await buildFixture())).toBe('cobranza');
    expect(await detectImportKind(await buildDirectoryFile([['OP', 'ID', 'N']], ['Código', 'Cédula', 'Nombre'], 'Hoja1'))).toBe('directory');
    await expect(detectImportKind(await buildNoBlocks())).rejects.toThrow(/formato/);
    expect((await previewImport(await buildFixture(), 'c.xlsx')).kind).toBe('cobranza');
  });

  it('normaliza WhatsApp a E.164 y rechaza inválidos con advertencia sin abortar', async () => {
    expect(normalizePhone('6612-3456')).toBe('+50766123456');
    expect(normalizePhone('+507 6612 3456')).toBe('+50766123456');
    expect(normalizePhone('50766123456')).toBe('+50766123456');
    expect(normalizePhone('+573001234567')).toBe('+573001234567');
    expect(normalizePhone('12345')).toBeNull(); expect(normalizePhone('abc')).toBeNull();
    const f = await buildDirectoryFile([['U1', 'A1', 'Ana', null, 'C1', '123', 30, null], ['U2', 'A2', 'Bea', null, 'C2', 66123456, 30, null]]);
    const rows = (await previewImport(f, 'x.xlsx')).blocks[0]!.rows;
    expect(rows[0]!.phoneE164).toBeNull(); expect(W(rows[0]!, 'invalid_phone')).toBe(true);
    expect(rows[1]!.phoneE164).toBe('+50766123456');
  });

  it('estados en español e inglés; inválidos se avisan', async () => {
    for (const [i, o] of [['Activo', 'active'], ['inactivo', 'inactive'], ['SUSPENDIDO', 'suspended'], ['Pendiente de aprobación', 'pending_approval'], ['pending_approval', 'pending_approval'], ['suspended', 'suspended']] as const) expect(normalizeStatus(i)).toBe(o);
    expect(normalizeStatus('quizás')).toBeUndefined();
    const f = await buildDirectoryFile([['U1', 'A1', 'Ana', null, 'C1', null, 30, 'quizás']]);
    const r = (await previewImport(f, 'x.xlsx')).blocks[0]!.rows[0]!;
    expect(r.rowStatus).toBeNull(); expect(W(r, 'invalid_status')).toBe(true);
    expect((await previewImport(f, 'x.xlsx')).summary.errors).toBe(1);
  });

  it('tarifa a centavos exactos; semanal inconsistente avisa; inválida avisa', async () => {
    const f = await buildDirectoryFile([['U1', 'A1', 'Ana', 'C1', 34.5, 207], ['U2', 'A2', 'Bea', 'C2', 0.29, 2], ['U3', 'A3', 'Cy', 'C3', '36,10', null], ['U4', 'A4', 'Di', 'C4', 'gratis', null], ['U5', 'A5', 'Ed', 'C5', -3, null]],
      ['Unidad', 'Operador', 'Nombre', 'Cédula', 'Tarifa diaria', 'Tarifa semanal']);
    const rows = (await previewImport(f, 'x.xlsx')).blocks[0]!.rows;
    expect(rows.map((r) => r.dailyRateCents)).toEqual([3450, 29, 3610, null, null]);
    expect(W(rows[0]!, 'weekly_rate_inconsistent')).toBe(false);
    expect(W(rows[1]!, 'weekly_rate_inconsistent')).toBe(true);
    expect(W(rows[2]!, 'text_in_numeric_cell')).toBe(true);
    expect(W(rows[3]!, 'invalid_rate')).toBe(true); expect(W(rows[4]!, 'invalid_rate')).toBe(true);
  });

  it('ignora filas vacías y marca duplicados en TODAS sus apariciones (operador o cédula)', async () => {
    const f = await buildDirectoryFile([
      ['U1', 'A1', 'Ana', null, 'C1'], [null, null, null, null, null], ['U2', 'A1', 'Ana bis', null, 'C2'], ['U3', 'A3', 'Cy', null, 'C3'],
      ['U4', 'A4', 'Di', null, 'C3'], ['U5', 'A5', 'Ed', null, 'C5']]);
    const p = await previewImport(f, 'x.xlsx');
    expect(p.summary.emptyRowsSkipped).toBe(1);
    expect(p.blocks[0]!.rows.map((r) => r.matchStatus)).toEqual(['duplicate', 'duplicate', 'duplicate', 'duplicate', 'unmatched']);
    expect(p.summary).toMatchObject({ duplicates: 4, rows: 5, drivers: { new: 1 } });
  });

  it('diferencias frente al directorio: crear/actualizar/sin cambio, unidad, asignación y tarifa; celda vacía = sin cambio', async () => {
    const dir: Directory = {
      drivers: [
        { id: 'd1', operatorCode: 'E1', nationalId: 'ID-E1', firstName: 'Vieja', lastName: 'Nombre', phoneE164: '+50760000000', status: 'active' },
        { id: 'd2', operatorCode: 'E2', nationalId: 'ID-E2', firstName: 'Dos', lastName: 'Dos', phoneE164: null, status: 'active' },
        { id: 'd3', operatorCode: 'E3', nationalId: 'ID-E3', firstName: 'Tres', lastName: 'Tres', phoneE164: null, status: 'active' },
        { id: 'd4', operatorCode: 'E4', nationalId: 'ID-E4', firstName: 'Cuatro', lastName: 'Cuatro', phoneE164: null, status: 'active' }],
      units: ['UE1', 'UE2', 'UE3', 'LIBRE'],
      assignments: [{ driverId: 'd1', unitCode: 'UE1', dailyRateCents: 3600 }, { driverId: 'd2', unitCode: 'UE2', dailyRateCents: null }, { driverId: 'd3', unitCode: 'UE3', dailyRateCents: 3000 }],
    };
    const f = await buildDirectoryFile([
      ['UE1', 'E1', 'Renombrada', null, 'ID-E1', null, 40, 'Suspendido'],   // actualiza nombre+estado, tarifa distinta
      ['UOTRA', 'E2', null, null, 'ID-E2', null, 30, null],                 // cambio de unidad → conflicto de asignación; nombre vacío se completa
      ['ue3', 'E3', 'Tres', 'Tres', 'ID-E3', null, 30, 'Activo'],           // sin cambios (unidad en otras mayúsculas)
      ['UE1', 'N1', 'Nuevo', null, 'ID-N1', null, 25, null],                // unidad ya asignada a otro conductor
      ['LIBRE', 'N2', 'Nuevo2', null, 'ID-N2', '66000000', 25, null],       // alta con unidad existente libre
      ['UNUEVA', 'N3', 'Nuevo3', null, 'ID-N3', null, null, null],          // alta con unidad nueva
      [null, 'E3X', 'Mal', null, 'ID-E4', null, null, null]]);              // operador nuevo con cédula de otro → conflicto
    const p = await previewImport(f, 'x.xlsx', { directory: dir });
    const r = p.blocks[0]!.rows;
    expect(r[0]!.changes).toMatchObject({ driver: { action: 'update', fields: { first_name: { from: 'Vieja', to: 'Renombrada' }, status: { from: 'active', to: 'suspended' } } }, assignment: { action: 'same' }, rate: { action: 'differs', from: 3600, to: 4000 } });
    expect(Object.keys(r[0]!.changes!.driver!.fields!).sort()).toEqual(['first_name', 'status']);   // apellido y teléfono vacíos no cambian
    expect(r[1]!).toMatchObject({ firstName: 'Dos', matchStatus: 'matched', changes: { driver: { action: 'unchanged' }, assignment: { action: 'conflict', currentUnit: 'UE2' }, rate: { action: 'none' } } });
    expect(r[2]!.changes).toMatchObject({ driver: { action: 'unchanged' }, assignment: { action: 'same' }, rate: { action: 'same' } });
    expect(r[3]!.changes).toMatchObject({ driver: { action: 'create' }, assignment: { action: 'conflict' } });
    expect(r[4]!.changes).toMatchObject({ unit: { action: 'existing' }, assignment: { action: 'new' }, rate: { action: 'new', to: 2500 } });
    expect(r[5]!.changes).toMatchObject({ unit: { action: 'new' }, assignment: { action: 'new' }, rate: { action: 'none' } });
    expect(r[6]!.matchStatus).toBe('conflict');
    expect(p.summary).toMatchObject({
      kind: 'directory', rows: 7, conflicts: 1, duplicates: 0,
      drivers: { new: 3, existing: 3, toUpdate: 1, unchanged: 2 }, units: { new: 2, existing: 3 },
      assignments: { new: 2, same: 2, conflicts: 2 }, rates: { new: 1, same: 1, differs: 1 },
    });
  });
});

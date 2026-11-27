import ExcelJS from 'exceljs';

/** Libros SINTÉTICOS de cobranza plana (réplica de la forma real: fila 1 vacía, cabeceras en la fila 2 con erratas, fórmulas con resultado en caché). Ningún dato real. */
export const FLAT_HEADERS = ['und', 'OERADOR', 'CEDULA ', 'NOMBRE Y AELLIDO', 'WHATSAPP', 'CUENTA ', 'ACUERDO', 'SALDO', 'LUNES ', 'MARTES ', 'MIERCOLES  ', 'JUEVES ', 'VIERNES ', 'SABADO', 'DOMINGO ', 'PAGO SEMANAL', 'Cuenta semanal'];
type Cell = ExcelJS.CellValue;
const F = (formula: string, result: number | { error: string } | undefined): Cell => (result === undefined ? { formula } : { formula, result }) as any;

export interface FlatRow {
  unit?: Cell; op?: Cell; ced?: Cell; name?: Cell; wsp?: Cell; rate?: Cell; agr?: Cell; saldo?: Cell; days?: Cell[]; diff?: Cell; exp?: Cell;
}
/** Fila con las fórmulas reales (PAGO SEMANAL = suma − Cuenta semanal; Cuenta semanal = CUENTA×6) y su resultado en caché. */
export function flatRow(r: FlatRow, excelRow: number): Cell[] {
  const days = r.days ?? [null, null, null, null, null, null, null];
  const sum = days.reduce<number>((a, d) => a + (typeof d === 'number' ? d : 0), 0);
  const rate = typeof r.rate === 'number' ? r.rate : 0;
  return [r.unit ?? null, r.op ?? null, r.ced ?? null, r.name ?? null, r.wsp ?? null, r.rate ?? null, r.agr ?? null, r.saldo ?? null, ...days,
    'diff' in r ? r.diff! : F(`J${excelRow}+K${excelRow}+L${excelRow}+M${excelRow}+N${excelRow}+O${excelRow}+P${excelRow}-R${excelRow}`, sum - rate * 6),
    'exp' in r ? r.exp! : F(`G${excelRow}*6`, rate * 6)];
}

export interface FlatOpts { sheet?: string; headerRow?: number; headers?: string[]; firstCol?: number }
export async function buildFlat(rows: FlatRow[], opts: FlatOpts = {}): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(opts.sheet ?? 'Hoja1');
  const hr = opts.headerRow ?? 2; const c0 = opts.firstCol ?? 2;     // fila 1 vacía y columna A vacía, como el original
  (opts.headers ?? FLAT_HEADERS).forEach((h, i) => { ws.getCell(hr, c0 + i).value = h; });
  rows.forEach((r, i) => flatRow(r, hr + 1 + i).forEach((v, j) => { if (v !== null && v !== undefined) ws.getCell(hr + 1 + i, c0 + j).value = v; }));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Caso feliz: vacío vs 0, 0 como operador, 8 dígitos y +507, cuota 0 con conductor, operario con 2 unidades, P360-like, fila vacía intermedia. */
export const HAPPY_ROWS: FlatRow[] = [
  { unit: 'P101', op: 'OP1', ced: '8-100-1', name: 'CARLOS ANDRES PRUEBA EJEMPLO', wsp: '6000-0101', rate: 29, agr: '  CHAPA  ', saldo: 0, days: [29, 0, null, null, null, null, null] },
  { unit: 'P102', op: 0, ced: 0, rate: 0 },
  { unit: 'P103', op: 'OP2', name: 'VICTOR MUESTRA DEMO', wsp: '+507 6000-0102', rate: 0, saldo: 199 },
  { unit: 'P104', op: 'OP2', name: 'VICTOR MUESTRA DEMO', wsp: 60000101, rate: 30, days: [30, 30, 30, 30, 30, 30, null] },
  { unit: 'P360', op: 'OP3', ced: '3-3-3', name: 'ANA DE LA CRUZ', rate: 35, days: [35, 35, 35, 35, 35, null, null], exp: F('G7*5+29', 204), diff: F('J7+K7+L7+M7+N7+O7+P7-R7', -29) },
  {},                                       // fila totalmente vacía (solo fórmulas con resultado): se salta
  { unit: 'P105', op: 'OP4', ced: 'C-4', name: 'LUIS', rate: 31, saldo: '1.5', exp: F('G9*6', undefined), diff: F('J9-R9', undefined) },   // fórmulas sin resultado en caché
];

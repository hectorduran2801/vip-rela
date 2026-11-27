import ExcelJS from 'exceljs';

/** Libro SINTÉTICO (réplica estructural del original; ningún dato real). */
type Cell = ExcelJS.CellValue;
const F = (formula: string, result: number | { error: string }): Cell => ({ formula, result } as any);

const H_CORR = ['und', 'OERADOR', 'CEDULA', 'NOMBRE Y AELLIDO', 'CUENTA', 'ACUERDO', 'SALDO', 'LUNES', 'MARTES', 'MIERCOLES', 'JUEVES', 'VIERNES', 'SABADO', 'DOMINDO', 'SEM. CORRRIENTE', 'Cuenta semanal'];
const H_PAGO = ['und', 'OPERADOR', 'CEDULA ', 'NOMBRE Y APELLIDO', 'CUENTA', 'ACUERDO', 'SALDO', 'LUNES', 'MARTES', 'MIÉRCOLES', 'JUEVES', 'VIERNES', 'SÁBADO', 'DOMINGO', 'PAGO SEMANAL', 'Cuenta semanal'];

function put(ws: ExcelJS.Worksheet, startCol: number, header: string[], rows: Cell[][]) {
  header.forEach((h, i) => { ws.getCell(1, startCol + i).value = h; });
  rows.forEach((r, ri) => r.forEach((v, i) => { if (v !== null && v !== undefined) ws.getCell(ri + 2, startCol + i).value = v; }));
}
/** und, op, ced, nombre, cuenta, acuerdo, saldo, 7 días, diff, expected */
const row = (unit: string, op: string | null, ced: string | null, rate: number | string, days: (number | string | null)[], extra: { acuerdo?: string; saldo?: Cell; diff?: Cell; exp?: Cell } = {}, r?: number): Cell[] => {
  const sum = days.reduce<number>((a, d) => a + (typeof d === 'number' ? d : 0), 0);
  const rt = typeof rate === 'number' ? rate : 0;
  return [unit, op, ced, op ? `Persona ${op}` : null, rate, extra.acuerdo ?? null, extra.saldo ?? null, ...days,
    'diff' in extra ? extra.diff! : F(`SUM(H${r}:N${r})-P${r}`, sum - rt * 6), 'exp' in extra ? extra.exp! : F(`E${r}*6`, rt * 6)];
};

export async function buildFixture(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Hoja1');
  // Bloque 1 (columnas A..P), cabeceras con erratas.
  put(ws, 1, H_CORR, [
    row('101', 'OP1', 'C-001', 34.5, [34.5, 34.5, 34.5, 34.5, 34.5, 34.5, null], { acuerdo: 'CUSTODIA', saldo: 12 }, 2),
    row('102', 'OP2', 'C-002', 35, [35, 35, 70, 35, 35, 35, 35], { saldo: 'ver nota', exp: F('E3*5+29', 204) }, 3),
    row('103', 'OP3', 'C-003', 0, [null, null, null, null, null, null, null], {}, 4),
    row('104', 'OP4', 'C-004', 36, ['abc', 36, 36, 36, 36, 36, null], { diff: F('+#REF!+P2:P22', { error: '#REF!' }) }, 5),
    row('105', 'OP1', 'C-009', 30, [30, 30, 30, 30, 30, 30, null], {}, 6),
    ['', null, null, null, null, null, null, null, null, null, null, null, null, null, null, F('SUBTOTAL(109,Tabla4[Cuenta semanal])', 1000)],
    row('999', 'OP5', 'C-005', 40, [40, 40, 40, 40, 40, 40, null], {}, 8),
    row('', null, null, 0, [null, null, null, null, null, null, null], { diff: null, exp: null }, 9),
  ]);
  // Bloque 2 (empieza en la columna 19 = S; 2 columnas separadoras), cabeceras bien escritas con \xa0 y acentos.
  put(ws, 19, H_PAGO, [
    row('101', 'OP1', 'C-001', 34.5, [34.5, 34.5, 34.5, 34.5, 34.5, 34.5, null], {}, 2),
    row('102', 'OP2', 'C-002', 35, [35, 35, 35, 35, 35, 35, null], {}, 3),
    row('104', 'OP4', 'C-004', 36, [36, 36, 36, 36, 36, 36, null], {}, 4),
    row('106', 'OP6', 'C-006', 32, [32, 32, 32, 32, 32, 32, null], { exp: 204, diff: -12 }, 5),
  ]);
  const w2 = wb.addWorksheet('Hoja2');
  w2.getCell('A1').value = 'unidades';
  ['101', '102', '103', '104', '105', '106', '107', '101'].forEach((u, i) => { w2.getCell(i + 2, 1).value = u; });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Libro con una sola hoja sin cabecera 'und' (debe rechazarse). */
export async function buildNoBlocks(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet('Hoja1').getCell('A1').value = 'nada';
  return Buffer.from(await wb.xlsx.writeBuffer());
}
/** Cabeceras ilegibles: debe usar la posición relativa. */
export async function buildPositional(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Hoja1');
  const h = ['und', 'x1', 'x2', 'x3', 'x4', 'x5', 'x6', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'x7', 'x8'];
  put(ws, 1, h, [['201', 'OPQ', 'C-Q', 'Q', 31, null, null, 31, 31, 31, 31, 31, 31, null, 0, 186]]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Plantilla de directorio con cabeceras propias (para probar tolerancia) y filas dadas (no se reescribe el generador). */
export async function buildDirectoryFile(rows: Cell[][], headers: string[] = ['Unidad', 'Código de operador', 'Nombre', 'Apellido', 'Cédula', 'WhatsApp', 'Tarifa diaria', 'Estado'], sheet = 'Plantilla'): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheet);
  put(ws, 1, headers, rows);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Rellena la hoja 'Plantilla' de una plantilla generada con `buildDirectoryTemplate()`. */
export async function fillTemplate(template: Buffer, rows: Cell[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(template as any);
  const ws = wb.getWorksheet('Plantilla')!;
  rows.forEach((r, ri) => r.forEach((v, i) => { if (v !== null && v !== undefined) ws.getCell(ri + 2, i + 1).value = v; }));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Cobranza sintética de varios bloques: cada fila = [unidad, operador, cédula, nombre, tarifa]; un arreglo por bloque. */
export async function buildMultiBlock(blocks: (string | number | null)[][][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Hoja1');
  blocks.forEach((rows, bi) => put(ws, 1 + bi * 18, H_PAGO, rows.map(([u, op, nid, nm, rate, agr]) =>
    [u as Cell, op as Cell, nid as Cell, nm as Cell, rate as Cell, (agr ?? null) as Cell, null, null, null, null, null, null, null, null, null, null])));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

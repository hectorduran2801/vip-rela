import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { findFlatHeader, parseFlatSheet } from '../src/flat.js';

/** Columna MENSAJE: SÍ o vacío = preseleccionar; NO = sin marcar; sin columna = null. */
const sheet = (withCol: boolean) => {
  const ws = new ExcelJS.Workbook().addWorksheet('DATOS');
  ws.addRow(['UND', 'OPERARIO', 'NOMBRE', 'CUENTA', 'SALDO', 'LUNES', 'MARTES', 'MIERCOLES', 'JUEVES', 'VIERNES', 'SABADO', ...(withCol ? ['MENSAJE'] : [])]);
  for (const [i, v] of ['si', 'NO', '  S Í ', ''].entries()) ws.addRow([`P${i + 1}`, `10${i}`, 'Ana', 30, null, null, null, null, null, null, null, ...(withCol ? [v] : [])]);
  return ws;
};
const flags = (ws: ExcelJS.Worksheet) => parseFlatSheet(ws, findFlatHeader(ws)!).blocks.flatMap((b) => b.rows.map((r) => r.sendFlag));

describe('columna MENSAJE', () => {
  it('solo «NO» deja sin marcar; SÍ (con o sin tilde, espacios) y vacío quedan marcados', () => { expect(flags(sheet(true))).toEqual([true, false, true, true]); });
  it('sin la columna no marca nada', () => { expect(flags(sheet(false))).toEqual([null, null, null, null]); });
});

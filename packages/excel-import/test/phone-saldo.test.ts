import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newDb, type Db } from '@vip/db/testing';
import { buildDirectoryTemplate, normalizePhone, parsePhone, parseSaldo, previewImport, stageImport } from '../src/index.js';
import { buildFixture } from './fixture.js';

const book = async (build: (ws: ExcelJS.Worksheet) => void): Promise<Buffer> => {
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Hoja1'); build(ws);
  return Buffer.from(await wb.xlsx.writeBuffer());
};
const BASE = ['und', 'OPERADOR', 'CEDULA', 'NOMBRE Y APELLIDO', 'CUENTA', 'ACUERDO', 'SALDO', 'LUNES', 'MARTES', 'MIERCOLES', 'JUEVES', 'VIERNES', 'SABADO', 'DOMINGO', 'PAGO SEMANAL', 'Cuenta semanal'];
/** Bloque con la columna WhatsApp en `at` (índice dentro del bloque) con la cabecera dada. */
function blockBook(header: string, phones: (string | number | null)[], at = 16, saldos: (string | number | null)[] = []) {
  return book((ws) => {
    const h = [...BASE]; h.splice(at, 0, header);
    h.forEach((x, i) => { ws.getCell(1, i + 1).value = x; });
    phones.forEach((p, k) => {
      const r = k + 2; const row: (string | number | null)[] = [`U${k}`, `OP${k}`, `C-${k}`, `Persona ${k}`, 39, null, saldos[k] ?? null, 39, 39, 39, 39, 39, 39, null, 0, 234];
      row.splice(at, 0, p);
      row.forEach((v, i) => { if (v !== null && v !== undefined) ws.getCell(r, i + 1).value = v; });
    });
  });
}

describe('normalizePhone / parsePhone: una sola normalización', () => {
  const ok: [string | number, string, boolean][] = [
    ['66123456', '+50766123456', true], ['6612-3456', '+50766123456', true], ['6612 3456', '+50766123456', true], ['(507) 6612-3456', '+50766123456', false],
    ['50766123456', '+50766123456', false], ['507 6612 3456', '+50766123456', false], ['+50766123456', '+50766123456', false], ['+507 6612-3456', '+50766123456', false],
    ['00507 6612 3456', '+50766123456', false], ['00 507 66123456', '+50766123456', false], ['  6612.3456 ', '+50766123456', true],
    [66123456, '+50766123456', true], [50766123456, '+50766123456', false], ['+573001234567', '+573001234567', false], ['00573001234567', '+573001234567', false],
  ];
  it.each(ok)('%s → %s (+507 agregado: %s)', (raw, e164, added) => { expect(parsePhone(raw)).toEqual({ e164, added507: added }); expect(normalizePhone(raw)).toBe(e164); });
  it.each(['', '   ', 'abc', '6612345', '123456789', '0661234567', '12345678', '+5076612345', '5076612345', '+0123456789', '66123456x', '6612-345-67', '+50', '00', '0066123456', '507661234567'])('inválido: %j', (raw) => {
    expect(normalizePhone(raw)).toBeNull();
  });
  it('una celda numérica con decimales NO es un teléfono; null/undefined tampoco', () => {
    expect(normalizePhone(6612.3456)).toBeNull(); expect(normalizePhone(-66123456)).toBeNull(); expect(normalizePhone(null)).toBeNull(); expect(normalizePhone(undefined)).toBeNull();
  });
});

describe('parseSaldo: vacío ≠ 0 ≠ importe ≠ texto', () => {
  it.each([[null, 'empty', null], ['', 'empty', null], ['  ', 'empty', null], ['0', 'zero', 0], ['0.00', 'zero', 0], ['119', 'amount', 11900], ['$ 119.50', 'amount', 11950], ['39,5', 'amount', 3950],
    ['ver nota', 'text', null], ['-5', 'amount', -500], ['1,234', 'text', null], ['12abc', 'text', null]] as const)('%j → %s', (raw, state, cents) => {
    expect(parseSaldo(raw)).toMatchObject({ state, cents });
  });
});

describe('bloques con la columna WhatsApp', () => {
  const PH: (string | number | null)[] = ['66123456', '507 6612-3457', '+507 6612 3458', '00507 66123459', 66123460, 'sin numero', null, '12345', '+573001234567'];
  it('normaliza todas las variantes, conserva la celda original y avisa de los inválidos sin romper la fila', async () => {
    const p = await previewImport(await blockBook('WHATSAPP', PH), 'w.xlsx');
    const rows = p.blocks[0]!.rows;
    expect(rows.map((r) => r.phoneE164 ?? null)).toEqual(['+50766123456', '+50766123457', '+50766123458', '+50766123459', '+50766123460', null, null, null, '+573001234567']);
    expect(rows[0]!.rawPhone).toBe('66123456'); expect(rows[5]!.rawPhone).toBe('sin numero'); expect(rows[6]!.rawPhone ?? null).toBeNull();
    expect(rows[5]!.warnings).toContain('invalid_phone'); expect(rows[7]!.warnings).toContain('invalid_phone'); expect(rows[6]!.warnings).not.toContain('invalid_phone');
    expect(rows[0]!.warnings).toContain('phone_added_507'); expect(rows[1]!.warnings).not.toContain('phone_added_507');
    expect(rows[5]!.unitCode).toBe('U5'); expect(rows[5]!.operatorCode).toBe('OP5'); expect(rows[5]!.dailyRateCents).toBe(3900);   // la fila no se rompe
    expect(p.summary.phones).toEqual({ withValue: 8, valid: 6, invalid: 2, added507: 2, empty: 1, sharedByDrivers: 0 });
    expect(p.summary.rowsWithWarnings).toBe(2);   // phone_added_507 es informativa
  });
  it.each([['WhatsApp', 16], ['wsp', 16], ['Whats App', 16], ['Teléfono', 16], ['TEL', 16], ['Celular', 16], ['cel', 16], ['Móvil', 16], ['WHATSAPP', 4], ['WHATSAPP', 7]])('cabecera %s en la posición %i del bloque', async (h, at) => {
    const p = await previewImport(await blockBook(h, ['66123456', '66123457'], at), 'w.xlsx');
    expect(p.blocks).toHaveLength(1);
    expect(p.blocks[0]!.rows.map((r) => r.phoneE164)).toEqual(['+50766123456', '+50766123457']);
    // el resto de campos se sigue leyendo bien aunque la columna desplace a las demás
    expect(p.blocks[0]!.rows[0]).toMatchObject({ unitCode: 'U0', operatorCode: 'OP0', dailyRateCents: 3900, excelWeeklyExpectedCents: 23400 });
    expect(p.blocks[0]!.positionalFallbackFields).toEqual([]);
  });
  it('un número compartido por dos operarios se cuenta en el resumen', async () => {
    const p = await previewImport(await blockBook('WHATSAPP', ['66123456', '66123456', '66123457']), 'w.xlsx');
    expect(p.summary.phones).toMatchObject({ valid: 3, sharedByDrivers: 1 });
  });
  it('sin la columna no cambia nada: ningún teléfono, mismos bloques y filas que antes', async () => {
    const p = await previewImport(await buildFixture(), 'f.xlsx');
    expect(p.summary).toMatchObject({ blocks: 2, phones: { withValue: 0, valid: 0, invalid: 0, added507: 0, empty: p.summary.rows - p.summary.matchCounts.ignored } });
    expect(p.blocks.flatMap((b) => b.rows).every((r) => r.phoneE164 === undefined && r.rawPhone === undefined)).toBe(true);
    expect(p.blocks.flatMap((b) => b.rows).flatMap((r) => r.warnings).some((w) => /phone/.test(w))).toBe(false);
  });
});

describe('SALDO: estados, crudo conservado y contadores (no es un movimiento)', () => {
  it('clasifica cada fila y suma solo los importes', async () => {
    const saldos: (string | number | null)[] = [null, 0, 119, '$ 50', 'ver nota', -5, '1,234', '0'];
    const p = await previewImport(await blockBook('WHATSAPP', saldos.map(() => null), 16, saldos), 's.xlsx');
    const rows = p.blocks[0]!.rows;
    expect(rows.map((r) => r.saldoState)).toEqual(['empty', 'zero', 'amount', 'amount', 'text', 'amount', 'text', 'zero']);          // -5 = crédito a favor (importe con signo)
    expect(rows.map((r) => r.saldoCents)).toEqual([null, 0, 11900, 5000, null, -500, null, 0]);
    expect(rows.map((r) => r.rawSaldo)).toEqual([null, '0', '119', '$ 50', 'ver nota', '-5', '1,234', '0']);
    expect(rows[4]!.warnings).toContain('saldo_text'); expect(rows[5]!.warnings).toContain('saldo_negative');
    expect(p.summary.saldo).toEqual({ empty: 1, zero: 2, amount: 3, text: 2, totalAmountCents: 16400 });
  });
  it('la plantilla del directorio no reporta SALDO', async () => {
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load((await buildDirectoryTemplate()) as any);
    const ws = wb.getWorksheet('Plantilla')!; ws.getRow(2).values = ['U1', 'OP1', 'Ana', 'Pérez', '8-1-1', '6612 3456', 36, 'Activo'];
    const p = await previewImport(Buffer.from(await wb.xlsx.writeBuffer()), 'd.xlsx');
    expect(p.kind).toBe('directory'); expect(p.summary.saldo).toBeUndefined();
    expect(p.summary.phones).toMatchObject({ valid: 1, added507: 1 });
  });
});

describe('plantilla del directorio: misma normalización en todas las variantes', () => {
  it('cada variante de teléfono produce el mismo E.164 y los inválidos avisan', async () => {
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load((await buildDirectoryTemplate()) as any);
    const ws = wb.getWorksheet('Plantilla')!;
    const phones: (string | number)[] = ['66123456', '6612-3456', '507 6612 3456', '+507 6612 3456', '00507 6612 3456', '(507) 6612-3456', 66123456, 'abc', '12345'];
    phones.forEach((ph, i) => { ws.getRow(i + 2).values = [`U${i}`, `OP${i}`, 'N', 'A', `ID${i}`, ph, 36]; });
    const p = await previewImport(Buffer.from(await wb.xlsx.writeBuffer()), 'd.xlsx');
    const rows = p.blocks[0]!.rows;
    expect(rows.slice(0, 7).every((r) => r.phoneE164 === '+50766123456')).toBe(true);
    expect(rows[7]!.warnings).toContain('invalid_phone'); expect(rows[8]!.warnings).toContain('invalid_phone');
    expect(p.summary.phones).toMatchObject({ withValue: 9, valid: 7, invalid: 2 });
  });
  it('las instrucciones aclaran el +507 y que SALDO no se importa desde la plantilla', async () => {
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load((await buildDirectoryTemplate()) as any);
    const text = wb.getWorksheet('Instrucciones')!.getSheetValues().flat().filter((v) => typeof v === 'string').join('\n');
    expect(text).toMatch(/COMPLETA con \+507/); expect(text).toMatch(/NO importa SALDO/);
  });
});

describe('staging: teléfonos y SALDO llegan crudos a import_rows', () => {
  let db: Db;
  beforeAll(async () => { db = await newDb(); });
  afterAll(async () => { await db.close(); });
  it('guarda raw_phone, phone_e164 y raw_saldo (sin tocar finanzas)', async () => {
    const buf = await blockBook('WHATSAPP', ['6612-3456', 'xx', null], 16, [119, null, 0]);
    await db.as(db.admin, (q) => stageImport(q, { userId: db.admin }, buf, 'w.xlsx'));
    const rows = (await db.su.query(`select raw_phone, phone_e164, raw_saldo from public.import_rows order by source_row`)).rows;
    expect(rows).toEqual([{ raw_phone: '6612-3456', phone_e164: '+50766123456', raw_saldo: '119' }, { raw_phone: 'xx', phone_e164: null, raw_saldo: null }, { raw_phone: null, phone_e164: null, raw_saldo: '0' }]);
    expect((await db.su.query(`select count(*)::int n from public.charges`)).rows[0].n).toBe(0);
  });
});

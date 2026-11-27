import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { exportCredits, exportDirectory, exportMovements, exportPaymentsByMethod, exportPendingDebts, exportWeeklyTable, exportDayCollection, type WeeklyRow } from '../src/index.js';

const load = async (buf: Buffer) => { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf as unknown as ArrayBuffer); return wb; };
const row = (o: Partial<WeeklyRow> = {}): WeeklyRow => ({
  unit_code: 'P1', operator_code: '1', national_id: 'X-1', full_name: 'Nombre Prueba', driver_status: 'active', daily_rate_cents: '3450',
  week_charged_cents: '20700', day_net_cents: ['3600', '0', '0', '0', '0', '0', '1000'], gross_cents: '4700', commission_cents: '100',
  net_cents: '4600', week_diff_cents: '-16100', pending_cents: '16100', credit_cents: '0', week_closed: false, ...o });

describe('exportación semanal', () => {
  it('conserva la estructura familiar y separa bruto, comisión y neto', async () => {
    const wb = await load(await exportWeeklyTable([row()], { weekStart: '2026-03-02', organizationName: 'Demo' }));
    const ws = wb.getWorksheet('Semana')!;
    const header = (ws.getRow(3).values as string[]).slice(1);
    expect(header).toEqual(expect.arrayContaining(['Unidad', 'Operador', 'Cuenta diaria', 'Cuenta semanal', 'Total entregado (bruto)', 'Comisión Yappy/Punto Pago', 'Pago neto recibido', 'Pendiente', 'Crédito a favor']));
    expect(header.filter((h) => /^(Lunes|Martes|Miércoles|Jueves|Viernes|Sábado|Domingo)/.test(h))).toHaveLength(7);
    expect(header.find((h) => h.startsWith('Lunes'))).toContain('02/03');
    expect(header.find((h) => h.startsWith('Domingo'))).toContain('08/03');
    const r = ws.getRow(4);
    const by = (name: string) => r.getCell(header.indexOf(name) + 1).value;
    expect(by('Cuenta diaria')).toBe(34.5);
    expect(by('Cuenta semanal')).toBe(207);
    expect(by('Total entregado (bruto)')).toBe(47);
    expect(by('Comisión Yappy/Punto Pago')).toBe(1);
    expect(by('Pago neto recibido')).toBe(46);
    expect(by('Diferencia (neto − cuenta semanal)')).toBe(-161);
    expect(by(header.find((h) => h.startsWith('Domingo'))!)).toBe(10);
  });
  it('escribe solo valores: ninguna fórmula (no se reproducen las fórmulas dañadas del original)', async () => {
    const wb = await load(await exportWeeklyTable([row(), row({ unit_code: 'P2', operator_code: '2' })], { weekStart: '2026-03-02' }));
    let formulas = 0;
    wb.eachSheet((ws) => ws.eachRow((r) => r.eachCell((c) => { if (c.type === ExcelJS.ValueType.Formula) formulas++; if (typeof c.value === 'string' && /#REF/.test(c.value)) formulas++; })));
    expect(formulas).toBe(0);
  });
  it('un crédito se muestra como crédito y no como deuda negativa', async () => {
    const wb = await load(await exportWeeklyTable([row({ pending_cents: '0', credit_cents: '400', week_diff_cents: '400' })], { weekStart: '2026-03-02' }));
    const ws = wb.getWorksheet('Semana')!; const header = (ws.getRow(3).values as string[]).slice(1);
    expect(ws.getRow(4).getCell(header.indexOf('Pendiente') + 1).value).toBe(0);
    expect(ws.getRow(4).getCell(header.indexOf('Crédito a favor') + 1).value).toBe(4);
  });
  it('no pierde exactitud con centavos', async () => {
    const wb = await load(await exportWeeklyTable([row({ daily_rate_cents: 1950, net_cents: 7 })], { weekStart: '2026-03-02' }));
    const ws = wb.getWorksheet('Semana')!; const header = (ws.getRow(3).values as string[]).slice(1);
    expect(ws.getRow(4).getCell(header.indexOf('Cuenta diaria') + 1).value).toBe(19.5);
    expect(ws.getRow(4).getCell(header.indexOf('Pago neto recibido') + 1).value).toBe(0.07);
  });
});

describe('otras exportaciones', () => {
  it('pagos por método con totales (bruto, comisión, neto)', async () => {
    const ws = (await load(await exportPaymentsByMethod([
      { method_label: 'Efectivo', payments: 2, gross_cents: 5000, commission_cents: 0, net_cents: 5000 },
      { method_label: 'Yappy', payments: 1, gross_cents: 3700, commission_cents: 100, net_cents: 3600 }], { from: '2026-03-02', to: '2026-03-08' }))).getWorksheet('Por método')!;
    const total = ws.getRow(ws.rowCount);
    expect([total.getCell(1).value, total.getCell(2).value, total.getCell(3).value, total.getCell(4).value, total.getCell(5).value]).toEqual(['TOTAL', 3, 87, 1, 86]);
  });
  it('deudas y créditos filtran solo a quien corresponde', async () => {
    const base = { unit_code: 'U', operator_code: '1', national_id: 'N', full_name: 'A', driver_status: 'active', phone: null };
    const rows = [{ ...base, pending_cents: 500, credit_cents: 0 }, { ...base, operator_code: '2', pending_cents: 0, credit_cents: 400 }, { ...base, operator_code: '3', pending_cents: 0, credit_cents: 0 }];
    expect((await load(await exportPendingDebts(rows, { asOf: '2026-03-08' }))).getWorksheet('Deudas')!.rowCount).toBe(3);      // título + cabecera + 1
    expect((await load(await exportCredits(rows, { asOf: '2026-03-08' }))).getWorksheet('Créditos')!.rowCount).toBe(3);
  });
  it('directorio, movimientos y cobranza del día generan hojas válidas', async () => {
    expect((await load(await exportDirectory([{ operator_code: '1', national_id: 'N', full_name: 'A', status: 'active', phone: null, whatsapp: '+50760000000', license_number: null, license_expires_on: null, unit_code: 'P1', plate: 'AB123', daily_rate_cents: 3600 }]))).worksheets).toHaveLength(1);
    const mv = (await load(await exportMovements([{ occurred_at: '2026-03-02 10:00', kind: 'payment_void', detail: 'duplicado', amount_cents: -3600, commission_cents: null, actor: 'x' }], { title: 'Movimientos' }))).getWorksheet('Movimientos')!;
    expect(mv.getRow(3).getCell(2).value).toBe('Anulación de pago');
    expect(mv.getRow(3).getCell(4).value).toBe(-36);
    expect((await load(await exportDayCollection([], { date: '2026-03-02' }))).getWorksheet('Día')).toBeTruthy();
  });
});

import { exportAssignments, exportDrivers, exportUnits } from '../src/index.js';
describe('conductores, unidades y asignaciones', () => {
  it('exporta conductores con las columnas de la plantilla de importación y estados en español', async () => {
    const ws = (await load(await exportDrivers([{ operator_code: '15374', national_id: '8-1-1', first_name: 'Ana', last_name: 'Gómez', status: 'pending_approval', phone: null, phone_e164: '+50760001111', whatsapp_consent: true, reminders_paused: false, license_number: null, license_expires_on: null, notes: null, unit_code: 'P811', created_at: '2026-03-02' }]))).getWorksheet('Conductores')!;
    const h = (ws.getRow(2).values as string[]).slice(1);
    for (const c of ['Unidad', 'Código de operador', 'Nombre', 'Apellido', 'Cédula', 'WhatsApp', 'Estado']) expect(h).toContain(c);
    expect(ws.getRow(3).getCell(h.indexOf('Estado') + 1).value).toBe('Pendiente de aprobación');
    expect(ws.getRow(3).getCell(h.indexOf('Consentimiento WhatsApp') + 1).value).toBe('Sí');
  });
  it('exporta unidades con su conductor y asignaciones con tarifa diaria y semanal sin errores de centavos', async () => {
    const u = (await load(await exportUnits([{ code: 'P1', plate: 'AB-123', make: null, model: null, year: 2020, vehicle_status: 'maintenance', notes: null, operator_code: '1', driver_name: 'Ana' }]))).getWorksheet('Unidades')!;
    expect(u.getRow(3).getCell(6).value).toBe('En mantenimiento');
    expect(u.getRow(3).getCell(7).value).toBeNull();                       // sin acuerdo: celda vacía, no un texto inventado
    const u2 = (await load(await exportUnits([{ code: 'P2', plate: null, make: null, model: null, year: null, vehicle_status: 'out_of_service', notes: null, operator_code: null, driver_name: null, agreement: 'CHAPA', agreement_note: 'En reparación' }]))).getWorksheet('Unidades')!;
    expect([u2.getRow(3).getCell(7).value, u2.getRow(3).getCell(8).value, u2.getRow(3).getCell(9).value, u2.getRow(3).getCell(10).value]).toEqual(['CHAPA', 'En reparación', null, null]);   // unidad sin conductor
    const a = (await load(await exportAssignments([{ unit_code: 'P1', operator_code: '1', driver_name: 'Ana', valid_from: '2026-03-02', valid_to: null, daily_rate_cents: 3450, agreement_note: null }]))).getWorksheet('Asignaciones')!;
    expect(a.getRow(3).getCell(5).value).toBe('Vigente'); expect(a.getRow(3).getCell(6).value).toBe(34.5); expect(a.getRow(3).getCell(7).value).toBe(207);
  });
});

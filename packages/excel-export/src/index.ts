import ExcelJS from 'exceljs';

/** Exportaciones .xlsx de VIP. Reciben filas YA calculadas por la base de datos (centavos) y escriben VALORES:
 *  no copian fórmulas del Excel original (algunas estaban dañadas) ni recalculan saldos. */

const DAYS = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
const MONEY = '"$"#,##0.00;[Red]-"$"#,##0.00';
const dollars = (cents: number | string | null | undefined): number | null => (cents == null ? null : Number(cents) / 100);

export interface WeeklyRow {
  unit_code: string; operator_code: string; national_id: string; full_name: string; driver_status: string;
  daily_rate_cents: number | string; week_charged_cents: number | string; day_net_cents: Array<number | string>;
  gross_cents: number | string; commission_cents: number | string; net_cents: number | string;
  week_diff_cents: number | string; pending_cents: number | string; credit_cents: number | string; week_closed: boolean;
}

export type Cell = string | number | boolean | null;
export interface Column<T> { header: string; width?: number; money?: boolean; value: (r: T) => Cell }

function sheetFrom<T>(wb: ExcelJS.Workbook, name: string, title: string[], cols: Array<Column<T>>, rows: T[]): ExcelJS.Worksheet {
  const ws = wb.addWorksheet(name.slice(0, 31), { views: [{ state: 'frozen', ySplit: title.length + 1, xSplit: 2 }] });
  title.forEach((t, i) => { ws.getCell(i + 1, 1).value = t; ws.getCell(i + 1, 1).font = { bold: i === 0, size: i === 0 ? 13 : 10 }; });
  const h = ws.getRow(title.length + 1);
  cols.forEach((c, i) => {
    const cell = h.getCell(i + 1);
    cell.value = c.header; cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3A5F' } };
    cell.alignment = { wrapText: true, vertical: 'middle', horizontal: c.money ? 'right' : 'left' };
    ws.getColumn(i + 1).width = c.width ?? (c.money ? 13 : 18);
    if (c.money) ws.getColumn(i + 1).numFmt = MONEY;
  });
  rows.forEach((r) => ws.addRow(cols.map((c) => c.value(r))));
  ws.autoFilter = { from: { row: title.length + 1, column: 1 }, to: { row: title.length + 1, column: cols.length } };
  return ws;
}

async function toBuffer(wb: ExcelJS.Workbook): Promise<Buffer> {
  wb.creator = 'VIP'; wb.created = new Date();
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const dayLabel = (weekStart: string, i: number): string => {
  const d = new Date(`${weekStart}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + i);
  return `${DAYS[i]} ${d.toISOString().slice(5, 10).split('-').reverse().join('/')}`;
};

/** Tabla semanal con estructura familiar: lunes a domingo, cuenta diaria y semanal, diferencia. */
export async function exportWeeklyTable(rows: WeeklyRow[], opts: { weekStart: string; organizationName?: string }): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const cols: Array<Column<WeeklyRow>> = [
    { header: 'Unidad', width: 10, value: (r) => r.unit_code },
    { header: 'Operador', width: 11, value: (r) => r.operator_code },
    { header: 'Cédula', width: 14, value: (r) => r.national_id },
    { header: 'Nombre y apellido', width: 30, value: (r) => r.full_name },
    { header: 'Estado', width: 12, value: (r) => r.driver_status },
    { header: 'Cuenta diaria', money: true, value: (r) => dollars(r.daily_rate_cents) },
    ...DAYS.map((_d, i): Column<WeeklyRow> => ({ header: `${dayLabel(opts.weekStart, i)} (neto recibido)`, money: true, value: (r) => dollars(r.day_net_cents[i]) })),
    { header: 'Cuenta semanal', money: true, value: (r) => dollars(r.week_charged_cents) },
    { header: 'Total entregado (bruto)', money: true, value: (r) => dollars(r.gross_cents) },
    { header: 'Comisión Yappy/Punto Pago', money: true, value: (r) => dollars(r.commission_cents) },
    { header: 'Pago neto recibido', money: true, value: (r) => dollars(r.net_cents) },
    { header: 'Diferencia (neto − cuenta semanal)', money: true, width: 16, value: (r) => dollars(r.week_diff_cents) },
    { header: 'Pendiente', money: true, value: (r) => dollars(r.pending_cents) },
    { header: 'Crédito a favor', money: true, value: (r) => dollars(r.credit_cents) },
    { header: 'Semana cerrada', width: 10, value: (r) => (r.week_closed ? 'Sí' : 'No') },
  ];
  sheetFrom(wb, 'Semana', [`Cobranza semanal · semana del ${opts.weekStart}${opts.organizationName ? ` · ${opts.organizationName}` : ''}`,
    'Cifras recibidas = neto (después de la comisión del proveedor). La comisión no forma parte de la cuenta semanal. Pendiente y crédito: para las unidades gestionadas por el Excel son el último SALDO válido importado (igual que Cobranza); para el resto, saldos acumulados al cierre de la semana, calculados desde los movimientos.'], cols, rows);
  return toBuffer(wb);
}

export interface PaymentRow {
  paid_at: string; unit_code: string; operator_code: string; full_name: string; method_label: string;
  gross_cents: number | string; commission_cents: number | string; net_cents: number | string; applied_cents: number | string;
  credit_generated_cents: number | string; reference: string | null; registered_by: string | null; voided: boolean; void_reason: string | null;
}
const paymentCols: Array<Column<PaymentRow>> = [
  { header: 'Fecha y hora', width: 20, value: (r) => r.paid_at },
  { header: 'Unidad', width: 10, value: (r) => r.unit_code }, { header: 'Operador', width: 11, value: (r) => r.operator_code },
  { header: 'Nombre y apellido', width: 30, value: (r) => r.full_name }, { header: 'Método', width: 13, value: (r) => r.method_label },
  { header: 'Entregado (bruto)', money: true, value: (r) => dollars(r.gross_cents) },
  { header: 'Comisión proveedor', money: true, value: (r) => dollars(r.commission_cents) },
  { header: 'Neto recibido', money: true, value: (r) => dollars(r.net_cents) },
  { header: 'Aplicado a deuda', money: true, value: (r) => dollars(r.applied_cents) },
  { header: 'Crédito generado', money: true, value: (r) => dollars(r.credit_generated_cents) },
  { header: 'Referencia', width: 18, value: (r) => r.reference }, { header: 'Registrado por', width: 24, value: (r) => r.registered_by },
  { header: 'Anulado', width: 9, value: (r) => (r.voided ? 'Sí' : 'No') }, { header: 'Motivo de anulación', width: 24, value: (r) => r.void_reason },
];

/** Cobranza de un día: pagos registrados ese día. */
export async function exportDayCollection(rows: PaymentRow[], opts: { date: string }): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  sheetFrom(wb, 'Día', [`Cobranza del día ${opts.date}`], paymentCols, rows);
  return toBuffer(wb);
}

export async function exportPaymentHistory(rows: PaymentRow[], opts: { from: string; to: string }): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  sheetFrom(wb, 'Pagos', [`Historial de pagos ${opts.from} a ${opts.to}`], paymentCols, rows);
  return toBuffer(wb);
}

export interface MethodRow { method_label: string; payments: number | string; gross_cents: number | string; commission_cents: number | string; net_cents: number | string }
/** Pagos por método: separa lo entregado, la comisión del proveedor y lo que recibió la empresa. */
export async function exportPaymentsByMethod(rows: MethodRow[], opts: { from: string; to: string }): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = sheetFrom(wb, 'Por método', [`Pagos por método ${opts.from} a ${opts.to}`], [
    { header: 'Método', width: 16, value: (r: MethodRow) => r.method_label },
    { header: 'Pagos', width: 8, value: (r) => Number(r.payments) },
    { header: 'Entregado (bruto)', money: true, value: (r) => dollars(r.gross_cents) },
    { header: 'Comisión proveedor', money: true, value: (r) => dollars(r.commission_cents) },
    { header: 'Neto recibido por la empresa', money: true, width: 18, value: (r) => dollars(r.net_cents) },
  ], rows);
  const t = ws.addRow(['TOTAL', rows.reduce((a, r) => a + Number(r.payments), 0),
    dollars(rows.reduce((a, r) => a + Number(r.gross_cents), 0)), dollars(rows.reduce((a, r) => a + Number(r.commission_cents), 0)),
    dollars(rows.reduce((a, r) => a + Number(r.net_cents), 0))]);
  t.font = { bold: true };
  return toBuffer(wb);
}

export interface BalanceRow { unit_code: string; operator_code: string; national_id: string; full_name: string; driver_status: string; pending_cents: number | string; credit_cents: number | string; phone: string | null }
const balanceCols = (kind: 'pending' | 'credit'): Array<Column<BalanceRow>> => [
  { header: 'Unidad', width: 10, value: (r) => r.unit_code }, { header: 'Operador', width: 11, value: (r) => r.operator_code },
  { header: 'Cédula', width: 14, value: (r) => r.national_id }, { header: 'Nombre y apellido', width: 30, value: (r) => r.full_name },
  { header: 'Estado', width: 12, value: (r) => r.driver_status }, { header: 'WhatsApp', width: 16, value: (r) => r.phone },
  kind === 'pending' ? { header: 'Deuda pendiente', money: true, value: (r) => dollars(r.pending_cents) }
                     : { header: 'Crédito a favor', money: true, value: (r) => dollars(r.credit_cents) },
];
export async function exportPendingDebts(rows: BalanceRow[], opts: { asOf: string }): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  sheetFrom(wb, 'Deudas', [`Deudas pendientes al ${opts.asOf}`], balanceCols('pending'), rows.filter((r) => Number(r.pending_cents) > 0));
  return toBuffer(wb);
}
export async function exportCredits(rows: BalanceRow[], opts: { asOf: string }): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  sheetFrom(wb, 'Créditos', [`Créditos a favor al ${opts.asOf}`], balanceCols('credit'), rows.filter((r) => Number(r.credit_cents) > 0));
  return toBuffer(wb);
}

export interface DirectoryRow { operator_code: string; national_id: string; full_name: string; status: string; phone: string | null; whatsapp: string | null;
  license_number: string | null; license_expires_on: string | null; unit_code: string | null; plate: string | null; daily_rate_cents: number | string | null }
export async function exportDirectory(rows: DirectoryRow[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  sheetFrom(wb, 'Conductores y unidades', ['Conductores y unidades'], [
    { header: 'Operador', width: 11, value: (r: DirectoryRow) => r.operator_code }, { header: 'Cédula', width: 14, value: (r) => r.national_id },
    { header: 'Nombre y apellido', width: 30, value: (r) => r.full_name }, { header: 'Estado', width: 16, value: (r) => r.status },
    { header: 'Teléfono', width: 15, value: (r) => r.phone }, { header: 'WhatsApp', width: 16, value: (r) => r.whatsapp },
    { header: 'Licencia', width: 14, value: (r) => r.license_number }, { header: 'Vence licencia', width: 13, value: (r) => r.license_expires_on },
    { header: 'Unidad', width: 10, value: (r) => r.unit_code }, { header: 'Placa', width: 11, value: (r) => r.plate },
    { header: 'Cuota diaria', money: true, value: (r) => dollars(r.daily_rate_cents) },
  ], rows);
  return toBuffer(wb);
}

export interface MovementRow { occurred_at: string; kind: string; detail: string | null; amount_cents: number | string; commission_cents: number | string | null; actor: string | null }
const KIND: Record<string, string> = { charge: 'Cuota diaria', payment: 'Pago', payment_void: 'Anulación de pago', adjustment: 'Ajuste' };
export async function exportMovements(rows: MovementRow[], opts: { title: string }): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  sheetFrom(wb, 'Movimientos', [opts.title], [
    { header: 'Fecha y hora', width: 20, value: (r: MovementRow) => r.occurred_at }, { header: 'Tipo', width: 18, value: (r) => KIND[r.kind] ?? r.kind },
    { header: 'Detalle', width: 28, value: (r) => r.detail }, { header: 'Importe', money: true, value: (r) => dollars(r.amount_cents) },
    { header: 'Comisión', money: true, value: (r) => dollars(r.commission_cents) }, { header: 'Usuario', width: 24, value: (r) => r.actor },
  ], rows);
  return toBuffer(wb);
}

export interface DriverRow { operator_code: string; national_id: string; first_name: string; last_name: string; status: string; phone: string | null; phone_e164: string | null;
  whatsapp_consent: boolean; reminders_paused: boolean; license_number: string | null; license_expires_on: string | null; notes: string | null; unit_code: string | null; created_at: string }
const STATUS: Record<string, string> = { active: 'Activo', inactive: 'Inactivo', suspended: 'Suspendido', pending_approval: 'Pendiente de aprobación', maintenance: 'En mantenimiento', out_of_service: 'Fuera de servicio' };
/** Todos los conductores (los mismos campos de la plantilla de importación, para poder editar y volver a importar). */
export async function exportDrivers(rows: DriverRow[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  sheetFrom(wb, 'Conductores', ['Conductores'], [
    { header: 'Unidad', width: 10, value: (r: DriverRow) => r.unit_code }, { header: 'Código de operador', width: 14, value: (r) => r.operator_code },
    { header: 'Nombre', width: 22, value: (r) => r.first_name }, { header: 'Apellido', width: 22, value: (r) => r.last_name }, { header: 'Cédula', width: 15, value: (r) => r.national_id },
    { header: 'WhatsApp', width: 16, value: (r) => r.phone_e164 }, { header: 'Teléfono', width: 15, value: (r) => r.phone },
    { header: 'Estado', width: 22, value: (r) => STATUS[r.status] ?? r.status }, { header: 'Consentimiento WhatsApp', width: 14, value: (r) => (r.whatsapp_consent ? 'Sí' : 'No') },
    { header: 'Recordatorios pausados', width: 14, value: (r) => (r.reminders_paused ? 'Sí' : 'No') }, { header: 'Licencia', width: 14, value: (r) => r.license_number },
    { header: 'Vence licencia', width: 13, value: (r) => r.license_expires_on }, { header: 'Observaciones', width: 30, value: (r) => r.notes }, { header: 'Creado', width: 12, value: (r) => r.created_at },
  ], rows);
  return toBuffer(wb);
}

export interface UnitRow { code: string; plate: string | null; make: string | null; model: string | null; year: number | null; vehicle_status: string; notes: string | null; operator_code: string | null; driver_name: string | null;
  agreement?: string | null; agreement_note?: string | null }
export async function exportUnits(rows: UnitRow[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  sheetFrom(wb, 'Unidades', ['Unidades'], [
    { header: 'Unidad', width: 10, value: (r: UnitRow) => r.code }, { header: 'Placa', width: 12, value: (r) => r.plate }, { header: 'Marca', width: 14, value: (r) => r.make },
    { header: 'Modelo', width: 14, value: (r) => r.model }, { header: 'Año', width: 8, value: (r) => r.year }, { header: 'Estado', width: 20, value: (r) => STATUS[r.vehicle_status] ?? r.vehicle_status },
    { header: 'Acuerdo / condición especial', width: 30, value: (r) => r.agreement ?? null }, { header: 'Observación', width: 34, value: (r) => r.agreement_note ?? null },
    { header: 'Conductor asignado', width: 28, value: (r) => r.driver_name }, { header: 'Código de operador', width: 14, value: (r) => r.operator_code }, { header: 'Observaciones', width: 30, value: (r) => r.notes },
  ], rows);
  return toBuffer(wb);
}

export interface AssignmentRow { unit_code: string; operator_code: string; driver_name: string; valid_from: string; valid_to: string | null; daily_rate_cents: number | string | null; agreement_note: string | null }
/** Asignaciones con su historial (vigentes y cerradas). La tarifa semanal es 6 × la diaria y solo es informativa. */
export async function exportAssignments(rows: AssignmentRow[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  sheetFrom(wb, 'Asignaciones', ['Asignaciones (historial)'], [
    { header: 'Unidad', width: 10, value: (r: AssignmentRow) => r.unit_code }, { header: 'Código de operador', width: 14, value: (r) => r.operator_code },
    { header: 'Conductor', width: 28, value: (r) => r.driver_name }, { header: 'Desde', width: 12, value: (r) => r.valid_from }, { header: 'Hasta', width: 12, value: (r) => r.valid_to ?? 'Vigente' },
    { header: 'Tarifa diaria', money: true, value: (r) => dollars(r.daily_rate_cents) }, { header: 'Tarifa semanal (6 × diaria)', money: true, width: 16, value: (r) => (r.daily_rate_cents == null ? null : (Number(r.daily_rate_cents) * 6) / 100) },
    { header: 'Acuerdo', width: 28, value: (r) => r.agreement_note },
  ], rows);
  return toBuffer(wb);
}

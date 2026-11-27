import { formatUSD } from './money.js';
import type { PaymentRecord, Position } from './ledger.js';
import { PAYMENT_METHODS } from './methods.js';

/** Línea de saldo que distingue claramente deuda de crédito. */
export function balanceLine(p: Position): string {
  if (p.pendingCents > 0) return `Saldo pendiente: ${formatUSD(p.pendingCents)}`;
  if (p.creditCents > 0) return `Saldo a favor: ${formatUSD(p.creditCents)}`;
  return 'Su cuenta está al día.';
}

/** Recordatorio de deuda. null = no enviar (ya pagó o solo tiene crédito). Usa la posición ACTUAL. */
export function debtReminder(p: Position, unit: string): { body: string } | { skip: 'paid' | 'credit' } {
  if (p.pendingCents > 0) {
    return { body: `Estimado conductor, unidad ${unit}: su saldo pendiente es de ${formatUSD(p.pendingCents)}.` };
  }
  return { skip: p.creditCents > 0 ? 'credit' : 'paid' };
}

/** Comprobante de pago con valores reales: bruto, comisión del proveedor, neto y saldo resultante. */
export function paymentReceipt(pay: PaymentRecord, after: Position, unit: string): string {
  const lines = [
    'Estimado conductor, hemos registrado su pago correctamente.',
    `Unidad: ${unit}`,
    `Método: ${PAYMENT_METHODS[pay.method].label}`,
    `Monto entregado: ${formatUSD(pay.grossCents)}`,
  ];
  if (pay.commissionCents > 0) lines.push(`Comisión del proveedor: ${formatUSD(pay.commissionCents)}`);
  lines.push(`Abono a su cuenta: ${formatUSD(pay.netCents)}`, balanceLine(after), 'Gracias por su pago.');
  return lines.join('\n');
}

export interface CreditNotice {
  creditCents: number;
  coveredObligationIds: string[];
  suggestedMessage: string;
  /** Nunca se envía solo: la administradora decide enviar, editar o descartar. */
  requiresApproval: true;
  autoSend: false;
}

/** Aviso interno cuando un pago deja (o aumenta) un crédito a favor. */
export function creditNotice(before: Position, after: Position, unit: string): CreditNotice | null {
  if (after.creditCents <= 0 || after.creditCents <= before.creditCents) return null;
  const prev = new Map(before.obligations.map((o) => [o.id, o.remainingCents]));
  const covered = after.obligations
    .filter((o) => o.remainingCents === 0 && (prev.get(o.id) ?? 0) > 0)
    .map((o) => o.id);
  return {
    creditCents: after.creditCents,
    coveredObligationIds: covered,
    suggestedMessage:
      `Estimado conductor, le informamos que su cuenta (unidad ${unit}) se encuentra al día y mantiene un ` +
      `saldo a favor de ${formatUSD(after.creditCents)}, que será aplicado a sus próximas obligaciones.\n¡Gracias por su puntualidad!`,
    requiresApproval: true,
    autoSend: false,
  };
}

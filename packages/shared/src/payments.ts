import type { Cents } from './money.js';

export interface PaymentBreakdown {
  /** Lo que entrega el conductor. */
  grossCents: Cents;
  /** Lo que descuenta el proveedor (Yappy / Punto Pago). */
  commissionCents: Cents;
  /** Lo que recibe realmente la empresa = bruto − comisión. Es lo único que se aplica a la cuenta. */
  netCents: Cents;
}

export type BreakdownResult =
  | ({ ok: true } & PaymentBreakdown)
  | { ok: false; reason: 'invalid_amount' | 'amount_not_covering_commission' };

/** Cada operación lleva su propia comisión (política confirmada: por transacción). */
export function breakdownPayment(grossCents: Cents, commissionCents: Cents): BreakdownResult {
  if (!Number.isInteger(grossCents) || grossCents <= 0 ||
      !Number.isInteger(commissionCents) || commissionCents < 0) {
    return { ok: false, reason: 'invalid_amount' };
  }
  if (grossCents <= commissionCents) return { ok: false, reason: 'amount_not_covering_commission' };
  return { ok: true, grossCents, commissionCents, netCents: grossCents - commissionCents };
}

/** Cuánto debe enviar el conductor para que la empresa reciba `netCents`. */
export const grossRequiredForNet = (netCents: Cents, commissionCents: Cents): Cents =>
  netCents + commissionCents;

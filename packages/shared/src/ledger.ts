import { breakdownPayment } from './payments.js';
import type { Cents } from './money.js';
import type { PaymentMethodCode } from './methods.js';
import { isOrdinaryChargeDay, weekDates } from './week.js';

export interface Charge { id: string; date: string; amountCents: Cents }
export interface Adjustment { id: string; date: string; amountCents: Cents } // + deuda, − reduce deuda
export interface PaymentRecord {
  id: string;
  idempotencyKey: string;
  method: PaymentMethodCode;
  grossCents: Cents;
  commissionCents: Cents;
  netCents: Cents;
  paidAt: string;
  reference?: string;
  registeredBy: string;
  voided?: boolean;
}

export interface LedgerState {
  /** SALDO inicial (significado en el Excel sin confirmar → por defecto 0). + deuda, − crédito. */
  openingCents: Cents;
  charges: Charge[];
  adjustments: Adjustment[];
  payments: PaymentRecord[];
}

export interface ObligationStatus { id: string; date: string; amountCents: Cents; coveredCents: Cents; remainingCents: Cents }

export interface Position {
  chargedCents: Cents;
  grossCents: Cents;
  commissionCents: Cents;
  /** Lo que realmente recibió la empresa (y lo único que cubre deuda). */
  netCents: Cents;
  pendingCents: Cents;
  creditCents: Cents;
  /** pendiente − crédito; positivo = debe, negativo = a favor. */
  balanceCents: Cents;
  obligations: ObligationStatus[];
}

/**
 * Posición calculada SOLO desde movimientos. La deuda se cubre de la más antigua a la más reciente;
 * lo que sobra es crédito, que se aplica solo a las obligaciones futuras y nunca se descarta.
 */
export function computePosition(state: LedgerState): Position {
  const live = state.payments.filter((p) => !p.voided);
  const net = sum(live.map((p) => p.netCents));

  const obligations: Array<{ id: string; date: string; amountCents: Cents }> = [];
  let available = net;
  const pushOrCredit = (id: string, date: string, amount: Cents) =>
    amount >= 0 ? obligations.push({ id, date, amountCents: amount }) : (available += -amount);

  pushOrCredit('opening', '0000-00-00', state.openingCents);
  for (const a of state.adjustments) pushOrCredit(a.id, a.date, a.amountCents);
  for (const c of state.charges) obligations.push({ id: c.id, date: c.date, amountCents: c.amountCents });
  obligations.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));

  const statuses: ObligationStatus[] = obligations.map((o) => {
    const covered = Math.min(available, o.amountCents);
    available -= covered;
    return { ...o, coveredCents: covered, remainingCents: o.amountCents - covered };
  });

  const pending = sum(statuses.map((s) => s.remainingCents));
  const credit = available;
  return {
    chargedCents: sum(state.charges.map((c) => c.amountCents)),
    grossCents: sum(live.map((p) => p.grossCents)),
    commissionCents: sum(live.map((p) => p.commissionCents)),
    netCents: net,
    pendingCents: pending,
    creditCents: credit,
    balanceCents: pending - credit,
    obligations: statuses,
  };
}

const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

/** Cargos ordinarios lun–sáb de la semana que contiene `anyDateInWeek`. El domingo no genera cuota. */
export function weeklyCharges(anyDateInWeek: string, dailyCents: Cents, idPrefix = 'chg'): Charge[] {
  return weekDates(anyDateInWeek)
    .filter(isOrdinaryChargeDay)
    .map((date) => ({ id: `${idPrefix}-${date}`, date, amountCents: dailyCents }));
}

export interface RegisterPaymentInput {
  id: string;
  idempotencyKey: string;
  method: PaymentMethodCode;
  grossCents: Cents;
  commissionCents: Cents;
  paidAt: string;
  reference?: string;
  registeredBy: string;
}

export type RegisterResult =
  | { status: 'created'; payment: PaymentRecord; before: Position; after: Position }
  | { status: 'duplicate'; payment: PaymentRecord; before: Position; after: Position }
  | { status: 'rejected'; reason: 'invalid_amount' | 'amount_not_covering_commission' | 'idempotency_conflict' };

/** Implementación de referencia en memoria; la versión real es una transacción en Postgres con la misma semántica. */
export class PaymentLedger {
  private state: LedgerState;

  constructor(initial?: Partial<LedgerState>) {
    this.state = { openingCents: 0, charges: [], adjustments: [], payments: [], ...initial };
  }

  addCharges(charges: Charge[]): void {
    for (const c of charges) {
      if (!this.state.charges.some((x) => x.id === c.id)) this.state.charges.push(c); // sin duplicar cargos
    }
  }

  addAdjustment(a: Adjustment): void { this.state.adjustments.push(a); }

  position(): Position { return computePosition(this.state); }

  registerPayment(input: RegisterPaymentInput): RegisterResult {
    const before = this.position();
    const existing = this.state.payments.find((p) => p.idempotencyKey === input.idempotencyKey);
    if (existing) {
      if (existing.grossCents !== input.grossCents || existing.method !== input.method) {
        return { status: 'rejected', reason: 'idempotency_conflict' };
      }
      return { status: 'duplicate', payment: existing, before, after: before };
    }
    const b = breakdownPayment(input.grossCents, input.commissionCents);
    if (!b.ok) return { status: 'rejected', reason: b.reason };
    const payment: PaymentRecord = { ...input, netCents: b.netCents };
    this.state.payments.push(payment);
    return { status: 'created', payment, before, after: this.position() };
  }
}

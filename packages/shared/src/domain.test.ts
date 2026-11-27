import { describe, expect, it } from 'vitest';
import {
  PAYMENT_METHODS, PaymentLedger, addDays, breakdownPayment, creditNotice, debtReminder,
  formatUSD, grossRequiredForNet, isOrdinaryChargeDay, paymentReceipt, toCents, weekDates, weekStart,
  weeklyCharges, type PaymentMethodCode, type RegisterPaymentInput,
} from './index.js';

const MON1 = '2026-11-16'; // lunes
const MON2 = '2026-11-23';
let seq = 0;
const pay = (method: PaymentMethodCode, grossCents: number, extra: Partial<RegisterPaymentInput> = {}): RegisterPaymentInput => {
  seq += 1;
  return {
    id: `p${seq}`, idempotencyKey: `k${seq}`, method, grossCents,
    commissionCents: PAYMENT_METHODS[method].commissionCents,
    paidAt: `${MON1}T10:00:00-05:00`, registeredBy: 'admin', ...extra,
  };
};
const daily = (cents = 3600) => {
  const l = new PaymentLedger();
  l.addCharges(weeklyCharges(MON1, cents));
  return l;
};
const oneDay = (cents = 3600) => {
  const l = new PaymentLedger();
  l.addCharges([{ id: 'c1', date: MON1, amountCents: cents }]);
  return l;
};

describe('semana', () => {
  it('lunes a sábado generan cuota; domingo no', () => {
    expect(isOrdinaryChargeDay('2026-11-16')).toBe(true);
    expect(isOrdinaryChargeDay('2026-11-21')).toBe(true);
    expect(isOrdinaryChargeDay('2026-11-22')).toBe(false);
  });
  it('la semana empieza el lunes y tiene 7 días', () => {
    expect(weekStart('2026-11-22')).toBe(MON1);
    expect(weekDates('2026-11-19')).toHaveLength(7);
    expect(addDays('2026-11-22', 1)).toBe(MON2);
  });
  it('cuenta semanal = 6 × cuota diaria, sin cargo dominical', () => {
    const c = weeklyCharges(MON1, 3600);
    expect(c).toHaveLength(6);
    expect(c.reduce((a, x) => a + x.amountCents, 0)).toBe(21600);
    expect(c.some((x) => x.date === '2026-11-22')).toBe(false);
  });
});

describe('pago: bruto, comisión y neto', () => {
  it('efectivo completo: entrega 36 y la empresa recibe 36', () => {
    const r = oneDay().registerPayment(pay('cash', 3600));
    expect(r.status).toBe('created');
    if (r.status !== 'created') return;
    expect(r.payment).toMatchObject({ grossCents: 3600, commissionCents: 0, netCents: 3600 });
    expect(r.after).toMatchObject({ pendingCents: 0, creditCents: 0, netCents: 3600 });
  });
  it.each(['yappy', 'punto_pago'] as const)('%s completo: entrega 37, comisión 1, empresa recibe 36', (m) => {
    const l = oneDay();
    const r = l.registerPayment(pay(m, 3700));
    if (r.status !== 'created') throw new Error('esperaba created');
    expect(r.payment).toMatchObject({ grossCents: 3700, commissionCents: 100, netCents: 3600 });
    expect(r.after).toMatchObject({ pendingCents: 0, creditCents: 0, netCents: 3600, commissionCents: 100, chargedCents: 3600 });
  });
  it('la comisión no altera la cuota ni se suma a la cuenta semanal', () => {
    const l = daily();
    l.registerPayment(pay('yappy', 3700));
    expect(l.position().chargedCents).toBe(21600);
  });
  it('cuánto debe enviar para que la empresa reciba el importe íntegro', () => {
    expect(grossRequiredForNet(3600, 100)).toBe(3700);
    expect(grossRequiredForNet(3600, 0)).toBe(3600);
  });
  it('rechaza importes inválidos o que no cubren la comisión', () => {
    expect(breakdownPayment(0, 100)).toEqual({ ok: false, reason: 'invalid_amount' });
    expect(breakdownPayment(36.5 as number, 100)).toEqual({ ok: false, reason: 'invalid_amount' });
    expect(breakdownPayment(100, 100)).toEqual({ ok: false, reason: 'amount_not_covering_commission' });
  });
});

describe('pagos parciales electrónicos', () => {
  it('Yappy 30 sobre deuda 36 → neto 29, pendiente 7', () => {
    const r = oneDay().registerPayment(pay('yappy', 3000));
    if (r.status !== 'created') throw new Error();
    expect(r.payment.netCents).toBe(2900);
    expect(r.after.pendingCents).toBe(700);
  });
  it('dos transferencias el mismo día: cada una con su propia comisión', () => {
    const l = oneDay();
    l.registerPayment(pay('yappy', 3000));
    const r2 = l.registerPayment(pay('yappy', 800));
    if (r2.status !== 'created') throw new Error();
    expect(r2.payment.netCents).toBe(700);
    expect(r2.after).toMatchObject({ pendingCents: 0, creditCents: 0, grossCents: 3800, commissionCents: 200, netCents: 3600 });
  });
});

describe('saldo a favor', () => {
  it('pagos netos 220 sobre cuenta semanal 216 → crédito 4 (no se usa el bruto)', () => {
    const l = daily();
    const r = l.registerPayment(pay('yappy', 22100)); // neto 22000
    if (r.status !== 'created') throw new Error();
    expect(r.after).toMatchObject({ pendingCents: 0, creditCents: 400, netCents: 22000, grossCents: 22100 });
  });
  it('el crédito se aplica a la semana siguiente: 216 − 4 = 212', () => {
    const l = daily();
    l.registerPayment(pay('cash', 22000));
    l.addCharges(weeklyCharges(MON2, 3600));
    const p = l.position();
    expect(p.creditCents).toBe(0);
    expect(p.pendingCents).toBe(21200);
  });
  it('un crédito que cubre parcialmente una cuota', () => {
    const l = daily();
    l.registerPayment(pay('cash', 22000));
    l.addCharges(weeklyCharges(MON2, 3600));
    const monday2 = l.position().obligations.find((o) => o.date === MON2)!;
    expect(monday2).toMatchObject({ amountCents: 3600, coveredCents: 400, remainingCents: 3200 });
  });
  it('el crédito se conserva (nunca se borra) mientras no haya nuevas obligaciones', () => {
    const l = daily();
    l.registerPayment(pay('cash', 22000));
    expect(l.position().creditCents).toBe(400);
    expect(l.position().balanceCents).toBe(-400);
  });
  it('si hay deuda anterior, primero se cubre la deuda y después queda crédito', () => {
    const l = new PaymentLedger({ openingCents: 1000 });
    l.addCharges([{ id: 'c1', date: MON1, amountCents: 3600 }]);
    const r = l.registerPayment(pay('cash', 5000));
    if (r.status !== 'created') throw new Error();
    expect(r.after).toMatchObject({ pendingCents: 0, creditCents: 400 });
    expect(r.after.obligations.find((o) => o.id === 'opening')!.remainingCents).toBe(0);
  });
});

describe('deuda arrastrada', () => {
  const SUN = '2026-11-22';
  it('la deuda llega al domingo, se paga ese día y el resto pasa a la semana siguiente', () => {
    const l = daily();
    l.registerPayment(pay('cash', 18000));
    expect(l.position().pendingCents).toBe(3600);

    const sun = l.registerPayment(pay('cash', 2000, { paidAt: `${SUN}T09:00:00-05:00` }));
    if (sun.status !== 'created') throw new Error();
    expect(sun.after.pendingCents).toBe(1600); // el domingo no genera cuota nueva

    l.addCharges(weeklyCharges(MON2, 3600));
    const p = l.position();
    expect(p.pendingCents).toBe(1600 + 21600); // la deuda no se reinicia
    const oldest = p.obligations.find((o) => o.remainingCents > 0)!;
    expect(oldest.date).toBe('2026-11-21'); // se cobra primero lo más antiguo
  });
  it('un pago anulado deja de contar', () => {
    const l = oneDay();
    const r = l.registerPayment(pay('cash', 3600));
    if (r.status !== 'created') throw new Error();
    r.payment.voided = true;
    expect(l.position().pendingCents).toBe(3600);
  });
});

describe('prevención de duplicados', () => {
  it('el mismo idempotencyKey no vuelve a registrar el pago', () => {
    const l = oneDay();
    const input = pay('yappy', 3000);
    const a = l.registerPayment(input);
    const b = l.registerPayment({ ...input, id: 'otro-id' });
    expect(a.status).toBe('created');
    expect(b.status).toBe('duplicate');
    expect(l.position().netCents).toBe(2900);
    expect(l.position().commissionCents).toBe(100);
  });
  it('misma clave con importe distinto es un conflicto', () => {
    const l = oneDay();
    const input = pay('cash', 1000);
    l.registerPayment(input);
    expect(l.registerPayment({ ...input, grossCents: 2000 })).toEqual({ status: 'rejected', reason: 'idempotency_conflict' });
  });
  it('un cargo repetido no se duplica', () => {
    const l = oneDay();
    l.addCharges([{ id: 'c1', date: MON1, amountCents: 3600 }]);
    expect(l.position().chargedCents).toBe(3600);
  });
});

describe('centavos exactos', () => {
  it('convierte decimales sin errores de coma flotante', () => {
    expect(toCents('19.5')).toBe(1950);
    expect(toCents('34,5')).toBe(3450);
    expect(toCents(34.35)).toBe(3435);
    expect(toCents(0.1 + 0.2)).toBe(30);
    expect(() => toCents('abc')).toThrow();
  });
  it('tarifas con centavos y cuenta semanal exacta', () => {
    const l = new PaymentLedger();
    l.addCharges(weeklyCharges(MON1, toCents('34.5')));
    expect(l.position().chargedCents).toBe(20700);
    const r = l.registerPayment(pay('yappy', 20800));
    if (r.status !== 'created') throw new Error();
    expect(r.after.pendingCents).toBe(0);
  });
  it('formatea importes', () => {
    expect(formatUSD(3600)).toBe('$36.00');
    expect(formatUSD(5)).toBe('$0.05');
    expect(formatUSD(-400)).toBe('-$4.00');
  });
});

describe('mensajes', () => {
  it('tras un pago parcial el recordatorio muestra el nuevo saldo', () => {
    const l = oneDay();
    l.registerPayment(pay('yappy', 3000));
    expect(debtReminder(l.position(), 'P811')).toEqual({
      body: 'Estimado conductor, unidad P811: su saldo pendiente es de $7.00.',
    });
  });
  it('si ya pagó o solo tiene crédito, no se envía reclamo de deuda', () => {
    const paid = oneDay(); paid.registerPayment(pay('cash', 3600));
    expect(debtReminder(paid.position(), 'P811')).toEqual({ skip: 'paid' });
    const credit = oneDay(); credit.registerPayment(pay('cash', 4000));
    expect(debtReminder(credit.position(), 'P811')).toEqual({ skip: 'credit' });
  });
  it('el comprobante muestra bruto, comisión, neto y saldo reales', () => {
    const l = oneDay();
    const r = l.registerPayment(pay('yappy', 3000));
    if (r.status !== 'created') throw new Error();
    const text = paymentReceipt(r.payment, r.after, 'P811');
    expect(text).toContain('Método: Yappy');
    expect(text).toContain('Monto entregado: $30.00');
    expect(text).toContain('Comisión del proveedor: $1.00');
    expect(text).toContain('Abono a su cuenta: $29.00');
    expect(text).toContain('Saldo pendiente: $7.00');
  });
  it('un pago que deja crédito genera aviso interno que requiere aprobación', () => {
    const l = daily();
    const r = l.registerPayment(pay('cash', 22000));
    if (r.status !== 'created') throw new Error();
    const n = creditNotice(r.before, r.after, 'P811')!;
    expect(n.creditCents).toBe(400);
    expect(n.requiresApproval).toBe(true);
    expect(n.autoSend).toBe(false);
    expect(n.coveredObligationIds).toHaveLength(6);
    expect(n.suggestedMessage).toContain('saldo a favor de $4.00');
  });
  it('sin crédito nuevo no hay aviso', () => {
    const l = oneDay();
    const r = l.registerPayment(pay('cash', 3600));
    if (r.status !== 'created') throw new Error();
    expect(creditNotice(r.before, r.after, 'P811')).toBeNull();
  });
});

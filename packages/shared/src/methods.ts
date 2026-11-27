import type { Cents } from './money.js';

export type PaymentMethodCode = 'cash' | 'yappy' | 'punto_pago';

export interface PaymentMethodInfo {
  label: string;
  /** Comisión que descuenta el proveedor por CADA operación. No es ingreso de la empresa. */
  commissionCents: Cents;
}

/** Valores por defecto; en producción se leen de payment_methods.commission_cents. */
export const PAYMENT_METHODS: Record<PaymentMethodCode, PaymentMethodInfo> = {
  cash: { label: 'Efectivo', commissionCents: 0 },
  yappy: { label: 'Yappy', commissionCents: 100 },
  punto_pago: { label: 'Punto Pago', commissionCents: 100 },
};

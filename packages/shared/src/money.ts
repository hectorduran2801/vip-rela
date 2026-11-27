/** Todo el dinero se maneja en centavos enteros. */
export type Cents = number;

/** Convierte '19.5', '36,00' o 36.5 a centavos sin errores de coma flotante. */
export function toCents(value: number | string): Cents {
  const n = typeof value === 'string' ? Number(value.trim().replace(',', '.')) : value;
  if (!Number.isFinite(n)) throw new RangeError(`Importe inválido: ${String(value)}`);
  return Math.round(n * 100);
}

/** 3600 → "$36.00"; −400 → "-$4.00". */
export function formatUSD(cents: Cents): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

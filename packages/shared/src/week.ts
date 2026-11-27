/** Fechas locales como 'YYYY-MM-DD'. 1 = lunes … 7 = domingo. */
export function isoWeekday(date: string): number {
  const d = new Date(`${date}T00:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}

/** La cuota ordinaria se genera de lunes a sábado; el domingo no. */
export function isOrdinaryChargeDay(date: string): boolean {
  return isoWeekday(date) <= 6;
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export const weekStart = (date: string): string => addDays(date, -(isoWeekday(date) - 1));

/** Los 7 días de la semana (lunes a domingo). */
export const weekDates = (anyDateInWeek: string): string[] =>
  Array.from({ length: 7 }, (_, i) => addDays(weekStart(anyDateInWeek), i));

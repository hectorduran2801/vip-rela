import { addDays, weekStart as sharedWeekStart } from '@vip/shared';

/** Fecha local 'YYYY-MM-DD' en una zona horaria. */
export function localDate(d: Date | string, timeZone: string): string {
  const date = typeof d === 'string' ? new Date(d) : d;
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
export const todayIn = (tz: string): string => localDate(new Date(), tz);
export const mondayOf = (date: string): string => sharedWeekStart(date);
export const shiftWeek = (monday: string, weeks: number): string => addDays(monday, weeks * 7);
export const DAY_LABELS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'] as const;

/** '2026-11-16' → '16 nov'. */
export function shortDate(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  return new Intl.DateTimeFormat('es-PA', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(d).replace('.', '');
}
/** Fecha y hora en 12 h («16/11/2026 9:05 AM») en la zona indicada. Toda hora visible usa esta función. */
export function dateTime(iso: string, tz: string): string { return formatDateTime12h(iso, tz); }
export function formatDateTime12h(iso: string | Date, tz: string): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(d).map((p) => [p.type, p.value]));
  return `${parts['day']}/${parts['month']}/${parts['year']} ${formatTime12h(`${parts['hour']}:${parts['minute']}`)}`;
}

/** '17:00' o '17:00:00' (24 h, como guarda la base) → '5:00 PM'. Medianoche = 12:00 AM, mediodía = 12:00 PM. */
export function formatTime12h(t: string): string {
  const m = /^(\d{1,2}):(\d{2})/.exec(t);
  if (!m) return '';
  const h = Number(m[1]), min = m[2]!;
  if (h > 23 || Number(min) > 59) return '';
  return `${h % 12 === 0 ? 12 : h % 12}:${min} ${h < 12 ? 'AM' : 'PM'}`;
}
/** '5:00 PM' / '05:00 pm' / '12:30 AM' → '17:00' / '00:30' (24 h para guardar). null si no es válida. */
export function parseTime12h(s: string): string | null {
  const m = /^\s*(\d{1,2}):(\d{2})\s*([AaPp])\.?\s*[Mm]\.?\s*$/.exec(s);
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  if (h < 1 || h > 12 || min > 59) return null;
  const h24 = (h % 12) + (m[3]!.toLowerCase() === 'p' ? 12 : 0);
  return `${String(h24).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}
export type Period = 'AM' | 'PM';
/** '17:05' → { hour: 5, minute: 5, period: 'PM' } para el selector. */
export function to12h(t: string): { hour: number; minute: number; period: Period } {
  const m = /^(\d{1,2}):(\d{2})/.exec(t) ?? ['', '0', '0'];
  const h = Number(m[1]);
  return { hour: h % 12 === 0 ? 12 : h % 12, minute: Number(m[2]), period: h < 12 ? 'AM' : 'PM' };
}
/** { 5, 5, 'PM' } → '17:05'. */
export function from12h(hour: number, minute: number, period: Period): string {
  return `${String((hour % 12) + (period === 'PM' ? 12 : 0)).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

const isoOk = (d: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`));
/** '2026-11-16' → 'lunes 16/11'. Devuelve '' si la fecha no es válida (nunca '0000-00-00'). */
export function dayLabel(date: string): string {
  if (!isoOk(date)) return '';
  const d = new Date(`${date}T00:00:00Z`);
  const wd = new Intl.DateTimeFormat('es-PA', { weekday: 'long', timeZone: 'UTC' }).format(d);
  return `${wd} ${ddmm(date)}`;
}
/** '2026-11-16' → '16/11'. */
export const ddmm = (date: string): string => (isoOk(date) ? `${date.slice(8, 10)}/${date.slice(5, 7)}` : '');
/** '2026-11-16' → '16/11/2026'. */
export const dmy = (date: string): string => (isoOk(date) ? `${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(0, 4)}` : '');

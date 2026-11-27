import { dateTime, formatDateTime12h, formatTime12h, from12h, parseTime12h, to12h } from './dates';

describe('Horas en formato de 12 h (AM/PM)', () => {
  it.each([
    ['00:00', '12:00 AM'], ['00:30', '12:30 AM'], ['12:00', '12:00 PM'], ['12:45', '12:45 PM'], ['13:05', '1:05 PM'],
    ['23:59', '11:59 PM'], ['11:00', '11:00 AM'], ['17:00', '5:00 PM'], ['21:00:00', '9:00 PM'], ['09:00:00', '9:00 AM'],
  ])('formatTime12h(%s) = %s', (i, o) => expect(formatTime12h(i)).toBe(o));
  it('formatTime12h rechaza basura', () => { expect(formatTime12h('')).toBe(''); expect(formatTime12h('25:00')).toBe(''); expect(formatTime12h('abc')).toBe(''); });
  it.each([
    ['12:00 AM', '00:00'], ['12:30 AM', '00:30'], ['12:00 PM', '12:00'], ['1:05 PM', '13:05'], ['11:59 PM', '23:59'],
    ['5:00 pm', '17:00'], ['05:00 P.M.', '17:00'], ['9:00 AM', '09:00'],
  ])('parseTime12h(%s) = %s', (i, o) => expect(parseTime12h(i)).toBe(o));
  it('parseTime12h valida', () => { for (const bad of ['13:00 PM', '0:30 AM', '5:60 PM', '17:00', '5 PM', '']) expect(parseTime12h(bad), bad).toBeNull(); });
  it('ida y vuelta para todos los minutos del día', () => {
    for (let h = 0; h < 24; h++) for (const m of [0, 5, 30, 59]) {
      const t = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
      expect(parseTime12h(formatTime12h(t)), t).toBe(t);
      const p = to12h(t);
      expect(from12h(p.hour, p.minute, p.period), t).toBe(t);
    }
  });
  it('to12h / from12h en los bordes', () => {
    expect(to12h('00:00')).toEqual({ hour: 12, minute: 0, period: 'AM' });
    expect(to12h('12:00')).toEqual({ hour: 12, minute: 0, period: 'PM' });
    expect(from12h(12, 0, 'AM')).toBe('00:00');
    expect(from12h(12, 0, 'PM')).toBe('12:00');
  });
  it('fecha y hora en America/Panama con AM/PM (UTC−5)', () => {
    expect(formatDateTime12h('2026-11-16T14:05:00Z', 'America/Panama')).toBe('16/11/2026 9:05 AM');
    expect(dateTime('2026-11-17T04:30:00Z', 'America/Panama')).toBe('16/11/2026 11:30 PM');
    expect(dateTime('2026-11-16T05:00:00Z', 'America/Panama')).toBe('16/11/2026 12:00 AM');
    expect(dateTime('2026-11-16T17:00:00Z', 'America/Panama')).toBe('16/11/2026 12:00 PM');
  });
});

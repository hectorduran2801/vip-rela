/** «+50760000001» → «+507 6000 0001» (Panamá, 8 dígitos). Otros países: se deja como viene. */
export function formatPhone(p: string | null | undefined): string {
  if (!p) return '';
  const m = /^\+?507(\d{4})(\d{4})$/.exec(p.replace(/[\s-]/g, ''));
  return m ? `+507 ${m[1]} ${m[2]}` : p;
}
/** Número enmascarado para la confirmación final: «+507…0001». */
export function maskPhone(p: string): string {
  const d = p.replace(/\D/g, '');
  const cc = p.startsWith('+') && d.startsWith('507') ? '+507' : p.slice(0, 1) === '+' ? `+${d.slice(0, 3)}` : '';
  return `${cc}…${d.slice(-4)}`;
}

/** WhatsApp → E.164 (misma regla que el importador): 8 dígitos → +507; 507xxxxxxxx → +507…; 00… o + → internacional (10–15 dígitos). null = no válido. */
export function normalizeWhatsapp(raw: string | null | undefined): string | null {
  const t = (raw ?? '').trim();
  if (!t) return null;
  const plus = t.startsWith('+'), d = t.replace(/\D/g, '');
  if (!/^[0-9+()\s./-]+$/.test(t)) return null;
  if (plus) return d.length >= 10 && d.length <= 15 ? `+${d}` : null;
  if (d.startsWith('00')) return d.length - 2 >= 10 && d.length - 2 <= 15 ? `+${d.slice(2)}` : null;
  if (d.length === 8) return `+507${d}`;
  if (d.startsWith('507') && d.length === 11) return `+${d}`;
  return null;
}

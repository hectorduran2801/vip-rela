/**
 * Normalización ÚNICA de teléfonos de WhatsApp (formato de bloques de cobranza y plantilla del directorio) → E.164.
 *
 * Acepta separadores (espacios, guiones, puntos, paréntesis, barras) y celdas numéricas de Excel:
 *   66123456, 6612-3456, (507) 6612-3456   → +50766123456   (8 dígitos = Panamá; el +507 se AGREGA)
 *   50766123456                            → +50766123456   (prefijo 507 sin «+»)
 *   +507 6612 3456, 00507 6612 3456        → +50766123456
 *   +573001234567, 00573001234567          → +573001234567  (otro país, solo con «+» o «00»)
 * Todo lo demás es inválido (null): letras, longitudes raras, 8 dígitos que empiezan por 0 o 1, decimales de una celda numérica.
 */
export interface PhoneResult {
  /** E.164 o null si no es válido. */
  e164: string | null;
  /** true = el valor original NO traía el 507 y se agregó (8 dígitos). */
  added507: boolean;
}

const INVALID: PhoneResult = { e164: null, added507: false };
const SEPARATORS = /[\s().\-–—/_]/g;

export function parsePhone(raw: string | number | null | undefined): PhoneResult {
  if (raw === null || raw === undefined) return INVALID;
  let s: string;
  if (typeof raw === 'number') {
    if (!Number.isInteger(raw) || raw <= 0 || !Number.isSafeInteger(raw)) return INVALID;   // 6612.3456 en una celda numérica NO es un teléfono
    s = String(raw);
  } else s = raw;
  const t = s.replace(SEPARATORS, '');
  if (!/^\+?\d+$/.test(t)) return INVALID;
  const intl = (digits: string): PhoneResult => {
    if (digits.startsWith('0')) return INVALID;
    if (digits.startsWith('507')) return digits.length === 11 ? { e164: `+${digits}`, added507: false } : INVALID;
    return digits.length >= 10 && digits.length <= 15 ? { e164: `+${digits}`, added507: false } : INVALID;
  };
  if (t.startsWith('+')) return intl(t.slice(1));
  if (t.startsWith('00')) return intl(t.slice(2));
  if (/^[2-9]\d{7}$/.test(t)) return { e164: `+507${t}`, added507: true };
  if (/^507\d{8}$/.test(t)) return { e164: `+${t}`, added507: false };
  return INVALID;
}

/** WhatsApp → E.164. 8 dígitos = Panamá (+507). null = no válido. */
export function normalizePhone(raw: string | number | null | undefined): string | null {
  return parsePhone(raw).e164;
}

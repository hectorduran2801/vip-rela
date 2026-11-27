import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Formato (bytea en whatsapp_session_secrets.encrypted_session):
 *   [1 byte versión=1][12 bytes IV aleatorio][16 bytes tag GCM][ciphertext]
 * AES-256-GCM. `aad` (p. ej. el id de la sesión) se autentica pero no se guarda: impide copiar el
 * secreto de una sesión a otra.
 */
const VERSION = 1;
const IV_LEN = 12;
const TAG_LEN = 16;

function assertKey(key: Buffer) {
  if (key.length !== 32) throw new Error('La clave de cifrado debe tener 32 bytes');
}

export function encryptSession(plain: Buffer | string, key: Buffer, aad?: string): Buffer {
  assertKey(key);
  const iv = randomBytes(IV_LEN);
  const c = createCipheriv('aes-256-gcm', key, iv);
  if (aad) c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(typeof plain === 'string' ? Buffer.from(plain) : plain), c.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, c.getAuthTag(), ct]);
}

/** Lanza si la clave es incorrecta, el aad no coincide o el contenido fue manipulado. */
export function decryptSession(blob: Buffer, key: Buffer, aad?: string): Buffer {
  assertKey(key);
  if (blob.length < 1 + IV_LEN + TAG_LEN || blob[0] !== VERSION) throw new Error('Secreto de sesión con formato inválido');
  const iv = blob.subarray(1, 1 + IV_LEN);
  const tag = blob.subarray(1 + IV_LEN, 1 + IV_LEN + TAG_LEN);
  const ct = blob.subarray(1 + IV_LEN + TAG_LEN);
  const d = createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  if (aad) d.setAAD(Buffer.from(aad));
  try {
    return Buffer.concat([d.update(ct), d.final()]);
  } catch {
    throw new Error('No se pudo descifrar el secreto de sesión (clave incorrecta o datos alterados)');
  }
}

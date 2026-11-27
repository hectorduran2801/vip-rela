import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptSession, encryptSession } from '../src/crypto.js';

const key = randomBytes(32);

describe('cifrado de sesión AES-256-GCM', () => {
  it('ida y vuelta', () => {
    const blob = encryptSession('{"wid":"abc","token":"secreto"}', key);
    expect(blob.toString('utf8')).not.toContain('secreto');
    expect(decryptSession(blob, key).toString()).toBe('{"wid":"abc","token":"secreto"}');
  });
  it('IV aleatorio: dos cifrados del mismo texto difieren', () => {
    const a = encryptSession('igual', key), b = encryptSession('igual', key);
    expect(a.equals(b)).toBe(false);
    expect(a.subarray(1, 13).equals(b.subarray(1, 13))).toBe(false);
  });
  it('clave incorrecta falla', () => {
    expect(() => decryptSession(encryptSession('x', key), randomBytes(32))).toThrow(/descifrar/);
  });
  it('detecta manipulación del texto cifrado, del tag y del IV', () => {
    const blob = encryptSession('contenido importante', key);
    for (const pos of [blob.length - 1, 20, 5]) {
      const t = Buffer.from(blob); t[pos] = (t[pos] ?? 0) ^ 0x01;
      expect(() => decryptSession(t, key)).toThrow();
    }
  });
  it('el aad liga el secreto a su sesión', () => {
    const blob = encryptSession('x', key, 'sesion-A');
    expect(decryptSession(blob, key, 'sesion-A').toString()).toBe('x');
    expect(() => decryptSession(blob, key, 'sesion-B')).toThrow();
  });
  it('rechaza claves que no son de 32 bytes y blobs truncados/versión desconocida', () => {
    expect(() => encryptSession('x', randomBytes(16))).toThrow();
    expect(() => decryptSession(Buffer.alloc(10), key)).toThrow(/formato/);
    const b = encryptSession('x', key); b[0] = 9;
    expect(() => decryptSession(b, key)).toThrow(/formato/);
  });
});

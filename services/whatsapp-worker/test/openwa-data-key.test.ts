import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { openwaDataKey } from '../src/adapters/openwa.js';

/** OpenWA exige una clave base64 de 32 bytes (/^[A-Za-z0-9+/]{43}=$/). Debe ser ESTABLE entre reinicios o la sesión guardada no se puede descifrar. */
describe('clave de datos de sesión de OpenWA', () => {
  const root = randomBytes(32).toString('base64');
  it('es determinista, tiene el formato exigido por OpenWA y no repite la clave de la base', () => {
    const a = openwaDataKey({ SESSION_ENCRYPTION_KEY: root } as NodeJS.ProcessEnv); const b = openwaDataKey({ SESSION_ENCRYPTION_KEY: root } as NodeJS.ProcessEnv);
    expect(a).toBe(b); expect(a).toMatch(/^[A-Za-z0-9+/]{43}=$/); expect(Buffer.from(a!, 'base64').length).toBe(32); expect(a).not.toBe(root);
  });
  it('cambia si cambia la clave raíz; sin clave raíz no hay clave', () => {
    expect(openwaDataKey({ SESSION_ENCRYPTION_KEY: root } as NodeJS.ProcessEnv)).not.toBe(openwaDataKey({ SESSION_ENCRYPTION_KEY: randomBytes(32).toString('base64') } as NodeJS.ProcessEnv));
    expect(openwaDataKey({} as NodeJS.ProcessEnv)).toBeUndefined();
  });
});

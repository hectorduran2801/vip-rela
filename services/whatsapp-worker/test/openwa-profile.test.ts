import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OpenWaAdapter } from '../src/adapters/openwa.js';

/** Cada sesión tiene su perfil de navegador persistente; «Cerrar sesión» lo borra y no toca el de otras. */
describe('perfil persistente por sesión', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vip-profile-'));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  it('ruta propia por sesión y borrado solo de la suya', async () => {
    const a = new OpenWaAdapter('aaa', { sessionDataPath: dir }); const b = new OpenWaAdapter('bbb', { sessionDataPath: dir });
    expect(a.profileDir).not.toBe(b.profileDir);
    for (const x of [a, b]) { mkdirSync(x.profileDir, { recursive: true }); writeFileSync(join(x.profileDir, 'Cookies'), 'x'); }
    await a.wipeLocalSession();
    expect(existsSync(a.profileDir)).toBe(false); expect(existsSync(b.profileDir)).toBe(true);
  });
});

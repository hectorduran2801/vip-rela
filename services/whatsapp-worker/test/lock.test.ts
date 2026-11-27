import { mkdtempSync, readFileSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionLock, SessionLockedError } from '../src/session/lock.js';
import { OpenWaAdapter } from '../src/adapters/openwa.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'vip-lock-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('exclusión mutua de la sesión de WhatsApp', () => {
  it('una segunda instancia VIVA no puede usar la misma sesión; al liberar, sí', () => {
    const f = join(dir, 's.lock');
    const a = new SessionLock(f, process.pid); a.acquire();
    expect(readFileSync(f, 'utf8')).toBe(String(process.pid));
    const b = new SessionLock(f, process.ppid);                         // otro «proceso» vivo (el padre)
    expect(() => b.acquire()).toThrow(SessionLockedError);
    a.release(); expect(existsSync(f)).toBe(false);
    expect(() => b.acquire()).not.toThrow(); b.release();
  });
  it('un bloqueo huérfano (proceso muerto) se reemplaza; el propio también', () => {
    const f = join(dir, 's.lock'); writeFileSync(f, '999999');            // PID inexistente
    const a = new SessionLock(f); expect(() => a.acquire()).not.toThrow(); expect(readFileSync(f, 'utf8')).toBe(String(process.pid));
    expect(() => new SessionLock(f).acquire()).not.toThrow();            // reentrada del mismo proceso (reinicio dentro del proceso)
    a.release();
  });
  it('liberar no borra el bloqueo de otro', () => {
    const f = join(dir, 's.lock'); const a = new SessionLock(f, process.pid); a.acquire();
    writeFileSync(f, String(process.ppid)); a.release(); expect(existsSync(f)).toBe(true);
  });
  it('el adaptador NO lanza Chrome si otra instancia viva ya tiene la sesión (falla controlada, sin tocar sus archivos)', async () => {
    writeFileSync(join(dir, 's1.lock'), String(process.ppid));
    let launched = false;
    const a = new OpenWaAdapter('s1', { sessionDataPath: dir, childFactory: (() => { launched = true; throw new Error('no debe lanzarse'); }) as never });
    await expect(a.connect()).rejects.toBeInstanceOf(SessionLockedError);
    expect(launched).toBe(false); expect(a.getStatus()).toBe('failed'); expect(a.getLastError()).toMatch(/otra instancia/);
  });
  it('desconectar libera el bloqueo (reinicio sin dejar basura)', async () => {
    const child = { on() {}, send() {}, kill() {} };
    const a = new OpenWaAdapter('s2', { sessionDataPath: dir, childFactory: () => child as never });
    await a.connect(); expect(existsSync(join(dir, 's2.lock'))).toBe(true);
    await a.disconnect(); expect(existsSync(join(dir, 's2.lock'))).toBe(false);
  });
});

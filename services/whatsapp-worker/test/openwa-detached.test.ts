import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OpenWaAdapter } from '../src/adapters/openwa.js';
import { isUncertain } from '../src/queue/test-messages.js';

/** Si la página de WhatsApp Web se recarga por dentro, la sesión sigue «conectada» pero NINGÚN envío sale: hay que reconectar sola. */
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'vip-detached-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

async function connected(detail: string) {
  const on: Record<string, (x?: unknown) => void> = {};
  const child = {
    on(e: string, cb: (x?: unknown) => void) { on[e] = cb; },
    send(m: { t: string; id?: number }) {
      if (m.t === 'send') queueMicrotask(() => on['message']!({ t: 'send_error', id: m.id, error: 'sendText could not confirm the result.', outcome: 'unknown', detail }));
      if (m.t === 'stop') queueMicrotask(() => on['exit']!());
    },
    kill() {},
  };
  const a = new OpenWaAdapter('s1', { sessionDataPath: dir, childFactory: () => child as never });
  const seen: string[] = [];
  a.onStatus((s) => seen.push(s));
  await a.connect();
  on['message']!({ t: 'connected', phone: '50760000000' });
  return { a, seen };
}

describe('envío con la página de WhatsApp caída', () => {
  it('«detached Frame» rechaza la orden ANTES de ejecutarla: seguro que no salió (fallido, no «sin confirmar»)', async () => {
    const { a } = await connected("[puppeteer:evaluate] Attempted to use detached Frame 'ABC'.");
    const e = await a.sendText('+50760000001', 'hola').catch((x) => x);
    expect(e.outcome).toBe('not_sent');
    expect(isUncertain(e)).toBe(false);
  });
  it.each([
    "[puppeteer:evaluate] Attempted to use detached Frame 'ABC'.",
    '[puppeteer:evaluate] Protocol error (Runtime.callFunctionOn): Session closed. Most likely the page has been closed.',
  ])('deja de darse por conectada para que se reconecte: %s', async (detail) => {
    const { a, seen } = await connected(detail);
    await expect(a.sendText('+50760000001', 'hola')).rejects.toMatchObject({ outcome: detail.includes('detached Frame') ? 'not_sent' : 'unknown' });   // si pudo ejecutarse, sigue «sin confirmar»
    expect(a.getStatus()).toBe('failed');
    expect(seen).toContain('failed');
    expect(a.getLastError()).toContain('se recargó');
    await expect(a.sendText('+50760000001', 'otro')).rejects.toThrow('no conectada');
  });
  it('otro error de envío no tira la sesión', async () => {
    const { a } = await connected('[wapi] invalid chat id');
    await expect(a.sendText('+50760000001', 'hola')).rejects.toBeTruthy();
    expect(a.getStatus()).toBe('connected');
    await a.disconnect();
  });
});

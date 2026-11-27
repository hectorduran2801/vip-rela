import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { maskPhone, sanitizeError } from '../src/log.js';
import { backoffDelay } from '../src/session/backoff.js';
import { createLimit } from '../src/queue/limit.js';
import { RateLimiter } from '../src/queue/rate-limiter.js';
import { MAC_CHROME, OpenWaAdapter, resolveChromePath } from '../src/adapters/openwa.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DryRunAdapter } from '../src/adapters/dry-run.js';

describe('config (zod)', () => {
  it('dry-run por defecto y valores por defecto', () => {
    const c = loadConfig({ DATABASE_URL: 'postgres://x' });
    expect(c.WHATSAPP_DRY_RUN).toBe(true);
    expect(c.BATCH_SIZE).toBe(10);
  });
  it('WHATSAPP_ADAPTER: openwa por defecto (solo conexión); fake permitido; otro valor se rechaza', () => {
    expect(loadConfig({ DATABASE_URL: 'x' }).WHATSAPP_ADAPTER).toBe('openwa');
    expect(loadConfig({ DATABASE_URL: 'x', WHATSAPP_ADAPTER: 'fake' }).WHATSAPP_ADAPTER).toBe('fake');
    expect(() => loadConfig({ DATABASE_URL: 'x', WHATSAPP_ADAPTER: 'otro' })).toThrow(/WHATSAPP_ADAPTER/);
    expect(loadConfig({ DATABASE_URL: 'x' }).HEARTBEAT_SECONDS).toBe(10);
    expect(() => loadConfig({ DATABASE_URL: 'x', HEARTBEAT_SECONDS: '30' })).toThrow(/HEARTBEAT_SECONDS/);
  });
  it('exige DATABASE_URL', () => { expect(() => loadConfig({})).toThrow(/DATABASE_URL/); });
  it('valida la clave de cifrado (32 bytes base64) sin filtrar su valor', () => {
    const bad = 'clave-corta-secreta';
    try { loadConfig({ DATABASE_URL: 'x', SESSION_ENCRYPTION_KEY: bad }); expect.unreachable(); }
    catch (e) { expect((e as Error).message).toMatch(/SESSION_ENCRYPTION_KEY/); expect((e as Error).message).not.toContain(bad); }
    expect(loadConfig({ DATABASE_URL: 'x', SESSION_ENCRYPTION_KEY: randomBytes(32).toString('base64') }).SESSION_ENCRYPTION_KEY).toBeTruthy();
  });
  it('rechaza valores inválidos y el modo real dentro de las pruebas', () => {
    expect(() => loadConfig({ DATABASE_URL: 'x', WHATSAPP_DRY_RUN: 'tal vez' })).toThrow(/WHATSAPP_DRY_RUN/);
    expect(() => loadConfig({ DATABASE_URL: 'x', WHATSAPP_DRY_RUN: 'false', SESSION_ENCRYPTION_KEY: randomBytes(32).toString('base64') })).toThrow(/pruebas/);
    expect(() => loadConfig({ DATABASE_URL: 'x', BATCH_SIZE: '0' })).toThrow(/BATCH_SIZE/);
  });
});

describe('utilidades', () => {
  it('maskPhone y sanitizeError no dejan teléfonos completos', () => {
    expect(maskPhone('+507 6123-4567')).toBe('***4567');
    expect(sanitizeError(new Error('falló envío a +50761234567 ahora'))).not.toMatch(/6123/);
  });
  it('backoff exponencial con tope', () => {
    const o = { baseMs: 100, maxMs: 1000, jitter: 0 };
    expect([0, 1, 2, 3, 4, 10].map((a) => backoffDelay(a, o))).toEqual([100, 200, 400, 800, 1000, 1000]);
    expect(backoffDelay(1, { ...o, jitter: 0.5 }, () => 1)).toBe(300);
  });
  it('createLimit respeta la concurrencia', async () => {
    const limit = createLimit(2); let active = 0, max = 0;
    await Promise.all(Array.from({ length: 8 }, () => limit(async () => { active++; max = Math.max(max, active); await new Promise((r) => setTimeout(r, 5)); active--; })));
    expect(max).toBe(2);
  });
  it('RateLimiter separa los envíos (mensajes/minuto + jitter)', async () => {
    let t = 0; const sleeps: number[] = [];
    const rl = new RateLimiter(60, 500, () => t, async (ms) => { sleeps.push(ms); t += ms; }, () => 0.5);
    await rl.acquire(); await rl.acquire(); await rl.acquire();
    expect(sleeps).toEqual([1250, 1250]);     // 1000 ms por mensaje + 250 de jitter
  });
});

describe('adaptadores', () => {
  /** Doble del proceso hijo: guarda lo enviado por IPC y permite emitir mensajes/salidas. */
  const fakeChild = () => {
    const h: Record<string, Array<(...a: any[]) => void>> = {};
    const sent: any[] = [];
    const child = {
      sent, killed: [] as string[],
      send: (m: any) => { sent.push(m); if (m.t === 'stop') setTimeout(() => (h.exit ?? []).forEach((f) => f(0, null)), 0); },
      kill: (sig?: string) => { child.killed.push(sig ?? 'SIGTERM'); },
      on: (ev: string, cb: (...a: any[]) => void) => { (h[ev] ??= []).push(cb); },
      emit: (ev: string, ...a: any[]) => (h[ev] ?? []).forEach((f) => f(...a)),
    };
    return child;
  };

  it('OpenWaAdapter: IPC con el hijo recorre starting → qr_pending → awaiting_scan → connecting → connected y envía con chatId', async () => {
    const c = fakeChild();
    const a = new OpenWaAdapter('s1', { childFactory: () => c as any, sessionDataPath: join(tmpdir(), `vip-ow-${process.pid}`), executablePath: '/x/chrome' });
    const seen: string[] = []; a.onStatus((s) => seen.push(s));
    const qr = vi.fn(); a.onQr(qr);
    await a.connect();
    expect(c.sent[0]).toMatchObject({ t: 'start', opts: { sessionId: 's1', executablePath: '/x/chrome', headless: true } });
    c.emit('message', { t: 'status', status: 'qr_pending' });
    c.emit('message', { t: 'qr', qr: 'QR-REAL' });
    c.emit('message', { t: 'status', status: 'connecting' });
    expect(a.getStatus()).toBe('connecting');                     // nunca "connected" sin confirmación
    c.emit('message', { t: 'connected', phone: '+50761234567' });
    expect(seen).toEqual(['starting', 'qr_pending', 'awaiting_scan', 'connecting', 'connected']);
    expect(qr).toHaveBeenCalledWith('QR-REAL');
    expect(a.getPhoneNumber()).toBe('+50761234567');
    const p = a.sendText('+507 6123-4567', 'hola');
    expect(c.sent.at(-1)).toMatchObject({ t: 'send', chatId: '50761234567@c.us', body: 'hola' });
    c.emit('message', { t: 'sent', id: c.sent.at(-1).id, messageId: 'id1' });
    expect((await p).messageId).toBe('id1');
    await a.disconnect();
    expect(a.getStatus()).toBe('disconnected'); expect(a.getPhoneNumber()).toBeNull();
    expect(c.sent.at(-1)).toEqual({ t: 'stop' });
  });

  it('OpenWaAdapter: error del cliente => failed con el motivo; caída del hijo => failed; sendText sin conexión rechaza', async () => {
    const c = fakeChild();
    const a = new OpenWaAdapter('s1', { childFactory: () => c as any, sessionDataPath: join(tmpdir(), `vip-ow-${process.pid}`) });
    await expect(a.sendText('+5071', 'x')).rejects.toThrow(/no conectada/);
    await a.connect();
    c.emit('message', { t: 'error', error: 'No se encontró Chrome en /x' });
    expect(a.getStatus()).toBe('failed'); expect(a.getLastError()).toBe('No se encontró Chrome en /x');
    const c2 = fakeChild();
    const b = new OpenWaAdapter('s2', { childFactory: () => c2 as any, sessionDataPath: join(tmpdir(), `vip-ow-${process.pid}`) });
    await b.connect(); c2.emit('message', { t: 'connected', phone: null });
    const pend = b.sendText('+50761234567', 'x'); pend.catch(() => undefined);
    c2.emit('exit', null, 'SIGKILL');                               // Chrome/hijo muertos
    expect(b.getStatus()).toBe('failed'); expect(b.getLastError()).toMatch(/terminó inesperadamente/);
    await expect(pend).rejects.toThrow();
  });

  it('resolveChromePath: CHROME_PATH manda; si no, Chrome de macOS solo si existe', () => {
    expect(resolveChromePath({ CHROME_PATH: '/otro' } as any, () => true)).toBe('/otro');
    expect(resolveChromePath({} as any, () => true)).toBe(MAC_CHROME);
    expect(resolveChromePath({} as any, () => false)).toBeUndefined();
  });
  it('DryRunAdapter devuelve éxito simulado y no guarda el cuerpo', async () => {
    const d = new DryRunAdapter(); await d.connect();
    const r = await d.sendText('+50761234567', 'texto secreto');
    expect(r.simulated).toBe(true);
    expect(JSON.stringify(d.sent)).not.toContain('secreto');
    expect(JSON.stringify(d.sent)).not.toContain('61234567');
  });
});

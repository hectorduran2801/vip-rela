import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newDb, type Db } from './support/harness.js';
import { realFake } from './support/fixtures.js';
import { OpenWaAdapter } from '../src/adapters/openwa.js';
import { DryRunAdapter } from '../src/adapters/dry-run.js';
import type { FakeAdapter } from '../src/adapters/fake.js';
import { Db as WorkerDb } from '../src/db.js';
import { silentLogger } from '../src/log.js';
import { TestMessageProcessor } from '../src/queue/test-messages.js';

/** «Conectado» no basta: antes de enviar se comprueba que WhatsApp responde, y mientras reconecta no se gasta la cola. */
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'vip-health-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

async function openwa(pong: ((id: number) => Record<string, unknown>) | null) {
  const on: Record<string, (x?: unknown) => void> = {};
  const child = { on(e: string, cb: (x?: unknown) => void) { on[e] = cb; }, kill() {},
    send(m: { t: string; id?: number }) { if (m.t === 'ping' && pong) queueMicrotask(() => on['message']!(pong(m.id!))); if (m.t === 'stop') queueMicrotask(() => on['exit']!()); } };
  const a = new OpenWaAdapter('s1', { sessionDataPath: dir, childFactory: () => child as never, pingTimeoutMs: 40 } as never);
  await a.connect(); on['message']!({ t: 'connected', phone: '50760000000' });
  return a;
}

describe('comprobación de que WhatsApp responde', () => {
  it('responde: sigue conectada', async () => {
    const a = await openwa((id) => ({ t: 'pong', id, ok: true }));
    expect(await a.ping()).toBe(true); expect(a.getStatus()).toBe('connected'); await a.disconnect();
  });
  it('página caída o sin respuesta: deja de darse por conectada', async () => {
    const dead = await openwa((id) => ({ t: 'pong', id, ok: false, error: "Attempted to use detached Frame 'X'." }));
    expect(await dead.ping()).toBe(false); expect(dead.getStatus()).toBe('failed');
    const mute = await openwa(null);
    expect(await mute.ping()).toBe(false); expect(mute.getStatus()).toBe('failed');
  });
  it('otro error de la consulta no tira la sesión', async () => {
    const a = await openwa((id) => ({ t: 'pong', id, ok: false, error: 'wapi: otra cosa' }));
    expect(await a.ping()).toBe(true); expect(a.getStatus()).toBe('connected'); await a.disconnect();
  });
});

describe('cola de mensajes con WhatsApp enfermo', () => {
  let db: Db; let wdb: WorkerDb; let n = 0;
  beforeEach(async () => { db = await newDb(); wdb = new WorkerDb(db.connection, 3); });
  afterEach(async () => { await wdb.close(); await db.close(); });
  const create = () => db.as(db.admin, (q) => q.one(`select * from public.create_test_message($1,$2,'real',$3,'Propietario','0001')`, ['+507 6000-0001', 'hola', `h-${++n}-${Math.random()}`]));
  const status = async (id: string) => (await db.su.query(`select status, error from public.whatsapp_test_messages where id=$1`, [id])).rows[0];
  const make = (real: FakeAdapter, recovering: () => boolean) => new TestMessageProcessor({ db: wdb, log: silentLogger(), dryRunAdapter: new DryRunAdapter(), dryRun: false,
    senders: { senderFor: () => real, anyConnected: () => true, recovering }, realTestEnabled: true });

  it('si no responde, no intenta enviar: queda «fallido» (reintentable) con un motivo claro', async () => {
    const real = await realFake(); (real as unknown as { ping: () => Promise<boolean> }).ping = async () => false;
    const m = await create();
    await make(real, () => false).tick();
    expect(real.calls).toHaveLength(0);
    expect(await status(m.id)).toMatchObject({ status: 'failed', error: expect.stringContaining('Reintentar') });
  });
  it('mientras reconecta, los demás esperan en cola y salen después', async () => {
    const real = await realFake(); let down = true;
    const m = await create(); const proc = make(real, () => down);
    expect(await proc.tick()).toBeNull();
    expect((await status(m.id)).status).toBe('prepared');
    down = false;
    expect(await proc.tick()).toMatchObject({ id: m.id, status: 'sent' });
  });
});

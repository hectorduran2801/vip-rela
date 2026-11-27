import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newDb, type Db } from './support/harness.js';
import { Db as WorkerDb } from '../src/db.js';

let db: Db; const open: WorkerDb[] = [];
beforeEach(async () => { db = await newDb(); });
afterEach(async () => { await Promise.all(open.splice(0).map((w) => w.close().catch(() => undefined))); await db.close(); });

describe('resiliencia de la conexión del worker', () => {
  it('si se corta la conexión en medio de una transacción, falla ESA consulta pero el proceso NO se cae (antes: «Unhandled error event» → worker muerto)', async () => {
    const w = new WorkerDb(db.connection, 2); open.push(w);
    await expect(w.tx(async (q) => {
      const pid = (await q.one<{ p: number }>(`select pg_backend_pid() p`)).p;
      await db.su.query(`select pg_terminate_backend($1)`, [pid]);
      await new Promise((r) => setTimeout(r, 200));
      return q.rows(`select 1`);
    })).rejects.toBeTruthy();
    // el pool se recupera: la siguiente transacción funciona con una conexión nueva
    expect((await w.tx((q) => q.one<{ n: number }>(`select 1 as n`))).n).toBe(1);
  });
  it('una conexión inactiva que el servidor cierra tampoco tumba el proceso', async () => {
    const w = new WorkerDb(db.connection, 2); open.push(w);
    const pid = await w.tx((q) => q.one<{ p: number }>(`select pg_backend_pid() p`)).then((r) => r.p);
    await db.su.query(`select pg_terminate_backend($1)`, [pid]); await new Promise((r) => setTimeout(r, 200));
    expect((await w.tx((q) => q.one<{ n: number }>(`select 2 as n`))).n).toBe(2);
  });
});

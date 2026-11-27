import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newDb, type Db } from '@vip/db/testing';
import { createDatabase, type Database } from './db.js';

let db: Db, pool: pg.Pool, database: Database;
let sent: string[] = [];

beforeAll(async () => {
  db = await newDb();
  pool = new pg.Pool({ ...db.connection, max: 1 });          // una sola conexión: lo que quede de una petición se vería en la siguiente
  pool.on('connect', (c) => {
    const query = c.query.bind(c) as (...a: unknown[]) => unknown;
    (c as unknown as { query: (...a: unknown[]) => unknown }).query = (...a) => { sent.push(String(a[0])); return query(...a); };
  });
  database = createDatabase(pool);
});
afterAll(async () => { await database.close(); await db.close(); });

const who = `select current_user u, current_setting('request.jwt.claims', true) c`;

describe('conexión de la API', () => {
  it('abre la transacción, fija el rol y la identidad en un solo viaje a la base', async () => {
    sent = [];
    await database.asUser(db.admin, (q) => q.one('select 1'));
    expect(sent).toHaveLength(3);                           // preparación, consulta y commit
  });

  it('la consulta corre como el usuario y nada queda en la conexión', async () => {
    const inside = await database.asUser(db.admin, (q) => q.one(who));
    expect(inside.u).toBe('authenticated');
    expect(JSON.parse(inside.c)).toEqual({ sub: db.admin, role: 'authenticated' });
    const after = (await pool.query(who)).rows[0];
    expect(after.u).not.toBe('authenticated');
    expect(after.c || '').toBe('');
  });

  it('el servicio corre como service_role y tampoco deja rastro', async () => {
    const inside = await database.asService!((q) => q.one(who));
    expect(inside.u).toBe('service_role');
    expect((await pool.query(who)).rows[0].u).not.toBe('service_role');
  });

  it('un identificador con comillas o barras llega como texto, no como SQL', async () => {
    const evil = `x'; reset role; select '\\`;
    const inside = await database.asUser(evil, (q) => q.one(who));
    expect(inside.u).toBe('authenticated');
    expect(JSON.parse(inside.c).sub).toBe(evil);
  });

  it('si falla la consulta se revierte y la conexión sigue sirviendo', async () => {
    await expect(database.asUser(db.admin, (q) => q.one('select 1/0'))).rejects.toThrow(/division by zero/);
    expect((await database.asUser(db.admin, (q) => q.one('select 2 n'))).n).toBe(2);
  });
});

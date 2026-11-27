import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newDb, type Db } from './harness.js';
// @ts-expect-error módulo .mjs sin tipos
import { applyMigrations, preflight } from '../../../scripts/db-apply/lib.mjs';

let db: Db;
const open: pg.Client[] = [];
const client = async () => { const c = new pg.Client(db.connection); await c.connect(); open.push(c); return c; };
const exists = async (t: string) => (await db.su.query('select to_regclass($1) is not null ok', [`public.${t}`])).rows[0].ok as boolean;

beforeAll(async () => { db = await newDb(); await db.su.query('create table public.busy_table (id int)'); });
afterAll(async () => { await Promise.all(open.map((c) => c.end())); await db.close(); });

describe('aplicación segura de migraciones', () => {
  it('aplica todos los archivos juntos', async () => {
    const r = await applyMigrations(await client(), [{ name: 'a', sql: 'create table public.ok_a (id int)' }, { name: 'b', sql: 'create table public.ok_b (id int)' }]);
    expect(r.applied).toEqual(['a', 'b']);
    expect([await exists('ok_a'), await exists('ok_b')]).toEqual([true, true]);
  });

  it('si uno falla no queda nada a medias', async () => {
    await expect(applyMigrations(await client(), [{ name: 'a', sql: 'create table public.half (id int)' }, { name: 'b', sql: 'select 1/0' }])).rejects.toThrow(/b: division by zero/);
    expect(await exists('half')).toBe(false);
  });

  it('no espera indefinidamente un bloqueo: abandona y revierte', async () => {
    const holder = await client();
    await holder.query('begin'); await holder.query('lock table public.busy_table in access exclusive mode');
    const t = Date.now();
    await expect(applyMigrations(await client(), [{ name: 'a', sql: 'create table public.waited (id int)' }, { name: 'b', sql: 'alter table public.busy_table add column x int' }], { lockTimeoutMs: 300 })).rejects.toThrow(/lock timeout/);
    expect(Date.now() - t).toBeLessThan(5000);
    expect(await exists('waited')).toBe(false);
    await holder.query('rollback');
  });

  it('limita el tiempo que puede retener los bloqueos', async () => {
    await expect(applyMigrations(await client(), [{ name: 'lenta', sql: 'create table public.slow (id int); select pg_sleep(5)' }], { statementTimeoutMs: 300 })).rejects.toThrow(/statement timeout/);
    expect(await exists('slow')).toBe(false);
  });

  it('se puede cancelar desde fuera y revierte', async () => {
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 400);
    await expect(applyMigrations(await client(), [{ name: 'larga', sql: 'create table public.cancelled (id int); select pg_sleep(20)' }], { signal: stop.signal, connect: client })).rejects.toThrow(/cancel/);
    expect(await exists('cancelled')).toBe(false);
  });

  it('la revisión previa detecta una transacción abierta que estorbaría', async () => {
    const other = await client();
    await other.query('begin'); await other.query('select * from public.busy_table');
    await new Promise((r) => setTimeout(r, 1200));
    expect((await preflight(await client(), { maxTxSeconds: 1 })).join(' ')).toMatch(/transacción/);
    await other.query('rollback');
    expect(await preflight(await client(), { maxTxSeconds: 1 })).toEqual([]);
  });
});

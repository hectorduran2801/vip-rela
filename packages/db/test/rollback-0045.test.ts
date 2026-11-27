import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { connConfig, MIGRATIONS_DIR, STUB_SQL } from './pg-cluster.js';

/** La reversión de 0045 conserva los datos y devuelve el esquema anterior. Se prueba sobre el estado REAL del remoto (migraciones hasta 0045). */
let c: pg.Client;
beforeAll(async () => {
  const cl = inject('pgCluster'); const name = `rb_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const admin = new pg.Client(connConfig(cl, 'postgres')); await admin.connect(); await admin.query(`create database ${name}`); await admin.end();
  c = new pg.Client(connConfig(cl, name)); await c.connect();
  await c.query(readFileSync(STUB_SQL, 'utf8'));
  for (const f of readdirSync(MIGRATIONS_DIR).filter((x) => x.endsWith('.sql') && x <= '20261116004500_z').sort()) await c.query(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'));
}, 120_000);
afterAll(async () => { await c.end(); });

describe('reversión de 0045', () => {
  it('quita la separación sin perder filas', async () => {
    await c.query(`insert into public.units(code) values ('RB-1')`);
    await c.query(readFileSync(new URL('../../../supabase/rollback/0045_accounts_down.sql', import.meta.url), 'utf8'));
    expect((await c.query(`select count(*)::int n from public.units where code='RB-1'`)).rows[0].n).toBe(1);
    expect((await c.query(`select count(*)::int n from information_schema.columns where table_schema='public' and column_name='account_id'`)).rows[0].n).toBe(0);
    expect((await c.query(`select count(*)::int n from pg_proc p join pg_roles r on r.oid=p.proowner where r.rolname='vip_app'`)).rows[0].n).toBe(0);
    await expect(c.query(`insert into public.units(code) values ('rb-1')`)).rejects.toThrow();                       // vuelve el único global
  });
});

import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newDb, type Db } from './harness.js';

/** La reversión de 0053 y 0052 devuelve las políticas anteriores y quita lo añadido, sin tocar datos. */
let db: Db;
beforeAll(async () => { db = await newDb(); }, 120_000);
afterAll(async () => { await db.close(); });
const sql = (f: string) => readFileSync(new URL(`../../../supabase/rollback/${f}`, import.meta.url), 'utf8');

describe('reversión de 0052 y 0053', () => {
  it('conserva los datos, restaura las políticas y elimina el resumen', async () => {
    await db.driverWithAssignment({ code: 'RBK1', unit: 'RBK-1', dailyCents: 3000 });
    await db.su.query(sql('0053_query_performance_down.sql'));
    const left = (await db.su.query(`select count(*)::int n from pg_policies where policyname like 'tenant%' and (coalesce(qual,'') like '%SELECT app_private%' or coalesce(with_check,'') like '%SELECT app_private%') and tablename not like 'collection_summary%'`)).rows[0].n;
    expect(left).toBe(0);
    await db.su.query(sql('0052_collection_summary_down.sql'));
    expect((await db.su.query(`select to_regprocedure('public.collection_summary_rows(date)') is null a, to_regclass('public.collection_summary') is null b`)).rows[0]).toEqual({ a: true, b: true });
    expect((await db.su.query(`select count(*)::int n from public.units where code='RBK-1'`)).rows[0].n).toBe(1);
    expect((await db.as(db.opsAdmin, (q) => q.one(`select count(*)::int n from public.drivers`))).n).toBeGreaterThan(0);
    expect(await db.as(db.outsider, (q) => q.rows(`select * from public.drivers`))).toEqual([]);
    await db.su.query(`update public.units set code = code`);                                      // sin disparadores huérfanos
  });
});

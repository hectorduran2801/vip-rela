import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newDb, type Db } from './harness.js';

let db: Db;
beforeAll(async () => { db = await newDb(); });
afterAll(async () => { await db.close(); });

describe('esquema de instancia única', () => {
  it('se aplica completo en PostgreSQL real y no quedan rastros de organizaciones', async () => {
    const t = (await db.su.query(`select table_name from information_schema.tables where table_schema='public'`)).rows.map((r) => r.table_name);
    expect(t.length).toBeGreaterThan(20);
    expect(t).not.toContain('organizations'); expect(t).not.toContain('organization_members');
    const cols = (await db.su.query(`select table_name, column_name from information_schema.columns where table_schema='public' and column_name = 'organization_id'`)).rows;
    expect(cols).toEqual([]);
    // Roles internos SIN organizaciones: exactamente SUPER_ADMIN, ADMIN y SUPERVISOR
    const roles = (await db.su.query(`select enumlabel from pg_enum e join pg_type t on t.oid=e.enumtypid where t.typname='app_role' order by e.enumsortorder`)).rows.map((r) => r.enumlabel);
    expect(roles).toEqual(['super_admin', 'admin', 'supervisor']);
  });
});

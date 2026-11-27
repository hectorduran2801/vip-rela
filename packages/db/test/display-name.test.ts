import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newDb, type Db, type Q } from './harness.js';

/** 0042: cada cuenta gestiona su propio nombre para mostrar. */
let db: Db;
beforeAll(async () => { db = await newDb(); }, 120_000);
afterAll(async () => { await db.close(); });
const as = <T>(who: string, fn: (q: Q) => Promise<T>) => db.as(who, fn);

describe('nombre para mostrar', () => {
  it('cada quien guarda y lee solo el suyo (con espacios normalizados) y queda auditado', async () => {
    await as(db.opsAdmin, (q) => q.rows(`select public.set_my_display_name('  Vanessa   Ejemplo ')`));
    expect((await as(db.opsAdmin, (q) => q.one(`select public.get_my_display_name() n`))).n).toBe('Vanessa Ejemplo');
    expect((await as(db.admin, (q) => q.one(`select public.get_my_display_name() n`))).n).not.toBe('Vanessa Ejemplo');
    await as(db.supervisor, (q) => q.rows(`select public.set_my_display_name('Ana')`));                    // cualquier rol con acceso
    expect((await db.su.query(`select count(*)::int n from public.audit_logs where action='profile.name_changed'`)).rows[0].n).toBe(2);
  });
  it('máximo 60 caracteres; sin sesión o sin rol no se puede', async () => {
    expect(await as(db.opsAdmin, (q) => q.fails(`select public.set_my_display_name(repeat('a', 61))`))).toBe('invalid_name');
    expect(await db.asAnon((q) => q.fails(`select public.get_my_display_name()`))).toMatch(/permission denied/);
  });
});

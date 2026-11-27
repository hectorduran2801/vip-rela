import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error módulo .mjs sin tipos
import { compare, inventory } from '../../../scripts/db-check/lib.mjs';
import { newDb, type Db } from './harness.js';
import { MIGRATIONS_DIR } from './pg-cluster.js';

/** El manifiesto es lo que se compara contra producción antes de habilitar una versión: debe salir SIEMPRE de las migraciones. */
const FILE = join(MIGRATIONS_DIR, '../schema-manifest.json');
let db: Db; let actual: Record<string, string>;
beforeAll(async () => { db = await newDb({ arming: true, strictMoney: true }); actual = await inventory(db.su); }, 120_000);
afterAll(async () => { await db.close(); });

describe('manifiesto del esquema', () => {
  it('coincide con las migraciones (si añadió una: UPDATE_SCHEMA_MANIFEST=1 npx vitest run test/schema-manifest.test.ts)', () => {
    if (process.env.UPDATE_SCHEMA_MANIFEST) writeFileSync(FILE, `${JSON.stringify(actual, null, 1)}\n`);
    expect(JSON.parse(readFileSync(FILE, 'utf8'))).toEqual(actual);
  });
  it('detecta una función ausente (como la 0023) y una desactualizada; lo que sobre no cuenta', () => {
    const expected = { 'fn a()': '1', 'fn b()': '2' };
    expect(compare(expected, { 'fn b()': 'otra', 'fn extra()': '9' })).toEqual({ missing: ['fn a()'], different: ['fn b()'] });
    expect(compare(expected, { ...expected, 'fn extra()': '9' })).toEqual({ missing: [], different: [] });
  });
});

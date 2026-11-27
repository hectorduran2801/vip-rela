import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newDb, type Db } from '@vip/db/testing';
import { confirmImport, previewImport, stageImport } from '../src/index.js';
import { buildDirectoryFile, buildMultiBlock } from './fixture.js';

/**
 * Decisión del dueño: operario/cédula faltantes ya no son errores (son «Requiere revisión»). La unidad se importa SIEMPRE que exista,
 * sin conductor ni asignación inventados; el conductor queda PENDIENTE DE REVISIÓN. Una advertencia nunca autoriza datos inválidos.
 */
let db: Db;
const count = async (t: string) => Number((await db.su.query(`select count(*) n from public.${t}`)).rows[0].n);
const stg = (f: Buffer, name = 'f.xlsx') => db.as(db.opsAdmin, (q) => stageImport(q, { userId: db.opsAdmin }, f, name));
const clean = (id: string) => db.as(db.opsAdmin, (q) => confirmImport(q, { userId: db.opsAdmin }, id, { approve: 'clean' }));
const applyDir = (id: string) => db.as(db.opsAdmin, async (q) => (await q.one(`select public.apply_directory_import($1, '2026-03-02'::date, 'active', false) r`, [id])).r);
const applyCob = (id: string) => db.as(db.opsAdmin, async (q) => (await q.one(`select public.apply_import($1, '2026-03-02'::date, 'active', 'skip') r`, [id])).r);
const rowOf = async (col: string, v: string) => (await db.su.query(`select applied_action a, applied_note n, driver_review dr from public.import_rows where ${col}=$1 order by source_row limit 1`, [v])).rows[0];

beforeAll(async () => {
  db = await newDb();
  await db.driverWithAssignment({ code: 'EX1', unit: 'UEX1', dailyCents: 3600, phone: '+50760000001' });
  await db.driverWithAssignment({ code: 'EX2', unit: 'UEX2' });
});
afterAll(async () => { await db.close(); });

const H = ['Unidad', 'Código de operador', 'Nombre', 'Apellido', 'Cédula', 'WhatsApp', 'Tarifa diaria', 'Estado'];
const DIR = [
  ['PU1', 'OP-A', 'Ana', null, null, null, 36, null],          // unidad + operario sin cédula
  ['PU2', null, 'Beto', null, 'ID-B', null, null, null],       // unidad + cédula sin operario
  ['PU3', null, null, null, null, null, null, null],           // solo unidad
  [null, 'OP-C', 'Carl', null, 'ID-C', null, null, null],      // sin unidad: error, no se aprueba con clean
  ['PU5', 'OP-DUP', 'Dup', null, 'ID-D1', null, null, null],  // operario duplicado en el bloque
  ['PU6', 'OP-DUP', 'Dup', null, 'ID-D2', null, null, null],
  ['UEX1', 'EX1', null, null, null, null, null, null],         // existente por operario: se concilia, sin cédula en el Excel
  ['UEX2', null, null, null, 'ID-EX2', null, null, null],      // existente por cédula: se concilia, sin operario en el Excel
];

describe('plantilla: conductor incompleto = unidad sí, conductor pendiente de revisión', () => {
  let file: Buffer; let importId: string;
  it('vista previa pura: faltantes no son error; hay contador de pendientes; sin unidad sí es error', async () => {
    file = await buildDirectoryFile(DIR, H);
    const dir = { drivers: [
      { id: 'd1', operatorCode: 'EX1', nationalId: 'ID-EX1', firstName: 'Conductor', lastName: 'EX1', phoneE164: null, status: 'active' },
      { id: 'd2', operatorCode: 'EX2', nationalId: 'ID-EX2', firstName: 'Conductor', lastName: 'EX2', phoneE164: null, status: 'active' }],
      units: ['UEX1', 'UEX2'], assignments: [{ driverId: 'd1', unitCode: 'UEX1', dailyRateCents: 3600 }, { driverId: 'd2', unitCode: 'UEX2', dailyRateCents: null }] };
    const p = await previewImport(file, 'd.xlsx', { directory: dir });
    const rows = p.blocks.flatMap((b) => b.rows);
    const byUnit = (u: string) => rows.find((r) => r.unitCode === u)!;
    expect(byUnit('PU1').warnings).toContain('missing_national_id');
    expect(byUnit('PU1').changes?.driver).toEqual({ action: 'pending_review', reasons: ['missing_national_id'] });
    expect(byUnit('PU1').changes?.assignment?.action).toBe('none');
    expect(byUnit('PU2').changes?.driver).toEqual({ action: 'pending_review', reasons: ['missing_operator'] });
    expect(byUnit('PU3').warnings).toContain('unit_without_driver');
    expect(byUnit('UEX1').changes?.driver?.action).toBe('unchanged');   // conciliado con lo existente
    expect(byUnit('UEX2').changes?.driver?.action).toBe('unchanged');
    expect(p.summary).toMatchObject({ driversPendingReview: 2, errors: 1, duplicates: 2, drivers: { new: 1, existing: 2 } });   // new:1 = la fila SIN unidad (error: no se aprueba)
  });

  it("stage + confirm 'clean': aprueba las filas de unidad incompletas (PU1, PU2, PU3 y las existentes); no el duplicado ni la fila sin unidad", async () => {
    const r = await stg(file); importId = r.importId;
    expect(r.summary.driversPendingReview).toBe(2);
    const c = await clean(importId);
    expect(c.approvedRows).toBe(5);
    const appr = (await db.su.query(`select unit_code from public.import_rows where review_status='approved' order by unit_code`)).rows.map((x) => x.unit_code);
    expect(appr).toEqual(['PU1', 'PU2', 'PU3', 'UEX1', 'UEX2']);
  });

  it('apply_directory_import: crea las 3 unidades, NINGÚN conductor ni asignación ni tarifa; trazabilidad por fila y contadores', async () => {
    const before = { d: await count('drivers'), a: await count('assignments'), r: await count('rates') };
    const res = await applyDir(importId);
    expect(res).toMatchObject({ drivers_created: 0, drivers_pending_review: 2, units_created: 3, units_without_driver_created: 3, units_without_driver: 3, assignments_created: 0, rates_created: 0, rows_rejected: 0 });
    expect(res.issues.filter((i: { issue: string }) => i.issue === 'driver_pending_review').map((i: any) => i.reasons[0]).sort()).toEqual(['missing_national_id', 'missing_operator']);
    expect({ d: await count('drivers'), a: await count('assignments'), r: await count('rates') }).toEqual(before);   // nada inventado
    expect((await db.su.query(`select code from public.units where code like 'PU%' order by 1`)).rows.map((x) => x.code)).toEqual(['PU1', 'PU2', 'PU3']);
    expect(await rowOf('unit_code', 'PU1')).toMatchObject({ a: 'linked', dr: ['missing_national_id'] });
    expect((await rowOf('unit_code', 'PU1')).n).toMatch(/conductor pendiente de revisión: falta cédula.*tarifa no se aplicó/);
    expect(await rowOf('unit_code', 'PU2')).toMatchObject({ a: 'linked', dr: ['missing_operator'] });
    expect((await rowOf('unit_code', 'PU2')).n).toMatch(/falta código de operario/);
    expect(await rowOf('unit_code', 'PU3')).toMatchObject({ a: 'linked', n: 'unidad sin conductor', dr: null });
    expect(await count('drivers')).toBe(2);
    expect((await db.su.query(`select count(*)::int n from public.drivers where operator_code in ('OP-A','OP-DUP','OP-C') or national_id in ('ID-B','ID-C')`)).rows[0].n).toBe(0);
    expect((await rowOf('operator_code', 'OP-DUP')).a).toBe('excluded');   // duplicado: no aprobado, no se aplica
    expect((await db.su.query(`select applied_action a from public.import_rows where operator_code='OP-C'`)).rows[0].a).toBe('excluded');   // sin unidad
  });

  it('el conductor existente se concilia SIN sobrescribir (nombre, teléfono, unidad y tarifa intactos)', async () => {
    const d = (await db.su.query(`select first_name, phone_e164 from public.drivers where operator_code='EX1'`)).rows[0];
    expect(d).toEqual({ first_name: 'Conductor', phone_e164: '+50760000001' });
    expect((await db.su.query(`select rt.daily_amount_cents::int c from public.rates rt join public.assignments a on a.id=rt.assignment_id join public.drivers dr on dr.id=a.driver_id where dr.operator_code='EX1' and rt.valid_to is null`)).rows[0].c).toBe(3600);
    expect(await rowOf('unit_code', 'UEX1')).toMatchObject({ a: 'linked', dr: null });
  });

  it('reimportar (otro archivo con las mismas filas) no duplica unidades ni crea conductores', async () => {
    const f2 = await buildDirectoryFile([...DIR.slice(0, 3), ['PU9', null, null, null, null, null, null, null]], H);
    const r = await stg(f2, 'otra.xlsx');
    await clean(r.importId);
    const res = await applyDir(r.importId);
    expect(res).toMatchObject({ units_created: 1, drivers_created: 0, drivers_pending_review: 2, assignments_created: 0 });
    expect(await count('units')).toBe(6);        // UEX1, UEX2, PU1..3 + PU9
    expect(await count('drivers')).toBe(2);
  });

  it('SQL: aunque se apruebe a mano, una fila sin unidad con conductor incompleto se rechaza; un duplicado aprobado a mano no crea nada', async () => {
    const f = await buildDirectoryFile([[null, 'OP-Q', 'Quin', null, null, null, null, null], ['PQ1', 'OP-R', 'Rita', null, 'ID-R', null, null, null], ['PQ2', 'OP-R', 'Rita', null, 'ID-R2', null, null, null]], H);
    const r = await stg(f, 'manual.xlsx');
    const ids = (await db.su.query(`select r.id from public.import_rows r join public.import_blocks b on b.id=r.block_id where b.import_id=$1`, [r.importId])).rows.map((x) => x.id);
    await db.as(db.opsAdmin, (q) => confirmImport(q, { userId: db.opsAdmin }, r.importId, { approve: ids }));
    const res = await applyDir(r.importId);
    expect(res).toMatchObject({ drivers_created: 0, drivers_pending_review: 0, rows_rejected: 3, units_created: 0 });
    expect(await count('drivers')).toBe(2);
  });
});

describe('cobranza: operario/cédula faltantes ya no bloquean; unidad sí, conductor no', () => {
  it("preview: no son error; 'clean' aprueba; duplicado de operario en el bloque sigue bloqueando", async () => {
    const f = await buildMultiBlock([[
      ['CU1', 'OPX', null, 'Xavi X', 30], ['CU2', null, 'ID-Y', null, 30], ['CU3', null, null, null, 30],
      ['CU4', 'OPD', 'ID-D1', 'Dani D', 30], ['CU5', 'OPD', 'ID-D2', 'Dani D', 30], ['CU6', 'OPOK', 'ID-OK', 'Olga', 31],
    ]]);
    const p = await previewImport(f, 'c.xlsx');
    expect(p.summary).toMatchObject({ kind: 'cobranza', errors: 0, driversPendingReview: 2 });
    const r = await stg(f, 'cob.xlsx');
    const c = await clean(r.importId);
    const ap = (await db.su.query(`select unit_code from public.import_rows r join public.import_blocks b on b.id=r.block_id where b.import_id=$1 and review_status='approved' order by unit_code`, [r.importId])).rows.map((x) => x.unit_code);
    expect(ap).toEqual(['CU1', 'CU2', 'CU3', 'CU6']);        // CU4/CU5: duplicate_operator_in_block no se aprueban
    expect(c.approvedRows).toBe(4);
    const res = await applyCob(r.importId);
    expect(res).toMatchObject({ drivers_created: 1, drivers_pending_review: 2, units_created: 4, assignments_created: 1, rates_created: 1 });
    expect((await db.su.query(`select operator_code from public.drivers where operator_code in ('OPX','OPD','OPOK')`)).rows.map((x) => x.operator_code)).toEqual(['OPOK']);
    expect(await count('drivers')).toBe(3);                    // EX1, EX2, OPOK
    expect((await db.su.query(`select count(*)::int n from public.units where code in ('CU1','CU2','CU3','CU6')`)).rows[0].n).toBe(4);
    expect((await db.su.query(`select count(*)::int n from public.units where code in ('CU4','CU5')`)).rows[0].n).toBe(0);
    expect(await rowOf('unit_code', 'CU1')).toMatchObject({ dr: ['missing_national_id'] });
    expect((await rowOf('unit_code', 'CU1')).n).toMatch(/pendiente de revisión: falta cédula/);
    expect(await rowOf('unit_code', 'CU2')).toMatchObject({ a: 'linked', dr: ['missing_operator'] });
    expect((await rowOf('unit_code', 'CU2')).n).toMatch(/falta código de operario/);
    expect(await rowOf('unit_code', 'CU3')).toMatchObject({ a: 'linked', dr: null });
    expect(await count('assignments')).toBe(3);               // las 2 previas + OPOK; ninguna para las incompletas
  });
});

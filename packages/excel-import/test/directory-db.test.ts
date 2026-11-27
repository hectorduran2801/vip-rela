import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newDb, type Db } from '@vip/db/testing';
import { buildDirectoryTemplate, confirmImport, listImportRows, loadDirectory, stageImport } from '../src/index.js';
import { buildDirectoryFile, buildMultiBlock, fillTemplate } from './fixture.js';

let db: Db;
const count = async (t: string) => Number((await db.su.query(`select count(*) n from ${t.includes('.') ? t : 'public.' + t}`)).rows[0].n);
const money = async () => ({ charges: await count('charges'), payments: await count('payments'), allocations: await count('payment_allocations'), adjustments: await count('adjustments') });
const apply = (imp: string, flag = false, from = '2026-03-02') =>
  db.as(db.opsAdmin, async (q) => (await q.one(`select public.apply_directory_import($1, $2::date, 'active', $3) r`, [imp, from, flag])).r);

beforeAll(async () => {
  db = await newDb();
  await db.driverWithAssignment({ code: 'E1', unit: 'UE1', dailyCents: 3600, phone: '+50760000000' });
  await db.driverWithAssignment({ code: 'E2', unit: 'UE2' });
  await db.driverWithAssignment({ code: 'E3', unit: 'UE3', dailyCents: 3000 });
  await db.su.query(`update public.drivers set first_name='Vieja', last_name='Nombre' where operator_code='E1'`);
});
afterAll(async () => { await db.close(); });

describe('plantilla de directorio contra PostgreSQL real', () => {
  let file: Buffer; let importId: string;
  let authBefore: number; let moneyBefore: Awaited<ReturnType<typeof money>>;

  it('loadDirectory lee conductores, unidades y asignaciones vigentes con su tarifa', async () => {
    const d = await db.as(db.opsAdmin, (q) => loadDirectory(q));
    expect(d.drivers).toHaveLength(3); expect(d.units.sort()).toEqual(['UE1', 'UE2', 'UE3']);
    expect(d.assignments.find((a) => a.unitCode === 'UE1')!.dailyRateCents).toBe(3600);
    expect(d.assignments.find((a) => a.unitCode === 'UE2')!.dailyRateCents).toBeNull();
  });

  it('vista previa con diferencias: se guarda en import_rows y no cambia nada financiero ni del directorio', async () => {
    const tpl = await buildDirectoryTemplate();
    file = await fillTemplate(tpl, [
      ['UE1', 'E1', 'Renombrada', null, 'ID-E1', null, 40, 'Suspendido'],
      ['UOTRA', 'E2', null, null, 'ID-E2', null, null, null],
      ['UE3', 'E3', 'Conductor', 'E3', 'ID-E3', null, 30, 'Activo'],
      ['UN1', 'N1', 'Nuevo', 'Uno', 'ID-N1', '6123-4567', 36, 'Activo'],
      ['UN2', 'N2', 'Nuevo', 'Dos', 'ID-N2', '123', 30, null],
      ['UN3', 'D1', 'Dup', null, 'ID-D1', null, 30, null],
      ['UN4', 'D1', 'Dup', null, 'ID-D2', null, 30, null],
      [null, null, null, null, null, null, null, null],
    ]);
    authBefore = await count('auth.users'); moneyBefore = await money();
    const before = { drivers: await count('drivers'), units: await count('units'), assignments: await count('assignments'), rates: await count('rates') };
    const r = await db.as(db.opsAdmin, (q) => stageImport(q, { userId: db.opsAdmin }, file, 'directorio.xlsx'));
    importId = r.importId;
    expect(r.created).toBe(true);
    expect(r.summary).toMatchObject({ kind: 'directory', rows: 7, duplicates: 2, drivers: { new: 2, existing: 3, toUpdate: 1, unchanged: 2 }, assignments: { new: 2, same: 2, conflicts: 1 }, rates: { new: 2, differs: 1, same: 1 } });
    expect((await db.su.query(`select source_kind, status from public.excel_imports`)).rows[0]).toEqual({ source_kind: 'directory', status: 'previewed' });
    expect({ drivers: await count('drivers'), units: await count('units'), assignments: await count('assignments'), rates: await count('rates') }).toEqual(before);
    expect(await money()).toEqual(moneyBefore); expect(await count('candidate_payments')).toBe(0);
    const e1 = (await db.su.query(`select first_name, last_name, phone_e164, row_status, daily_rate_cents::int rate, changes from public.import_rows where operator_code='E1'`)).rows[0];
    expect(e1).toMatchObject({ first_name: 'Renombrada', row_status: 'suspended', rate: 4000, last_name: null, phone_e164: null });
    expect(e1.changes.driver.action).toBe('update'); expect(e1.changes.rate).toMatchObject({ action: 'differs', from: 3600, to: 4000 });
    const n1 = (await db.su.query(`select phone_e164, match_status from public.import_rows where operator_code='N1'`)).rows[0];
    expect(n1).toEqual({ phone_e164: '+50761234567', match_status: 'unmatched' });
    expect((await db.su.query(`select match_status from public.import_rows where operator_code='D1' order by source_row`)).rows.map((x) => x.match_status)).toEqual(['duplicate', 'duplicate']);
  });

  it('el mismo archivo dos veces devuelve el existente', async () => {
    const r = await db.as(db.opsAdmin, (q) => stageImport(q, { userId: db.opsAdmin }, file, 'copia.xlsx'));
    expect(r.created).toBe(false); expect(r.importId).toBe(importId); expect(await count('excel_imports')).toBe(1);
  });

  it('supervisor (solo lectura), usuario sin rol y anon no pueden importar; sin rol y anon tampoco ven filas (RLS)', async () => {
    const other = await buildDirectoryFile([['U1', 'ZZ', 'Z', null, 'ID-ZZ']]);
    for (const uid of [db.supervisor, db.outsider]) {
      await expect(db.as(uid, (q) => stageImport(q, { userId: uid }, other, 'x.xlsx'))).rejects.toThrow(/row-level security|permission denied/i);
    }
    expect(await db.as(db.outsider, (q) => listImportRows(q, importId))).toEqual([]);
    expect((await db.as(db.supervisor, (q) => listImportRows(q, importId))).length).toBeGreaterThan(0);   // el supervisor consulta, no importa
    await expect(db.as(db.supervisor, (q) => confirmImport(q, { userId: db.supervisor }, importId, { approve: 'clean' }))).rejects.toThrow();
    expect((await db.su.query(`select status from public.excel_imports`)).rows[0].status).toBe('previewed');
    await expect(db.asAnon((q) => stageImport(q, { userId: db.opsAdmin }, other, 'x.xlsx'))).rejects.toThrow(/permission denied|row-level security/i);
    expect(await count('excel_imports')).toBe(1);
  });

  it("confirm 'clean' aprueba matched/unmatched sin duplicados ni errores", async () => {
    const r = await db.as(db.opsAdmin, (q) => confirmImport(q, { userId: db.opsAdmin }, importId, { approve: 'clean' }));
    expect(r.approvedRows).toBe(5);
    expect((await db.su.query(`select count(*)::int n from public.import_rows where review_status='approved' and match_status in ('duplicate','conflict','ignored')`)).rows[0].n).toBe(0);
    expect(await money()).toEqual(moneyBefore);
  });

  it('apply_directory_import: crea y actualiza; celdas vacías no borran; tarifa distinta NO se aplica sin flag; cambio de unidad es conflicto', async () => {
    const res = await apply(importId);
    expect(res).toMatchObject({ drivers_created: 2, drivers_updated: 1, drivers_unchanged: 2, assignments_created: 2, rates_created: 2, rates_changed: 0, rows_excluded: 2 });
    expect(res.issues.map((i: { issue: string }) => i.issue).sort()).toEqual(['assignment_conflict', 'rate_differs']);
    expect((await db.su.query(`select first_name, last_name, phone_e164, status from public.drivers where operator_code='E1'`)).rows[0]).toEqual({ first_name: 'Renombrada', last_name: 'Nombre', phone_e164: '+50760000000', status: 'suspended' });
    expect((await db.su.query(`select rt.daily_amount_cents::int c from public.rates rt join public.assignments a on a.id=rt.assignment_id join public.drivers d on d.id=a.driver_id where d.operator_code='E1' and rt.valid_to is null`)).rows[0].c).toBe(3600);
    expect((await db.su.query(`select u.code from public.assignments a join public.units u on u.id=a.unit_id join public.drivers d on d.id=a.driver_id where d.operator_code='E2' and a.valid_to is null`)).rows.map((x) => x.code)).toEqual(['UE2']);
    expect((await db.su.query(`select phone_e164, status, first_name from public.drivers where operator_code='N2'`)).rows[0]).toEqual({ phone_e164: null, status: 'active', first_name: 'Nuevo' });
    expect((await db.su.query(`select phone_e164 from public.drivers where operator_code='N1'`)).rows[0].phone_e164).toBe('+50761234567');
    expect(await count('drivers')).toBe(5);          // los duplicados D1 no se crearon
    expect((await db.su.query(`select count(*)::int n from public.drivers where operator_code='D1'`)).rows[0].n).toBe(0);
    expect(await db.as(db.opsAdmin, (q) => q.fails(`select public.apply_directory_import($1)`, [importId]))).toBe('import_already_applied');
  });

  it('NO toca pagos/cargos/saldos y NO crea cuentas de Supabase Auth', async () => {
    expect(await money()).toEqual(moneyBefore);
    expect(await count('auth.users')).toBe(authBefore);
    expect(await count('candidate_payments')).toBe(0);
  });

  it('la tarifa distinta se aplica solo con apply_rate_changes', async () => {
    const f2 = await buildDirectoryFile([['UE1', 'E1', null, null, 'ID-E1', null, 40, null]]);
    const r = await db.as(db.opsAdmin, (q) => stageImport(q, { userId: db.opsAdmin }, f2, 'tarifa.xlsx'));
    expect(r.summary.rates).toEqual({ new: 0, same: 0, differs: 1 });
    await db.as(db.opsAdmin, (q) => confirmImport(q, { userId: db.opsAdmin }, r.importId, { approve: 'clean' }));
    expect(await apply(r.importId, true, '2026-03-09')).toMatchObject({ rates_changed: 1, drivers_updated: 0 });
    expect((await db.su.query(`select rt.daily_amount_cents::int c, rt.valid_from::text vf from public.rates rt join public.assignments a on a.id=rt.assignment_id join public.drivers d on d.id=a.driver_id where d.operator_code='E1' and rt.valid_to is null`)).rows[0]).toEqual({ c: 4000, vf: '2026-03-09' });
    expect((await db.su.query(`select count(*)::int n from public.rates rt join public.assignments a on a.id=rt.assignment_id join public.drivers d on d.id=a.driver_id where d.operator_code='E1'`)).rows[0].n).toBe(2);
    expect(await money()).toEqual(moneyBefore);
  });
});

describe('cobranza multibloque: apply_import skip vs latest_block', () => {
  // A: unidad y tarifa ambiguas; B: igual en 3 bloques; C: unidad ambigua pero tarifa igual, no aparece en el último bloque.
  const blocks = [
    [['U1', 'A', 'ID-A', 'A A', 30], ['U3', 'B', 'ID-B', 'B B', 32], ['U4', 'C', 'ID-C', 'C C', 31]],
    [['U2', 'A', 'ID-A', 'A A', 30], ['U3', 'B', 'ID-B', 'B B', 32], ['U5', 'C', 'ID-C', 'C C', 31]],
    [['U2', 'A', 'ID-A', 'A A', 35], ['U3', 'B', 'ID-B', 'B B', 32]],
  ];
  const run = async (resolve: 'skip' | 'latest_block') => {
    const d = await newDb();
    try {
      const f = await buildMultiBlock(blocks);
      const r = await d.as(d.opsAdmin, (q) => stageImport(q, { userId: d.opsAdmin }, f, 'c.xlsx'));
      expect(r.summary).toMatchObject({ kind: 'cobranza', uniqueDrivers: 3, drivers: { new: 3 }, assignmentsResolvable: { skip: 1, latestBlock: 3 },
        ambiguity: { unitAmbiguous: 2, rateAmbiguous: 1, nationalIdsDiffer: 0, unitsWithSeveralDrivers: 0 } });
      await d.as(d.opsAdmin, (q) => confirmImport(q, { userId: d.opsAdmin }, r.importId, { approve: 'clean' }));
      const res = await d.as(d.opsAdmin, async (q) => (await q.one(`select public.apply_import($1, '2026-03-02'::date, 'active', $2) r`, [r.importId, resolve])).r);
      const asg = (await d.su.query(`select dr.operator_code op, u.code, rt.daily_amount_cents::int rate from public.assignments a join public.drivers dr on dr.id=a.driver_id
        join public.units u on u.id=a.unit_id left join public.rates rt on rt.assignment_id=a.id order by 1`)).rows;
      const drivers = Number((await d.su.query(`select count(*) n from public.drivers`)).rows[0].n);
      const money = Number((await d.su.query(`select (select count(*) from public.charges)+(select count(*) from public.payments) n`)).rows[0].n);
      return { res, asg, drivers, money };
    } finally { await d.close(); }
  };

  it("'skip' no adivina: solo B queda asignado; el conductor de 3 bloques es UNO", async () => {
    const x = await run('skip');
    expect(x.drivers).toBe(3);
    expect(x.res).toMatchObject({ drivers_created: 3, assignments_created: 1, rates_created: 1, resolve: 'skip', resolved_by_latest_block: 0 });
    expect(x.asg).toEqual([{ op: 'B', code: 'U3', rate: 3200 }]);
    expect(x.money).toBe(0);
  });

  it("'latest_block' usa el bloque más a la derecha donde aparece cada conductor", async () => {
    const x = await run('latest_block');
    expect(x.drivers).toBe(3);
    expect(x.res).toMatchObject({ drivers_created: 3, assignments_created: 3, rates_created: 3, resolve: 'latest_block', resolved_by_latest_block: 2 });
    expect(x.asg).toEqual([{ op: 'A', code: 'U2', rate: 3500 }, { op: 'B', code: 'U3', rate: 3200 }, { op: 'C', code: 'U5', rate: 3100 }]);
    expect(x.money).toBe(0);
  });
});

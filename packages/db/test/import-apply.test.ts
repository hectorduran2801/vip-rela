import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MON, chargeWeek, pay } from './fixtures.js';
import { newDb, type Db } from './harness.js';

let db: Db;
beforeAll(async () => { db = await newDb(); });
afterAll(async () => { await db.close(); });

type Row = { block: number; op: string; nid: string; name: string; unit: string; rate: number | null; match?: string; approved?: boolean; days?: (number | null)[]; saldo?: string; agreement?: string };
let sha = 0;
async function stage(rows: Row[], status = 'confirmed') {
  const imp = (await db.su.query(`insert into public.excel_imports(file_name, file_sha256, status, created_by) values ('t.xlsx',$1,$2,$3) returning id`, [`sha-${++sha}`, status, db.admin])).rows[0].id;
  const blocks = new Map<number, string>(); let k = 0;
  for (const r of rows) {
    if (!blocks.has(r.block)) blocks.set(r.block, (await db.su.query(`insert into public.import_blocks(import_id, block_index, start_column, header_variant) values ($1,$2,'B','PAGO SEMANAL') returning id`, [imp, r.block])).rows[0].id);
    await db.su.query(`insert into public.import_rows(block_id, source_row, unit_code, operator_code, national_id, full_name, daily_rate_cents, raw_saldo, raw_agreement, day_amounts_cents, match_status, review_status)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [blocks.get(r.block), ++k + 1, r.unit, r.op, r.nid, r.name, r.rate, r.saldo ?? null, r.agreement ?? null, r.days ?? null, r.match ?? 'unmatched', r.approved === false ? 'pending' : 'approved']);
  }
  return imp as string;
}
const apply = (imp: string, from?: string, st = 'active') => db.as(db.admin, async (q) => (await q.one(`select public.apply_import($1, $2::date, $3) r`, [imp, from ?? null, st])).r);
const count = async (t: string) => Number((await db.su.query(`select count(*) n from public.${t}`)).rows[0].n);

describe('apply_import: construye el directorio sin tocar finanzas', () => {
  it('crea conductores, unidades, asignaciones y tarifas desde varios bloques sin duplicar a los repetidos', async () => {
    const imp = await stage([
      { block: 1, op: '15374', nid: '8-111-111', name: 'JUAN PEREZ', unit: 'P811', rate: 3600, days: [3600, 0, null, null, null, null, null], saldo: '40', agreement: 'CUSTODIA' },
      { block: 2, op: '15374', nid: '8-111-111', name: 'JUAN PEREZ', unit: 'p811', rate: 3600 }, { block: 3, op: '15374', nid: '8-111-111', name: 'JUAN PEREZ', unit: 'P811 ', rate: 3600 },
      { block: 1, op: '17961', nid: '8-222-222', name: 'ANA GOMEZ', unit: 'P820', rate: 3450 }]);
    expect(await apply(imp, '2026-03-02')).toMatchObject({ drivers_created: 2, drivers_linked: 0, units_created: 2, assignments_created: 2, rates_created: 2, skipped: 0, valid_from: '2026-03-02' });
    expect((await db.su.query(`select d.status, d.first_name, a.valid_from::text vf, rt.daily_amount_cents::int rate from public.drivers d join public.assignments a on a.driver_id=d.id join public.rates rt on rt.assignment_id=a.id where d.operator_code='17961'`)).rows[0]).toEqual({ status: 'active', first_name: 'ANA GOMEZ', vf: '2026-03-02', rate: 3450 });
    expect((await db.su.query(`select status, applied_by from public.excel_imports where id=$1`, [imp])).rows[0]).toEqual({ status: 'applied', applied_by: db.admin });
  });
  it('NO crea cargos, pagos ni ajustes; SALDO y ACUERDO siguen crudos y no se vuelven deuda', async () => {
    expect([await count('charges'), await count('payments'), await count('adjustments')]).toEqual([0, 0, 0]);
    expect((await db.su.query(`select raw_saldo, raw_agreement from public.import_rows where operator_code='15374' and raw_saldo is not null`)).rows[0]).toMatchObject({ raw_saldo: '40', raw_agreement: 'CUSTODIA' });
    const pos = await db.as(db.admin, (q) => q.rows(`select pending_cents::int p, credit_cents::int c from public.v_assignment_position`));
    expect(pos.every((p) => p.p === 0 && p.c === 0)).toBe(true);
  });
  it('no se puede aplicar dos veces ni sin confirmar; solo la administradora', async () => {
    const imp = await stage([{ block: 1, op: 'X1', nid: 'N-X1', name: 'X', unit: 'UX1', rate: 3000 }], 'previewed');
    expect(await db.as(db.admin, (q) => q.fails(`select public.apply_import($1)`, [imp]))).toBe('import_not_confirmed');
    expect(await db.as(db.outsider, (q) => q.fails(`select public.apply_import($1)`, [imp]))).toBe('forbidden');
    expect(await db.asAnon((q) => q.fails(`select public.apply_import($1)`, [imp]))).toMatch(/permission denied/);
    await db.su.query(`update public.excel_imports set status='confirmed' where id=$1`, [imp]);
    await apply(imp);
    expect(await db.as(db.admin, (q) => q.fails(`select public.apply_import($1)`, [imp]))).toBe('import_already_applied');
  });
  it('las filas excluidas no crean nada; conflictos, duplicados e ignoradas se rechazan con motivo; sin cédula o sin operario NO bloquea la unidad', async () => {
    const imp = await stage([
      { block: 1, op: 'E1', nid: 'N-E1', name: 'EXCLUIDO', unit: 'UE1', rate: 3000, approved: false }, { block: 1, op: 'E2', nid: 'N-E2', name: 'INCLUIDO', unit: 'UE2', rate: 3000 },
      { block: 1, op: 'R1', nid: 'N-R1', name: 'C', unit: 'UR1', rate: 3000, match: 'conflict' }, { block: 1, op: 'R2', nid: 'N-R2', name: 'D', unit: 'UR2', rate: 3000, match: 'duplicate' },
      { block: 1, op: 'R3', nid: 'N-R3', name: 'I', unit: 'UR3', rate: 3000, match: 'ignored' }, { block: 1, op: 'R4', nid: '', name: 'S', unit: 'UR4', rate: 3000 },
      { block: 1, op: '', nid: 'N-R5', name: 'S', unit: 'UR5', rate: 3000 }, { block: 1, op: '', nid: '', name: '', unit: '', rate: null }]);
    const r = await apply(imp);
    expect(r).toMatchObject({ drivers_created: 1, rows_excluded: 1, rows_rejected: 4 });
    const note = (op: string) => db.su.query(`select applied_action a, applied_note n from public.import_rows where operator_code=$1`, [op]).then((x) => x.rows[0]);
    expect(await note('R4')).toMatchObject({ a: 'skipped' });             // sin cédula: no hay conductor…
    const units = (await db.su.query(`select code from public.units where code in ('UR4','UR5')`)).rows.map((x) => x.code).sort();
    expect(units).toEqual(['UR4', 'UR5']);                                 // …pero la unidad SÍ se importa
    expect((await db.su.query(`select count(*)::int n from public.drivers where operator_code in ('R1','R2','R3','R4')`)).rows[0].n).toBe(0);   // nunca se inventa un conductor
  });
  it('datos ambiguos entre bloques no se adivinan: unidad distinta, tarifa distinta, cédulas distintas', async () => {
    const imp = await stage([
      { block: 1, op: 'M1', nid: 'N-M1', name: 'M', unit: 'UM1', rate: 3000 }, { block: 2, op: 'M1', nid: 'N-M1', name: 'M', unit: 'UM2', rate: 3000 },
      { block: 1, op: 'M2', nid: 'N-M2', name: 'T', unit: 'UM3', rate: 3000 }, { block: 2, op: 'M2', nid: 'N-M2', name: 'T', unit: 'UM3', rate: 3500 },
      { block: 1, op: 'M3', nid: 'N-M3a', name: 'Q', unit: 'UM4', rate: 3000 }, { block: 2, op: 'M3', nid: 'N-M3b', name: 'Q', unit: 'UM4', rate: 3000 }]);
    const r = await apply(imp);
    expect(r).toMatchObject({ drivers_created: 2, assignments_created: 1, rates_created: 0, skipped: 1 });
    expect(r.issues.map((i: { issue: string }) => i.issue).sort()).toEqual(['national_id_ambiguous', 'rate_ambiguous', 'unit_ambiguous']);
  });
});

describe('importaciones posteriores: no duplican ni sobrescriben', () => {
  it('vincula existentes, no cambia asignaciones ni tarifas y reporta diferencias', async () => {
    const before = (await db.su.query(`select d.first_name, a.id aid, a.unit_id, rt.daily_amount_cents::int rate from public.drivers d join public.assignments a on a.driver_id=d.id join public.rates rt on rt.assignment_id=a.id where d.operator_code='17961'`)).rows[0];
    const imp = await stage([
      { block: 1, op: '17961', nid: '8-222-222', name: 'NOMBRE DISTINTO', unit: 'P820', rate: 4000, match: 'matched' }, { block: 1, op: '15374', nid: '8-111-111', name: 'JUAN PEREZ', unit: 'P999', rate: 3600, match: 'matched' },
      { block: 1, op: 'N1', nid: 'N-N1', name: 'NUEVO', unit: 'P820', rate: 3000 }]);
    const r = await apply(imp);
    expect(r).toMatchObject({ drivers_created: 1, drivers_linked: 2 });
    expect(r.issues.map((i: { issue: string }) => i.issue).sort()).toEqual(['assignment_conflict', 'rate_differs', 'unit_already_assigned']);
    expect((await db.su.query(`select d.first_name, a.id aid, a.unit_id, rt.daily_amount_cents::int rate from public.drivers d join public.assignments a on a.driver_id=d.id join public.rates rt on rt.assignment_id=a.id where d.operator_code='17961'`)).rows[0]).toEqual(before);
  });
  it('conserva los pagos existentes y el saldo calculado no incorpora el SALDO del Excel', async () => {
    const x = await db.driverWithAssignment({ code: 'H1', unit: 'UH1', dailyCents: 3600 });
    await chargeWeek(db, MON);
    const p = await db.as(db.admin, (q) => pay(q, x.assignment, 'cash', 5000));
    const imp = await stage([{ block: 1, op: 'H1', nid: 'ID-H1', name: 'H', unit: 'UH1', rate: 9999, match: 'matched', saldo: '777', days: [100, 100, 100, 100, 100, 100, 100] }]);
    await apply(imp);
    expect((await db.su.query(`select net_cents::int n, voided_at from public.payments where id=$1`, [p.payment_id])).rows[0]).toEqual({ n: 5000, voided_at: null });
    expect((await db.as(db.admin, (q) => q.one(`select pending_cents::int p from public.assignment_position($1)`, [x.assignment]))).p).toBe(21600 - 5000);
  });
});

import { existsSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newDb, type Db } from '@vip/db/testing';
import { confirmImport, ImportStateError, listImportRows, loadDrivers, previewImport, rejectImport, stageImport } from '../src/index.js';
import { buildFixture, buildPositional } from './fixture.js';

let db: Db;
let file: Buffer;
let ctx: { userId: string };

const count = async (t: string) => Number((await db.su.query(`select count(*) n from public.${t}`)).rows[0].n);
const financial = async () => ({ charges: await count('charges'), payments: await count('payments'), allocations: await count('payment_allocations'),
  drivers: await count('drivers'), assignments: await count('assignments'), units: await count('units'), rates: await count('rates'), adjustments: await count('adjustments') });

beforeAll(async () => {
  db = await newDb();
  ctx = { userId: db.admin };
  file = await buildFixture();
  const ins = (code: string, nid: string) => db.su.query(
    `insert into public.drivers(operator_code, national_id, first_name) values ($1,$2,'Conductor')`, [code, nid]);
  await ins('OP2', 'C-002');   // coincide
  await ins('OP4', 'OTRA');    // conflicto: operador con otra cédula
  await ins('OTRO', 'C-005');  // conflicto: cédula con otro operador
});
afterAll(async () => { await db.close(); });

describe('staging contra PostgreSQL real', () => {
  let importId: string;
  let before: Awaited<ReturnType<typeof financial>>;

  it('la administradora importa: sin cambios en charges/payments/drivers/assignments/units/rates', async () => {
    before = await financial();
    const r = await db.as(db.admin, (q) => stageImport(q, ctx, file, 'sintetico.xlsx'));
    expect(r.created).toBe(true); expect(r.status).toBe('previewed');
    importId = r.importId;
    expect(await financial()).toEqual(before);
    expect(await count('import_blocks')).toBe(2);
    expect(await count('import_rows')).toBe(r.summary.rows);
    const rows = await db.su.query(`select count(*)::int n from public.import_rows where match_status='matched'`);
    expect(rows.rows[0].n).toBe(r.summary.matchCounts.matched);
  });

  it('guarda crudos, centavos, fórmulas y semanas sin fecha', async () => {
    const blk = (await db.su.query(`select detected_week_start, header_variant, start_column from public.import_blocks order by block_index`)).rows;
    expect(blk.map((b) => b.detected_week_start)).toEqual([null, null]);
    expect(blk.map((b) => b.header_variant)).toEqual(['sem_corriente', 'pago_semanal']);
    const r = (await db.su.query(`select * from public.import_rows where operator_code='OP1' and national_id='C-001' and source_row=2 and block_id in (select id from public.import_blocks where block_index=1)`)).rows[0];
    expect(r.daily_rate_cents).toBe('3450');
    expect(r.day_amounts_cents).toEqual(['3450', '3450', '3450', '3450', '3450', '3450', null]);
    expect(r.raw_saldo).toBe('12'); expect(r.raw_agreement).toBe('CUSTODIA');
    expect(r.original_formulas.weekly_expected).toBe('=E2*6');
    expect(r.excel_weekly_expected_cents).toBe('20700');
    expect(r.warnings).toContain('duplicate_operator_in_block');
    expect(r.applied_action).toBeNull();
  });

  it('importes lun-dom solo como candidate_payments pending (sin ceros ni totales)', async () => {
    const c = (await db.su.query(`select status, count(*)::int n, min(amount_cents) mn from public.candidate_payments group by status`)).rows;
    expect(c).toHaveLength(1); expect(c[0].status).toBe('pending'); expect(Number(c[0].mn)).toBeGreaterThan(0);
    const s = (await db.su.query(`select summary from public.excel_imports`)).rows[0].summary;
    expect(c[0].n).toBe(s.candidatePayments);
  });

  it('concilia con drivers existentes (loadDrivers) y no los modifica', async () => {
    const drivers = await db.as(db.admin, (q) => loadDrivers(q));
    expect(drivers.map((d) => d.operatorCode).sort()).toEqual(['OP2', 'OP4', 'OTRO']);
    const m = Object.fromEntries((await db.su.query(`select operator_code, match_status from public.import_rows where block_id in (select id from public.import_blocks where block_index=1) and operator_code in ('OP2','OP3','OP4','OP5')`)).rows.map((x) => [x.operator_code, x.match_status]));
    expect(m).toEqual({ OP2: 'matched', OP3: 'unmatched', OP4: 'conflict', OP5: 'conflict' });
    expect((await db.su.query(`select national_id from public.drivers where operator_code='OP4'`)).rows[0].national_id).toBe('OTRA');
    const matched = (await db.su.query(`select matched_driver_id from public.import_rows where operator_code='OP2' and match_status='matched' limit 1`)).rows[0];
    expect(matched.matched_driver_id).toBeTruthy();
  });

  it('el mismo archivo no se importa dos veces (devuelve el existente, sin duplicar filas)', async () => {
    const rowsBefore = await count('import_rows');
    const r = await db.as(db.admin, (q) => stageImport(q, ctx, file, 'copia.xlsx'));
    expect(r.created).toBe(false); expect(r.importId).toBe(importId);
    expect(await count('import_rows')).toBe(rowsBefore);
    expect(await count('excel_imports')).toBe(1);
  });

  it('un usuario autenticado NO autorizado no puede importar ni ver filas; anon tampoco', async () => {
    await expect(db.as(db.outsider, (q) => stageImport(q, { userId: db.outsider }, file, 'x.xlsx'))).rejects.toThrow(/row-level security|permission denied/i);
    const seen = await db.as(db.outsider, async (q) => ({
      imports: (await q.rows('select id from public.excel_imports')).length, blocks: (await q.rows('select id from public.import_blocks')).length,
      rows: (await q.rows('select id from public.import_rows')).length, cands: (await q.rows('select id from public.candidate_payments')).length,
    }));
    expect(seen).toEqual({ imports: 0, blocks: 0, rows: 0, cands: 0 });
    expect(await db.as(db.outsider, (q) => listImportRows(q, importId))).toEqual([]);
    await expect(db.asAnon((q) => stageImport(q, ctx, file, 'x.xlsx'))).rejects.toThrow(/permission denied|row-level security/i);
    await expect(db.asAnon((q) => listImportRows(q, importId))).rejects.toThrow(/permission denied/i);
    await expect(db.as(db.outsider, (q) => confirmImport(q, { userId: db.outsider }, importId, { approve: 'clean' }))).rejects.toThrow(ImportStateError);
    expect(await count('excel_imports')).toBe(1);
    expect((await db.su.query(`select status from public.excel_imports`)).rows[0].status).toBe('previewed');
  });

  it('listImportRows permite revisar conflictos', async () => {
    const rows = await db.as(db.admin, (q) => listImportRows(q, importId, { matchStatus: 'conflict' }));
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.every((r) => r.warnings.some((w: string) => w.startsWith('conflict_')))).toBe(true);
  });

  it('confirm: marca confirmed + filas aprobadas, sin conflictos/duplicados/#REF y sin movimientos financieros', async () => {
    const r = await db.as(db.admin, (q) => confirmImport(q, ctx, importId, { approve: 'clean' }));
    expect(r.status).toBe('confirmed'); expect(r.approvedRows).toBeGreaterThan(0);
    expect((await db.su.query(`select status from public.excel_imports`)).rows[0].status).toBe('confirmed');
    const bad = (await db.su.query(`select count(*)::int n from public.import_rows where review_status='approved' and (match_status in ('conflict','duplicate','ignored') or warnings && array['formula_ref_error:weekly_diff'])`)).rows[0].n;
    expect(bad).toBe(0);
    expect((await db.su.query(`select count(*)::int n from public.candidate_payments where status<>'pending'`)).rows[0].n).toBe(0);
    expect(await financial()).toEqual(before);
    await expect(db.as(db.admin, (q) => confirmImport(q, ctx, importId, { approve: 'clean' }))).rejects.toThrow(ImportStateError);
  });

  it('flujo completo: apply_import crea el directorio y NO crea cargos ni pagos', async () => {
    const res = await db.as(db.admin, async (q) => (await q.one(`select public.apply_import($1, $2::date, $3) r`, [importId, '2026-03-02', 'active'])).r);
    expect(res.drivers_created).toBeGreaterThan(0);
    const after = await financial();
    expect(after.drivers).toBeGreaterThan(before.drivers);
    expect(after.assignments).toBeGreaterThan(before.assignments);
    expect(after.charges).toBe(0); expect(after.payments).toBe(0); expect(after.allocations).toBe(0); expect(after.adjustments).toBe(0);
    expect((await db.su.query(`select status, applied_by from public.excel_imports`)).rows[0]).toEqual({ status: 'applied', applied_by: db.admin });
    expect((await db.su.query(`select national_id from public.drivers where operator_code='OP4'`)).rows[0].national_id).toBe('OTRA');
    expect((await db.su.query(`select count(*)::int n from public.candidate_payments where status<>'pending'`)).rows[0].n).toBe(0);
    const again = await db.as(db.admin, (q) => stageImport(q, ctx, file, 'otra-vez.xlsx'));
    expect(again.created).toBe(false); expect(again.status).toBe('applied');
  });

  it('rejectImport descarta una vista previa y solo en estado previewed', async () => {
    const f2 = await buildPositional();
    const r = await db.as(db.admin, (q) => stageImport(q, ctx, f2, 'p.xlsx'));
    await db.as(db.admin, (q) => rejectImport(q, ctx, r.importId));
    expect((await db.su.query(`select status from public.excel_imports where id=$1`, [r.importId])).rows[0].status).toBe('rejected');
    await expect(db.as(db.admin, (q) => rejectImport(q, ctx, r.importId))).rejects.toThrow(ImportStateError);
  });

  it('el archivo original no se modifica (buffer intacto tras previsualizar)', async () => {
    const copy = Buffer.from(file);
    await previewImport(file, 'x');
    expect(file.equals(copy)).toBe(true);
  });
});

// Prueba de humo OPCIONAL con el archivo real local (nunca en el repo). No imprime datos personales.
const REAL = '/private/tmp/claude-502/-Users-hector-Documents-IDEAS-vip/e664b1f9-3ee7-4326-915a-70d5b133924b/scratchpad/data/cobranza.xlsx';
describe.skipIf(!existsSync(REAL))('humo con archivo real (opcional)', () => {
  it('detecta 21 bloques', async () => {
    const p = await previewImport(readFileSync(REAL), 'real.xlsx');
    expect(p.summary.blocks).toBe(21);
    expect(p.blocks.every((b) => b.detectedWeekStart === null)).toBe(true);
    expect(p.summary.warningsByType.totals_row).toBeGreaterThan(0);
  });
  it('buckets sobre conductores únicos (solo conteos)', async () => {
    const p = await previewImport(readFileSync(REAL), 'real.xlsx');
    expect(p.kind).toBe('cobranza');
    expect(p.summary.uniqueDrivers).toBeLessThan(p.summary.rows);
    expect(p.summary.assignmentsResolvable!.latestBlock).toBeGreaterThanOrEqual(p.summary.assignmentsResolvable!.skip);
  });
});

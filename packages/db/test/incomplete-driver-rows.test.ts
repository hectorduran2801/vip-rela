import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newDb, type Db } from './harness.js';

/** 0020: filas con unidad pero sin datos suficientes de conductor (SQL directo sobre filas preparadas, sin pasar por el parser). */
let db: Db;
beforeAll(async () => {
  db = await newDb();
  await db.driverWithAssignment({ code: 'EX1', unit: 'UEX1', dailyCents: 3600, phone: '+50760000001' });
});
afterAll(async () => { await db.close(); });

type R = { op?: string | null; nid?: string | null; fn?: string | null; unit?: string | null; rate?: number | null; agr?: string | null; match?: string };
let sha = 0;
async function stage(kind: 'directory' | 'cobranza', rows: R[]) {
  const imp = (await db.su.query(`insert into public.excel_imports(file_name, file_sha256, status, source_kind, created_by) values ('t.xlsx',$1,'confirmed',$2,$3) returning id`, [`inc-${++sha}`, kind, db.admin])).rows[0].id;
  const blk = (await db.su.query(`insert into public.import_blocks(import_id, block_index, start_column, header_variant) values ($1,1,'A',$2) returning id`, [imp, kind === 'directory' ? 'plantilla' : 'PAGO SEMANAL'])).rows[0].id;
  let k = 1;
  for (const r of rows) await db.su.query(`insert into public.import_rows(block_id, source_row, unit_code, operator_code, national_id, first_name, full_name, daily_rate_cents, unit_agreement, raw_agreement, match_status, review_status)
    values ($1,$2,$3,$4,$5,$6,$6,$7,$8,$8,$9,'approved')`, [blk, ++k, r.unit ?? null, r.op ?? null, r.nid ?? null, r.fn ?? null, r.rate ?? null, r.agr ?? null, r.match ?? 'unmatched']);
  return imp as string;
}
const dir = (id: string) => db.as(db.admin, async (q) => (await q.one(`select public.apply_directory_import($1, '2026-03-02'::date, 'active', false) r`, [id])).r);
const cob = (id: string) => db.as(db.admin, async (q) => (await q.one(`select public.apply_import($1, '2026-03-02'::date, 'active', 'skip') r`, [id])).r);
const n = async (t: string) => Number((await db.su.query(`select count(*) n from public.${t}`)).rows[0].n);

describe('0020 SQL: unidad sí, conductor pendiente de revisión', () => {
  it('directorio: sin operario, sin cédula o sin nombre → unidad creada, ningún conductor/asignación/tarifa, motivo en la fila', async () => {
    const imp = await stage('directory', [
      { unit: 'S1', op: 'OA', nid: null, fn: 'Ana', rate: 3000, agr: 'CHAPA' }, { unit: 'S2', op: null, nid: 'IDB', fn: 'Beto' },
      { unit: 'S3', op: 'OC', nid: 'IDC', fn: null }, { unit: 'S4' }, { unit: null, op: 'OD', nid: null, fn: 'Dora' }, { unit: 'S5', op: 'OE', nid: 'IDE', fn: 'Eva', match: 'duplicate' }]);
    const d0 = await n('drivers'), a0 = await n('assignments'), r0 = await n('rates');
    const res = await dir(imp);
    expect(res).toMatchObject({ drivers_created: 0, drivers_pending_review: 3, units_created: 4, units_without_driver_created: 4, assignments_created: 0, rates_created: 0, agreements_set: 1, rows_rejected: 2 });
    expect([await n('drivers'), await n('assignments'), await n('rates')]).toEqual([d0, a0, r0]);
    const rows = (await db.su.query(`select unit_code u, applied_action a, driver_review dr, applied_note note from public.import_rows r join public.import_blocks b on b.id=r.block_id where b.import_id=$1 order by source_row`, [imp])).rows;
    expect(rows.map((x) => [x.u, x.a, x.dr])).toEqual([['S1', 'linked', ['missing_national_id']], ['S2', 'linked', ['missing_operator']], ['S3', 'linked', ['missing_first_name']], ['S4', 'linked', null], [null, 'rejected', null], ['S5', 'rejected', null]]);
    expect(rows[2]!.note).toMatch(/falta nombre/);
    expect((await db.su.query(`select agreement from public.units where code='S1'`)).rows[0].agreement).toBe('CHAPA');
    expect((await db.su.query(`select count(*)::int c from public.drivers where operator_code in ('OA','OC','OD','OE') or national_id in ('IDB','IDC','IDD','IDE')`)).rows[0].c).toBe(0);
  });
  it('directorio: identificado por operario o cédula → se concilia completando solo lo vacío, sin sobrescribir', async () => {
    const imp = await stage('directory', [{ unit: 'UEX1', op: 'EX1', nid: null, fn: null }, { unit: 'UEX1', op: null, nid: 'ID-EX1', fn: 'Otro Nombre' }]);
    const d0 = await n('drivers');
    const res = await dir(imp);
    expect(res).toMatchObject({ drivers_pending_review: 0, drivers_created: 0, rows_rejected: 0 });
    expect(res.drivers_updated + res.drivers_unchanged).toBe(2);
    const d = (await db.su.query(`select operator_code, national_id, phone_e164 from public.drivers where operator_code='EX1'`)).rows[0];
    expect(d).toEqual({ operator_code: 'EX1', national_id: 'ID-EX1', phone_e164: '+50760000001' });
    expect(await n('drivers')).toBe(d0);
  });
  it('directorio: operario/cédula contradictorios con un existente NO se concilian (rechazo como antes)', async () => {
    const imp = await stage('directory', [{ unit: 'UX', op: 'EX1', nid: 'ID-OTRA', fn: 'X' }]);
    expect(await dir(imp)).toMatchObject({ drivers_created: 0, rows_rejected: 1 });
  });
  it('cobranza: operario sin cédula o cédula sin operario → unidad sí, conductor no, contadores; duplicado/conflicto/sin unidad siguen rechazados', async () => {
    const imp = await stage('cobranza', [
      { unit: 'K1', op: 'KA', nid: null, fn: 'A', rate: 3000 }, { unit: 'K2', op: null, nid: 'KIDB', fn: 'B', rate: 3000 }, { unit: 'K3' },
      { unit: 'K4', op: 'KD', nid: 'KIDD', fn: 'D', match: 'duplicate' }, { unit: null, op: null, nid: 'KIDE', fn: 'E' }]);
    const res = await cob(imp);
    expect(res).toMatchObject({ drivers_created: 0, drivers_pending_review: 2, units_created: 3, units_without_driver_created: 3, assignments_created: 0, rates_created: 0, rows_rejected: 2 });
    expect((await db.su.query(`select count(*)::int c from public.units where code in ('K1','K2','K3')`)).rows[0].c).toBe(3);
    expect((await db.su.query(`select count(*)::int c from public.units where code='K4'`)).rows[0].c).toBe(0);
    expect((await db.su.query(`select count(*)::int c from public.drivers where operator_code in ('KA','KD') or national_id in ('KIDB','KIDD','KIDE')`)).rows[0].c).toBe(0);
  });
  it('idempotente: reaplicar otra importación con las mismas unidades no las duplica', async () => {
    const before = await n('units');
    const res = await dir(await stage('directory', [{ unit: 'S1', op: 'OA', nid: null, fn: 'Ana' }, { unit: 'S4' }]));
    expect(res).toMatchObject({ units_created: 0, units_without_driver_created: 0, drivers_pending_review: 1, drivers_created: 0 });
    expect(await n('units')).toBe(before);
  });
  it('conserva las claves existentes del resultado y no toca finanzas', async () => {
    const res = await dir(await stage('directory', [{ unit: 'Z1' }]));
    for (const k of ['drivers_created', 'drivers_updated', 'drivers_unchanged', 'units_created', 'assignments_created', 'rates_created', 'rates_changed', 'rows_rejected', 'rows_excluded', 'units_without_driver', 'agreements_set', 'consents_granted', 'consents_withdrawn', 'consents_unchanged', 'consents_ignored', 'consent_jobs_cancelled', 'valid_from', 'issues']) expect(res).toHaveProperty(k);
    expect([await n('charges'), await n('payments')]).toEqual([0, 0]);
  });
});

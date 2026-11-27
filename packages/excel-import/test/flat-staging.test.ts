import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newDb, type Db } from '@vip/db/testing';
import { confirmImport, stageImport } from '../src/index.js';
import { buildFlat, HAPPY_ROWS } from './flat-fixture.js';

let db: Db;
let file: Buffer;
const count = async (t: string) => Number((await db.su.query(`select count(*) n from public.${t}`)).rows[0].n);
const financial = async () => ({ charges: await count('charges'), payments: await count('payments'), drivers: await count('drivers'), assignments: await count('assignments'),
  units: await count('units'), rates: await count('rates'), adjustments: await count('adjustments'), consents: await count('driver_consents'), candidates: await count('candidate_payments') });

beforeAll(async () => { db = await newDb(); file = await buildFlat(HAPPY_ROWS); });
afterAll(async () => { await db.close(); });

describe('cobranza plana: staging contra PostgreSQL real (migración 0026)', () => {
  let importId: string;
  it('escribe source_kind=collection_flat e import_rows con lo que lee apply_collection_sync; no toca maestros, cargos, pagos ni consentimientos', async () => {
    const before = await financial();
    const r = await db.as(db.admin, (q) => stageImport(q, { userId: db.admin }, file, 'plana.xlsx'));
    importId = r.importId;
    expect(r.created).toBe(true); expect(r.status).toBe('previewed');
    expect(await financial()).toEqual(before);
    const imp = (await db.su.query('select source_kind, status, summary from public.excel_imports where id=$1', [importId])).rows[0];
    expect(imp.source_kind).toBe('collection_flat');
    expect(imp.summary.units.total).toBe(6);
    const rows = (await db.su.query(
      `select r.* from public.import_rows r join public.import_blocks b on b.id=r.block_id where b.import_id=$1 order by r.source_row`, [importId])).rows;
    expect(rows).toHaveLength(6);
    const p101 = rows[0];
    expect(p101).toMatchObject({ source_row: 3, unit_code: 'P101', operator_code: 'OP1', national_id: '8-100-1', full_name: 'CARLOS ANDRES PRUEBA EJEMPLO',
      first_name: null, last_name: null, phone_e164: '+50760000101', raw_phone: '6000-0101', raw_saldo: '0', raw_agreement: 'CHAPA', unit_agreement: 'CHAPA' });
    expect(Number(p101.daily_rate_cents)).toBe(2900);
    expect(p101.day_amounts_cents.map((x: string | null) => (x === null ? null : Number(x)))).toEqual([2900, 0, null, null, null, null, null]);   // NULL = vacío, 0 = cero explícito
    expect(rows[1]).toMatchObject({ unit_code: 'P102', operator_code: null, raw_saldo: null });
    expect(Number(rows[1].daily_rate_cents)).toBe(0);
    expect(rows[3].raw_saldo).toBeNull();
    expect(Number(rows[4].excel_weekly_expected_cents)).toBe(20400);
  });
  it('apply_collection_sync (vista previa, solo lectura) entiende las filas: unidades, pagos y avisos', async () => {
    const pv = (await db.as(db.admin, (q) => q.query('select public.preview_collection_sync($1, $2::date) j', [importId, '2026-11-16']))).rows[0].j;
    expect(pv.units).toMatchObject({ total: 6, errors: 0, new: 6, without_driver: 1 });
    expect(pv.payments).toMatchObject({ new: 12, rejected: 0 });                 // 13 celdas con dato: 1 es 0 explícito (sin pago previo) 
    expect(pv.saldo.skip_empty).toBe(3);
    expect(pv.warnings.some((w: any) => w.code === 'rate_zero' && w.row === 4)).toBe(true);
    expect(await count('units')).toBe(0);                                         // la vista previa no escribe
  });
  it('idempotencia por sha256: el mismo archivo no se reimporta; uno con contenido distinto sí', async () => {
    const sameFile = Buffer.from(file);   // mismos bytes = mismo sha256
    const same = await db.as(db.admin, (q) => stageImport(q, { userId: db.admin }, sameFile, 'copia.xlsx'));
    expect(same.created).toBe(false); expect(same.importId).toBe(importId);
    expect(await count('excel_imports')).toBe(1);
    const otherFile = await buildFlat([...HAPPY_ROWS, { unit: 'P777', rate: 30 }]);
    const other = await db.as(db.admin, (q) => stageImport(q, { userId: db.admin }, otherFile, 'otra.xlsx'));
    expect(other.created).toBe(true); expect(other.importId).not.toBe(importId);
    expect(await count('excel_imports')).toBe(2);
  });
  it('confirmImport(clean) aprueba solo filas sin errores de celda', async () => {
    const badFile = await buildFlat([{ unit: 'P801', rate: 30 }, { unit: 'P802', rate: 30, days: ['abc', null, null, null, null, null, null] as any }]);
    const bad = await db.as(db.admin, (q) => stageImport(q, { userId: db.admin }, badFile, 'mala.xlsx'));
    const c = await db.as(db.admin, (q) => confirmImport(q, { userId: db.admin }, bad.importId, { approve: 'clean' }));
    expect(c.approvedRows).toBe(1);
  });
});

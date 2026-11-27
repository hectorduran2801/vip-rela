import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newDb, type Db } from './harness.js';

/** apply_import (formato de bloques): el WhatsApp de la columna opcional completa al conductor SIN sobrescribir y SIN marcar consentimiento. */
let db: Db; let sha = 0;
beforeAll(async () => { db = await newDb(); });
afterAll(async () => { await db.close(); });

type R = { block: number; op: string; unit: string; phone?: string | null; raw?: string | null };
async function stage(rows: R[]) {
  const imp = (await db.su.query(`insert into public.excel_imports(file_name, file_sha256, status, created_by) values ('p.xlsx',$1,'confirmed',$2) returning id`, [`ph-${++sha}`, db.admin])).rows[0].id as string;
  const blocks = new Map<number, string>(); let k = 1;
  for (const r of rows) {
    if (!blocks.has(r.block)) blocks.set(r.block, (await db.su.query(`insert into public.import_blocks(import_id, block_index, start_column, header_variant) values ($1,$2,'A','X') returning id`, [imp, r.block])).rows[0].id);
    await db.su.query(`insert into public.import_rows(block_id, source_row, unit_code, operator_code, national_id, full_name, daily_rate_cents, phone_e164, raw_phone, review_status)
      values ($1,$2,$3,$4,$5,'NOMBRE',3900,$6,$7,'approved')`, [blocks.get(r.block), ++k, r.unit, r.op, `N-${r.op}`, r.phone ?? null, r.raw ?? r.phone ?? null]);
  }
  return imp;
}
const apply = (imp: string) => db.as(db.admin, (q) => q.one(`select public.apply_import($1) r`, [imp]).then((x) => x.r));
const driver = async (op: string) => (await db.su.query(`select phone_e164, whatsapp_consent, whatsapp_consent_at from public.drivers where operator_code=$1`, [op])).rows[0];

describe('apply_import y el teléfono de la columna WhatsApp', () => {
  it('conductor NUEVO: recibe el teléfono, pero NUNCA el consentimiento', async () => {
    const r = await apply(await stage([{ block: 1, op: 'PH1', unit: 'PHU1', phone: '+50766123456', raw: '6612-3456' }, { block: 1, op: 'PH2', unit: 'PHU2' }]));
    expect(r).toMatchObject({ drivers_created: 2, phones_set: 1, phone_conflicts: 0 });
    expect(await driver('PH1')).toEqual({ phone_e164: '+50766123456', whatsapp_consent: false, whatsapp_consent_at: null });
    expect((await driver('PH2')).phone_e164).toBeNull();
    expect((await db.su.query(`select count(*)::int n from public.driver_consents`)).rows[0].n).toBe(0);
  });
  it('conductor existente: se completa si no tiene teléfono, no cambia si es el mismo y NO se sobrescribe si difiere', async () => {
    await db.su.query(`insert into public.drivers(operator_code, national_id, first_name, phone_e164) values ('PH3','N-PH3','Con teléfono','+50760000003'), ('PH4','N-PH4','Mismo','+50760000004')`);
    await db.su.query(`insert into public.drivers(operator_code, national_id, first_name) values ('PH5','N-PH5','Sin teléfono')`);
    const r = await apply(await stage([
      { block: 1, op: 'PH3', unit: 'PHU3', phone: '+50761111111' },   // difiere
      { block: 1, op: 'PH4', unit: 'PHU4', phone: '+50760000004' },   // igual
      { block: 1, op: 'PH5', unit: 'PHU5', phone: '+50762222222' }]));// vacío → se completa
    expect(r).toMatchObject({ drivers_linked: 3, phones_set: 1, phone_conflicts: 1 });
    expect(r.issues).toContainEqual({ operator: 'PH3', issue: 'phone_conflict', current: '+50760000003', imported: '+50761111111' });
    expect((await driver('PH3')).phone_e164).toBe('+50760000003');
    expect((await driver('PH4')).phone_e164).toBe('+50760000004');
    expect((await driver('PH5'))).toMatchObject({ phone_e164: '+50762222222', whatsapp_consent: false });
  });
  it('números distintos para el mismo operario entre bloques: no se adivina (phone_ambiguous) y los inválidos se ignoran', async () => {
    const r = await apply(await stage([
      { block: 1, op: 'PH6', unit: 'PHU6', phone: '+50763333333' }, { block: 2, op: 'PH6', unit: 'PHU6', phone: '+50764444444' },
      { block: 1, op: 'PH7', unit: 'PHU7', phone: 'no-es-telefono' }, { block: 2, op: 'PH7', unit: 'PHU7', phone: '+50765555555' }]));
    expect(r.issues).toContainEqual({ operator: 'PH6', issue: 'phone_ambiguous' });
    expect((await driver('PH6')).phone_e164).toBeNull();
    expect((await driver('PH7')).phone_e164).toBe('+50765555555');
  });
  it('un consentimiento previo no se toca al completar el teléfono', async () => {
    await db.su.query(`insert into public.drivers(operator_code, national_id, first_name, phone_e164, whatsapp_consent, whatsapp_consent_at) values ('PH8','N-PH8','Consentido','+50766666666', true, now())`);
    await apply(await stage([{ block: 1, op: 'PH8', unit: 'PHU8', phone: '+50767777777' }]));
    expect(await driver('PH8')).toMatchObject({ phone_e164: '+50766666666', whatsapp_consent: true });
  });
});

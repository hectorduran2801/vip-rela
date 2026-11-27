import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newDb, type Db } from './harness.js';

/** 0049: la columna MENSAJE se guarda en la asignación al aplicar la importación; por cuenta; sin la columna se conserva. */
let db: Db; let a: Awaited<ReturnType<Db['driverWithAssignment']>>; let b: typeof a; let other: string; let c: typeof a;
const MAIN = '00000000-0000-4000-8000-000000000001';
beforeAll(async () => {
  db = await newDb();
  a = await db.driverWithAssignment({ code: 'MS1', unit: 'P651' }); b = await db.driverWithAssignment({ code: 'MS2', unit: 'P661' });
  other = (await db.su.query(`insert into public.accounts(name) values ('otra') returning id`)).rows[0].id;
  c = await db.driverWithAssignment({ code: 'MS3', unit: 'ZZ-9' });
  for (const [t, id] of [['drivers', c.driver], ['units', c.unit], ['assignments', c.assignment]] as const) await db.su.query(`update public.${t} set account_id=$2 where id=$1`, [id, other]);
  await db.su.query(`update public.units set code='P651' where id=$1`, [c.unit]);                                   // mismo código en otra cuenta
}, 120_000);
afterAll(async () => { await db.close(); });

let n = 0;
async function importFile(rows: [string, boolean | null][], account = MAIN) {
  n += 1;
  const imp = (await db.su.query(`insert into public.excel_imports(file_name, file_sha256, source_kind, created_by, account_id) values ('d.xlsx',$1,'collection_flat',$2,$3) returning id`, [`ms-${n}`, db.admin, account])).rows[0].id;
  const blk = (await db.su.query(`insert into public.import_blocks(import_id, block_index, start_column, header_variant) select $1,0,2, header_variant from (values ('flat')) v(header_variant) returning id`, [imp])).rows[0].id;
  let i = 3;
  for (const [unit, flag] of rows) await db.su.query(`insert into public.import_rows(block_id, source_row, unit_code, send_flag) values ($1,$2,$3,$4)`, [blk, i++, unit, flag]);
  await db.su.query(`update public.excel_imports set status='applied', applied_at=now() where id=$1`, [imp]);
}
const flag = async (asg: string) => (await db.su.query(`select send_default d from public.assignments where id=$1`, [asg])).rows[0].d;

describe('selección de mensajes guardada', () => {
  it('SÍ = true, NO = false; se actualiza con cada importación y solo en su cuenta', async () => {
    await importFile([['P651', true], ['p 661', false]]);
    expect([await flag(a.assignment), await flag(b.assignment), await flag(c.assignment)]).toEqual([true, false, false]);   // la otra cuenta (también P651) no cambia
    await importFile([['P651', false], ['P661', true]]);
    expect([await flag(a.assignment), await flag(b.assignment)]).toEqual([false, true]);
    await importFile([['P651', true]], other);
    expect([await flag(a.assignment), await flag(c.assignment)]).toEqual([false, true]);
  });
  it('un archivo sin la columna conserva lo guardado; no crea ningún mensaje', async () => {
    await importFile([['P651', null], ['P661', null]]);
    expect([await flag(a.assignment), await flag(b.assignment)]).toEqual([false, true]);
    expect((await db.su.query(`select count(*)::int n from public.whatsapp_test_messages`)).rows[0].n).toBe(0);
  });
});

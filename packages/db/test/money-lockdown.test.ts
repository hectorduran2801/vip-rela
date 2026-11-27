import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newDb, type Db } from './harness.js';

/** 0029: los pagos solo entran por el Excel (también para PostgREST/RPC) + fecha de corte de los datos + importación histórica segura. */
let db: Db;
beforeAll(async () => { db = await newDb({ strictMoney: true }); }, 120_000);
afterAll(async () => { await db.close(); });

const MON = '2026-11-02';
const stage = async (rows: { unit: string; op: string; name: string; rate: number; days?: (number | null)[] }[]): Promise<string> => {
  const imp = (await db.su.query(`insert into public.excel_imports(file_name, file_sha256, status, source_kind, created_by) values ('plano.xlsx',$1,'confirmed','collection_flat',$2) returning id`, [`lock-${Math.random()}`, db.admin])).rows[0].id;
  const blk = (await db.su.query(`insert into public.import_blocks(import_id, block_index, start_column, header_variant) values ($1,1,'A','PLANO') returning id`, [imp])).rows[0].id;
  let k = 1;
  for (const r of rows) await db.su.query(`insert into public.import_rows(block_id, source_row, unit_code, operator_code, full_name, daily_rate_cents, phone_e164, raw_phone, day_amounts_cents) values ($1,$2,$3,$4,$5,$6,'+50761110000','+50761110000',$7::bigint[])`,
    [blk, ++k, r.unit, r.op, r.name, r.rate, r.days ?? null]);
  return imp;
};
const preview = (imp: string, week: string, dd: string | null = null) => db.as(db.admin, async (q) => (await q.one(`select public.preview_collection_sync($1,$2::date,$3::date) r`, [imp, week, dd])).r);
const apply = (imp: string, week: string, dd: string | null, confirm = false, note: string | null = null) =>
  db.as(db.admin, async (q) => (await q.one(`select public.apply_collection_sync($1,$2::date,$3,$4,$5::date) r`, [imp, week, note, confirm, dd])).r);

describe('0029 · el dinero solo entra por el Excel', () => {
  it('ni ADMIN ni SUPER_ADMIN ni anon pueden ejecutar las operaciones manuales por RPC; el servicio sí conserva el permiso', async () => {
    const x = await db.driverWithAssignment({ code: 'LK1', unit: 'LKU1', dailyCents: 3600 });
    for (const who of [db.admin, db.opsAdmin]) {
      expect(await db.as(who, (q) => q.fails(`select public.register_payment($1,'cash',1000,'k-${who}',null,null,false,null)`, [x.assignment]))).toMatch(/permission denied/);
      expect(await db.as(who, (q) => q.fails(`select public.void_payment(gen_random_uuid(),'x')`))).toMatch(/permission denied/);
      expect(await db.as(who, (q) => q.fails(`select public.create_adjustment($1, 100, current_date, 'x', 'k-adj-${who}')`, [x.assignment]))).toMatch(/permission denied/);
      expect(await db.as(who, (q) => q.fails(`select public.close_week('2026-11-02')`))).toMatch(/permission denied/);
      expect(await db.as(who, (q) => q.fails(`select public.generate_daily_charges(current_date)`))).toMatch(/permission denied/);
    }
    expect(await db.asAnon((q) => q.fails(`select public.register_payment($1,'cash',1000,'k-anon',null,null,false,null)`, [x.assignment]))).toMatch(/permission denied/);
    const svc = (await db.su.query(`select bool_and(has_function_privilege('service_role', p.oid, 'execute') and not has_function_privilege('authenticated', p.oid, 'execute')) ok
      from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('register_payment','void_payment','create_adjustment','close_week','generate_daily_charges')`)).rows[0];
    expect(svc.ok).toBe(true);
    expect(await db.as(db.admin, (q) => q.fails(`update public.payment_methods set commission_cents = 1`))).toMatch(/permission denied/);
    expect(await db.as(db.admin, (q) => q.fails(`insert into public.payments(assignment_id, method_id, gross_cents, net_cents, idempotency_key) values ($1, gen_random_uuid(), 1, 1, 'k')`, [x.assignment]))).toMatch(/permission denied/);
  });
  it('la importación del Excel sigue registrando y corrigiendo pagos (usa las funciones internas como definidor)', async () => {
    const a = await stage([{ unit: 'LK-U2', op: 'LKOP2', name: 'LOCK DOS', rate: 3000, days: [3000, null, null, null, null, null, null] }]);
    expect((await apply(a, MON, '2026-11-02')).payments).toMatchObject({ new: 1 });
    const b = await stage([{ unit: 'LK-U2', op: 'LKOP2', name: 'LOCK DOS', rate: 3000, days: [2500, null, null, null, null, null, null] }]);
    expect((await apply(b, MON, '2026-11-03')).payments).toMatchObject({ changed: 1 });
    expect((await db.su.query(`select count(*)::int n, coalesce(sum(net_cents) filter (where voided_at is null),0)::int s from public.payments p join public.assignments a on a.id=p.assignment_id join public.units u on u.id=a.unit_id where u.code='LK-U2'`)).rows[0]).toEqual({ n: 2, s: 2500 });
  });
});

describe('0029 · fecha de corte de los datos', () => {
  it('la copia del lunes subida DESPUÉS de la del martes (misma semana) se detecta por la fecha de corte, aunque la semana y la subida no lo delaten', async () => {
    const W = '2026-11-09';
    const martes = await stage([{ unit: 'DD-U1', op: 'DDOP1', name: 'CORTE UNO', rate: 3000, days: [3000, 3000, null, null, null, null, null] }]);
    await apply(martes, W, '2026-11-10');
    const lunes = await stage([{ unit: 'DD-U1', op: 'DDOP1', name: 'CORTE UNO', rate: 3000, days: [3000, null, null, null, null, null, null] }]);     // subida DESPUÉS, datos del lunes
    const pv = await preview(lunes, W, '2026-11-09');
    expect(pv.guard).toMatchObject({ historical: true, dataDate: '2026-11-09', newerData: { dataDate: '2026-11-10' } });
    expect(pv.guard.reasons).toContain('older_data_date');
    expect(await db.as(db.admin, (q) => q.fails(`select public.apply_collection_sync($1,$2::date,null,false,'2026-11-09')`, [lunes, W]))).toBe('historical_import_requires_confirmation');
    expect((await preview(lunes, W, '2026-11-11')).guard.reasons).not.toContain('older_data_date');           // con fecha de corte posterior no hay alerta
    await apply(lunes, W, '2026-11-09', true, 'recupero la copia del lunes a propósito');
    expect((await db.su.query(`select data_date::text d, historical, historical_reasons from public.collection_sync_runs where import_id=$1`, [lunes])).rows[0]).toMatchObject({ d: '2026-11-09', historical: true });
  });
  it('la fecha de corte no puede ser futura', async () => {
    const imp = await stage([{ unit: 'DD-U2', op: 'DDOP2', name: 'CORTE DOS', rate: 3000 }]);
    expect(await db.as(db.admin, (q) => q.fails(`select public.preview_collection_sync($1,$2::date,'2099-01-01')`, [imp, MON]))).toBe('invalid_data_date');
  });
});

describe('0029 · importar una semana anterior no toca asignaciones actuales', () => {
  it('si la unidad empezó DESPUÉS de esa semana: error claro y no se modifica nada (antes era assignment_overlap)', async () => {
    const W2 = '2026-11-16', W1 = '2026-11-02';
    await apply(await stage([{ unit: 'HB-U1', op: 'HBOP1', name: 'HISTORICO UNO', rate: 3000 }]), W2, '2026-11-16');
    const before = (await db.su.query(`select count(*)::int n, min(valid_from)::text vf from public.assignments a join public.units u on u.id=a.unit_id where u.code='HB-U1'`)).rows[0];
    const old = await stage([{ unit: 'HB-U1', op: 'HBOP1', name: 'HISTORICO UNO', rate: 3000, days: [3000, null, null, null, null, null, null] }]);
    const pv = await preview(old, W1, '2026-11-03');
    expect(pv.units).toMatchObject({ errors: 1 }); expect(pv.warnings.map((w: { code: string }) => w.code)).toContain('historical_before_assignment');
    expect((await db.su.query(`select count(*)::int n, min(valid_from)::text vf from public.assignments a join public.units u on u.id=a.unit_id where u.code='HB-U1'`)).rows[0]).toEqual(before);
  });
});

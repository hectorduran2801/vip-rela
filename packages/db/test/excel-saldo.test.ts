import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newDb, type Db, type Q } from './harness.js';

/** 0032: el saldo que se comunica es el del Excel (último SALDO válido importado); el devengo interno de cuotas no lo modifica. */
let db: Db; let n = 0;
beforeAll(async () => { db = await newDb(); }, 120_000);
afterAll(async () => { await db.close(); });
const adm = <T>(fn: (q: Q) => Promise<T>) => db.as(db.opsAdmin, fn);
const MON = '2026-11-16', MON2 = '2026-11-23', MON3 = '2026-11-30';
const mk = async () => { n += 1; const x = await db.driverWithAssignment({ code: `XS${n}`, unit: `XSU${n}`, dailyCents: 3000 });
  await db.su.query(`update public.drivers set phone_e164=$2, first_name='Ana', last_name='' where id=$1`, [x.driver, `+507611200${String(10 + n)}`]);
  await db.su.query(`update public.assignments set collect_commission=false where id=$1`, [x.assignment]); return x; };          // estas pruebas miden el cálculo base: la comisión tiene sus propias pruebas
const snap = (x: { assignment: string; driver: string }, week: string, saldo: number | null) => db.su.query(
  `insert into public.collection_week_units(week_start, unit_id, unit_code, assignment_id, driver_id, saldo_excel_cents, first_import_id, last_import_id)
   select $1::date, a.unit_id, 'X', a.id, a.driver_id, $3, null, null from public.assignments a where a.id=$2
   on conflict (week_start, unit_id) do update set saldo_excel_cents = excluded.saldo_excel_cents`, [week, x.assignment, saldo]);
const vars = async (asg: string, date = MON2) => (await db.su.query(`select app_private.template_vars($1,$2::date) v`, [asg, date])).rows[0].v;
const charge = (asg: string, d: string, cents: number) => db.su.query(`insert into public.charges(assignment_id, kind, charge_date, amount_cents, week_start) values ($1,'daily',$2,$3,app_private.week_start_of($2::date))`, [asg, d, cents]);

describe('saldo = último SALDO válido del Excel', () => {
  it('asignación SIN importación del Excel: conserva el cálculo anterior', async () => {
    const x = await mk(); await charge(x.assignment, MON, 3000);
    expect((await vars(x.assignment, MON)).saldo_total).toBe('$30.00');
    expect((await db.su.query(`select managed from app_private.excel_saldo($1)`, [x.assignment])).rows[0].managed).toBe(false);
  });
  it('gestionada por el Excel: el saldo no crece con las cuotas diarias ni cambia con pagos; un SALDO vacío en la importación más reciente reemplaza la deuda anterior (no se conserva una obsoleta)', async () => {
    const x = await mk(); await snap(x, MON, 10000); await snap(x, MON2, null);                     // la 2.ª semana trajo SALDO vacío → $0.00 de deuda anterior (no vale el de la 1.ª)
    for (const d of ['2026-11-23', '2026-11-24', '2026-11-25']) await charge(x.assignment, d, 3000);  // devengo interno: NO cambia lo comunicado
    const v = await vars(x.assignment);
    expect(v).toMatchObject({ saldo_total: '$30.00', deuda_anterior: '$0.00', credito: '$0.00', cuota_hoy: '$30.00', detalle_deuda: 'Su saldo pendiente es de $30.00.' });
    expect(v.pendiente_hoy).toBeNull(); expect(v.deuda_semanal).toBeNull(); expect(v.cuenta_semana).toBeNull();      // variables del devengo interno: sin resolver
    await snap(x, MON3, 5000);                                                                        // nueva importación con otro saldo
    expect((await vars(x.assignment, MON3)).saldo_total).toBe('$80.00');
    await snap(x, MON3, -2500);                                                                       // saldo negativo = a favor
    expect(await vars(x.assignment, MON3)).toMatchObject({ saldo_total: '$5.00', deuda_anterior: '$0.00', credito: '$0.00', detalle_deuda: 'Su saldo pendiente es de $5.00.' });
  });
  it('SALDO vacío en un Excel importado = $0.00 de deuda anterior (no «desconocido»); una unidad NUNCA importada no es gestionada', async () => {
    const x = await mk(); await snap(x, MON, 0); await snap(x, MON2, null);
    expect(await vars(x.assignment)).toMatchObject({ saldo_total: '$30.00', deuda_anterior: '$0.00', credito: '$0.00', detalle_deuda: 'Su saldo pendiente es de $30.00.' });
    const y = await mk(); await snap(y, MON, null);                                                  // celda vacía desde la primera importación: cuotas de lun 16 a lun 23 = 7 × $30
    expect(await vars(y.assignment)).toMatchObject({ saldo_total: '$210.00', deuda_anterior: '$0.00', detalle_deuda: 'Su saldo pendiente es de $210.00.' });
    const z = await mk();                                                                             // sin ninguna fila de importación
    expect((await db.su.query(`select managed, saldo_cents from app_private.excel_saldo($1)`, [z.assignment])).rows[0]).toEqual({ managed: false, saldo_cents: null });
  });
  it('SALDO vacío: el mensaje SÍ se puede enviar y usa el mismo saldo total (cuotas de la semana) que la variable', async () => {
    const x = await mk(); await snap(x, MON2, null);
    await db.su.query(`insert into public.excel_imports(file_name, file_sha256, status, source_kind, created_by, applied_at) values ('d.xlsx', $1, 'applied', 'collection_flat', $2, now())`, [`sha-${Math.random()}`, db.opsAdmin]);
    const t = (await db.su.query(`insert into public.message_templates(name, body) values ('Saldo', 'Su saldo es {{saldo_total}}') returning id`)).rows[0].id;
    const m = await adm((q) => q.one(`select * from public.create_collection_message($1,$2,$3,false)`, [x.assignment, t, `k-${Math.random()}-yyyy`]));
    const today = (await db.su.query(`select app_private.template_vars($1,(now() at time zone 'America/Panama')::date)->>'saldo_total' t`, [x.assignment])).rows[0].t;
    expect(m.body).toBe(`Su saldo es ${today}`);
  });
  it('catálogo: sin {{apellido}}, {{pendiente_hoy}}, {{deuda_semanal}} ni {{cuenta_semana}}; saldo_total se describe como SALDO + cuotas faltantes', async () => {
    const rows = await adm((q) => q.rows(`select code, description from public.template_variables()`));
    const codes = rows.map((r) => r.code);
    for (const gone of ['apellido', 'pendiente_hoy', 'deuda_semanal', 'cuenta_semana']) expect(codes).not.toContain(gone);
    expect(rows.find((r) => r.code === 'saldo_total')!.description).toContain('SALDO del Excel (semanas anteriores)');
  });
  it('Inicio: «pendiente por cobrar» suma los SALDOS del Excel (positivos) para lo gestionado y el cálculo anterior para el resto', async () => {
    const a = await mk(); const b = await mk(); await snap(a, MON2, 12000); await snap(b, MON2, -500); await charge(a.assignment, '2026-11-24', 3000);
    const before = (await adm((q) => q.one(`select public.dashboard_summary() s`))).s.collections;
    const c = await mk(); await snap(c, MON2, 4000);
    const after = (await adm((q) => q.one(`select public.dashboard_summary() s`))).s.collections;
    expect(Number(after.pending_total_cents) - Number(before.pending_total_cents)).toBe(4000);
    expect(Number(after.drivers_with_debt) - Number(before.drivers_with_debt)).toBe(1);
  });
});

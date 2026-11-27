import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MON, MON2, addDays, chargeWeek, pay } from './fixtures.js';
import { newDb, type Db, type Q } from './harness.js';

/**
 * 0026 · Sincronización de la cobranza del Excel PLANO. Todas las fechas son fijas y pasadas (sin depender de la hora real).
 * MON = 2026-03-02 · MON2 = 2026-03-09 · MON3 = 2026-03-16 · PREV = 2026-02-23 (semana anterior a MON).
 */
const MON3 = addDays(MON, 14);
const PREV = addDays(MON, -7);

type Row = { unit?: string | null; op?: string | null; nid?: string | null; name?: string | null; rate?: number | null; ag?: string | null; saldo?: string | null;
  phone?: string | null; rawPhone?: string | null; days?: (number | null)[] | null };
const NONE = [null, null, null, null, null, null, null] as (number | null)[];

function kit(db: Db) {
  let sha = 0;
  const stage = async (rows: Row[], opts: { status?: string; kind?: string } = {}): Promise<string> => {
    const imp = (await db.su.query(`insert into public.excel_imports(file_name, file_sha256, status, source_kind, created_by) values ('plano.xlsx',$1,$2,$3,$4) returning id`,
      [`sync-${++sha}-${Math.random()}`, opts.status ?? 'confirmed', opts.kind ?? 'collection_flat', db.admin])).rows[0].id;
    const blk = (await db.su.query(`insert into public.import_blocks(import_id, block_index, start_column, header_variant) values ($1,1,'A','PLANO') returning id`, [imp])).rows[0].id;
    let k = 1;
    for (const r of rows)
      await db.su.query(`insert into public.import_rows(block_id, source_row, unit_code, operator_code, national_id, full_name, daily_rate_cents, raw_agreement, raw_saldo, phone_e164, raw_phone, day_amounts_cents)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::bigint[])`,
        [blk, ++k, r.unit ?? null, r.op ?? null, r.nid ?? null, r.name ?? null, r.rate ?? null, r.ag ?? null, r.saldo ?? null, r.phone ?? null, r.rawPhone ?? r.phone ?? null, r.days ?? null]);
    return imp;
  };
  const preview = (imp: string, week: string, who = db.admin) => db.as(who, async (q) => (await q.one(`select public.preview_collection_sync($1,$2::date) r`, [imp, week])).r);
  const apply = (imp: string, week: string, who = db.admin) => db.as(who, async (q) => (await q.one(`select public.apply_collection_sync($1,$2::date,'prueba',true) r`, [imp, week])).r);
  const one = async (sql: string, params: unknown[] = []) => (await db.su.query(sql, params)).rows[0];
  const rows = async (sql: string, params: unknown[] = []) => (await db.su.query(sql, params)).rows;
  /** Huella de todo lo que una importación puede tocar (para probar «0 movimientos»). */
  const fp = (strictAudit = true) => one(`select
    (select count(*) from public.payments)::int pay, (select count(*) from public.payments where voided_at is null)::int pay_active,
    (select count(*) from public.charges)::int ch, (select count(*) from public.adjustments)::int adj, (select count(*) from public.payment_allocations)::int alloc,
    (select count(*) from public.audit_logs ${strictAudit ? '' : `where entity <> 'excel_imports'`})::int audit,
    (select count(*) from public.excel_payment_days)::int days, (select count(*) from public.excel_payment_changes)::int chg,
    (select count(*) from public.collection_week_units)::int snaps, (select count(*) from public.collection_week_unit_changes)::int snapchg,
    (select count(*) from public.assignments)::int asg, (select count(*) from public.rates)::int rates, (select count(*) from public.drivers)::int drv,
    (select count(*) from public.units)::int units, (select count(*) from public.unit_agreement_history)::int agh, (select count(*) from public.notification_jobs)::int jobs,
    (select md5(coalesce(string_agg(id::text || gross_cents || coalesce(voided_at::text, ''), ',' order by id), '')) from public.payments) payh,
    (select md5(coalesce(string_agg(id::text || amount_cents || kind, ',' order by id), '')) from public.charges) chh`);
  const asgOf = async (unit: string, week?: string) => (await one(
    `select a.id, a.driver_id, a.valid_from::text vf, a.valid_to::text vt from public.assignments a join public.units u on u.id = a.unit_id
      where upper(u.code) = upper($1) and ($2::date is null or (a.valid_from <= $2::date + 6 and (a.valid_to is null or a.valid_to >= $2::date))) order by a.valid_from desc limit 1`, [unit, week ?? null]));
  const pos = (asg: string, asOf: string | null = null) => one(`select charged_cents::int ch, net_cents::int net, pending_cents::int pending, credit_cents::int credit from public.assignment_position($1, $2::date)`, [asg, asOf]);
  const codes = (r: any) => (r.warnings as { code: string }[]).map((w) => w.code);
  return { stage, preview, apply, one, rows, fp, asgOf, pos, codes };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('0026 · flujo principal (primera importación, repetición, saldo, cuota, acuerdo, operario, unidad nueva, semanas)', () => {
  let db: Db; let k: ReturnType<typeof kit>;
  let legacy: { driver: string; unit: string; assignment: string }; let legacyHash: Record<string, string>; let legacyAuditMax: number; let legacyIds: Record<'pay' | 'ch' | 'adj' | 'clo', string[]>;
  beforeAll(async () => {
    db = await newDb(); k = kit(db);
    // Historial PREVIO (debe quedar intacto): conductor, cargos de la semana anterior, un pago manual, un ajuste y el cierre de esa semana.
    legacy = await db.driverWithAssignment({ code: 'LEG1', unit: 'LEG-U1', dailyCents: 3000, from: '2026-01-01', phone: '+50761110000' });
    await chargeWeek(db, PREV);
    await db.as(db.admin, (q) => pay(q, legacy.assignment, 'cash', 5000, { paidAt: `${addDays(PREV, 2)}T12:00:00-05:00` }));
    await db.as(db.admin, (q) => q.one(`select public.create_adjustment($1, -200, $2::date, 'ajuste previo de prueba', 'legacy-adj-1')`, [legacy.assignment, addDays(PREV, 3)]));
    await db.as(db.admin, (q) => q.query(`select public.close_week($1::date)`, [PREV]));
    legacyIds = {
      pay: (await k.rows(`select id from public.payments where assignment_id=$1 order by id`, [legacy.assignment])).map((x) => x.id),
      ch: (await k.rows(`select id from public.charges where assignment_id=$1 order by id`, [legacy.assignment])).map((x) => x.id),
      adj: (await k.rows(`select id from public.adjustments where assignment_id=$1 order by id`, [legacy.assignment])).map((x) => x.id),
      clo: (await k.rows(`select id from public.weekly_closures where assignment_id=$1 order by id`, [legacy.assignment])).map((x) => x.id) };
    legacyAuditMax = Number((await k.one(`select max(id) m from public.audit_logs`)).m);
    legacyHash = await legacySnapshot();
  }, 120_000);
  afterAll(async () => { await db.close(); });
  /** Huella de las filas PREVIAS (por id) de pagos, cargos, ajustes, cierres y de la auditoría anterior. */
  const legacySnapshot = async () => (await k.one(`select
    (select md5(coalesce(string_agg(row(p.*)::text, '|' order by p.id), '')) from public.payments p where p.id = any ($1::uuid[])) pay,
    (select md5(coalesce(string_agg(row(c.*)::text, '|' order by c.id), '')) from public.charges c where c.id = any ($2::uuid[])) ch,
    (select md5(coalesce(string_agg(row(a.*)::text, '|' order by a.id), '')) from public.adjustments a where a.id = any ($3::uuid[])) adj,
    (select md5(coalesce(string_agg(row(w.*)::text, '|' order by w.id), '')) from public.weekly_closures w where w.id = any ($4::uuid[])) clo,
    (select md5(coalesce(string_agg(row(l.*)::text, '|' order by l.id), '')) from public.audit_logs l where l.id <= $5) aud`,
    [legacyIds.pay, legacyIds.ch, legacyIds.adj, legacyIds.clo, legacyAuditMax])) as Record<string, string>;

  const P121 = (over: Partial<Row> = {}): Row => ({ unit: 'P121', op: 'OP1', nid: '8-111-111', name: 'ANA PEREZ', rate: 3000, ag: 'ACUERDO A', saldo: '20', phone: '+50760000001',
    days: [3000, 3000, null, null, null, null, null], ...over });
  let imp1 = '';

  it('1 · primera importación: vista previa de solo lectura y luego aplicación (unidad, operario, asignación, tarifa, apertura, pagos, foto)', async () => {
    imp1 = await k.stage([P121(), { unit: 'P122', op: 'OP22', nid: '8-222-222', name: 'BEN RUIZ', rate: 3000, days: NONE }]);
    const before = await k.fp();
    const pv = await k.preview(imp1, MON);
    expect(await k.fp()).toEqual(before);                                              // la vista previa no escribe NADA
    expect(pv).toMatchObject({ week_start: MON, applied: false, already_up_to_date: false, units: { total: 2, new: 2, unchanged: 0, changed: 0, errors: 0, without_driver: 0 },
      payments: { new: 2, changed: 0, zeroed: 0, unchanged: 0 }, saldo: { create: 1, unchanged: 0, adjust: 0 }, rate_changes: [] });
    const r = await k.apply(imp1, MON);
    expect(r).toMatchObject({ applied: true, units: { new: 2 }, payments: { new: 2, net_delta_cents: 6000 }, saldo: { create: 1, delta_cents: 2000 }, drivers: { created: 2 }, assignments_created: 2 });
    const a = await k.asgOf('P121', MON);
    expect(a.vf).toBe(MON);
    expect((await k.rows(`select daily_amount_cents::int c, valid_from::text f, valid_to::text t from public.rates where assignment_id=$1`, [a.id]))).toEqual([{ c: 3000, f: MON, t: null }]);
    // Apertura = el SALDO del Excel, fechada el domingo anterior, sin pagos ni deuda duplicados
    expect(await k.rows(`select kind, amount_cents::int a, charge_date::text d from public.charges where assignment_id=$1`, [a.id])).toEqual([{ kind: 'opening', a: 2000, d: addDays(MON, -1) }]);
    expect((await k.pos(a.id, addDays(MON, -1))).pending).toBe(2000);
    const pays = await k.rows(`select p.gross_cents::int g, p.commission_cents::int c, p.week_start::text w, (p.paid_at at time zone 'America/Panama')::text lp, m.code mc, m.label ml, p.idempotency_key ik
      from public.payments p join public.payment_methods m on m.id=p.method_id where p.assignment_id=$1 order by p.paid_at`, [a.id]);
    expect(pays).toMatchObject([{ g: 3000, c: 0, w: MON, mc: 'excel', ml: 'Excel', lp: `${MON} 12:00:00` }, { g: 3000, c: 0, w: MON, lp: `${addDays(MON, 1)} 12:00:00` }]);
    expect(pays[0].ik).toBe(`excel:${a.id}:${MON}:r1`);
    // El operario no recibe consentimiento de WhatsApp (aunque traiga teléfono)
    const d = await k.one(`select whatsapp_consent, phone_e164, national_id from public.drivers where operator_code='OP1'`);
    expect(d).toEqual({ whatsapp_consent: false, phone_e164: '+50760000001', national_id: '8-111-111' });   // la cédula, cuando viene, se guarda
    expect((await k.one(`select count(*)::int n from public.driver_consents`)).n).toBe(0);
    // Foto semanal
    expect(await k.one(`select unit_code, daily_rate_cents::int r, agreement, phone_e164, saldo_excel_cents::int s, saldo_pending_before_cents::int pb, saldo_delta_cents::int sd from public.collection_week_units where week_start=$1 and unit_code='P121'`, [MON]))
      .toEqual({ unit_code: 'P121', r: 3000, agreement: 'ACUERDO A', phone_e164: '+50760000001', s: 2000, pb: 0, sd: 2000 });
    expect((await k.one(`select status, summary -> 'collection_sync' -> $2 ->> 'already_up_to_date' u from public.excel_imports where id=$1`, [imp1, MON]))).toEqual({ status: 'applied', u: 'false' });
    expect((await k.one(`select count(*)::int n from public.audit_logs where action='apply_collection_sync'`)).n).toBe(1);
    await chargeWeek(db, MON);                                                          // el motor genera las cuotas de la semana
  });

  it('2 · el mismo archivo otra vez: estado idéntico, 0 movimientos y 0 auditoría extra', async () => {
    const before = await k.fp();                                                       // auditoría total (incluye excel_imports)
    const r = await k.apply(imp1, MON);                                                // reaplicar la MISMA importación
    expect(r).toMatchObject({ already_up_to_date: true, units: { new: 0, changed: 0, unchanged: 2 }, payments: { new: 0, changed: 0, zeroed: 0, unchanged: 2, skipped_empty: 12 },
      saldo: { create: 0, adjust: 0, unchanged: 1 }, rate_changes: [], snapshots: { created: 0, changed: 0 } });
    expect(await k.fp()).toEqual(before);
    // Un archivo nuevo con las mismas filas (código con otro formato: minúsculas y espacios) tampoco cambia nada de negocio
    const imp = await k.stage([P121({ unit: ' p 121 ' }), { unit: 'p122', op: 'OP22', nid: '8-222-222', name: 'BEN RUIZ', rate: 3000, days: NONE }]);
    const b2 = await k.fp(false);
    expect((await k.preview(imp, MON)).already_up_to_date).toBe(true);
    expect((await k.apply(imp, MON)).already_up_to_date).toBe(true);
    expect(await k.fp(false)).toEqual(b2);
    expect((await k.one(`select count(*)::int n from public.audit_logs where action='apply_collection_sync'`)).n).toBe(1);   // solo la primera aplicación real
  });

  it('3 · cambia solo el SALDO: se concilia la DIFERENCIA, nunca otro movimiento completo; vacío no hace nada; 0 explícito sí concilia', async () => {
    const a = await k.asgOf('P121', MON);
    let imp = await k.stage([P121({ saldo: '30' })]);
    const pv = await k.preview(imp, MON);
    expect(pv).toMatchObject({ saldo: { create: 0, adjust: 1, unchanged: 0 }, payments: { new: 0, unchanged: 2 } });
    await k.apply(imp, MON);
    expect(await k.rows(`select kind, amount_cents::int a from public.charges where assignment_id=$1 and kind <> 'daily' order by created_at`, [a.id]))
      .toEqual([{ kind: 'opening', a: 2000 }, { kind: 'adjustment', a: 1000 }]);                       // apertura 2000 + SOLO la diferencia (+1000)
    expect((await k.pos(a.id, addDays(MON, -1))).pending).toBe(3000);
    expect(await k.one(`select saldo_excel_cents::int s, saldo_pending_before_cents::int pb, saldo_delta_cents::int sd, saldo_steps from public.collection_week_units where week_start=$1 and unit_code='P121'`, [MON]))
      .toEqual({ s: 3000, pb: 0, sd: 3000, saldo_steps: 2 });
    // mismo SALDO otra vez: nada
    imp = await k.stage([P121({ saldo: '30' })]);
    expect((await k.apply(imp, MON)).saldo).toMatchObject({ create: 0, adjust: 0, unchanged: 1 });
    // SALDO menor: ajuste negativo auditado (crédito), no deuda
    imp = await k.stage([P121({ saldo: '10' })]);
    expect((await k.apply(imp, MON)).saldo).toMatchObject({ adjust: 1, delta_cents: -2000 });
    const adj = await k.rows(`select amount_cents::int a, effective_date::text d, reason from public.adjustments where assignment_id=$1 order by created_at`, [a.id]);
    expect(adj).toHaveLength(2); expect(adj[1]).toMatchObject({ a: -2000, d: addDays(MON, -1) });
    expect((await k.pos(a.id, addDays(MON, -1))).pending).toBe(1000);
    expect((await k.one(`select count(*)::int n from public.audit_logs where action in ('collection_sync_saldo_adjustment','collection_sync_opening') `)).n).toBe(3);
    // SALDO vacío = sin dato; 0 explícito = concilia a 0
    imp = await k.stage([P121({ saldo: null })]);
    expect((await k.apply(imp, MON))).toMatchObject({ already_up_to_date: true, saldo: { skip_empty: 1, adjust: 0 } });
    imp = await k.stage([P121({ saldo: '0' })]);
    expect((await k.apply(imp, MON)).saldo).toMatchObject({ adjust: 1, delta_cents: -1000 });
    expect((await k.pos(a.id, addDays(MON, -1))).pending).toBe(0);
    // volver a 20 (el valor original): solo la diferencia (+2000) vuelve a aparecer como ajuste positivo
    imp = await k.stage([P121({ saldo: '20' })]);
    expect((await k.apply(imp, MON)).saldo).toMatchObject({ adjust: 1, delta_cents: 2000 });
    expect((await k.pos(a.id, addDays(MON, -1))).pending).toBe(2000);
  });

  it('SALDO no duplica deuda: contra la posición ya calculada por VIP al domingo anterior (cargos + pagos previos), y los pagos de la semana no cuentan', async () => {
    const before = await k.pos(legacy.assignment, addDays(MON, -1));
    expect(before).toMatchObject({ ch: 18000, net: 5000, pending: 12800 });                  // 18.000 de cargos − 5.000 de pago manual − 200 de ajuste negativo previo
    // SALDO del Excel = lo que VIP ya calcula → no se crea nada; los pagos del lunes/martes no cambian la posición al domingo
    const imp = await k.stage([{ unit: 'LEG-U1', op: 'LEG1', rate: 3000, saldo: '128', days: [3000, 3000, null, null, null, null, null] }]);
    const f0 = await k.fp();
    const r = await k.apply(imp, MON);
    expect(r).toMatchObject({ saldo: { create: 0, adjust: 0, unchanged: 1 }, payments: { new: 2 }, units: { changed: 1, unchanged: 0 } });   // una unidad con pagos nuevos cuenta como «con cambios» (una sola vez)
    const f1 = await k.fp();
    expect(f1.ch).toBe(f0.ch); expect(f1.adj).toBe(f0.adj);                            // ni cargos ni ajustes nuevos
    expect(await k.pos(legacy.assignment, addDays(MON, -1))).toEqual(before);          // la posición al domingo NO se movió con los pagos de la semana
    expect((await k.pos(legacy.assignment)).pending).toBe(12800 + 18000 - 6000);       // 12.800 de la semana anterior + 18.000 de la semana generada − pagos del Excel (una sola vez)
    // SALDO distinto → solo la diferencia
    const imp2 = await k.stage([{ unit: 'LEG-U1', op: 'LEG1', rate: 3000, saldo: '130', days: [3000, 3000, null, null, null, null, null] }]);
    expect((await k.apply(imp2, MON)).saldo).toMatchObject({ create: 1, adjust: 0, delta_cents: 200 });       // la asignación aún no tiene apertura: la diferencia entra como `opening`
    expect(await k.rows(`select kind, amount_cents::int a, charge_date::text d from public.charges where assignment_id=$1 and kind <> 'daily'`, [legacy.assignment])).toEqual([{ kind: 'opening', a: 200, d: addDays(MON, -1) }]);
    expect((await k.pos(legacy.assignment, addDays(MON, -1))).pending).toBe(13000);
    expect((await k.apply(await k.stage([{ unit: 'LEG-U1', op: 'LEG1', rate: 3000, saldo: '135', days: [3000, 3000, null, null, null, null, null] }]), MON)).saldo).toMatchObject({ create: 0, adjust: 1, delta_cents: 500 });   // ya hay apertura: ajuste positivo
    expect((await k.pos(legacy.assignment, addDays(MON, -1))).pending).toBe(13500);
    // FIFO: lo más antiguo se cubre primero (cargos de la semana anterior antes que cualquier otro)
    const cov = await k.rows(`select charge_date::text d, covered_cents::int c from public.assignment_coverage($1) order by charge_date, charge_id`, [legacy.assignment]);
    expect(cov[0].d).toBe(addDays(PREV, 0)); expect(cov.slice(0, 3).every((x) => x.c > 0)).toBe(true);
  });

  it('4 · cambia la cuota: nueva tarifa con historial desde el lunes; los cargos ya generados no se tocan; con cargos en la semana rige hacia adelante e informa la diferencia', async () => {
    const a = await k.asgOf('P121', MON);
    const chBefore = (await k.one(`select md5(string_agg(id::text || amount_cents, ',' order by id)) h from public.charges where assignment_id=$1 and kind='daily'`, [a.id])).h;
    const imp = await k.stage([P121({ rate: 3500, days: NONE })]);
    const pv = await k.preview(imp, MON2);
    expect(pv.rate_changes).toMatchObject([{ unit_code: 'P121', previous_cents: 3000, new_cents: 3500, effective_from: MON2, generated_charges_in_week: 0 }]);
    await k.apply(imp, MON2);
    expect(await k.rows(`select daily_amount_cents::int c, valid_from::text f, valid_to::text t from public.rates where assignment_id=$1 order by valid_from`, [a.id]))
      .toEqual([{ c: 3000, f: MON, t: addDays(MON2, -1) }, { c: 3500, f: MON2, t: null }]);
    expect((await k.one(`select md5(string_agg(id::text || amount_cents, ',' order by id)) h from public.charges where assignment_id=$1 and kind='daily'`, [a.id])).h).toBe(chBefore);
    expect((await k.apply(await k.stage([P121({ rate: 3500, days: NONE })]), MON2)).rate_changes).toEqual([]);   // idempotente
    // P122: la cuota vigente nació en esta semana y ya hay cuotas generadas → es una CORRECCIÓN: se corrige en su lugar y lo generado se ajusta (sin tocar cargos ni pagos)
    const b = await k.asgOf('P122', MON);
    const payBefore = (await k.one(`select count(*)::int n, coalesce(sum(net_cents),0)::int s from public.payments where assignment_id=$1 and voided_at is null`, [b.id]));
    const imp2 = await k.stage([{ unit: 'P122', op: 'OP22', nid: '8-222-222', name: 'BEN RUIZ', rate: 4000, days: NONE }]);
    const pv2 = await k.preview(imp2, MON);
    expect(pv2.rate_changes).toMatchObject([{ previous_cents: 3000, new_cents: 4000, kind: 'correction' }]);
    expect(pv2.units).toMatchObject({ changed: 1 });
    const pend0 = (await k.pos(b.id, addDays(MON, 6))).pending;
    await k.apply(imp2, MON);
    expect(await k.rows(`select daily_amount_cents::int c, valid_from::text f, valid_to::text t from public.rates where assignment_id=$1`, [b.id])).toEqual([{ c: 4000, f: MON, t: null }]);
    expect((await k.one(`select sum(amount_cents)::int s, count(*)::int n from public.charges where assignment_id=$1 and kind='daily'`, [b.id]))).toEqual({ s: 18000, n: 6 });        // cargos originales intactos
    expect((await k.one(`select coalesce(sum(amount_cents),0)::int s, count(*)::int n from public.charges where assignment_id=$1 and kind='adjustment'`, [b.id]))).toEqual({ s: 6000, n: 6 }); // +1.000 por cada día
    expect((await k.one(`select count(*)::int n, coalesce(sum(net_cents),0)::int s from public.payments where assignment_id=$1 and voided_at is null`, [b.id]))).toEqual(payBefore);   // pagos intactos
    expect((await k.pos(b.id, addDays(MON, 6))).pending).toBe(pend0 + 6000);
    expect((await db.su.query(`select previous_daily_cents::int p, new_daily_cents::int n, adjusted_charges::int c, adjusted_cents::int s from public.rate_corrections where assignment_id=$1`, [b.id])).rows).toEqual([{ p: 3000, n: 4000, c: 6, s: 6000 }]);
    expect((await db.su.query(`select count(*)::int n from public.audit_logs where action='collection_sync_rate_correction' and entity_id=$1`, [b.id])).rows[0].n).toBe(1);
    expect((await k.apply(await k.stage([{ unit: 'P122', op: 'OP22', nid: '8-222-222', name: 'BEN RUIZ', rate: 4000, days: NONE }]), MON)).already_up_to_date).toBe(true);
    // segunda corrección encima de la primera (4.000 → 3.800): el ajuste parte de lo ya corregido, sin duplicar
    await k.apply(await k.stage([{ unit: 'P122', op: 'OP22', nid: '8-222-222', name: 'BEN RUIZ', rate: 3800, days: NONE }]), MON);
    expect((await k.pos(b.id, addDays(MON, 6))).pending).toBe(pend0 + 6 * 800);
  });

  it('5 · cambia el acuerdo: texto libre con historial; igual (mayúsculas/espacios) o vacío = sin cambio y sin auditoría', async () => {
    const u = (await k.one(`select id from public.units where code='P121'`)).id;
    const h0 = (await k.one(`select count(*)::int n from public.unit_agreement_history where unit_id=$1`, [u])).n;
    let imp = await k.stage([P121({ ag: '  acuerdo   a ', rate: 3500, days: NONE }), P121Empty()]);
    expect((await k.apply(imp, MON2)).units).toMatchObject({ changed: 0 });
    imp = await k.stage([P121({ ag: null, rate: 3500, days: NONE })]);
    expect((await k.apply(imp, MON2)).already_up_to_date).toBe(true);
    expect((await k.one(`select count(*)::int n from public.unit_agreement_history where unit_id=$1`, [u])).n).toBe(h0);
    imp = await k.stage([P121({ ag: 'ACUERDO B, paga los viernes', rate: 3500, days: NONE })]);
    expect((await k.preview(imp, MON2)).units).toMatchObject({ changed: 1, unchanged: 0 });
    expect((await k.apply(imp, MON2)).units).toMatchObject({ changed: 1 });
    expect((await k.one(`select agreement from public.units where id=$1`, [u])).agreement).toBe('ACUERDO B, paga los viernes');
    expect(await k.rows(`select agreement, previous_agreement, source from public.unit_agreement_history where unit_id=$1 order by id desc limit 1`, [u]))
      .toEqual([{ agreement: 'ACUERDO B, paga los viernes', previous_agreement: 'ACUERDO A', source: 'import' }]);
    expect((await k.one(`select count(*)::int n from public.unit_agreement_history where unit_id=$1`, [u])).n).toBe(h0 + 1);
    // La foto de la semana MON conserva el acuerdo de entonces; la de MON2 el nuevo
    expect((await k.one(`select agreement from public.collection_week_units where week_start=$1 and unit_code='P121'`, [MON])).agreement).toBe('ACUERDO A');
    expect((await k.one(`select agreement from public.collection_week_units where week_start=$1 and unit_code='P121'`, [MON2])).agreement).toBe('ACUERDO B, paga los viernes');
  });
  const P121Empty = (): Row => ({ unit: '   ', op: null, nid: null, name: null, rate: null, days: null });

  it('6 · cambia el operario de la unidad: cierra la asignación vigente y abre otra; historial intacto; con cuotas ya generadas se bloquea con aviso', async () => {
    const a1 = await k.asgOf('P121', MON);
    const frozen = await k.fp(false);
    const imp = await k.stage([P121({ op: 'OP2', nid: '8-333-333', name: 'CARLOS DIAZ', phone: '+50760000002', rate: null, ag: null, saldo: '15', days: [null, 2500, null, null, null, null, null] })]);
    const pv = await k.preview(imp, MON3);
    expect(pv).toMatchObject({ units: { changed: 1 }, drivers: { created: 1 }, assignments_created: 1 });
    expect(await k.fp(false)).toEqual(frozen);
    await k.apply(imp, MON3);
    const hist = await k.rows(`select d.operator_code oc, a.valid_from::text f, a.valid_to::text t from public.assignments a join public.drivers d on d.id=a.driver_id join public.units u on u.id=a.unit_id where u.code='P121' order by a.valid_from`);
    expect(hist).toEqual([{ oc: 'OP1', f: MON, t: addDays(MON3, -1) }, { oc: 'OP2', f: MON3, t: null }]);
    // La asignación anterior conserva sus cargos, pagos y tarifa (la tarifa se cierra, no se borra); la nueva hereda la cuota vigente
    expect((await k.one(`select count(*)::int n from public.charges where assignment_id=$1 and kind='daily'`, [a1.id])).n).toBe(6);
    expect((await k.one(`select count(*)::int n from public.payments where assignment_id=$1 and voided_at is null`, [a1.id])).n).toBe(2);
    expect(await k.rows(`select r.daily_amount_cents::int c, r.valid_from::text f, r.valid_to::text t from public.rates r join public.assignments a on a.id=r.assignment_id join public.units u on u.id=a.unit_id where u.code='P121' order by r.valid_from`))
      .toEqual([{ c: 3000, f: MON, t: addDays(MON2, -1) }, { c: 3500, f: MON2, t: addDays(MON3, -1) }, { c: 3500, f: MON3, t: null }]);
    expect((await k.one(`select count(*)::int n from public.drivers where operator_code='OP1'`)).n).toBe(1);        // el operario anterior sigue existiendo
    const a2 = await k.asgOf('P121', MON3);
    expect(await k.rows(`select kind, amount_cents::int a from public.charges where assignment_id=$1`, [a2.id])).toEqual([{ kind: 'opening', a: 1500 }]);
    expect((await k.apply(await k.stage([P121({ op: 'OP2', nid: '8-333-333', name: 'CARLOS DIAZ', phone: '+50760000002', rate: null, ag: null, saldo: '15', days: [null, 2500, null, null, null, null, null] })]), MON3)).already_up_to_date).toBe(true);
    // Bloqueo: P122 ya tiene cuotas generadas desde MON → el cambio de operario no reescribe historia
    const imp2 = await k.stage([{ unit: 'P122', op: 'OP-NEW', nid: '8-444-444', name: 'DANIEL', rate: 4000, saldo: '99', days: [1000, null, null, null, null, null, null] }]);
    const f0 = await k.fp();
    const r = await k.apply(imp2, MON);
    expect(r.blocked).toBeGreaterThanOrEqual(1);
    expect(k.codes(r)).toContain('operator_change_retroactive');
    expect((r.warnings as any[]).find((w) => w.code === 'operator_change_retroactive').level).toBe('blocking');
    const f1 = await k.fp();
    expect([f1.asg, f1.pay, f1.ch, f1.adj, f1.drv]).toEqual([f0.asg, f0.pay, f0.ch, f0.adj, f0.drv]);
  });

  it('7 · unidad nueva: se crea con su acuerdo e historial; sin operario queda sin asignación (OPERADOR 0)', async () => {
    const imp = await k.stage([{ unit: 'N-77', op: '0', nid: '0', name: 'SIN OPERARIO', rate: 3000, ag: 'Taller', saldo: '40', days: [1000, null, null, null, null, null, null] }]);
    const pv = await k.preview(imp, MON3);
    expect(pv.units).toMatchObject({ new: 1, without_driver: 1 });
    expect(k.codes(pv)).toContain('saldo_without_assignment');
    expect(pv.payments.rejected).toBe(1);                                              // sin asignación no hay a quién imputar el pago: se informa, no se oculta
    const r = await k.apply(imp, MON3);
    expect(r.units).toMatchObject({ new: 1, without_driver: 1 });
    expect(await k.one(`select u.agreement, (select count(*)::int from public.assignments a where a.unit_id=u.id) asg, (select count(*)::int from public.unit_agreement_history h where h.unit_id=u.id and h.source='import') h from public.units u where u.code='N-77'`))
      .toEqual({ agreement: 'Taller', asg: 0, h: 1 });
    expect((await k.apply(await k.stage([{ unit: 'N-77', op: '0', nid: '0', name: 'SIN OPERARIO', rate: 3000, ag: 'Taller', saldo: '40', days: [1000, null, null, null, null, null, null] }]), MON3)).units).toMatchObject({ new: 0, unchanged: 1 });
  });

  it('8 · una semana posterior no altera la anterior: las fotos semanales y sus historiales quedan intactos', async () => {
    const snapMon = await k.one(`select md5(string_agg(row(w.*)::text, '|' order by w.unit_code)) h, count(*)::int n from public.collection_week_units w where week_start=$1`, [MON]);
    const snapMon2 = await k.one(`select md5(string_agg(row(w.*)::text, '|' order by w.unit_code)) h from public.collection_week_units w where week_start=$1`, [MON2]);
    const hMon = (await k.one(`select count(*)::int n from public.collection_week_unit_changes where week_start=$1`, [MON])).n;
    const imp = await k.stage([P121({ op: 'OP2', nid: '8-333-333', name: 'CARLOS DIAZ', rate: 5000, ag: 'ACUERDO C', saldo: '99', days: [5000, null, null, null, null, null, null] }), { unit: 'P122', op: 'OP22', nid: '8-222-222', rate: 4500, ag: 'OTRO', days: NONE }]);
    const week4 = addDays(MON, 21);
    await k.apply(imp, week4);
    expect(await k.one(`select md5(string_agg(row(w.*)::text, '|' order by w.unit_code)) h, count(*)::int n from public.collection_week_units w where week_start=$1`, [MON])).toEqual(snapMon);
    expect((await k.one(`select md5(string_agg(row(w.*)::text, '|' order by w.unit_code)) h from public.collection_week_units w where week_start=$1`, [MON2]))).toEqual(snapMon2);
    expect((await k.one(`select count(*)::int n from public.collection_week_unit_changes where week_start=$1`, [MON])).n).toBe(hMon);
    expect((await k.one(`select daily_rate_cents::int r, agreement from public.collection_week_units where week_start=$1 and unit_code='P121'`, [MON]))).toEqual({ r: 3000, agreement: 'ACUERDO A' });
    expect((await k.one(`select daily_rate_cents::int r, agreement from public.collection_week_units where week_start=$1 and unit_code='P121'`, [week4]))).toEqual({ r: 5000, agreement: 'ACUERDO C' });
    // el historial de cambios de la foto registra qué campos cambiaron entre importaciones de la MISMA semana
    const last = await k.one(`select changed_fields from public.collection_week_unit_changes where week_start=$1 and unit_code='P121' order by id desc limit 1`, [MON2]);
    expect(last.changed_fields).toContain('agreement');
  });

  it('operario con 2 unidades a la vez: una asignación por unidad, saldos y pagos separados', async () => {
    const w = addDays(MON, 28);
    const imp = await k.stage([
      { unit: 'M-1', op: 'MULTI', nid: '8-555-555', name: 'ELENA DOS', rate: 3000, saldo: '10', days: [500, null, null, null, null, null, null] },
      { unit: 'M-2', op: 'MULTI', nid: '8-555-555', name: 'ELENA DOS', rate: 2000, saldo: '25', days: [700, 300, null, null, null, null, null] }]);
    const r = await k.apply(imp, w);
    expect(r).toMatchObject({ units: { new: 2 }, drivers: { created: 1 }, assignments_created: 2, saldo: { create: 2 }, payments: { new: 3 } });
    const a1 = await k.asgOf('M-1', w); const a2 = await k.asgOf('M-2', w);
    expect(a1.driver_id).toBe(a2.driver_id); expect(a1.id).not.toBe(a2.id);
    expect((await k.pos(a1.id, addDays(w, -1))).pending).toBe(1000); expect((await k.pos(a2.id, addDays(w, -1))).pending).toBe(2500);
    expect((await k.one(`select sum(net_cents)::int s from public.payments where assignment_id=$1 and voided_at is null`, [a1.id])).s).toBe(500);
    expect((await k.one(`select sum(net_cents)::int s from public.payments where assignment_id=$1 and voided_at is null`, [a2.id])).s).toBe(1000);
    expect((await k.apply(await k.stage([
      { unit: 'M-1', op: 'MULTI', nid: '8-555-555', rate: 3000, saldo: '10', days: [500, null, null, null, null, null, null] },
      { unit: 'M-2', op: 'MULTI', nid: '8-555-555', rate: 2000, saldo: '25', days: [700, 300, null, null, null, null, null] }]), w)).already_up_to_date).toBe(true);
    // la regla relajada solo quita «un conductor, una asignación»: una UNIDAD sigue sin poder tener dos conductores a la vez
    expect(await db.su.query(`insert into public.assignments(driver_id, unit_id, valid_from) values ($1,$2,$3)`, [legacy.driver, (await k.one(`select id from public.units where code='M-1'`)).id, w]).then(() => null, (e) => e.message)).toMatch(/exclusion|conflicting key/);
  });

  it('12 · filas vacías, cuota 0 (advertencia no bloqueante), unidad sin operario y cédula ausente', async () => {
    const w = addDays(MON, 35);
    const imp = await k.stage([
      { unit: '  ', days: null },                                                       // fila totalmente vacía
      { unit: null, op: null, nid: null, name: null, rate: 0, days: NONE },             // «cuenta 0» suelta, sin unidad ni datos
      { unit: 'Z-1', op: '0', nid: '0', name: null, rate: 0, days: NONE },              // unidad sin operario y cuota 0
      { unit: 'Z-2', op: 'ZOP', nid: '', name: 'CON CUOTA CERO', rate: 0, saldo: null, days: [null, null, null, null, null, null, null], phone: '+50760000009' },
      { unit: 'Z-3', op: 'ZOP3', nid: '0', name: 'SIN CEDULA', rate: 3000, days: [3000, null, null, null, null, null, null] },
      { unit: null, op: 'XYZ', nid: '8-1-9', name: 'DATOS SIN UNIDAD', days: NONE }]);
    const pv = await k.preview(imp, w);
    expect(pv).toMatchObject({ rows_empty: 2, units: { total: 3, new: 3, errors: 1 } });          // 2 vacías; Z-1..Z-3 nuevas; una fila con datos pero sin unidad = error
    expect(k.codes(pv)).toEqual(expect.arrayContaining(['rate_zero', 'missing_unit']));
    const lv = (c: string) => (pv.warnings as any[]).filter((x) => x.code === c).map((x) => x.level);
    expect(lv('rate_zero').every((l: string) => l === 'info')).toBe(true);                       // cuota 0 = informativa, NO bloquea
    expect(pv.blocked).toBe(0);
    const r = await k.apply(imp, w);
    expect(r).toMatchObject({ blocked: 0, units: { new: 3, without_driver: 1 } });
    // Z-2: operario importado aun con cuota 0 y sin cédula; NO se crea tarifa ni cargos con 0
    const z2 = await k.asgOf('Z-2', w);
    expect(z2).toBeTruthy();
    expect((await k.one(`select count(*)::int n from public.rates where assignment_id=$1`, [z2.id])).n).toBe(0);
    expect((await k.one(`select national_id, whatsapp_consent from public.drivers where operator_code='ZOP'`))).toEqual({ national_id: null, whatsapp_consent: false });
    expect((await k.one(`select count(*)::int n from public.drivers where national_id is null`)).n).toBeGreaterThanOrEqual(2);    // UNIQUE admite varios NULL
    await chargeWeek(db, w);
    expect((await k.one(`select count(*)::int n from public.charges where assignment_id=$1`, [z2.id])).n).toBe(0);
    expect((await k.asgOf('Z-1', w))).toBeUndefined();                                         // sin operario ni asignación previa: queda solo la unidad
    expect((await k.one(`select count(*)::int n from public.rates r join public.assignments a on a.id=r.assignment_id join public.units u on u.id=a.unit_id where u.code='Z-1'`)).n).toBe(0);
    expect((await k.apply(imp, w)).already_up_to_date).toBe(true);
  });

  it('13 · el historial previo queda íntegro (pagos, cargos, ajustes, cierres y auditoría anterior), también tras todas las importaciones anteriores', async () => {
    expect(await legacySnapshot()).toEqual(legacyHash);
    expect((await k.one(`select count(*)::int n from public.weekly_closures where assignment_id=$1`, [legacy.assignment])).n).toBe(1);
    expect((await k.one(`select count(*)::int n from public.payments where assignment_id=$1 and idempotency_key not like 'excel:%'`, [legacy.assignment])).n).toBe(1);
    // la auditoría y la bitácora de pagos importados son append-only
    expect(await db.su.query(`delete from public.audit_logs where id=$1`, [legacyAuditMax]).then(() => null, (e) => e.message)).toMatch(/no permitido/);
    expect(await db.su.query(`update public.excel_payment_changes set new_cents = 1`).then(() => null, (e) => e.message)).toMatch(/no permitido/);
    expect(await db.su.query(`update public.collection_week_unit_changes set unit_code = 'x'`).then(() => null, (e) => e.message)).toMatch(/no permitido/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('0026 · pagos lunes–domingo idempotentes, neto exacto, FIFO, reportes y recordatorios', () => {
  let db: Db; let k: ReturnType<typeof kit>; let asg = ''; let drv = '';
  const W = MON2;
  const R = (days: (number | null)[], over: Partial<Row> = {}): Row => ({ unit: 'PAY1', op: 'PAYOP', nid: '8-700-700', name: 'PAGADOR UNO', rate: 3000, days, ...over });
  const active = async () => (await k.rows(`select (p.paid_at at time zone 'America/Panama')::date::text d, p.net_cents::int n from public.payments p where p.assignment_id=$1 and p.voided_at is null order by p.paid_at`, [asg]));
  const sum = (x: { n: number }[]) => x.reduce((s, y) => s + y.n, 0);
  beforeAll(async () => { db = await newDb(); k = kit(db); }, 120_000);
  afterAll(async () => { await db.close(); });

  it('9a · $35 → $20 → $0 → $35: el neto siempre queda en el importe nuevo, sin sumar, sin borrar; vacío no borra; mismo valor no mueve nada', async () => {
    await k.apply(await k.stage([R([null, null, null, null, null, null, null])]), W);          // crea unidad/operario/asignación sin pagos
    const a = await k.asgOf('PAY1', W); asg = a.id; drv = a.driver_id;
    await chargeWeek(db, W);                                                                    // 6 × 3000
    const mk = (days: (number | null)[]) => k.stage([R(days)]);
    // 1) lunes $35 y martes $20 (nuevos)
    let r = await k.apply(await mk([3500, 2000, null, null, null, null, null]), W);
    expect(r.payments).toMatchObject({ new: 2, changed: 0, zeroed: 0, unchanged: 0, skipped_empty: 5, net_delta_cents: 5500 });
    expect(await active()).toEqual([{ d: W, n: 3500 }, { d: addDays(W, 1), n: 2000 }]);
    // 2) mismo valor: 0 movimientos y sin auditoría
    const f0 = await k.fp(false);
    r = await k.apply(await mk([3500, 2000, null, null, null, null, null]), W);
    expect(r).toMatchObject({ already_up_to_date: true, payments: { new: 0, changed: 0, zeroed: 0, unchanged: 2 } });
    expect(await k.fp(false)).toEqual(f0);                                                      // ni pagos, ni estado, ni historial, ni auditoría de negocio
    // 3) $35→$20 y $20→$35 (intercambio): neto = nuevos importes, NO 55+..., el pago anterior queda anulado con motivo y el nuevo es uno solo
    r = await k.apply(await mk([2000, 3500, null, null, null, null, null]), W);
    expect(r.payments).toMatchObject({ new: 0, changed: 2, zeroed: 0, net_delta_cents: 0 });
    expect(await active()).toEqual([{ d: W, n: 2000 }, { d: addDays(W, 1), n: 3500 }]);
    const voided = await k.rows(`select net_cents::int n, void_reason from public.payments where assignment_id=$1 and voided_at is not null order by net_cents`, [asg]);
    expect(voided).toHaveLength(2); expect(voided.every((v) => /^corregido por importación del Excel/.test(v.void_reason))).toBe(true);
    expect((await k.one(`select count(*)::int n from public.payments where assignment_id=$1`, [asg])).n).toBe(4);       // 2 originales anulados + 2 nuevos: nada borrado
    // 4) 0 explícito: anula sin reemplazo (neto 0) con auditoría; martes vacío NO se borra
    r = await k.apply(await mk([0, null, null, null, null, null, null]), W);
    expect(r.payments).toMatchObject({ zeroed: 1, new: 0, changed: 0, skipped_empty: 6, net_delta_cents: -2000 });
    expect(await active()).toEqual([{ d: addDays(W, 1), n: 3500 }]);
    expect((await k.one(`select void_reason r from public.payments where assignment_id=$1 and voided_at is not null and net_cents=2000 order by voided_at desc limit 1`, [asg])).r).toMatch(/^anulado por importación del Excel \(0 explícito\)/);
    expect((await k.one(`select count(*)::int n from public.audit_logs where action='void_payment' and (detail ->> 'reason') like 'anulado por importación%'`)).n).toBe(1);
    // 5) vuelve a $35: un pago nuevo (clave distinta por revisión), el viejo sigue anulado
    r = await k.apply(await mk([3500, null, null, null, null, null, null]), W);
    expect(r.payments).toMatchObject({ new: 1, net_delta_cents: 3500 });
    expect(await active()).toEqual([{ d: W, n: 3500 }, { d: addDays(W, 1), n: 3500 }]);
    expect((await k.one(`select count(distinct idempotency_key)::int n, count(*)::int t from public.payments where assignment_id=$1`, [asg]))).toEqual({ n: 5, t: 5 });
    // 6) 0 explícito sobre un día sin pago previo: nada; vacío no crea
    const f2 = await k.fp(false);
    r = await k.apply(await mk([3500, null, null, 0, null, null, null]), W);
    expect(r).toMatchObject({ already_up_to_date: true, payments: { unchanged: 2, skipped_empty: 5 } });
    expect(await k.fp(false)).toEqual(f2);
    // 7) auditoría de cambios: append-only y completa
    const ch = await k.rows(`select pay_date::text d, previous_cents::int p, new_cents::int n, delta_cents::int dl, action from public.excel_payment_changes where assignment_id=$1 order by id`, [asg]);
    expect(ch).toEqual([
      { d: W, p: null, n: 3500, dl: 3500, action: 'create' }, { d: addDays(W, 1), p: null, n: 2000, dl: 2000, action: 'create' },
      { d: W, p: 3500, n: 2000, dl: -1500, action: 'change' }, { d: addDays(W, 1), p: 2000, n: 3500, dl: 1500, action: 'change' },
      { d: W, p: 2000, n: 0, dl: -2000, action: 'zero' }, { d: W, p: 0, n: 3500, dl: 3500, action: 'create' }]);
    expect(await db.su.query(`delete from public.excel_payment_changes`).then(() => null, (e) => e.message)).toMatch(/no permitido/);
    // el operario (driver_id) de la asignación queda guardado en el estado
    expect((await k.one(`select driver_id from public.excel_payment_days where assignment_id=$1 and pay_date=$2`, [asg, W])).driver_id).toBe(drv);
  });

  it('9b · un pago importado anulado a mano no se resucita al reimportar el mismo importe', async () => {
    const mon = (await k.one(`select payment_id from public.excel_payment_days where assignment_id=$1 and pay_date=$2`, [asg, W])).payment_id;
    await db.as(db.admin, (q) => q.one(`select public.void_payment($1,'anulado a mano')`, [mon]));
    const f = await k.fp(false);
    const r = await k.apply(await k.stage([R([3500, null, null, null, null, null, null])]), W);
    expect(r.payments).toMatchObject({ new: 0, unchanged: 1 }); expect(k.codes(r)).toContain('payment_voided_outside_import');
    expect(await k.fp(false)).toEqual(f);
    const r2 = await k.apply(await k.stage([R([3000, null, null, null, null, null, null])]), W);       // otro importe → sí se registra (no hay nada vigente que anular)
    expect(r2.payments).toMatchObject({ new: 1 });
    expect((await active()).filter((x) => x.d === W)).toEqual([{ d: W, n: 3000 }]);
    await k.apply(await k.stage([R([3500, null, null, null, null, null, null])]), W);               // y se deja como estaba para los siguientes casos
    expect((await active())).toEqual([{ d: W, n: 3500 }, { d: addDays(W, 1), n: 3500 }]);
  });

  it('10 · sin pagos duplicados y neto exacto en posición, FIFO, saldos y reportes (los anulados no cuentan)', async () => {
    const net = 7000;
    expect((await k.pos(asg)).net).toBe(net);
    expect(await k.pos(asg, addDays(W, -1))).toMatchObject({ net: 0, pending: 0 });                  // los pagos de la semana no tocan la posición del domingo anterior
    const cov = await k.rows(`select charge_date::text d, covered_cents::int c from public.assignment_coverage($1) order by charge_date`, [asg]);
    expect(cov.map((x) => x.c)).toEqual([3000, 3000, 1000, 0, 0, 0]);                                // FIFO: lo más antiguo primero; 7000 = 3000+3000+1000
    expect(sum(cov.map((x) => ({ n: x.c })))).toBe(net);
    const tbl = (await db.as(db.admin, (q) => q.one(`select net_cents::int n, day_net_cents d, week_charged_cents::int ch from public.weekly_collection_table($1::date) where unit_code='PAY1'`, [W])));
    expect(tbl.n).toBe(net); expect(tbl.d.map(Number)).toEqual([3500, 3500, 0, 0, 0, 0, 0]); expect(tbl.ch).toBe(18000);
    const per = await db.as(db.admin, (q) => q.one(`select public.period_summary($1::date,$2::date) s`, [W, addDays(W, 6)]));
    expect(per.s).toMatchObject({ net_cents: net, payments_count: 2 });
    const vars = await db.su.query(`select app_private.template_vars($1,$2::date) v`, [asg, addDays(W, 3)]);
    expect(vars.rows[0].v.pagos_semana).toBe('$70.00');
    expect((await db.su.query(`select net_cents::int n from public.v_collection_totals where week_start=$1 and method_code='excel'`, [W])).rows[0].n).toBe(net);
    expect((await db.as(db.admin, (q) => q.one(`select public.dashboard_summary() d`))).d.collections).toBeTruthy();   // el panel no falla con anulados y método nuevo
    // cierre de semana: usa solo pagos vigentes
    await db.as(db.admin, (q) => q.query(`select public.close_week($1::date)`, [W]));
    expect((await k.one(`select net_cents::int n, gross_cents::int g from public.weekly_closures where assignment_id=$1 and week_start=$2`, [asg, W]))).toEqual({ n: net, g: net });
    // semana cerrada: ningún cambio retroactivo se hace en silencio
    const imp = await k.stage([R([1000, null, null, null, null, null, null], { saldo: '99' })]);
    const pv = await k.preview(imp, W);
    expect(pv.blocked).toBeGreaterThanOrEqual(1); expect(k.codes(pv)).toContain('week_closed');
    const f = await k.fp(false);
    const r = await k.apply(imp, W);
    expect(k.codes(r)).toContain('week_closed'); expect(r.payments).toMatchObject({ new: 0, changed: 0, zeroed: 0 });
    expect(await k.fp(false)).toEqual(f);
    expect((await active())).toEqual([{ d: W, n: 3500 }, { d: addDays(W, 1), n: 3500 }]);
  });

  it('11 · recordatorios: el pago que llega después de programar ajusta el trabajo pendiente y reimportar no duplica trabajos', async () => {
    const w = addDays(MON, 14);
    const r0 = await k.stage([{ unit: 'REM1', op: 'REMOP', nid: '8-800-800', name: 'RECORDADO', rate: 3000, days: NONE }]);
    await k.apply(r0, w);
    const a = await k.asgOf('REM1', w);
    await chargeWeek(db, w);
    const mkJob = async (day: number) => (await db.su.query(`insert into public.notification_jobs(driver_id, kind, local_date, scheduled_for, status) values ($1,'debt_first',$2::date,$3::timestamptz,'pending') returning id`,
      [a.driver_id, addDays(w, day), `${addDays(w, day)}T08:00:00-05:00`])).rows[0].id as string;
    const tue = await mkJob(1); const thu = await mkJob(3);
    const st = async (id: string) => (await k.one(`select status from public.notification_jobs where id=$1`, [id])).status;
    const nJobs = async () => (await k.one(`select count(*)::int n from public.notification_jobs where driver_id=$1`, [a.driver_id])).n;
    expect([await st(tue), await st(thu)]).toEqual(['pending', 'pending']);
    const days = [3000, 3000, null, null, null, null, null] as (number | null)[];
    await k.apply(await k.stage([{ unit: 'REM1', op: 'REMOP', nid: '8-800-800', rate: 3000, days }]), w);
    expect(await st(tue)).toBe('skipped_paid');                                                 // lo exigible al martes quedó cubierto
    expect(await st(thu)).toBe('pending');                                                      // al jueves aún se debe miércoles y jueves
    expect(await nJobs()).toBe(2);
    await k.apply(await k.stage([{ unit: 'REM1', op: 'REMOP', nid: '8-800-800', rate: 3000, days }]), w);
    await k.apply(await k.stage([{ unit: 'REM1', op: 'REMOP', nid: '8-800-800', rate: 3000, days: [3000, 3000, 3000, 3000, null, null, null] }]), w);
    expect(await st(thu)).toBe('skipped_paid');
    expect(await nJobs()).toBe(2);                                                              // nunca se crean ni duplican trabajos de WhatsApp
    expect((await k.one(`select count(*)::int n from public.notification_jobs where kind in ('payment_receipt') and driver_id=$1`, [a.driver_id])).n).toBe(0);   // ni comprobantes
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('0026 · permisos y validaciones', () => {
  let db: Db; let k: ReturnType<typeof kit>; let imp = '';
  beforeAll(async () => { db = await newDb(); k = kit(db); imp = await k.stage([{ unit: 'PERM1', op: 'PERMOP', nid: '8-900-900', name: 'PERMISOS', rate: 3000, days: [1000, null, null, null, null, null, null] }]); }, 120_000);
  afterAll(async () => { await db.close(); });

  it('solo ADMIN y SUPER_ADMIN; supervisor, usuario sin rol y anónimo se rechazan', async () => {
    for (const who of [db.supervisor, db.outsider]) expect(await db.as(who, async (q) => {
      const a = await q.fails(`select public.preview_collection_sync($1,$2::date)`, [imp, MON]);
      const b = await q.fails(`select public.apply_collection_sync($1,$2::date)`, [imp, MON]);
      return [a, b];
    })).toEqual(['forbidden', 'forbidden']);
    expect((await db.asAnon(async (q) => {
      const a = await q.fails(`select public.preview_collection_sync($1,$2::date)`, [imp, MON]);
      const b = await q.fails(`select public.apply_collection_sync($1,$2::date)`, [imp, MON]);
      return [a, b];
    })).every((m) => /permission denied/.test(m ?? ''))).toBe(true);
    expect((await k.fp()).pay).toBe(0);
    const ok = await db.as(db.opsAdmin, async (q) => (await q.one(`select public.preview_collection_sync($1,$2::date) r`, [imp, MON])).r);       // ADMIN
    expect(ok.units.new).toBe(1);
    await k.apply(imp, MON, db.admin);                                                                                                          // SUPER_ADMIN
    expect((await k.fp()).pay).toBe(1);
  });
  it('tablas nuevas: lectura para el personal, ninguna escritura directa desde el cliente; RLS activa', async () => {
    for (const t of ['excel_payment_days', 'excel_payment_changes', 'collection_week_units', 'collection_week_unit_changes']) {
      expect((await db.su.query(`select relrowsecurity r from pg_class where oid = 'public.${t}'::regclass`)).rows[0].r).toBe(true);
      expect(await db.as(db.supervisor, (q) => q.rows(`select * from public.${t}`).then((x) => x.length >= 0))).toBe(true);
      expect(await db.as(db.outsider, (q) => q.rows(`select * from public.${t}`))).toEqual([]);
      expect(await db.as(db.admin, (q) => q.fails(`delete from public.${t}`))).toMatch(/permission denied/);
      expect(await db.as(db.admin, (q) => q.fails(`insert into public.${t} default values`))).toMatch(/permission denied/);
    }
  });
  it('validaciones: lunes, tipo de importación, estado; la vista previa acepta «previewed» pero aplicar exige «confirmed»', async () => {
    expect(await db.as(db.admin, (q) => q.fails(`select public.preview_collection_sync($1,$2::date)`, [imp, addDays(MON, 1)]))).toBe('week_start_must_be_monday');
    expect(await db.as(db.admin, (q) => q.fails(`select public.preview_collection_sync(gen_random_uuid(),$1::date)`, [MON]))).toBe('import_not_found');
    const old = (await db.su.query(`insert into public.excel_imports(file_name, file_sha256, source_kind, created_by) values ('b.xlsx','legacy-sha','cobranza',$1) returning id`, [db.admin])).rows[0].id;
    expect(await db.as(db.admin, (q) => q.fails(`select public.apply_collection_sync($1,$2::date)`, [old, MON]))).toBe('wrong_import_kind');       // el formato de bloques antiguo no se toca
    const pending = await k.stage([{ unit: 'PERM2', op: '0', rate: 100, days: NONE }], { status: 'previewed' });
    expect((await k.preview(pending, MON)).units.new).toBe(1);
    expect(await db.as(db.admin, (q) => q.fails(`select public.apply_collection_sync($1,$2::date)`, [pending, MON]))).toBe('import_not_confirmed');
  });
  it('cédula opcional y operario con varias unidades a nivel de esquema; apply_import legado sigue marcando la cédula ausente como «requiere revisión»', async () => {
    expect((await db.su.query(`select is_nullable n from information_schema.columns where table_schema='public' and table_name='drivers' and column_name='national_id'`)).rows[0].n).toBe('YES');
    expect((await db.su.query(`select count(*)::int n from pg_constraint where conrelid='public.assignments'::regclass and contype='x'`)).rows[0].n).toBe(1);      // solo queda la exclusión por unidad
    expect((await db.su.query(`select pg_get_constraintdef(oid) d from pg_constraint where conrelid='public.excel_imports'::regclass and contype='c' and conname like '%source_kind%'`)).rows[0].d).toContain('collection_flat');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('0026 · bordes: duplicados, identidad, teléfono, fechas futuras y operarios inactivos', () => {
  let db: Db; let k: ReturnType<typeof kit>;
  beforeAll(async () => { db = await newDb(); k = kit(db); }, 120_000);
  afterAll(async () => { await db.close(); });

  it('unidad repetida en el archivo; la cédula nunca bloquea ni avisa; teléfono distinto y consentimiento intacto', async () => {
    const x = await db.driverWithAssignment({ code: 'BORDE1', unit: 'B-1', dailyCents: 3000, phone: '+50762220001', consent: true, from: '2026-01-01' });
    await db.su.query(`update public.drivers set national_id='8-BORDE-1' where id=$1`, [x.driver]);
    const imp = await k.stage([
      { unit: 'D-1', op: 'DUP1', nid: '8-d-1', name: 'UNO', rate: 1000 }, { unit: 'd-1', op: 'DUP2', nid: '8-d-2', name: 'DOS', rate: 1000 },      // misma unidad dos veces
      { unit: 'B-2', op: 'BORDE2', nid: '8-BORDE-1', name: 'CEDULA AJENA', rate: 1000 },                                                              // cédula de BORDE1
      { unit: 'B-1', op: 'BORDE1', nid: '8-OTRA', name: 'Conductor BORDE1', phone: '+50769999999', rate: 3000, days: [3000, null, null, null, null, null, null] }]);   // cédula y teléfono distintos
    const r = await k.apply(imp, MON);
    expect(r.units).toMatchObject({ total: 4, errors: 2, changed: 1 });                                                       // solo la unidad repetida (la cédula ajena ya no es error)
    expect(k.codes(r)).toEqual(expect.arrayContaining(['duplicate_unit', 'phone_updated']));
    expect(k.codes(r)).not.toEqual(expect.arrayContaining(['identity_conflict']));
    expect((await k.one(`select count(*)::int n from public.units where code in ('D-1')`)).n).toBe(0);                                 // la unidad repetida no creó nada
    expect(await k.one(`select phone_e164, whatsapp_consent, national_id from public.drivers where id=$1`, [x.driver])).toEqual({ phone_e164: '+50769999999', whatsapp_consent: true, national_id: '8-OTRA' });   // no se pisa nada
    expect((await k.one(`select count(*)::int n from public.driver_consents`)).n).toBe(0);                                            // el import nunca crea consentimiento
    expect(r.payments).toMatchObject({ new: 1 });
  });

  it('fechas futuras y conductores inactivos: el pago no se aplica y se informa (nunca en silencio)', async () => {
    let far = new Date('2099-01-01T00:00:00Z'); while (far.getUTCDay() !== 1) far.setUTCDate(far.getUTCDate() + 1);
    const w = far.toISOString().slice(0, 10);
    const imp = await k.stage([{ unit: 'F-1', op: 'FUT1', nid: '8-f-1', name: 'FUTURO', rate: 1000, saldo: '5', days: [100, null, null, null, null, null, null] }]);
    const r = await k.apply(imp, w);
    expect(r.payments).toMatchObject({ new: 0, rejected: 1 }); expect(k.codes(r)).toContain('payment_not_applied_future_date');
    expect(r.saldo).toMatchObject({ create: 1 });                                                                                      // el saldo sí se concilia
    const y = await db.driverWithAssignment({ code: 'INACT1', unit: 'I-1', dailyCents: 1000, from: '2026-01-01', status: 'inactive' });
    const r2 = await k.apply(await k.stage([{ unit: 'I-1', op: 'INACT1', rate: 1000, days: [100, null, null, null, null, null, null] }]), MON);
    expect(r2.payments).toMatchObject({ new: 0, rejected: 1 }); expect(k.codes(r2)).toContain('payment_not_applied_driver_inactive');
    expect((await k.one(`select count(*)::int n from public.payments where assignment_id=$1`, [y.assignment])).n).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('0026 · nombre COMPLETO del operario (sin dividir)', () => {
  let db: Db; let k: ReturnType<typeof kit>;
  const FULL = 'CARLOS ANDRES PRUEBA EJEMPLO';
  const nameAudits = (id: string) => k.one(`select count(*)::int n from public.audit_logs where entity='drivers' and entity_id=$1 and (action='import_driver_name_change' or action='update')`, [id]);
  const drvOf = (op: string) => k.one(`select id, first_name, last_name from public.drivers where operator_code=$1`, [op]);
  beforeAll(async () => { db = await newDb(); k = kit(db); }, 120_000);
  afterAll(async () => { await db.close(); });

  it('conductor nuevo: guarda el nombre completo exacto en first_name y last_name vacío; la plantilla {{nombre_completo}} lo devuelve tal cual', async () => {
    const imp = await k.stage([{ unit: 'NM-1', op: 'NM1', nid: '8-nm-1', name: `  ${FULL}  `.replace(' ANDRES ', '   ANDRES  '), rate: 3000 }]);
    const pv = await k.preview(imp, MON);
    expect(pv.drivers).toMatchObject({ created: 1, updated: 0 });
    expect((await k.apply(imp, MON)).drivers).toMatchObject({ created: 1, updated: 0 });
    expect(await drvOf('NM1')).toMatchObject({ first_name: FULL, last_name: '' });
    const a = await k.asgOf('NM-1', MON);
    const t = (await db.as(db.admin, (q) => q.one(`select public.preview_template($1,'Hola {{nombre_completo}}.|{{nombre}}|{{apellido}}',$2::date) t`, [a.id, MON]))).t;
    expect(t.text).toBe(`Hola ${FULL}.|${FULL}|`); expect(t.unresolved).toEqual(['apellido']);
  });
  it('reimportar el mismo nombre (otra capitalización/espacios) no escribe ni audita', async () => {
    const d = await drvOf('NM1'); const before = await nameAudits(d.id);
    const imp = await k.stage([{ unit: 'NM-1', op: 'NM1', nid: '8-nm-1', name: ' carlos  andres prueba   ejemplo ', rate: 3000 }]);
    expect((await k.preview(imp, MON)).drivers).toMatchObject({ created: 0, updated: 0 });
    const fp0 = await k.fp(false);
    const r = await k.apply(imp, MON);
    expect(r.drivers).toMatchObject({ created: 0, updated: 0 });
    expect(await k.fp(false)).toEqual(fp0);
    expect(await drvOf('NM1')).toMatchObject({ first_name: FULL, last_name: '' });
    expect(await nameAudits(d.id)).toEqual(before);
  });
  it('nombre distinto: se actualiza (first_name = completo, last_name = \'\'), se audita solo ese cambio y la vista previa lo cuenta', async () => {
    const d = await drvOf('NM1'); const before = (await nameAudits(d.id)).n;
    const NEW = 'CARLOS ANDRES PRUEBA DE EJEMPLO';
    const imp = await k.stage([{ unit: 'NM-1', op: 'NM1', nid: '8-nm-1', name: NEW, rate: 3000 }]);
    expect((await k.preview(imp, MON)).drivers).toMatchObject({ created: 0, updated: 1 });
    expect(await drvOf('NM1')).toMatchObject({ first_name: FULL });                       // la vista previa no escribe
    expect((await k.apply(imp, MON)).drivers).toMatchObject({ created: 0, updated: 1 });
    expect(await drvOf('NM1')).toMatchObject({ first_name: NEW, last_name: '' });
    const aud = await k.one(`select detail, actor from public.audit_logs where action='import_driver_name_change' and entity_id=$1`, [d.id]);
    expect(aud.detail).toMatchObject({ import_id: imp, operator_code: 'NM1', previous: FULL, new: NEW }); expect(aud.actor).toBe(db.admin);
    expect((await nameAudits(d.id)).n).toBe(before + 2);                                    // explícito + trigger de la tabla, ambos con el valor anterior/nuevo
    expect((await k.apply(await k.stage([{ unit: 'NM-1', op: 'NM1', nid: '8-nm-1', name: NEW, rate: 3000 }]), MON)).drivers).toMatchObject({ updated: 0 });
  });
  it('nombre vacío en el Excel nunca pisa el existente', async () => {
    const d = await drvOf('NM1'); const before = await nameAudits(d.id);
    for (const name of [null, '   ']) {
      const imp = await k.stage([{ unit: 'NM-1', op: 'NM1', nid: '8-nm-1', name, rate: 3000 }]);
      expect((await k.preview(imp, MON)).drivers).toMatchObject({ updated: 0 });
      expect((await k.apply(imp, MON)).drivers).toMatchObject({ updated: 0 });
    }
    expect((await drvOf('NM1')).first_name).toBe('CARLOS ANDRES PRUEBA DE EJEMPLO');
    expect(await nameAudits(d.id)).toEqual(before);
  });
  it('histórico con first_name/last_name separados: igual al concatenar = sin cambio; distinto = unifica; plantilla sin espacios de más', async () => {
    const x = await db.driverWithAssignment({ code: 'HIS1', unit: 'HIS-U1', dailyCents: 3000, from: '2026-01-01' });
    await db.su.query(`update public.drivers set first_name='Carlos Andres', last_name=' Prueba  Ejemplo ' where id=$1`, [x.driver]);
    const before = await nameAudits(x.driver);
    const same = await k.stage([{ unit: 'HIS-U1', op: 'HIS1', name: 'CARLOS ANDRES PRUEBA EJEMPLO', rate: 3000 }]);
    expect((await k.preview(same, MON)).drivers).toMatchObject({ updated: 0 });
    expect((await k.apply(same, MON)).drivers).toMatchObject({ updated: 0 });
    expect(await drvOf('HIS1')).toMatchObject({ first_name: 'Carlos Andres', last_name: ' Prueba  Ejemplo ' });   // intacto
    expect(await nameAudits(x.driver)).toEqual(before);
    const t = (await db.as(db.admin, (q) => q.one(`select public.preview_template($1,'[{{nombre_completo}}]',$2::date) t`, [x.assignment, MON]))).t;
    expect(t.text).toBe('[Carlos Andres Prueba Ejemplo]');
    // Un apellido distinto con las demás palabras iguales NO se unifica sola: es un conflicto para revisión manual (no se modifica nada).
    const diff = await k.stage([{ unit: 'HIS-U1', op: 'HIS1', name: 'CARLOS ANDRES PRUEBA PEREZ', rate: 3000 }]);
    const pv = await k.preview(diff, MON);
    expect(pv.units).toMatchObject({ errors: 1 }); expect(k.codes(pv)).toContain('operator_identity_conflict');
    expect(await drvOf('HIS1')).toMatchObject({ first_name: 'Carlos Andres', last_name: ' Prueba  Ejemplo ' });
    // si el nombre contiene al registrado (nombre más completo) se acepta y se unifica con auditoría
    const longer = await k.stage([{ unit: 'HIS-U1', op: 'HIS1', name: 'CARLOS ANDRES PRUEBA EJEMPLO DE LA CRUZ', rate: 3000 }]);
    expect((await k.apply(longer, MON)).drivers).toMatchObject({ updated: 1 });
    expect(await drvOf('HIS1')).toMatchObject({ first_name: 'CARLOS ANDRES PRUEBA EJEMPLO DE LA CRUZ', last_name: '' });
  });
});

describe('0028 · protección contra importaciones antiguas, identidad y contador de cambios', () => {
  let db: Db; let k: ReturnType<typeof kit>;
  beforeAll(async () => { db = await newDb(); k = kit(db); }, 120_000);
  afterAll(async () => { await db.close(); });
  const raw = (imp: string, week: string, note: string | null, confirm: boolean) =>
    db.as(db.admin, (q) => q.one(`select public.apply_collection_sync($1,$2::date,$3,$4) r`, [imp, week, note, confirm]));
  const rawFails = (imp: string, week: string) => db.as(db.admin, (q) => q.fails(`select public.apply_collection_sync($1,$2::date,null,false)`, [imp, week]));
  const W1 = addDays(MON, 70), W2 = addDays(MON, 77), W3 = addDays(MON, 84);
  const row = (over: Partial<Row> = {}): Row => ({ unit: 'G-1', op: 'GOP1', name: 'GUARDA UNO', rate: 3000, phone: '+50761110001', days: NONE, ...over });

  it('semana anterior a la última aplicada: exige confirmación explícita con nota; queda en collection_sync_runs y auditoría', async () => {
    const a = await k.stage([row()]);
    await raw(a, W2, null, false);                                                    // la primera aplicación no es histórica
    const b = await k.stage([row({ unit: 'G-1B', op: 'GOP1B', name: 'GUARDA UNO B', saldo: '10' })]);
    const pv = await k.preview(b, W1);
    expect(pv.guard).toMatchObject({ historical: true, reasons: ['older_week'], latestWeek: W2 });
    expect(await rawFails(b, W1)).toBe('historical_import_requires_confirmation');
    expect(await db.as(db.admin, (q) => q.fails(`select public.apply_collection_sync($1,$2::date,'x',true)`, [b, W1]))).toBe('historical_import_requires_confirmation');   // nota < 3 caracteres
    const ok = await raw(b, W1, 'corrección histórica intencional', true);
    expect(ok.r.guard).toMatchObject({ historical: true });
    expect((await k.rows(`select historical, historical_reasons, note from public.collection_sync_runs where import_id=$1`, [b]))).toEqual([{ historical: true, historical_reasons: ['older_week'], note: 'corrección histórica intencional' }]);
    expect((await k.one(`select count(*)::int n from public.audit_logs where action='collection_sync_historical' and entity_id=$1`, [b])).n).toBe(1);
  });
  it('un archivo SUBIDO antes que otro ya aplicado a la misma semana también es histórico (sin usar la fecha de modificación del archivo)', async () => {
    const older = await k.stage([row({ unit: 'G-2', op: 'GOP2', name: 'GUARDA DOS' })]);      // creado primero
    const newer = await k.stage([row({ unit: 'G-2', op: 'GOP2', name: 'GUARDA DOS', saldo: '5' })]);
    await raw(newer, W3, null, false);
    expect((await k.preview(older, W3)).guard).toMatchObject({ historical: true, reasons: ['older_file_for_week'] });
    expect(await rawFails(older, W3)).toBe('historical_import_requires_confirmation');
    expect((await k.preview(newer, W3)).guard).toMatchObject({ historical: false, priorRuns: [{ weekStart: W3 }] });   // reaplicar el mismo archivo: sin alerta, con su historial
  });
  it('código de operario con nombres de personas distintas: error antes de guardar; nombres que se contienen no lo son', async () => {
    const bad = await k.stage([{ unit: 'ID-1', op: 'IDOP', name: 'ANA PEREZ', rate: 1000 }, { unit: 'ID-2', op: 'IDOP', name: 'LUIS GOMEZ', rate: 1000 }]);
    const pv = await k.preview(bad, W3);
    expect(pv.units).toMatchObject({ errors: 2 }); expect(k.codes(pv)).toContain('operator_identity_conflict');
    const ok = await k.stage([{ unit: 'ID-3', op: 'IDOK', name: 'ANA PEREZ', rate: 1000 }, { unit: 'ID-4', op: 'IDOK', name: 'ANA MARIA PEREZ', rate: 1000 }]);
    expect((await k.preview(ok, W3)).units).toMatchObject({ errors: 0 });
    await k.apply(ok, W3);                                                              // contra la base: otro nombre sin nada en común es conflicto
    const vsDb = await k.stage([{ unit: 'ID-3', op: 'IDOK', name: 'PEDRO LOPEZ', rate: 1000 }]);
    expect(k.codes(await k.preview(vsDb, W3))).toContain('operator_identity_conflict');
  });
  it('«Juan Carlos Pérez» y «Juan Carlos Rodríguez» comparten palabras pero NO son la misma persona: conflicto para revisión manual', async () => {
    const same = await k.stage([{ unit: 'JC-1', op: 'JCOP', name: 'Juan Carlos Pérez', rate: 1000 }, { unit: 'JC-2', op: 'JCOP', name: 'JUAN  CARLOS PÉREZ', rate: 1000 }]);
    expect((await k.preview(same, W3)).units).toMatchObject({ errors: 0 });              // iguales sin mayúsculas, tildes ni espacios
    const other = await k.stage([{ unit: 'JC-3', op: 'JCOP2', name: 'Juan Carlos Pérez', rate: 1000 }, { unit: 'JC-4', op: 'JCOP2', name: 'Juan Carlos Rodríguez', rate: 1000 }]);
    const pv = await k.preview(other, W3);
    expect(pv.units).toMatchObject({ errors: 2 }); expect(k.codes(pv)).toContain('operator_identity_conflict');
  });
  it('contador «con cambios»: una unidad con varios cambios (cuota, saldo, pago, acuerdo) cuenta una sola vez', async () => {
    const MX = addDays(MON, 91), MY = addDays(MX, 7);
    await k.apply(await k.stage([row({ unit: 'C-1', op: 'COP1', name: 'CAMBIOS UNO', rate: 3000, saldo: '10', ag: 'A' }), row({ unit: 'C-2', op: 'COP2', name: 'CAMBIOS DOS', rate: 3000 })]), MX);
    const pv = await k.preview(await k.stage([row({ unit: 'C-1', op: 'COP1', name: 'CAMBIOS UNO', rate: 3500, saldo: '40', ag: 'B', days: [3500, null, null, null, null, null, null] }), row({ unit: 'C-2', op: 'COP2', name: 'CAMBIOS DOS', rate: 3000 })]), MY);
    expect(pv.units).toMatchObject({ total: 2, changed: 1, unchanged: 1 });
  });
});

describe('0031 · desvincular conductor y reimportar el Excel', () => {
  let db: Db; let k: ReturnType<typeof kit>;
  beforeAll(async () => { db = await newDb(); k = kit(db); }, 120_000);
  afterAll(async () => { await db.close(); });
  const W1 = addDays(MON, 105), W2 = addDays(W1, 7);
  const rowU = (over: Partial<Row> = {}): Row => ({ unit: 'UL-1', op: 'ULOP1', name: 'DESVINCULADO UNO', rate: 3000, phone: '+50761230099', days: NONE, ...over });
  it('desvincular conserva todo y no toca las otras unidades del conductor; el Excel desactualizado NO reasigna la unidad (conflicto en la vista previa)', async () => {
    await k.apply(await k.stage([rowU(), rowU({ unit: 'UL-2' })]), W1);                                   // el operario ULOP1 tiene dos unidades
    const a1 = await k.asgOf('UL-1', W1); const a2 = await k.asgOf('UL-2', W1);
    const hist = async () => (await db.su.query(`select (select count(*) from public.charges where assignment_id=$1)::int ch, (select count(*) from public.payments where assignment_id=$1)::int pay,
      (select count(*) from public.rates where assignment_id=$1)::int rt, (select count(*) from public.drivers)::int drv`, [a1.id])).rows[0];
    const before = await hist();
    await db.as(db.admin, (q) => q.one(`select public.end_assignment($1, $2::date) x`, [a1.id, addDays(W1, 2)]));
    expect(await hist()).toEqual(before);                                                                  // historial, cargos, pagos, tarifas y conductor intactos
    expect((await db.su.query(`select valid_to::text vt from public.assignments where id=$1`, [a1.id])).rows[0].vt).toBe(addDays(W1, 2));
    expect((await db.su.query(`select valid_to from public.assignments where id=$1`, [a2.id])).rows[0].valid_to).toBeNull();      // la otra unidad sigue asignada
    // el Excel de la semana siguiente todavía trae UL-1 con el mismo operario: conflicto, sin reasignación
    const stale = await k.stage([rowU(), rowU({ unit: 'UL-2' })]);
    const pv = await k.preview(stale, W2);
    expect(k.codes(pv)).toContain('unit_unlinked_manually'); expect(pv.units).toMatchObject({ errors: 1 });
    expect((await db.su.query(`select count(*)::int n from public.assignments where unit_id=(select id from public.units where code='UL-1')`)).rows[0].n).toBe(1);
    // con el operario vacío (0) la fila no genera conflicto; un operario DISTINTO es una asignación nueva legítima
    expect((await k.preview(await k.stage([rowU({ op: '0', name: null }), rowU({ unit: 'UL-2' })]), W2)).units).toMatchObject({ errors: 0 });
    expect((await k.preview(await k.stage([rowU({ op: 'ULOP9', name: 'NUEVO OPERARIO', phone: '+50761230098' }), rowU({ unit: 'UL-2' })]), W2)).units).toMatchObject({ errors: 0 });
  });
});

describe('0033 · saldo negativo = crédito; unidad desvinculada dentro de la semana; asignación terminada no cambia cuota', () => {
  let db: Db; let k: ReturnType<typeof kit>;
  beforeAll(async () => { db = await newDb(); k = kit(db); }, 120_000);
  afterAll(async () => { await db.close(); });
  const WK = addDays(MON, 133);
  it('un SALDO negativo se concilia como CRÉDITO a favor (ajuste negativo) y se comunica como saldo a favor; SALDO vacío = $0.00', async () => {
    const imp = await k.stage([{ unit: 'NG-1', op: 'NGOP1', name: 'NEGATIVO UNO', rate: 3000, saldo: '-15' }, { unit: 'NG-2', op: 'NGOP2', name: 'NEGATIVO DOS', rate: 3000, saldo: '0' }, { unit: 'NG-3', op: 'NGOP3', name: 'NEGATIVO TRES', rate: 3000 }]);
    const pv = await k.preview(imp, WK);
    expect(pv.saldo).toMatchObject({ adjust: 1, unchanged: 1, skip_empty: 1, delta_cents: -1500, skipped_invalid: 0 });
    await k.apply(imp, WK);
    const a = await k.asgOf('NG-1', WK);
    expect((await db.su.query(`select coalesce(sum(amount_cents),0)::int s from public.adjustments where assignment_id=$1`, [a.id])).rows[0].s).toBe(-1500);
    await db.su.query(`update public.assignments set collect_commission=false where id in (select id from public.assignments where unit_id in (select id from public.units where code in ('NG-1','NG-3')))`);
    const v = (await db.su.query(`select app_private.template_vars($1,$2::date) v`, [a.id, WK])).rows[0].v;
    expect(v).toMatchObject({ deuda_anterior: '$0.00', saldo_total: '$15.00', credito: '$0.00', detalle_deuda: 'Su saldo pendiente es de $15.00.' });
    const b = await k.asgOf('NG-3', WK);                                                        // celda vacía: saldo DESCONOCIDO
    expect((await db.su.query(`select app_private.template_vars($1,$2::date) v`, [b.id, WK])).rows[0].v).toMatchObject({ deuda_anterior: '$0.00', saldo_total: '$30.00' });
  });
  it('desvincular HOY a un operario con la semana en curso: el Excel desactualizado marca error claro (unit_unlinked_manually), sin errores técnicos de cuota', async () => {
    const MONDAY = (await db.su.query(`select app_private.week_start_of((now() at time zone 'America/Panama')::date)::text d`)).rows[0].d;
    await k.apply(await k.stage([{ unit: 'UN-1', op: 'UNOP1', name: 'UNLINK UNO', rate: 3000, phone: '+50761240001' }]), MONDAY);
    const a = await k.asgOf('UN-1', MONDAY);
    const today = (await db.su.query(`select (now() at time zone 'America/Panama')::date::text d`)).rows[0].d;
    await db.as(db.admin, (q) => q.one(`select public.end_assignment($1, $2::date) x`, [a.id, today]));
    const stale = await k.stage([{ unit: 'UN-1', op: 'UNOP1', name: 'UNLINK UNO', rate: 3500, phone: '+50761240001' }]);        // el Excel trae otra cuota y el mismo operario
    const pv = await k.preview(stale, MONDAY);
    expect(k.codes(pv)).toContain('unit_unlinked_manually'); expect(k.codes(pv)).not.toContain('rate_change_not_applied');
    expect(pv.units).toMatchObject({ errors: 1 });
    // con el operario vacío (0) no hay error ni intento de cambiar la cuota de una asignación terminada
    const cleared = await k.preview(await k.stage([{ unit: 'UN-1', op: '0', rate: 3500 }]), MONDAY);
    expect(cleared.units).toMatchObject({ errors: 0 }); expect(k.codes(cleared)).not.toContain('rate_change_not_applied');
  });
});

describe('0050 · el Excel manda sobre las asignaciones vigentes (semana en curso)', () => {
  let db: Db; let k: ReturnType<typeof kit>;
  beforeAll(async () => { db = await newDb(); k = kit(db); }, 120_000);
  afterAll(async () => { await db.close(); });
  const week = async () => (await db.su.query(`select app_private.week_start_of((now() at time zone app_private.tz())::date)::text d`)).rows[0].d as string;
  const today = async () => (await db.su.query(`select (now() at time zone app_private.tz())::date::text d`)).rows[0].d as string;
  const load = async (rows: any[]) => { const w = await week(); const imp = await k.stage(rows); const pv = await k.preview(imp, w); const ap = await k.apply(imp, w); return { pv, ap, imp, w }; };
  const live = async (unit: string) => (await db.su.query(`select d.operator_code op, a.id, a.valid_from::text desde, a.valid_to::text hasta, d.phone_e164 tel from public.assignments a join public.units u on u.id=a.unit_id join public.drivers d on d.id=a.driver_id
      where u.code=$1 and (a.valid_to is null or a.valid_to > (now() at time zone app_private.tz())::date) order by a.valid_from`, [unit])).rows;
  const paid = async (unit: string) => Number((await db.su.query(`select coalesce(sum(p.net_cents),0) n from public.payments p join public.assignments a on a.id=p.assignment_id join public.units u on u.id=a.unit_id where u.code=$1 and p.voided_at is null`, [unit])).rows[0].n);
  const one = { unit: 'SV-1', op: 'SVOP1', name: 'AMBROSIO PRUEBA', rate: 3400, phone: '+50761250001' };

  it('el operario pasa de una unidad a otra: queda SOLO en la nueva; la vacía se finaliza, no cobra ni se puede escribir', async () => {
    await load([one, { unit: 'SV-2' }]);
    const moved = await load([{ unit: 'SV-1' }, { ...one, unit: 'SV-2' }]);
    expect((await live('SV-1'))).toEqual([]); expect((await live('SV-2')).map((x) => x.op)).toEqual(['SVOP1']);
    expect(moved.pv.assignments_ended).toBe(1); expect(JSON.stringify(moved.pv.warnings)).toContain('unit_vacated');
    const back = await load([one, { unit: 'SV-2', days: [3450, 3450] }]);                           // vuelve a SV-1; la fila vacía trae dinero
    expect((await live('SV-1')).map((x) => x.op)).toEqual(['SVOP1']); expect(await live('SV-2')).toEqual([]);
    expect(await paid('SV-2')).toBe(0);                                                             // una fila sin operario no registra pagos a nadie
    expect(JSON.stringify(back.pv.warnings)).toContain('unit_vacated');
    expect((await db.su.query(`select count(*)::int n from public.drivers where operator_code='SVOP1'`)).rows[0].n).toBe(1);
    expect((await db.su.query(`select count(*)::int n from public.assignments a join public.units u on u.id=a.unit_id where u.code='SV-2'`)).rows[0].n).toBeGreaterThanOrEqual(1);   // historial conservado
  });
  it('importar varias veces el mismo estado no cambia nada (idempotente)', async () => {
    await load([one, { unit: 'SV-2' }]);
    const snap = async () => (await db.su.query(`select string_agg(u.code||':'||coalesce(a.valid_to::text,'-'), ',' order by u.code, a.valid_from) s, count(*)::int n from public.assignments a join public.units u on u.id=a.unit_id where u.code like 'SV-%'`)).rows[0];
    const before = await snap();
    const again = await load([one, { unit: 'SV-2' }]);
    expect(await snap()).toEqual(before); expect(again.pv.assignments_ended).toBe(0);
  });
  it('un operario en DOS filas conserva las dos; las unidades que no vienen en el archivo no se tocan', async () => {
    await load([{ ...one, unit: 'SV-3' }, { ...one, unit: 'SV-4' }]);
    expect((await live('SV-3')).length).toBe(1); expect((await live('SV-4')).length).toBe(1);
    expect((await live('SV-1')).length).toBe(1);                                                    // no venía en este archivo
  });
  it('entra otro operario en una unidad con asignación de esta semana: se cierra la anterior y queda la nueva', async () => {
    await load([{ unit: 'SV-5', op: 'SVOP5', name: 'CINCO UNO', rate: 3000 }]);
    await load([{ unit: 'SV-5', op: 'SVOP6', name: 'SEIS DOS', rate: 3000 }]);
    const rows = (await db.su.query(`select d.operator_code op, a.valid_to::text hasta from public.assignments a join public.units u on u.id=a.unit_id join public.drivers d on d.id=a.driver_id where u.code='SV-5' order by a.valid_from`)).rows;
    expect(rows.map((r) => r.op)).toEqual(['SVOP5', 'SVOP6']); expect(rows[0].hasta).not.toBeNull(); expect(rows[1].hasta).toBeNull();
    expect(rows[0].hasta <= (await today())).toBe(true);
  });
  it('un 0 en la fila sin operario ANULA el pago que se había importado ahí; vacío no toca; no registra pagos nuevos', async () => {
    await load([{ unit: 'ZV-1', op: 'ZVOP1', name: 'CERO UNO', rate: 3000, days: [3450, 3450] }]);
    expect(await paid('ZV-1')).toBe(6900);
    await load([{ unit: 'ZV-1' }]); expect(await paid('ZV-1')).toBe(6900);                            // vacío: se conserva
    await load([{ unit: 'ZV-1', days: [null, 0, 5000] }]); expect(await paid('ZV-1')).toBe(3450);      // 0 anula el martes; el 50 de una fila sin operario no se registra
    await load([{ unit: 'ZV-1', days: [0, 0] }]); expect(await paid('ZV-1')).toBe(0);
    const again = await load([{ unit: 'ZV-1', days: [0, 0] }]); expect(again.pv.payments.zeroed).toBe(0); expect(await live('ZV-1')).toEqual([]);
  });
  it('cambio de WhatsApp: se actualiza; una celda vacía no lo borra; una fila incompleta (con nombre) no desvincula', async () => {
    await load([{ ...one, phone: '+50761259999' }]);
    expect((await live('SV-1'))[0].tel).toBe('+50761259999');
    await load([{ ...one, phone: undefined }]); expect((await live('SV-1'))[0].tel).toBe('+50761259999');
    const partial = await load([{ unit: 'SV-1', name: 'AMBROSIO PRUEBA' }]);
    expect(partial.pv.assignments_ended).toBe(0); expect((await live('SV-1')).length).toBe(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('unidad que queda sin operario en el Excel de la semana en curso (caso P280 · operario 10325)', () => {
  let db: Db; let k: ReturnType<typeof kit>; let week: string;
  beforeAll(async () => {
    db = await newDb(); k = kit(db);
    week = (await db.su.query(`select app_private.week_start_of((now() at time zone app_private.tz())::date)::text w`)).rows[0].w;
  }, 120_000);
  afterAll(async () => { await db.close(); });
  const P280 = (over: Partial<Row> = {}): Row => ({ unit: 'P280', op: '10325', name: 'EX OPERARIO', rate: 3900, saldo: '199', phone: '+50760000280', days: NONE, ...over });
  const empty = (): Row => ({ unit: 'P280', days: NONE });
  const state = () => k.one(`select count(*)::int asignaciones, count(*) filter (where a.valid_to is null)::int abiertas, max(a.valid_to)::text fin,
      (select count(*)::int from public.drivers where operator_code = '10325') conductor, (select count(*)::int from public.charges) cargos,
      (select count(*)::int from public.payments) pagos from public.assignments a join public.units u on u.id = a.unit_id where u.code = 'P280'`);
  const codes = (r: any) => (r.warnings as { code: string }[]).map((w) => w.code);

  it('finaliza la asignación conservando historial; volver a subir el mismo Excel (u otro igual) no la reactiva ni duplica', async () => {
    await k.apply(await k.stage([P280()]), week);
    const before = await state();
    expect(before).toMatchObject({ asignaciones: 1, abiertas: 1, conductor: 1 });
    const imp = await k.stage([empty()]);
    const pv = await k.preview(imp, week);
    expect(pv.assignments_ended).toBe(1);
    expect(codes(pv)).toContain('unit_vacated');
    expect((await state()).abiertas).toBe(1);                                        // la vista previa no escribe
    await k.apply(imp, week);
    const after = await state();
    expect(after).toMatchObject({ asignaciones: 1, abiertas: 0, conductor: 1, cargos: before.cargos, pagos: before.pagos });
    expect(after.fin).not.toBeNull();
    for (const again of [imp, await k.stage([empty()])]) {
      expect((await k.apply(again, week)).assignments_ended ?? 0).toBe(0);
      expect(await state()).toEqual(after);
    }
  });
});

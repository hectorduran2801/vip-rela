import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MON, addDays, chargeWeek, pay } from './fixtures.js';
import { newDb, type Db, type Q } from './harness.js';

/**
 * SALDO del Excel = DEUDA arrastrada de la semana anterior → cargo `opening` (domingo anterior a la semana), auditado e idempotente.
 * Cada escenario usa su propia semana (W(k)) y su propia asignación (nace el lunes de esa semana) para no mezclarse con los demás.
 */
let db: Db; let n = 0; let sha = 0;
beforeAll(async () => { db = await newDb(); });
afterAll(async () => { await db.close(); });
const adm = <T>(fn: (q: Q) => Promise<T>, who = db.admin) => db.as(who, fn);
const W = (k: number) => addDays(MON, 7 * k);
const at = (d: string, h = 12) => `${d}T${String(h).padStart(2, '0')}:00:00-05:00`;
const person = async (week: string, rate = 3900) => { n += 1; return db.driverWithAssignment({ code: `OB${n}`, unit: `OBU${n}`, dailyCents: rate, from: week }); };

type SRow = { op?: string | null; unit?: string | null; saldo?: string | null; block?: number; approved?: boolean; match?: string; phone?: string | null; nid?: string; name?: string; rate?: number | null };
async function stage(rows: SRow[], o: { status?: string; kind?: string } = {}) {
  const imp = (await db.su.query(`insert into public.excel_imports(file_name, file_sha256, status, created_by, source_kind) values ('s.xlsx',$1,$2,$3,$4) returning id`,
    [`ob-${++sha}`, o.status ?? 'confirmed', db.admin, o.kind ?? 'cobranza'])).rows[0].id as string;
  const blocks = new Map<number, string>(); let k = 1;
  for (const r of rows) {
    const b = r.block ?? 1;
    if (!blocks.has(b)) blocks.set(b, (await db.su.query(`insert into public.import_blocks(import_id, block_index, start_column, header_variant) values ($1,$2,'A','PAGO SEMANAL') returning id`, [imp, b])).rows[0].id);
    await db.su.query(`insert into public.import_rows(block_id, source_row, unit_code, operator_code, national_id, full_name, daily_rate_cents, raw_saldo, match_status, review_status, raw_phone, phone_e164)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)`,
      [blocks.get(b), ++k, r.unit ?? null, r.op ?? null, r.nid ?? (r.op ? `N-${r.op}` : null), r.name ?? 'PERSONA', r.rate ?? null, r.saldo ?? null, r.match ?? 'unmatched', r.approved === false ? 'pending' : 'approved', r.phone ?? null]);
  }
  return { imp, block: blocks.get(1)!, blocks };
}
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;   // pg entrega `date` como Date local
const preview = (s: { imp: string; block: string }, week: string, who = db.admin) =>
  adm((q) => q.rows(`select * from public.preview_opening_balances($1,$2,$3::date)`, [s.imp, s.block, week]), who)
    .then((rows) => rows.map((r) => ({ ...r, existing_opening_week_start: r.existing_opening_week_start instanceof Date ? ymd(r.existing_opening_week_start) : r.existing_opening_week_start })));
const apply = (s: { imp: string; block: string }, week: string, who = db.admin, note: string | null = null) =>
  adm((q) => q.one(`select public.apply_opening_balances($1,$2,$3::date,$4) r`, [s.imp, s.block, week, note]).then((x) => x.r), who);
const byOp = (rows: any[], unit: string) => rows.find((r) => r.unit_code === unit);
const openings = async (asg: string) => (await db.su.query(`select amount_cents::int a, charge_date::text d, week_start::text w, kind from public.charges where assignment_id=$1 and kind='opening'`, [asg])).rows;
const pos = (asg: string) => adm((q) => q.one(`select charged_cents::int ch, net_cents::int net, pending_cents::int pending, credit_cents::int credit from public.assignment_position($1)`, [asg]));
const cov = (asg: string) => adm((q) => q.rows(`select kind, charge_date::text d, amount_cents::int a, covered_cents::int c, remaining_cents::int r from public.assignment_coverage($1) order by charge_date`, [asg]));
const tableRow = async (week: string, asg: string) => {
  const r = (await adm((q) => q.rows(`select * from public.weekly_collection_table($1::date)`, [week]))).find((x) => x.assignment_id === asg);
  return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, k.endsWith('_cents') ? Number(v) : v])) as Record<string, any>;
};
const detail = async (asg: string, week: string) => {
  const r = (await adm((q) => q.rows(`select * from public.weekly_collection_detail($1::date,$2)`, [week, asg])))[0];
  return { prevP: Number(r.previous_pending_cents), prevC: Number(r.previous_credit_cents), days: r.days as Array<{ date: string; charge_cents: number; remaining_cents: number }> };
};

describe('importación de CUENTA y SALDO → apertura → cuotas (ejemplo P280: SALDO 119 + 6×39 = 353)', () => {
  const week = W(1); let asg: string; let s: { imp: string; block: string };
  it('apply_import crea la asignación con la CUENTA y el SALDO queda crudo: ninguna deuda todavía', async () => {
    s = await stage([{ op: 'P280-OP', unit: 'P280', saldo: '119', rate: 3900, nid: 'N-P280' }, { op: 'P281-OP', unit: 'P281', saldo: null, rate: 3900, nid: 'N-P281' }]);
    await adm((q) => q.one(`select public.apply_import($1,$2::date) r`, [s.imp, week]));
    asg = (await db.su.query(`select a.id from public.assignments a join public.units u on u.id=a.unit_id where u.code='P280'`)).rows[0].id;
    expect((await db.su.query(`select daily_amount_cents::int r from public.rates where assignment_id=$1`, [asg])).rows[0].r).toBe(3900);
    expect(await pos(asg)).toMatchObject({ ch: 0, pending: 0, credit: 0 });
    expect(await openings(asg)).toEqual([]);
  });
  it('conciliación previa (solo lectura): propone crear 11900 y no escribe nada', async () => {
    const rows = await preview(s, week);
    expect(rows).toHaveLength(2);
    expect(byOp(rows, 'P280')).toMatchObject({ assignment_id: asg, operator_code: 'P280-OP', saldo_state: 'amount', action: 'create', existing_opening_cents: null, prior_records: false });
    expect(Number(byOp(rows, 'P280').saldo_excel_cents)).toBe(11900); expect(Number(byOp(rows, 'P280').pending_before_cents)).toBe(0);
    expect(byOp(rows, 'P281')).toMatchObject({ saldo_state: 'empty', action: 'skip_empty', saldo_excel_cents: null });
    expect(await openings(asg)).toEqual([]);
  });
  it('aplicar crea la apertura el DOMINGO anterior: deuda de 119 y ninguna cuota generada', async () => {
    const r = await apply(s, week, db.admin, 'Excel de la semana 1');
    expect(r).toMatchObject({ created: 1, created_cents: 11900, unchanged: 0, conflicts: 0, skipped_empty: 1, skipped_zero: 0, skipped_text: 0, no_assignment: 0, ambiguous: 0, week_start: week });
    expect(await openings(asg)).toEqual([{ a: 11900, d: addDays(week, -1), w: addDays(week, -7), kind: 'opening' }]);
    expect(await pos(asg)).toMatchObject({ ch: 11900, pending: 11900 });
    const c = (await db.su.query(`select source_import_id, source_row_id from public.charges where assignment_id=$1 and kind='opening'`, [asg])).rows[0];
    expect(c.source_import_id).toBe(s.imp); expect(c.source_row_id).not.toBeNull();
  });
  it('queda auditada con importación, bloque, semana y la nota de quien aplica', async () => {
    const a = (await db.su.query(`select actor, entity_id, detail from public.audit_logs where action='apply_opening_balances' order by id desc limit 1`)).rows[0];
    expect(a.actor).toBe(db.admin); expect(a.entity_id).toBe(s.imp);
    expect(a.detail).toMatchObject({ import_id: s.imp, block_id: s.block, week_start: week, created: 1, actor_note: 'Excel de la semana 1' });
    expect(a.detail.items[0]).toMatchObject({ assignment_id: asg, amount_cents: 11900 });
    expect((await db.su.query(`select summary->'opening' o from public.excel_imports where id=$1`, [s.imp])).rows[0].o[`${s.block}:${week}`]).toMatchObject({ created: 1 });
  });
  it('exigible según los días generados: lunes → 119 + 39; semana completa → 353', async () => {
    await adm((q) => q.one(`select public.generate_daily_charges($1::date)`, [week]));
    expect(await adm((q) => q.one(`select today_cents::int t, overdue_cents::int o, future_cents::int f, total_pending_cents::int tot from public.assignment_dues($1,$2::date)`, [asg, week])))
      .toEqual({ t: 3900, o: 11900, f: 0, tot: 15800 });
    await chargeWeek(db, week);
    expect(await pos(asg)).toMatchObject({ ch: 35300, pending: 35300, credit: 0 });          // 11900 + 6 × 3900 = $353
    const t = await tableRow(week, asg);
    expect(t).toMatchObject({ previous_pending_cents: 11900, previous_credit_cents: 0, opening_cents: 11900, week_charged_cents: 23400, pending_cents: 35300, credit_cents: 0 });
  });
  it('la tabla y el detalle coinciden: deuda anterior, 6 cuotas (domingo sin cuota) y saldo', async () => {
    const t = await tableRow(week, asg); const d = await detail(asg, week);
    expect(d.prevP).toBe(t.previous_pending_cents);
    expect(d.days.map((x) => x.charge_cents)).toEqual([3900, 3900, 3900, 3900, 3900, 3900, 0]);    // la apertura NO es una cuota de ningún día
    const openingRemaining = (await cov(asg)).find((c) => c.kind === 'opening')!.r;
    expect(d.days.reduce((a, x) => a + x.remaining_cents, 0) + openingRemaining).toBe(t.pending_cents);
  });
  it('la semana anterior (donde cae el domingo de apertura) NO cuenta la apertura como cuota ni como cuota del domingo', async () => {
    const t = await tableRow(addDays(week, -7), asg).catch(() => null);
    if (t) expect(t.week_charged_cents).toBe(0);                                              // (la asignación nace en `week`: normalmente no aparece)
    const d = await detail(asg, addDays(week, -7)).catch(() => null);
    if (d) expect(d.days[6]!.charge_cents).toBe(0);
  });
  it('un pago cubre PRIMERO la deuda antigua (apertura) y luego las cuotas; los parciales avanzan en orden', async () => {
    await adm((q) => pay(q, asg, 'cash', 10000, { paidAt: at(week) }));
    let c = await cov(asg);
    expect(c[0]).toMatchObject({ kind: 'opening', a: 11900, c: 10000, r: 1900 });
    expect(c[1]).toMatchObject({ kind: 'daily', c: 0, r: 3900 });
    await adm((q) => pay(q, asg, 'cash', 5000, { paidAt: at(week) }));
    c = await cov(asg);
    expect(c[0]).toMatchObject({ c: 11900, r: 0 });                                            // 1900 terminan la apertura…
    expect(c[1]).toMatchObject({ kind: 'daily', c: 3100, r: 800 });                            // …y 3100 van a la cuota del lunes
    expect(await pos(asg)).toMatchObject({ net: 15000, pending: 20300 });
    const alloc = (await db.su.query(`select c.kind, sum(pa.amount_cents)::int a from public.payment_allocations pa join public.charges c on c.id=pa.charge_id join public.payments p on p.id=pa.payment_id where p.assignment_id=$1 group by c.kind order by c.kind`, [asg])).rows;
    expect(alloc).toEqual([{ kind: 'daily', a: 3100 }, { kind: 'opening', a: 11900 }]);
  });
  it('el pago del DOMINGO cancela los faltantes de lunes a sábado; luego queda al día', async () => {
    const r = await adm((q) => pay(q, asg, 'cash', 20300, { paidAt: at(addDays(week, 6)) }));
    expect(r.applied_cents ?? r.payment?.applied_cents).toBeDefined();
    expect(await pos(asg)).toMatchObject({ pending: 0, credit: 0 });
    expect((await cov(asg)).every((c) => c.r === 0)).toBe(true);
  });
  it('crédito a favor tras cubrir todo (apertura + cuotas)', async () => {
    await adm((q) => pay(q, asg, 'cash', 1000, { paidAt: at(addDays(week, 6), 15) }));
    expect(await pos(asg)).toMatchObject({ pending: 0, credit: 1000 });
    expect(Number((await tableRow(week, asg)).credit_cents)).toBe(1000);
  });
});

describe('Yappy: la comisión de $1 se descuenta antes del abono neto, también sobre deuda antigua', () => {
  it('12000 brutos → 11900 netos cubren exactamente la apertura; el siguiente Yappy genera crédito neto', async () => {
    const week = W(2); const a = await person(week);
    const s = await stage([{ op: `OB${n}`, unit: `OBU${n}`, saldo: '119' }]);
    await apply(s, week);
    const r = await adm((q) => pay(q, a.assignment, 'yappy', 12000, { paidAt: at(week) }));
    expect(r).toMatchObject({ commission_cents: 100, net_cents: 11900, applied_cents: 11900, credit_generated_cents: 0 });
    expect((await cov(a.assignment))[0]).toMatchObject({ kind: 'opening', c: 11900, r: 0 });
    expect(await pos(a.assignment)).toMatchObject({ pending: 0, credit: 0 });
    const r2 = await adm((q) => pay(q, a.assignment, 'yappy', 5000, { paidAt: at(week) }));
    expect(r2).toMatchObject({ commission_cents: 100, net_cents: 4900, applied_cents: 0, credit_generated_cents: 4900 });
  });
});

describe('idempotencia y conflictos: nunca duplica ni sobrescribe', () => {
  const week = W(3); let a: Awaited<ReturnType<typeof person>>; let s1: Awaited<ReturnType<typeof stage>>;
  it('aplicar dos veces el mismo bloque/semana no duplica la deuda', async () => {
    a = await person(week);
    s1 = await stage([{ op: `OB${n}`, unit: `OBU${n}`, saldo: '50' }]);
    expect(await apply(s1, week)).toMatchObject({ created: 1, unchanged: 0 });
    expect(await apply(s1, week)).toMatchObject({ created: 0, unchanged: 1, conflicts: 0 });
    expect(await openings(a.assignment)).toHaveLength(1);
    expect(await pos(a.assignment)).toMatchObject({ pending: 5000 });
    expect(byOp(await preview(s1, week), `OBU${n}`)).toMatchObject({ action: 'unchanged', existing_opening_cents: '5000', existing_opening_week_start: week });
  });
  it('reimportar el mismo contenido en otro archivo (mismo importe, misma semana) tampoco duplica', async () => {
    const s2 = await stage([{ op: `OB${n}`, unit: `OBU${n}`, saldo: '50.00' }]);
    expect(await apply(s2, week)).toMatchObject({ created: 0, unchanged: 1 });
    expect(await pos(a.assignment)).toMatchObject({ pending: 5000 });
  });
  it('apertura existente con OTRO importe → conflicto: no se sobrescribe ni se borra', async () => {
    const s3 = await stage([{ op: `OB${n}`, unit: `OBU${n}`, saldo: '60' }]);
    const p = byOp(await preview(s3, week), `OBU${n}`);
    expect(p).toMatchObject({ action: 'conflict', existing_opening_cents: '5000' }); expect(p.note).toMatch(/no se sobrescribe/);
    expect(await apply(s3, week)).toMatchObject({ created: 0, conflicts: 1 });
    expect(await openings(a.assignment)).toEqual([{ a: 5000, d: addDays(week, -1), w: addDays(week, -7), kind: 'opening' }]);
  });
  it('el mismo importe pero para OTRA semana también es conflicto (un solo opening por asignación)', async () => {
    const s4 = await stage([{ op: `OB${n}`, unit: `OBU${n}`, saldo: '50' }]);
    expect(byOp(await preview(s4, addDays(week, 7)), `OBU${n}`)).toMatchObject({ action: 'conflict' });
    expect(await apply(s4, addDays(week, 7))).toMatchObject({ created: 0, conflicts: 1 });
    expect(await openings(a.assignment)).toHaveLength(1);
  });
  it('se rechaza una segunda apertura directa, una apertura que no cae en domingo y cualquier UPDATE/DELETE', async () => {
    const c = (await db.su.query(`select id from public.charges where assignment_id=$1 and kind='opening'`, [a.assignment])).rows[0].id;
    await expect(db.su.query(`insert into public.charges(assignment_id, kind, charge_date, amount_cents, week_start) values ($1,'opening',$2,100,$3)`, [a.assignment, addDays(week, -8), addDays(week, -14)])).rejects.toThrow(/charges_one_opening_per_assignment/);
    const b = await person(W(4));
    await expect(db.su.query(`insert into public.charges(assignment_id, kind, charge_date, amount_cents, week_start) values ($1,'opening',$2,100,$2)`, [b.assignment, W(4)])).rejects.toThrow(/charges_opening_on_sunday/);
    await expect(db.su.query(`update public.charges set amount_cents = 1 where id=$1`, [c])).rejects.toThrow();
    await expect(db.su.query(`delete from public.charges where id=$1`, [c])).rejects.toThrow();
  });
});

describe('SALDO vacío ≠ 0 ≠ texto; filas sin asignación o ambiguas', () => {
  it('vacío, 0 y texto no crean nada; las filas resueltas se concilian por separado', async () => {
    const week = W(5);
    const e = await person(week), z = await person(week), t = await person(week), t2 = await person(week), ok = await person(week);
    const code = (x: { assignment: string }) => db.su.query(`select d.operator_code op, u.code unit from public.assignments a join public.drivers d on d.id=a.driver_id join public.units u on u.id=a.unit_id where a.id=$1`, [x.assignment]).then((r) => r.rows[0]);
    const [ce, cz, ct, ct2, cok] = await Promise.all([e, z, t, t2, ok].map(code));
    const dup = await person(week); const cdup = await code(dup);
    const s = await stage([
      { op: ce.op, unit: ce.unit, saldo: null }, { op: cz.op, unit: cz.unit, saldo: '0' }, { op: ct.op, unit: ct.unit, saldo: 'ver nota' }, { op: ct2.op, unit: ct2.unit, saldo: '-5' },
      { op: cok.op, unit: cok.unit, saldo: '$ 25.50' }, { op: 'NO-EXISTE', unit: 'NOEXISTE', saldo: '10' },
      { op: cdup.op, unit: cdup.unit, saldo: '10' }, { op: cdup.op, unit: null, saldo: '10' },
      { op: null, unit: null, saldo: '5' }, { op: 'IGN', unit: 'IGN', saldo: '5', match: 'ignored' }, { op: ce.op, unit: ce.unit, saldo: '9', approved: false }]);
    const rows = await preview(s, week);
    expect(rows.map((r) => r.action)).toEqual(['skip_empty', 'skip_zero', 'skip_text', 'skip_text', 'create', 'no_assignment', 'ambiguous', 'ambiguous', 'no_assignment']);
    expect(rows.map((r) => r.saldo_state)).toEqual(['empty', 'zero', 'text', 'text', 'amount', 'amount', 'amount', 'amount', 'amount']);
    expect(rows[0]!.saldo_excel_cents).toBeNull(); expect(rows[1]!.saldo_excel_cents).toBe('0'); expect(rows[2]!.saldo_excel_cents).toBeNull();
    expect(rows[2]!.note).toMatch(/numérico/); expect(rows[3]!.note).toMatch(/negativo/);
    const r = await apply(s, week);
    expect(r).toMatchObject({ rows: 9, created: 1, created_cents: 2550, skipped_empty: 1, skipped_zero: 1, skipped_text: 2, no_assignment: 2, ambiguous: 2, unchanged: 0, conflicts: 0 });
    for (const x of [e, z, t, t2, dup]) expect(await openings(x.assignment)).toEqual([]);          // vacío ≠ 0: nada se registra
    expect(await openings(ok.assignment)).toHaveLength(1);
    expect((await pos(ok.assignment)).pending).toBe(2550);
  });
  it('el operario y la unidad deben apuntar a la MISMA asignación', async () => {
    const week = W(5); const x = await person(week), y = await person(week);
    const cx = (await db.su.query(`select d.operator_code op from public.assignments a join public.drivers d on d.id=a.driver_id where a.id=$1`, [x.assignment])).rows[0].op;
    const cy = (await db.su.query(`select u.code unit from public.assignments a join public.units u on u.id=a.unit_id where a.id=$1`, [y.assignment])).rows[0].unit;
    const s = await stage([{ op: cx, unit: cy, saldo: '10' }]);
    expect((await preview(s, week))[0]).toMatchObject({ action: 'ambiguous' });
  });
});

describe('estados, bloque y permisos', () => {
  it('la importación debe estar confirmada/aplicada, ser de cobranza y el bloque pertenecer a ella; la semana empieza en lunes', async () => {
    const week = W(6); await person(week);
    const prev = await stage([{ op: 'X', unit: 'X', saldo: '1' }], { status: 'previewed' });
    expect(await adm((q) => q.fails(`select * from public.preview_opening_balances($1,$2,$3::date)`, [prev.imp, prev.block, week]))).toBe('import_not_confirmed');
    const dir = await stage([{ op: 'X', unit: 'X', saldo: '1' }], { kind: 'directory' });
    expect(await adm((q) => q.fails(`select * from public.preview_opening_balances($1,$2,$3::date)`, [dir.imp, dir.block, week]))).toBe('wrong_import_kind');
    const ok = await stage([{ op: 'X', unit: 'X', saldo: '1' }]), other = await stage([{ op: 'X', unit: 'X', saldo: '1' }]);
    expect(await adm((q) => q.fails(`select * from public.preview_opening_balances($1,$2,$3::date)`, [ok.imp, other.block, week]))).toBe('block_not_found');
    expect(await adm((q) => q.fails(`select * from public.preview_opening_balances($1,$2,$3::date)`, [ok.imp, ok.block, addDays(week, 1)]))).toBe('week_start_must_be_monday');
    expect(await adm((q) => q.fails(`select * from public.preview_opening_balances(gen_random_uuid(),$1,$2::date)`, [ok.block, week]))).toBe('import_not_found');
    expect(await adm((q) => q.fails(`select public.apply_opening_balances($1,$2,$3::date)`, [prev.imp, prev.block, week]))).toBe('import_not_confirmed');
    await db.su.query(`update public.excel_imports set status='applied' where id=$1`, [ok.imp]);                 // un import ya aplicado también vale
    expect(await preview(ok, week)).toHaveLength(1);
  });
  it('SUPER_ADMIN y ADMIN sí; supervisor, usuario externo y anónimo no', async () => {
    const week = W(7); const x = await person(week);
    const cx = (await db.su.query(`select d.operator_code op, u.code unit from public.assignments a join public.drivers d on d.id=a.driver_id join public.units u on u.id=a.unit_id where a.id=$1`, [x.assignment])).rows[0];
    const s = await stage([{ op: cx.op, unit: cx.unit, saldo: '7' }]);
    expect(await preview(s, week, db.opsAdmin)).toHaveLength(1);
    for (const who of [db.supervisor, db.outsider]) {
      expect(await adm((q) => q.fails(`select * from public.preview_opening_balances($1,$2,$3::date)`, [s.imp, s.block, week]), who)).toBe('forbidden');
      expect(await adm((q) => q.fails(`select public.apply_opening_balances($1,$2,$3::date)`, [s.imp, s.block, week]), who)).toBe('forbidden');
    }
    expect(await db.asAnon((q) => q.fails(`select * from public.preview_opening_balances($1,$2,$3::date)`, [s.imp, s.block, week]))).toMatch(/permission denied/);
    expect(await db.asAnon((q) => q.fails(`select public.apply_opening_balances($1,$2,$3::date)`, [s.imp, s.block, week]))).toMatch(/permission denied/);
    expect(await openings(x.assignment)).toEqual([]);
    expect(await apply(s, week, db.opsAdmin)).toMatchObject({ created: 1 });
  });
});

describe('cierre semanal: conserva deuda y crédito, no duplica y la semana siguiente recibe la deuda', () => {
  it('close_week excluye la apertura de «cuotas generadas», conserva la posición y es idempotente; el domingo se puede seguir pagando', async () => {
    const week = W(8); const a = await person(week), c = await person(week);
    const cd = async (x: { assignment: string }) => (await db.su.query(`select d.operator_code op, u.code unit from public.assignments a join public.drivers d on d.id=a.driver_id join public.units u on u.id=a.unit_id where a.id=$1`, [x.assignment])).rows[0];
    const [ca, cc] = [await cd(a), await cd(c)];
    const s = await stage([{ op: ca.op, unit: ca.unit, saldo: '119' }, { op: cc.op, unit: cc.unit, saldo: '10' }]);
    await apply(s, week);
    await chargeWeek(db, week);
    await adm((q) => pay(q, a.assignment, 'cash', 15000, { paidAt: at(week) }));
    await adm((q) => pay(q, c.assignment, 'cash', 50000, { paidAt: at(week) }));              // paga de más: 10 + 234 = 244 → crédito 256
    const closed = await adm((q) => q.one(`select public.close_week($1::date) n`, [week]));
    expect(Number(closed.n)).toBeGreaterThanOrEqual(2);
    const cl = async (x: { assignment: string }, w = week) => (await db.su.query(`select charged_cents::int ch, net_cents::int net, pending_cents::int p, credit_cents::int cr from public.weekly_closures where assignment_id=$1 and week_start=$2`, [x.assignment, w])).rows;
    expect(await cl(a)).toEqual([{ ch: 23400, net: 15000, p: 20300, cr: 0 }]);               // 353 − 150: la apertura NO se cuenta dos veces ni como cuota
    expect(await cl(c)).toEqual([{ ch: 23400, net: 50000, p: 0, cr: 25600 }]);                // el crédito se conserva
    expect(Number((await adm((q) => q.one(`select public.close_week($1::date) n`, [week]))).n)).toBe(0);
    expect(await cl(a)).toHaveLength(1);
    // La semana siguiente recibe la deuda (y el crédito) tal cual.
    await chargeWeek(db, addDays(week, 7));
    const t1 = await tableRow(addDays(week, 7), a.assignment), t2 = await tableRow(addDays(week, 7), c.assignment);
    expect(t1).toMatchObject({ previous_pending_cents: 20300, opening_cents: 0, week_charged_cents: 23400, pending_cents: 43700 });
    expect(t2).toMatchObject({ previous_pending_cents: 0, previous_credit_cents: 25600, pending_cents: 0, credit_cents: 2200 });
    await adm((q) => q.one(`select public.close_week($1::date)`, [addDays(week, 7)]));
    expect(await cl(a, addDays(week, 7))).toEqual([{ ch: 23400, net: 0, p: 43700, cr: 0 }]);
    // Pagar el domingo (de la semana ya cerrada) sigue permitido y se aplica a lo más antiguo.
    await adm((q) => pay(q, a.assignment, 'cash', 5000, { paidAt: at(addDays(week, 6)) }));
    expect(await pos(a.assignment)).toMatchObject({ pending: 43700 - 5000 });
  });
});

describe('informes: la apertura es deuda anterior, no cuota generada', () => {
  let d2: Db;
  beforeAll(async () => { d2 = await newDb(); });
  afterAll(async () => { await d2.close(); });
  it('period_summary, tabla semanal, movimientos y plantilla muestran la apertura aparte', async () => {
    const week = MON; const x = await d2.driverWithAssignment({ code: 'RP1', unit: 'RPU1', dailyCents: 3900, from: week });
    const mk = async (rows: SRow[]) => {
      const imp = (await d2.su.query(`insert into public.excel_imports(file_name, file_sha256, status, created_by) values ('r.xlsx','r-${Math.random()}','confirmed',$1) returning id`, [d2.admin])).rows[0].id;
      const blk = (await d2.su.query(`insert into public.import_blocks(import_id, block_index, start_column, header_variant) values ($1,1,'A','PAGO SEMANAL') returning id`, [imp])).rows[0].id;
      for (const [i, r] of rows.entries()) await d2.su.query(`insert into public.import_rows(block_id, source_row, unit_code, operator_code, raw_saldo, review_status) values ($1,$2,$3,$4,$5,'approved')`, [blk, i + 2, r.unit, r.op, r.saldo]);
      return { imp, blk };
    };
    const { imp, blk } = await mk([{ op: 'RP1', unit: 'RPU1', saldo: '119' }]);
    await d2.as(d2.admin, (q) => q.one(`select public.apply_opening_balances($1,$2,$3::date) r`, [imp, blk, week]));
    await chargeWeek(d2, week);
    await d2.as(d2.admin, (q) => pay(q, x.assignment, 'cash', 10000, { paidAt: at(week) }));
    const ps = (from: string, to: string) => d2.as(d2.admin, (q) => q.one(`select public.period_summary($1::date,$2::date) s`, [from, to])).then((r) => r.s);
    const inWeek = await ps(week, addDays(week, 6));
    expect(inWeek).toMatchObject({ expected_cents: 23400, charges_generated_cents: 23400, opening_charged_cents: 0, net_cents: 10000, prior_debt_recovered_cents: 10000, applied_to_period_cents: 0, pending_end_cents: 25300 });
    const withSunday = await ps(addDays(week, -1), addDays(week, 6));
    expect(withSunday).toMatchObject({ expected_cents: 23400, charges_generated_cents: 23400, adjustments_charged_cents: 0, opening_charged_cents: 11900, difference_cents: 10000 - 23400, pending_end_cents: 25300 });
    // tabla semanal: deuda anterior vs cuotas generadas vs saldo exigible
    expect(await (async () => { const r = (await d2.as(d2.admin, (q) => q.rows(`select * from public.weekly_collection_table($1::date)`, [week])))[0]; return { pp: Number(r.previous_pending_cents), pc: Number(r.previous_credit_cents), op: Number(r.opening_cents), wc: Number(r.week_charged_cents), p: Number(r.pending_cents), diff: Number(r.week_diff_cents) }; })())
      .toEqual({ pp: 11900, pc: 0, op: 11900, wc: 23400, p: 25300, diff: 10000 - 23400 });
    // la semana anterior (donde cae el domingo) no muestra la apertura como cuota
    const prevWeek = (await d2.as(d2.admin, (q) => q.rows(`select * from public.weekly_collection_table($1::date)`, [addDays(week, -7)])));
    expect(prevWeek.every((r) => Number(r.week_charged_cents) === 0)).toBe(true);
    // movimientos: la apertura aparece como movimiento propio
    const mv = (await d2.su.query(`select kind, amount_cents::int a, detail from public.v_movements where assignment_id=$1 and kind='opening'`, [x.assignment])).rows;
    expect(mv).toEqual([{ kind: 'opening', a: 11900, detail: `Deuda anterior (apertura) al ${addDays(week, -1)}` }]);
    // plantillas: «cuenta_semana» no incluye la apertura (domingo de apertura) y la deuda anterior sí
    const tpl = (date: string) => d2.as(d2.admin, (q) => q.one(`select public.preview_template($1,'{{cuenta_semana}}|{{deuda_anterior}}|{{cuota_hoy}}',$2::date) r`, [x.assignment, date])).then((r) => r.r.text);
    expect(await tpl(addDays(week, -1))).toBe('$0.00|$19.00|$0.00')   // 119 − 100 pagados el lunes;
    expect(await tpl(week)).toBe('$234.00|$19.00|$39.00');
    // detalle del período: etiqueta de la apertura
    const det = await d2.as(d2.admin, (q) => q.rows(`select kind, amount_cents::int a, detail from public.period_detail($1::date,$2::date,'charges') where kind='opening'`, [addDays(week, -1), addDays(week, -1)]));
    expect(det).toEqual([{ kind: 'opening', a: 11900, detail: 'Deuda anterior (apertura)' }]);
  });
  it('dashboard_summary: la apertura (domingo de la semana en curso) no suma a las cuotas de la semana', async () => {
    const dash = () => d2.as(d2.admin, (q) => q.one(`select public.dashboard_summary() s`)).then((r) => r.s);
    const before = await dash(); const next = addDays(before.week_start, 7);
    const y = await d2.driverWithAssignment({ code: 'RP2', unit: 'RPU2', dailyCents: 3900, from: '2026-01-01' });
    const imp = (await d2.su.query(`insert into public.excel_imports(file_name, file_sha256, status, created_by) values ('r.xlsx','r-${Math.random()}','confirmed',$1) returning id`, [d2.admin])).rows[0].id;
    const blk = (await d2.su.query(`insert into public.import_blocks(import_id, block_index, start_column, header_variant) values ($1,1,'A','X') returning id`, [imp])).rows[0].id;
    await d2.su.query(`insert into public.import_rows(block_id, source_row, unit_code, operator_code, raw_saldo, review_status) values ($1,2,'RPU2','RP2','77','approved')`, [blk]);
    await d2.as(d2.admin, (q) => q.one(`select public.apply_opening_balances($1,$2,$3::date)`, [imp, blk, next]));
    expect((await d2.su.query(`select week_start::text w from public.charges where assignment_id=$1 and kind='opening'`, [y.assignment])).rows[0].w).toBe(before.week_start);   // cae en la semana en curso…
    const after = await dash();
    expect(after.collections.week_charged_cents).toBe(before.collections.week_charged_cents);                                                              // …pero no es cuota generada
    expect(after.collections.pending_total_cents).toBe(before.collections.pending_total_cents + 7700);                                                     // sí es deuda
  });
});

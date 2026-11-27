import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MON, chargeWeek, key, pay, position } from './fixtures.js';
import { newDb, type Db, type Q } from './harness.js';

let db: Db;
beforeAll(async () => { db = await newDb(); });
afterAll(async () => { await db.close(); });
const adm = <T>(fn: (q: Q) => Promise<T>) => db.as(db.admin, fn);
const newUnit = async (code: string) => (await db.su.query(`insert into public.units(code) values ($1) returning id`, [code])).rows[0].id as string;
const setAg = (id: string, agreement: string | null, note: string | null = null, who = db.admin) =>
  db.as(who, (q) => q.one(`select public.set_unit_agreement($1,$2,$3) r`, [id, agreement, note])).then((x) => x.r);

describe('código de unidad y operario', () => {
  it('el código de unidad es obligatorio y único (sin distinguir mayúsculas ni espacios); el operario es independiente', async () => {
    await newUnit('P300');
    const e = (sql: string) => db.su.query(sql).then(() => null, (x) => x.message as string);
    expect(await e(`insert into public.units(code) values ('')`)).toMatch(/check/);
    expect(await e(`insert into public.units(code) values ('p300')`)).toMatch(/unique|duplicate/);
    expect(await e(`insert into public.units(code) values (' P300 ')`)).toMatch(/unique|duplicate/);
    await newUnit('P341');       // unidad sin conductor
    expect((await db.su.query(`select count(*)::int n from public.assignments a join public.units u on u.id=a.unit_id where u.code='P341'`)).rows[0].n).toBe(0);
  });
});

describe('Acuerdo / condición especial: texto libre', () => {
  it('acepta cualquier texto (sin lista cerrada) y lo guarda EXACTAMENTE como se escribió (solo se recortan espacios laterales)', async () => {
    const u = await newUnit('P400');
    for (const t of ['CHAPA', 'RESCATE', 'CUSTODIA', 'TAPICERÍA', 'ACUERDO', 'REVISADO PENDIENTE', 'cualquier otra cosa con ñ y acentos: áéíóú', 'CHAPISTERIA']) {
      expect((await setAg(u, `  ${t}  `)).agreement).toBe(t);
      expect((await db.su.query(`select agreement a from public.units where id=$1`, [u])).rows[0].a).toBe(t);     // persistido en la base
    }
  });
  it('no reemplaza CHAPA por CHAPISTERÍA ni normaliza mayúsculas: respeta el valor original', async () => {
    const u = await newUnit('P401'); await setAg(u, 'Chapa'); expect((await db.su.query(`select agreement a from public.units where id=$1`, [u])).rows[0].a).toBe('Chapa');
  });
  it('admite vacío: quitar el acuerdo; la observación es independiente', async () => {
    const u = await newUnit('P402');
    await setAg(u, 'RESCATE', 'Unidad en proceso de rescate');
    expect(await setAg(u, 'CUSTODIA', 'Unidad en proceso de rescate')).toMatchObject({ agreement: 'CUSTODIA', agreement_note: 'Unidad en proceso de rescate' });   // la observación no cambia
    expect(await setAg(u, 'CUSTODIA', 'Otra observación')).toMatchObject({ agreement: 'CUSTODIA', agreement_note: 'Otra observación' });
    expect(await setAg(u, null, 'Otra observación')).toMatchObject({ agreement: null, agreement_note: 'Otra observación' });    // sin acuerdo pero con observación
    expect(await setAg(u, '   ', '   ')).toMatchObject({ agreement: null, agreement_note: null });
  });
  it('límites: 200 caracteres el acuerdo y 1000 la observación', async () => {
    const u = await newUnit('P403');
    expect(await adm((q) => q.fails(`select public.set_unit_agreement($1,$2,null)`, [u, 'x'.repeat(201)]))).toBe('agreement_too_long');
    expect(await adm((q) => q.fails(`select public.set_unit_agreement($1,'ok',$2)`, [u, 'y'.repeat(1001)]))).toBe('note_too_long');
    expect((await setAg(u, 'x'.repeat(200))).agreement.length).toBe(200);
  });
  it('sin cambios reales no escribe nada (evita solicitudes duplicadas): ni historial ni auditoría nuevos', async () => {
    const u = await newUnit('P404');
    await setAg(u, 'CHAPA', 'nota');
    const count = async () => [(await db.su.query(`select count(*)::int n from public.unit_agreement_history where unit_id=$1`, [u])).rows[0].n,
      (await db.su.query(`select count(*)::int n from public.audit_logs where action='set_unit_agreement' and entity_id=$1`, [u])).rows[0].n];
    const before = await count();
    expect((await setAg(u, 'CHAPA', 'nota')).changed).toBe(false);
    expect((await setAg(u, '  CHAPA ', ' nota ')).changed).toBe(false);
    expect(await count()).toEqual(before);
  });
});

describe('permisos', () => {
  it('solo ADMIN y SUPER_ADMIN la editan; SUPERVISOR y usuarios sin rol no; tampoco por UPDATE directo', async () => {
    const u = await newUnit('P410');
    expect(await db.as(db.opsAdmin, (q) => q.fails(`select public.set_unit_agreement($1,'CHAPA',null)`, [u]))).toBeNull();
    expect(await db.as(db.supervisor, (q) => q.fails(`select public.set_unit_agreement($1,'CHAPA',null)`, [u]))).toBe('forbidden');
    expect(await db.as(db.outsider, (q) => q.fails(`select public.set_unit_agreement($1,'CHAPA',null)`, [u]))).toBe('forbidden');
    expect(await db.asAnon((q) => q.fails(`select public.set_unit_agreement($1,'CHAPA',null)`, [u]))).toMatch(/permission denied/);
    expect(await adm((q) => q.fails(`update public.units set agreement = 'X' where id=$1`, [u]))).toMatch(/permission denied/);
    expect(await adm((q) => q.fails(`update public.units set plate = 'AB-999' where id=$1`, [u]))).toBeNull();
    expect((await db.as(db.supervisor, (q) => q.rows(`select agreement from public.units where id=$1`, [u]))).length).toBe(1);     // todos los roles lo leen
  });
});

describe('historial: valor anterior, nuevo, quién y cuándo', () => {
  it('registra cada cambio con el usuario y conserva el valor anterior; auditoría general también', async () => {
    const u = await newUnit('P420');
    await setAg(u, 'CHAPA', 'revisar');
    await setAg(u, 'RESCATE', 'revisar', db.opsAdmin);
    await setAg(u, null, null);
    const h = (await adm((q) => q.rows(`select agreement a, previous_agreement p, note, previous_note pn, changed_by, source, changed_at from public.unit_agreement_history where unit_id=$1 order by id`, [u])));
    expect(h.map((x) => [x.p, x.a])).toEqual([[null, 'CHAPA'], ['CHAPA', 'RESCATE'], ['RESCATE', null]]);
    expect(h.map((x) => x.changed_by)).toEqual([db.admin, db.opsAdmin, db.admin]);
    expect(h[1]).toMatchObject({ note: 'revisar', pn: 'revisar', source: 'manual' });
    expect(h.every((x) => x.changed_at instanceof Date)).toBe(true);
    const log = (await db.su.query(`select detail from public.audit_logs where action='set_unit_agreement' and entity_id=$1 order by id`, [u])).rows;
    expect(log[1].detail).toMatchObject({ previous_agreement: 'CHAPA', agreement: 'RESCATE' });
    expect(await db.su.query(`update public.unit_agreement_history set note='x'`).then(() => null, (e) => e.message)).toMatch(/no permitido/);
    expect(await db.su.query(`delete from public.unit_agreement_history`).then(() => null, (e) => e.message)).toMatch(/no permitido/);
    expect((await db.as(db.outsider, (q) => q.rows(`select 1 from public.unit_agreement_history`))).length).toBe(0);
  });
});

describe('el acuerdo NO altera la contabilidad ni las asignaciones', () => {
  it('cambiar el acuerdo conserva pagos, cargos, tarifas, saldo y asignaciones', async () => {
    const x = await db.driverWithAssignment({ code: 'AG1', unit: 'P430', dailyCents: 3600 });
    await chargeWeek(db, MON);
    await adm((q) => pay(q, x.assignment, 'yappy', 22100, { paidAt: `${MON}T10:00:00-05:00` }));
    const snap = async () => ({ pos: await adm((q) => position(q, x.assignment)),
      pay: (await db.su.query(`select count(*)::int c, sum(net_cents)::int n from public.payments where assignment_id=$1`, [x.assignment])).rows[0],
      ch: (await db.su.query(`select count(*)::int c, sum(amount_cents)::int a from public.charges where assignment_id=$1`, [x.assignment])).rows[0],
      rt: (await db.su.query(`select daily_amount_cents::int d, valid_from::text f, valid_to from public.rates where assignment_id=$1`, [x.assignment])).rows,
      as: (await db.su.query(`select driver_id, unit_id, valid_from::text f, valid_to from public.assignments where id=$1`, [x.assignment])).rows });
    const before = await snap();
    for (const t of ['RESCATE', 'CHAPA', 'otra cosa', null]) await setAg(x.unit, t, t ? 'nota' : null);
    expect(await snap()).toEqual(before);
  });
  it('una unidad activa con acuerdo sigue generando cuotas; estado operativo y acuerdo son independientes', async () => {
    const x = await db.driverWithAssignment({ code: 'AG2', unit: 'P431', dailyCents: 3000 });
    await setAg(x.unit, 'ACUERDO', 'Acuerdo especial de pago');
    await chargeWeek(db, MON);
    expect((await db.su.query(`select count(*)::int n from public.charges where assignment_id=$1`, [x.assignment])).rows[0].n).toBe(6);
    const a = await newUnit('P432'); await db.su.query(`update public.units set vehicle_status='out_of_service' where id=$1`, [a]); await setAg(a, 'CHAPA', 'En reparación');
    expect((await db.su.query(`select vehicle_status s, agreement a from public.units where id=$1`, [a])).rows[0]).toEqual({ s: 'out_of_service', a: 'CHAPA' });
  });
});

describe('búsquedas y filtros', () => {
  it('se puede buscar por texto (sin distinguir mayúsculas) y filtrar unidades sin acuerdo', async () => {
    const u = await newUnit('P440'); await setAg(u, 'Pendiente de REVISADO');
    expect((await adm((q) => q.rows(`select code from public.units where agreement ilike '%revisado%'`))).map((r) => r.code)).toContain('P440');
    expect((await adm((q) => q.rows(`select count(*)::int n from public.units where agreement is null`)))[0].n).toBeGreaterThan(0);
  });
});

type Row = { block: number; op: string; nid: string; name: string; unit: string; rate: number | null; agreement?: string };
let sha = 0;
async function stage(rows: Row[]) {
  const imp = (await db.su.query(`insert into public.excel_imports(file_name, file_sha256, status, created_by) values ('vip.xlsx',$1,'confirmed',$2) returning id`, [`ag-${++sha}`, db.admin])).rows[0].id;
  const blocks = new Map<number, string>(); let k = 1;
  for (const r of rows) {
    if (!blocks.has(r.block)) blocks.set(r.block, (await db.su.query(`insert into public.import_blocks(import_id, block_index, start_column, header_variant) values ($1,$2,'B','PAGO SEMANAL') returning id`, [imp, r.block])).rows[0].id);
    await db.su.query(`insert into public.import_rows(block_id, source_row, unit_code, operator_code, national_id, full_name, daily_rate_cents, raw_agreement, match_status, review_status) values ($1,$2,$3,$4,$5,$6,$7,$8,'unmatched','approved')`,
      [blocks.get(r.block), ++k, r.unit, r.op, r.nid, r.name, r.rate, r.agreement ?? null]);
  }
  return imp as string;
}
const apply = (imp: string, resolve = 'skip') => adm(async (q) => (await q.one(`select public.apply_import($1, '2026-03-02', 'active', $2) r`, [imp, resolve])).r);

describe('importación: el ACUERDO del Excel se guarda tal cual', () => {
  it('importa unidades SIN operario y respeta el texto original de ACUERDO (CHAPA, RESCATE, CHAPISTERIA, ADENDA, P450…) sin inventar conductores ni fechas', async () => {
    const drivers0 = Number((await db.su.query(`select count(*) n from public.drivers`)).rows[0].n);
    const imp = await stage([
      { block: 1, op: '70001', nid: '8-7-1', name: 'CON CONDUCTOR', unit: 'P811', rate: 3600 },
      { block: 1, op: '70002', nid: '8-7-2', name: 'CON ACUERDO', unit: 'P812', rate: 3600, agreement: 'CUSTODIA' },
      { block: 1, op: '', nid: '', name: '', unit: 'P3410', rate: null, agreement: 'CHAPA' }, { block: 1, op: '', nid: '', name: '', unit: 'P3420', rate: null, agreement: 'RESCATE' },
      { block: 1, op: '', nid: '', name: '', unit: 'P3430', rate: null }, { block: 1, op: '', nid: '', name: '', unit: 'P4810', rate: null, agreement: 'P450' },
      { block: 1, op: '', nid: '', name: '', unit: 'P7210', rate: null, agreement: 'POR CHOFER' }, { block: 1, op: '', nid: '', name: '', unit: 'P7220', rate: null, agreement: 'CHAPISTERIA' },
      { block: 1, op: '', nid: '', name: '', unit: 'P7230', rate: null, agreement: 'ADENDA' }, { block: 1, op: '', nid: '', name: '', unit: 'P7240', rate: null, agreement: 'Tapicería  ' }]);
    const r = await apply(imp);
    expect(r).toMatchObject({ drivers_created: 2, units_created: 10, units_without_driver: 8, agreements_set: 8, rows_rejected: 0 });
    expect(Number((await db.su.query(`select count(*) n from public.drivers`)).rows[0].n)).toBe(drivers0 + 2);
    const got = Object.fromEntries((await db.su.query(`select code, agreement from public.units where code like 'P%0' or code in ('P811','P812')`)).rows.map((x) => [x.code, x.agreement]));
    expect(got).toMatchObject({ P3410: 'CHAPA', P3420: 'RESCATE', P3430: null, P4810: 'P450', P7210: 'POR CHOFER', P7220: 'CHAPISTERIA', P7230: 'ADENDA', P7240: 'Tapicería', P811: null, P812: 'CUSTODIA' });
    const h = (await db.su.query(`select source, changed_by from public.unit_agreement_history h join public.units u on u.id=h.unit_id where u.code='P3410'`)).rows;
    expect(h).toEqual([{ source: 'import', changed_by: db.admin }]);
    expect((await db.su.query(`select count(*)::int n from public.charges c join public.assignments a on a.id=c.assignment_id join public.units u on u.id=a.unit_id where u.code in ('P811','P812')`)).rows[0].n).toBe(0);   // importar no crea cargos
  });
  it('un acuerdo ya registrado NO se pisa al reimportar (se informa); coincide sin distinguir mayúsculas', async () => {
    const u = (await db.su.query(`select id from public.units where code='P3420'`)).rows[0].id;
    await setAg(u, 'Escrito a mano');
    const r1 = await apply(await stage([{ block: 1, op: '', nid: '', name: '', unit: 'P3420', rate: null, agreement: 'RESCATE' }]));
    expect(r1.agreements_skipped).toBe(1); expect(r1.issues.map((i: { issue: string }) => i.issue)).toContain('agreement_differs');
    expect((await db.su.query(`select agreement a from public.units where id=$1`, [u])).rows[0].a).toBe('Escrito a mano');
    const r2 = await apply(await stage([{ block: 1, op: '', nid: '', name: '', unit: 'P3420', rate: null, agreement: 'ESCRITO A MANO' }]));
    expect(r2.agreements_skipped).toBe(0);
  });
  it('valores distintos de una misma unidad entre bloques: se omite, o se toma el bloque más reciente si se elige', async () => {
    const mk = () => stage([{ block: 1, op: '', nid: '', name: '', unit: 'P500', rate: null, agreement: 'CUSTODIA' }, { block: 2, op: '', nid: '', name: '', unit: 'P500', rate: null, agreement: 'rescate' }]);
    expect((await apply(await mk(), 'skip')).agreements_skipped).toBe(1);
    expect((await db.su.query(`select agreement a from public.units where code='P500'`)).rows[0].a).toBeNull();
    expect((await apply(await mk(), 'latest_block')).agreements_set).toBe(1);
    expect((await db.su.query(`select agreement a from public.units where code='P500'`)).rows[0].a).toBe('rescate');               // texto original del bloque más reciente
  });
  it('un texto demasiado largo no aborta la importación: se informa y se omite', async () => {
    const r = await apply(await stage([{ block: 1, op: '', nid: '', name: '', unit: 'P600', rate: null, agreement: 'x'.repeat(250) }, { block: 1, op: '', nid: '', name: '', unit: 'P601', rate: null, agreement: 'RESCATE' }]));
    expect(r.agreements_set).toBe(1); expect(r.agreements_skipped).toBe(1);
    expect(r.issues.map((i: { issue: string }) => i.issue)).toContain('agreement_invalid');
    expect((await db.su.query(`select count(*)::int n from public.units where code in ('P600','P601')`)).rows[0].n).toBe(2);
  });
  it('la importación no toca pagos existentes de una unidad cuyo acuerdo cambia', async () => {
    const x = await db.driverWithAssignment({ code: 'IM1', unit: 'P510', dailyCents: 3600 });
    await chargeWeek(db, MON);
    await adm((q) => pay(q, x.assignment, 'cash', 5000, { paidAt: `${MON}T10:00:00-05:00` }));
    const before = await adm((q) => position(q, x.assignment));
    await apply(await stage([{ block: 1, op: 'IM1', nid: 'ID-IM1', name: 'X', unit: 'P510', rate: 9999, agreement: 'CHAPA' }]));
    expect((await db.su.query(`select agreement a from public.units where code='P510'`)).rows[0].a).toBe('CHAPA');
    expect(await adm((q) => position(q, x.assignment))).toEqual(before);
  });
});

describe('quien tiene un rol interno puede leer nombre y correo de los demás (historial)', () => {
  it('lo ve un SUPERVISOR; un usuario sin rol no', async () => {
    expect((await db.as(db.supervisor, (q) => q.rows(`select email from public.profiles order by email`))).map((r) => r.email)).toEqual(['admin@test.local', 'ops-admin@test.local', 'supervisor@test.local']);
    expect((await db.as(db.outsider, (q) => q.rows(`select 1 from public.profiles`))).length).toBe(0);
  });
});

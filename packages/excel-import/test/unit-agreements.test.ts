import { existsSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newDb, type Db } from '@vip/db/testing';
import { buildDirectoryTemplate, confirmImport, previewImport, stageImport } from '../src/index.js';
import { buildDirectoryFile, buildMultiBlock, fillTemplate } from './fixture.js';

const W = (r: { warnings: string[] }, w: string) => r.warnings.some((x) => x === w || x.startsWith(`${w}:`));
const HDR = ['Unidad', 'Código de operario', 'Nombre', 'Apellido', 'Cédula', 'WhatsApp', 'Tarifa diaria', 'Estado', 'Acuerdo / condición especial', 'Observación'];
const unitRow = (u: string, agr: string | null, note: string | null = null) => [u, null, null, null, null, null, null, null, agr, note];

describe('cobranza: unidades sin conductor y acuerdo de texto libre (sin BD)', () => {
  it('guarda el texto ORIGINAL (solo recortado), sin mapear a categorías; unidad sin operario no se ignora', async () => {
    const f = await buildMultiBlock([[['P1', 'OPA', 'ID-A', 'A', 30, '  CHAPA '], ['P2', null, null, null, 0, 'Tapicería'], ['P3', null, null, null, 0, null], ['P4', 'OPB', 'ID-B', 'B', 32, 'CHAPISTERIA'],
      ['P5', null, null, null, 0, 'ñandú áéíóú'], ['P6', 'OPC', 'ID-C', 'C', 30, 'x'.repeat(201)]],
      [['P1', 'OPA', 'ID-A', 'A', 30, 'chapa'], ['P2', null, null, null, 0, 'RESCATE']]]);
    const p = await previewImport(f, 'c.xlsx');
    const rows = p.blocks[0]!.rows;
    expect(rows.map((r) => r.matchStatus)).toEqual(Array(6).fill('unmatched'));
    expect(rows[0]).toMatchObject({ unitAgreement: 'CHAPA' });
    expect(rows[1]).toMatchObject({ unitAgreement: 'Tapicería', rawAgreement: 'Tapicería', operatorCode: null });
    expect(rows[2]!.unitAgreement).toBeNull();
    expect(rows[3]!.unitAgreement).toBe('CHAPISTERIA'); expect(rows[4]!.unitAgreement).toBe('ñandú áéíóú');
    expect(W(rows[1]!, 'unit_without_driver')).toBe(true); expect(W(rows[1]!, 'missing_operator')).toBe(false);
    expect(W(rows[5]!, 'agreement_too_long')).toBe(true);
    expect(W(rows[0]!, 'agreement_ambiguous_across_blocks')).toBe(false);   // CHAPA = chapa (sin distinguir mayúsculas)
    expect(W(rows[1]!, 'agreement_ambiguous_across_blocks')).toBe(true);    // Tapicería vs RESCATE
    expect(p.summary.units).toMatchObject({ new: 6, withoutDriver: 3, withAgreement: 4 });   // P2 ambigua no cuenta; P3 sin acuerdo
    expect(p.summary.ambiguity!.agreementAmbiguous).toBe(1);
    expect(p.summary).not.toHaveProperty('conditions');
  });

  it('unidad existente sin conductor queda matched; acuerdo distinto del registrado se avisa', async () => {
    const f = await buildMultiBlock([[['P3', null, null, null, 0, null], ['P5', null, null, null, 0, 'ACUERDO']]]);
    const dir = { drivers: [], units: ['P3', 'p5'], assignments: [], unitAgreements: { P3: null, P5: 'rescate' } };
    const p = await previewImport(f, 'c.xlsx', { directory: dir });
    expect(p.blocks[0]!.rows.map((r) => r.matchStatus)).toEqual(['matched', 'matched']);
    expect(W(p.blocks[0]!.rows[1]!, 'agreement_differs_from_existing')).toBe(true);
    expect(W(p.blocks[0]!.rows[0]!, 'agreement_differs_from_existing')).toBe(false);
  });
});

describe('plantilla: acuerdo de texto libre (sin BD)', () => {
  it('fila solo de unidad; texto libre sin validar; vacío = sin cambio; «-» quita; observación independiente', async () => {
    const f = await buildDirectoryFile([
      unitRow('U1', 'Custodia hasta el viernes', 'revisar'), unitRow('U2', 'cualquier cosa 123'), unitRow('U3', '-'), unitRow('U4', null, 'solo nota'),
      unitRow('U5', 'x'.repeat(201)), [null, 'OPZ', 'Zeta', null, 'ID-Z', null, 30, null, null, null], ['U6', 'OPY', 'Ye', null, 'ID-Y', null, 30, null, null, null]], HDR);
    const dir = { drivers: [], units: ['U3', 'U4'], assignments: [], unitAgreements: { U3: 'CHAPA', U4: 'RESCATE' } };
    const p = await previewImport(f, 'x.xlsx', { directory: dir });
    const r = p.blocks[0]!.rows;
    expect(r[0]).toMatchObject({ matchStatus: 'unmatched', unitAgreement: 'Custodia hasta el viernes', unitAgreementNote: 'revisar' });
    expect(W(r[0]!, 'unit_without_driver')).toBe(true); expect(r[0]!.changes!.driver).toBeUndefined();
    expect(r[0]!.changes!.agreement).toEqual({ action: 'set', from: null, to: 'Custodia hasta el viernes' });
    expect(r[1]!.unitAgreement).toBe('cualquier cosa 123');
    expect(r[2]).toMatchObject({ unitAgreement: '-', matchStatus: 'matched' }); expect(r[2]!.changes!.agreement).toEqual({ action: 'clear', from: 'CHAPA', to: null });
    expect(r[3]).toMatchObject({ unitAgreement: null, unitAgreementNote: 'solo nota' }); expect(r[3]!.changes!.agreement).toEqual({ action: 'none' });
    expect(W(r[4]!, 'agreement_too_long')).toBe(true);
    expect(W(r[5]!, 'missing_unit')).toBe(true);
    expect(p.summary).toMatchObject({ errors: 2, units: { withoutDriver: 5, withAgreement: 3 }, drivers: { new: 2 } });
  });
  it('cambio de acuerdo existente se marca change; sin cambio = same', async () => {
    const f = await buildDirectoryFile([unitRow('U1', 'Chapa'), unitRow('U2', 'RESCATE')], HDR);
    const p = await previewImport(f, 'x.xlsx', { directory: { drivers: [], units: ['U1', 'U2'], assignments: [], unitAgreements: { U1: 'CHAPA', U2: 'RESCATE' } } });
    expect(p.blocks[0]!.rows.map((r) => r.changes!.agreement!.action)).toEqual(['change', 'same']);
  });
  it('acepta los encabezados antiguos «Condición especial» / «Comentario de la condición»; la plantilla generada hace ida y vuelta sin lista desplegable', async () => {
    const old = await buildDirectoryFile([unitRow('U1', 'CHAPA', 'n')], HDR.map((h, i) => (i === 8 ? 'Condición especial' : i === 9 ? 'Comentario de la condición' : h)));
    expect((await previewImport(old, 'x.xlsx')).blocks[0]!.rows[0]).toMatchObject({ unitAgreement: 'CHAPA', unitAgreementNote: 'n' });
    const tpl = await buildDirectoryTemplate();
    const f = await fillTemplate(tpl, [unitRow('U1', 'Cualquier texto libre')]);
    expect((await previewImport(f, 'x.xlsx')).blocks[0]!.rows[0]).toMatchObject({ unitCode: 'U1', unitAgreement: 'Cualquier texto libre', operatorCode: null });
    const ExcelJS = (await import('exceljs')).default; const wb = new ExcelJS.Workbook(); await wb.xlsx.load(tpl as any);
    expect(wb.getWorksheet('Plantilla')!.getCell('I2').dataValidation ?? null).toBeNull();
  });
});

// ───────────── contra PostgreSQL real ─────────────
let db: Db;
const count = async (t: string) => Number((await db.su.query(`select count(*) n from ${t.includes('.') ? t : 'public.' + t}`)).rows[0].n);
const money = async () => ({ charges: await count('charges'), payments: await count('payments'), allocations: await count('payment_allocations'), adjustments: await count('adjustments') });
const asOps = <T>(fn: (q: Parameters<Parameters<Db['as']>[1]>[0]) => Promise<T>) => db.as(db.opsAdmin, fn);
const agr = async (code: string) => (await db.su.query(`select agreement, agreement_note from public.units where code=$1`, [code])).rows[0];
const hist = async (code: string) => (await db.su.query(`select h.agreement, h.previous_agreement, h.source from public.unit_agreement_history h join public.units u on u.id=h.unit_id where u.code=$1 order by h.id`, [code])).rows;

describe('acuerdos de unidad contra PostgreSQL real', () => {
  beforeAll(async () => {
    db = await newDb();
    await db.su.query(`insert into public.units(code) values ('P3'), ('P5')`);
    await db.su.query(`update public.units set agreement='RESCATE' where code='P5'`);
  });
  afterAll(async () => { await db.close(); });

  it('cobranza: preview → confirm → apply_import respeta los textos al carácter, crea unidades sin conductor y no pisa un acuerdo existente', async () => {
    const f = await buildMultiBlock([[
      ['P1', 'OPA', 'ID-A', 'A A', 30, 'CHAPA'], ['P2', null, null, null, 0, 'RESCATE'], ['P3', null, null, null, 0, null],
      ['P4', 'OPB', 'ID-B', 'B B', 32, 'CHAPISTERIA'], ['P5', null, null, null, 0, 'ADENDA'], ['P6', null, null, null, 0, 'POR CHOFER'],
      ['P7', null, null, null, 0, 'P450'], ['P8', null, null, null, 0, ' Tapicería'], ['P9', null, null, null, 0, 'ñandú áéíóú']]]);
    const before = await money(); const authBefore = await count('auth.users');
    const r = await asOps((q) => stageImport(q, { userId: db.opsAdmin }, f, 'c.xlsx'));
    expect(r.summary).toMatchObject({ kind: 'cobranza', drivers: { new: 2 }, units: { new: 7, existing: 2, withoutDriver: 7, withAgreement: 8 }, ambiguity: { agreementAmbiguous: 0 } });
    const rows = (await db.su.query(`select unit_code, match_status, unit_agreement, raw_agreement, warnings from public.import_rows order by source_row`)).rows;
    expect(rows.map((x) => x.match_status)).toEqual(['unmatched', 'unmatched', 'matched', 'unmatched', 'matched', 'unmatched', 'unmatched', 'unmatched', 'unmatched']);
    expect(rows.map((x) => x.unit_agreement)).toEqual(['CHAPA', 'RESCATE', null, 'CHAPISTERIA', 'ADENDA', 'POR CHOFER', 'P450', 'Tapicería', 'ñandú áéíóú']);
    expect(rows[4]!.warnings).toContain('agreement_differs_from_existing');
    expect(await count('units')).toBe(2);                                       // la vista previa no crea nada
    await asOps((q) => confirmImport(q, { userId: db.opsAdmin }, r.importId, { approve: 'clean' }));
    const res = await asOps(async (q) => (await q.one(`select public.apply_import($1, null, 'active', 'skip') r`, [r.importId])).r);
    expect(res).toMatchObject({ drivers_created: 2, units_created: 7, assignments_created: 2, agreements_set: 7, agreements_skipped: 1 });
    expect(res.issues.map((i: { issue: string }) => i.issue)).toContain('agreement_differs');
    expect(await count('drivers')).toBe(2);                                     // ningún conductor inventado
    for (const [u, t] of [['P1', 'CHAPA'], ['P2', 'RESCATE'], ['P4', 'CHAPISTERIA'], ['P6', 'POR CHOFER'], ['P7', 'P450'], ['P8', 'Tapicería'], ['P9', 'ñandú áéíóú']] as const)
      expect((await agr(u)).agreement, u).toBe(t);
    expect((await agr('P3')).agreement).toBeNull();
    expect((await agr('P5')).agreement).toBe('RESCATE');                        // no se pisa
    expect((await db.su.query(`select count(*)::int n from public.assignments a join public.units u on u.id=a.unit_id where u.code in ('P2','P3','P5','P6','P7','P8','P9')`)).rows[0].n).toBe(0);
    expect(await hist('P1')).toEqual([{ agreement: 'CHAPA', previous_agreement: null, source: 'import' }]);
    expect(await money()).toEqual(before); expect(await count('auth.users')).toBe(authBefore);
    expect(await count('rates')).toBe(2);                                       // solo las tarifas de los 2 conductores nuevos
  });

  it('plantilla: sí cambia un acuerdo existente (con historial), «-» lo quita, la observación es independiente y >200 caracteres no se aprueba', async () => {
    const f = await buildDirectoryFile([
      unitRow('P1', 'Chapa'), unitRow('P2', '-'), unitRow('T1', 'TAPICERÍA'), unitRow('T2', 'ñandú áéíóú', 'con observación'),
      unitRow('P4', null, 'solo nota'), unitRow('T3', 'x'.repeat(201))], HDR);
    const m0 = await money(); const d0 = await count('drivers'); const a0 = await count('auth.users'); const rates0 = await count('rates');
    const r = await asOps((q) => stageImport(q, { userId: db.opsAdmin }, f, 't.xlsx'));
    expect(r.summary).toMatchObject({ kind: 'directory', errors: 1, drivers: { new: 0, existing: 0 }, units: { new: 3, existing: 3 } });
    expect((await db.su.query(`select warnings from public.import_rows where unit_code='T3'`)).rows[0].warnings).toContain('agreement_too_long');
    expect((await db.su.query(`select r.changes->'agreement' a from public.import_rows r join public.import_blocks b on b.id=r.block_id where b.import_id=$1 and r.unit_code='P1'`, [r.importId])).rows[0].a).toEqual({ action: 'change', from: 'CHAPA', to: 'Chapa' });
    const c = await asOps((q) => confirmImport(q, { userId: db.opsAdmin }, r.importId, { approve: 'clean' }));
    expect(c.approvedRows).toBe(5);                                             // T3 no se aprueba con 'clean'
    const res = await asOps(async (q) => (await q.one(`select public.apply_directory_import($1, null, 'active', false) r`, [r.importId])).r);
    expect(res).toMatchObject({ units_created: 2, agreements_set: 5, rows_excluded: 1 });
    expect(await count('drivers')).toBe(d0);
    expect((await agr('P1')).agreement).toBe('Chapa');
    expect((await agr('P2')).agreement).toBeNull();
    expect(await agr('T1')).toEqual({ agreement: 'TAPICERÍA', agreement_note: null });
    expect(await agr('T2')).toEqual({ agreement: 'ñandú áéíóú', agreement_note: 'con observación' });
    expect(await agr('P4')).toEqual({ agreement: 'CHAPISTERIA', agreement_note: 'solo nota' });   // vacío = sin cambio
    expect((await db.su.query(`select count(*)::int n from public.units where code='T3'`)).rows[0].n).toBe(0);
    expect((await hist('P1')).at(-1)).toEqual({ agreement: 'Chapa', previous_agreement: 'CHAPA', source: 'import' });
    expect((await hist('P2')).at(-1)).toEqual({ agreement: null, previous_agreement: 'RESCATE', source: 'import' });
    expect(await money()).toEqual(m0); expect(await count('auth.users')).toBe(a0); expect(await count('rates')).toBe(rates0);
  });

  it('supervisor y usuarios sin rol no pueden importar', async () => {
    const f = await buildDirectoryFile([unitRow('Z1', 'CHAPA')], HDR);
    for (const uid of [db.supervisor, db.outsider]) await expect(db.as(uid, (q) => stageImport(q, { userId: uid }, f, 'z.xlsx'))).rejects.toThrow(/row-level security|permission denied/i);
  });
});

// Prueba de humo OPCIONAL con vip.xlsx real (copia local fuera del repo). No imprime nombres ni cédulas.
const VIP = '/private/tmp/claude-502/-Users-hector-Documents-IDEAS-vip/e664b1f9-3ee7-4326-915a-70d5b133924b/scratchpad/data/vip.xlsx';
describe.skipIf(!existsSync(VIP))('humo con vip.xlsx real (opcional)', () => {
  it('1 bloque, 115 filas, 23 unidades sin operario y valores de ACUERDO conservados tal cual', async () => {
    const p = await previewImport(readFileSync(VIP), 'vip.xlsx');
    expect(p.kind).toBe('cobranza'); expect(p.summary.blocks).toBe(1); expect(p.summary.rows).toBe(115);
    expect(p.summary.units.withoutDriver).toBe(23);
    expect(p.summary.matchCounts.ignored).toBe(0);
    const vals = p.blocks[0]!.rows.map((r) => r.unitAgreement).filter((v): v is string => !!v);
    const tally = (k: string) => vals.filter((v) => v === k).length;
    expect([tally('CHAPA'), tally('RESCATE'), tally('CUSTODIA')]).toEqual([4, 2, 2]);
    expect(vals.filter((v) => !['CHAPA', 'RESCATE', 'CUSTODIA'].includes(v)).sort()).toEqual(['ADENDA', 'CHAPISTERIA', 'P450', 'POR CHOFER']);
    expect(p.summary.units.withAgreement).toBe(12);
  });
});

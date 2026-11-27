import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newDb, type Db } from '@vip/db/testing';
import { buildDirectoryTemplate, classifyTemplateHeader, confirmImport, previewImport, stageImport, TEMPLATE_HEADERS, type Directory } from '../src/index.js';
import { buildDirectoryFile, fillTemplate } from './fixture.js';

const H = ['Unidad', 'Código de operador', 'Nombre', 'Apellido', 'Cédula', 'WhatsApp', 'Tarifa diaria', 'Estado', 'Consentimiento cobranza WhatsApp', 'Origen del consentimiento'];
const file = (rows: (string | number | null)[][]) => buildDirectoryFile(rows, H);
const rowsOf = async (rows: (string | number | null)[][], dir?: Directory) => (await previewImport(await file(rows), 'f.xlsx', { directory: dir })).blocks[0]!.rows;

describe('plantilla: columnas de consentimiento', () => {
  it('la plantilla de descarga incluye las dos columnas y la hoja de instrucciones las explica', async () => {
    expect(TEMPLATE_HEADERS).toContain('Consentimiento cobranza WhatsApp');
    expect(TEMPLATE_HEADERS).toContain('Origen del consentimiento');
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load((await buildDirectoryTemplate()) as any);
    const heads = wb.getWorksheet('Plantilla')!.getRow(1).values as (string | undefined)[];
    expect(heads).toContain('Consentimiento cobranza WhatsApp'); expect(heads).toContain('Origen del consentimiento');
    const text = wb.getWorksheet('Instrucciones')!.getSheetValues().flat().map(String).join(' ');
    expect(text).toMatch(/NO significa que autorizó/); expect(text).toMatch(/Origen del consentimiento/);
  });
  it('las cabeceras se reconocen con tolerancia (acentos, mayúsculas, formas cortas)', () => {
    for (const h of ['Consentimiento cobranza WhatsApp', 'CONSENTIMIENTO COBRANZA WHATSAPP', 'Consentimiento', 'Consentimiento WhatsApp']) expect(classifyTemplateHeader(h)).toBe('consent');
    for (const h of ['Origen del consentimiento', 'origen del consentimiento', 'Origen']) expect(classifyTemplateHeader(h)).toBe('consent_origin');
  });
});

describe('parseo del consentimiento', () => {
  it('SI / SÍ / si / Sí con origen y teléfono válido → grant; NO / no → withdraw; vacío → sin cambio', async () => {
    const rows = await rowsOf([
      ['U1', 'A1', 'Ana', null, 'I1', '60000001', null, null, 'SI', 'formulario firmado'],
      ['U2', 'A2', 'Ana', null, 'I2', '60000002', null, null, 'SÍ', 'formulario firmado'],
      ['U3', 'A3', 'Ana', null, 'I3', '60000003', null, null, 'si', ' declaración de la administradora 2026-11-10 '],
      ['U4', 'A4', 'Ana', null, 'I4', '60000004', null, null, 'Sí', 'x'],
      ['U5', 'A5', 'Ana', null, 'I5', '60000005', null, null, 'NO', null],
      ['U6', 'A6', 'Ana', null, 'I6', '60000006', null, null, 'no', 'retiró por chat'],
      ['U7', 'A7', 'Ana', null, 'I7', '60000007', null, null, null, 'origen sin valor'],
    ]);
    expect(rows.map((r) => r.consentRequest)).toEqual(['grant', 'grant', 'grant', 'grant', 'withdraw', 'withdraw', null]);
    expect(rows[2]!.consentOrigin).toBe('declaración de la administradora 2026-11-10');
    expect(rows.map((r) => r.changes!.consent?.action)).toEqual(['grant', 'grant', 'grant', 'grant', 'unchanged', 'unchanged', undefined]);
    expect(rows.every((r) => !r.warnings.some((w) => w.startsWith('consent_ignored')))).toBe(true);
  });
  it('«SI» sin origen → ignorado con advertencia; sin teléfono → ignorado; valor desconocido → ignorado; la fila NO se bloquea', async () => {
    const p = await previewImport(await file([
      ['U1', 'A1', 'Ana', null, 'I1', '60000001', 30, null, 'SI', null],
      ['U2', 'A2', 'Bea', null, 'I2', null, 30, null, 'SI', 'formulario'],
      ['U3', 'A3', 'Cris', null, 'I3', '60000003', 30, null, 'quizás', 'formulario'],
      ['U4', 'A4', 'Dani', null, 'I4', '123', 30, null, 'SI', 'formulario'],      // teléfono inválido
    ]), 'f.xlsx');
    const r = p.blocks[0]!.rows;
    expect(r.map((x) => x.consentRequest ?? null)).toEqual([null, null, null, null]);
    expect(r[0]!.warnings).toContain('consent_ignored:missing_origin');
    expect(r[1]!.warnings).toContain('consent_ignored:missing_phone');
    expect(r[2]!.warnings).toContain('consent_ignored:invalid_value');
    expect(r[3]!.warnings).toEqual(expect.arrayContaining(['invalid_phone', 'consent_ignored:missing_phone']));
    expect(r.map((x) => x.matchStatus)).toEqual(['unmatched', 'unmatched', 'unmatched', 'unmatched']);       // resto de la fila intacto
    expect(p.summary.errors).toBe(0);
    expect(p.summary.consents).toEqual({ toGrant: 0, toWithdraw: 0, unchanged: 0, ignored: { total: 4, missingOrigin: 1, missingPhone: 2, invalidValue: 1, noDriver: 0 } });
    expect(p.summary.warningsByType).toMatchObject({ consent_ignored: 4 });
  });
  it('un conductor existente con teléfono sirve aunque la celda esté vacía; «NO» sobre consentimiento vigente es un retiro destacado', async () => {
    const dir: Directory = {
      drivers: [
        { id: 'd1', operatorCode: 'A1', nationalId: 'I1', firstName: 'Ana', lastName: 'X', phoneE164: '+50760000001', status: 'active', whatsappConsent: false },
        { id: 'd2', operatorCode: 'A2', nationalId: 'I2', firstName: 'Bea', lastName: 'X', phoneE164: '+50760000002', status: 'active', whatsappConsent: true },
        { id: 'd3', operatorCode: 'A3', nationalId: 'I3', firstName: 'Cris', lastName: 'X', phoneE164: null, status: 'active', whatsappConsent: false },
        { id: 'd4', operatorCode: 'A4', nationalId: 'I4', firstName: 'Dani', lastName: 'X', phoneE164: '+50760000004', status: 'active', whatsappConsent: true },
      ], units: [], assignments: [] };
    const p = await previewImport(await file([
      [null, 'A1', null, null, 'I1', null, null, null, 'SI', 'formulario firmado'],   // grant (teléfono existente)
      [null, 'A2', null, null, 'I2', null, null, null, 'NO', null],                    // withdraw
      [null, 'A3', null, null, 'I3', null, null, null, 'SI', 'formulario firmado'],   // sin teléfono
      [null, 'A4', null, null, 'I4', null, null, null, 'SI', 'otro formulario'],      // ya consentía → sin cambio
    ]), 'f.xlsx', { directory: dir });
    const r = p.blocks[0]!.rows;
    expect(r.map((x) => x.changes!.consent!.action)).toEqual(['grant', 'withdraw', 'ignored', 'unchanged']);
    expect(r[1]!.warnings).toContain('consent_withdrawal');
    expect(p.summary.consents).toEqual({ toGrant: 1, toWithdraw: 1, unchanged: 1, ignored: { total: 1, missingOrigin: 0, missingPhone: 1, invalidValue: 0, noDriver: 0 } });
  });
  it('un teléfono sin columna de consentimiento NUNCA genera consentimiento', async () => {
    const p = await previewImport(await buildDirectoryFile([['U1', 'A1', 'Ana', null, 'I1', '60000001', 30, null]]), 'f.xlsx');
    expect(p.blocks[0]!.rows[0]).toMatchObject({ phoneE164: '+50760000001' });
    expect(p.blocks[0]!.rows[0]!.consentRequest ?? null).toBeNull();
    expect(p.blocks[0]!.rows[0]!.changes!.consent).toBeUndefined();
    expect(p.summary.consents).toEqual({ toGrant: 0, toWithdraw: 0, unchanged: 0, ignored: { total: 0, missingOrigin: 0, missingPhone: 0, invalidValue: 0, noDriver: 0 } });
  });
  it('fila solo de unidad con consentimiento: se ignora (sin conductor)', async () => {
    const r = await rowsOf([['U9', null, null, null, null, null, null, null, 'SI', 'formulario']]);
    expect(r[0]!.warnings).toEqual(expect.arrayContaining(['unit_without_driver', 'consent_ignored:no_driver']));
    expect(r[0]!.changes!.consent).toMatchObject({ action: 'ignored', reason: 'no_driver' });
  });
  it('la plantilla de descarga rellenada con las columnas nuevas se interpreta (ida y vuelta)', async () => {
    const f = await fillTemplate(await buildDirectoryTemplate(), [['U1', 'OP1', 'Ana', 'Pérez', '8-111-111', '66123456', 34.5, 'Activo', null, null, 'SI', 'formulario firmado']]);
    const r = (await previewImport(f, 'f.xlsx')).blocks[0]!.rows[0]!;
    expect(r).toMatchObject({ consentRequest: 'grant', consentOrigin: 'formulario firmado' });
  });
});

describe('stage + confirm + apply (PostgreSQL real)', () => {
  let db: Db;
  beforeAll(async () => {
    db = await newDb();
    await db.driverWithAssignment({ code: 'X1', unit: 'UX1', phone: '+50760000011' });
    await db.driverWithAssignment({ code: 'X2', unit: 'UX2', phone: '+50760000012', consent: true });
  });
  afterAll(async () => { await db.close(); });
  const apply = (imp: string, uid = db.opsAdmin) => db.as(uid, async (q) => (await q.one(`select public.apply_directory_import($1, '2026-03-02'::date, 'active', false) r`, [imp])).r);

  it('vista previa guarda consent_request/origin; aplicar registra con import_declaration, evidencia y quien aplica; retiro y no-teléfono', async () => {
    const f = await file([
      ['UX1', 'X1', null, null, 'ID-X1', null, null, null, 'SI', 'declaración de la administradora 2026-11-10'],
      ['UX2', 'X2', null, null, 'ID-X2', null, null, null, 'NO', 'retiró por chat'],
      ['UN1', 'N1', 'Nuevo', null, 'ID-N1', '61234567', 30, null, 'SI', 'formulario firmado'],
      ['UN2', 'N2', 'SinOrigen', null, 'ID-N2', '61234568', 30, null, 'SI', null],
      ['UN3', 'N3', 'SinTel', null, 'ID-N3', null, 30, null, 'SI', 'formulario firmado'],
      ['UN4', 'N4', 'SoloTel', null, 'ID-N4', '61234569', 30, null, null, null],
    ]);
    const st = await db.as(db.opsAdmin, (q) => stageImport(q, { userId: db.opsAdmin }, f, 'consent-2026.xlsx'));
    expect(st.summary.consents).toEqual({ toGrant: 2, toWithdraw: 1, unchanged: 0, ignored: { total: 2, missingOrigin: 1, missingPhone: 1, invalidValue: 0, noDriver: 0 } });
    expect((await db.su.query(`select consent_request, consent_origin from public.import_rows where operator_code='X1'`)).rows[0]).toEqual({ consent_request: 'grant', consent_origin: 'declaración de la administradora 2026-11-10' });
    const hist0 = (await db.su.query(`select count(*)::int n from public.driver_consents`)).rows[0].n;
    expect((await db.su.query(`select whatsapp_consent c from public.drivers where operator_code='X1'`)).rows[0].c).toBe(false);   // la vista previa no consiente
    await db.as(db.opsAdmin, (q) => confirmImport(q, { userId: db.opsAdmin }, st.importId, { approve: 'clean' }));
    const before = hist0;
    const res = await apply(st.importId);
    expect(res).toMatchObject({ consents_granted: 2, consents_withdrawn: 1, consents_ignored: 0 });
    const d = async (op: string) => (await db.su.query(`select whatsapp_consent c, whatsapp_consent_source s, promotional_consent p from public.drivers where operator_code=$1`, [op])).rows[0];
    expect(await d('X1')).toEqual({ c: true, s: 'import_declaration', p: false });
    expect(await d('X2')).toEqual({ c: false, s: null, p: false });
    expect(await d('N1')).toEqual({ c: true, s: 'import_declaration', p: false });
    for (const op of ['N2', 'N3', 'N4']) expect((await d(op)).c).toBe(false);          // sin origen / sin teléfono / solo teléfono: NO consiente
    const hist = (await db.su.query(`select dr.operator_code op, c.purpose, c.granted, c.source, c.evidence, c.recorded_by from public.driver_consents c join public.drivers dr on dr.id=c.driver_id where c.recorded_by is not null order by dr.operator_code`)).rows;
    expect(hist).toEqual([
      { op: 'N1', purpose: 'collection', granted: true, source: 'import_declaration', evidence: 'formulario firmado | archivo: consent-2026.xlsx', recorded_by: db.opsAdmin },
      { op: 'X1', purpose: 'collection', granted: true, source: 'import_declaration', evidence: 'declaración de la administradora 2026-11-10 | archivo: consent-2026.xlsx', recorded_by: db.opsAdmin },
      { op: 'X2', purpose: 'collection', granted: false, source: 'withdrawal', evidence: 'retiró por chat | archivo: consent-2026.xlsx', recorded_by: db.opsAdmin },
    ]);
    expect((await db.su.query(`select count(*)::int n from public.driver_consents`)).rows[0].n).toBe(before + 3);
    const n3 = (await db.su.query(`select consent_request, warnings from public.import_rows where operator_code='N3'`)).rows[0];
    expect(n3.consent_request).toBeNull(); expect(n3.warnings).toContain('consent_ignored:missing_phone');
    expect((await db.su.query(`select summary->'consents' c from public.excel_imports where id=$1`, [st.importId])).rows[0].c.ignored).toMatchObject({ total: 2, missingOrigin: 1, missingPhone: 1 });
  });
});

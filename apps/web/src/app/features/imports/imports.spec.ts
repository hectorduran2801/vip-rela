import { TestBed } from '@angular/core/testing';
import { ApiService, Breakpoints } from '../../core/services';
import { FakeBreakpoints, fakeApi, settle } from '../../testing/fakes';
import { Imports } from './imports';

const SYNC = { guard: null, rateChanges: [], weekStart: '2026-11-23', applied: false, alreadyUpToDate: false, units: { total: 3, unchanged: 0, changed: 0, new: 3, withoutDriver: 1, errors: 0 },
  payments: { new: 0, changed: 0, zeroed: 0, unchanged: 0, skippedEmpty: 21, rejected: 0, netDeltaCents: 0 }, saldo: { create: 1, unchanged: 0, adjust: 0, skipEmpty: 2, skippedInvalid: 0, skippedNoAssignment: 0, deltaCents: 5000 },
  drivers: { created: 2, updated: 0 }, assignmentsCreated: 2, blocked: 0, warnings: [] };

async function setup(api: object) {
  TestBed.configureTestingModule({ providers: [{ provide: ApiService, useValue: api }, { provide: Breakpoints, useValue: new FakeBreakpoints() }] });
  const f = TestBed.createComponent(Imports); await settle(f);
  const el = f.nativeElement as HTMLElement;
  const upload = async (fl: File) => { const i = el.querySelector('#xlsx') as HTMLInputElement; Object.defineProperty(i, 'files', { value: [fl], configurable: true }); i.dispatchEvent(new Event('change')); await settle(f); };
  return { f, el, upload };
}
const api = (o: Record<string, unknown> = {}) => fakeApi({ uploadImport: vi.fn(async () => ({ created: true, importId: 'i1', status: 'confirmed', kind: 'collection_flat', summary: { rows: 3, warningsByType: {} } })),
  syncPreview: vi.fn(async () => SYNC), importRows: vi.fn(async () => []), updateImportRow: vi.fn(async () => undefined), syncApply: vi.fn(async () => ({ ...SYNC, applied: true })), ...o });

describe('Importar Excel de cobranza', () => {
  it('rechaza archivos que no son .xlsx sin llamar a la API', async () => {
    const a = api(); const { el, upload } = await setup(a);
    await upload(new File([new Uint8Array(4)], 'datos.csv'));
    expect(a.uploadImport).not.toHaveBeenCalled(); expect(el.querySelector('[role=alert]')!.textContent).toContain('.xlsx');
  });
  it('sube, muestra la vista previa de la semana y guarda con un clic', async () => {
    const a = api(); const { f, el, upload } = await setup(a);
    await upload(new File([new Uint8Array(5)], 'DATOS.xlsx'));
    expect(a.syncPreview).toHaveBeenCalled();
    expect(el.textContent).toContain('Unidades en el archivo');
    (Array.from(el.querySelectorAll('button')).find((b) => b.textContent!.includes('Guardar datos')) as HTMLButtonElement).click(); await settle(f);
    expect(a.syncApply).toHaveBeenCalledTimes(1);
    expect(el.textContent).toContain('Datos guardados');
  });
  it('con errores no se puede guardar y se indica fila y columna', async () => {
    const bad = { ...SYNC, units: { ...SYNC.units, errors: 1 }, warnings: [{ row: 9, column: 'und', code: 'missing_unit', message: 'Falta la unidad', level: 'error' }] };
    const { el, upload } = await setup(api({ syncPreview: vi.fn(async () => bad) }));
    await upload(new File([new Uint8Array(5)], 'DATOS.xlsx'));
    expect(el.textContent).toContain('Fila 9');
    expect((Array.from(el.querySelectorAll('button')).find((b) => b.textContent!.includes('Guardar datos')) as HTMLButtonElement).disabled).toBe(true);
  });
  it('muestra la tabla con las filas con avisos en rojo/amarillo y permite corregir una celda', async () => {
    const row = (o: object) => ({ id: 'r1', sourceRow: 4, unitCode: 'P1', operatorCode: '0', fullName: 'Ana', nationalId: null, rawPhone: null, phoneE164: null, dailyRateCents: 0, rawSaldo: null, rawAgreement: null, dayAmountsCents: [null, null, null, null, null, null, null], warnings: [], ...o });
    const warns = [{ row: 4, column: 'cuenta', code: 'rate_zero', message: 'La cuota (CUENTA) es 0', level: 'info' }, { row: 5, column: 'und', code: 'missing_unit', message: 'Falta la unidad', level: 'error' }];
    const a = api({ syncPreview: vi.fn(async () => ({ ...SYNC, units: { ...SYNC.units, errors: 1 }, warnings: warns })), importRows: vi.fn(async () => [row({}), row({ id: 'r2', sourceRow: 5, unitCode: null }), row({ id: 'r3', sourceRow: 6, dailyRateCents: 3600 })]) });
    const { f, el, upload } = await setup(a);
    await upload(new File([new Uint8Array(5)], 'DATOS.xlsx'));
    expect(el.querySelectorAll('tr.cs-err').length).toBe(1);
    expect(el.querySelectorAll('tr.cs-warn').length).toBe(1);
    expect(el.querySelectorAll('td.cs-bad-err, td.cs-bad-warn').length).toBe(2);          // «cuenta» en la fila 4 y «und» en la fila 5
    expect(el.textContent).toContain('La cuota (CUENTA) es 0');
    const input = el.querySelector('tr.cs-warn input[aria-label="Cuota diaria"]') as HTMLInputElement;
    input.value = '36.00'; input.dispatchEvent(new Event('change')); await settle(f);
    expect(a.updateImportRow).toHaveBeenCalledWith('i1', 'r1', { dailyRateCents: 3600 });
  });
  it('importación antigua: el botón Guardar exige confirmar con motivo y se envía confirmHistorical', async () => {
    const guard = { historical: true, reasons: ['older_week'], latestWeek: '2026-11-30', lastRun: null, import: { fileName: 'DATOS.xlsx', sha256: 'abcdef1234567890', uploadedAt: '2026-11-24T12:00:00Z', uploadedBy: 'Ana' }, priorRuns: [] };
    const a = api({ syncPreview: vi.fn(async () => ({ ...SYNC, guard })) });
    const { f, el, upload } = await setup(a);
    await upload(new File([new Uint8Array(5)], 'DATOS.xlsx'));
    expect(el.textContent).toContain('esta importación es antigua');
    const save = () => Array.from(el.querySelectorAll('button')).find((b) => b.textContent!.includes('Guardar datos')) as HTMLButtonElement;
    expect(save().disabled).toBe(true);
    const box = el.querySelector('.cs-hist input[type=checkbox]') as HTMLInputElement; box.checked = true; box.dispatchEvent(new Event('change'));
    const note = el.querySelector('#cs-note') as HTMLInputElement; note.value = 'corrección histórica'; note.dispatchEvent(new Event('input')); await settle(f);
    expect(save().disabled).toBe(false);
    save().click(); await settle(f);
    expect(a.syncApply).toHaveBeenCalledWith('i1', expect.any(String), 'corrección histórica', true, expect.any(String));   // + fecha de corte
  });
});

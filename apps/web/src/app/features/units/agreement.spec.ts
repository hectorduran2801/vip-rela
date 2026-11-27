import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { ApiError } from '../../core/errors';
import type { Assignment, UnitAgreementChange } from '../../core/models';
import { ApiService, AuthService, Breakpoints, DataService } from '../../core/services';
import { FakeAuth, FakeBreakpoints, byText, driver, fakeApi, fakeData, settle, typeInto, unit } from '../../testing/fakes';
import { Assignments } from '../assignments/assignments';
import { UnitDetail } from './unit-detail';
import { UnitForm, normCode, validateUnit } from './unit-form';
import { UnitAgreement } from './unit-agreement';
import { Units } from './units';

const bp = (m = false) => { const b = new FakeBreakpoints(); b.isMobile.set(m); return b; };
const HIST: UnitAgreementChange[] = [{ id: '1', unitId: 'u1', agreement: 'CUSTODIA', note: 'En el taller', previousAgreement: 'CHAPA', previousNote: null, source: 'manual', changedBy: 'x', changedByName: 'Marta Díaz', changedAt: '2026-11-02T15:00:00Z' }];
const U1 = unit({ id: 'u1', code: 'T-1', agreement: 'CUSTODIA', agreementNote: 'En el taller' });
const saveOk = () => vi.fn(async (_id: string, a: string | null, n: string | null) => ({ unitId: 'u1', agreement: a, agreementNote: n, changed: true }));
const dataWith = (o: object = {}) => fakeData({ listUnits: vi.fn(async () => [U1, unit({ id: 'u2', code: 'T-2' }), unit({ id: 'u3', code: 'T-3', agreement: 'chapa y pintura' })]), listAgreementHistory: vi.fn(async () => HIST),
  listAssignments: vi.fn(async () => []), listDrivers: vi.fn(async () => [driver()]), listRateExceptions: vi.fn(async () => []), saveUnit: vi.fn(async (i: { id?: string }) => i.id ?? 'new-id'), setUnitAgreement: saveOk(), ...o });
const blur = (el: Element) => el.dispatchEvent(new Event('blur'));
const key = (el: Element, k: string, shift = false) => { const e = new KeyboardEvent('keydown', { key: k, shiftKey: shift, bubbles: true, cancelable: true }); el.dispatchEvent(e); return e; };

describe('Unidad: código obligatorio y sin duplicados (ignora mayúsculas y espacios)', () => {
  it('normCode: «P300» = «p300» = « p 300 »', () => { expect(normCode('P300')).toBe(normCode('p300')); expect(normCode(' p 300 ')).toBe('p300'); });
  it('el código es obligatorio', () => expect(validateUnit({ ...unit(), code: '  ' })['code']).toContain('obligatorio'));
  it('detecta duplicado entre unidades existentes (otra unidad)', () => {
    expect(validateUnit({ ...unit(), code: 'p300' }, [unit({ id: 'x', code: 'P300' })])['code']).toContain('Ya existe una unidad con ese código');
    expect(validateUnit({ ...unit({ id: 'x' }), code: 'p300' }, [unit({ id: 'x', code: 'P300' })])).toEqual({});
  });
});

describe('Acuerdo / condición especial: texto libre con guardado automático', () => {
  async function editor(d: ReturnType<typeof dataWith>, editable = true, u = U1) {
    TestBed.configureTestingModule({ providers: [{ provide: DataService, useValue: d }] });
    const f = TestBed.createComponent(UnitAgreement);
    f.componentRef.setInput('unit', u);
    f.componentRef.setInput('editable', editable);
    await settle(f);
    return { f, el: f.nativeElement as HTMLElement, d };
  }
  it('es texto libre: input con sugerencias NO restrictivas (datalist), sin select ni catálogo, sin botón Guardar', async () => {
    const { el } = await editor(dataWith());
    expect(el.querySelector('select')).toBeNull();
    expect((el.querySelector('#ag-text') as HTMLInputElement).value).toBe('CUSTODIA');
    expect((el.querySelector('#ag-note') as HTMLTextAreaElement).value).toBe('En el taller');
    expect(Array.from(el.querySelectorAll('#ag-suggest option')).map((o) => o.getAttribute('value'))).toContain('REVISADO PENDIENTE');
    expect(byText(el, 'button', 'Guardar')).toBeUndefined();
    expect(el.textContent).toContain('no modifica tarifas, cuotas, pagos, saldos ni asignaciones');
  });
  it('al perder el foco guarda con set_unit_agreement (cualquier texto) y muestra «Guardando…» y «✓ Guardado»', async () => {
    const d = dataWith();
    const { f, el } = await editor(d);
    typeInto(el, '#ag-text', 'REVISADO PENDIENTE'); await settle(f);
    blur(el.querySelector('#ag-text')!); await settle(f);
    expect(d.setUnitAgreement).toHaveBeenCalledWith('u1', 'REVISADO PENDIENTE', 'En el taller');
    expect(el.textContent).toContain('✓ Guardado');
  });
  it('muestra «Guardando…» mientras la solicitud está en curso', async () => {
    let release!: () => void;
    const d = dataWith({ setUnitAgreement: vi.fn((_i: string, a: string | null, n: string | null) => new Promise((r) => { release = () => r({ unitId: 'u1', agreement: a, agreementNote: n, changed: true }); })) });
    const { f, el } = await editor(d);
    typeInto(el, '#ag-text', 'X'); await settle(f);
    blur(el.querySelector('#ag-text')!); await settle(f);
    expect(el.textContent).toContain('Guardando…');
    release(); await settle(f);
    expect(el.textContent).toContain('✓ Guardado');
  });
  it('NO envía si el valor no cambió, ni al repetir el blur', async () => {
    const d = dataWith();
    const { f, el } = await editor(d);
    blur(el.querySelector('#ag-text')!); await settle(f);
    expect(d.setUnitAgreement).not.toHaveBeenCalled();
    typeInto(el, '#ag-text', 'CHAPA'); await settle(f);
    blur(el.querySelector('#ag-text')!); await settle(f); blur(el.querySelector('#ag-text')!); await settle(f); blur(el.querySelector('#ag-note')!); await settle(f);
    expect(d.setUnitAgreement).toHaveBeenCalledTimes(1);
    typeInto(el, '#ag-text', '  CHAPA '); await settle(f); blur(el.querySelector('#ag-text')!); await settle(f);
    expect(d.setUnitAgreement).toHaveBeenCalledTimes(1);
  });
  it('Enter en el acuerdo guarda; en la observación Enter guarda y Mayús+Enter no', async () => {
    const d = dataWith();
    const { f, el } = await editor(d);
    typeInto(el, '#ag-text', 'RESCATE'); await settle(f);
    key(el.querySelector('#ag-text')!, 'Enter'); await settle(f);
    expect(d.setUnitAgreement).toHaveBeenCalledTimes(1);
    typeInto(el, '#ag-note', 'línea 1'); await settle(f);
    const shift = key(el.querySelector('#ag-note')!, 'Enter', true); await settle(f);
    expect(shift.defaultPrevented).toBe(false);
    expect(d.setUnitAgreement).toHaveBeenCalledTimes(1);
    const plain = key(el.querySelector('#ag-note')!, 'Enter'); await settle(f);
    expect(plain.defaultPrevented).toBe(true);
    expect(d.setUnitAgreement).toHaveBeenCalledTimes(2);
    expect(d.setUnitAgreement).toHaveBeenLastCalledWith('u1', 'RESCATE', 'línea 1');
  });
  it('vaciar el acuerdo lo quita (null); espacios = null', async () => {
    const d = dataWith();
    const { f, el } = await editor(d);
    typeInto(el, '#ag-text', '   '); await settle(f); blur(el.querySelector('#ag-text')!); await settle(f);
    expect(d.setUnitAgreement).toHaveBeenCalledWith('u1', null, 'En el taller');
  });
  it('error: muestra «Error» con el mensaje real y «Reintentar»; conserva lo escrito y reintenta', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new ApiError('forbidden', 403)).mockResolvedValueOnce({ unitId: 'u1', agreement: 'NUEVO', agreementNote: 'En el taller', changed: true });
    const { f, el } = await editor(dataWith({ setUnitAgreement: fn }));
    typeInto(el, '#ag-text', 'NUEVO'); await settle(f); blur(el.querySelector('#ag-text')!); await settle(f);
    expect(el.querySelector('.save-state')!.textContent).toContain('Error');
    expect(el.querySelector('.save-state')!.textContent).toContain('No tienes permiso');
    expect((el.querySelector('#ag-text') as HTMLInputElement).value).toBe('NUEVO');
    byText(el, 'button', 'Reintentar').click(); await settle(f);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(el.textContent).toContain('✓ Guardado');
  });
  it('si el usuario sigue editando mientras guarda, se encola el último valor (una sola solicitud a la vez)', async () => {
    const releases: (() => void)[] = []; let active = 0, max = 0;
    const fn = vi.fn((_id: string, a: string | null, n: string | null) => new Promise((r) => { active++; max = Math.max(max, active); releases.push(() => { active--; r({ unitId: 'u1', agreement: a, agreementNote: n, changed: true }); }); }));
    const { f, el } = await editor(dataWith({ setUnitAgreement: fn }));
    typeInto(el, '#ag-text', 'UNO'); await settle(f); blur(el.querySelector('#ag-text')!); await settle(f);
    typeInto(el, '#ag-text', 'DOS'); await settle(f); blur(el.querySelector('#ag-text')!); await settle(f);
    releases[0]!(); await settle(f);
    releases[1]?.(); await settle(f);
    expect(fn.mock.calls.map((c) => c[1])).toEqual(['UNO', 'DOS']);
    expect(max).toBe(1);
    expect((el.querySelector('#ag-text') as HTMLInputElement).value).toBe('DOS');
  });
  it('no pierde ediciones al navegar: guarda lo pendiente al destruir el componente', async () => {
    const d = dataWith();
    const { f, el } = await editor(d);
    typeInto(el, '#ag-text', 'PENDIENTE'); await settle(f);
    f.destroy(); await new Promise((r) => setTimeout(r, 5));
    expect(d.setUnitAgreement).toHaveBeenCalledWith('u1', 'PENDIENTE', 'En el taller');
  });
  it('SUPERVISOR: solo lectura, no guarda y se explica', async () => {
    const d = dataWith();
    const { f, el } = await editor(d, false);
    expect((el.querySelector('#ag-text') as HTMLInputElement).readOnly).toBe(true);
    typeInto(el, '#ag-text', 'X'); blur(el.querySelector('#ag-text')!); await settle(f);
    expect(d.setUnitAgreement).not.toHaveBeenCalled();
    expect(el.textContent).toContain('Solo ADMIN y SUPER_ADMIN pueden editar el acuerdo');
  });
});

describe('Formulario de unidad: acuerdo', () => {
  async function form(d: ReturnType<typeof dataWith>, u?: ReturnType<typeof unit>) {
    TestBed.configureTestingModule({ providers: [{ provide: DataService, useValue: d }] });
    const f = TestBed.createComponent(UnitForm);
    if (u) f.componentRef.setInput('unit', u);
    await settle(f);
    return { f, el: f.nativeElement as HTMLElement };
  }
  it('al CREAR: se envía tras crear la unidad con el mismo RPC (id devuelto) y sin catálogo', async () => {
    const d = dataWith();
    const { f, el } = await form(d);
    expect(el.querySelector('select#uf-cond')).toBeNull();
    typeInto(el, '#uf-code', 'P300'); typeInto(el, '#ag-text', 'TAPICERÍA'); typeInto(el, '#ag-note', 'asientos'); await settle(f);
    (el.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit')); await settle(f);
    expect(d.saveUnit).toHaveBeenCalledWith(expect.objectContaining({ code: 'P300' }));
    expect(JSON.stringify((d.saveUnit as ReturnType<typeof vi.fn>).mock.calls[0])).not.toContain('agreement');
    expect(d.setUnitAgreement).toHaveBeenCalledWith('new-id', 'TAPICERÍA', 'asientos');
  });
  it('al crear sin acuerdo no llama al RPC', async () => {
    const d = dataWith();
    const { f, el } = await form(d);
    typeInto(el, '#uf-code', 'P301'); await settle(f);
    (el.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit')); await settle(f);
    expect(d.setUnitAgreement).not.toHaveBeenCalled();
  });
  it('al EDITAR: usa el editor con guardado automático (el botón Guardar no toca el acuerdo)', async () => {
    const d = dataWith();
    const { f, el } = await form(d, U1);
    expect(el.querySelector('app-unit-agreement')).not.toBeNull();
    (el.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit')); await settle(f);
    expect(d.setUnitAgreement).not.toHaveBeenCalled();
  });
  it('código duplicado (sin importar mayúsculas/espacios): error y no guarda', async () => {
    const d = dataWith({ listUnits: vi.fn(async () => [unit({ id: 'u9', code: 'P300' })]) });
    const { f, el } = await form(d);
    typeInto(el, '#uf-code', ' p300 '); await settle(f);
    (el.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit')); await settle(f);
    expect(d.saveUnit).not.toHaveBeenCalled();
    expect(el.textContent).toContain('Ya existe una unidad con ese código');
  });
  it('error de duplicado de la base se mapea al mensaje de unidad', async () => {
    const d = dataWith({ saveUnit: vi.fn(async () => { throw { code: '23505', message: 'duplicate key value violates unique constraint "units_code_key"' }; }) });
    const { f, el } = await form(d);
    typeInto(el, '#uf-code', 'Z9'); await settle(f);
    (el.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit')); await settle(f);
    expect(el.querySelector('[role=alert]')!.textContent).toContain('«P300» = «p300»');
  });
});

describe('Lista de unidades: columna, búsqueda y filtro del acuerdo', () => {
  async function list(mobile = false) {
    TestBed.configureTestingModule({ providers: [provideRouter([]), { provide: AuthService, useValue: new FakeAuth().login('admin') }, { provide: DataService, useValue: dataWith() }, { provide: Breakpoints, useValue: bp(mobile) }] });
    const f = TestBed.createComponent(Units);
    await settle(f);
    return { f, el: f.nativeElement as HTMLElement };
  }
  const codes = (el: HTMLElement) => Array.from(el.querySelectorAll('tbody tr')).map((r) => r.querySelector('td a')!.textContent!.trim());
  it('columna «Acuerdo / condición especial» con el texto tal cual y tooltip', async () => {
    const { el } = await list();
    expect(Array.from(el.querySelectorAll('thead th')).map((h) => h.textContent!.trim())).toContain('Acuerdo / condición especial');
    const cells = Array.from(el.querySelectorAll('tbody .ag-text'));
    expect(cells.map((c) => c.textContent!.trim())).toEqual(['CUSTODIA', 'chapa y pintura']);
    expect(cells[1]!.getAttribute('title')).toBe('chapa y pintura');
  });
  it('la barra de búsqueda también busca en el acuerdo, sin distinguir mayúsculas', async () => {
    const { f, el } = await list();
    typeInto(el, '#q', 'CHAPA'); await settle(f);
    expect(codes(el)).toEqual(['T-3']);
    typeInto(el, '#q', 'custodia'); await settle(f);
    expect(codes(el)).toEqual(['T-1']);
  });
  it('filtro «contiene…» (insensible a mayúsculas) y opción «Sin acuerdo»', async () => {
    const { f, el } = await list();
    typeInto(el, '#cf', 'PINTURA'); await settle(f);
    expect(codes(el)).toEqual(['T-3']);
    typeInto(el, '#cf', ''); await settle(f);
    (el.querySelector('#cf-none') as HTMLInputElement).click(); await settle(f);
    expect(codes(el)).toEqual(['T-2']);
  });
  it('móvil: tarjetas con el acuerdo', async () => {
    const { el } = await list(true);
    expect(el.querySelector('ul.cards .ag-badge')!.textContent).toContain('CUSTODIA');
  });
});

describe('Ficha de unidad: acuerdo e historial', () => {
  async function det(role: 'admin' | 'supervisor' = 'admin', d = dataWith()) {
    TestBed.configureTestingModule({ providers: [provideRouter([]), { provide: AuthService, useValue: new FakeAuth().login(role) }, { provide: DataService, useValue: d }, { provide: ApiService, useValue: fakeApi() }, { provide: Breakpoints, useValue: bp() }] });
    const f = TestBed.createComponent(UnitDetail);
    f.componentRef.setInput('id', 'u1');
    await settle(f);
    return { f, el: f.nativeElement as HTMLElement, d };
  }
  it('muestra el acuerdo guardado y el historial «anterior → nuevo», quién y cuándo en 12 h', async () => {
    const { el } = await det();
    const t = el.querySelector('[aria-labelledby=ud-cond]')!.textContent!;
    for (const s of ['CHAPA → CUSTODIA', 'En el taller', 'manual', 'Marta Díaz', '02/11/2026 10:00 AM', 'no cambia tarifas, cuotas, pagos, saldos ni asignaciones']) expect(t, s).toContain(s);
    expect((el.querySelector('#ag-text') as HTMLInputElement).value).toBe('CUSTODIA');
  });
  it('tras guardar relee la unidad y el historial (lo mostrado sale de la base de datos)', async () => {
    const d = dataWith();
    const { f, el } = await det('admin', d);
    const before = (d.listAgreementHistory as ReturnType<typeof vi.fn>).mock.calls.length;
    typeInto(el, '#ag-text', 'RESCATE'); await settle(f); blur(el.querySelector('#ag-text')!); await settle(f);
    expect(d.setUnitAgreement).toHaveBeenCalledWith('u1', 'RESCATE', 'En el taller');
    expect((d.listAgreementHistory as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(before);
  });
  it('SUPERVISOR lo ve de solo lectura', async () => {
    const { el } = await det('supervisor');
    expect((el.querySelector('#ag-text') as HTMLInputElement).readOnly).toBe(true);
    expect(el.textContent).toContain('Solo ADMIN y SUPER_ADMIN pueden editar el acuerdo');
  });
});

describe('Asignaciones: acuerdo de la unidad', () => {
  const asg: Assignment = { id: 'a1', driverId: 'd1', unitId: 'u1', unitCode: 'T-1', operatorCode: '101', driverName: 'Ana Pérez', validFrom: '2026-01-01', validTo: null, agreementNote: null, dailyRateCents: 3600 };
  async function page(mobile = false) {
    TestBed.configureTestingModule({ providers: [provideRouter([]), { provide: AuthService, useValue: new FakeAuth().login('admin') }, { provide: DataService, useValue: dataWith({ listAssignments: vi.fn(async () => [asg, { ...asg, id: 'a0', validFrom: '2025-01-01', validTo: '2025-12-31' }]) }) }, { provide: ApiService, useValue: fakeApi() }, { provide: Breakpoints, useValue: bp(mobile) }] });
    const f = TestBed.createComponent(Assignments);
    await settle(f);
    return f.nativeElement as HTMLElement;
  }
  it('tabla: columnas pedidas y el acuerdo de la unidad como etiqueta discreta', async () => {
    const el = await page();
    expect(Array.from(el.querySelectorAll('thead th')).map((h) => h.textContent!.trim())).toEqual(['Código de operario', 'Nombre y apellido', 'Código de unidad', 'Estado de asignación', 'Fecha de inicio', 'Fecha de fin', 'Acciones']);
    const row = el.querySelector('tbody tr')!.textContent!;
    for (const s of ['101', 'Ana Pérez', 'T-1', 'CUSTODIA', 'Vigente', '01/01/2026']) expect(row, s).toContain(s);
  });
  it('móvil: tarjetas con estado y acuerdo', async () => {
    const m = await page(true);
    expect(m.querySelector('table')).toBeNull();
    expect(m.querySelector('ul.cards li')!.textContent).toContain('CUSTODIA');
  });
});

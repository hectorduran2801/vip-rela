import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { ApiError } from '../../core/errors';
import type { Assignment } from '../../core/models';
import { ApiService, Breakpoints, DataService } from '../../core/services';
import { FakeBreakpoints, byLabel, byText, driver, fakeApi, fakeData, settle, typeInto, unit } from '../../testing/fakes';
import { Assignments } from '../assignments/assignments';
import { UnitDetail } from './unit-detail';

const asg = (o: Partial<Assignment> = {}): Assignment => ({ id: 'a1', driverId: 'd1', unitId: 'u1', unitCode: 'T-1', operatorCode: '101', driverName: 'Ana Pérez', validFrom: '2026-01-01', validTo: null, agreementNote: 'Acuerdo verbal', dailyRateCents: 3600, ...o });
const bpWith = (m: boolean) => { const b = new FakeBreakpoints(); b.isMobile.set(m); return b; };

async function detail(api: object, data: object = {}, current: Assignment | null = asg()) {
  const d = fakeData({
    listUnits: vi.fn(async () => [unit({ plate: 'AB-123' })]),
    listAssignments: vi.fn(async () => [...(current ? [current] : []), asg({ id: 'a0', driverId: 'd0', driverName: 'Luis Gómez', operatorCode: '99', validFrom: '2025-01-01', validTo: '2025-12-31', dailyRateCents: 3000 })]),
    listDrivers: vi.fn(async () => [driver(), driver({ id: 'd2', operatorCode: '202', firstName: 'Eva', lastName: 'Ruiz' }), driver({ id: 'd3', operatorCode: '303', firstName: 'Inactivo', status: 'inactive' })]),
    listRateExceptions: vi.fn(async () => [{ id: 'x1', assignmentId: 'a1', onDate: '2026-11-20', amountCents: 2000, reason: 'Descuento acordado' }]),
    saveUnit: vi.fn(async () => undefined), saveRateException: vi.fn(async () => undefined), deleteRateException: vi.fn(async () => undefined), ...data });
  TestBed.configureTestingModule({ providers: [provideRouter([]), { provide: DataService, useValue: d }, { provide: ApiService, useValue: api }, { provide: Breakpoints, useValue: bpWith(false) }] });
  const f = TestBed.createComponent(UnitDetail);
  f.componentRef.setInput('id', 'u1');
  await settle(f);
  return { f, el: f.nativeElement as HTMLElement, d };
}
const submit = (el: HTMLElement, sel = 'form') => (el.querySelector(sel) as HTMLFormElement).dispatchEvent(new Event('submit'));
const submitLast = (el: HTMLElement) => { const fs = el.querySelectorAll('form'); (fs[fs.length - 1] as HTMLFormElement).dispatchEvent(new Event('submit')); };

describe('Ficha de unidad', () => {
  it('muestra conductor, tarifa diaria y semanal prevista (la calcula Cobranza por períodos, no 6 × diaria), acuerdo e historial', async () => {
    const { el } = await detail(fakeApi());
    const t = el.textContent!;
    for (const s of ['Ana Pérez', '$36.00', 'Tarifa semanal prevista', 'Se calcula por períodos de tarifa en Cobranza', 'Acuerdo: Acuerdo verbal', 'Luis Gómez', 'vigente']) expect(t).toContain(s);
  });
  it('suspender y desactivar cambian vehicle_status; reactivar lo devuelve a activa', async () => {
    const { f, el, d } = await detail(fakeApi());
    byLabel(el, '', 'Suspender unidad').click(); await settle(f);
    expect(d.saveUnit).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'u1', vehicleStatus: 'maintenance' }));
    byLabel(el, '', 'Desactivar unidad').click(); await settle(f);
    expect(d.saveUnit).toHaveBeenCalledTimes(1);                                       // pide confirmación
    byText(el, '[role=alertdialog] button', 'Desactivar unidad').click(); await settle(f);
    expect(d.saveUnit).toHaveBeenLastCalledWith(expect.objectContaining({ vehicleStatus: 'out_of_service' }));
  });
  it('unidad suspendida ofrece reactivar', async () => {
    const { f, el, d } = await detail(fakeApi(), { listUnits: vi.fn(async () => [unit({ vehicleStatus: 'maintenance' })]) });
    expect(el.textContent).toContain('En mantenimiento');
    byLabel(el, '', 'Reactivar unidad').click(); await settle(f);
    expect(d.saveUnit).toHaveBeenCalledWith(expect.objectContaining({ vehicleStatus: 'active' }));
  });
  it('cambiar conductor: reassign atómico con fecha de inicio, tarifa y acuerdo (sin conductores inactivos ni el actual)', async () => {
    const api = fakeApi({ reassignUnit: vi.fn(async () => undefined) });
    const { f, el } = await detail(api);
    byLabel(el, '', 'Cambiar conductor').click(); await settle(f);
    expect(Array.from(el.querySelectorAll('#ra-driver option')).map((o) => o.textContent!.trim())).toEqual(['Selecciona…', '202 · Eva Ruiz']);
    (el.querySelector('#ra-driver') as HTMLSelectElement).value = 'd2';
    (el.querySelector('#ra-driver') as HTMLSelectElement).dispatchEvent(new Event('change'));
    typeInto(el, '#ra-from', '2026-12-01'); typeInto(el, '#ra-rate', '40'); typeInto(el, '#ra-note', 'Nuevo trato');
    await settle(f);
    expect(el.textContent).toContain('$240.00');
    submit(el, 'app-reassign-form form'); await settle(f);
    expect(api.reassignUnit).toHaveBeenCalledWith({ unitId: 'u1', newDriverId: 'd2', validFrom: '2026-12-01', dailyCents: 4000, agreementNote: 'Nuevo trato' });
    expect(el.textContent).toContain('Asignación guardada');
  });
  it('la fecha de inicio debe ser posterior al inicio de la asignación actual', async () => {
    const api = fakeApi({ reassignUnit: vi.fn() });
    const { f, el } = await detail(api);
    byLabel(el, '', 'Cambiar conductor').click(); await settle(f);
    (el.querySelector('#ra-driver') as HTMLSelectElement).value = 'd2';
    (el.querySelector('#ra-driver') as HTMLSelectElement).dispatchEvent(new Event('change'));
    typeInto(el, '#ra-from', '2025-12-31');
    await settle(f);
    expect(el.textContent).toContain('posterior al inicio');
    submit(el, 'app-reassign-form form'); await settle(f);
    expect(api.reassignUnit).not.toHaveBeenCalled();
  });
  it('error de la API al reasignar se muestra en español', async () => {
    const { f, el } = await detail(fakeApi({ reassignUnit: vi.fn(async () => { throw new ApiError('driver_already_assigned', 409); }) }));
    byLabel(el, '', 'Cambiar conductor').click(); await settle(f);
    (el.querySelector('#ra-driver') as HTMLSelectElement).value = 'd2';
    (el.querySelector('#ra-driver') as HTMLSelectElement).dispatchEvent(new Event('change'));
    await settle(f);
    submit(el, 'app-reassign-form form'); await settle(f);
    expect(el.querySelector('app-reassign-form [role=alert]')!.textContent).toContain('ya tiene una unidad asignada');
  });
  it('sin conductor vigente ofrece asignar', async () => {
    const { el } = await detail(fakeApi(), {}, null);
    expect(el.textContent).toContain('Disponible'); expect(el.textContent).toContain('Sin asignar');
    expect(byText(el, 'button', 'Asignar conductor')).toBeDefined();
  });
  it('cambio de tarifa: avisa que NO altera cuotas ya generadas, llama a /assignments/:id/rate e informa cuántas se conservaron', async () => {
    const api = fakeApi({ changeRate: vi.fn(async () => ({ assignmentId: 'a1', rateId: 'r2', from: '2026-12-01', previousDailyCents: 3600, newDailyCents: 4250, existingChargesFromDateUnchanged: 3 })) });
    const { f, el } = await detail(api);
    byLabel(el, '', 'Cambiar tarifa').click(); await settle(f);
    expect(el.querySelector('app-rate-change')!.textContent).toContain('no cambia cuotas ya generadas');
    expect(el.querySelector('app-rate-change')!.textContent).toContain('Aplica desde esa fecha hacia adelante');
    typeInto(el, '#rc-amount', '42.50'); typeInto(el, '#rc-from', '2026-12-01');
    await settle(f);
    typeInto(el, '#rc-reason', 'Acuerdo nuevo'); await settle(f);
    submit(el, 'app-rate-change form'); await settle(f);
    expect(api.changeRate).not.toHaveBeenCalled();                                            // primero confirmar
    expect(el.querySelector('app-rate-change')!.textContent).toContain('de $36.00 a $42.50 por día desde el');
    submit(el, 'app-rate-change form'); await settle(f);
    expect(api.changeRate).toHaveBeenCalledTimes(1);
    expect(api.changeRate).toHaveBeenCalledWith('a1', 4250, '2026-12-01', 'Acuerdo nuevo');
    expect(el.textContent).toContain('3 cuotas ya generadas desde esa fecha no se modificaron');
  });
  it('desvincular conductor: muestra el modal de confirmación con el texto exacto y llama a end (hoy) solo al confirmar; la otra unidad no se toca', async () => {
    const api = fakeApi({ endAssignment: vi.fn(async () => undefined) });
    const { f, el } = await detail(api);
    byLabel(el, '', 'Desvincular conductor').click(); await settle(f);
    expect(el.textContent).toContain('¿Deseas desvincular a este conductor de la unidad? La unidad quedará disponible para asignar un nuevo conductor. Los registros anteriores se conservarán.');
    expect(api.endAssignment).not.toHaveBeenCalled();
    byText(el, '[role=alertdialog] button', 'Cancelar').click(); await settle(f);
    expect(api.endAssignment).not.toHaveBeenCalled();
    byLabel(el, '', 'Desvincular conductor').click(); await settle(f);
    byText(el, '[role=alertdialog] button', 'Desvincular conductor').click(); await settle(f);
    expect(api.endAssignment).toHaveBeenCalledTimes(1);
    expect(api.endAssignment).toHaveBeenCalledWith('a1', expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/));
  });
  it('excepciones/acuerdos: lista, agrega (upsert) y quita', async () => {
    const { f, el, d } = await detail(fakeApi());
    expect(el.textContent).toContain('Descuento acordado');
    typeInto(el, '#ex-date', '2026-11-25'); typeInto(el, '#ex-amt', '18'); typeInto(el, '#ex-reason', 'Feriado');
    await settle(f);
    byText(el, 'button', 'Agregar excepción').click(); await settle(f);
    expect(d.saveRateException).toHaveBeenCalledWith({ assignmentId: 'a1', onDate: '2026-11-25', amountCents: 1800, reason: 'Feriado' });
    byLabel(el, '', 'Quitar excepción').click(); await settle(f);
    expect(d.deleteRateException).not.toHaveBeenCalled();
    byText(el, 'button', 'Sí, quitar').click(); await settle(f);
    expect(d.deleteRateException).toHaveBeenCalledWith('x1');
  });
});

describe('Asignaciones (operaciones atómicas por la API)', () => {
  async function setup(api: object, mobile = false) {
    const d = fakeData({ listAssignments: vi.fn(async () => [asg()]), listDrivers: vi.fn(async () => [driver()]), listUnits: vi.fn(async () => [unit()]) });
    TestBed.configureTestingModule({ providers: [provideRouter([]), { provide: DataService, useValue: d }, { provide: ApiService, useValue: api }, { provide: Breakpoints, useValue: bpWith(mobile) }] });
    const f = TestBed.createComponent(Assignments);
    await settle(f);
    return { f, el: f.nativeElement as HTMLElement, d };
  }
  it('crear asignación + tarifa es UNA llamada a /assignments/start (no dos inserts)', async () => {
    const api = fakeApi({ startAssignment: vi.fn(async () => undefined) });
    const { f, el, d } = await setup(api);
    byText(el, 'button', 'Nueva asignación').click(); await settle(f);
    (el.querySelector('#a-driver') as HTMLSelectElement).value = 'd1'; (el.querySelector('#a-driver') as HTMLSelectElement).dispatchEvent(new Event('change'));
    (el.querySelector('#a-unit') as HTMLSelectElement).value = 'u1'; (el.querySelector('#a-unit') as HTMLSelectElement).dispatchEvent(new Event('change'));
    typeInto(el, '#a-from', '2026-11-16'); typeInto(el, '#a-rate', '36'); typeInto(el, '#a-note', 'Verbal');
    await settle(f);
    expect(el.textContent).toContain('$216.00');
    submitLast(el); await settle(f);
    expect(api.startAssignment).toHaveBeenCalledTimes(1);
    expect(api.startAssignment).toHaveBeenCalledWith({ driverId: 'd1', unitId: 'u1', validFrom: '2026-11-16', dailyCents: 3600, agreementNote: 'Verbal' });
    expect(Object.keys(d)).not.toContain('createAssignment');
  });
  it('cambiar tarifa y cerrar hoy pasan por la API', async () => {
    const api = fakeApi({ changeRate: vi.fn(async () => ({ assignmentId: 'a1', rateId: 'r2', from: '2026-12-01', previousDailyCents: 3600, newDailyCents: 4000, existingChargesFromDateUnchanged: 0 })), endAssignment: vi.fn(async () => undefined) });
    const { f, el } = await setup(api);
    byLabel(el, '', 'Cambiar tarifa').click(); await settle(f);
    typeInto(el, '#rc-amount', '40'); typeInto(el, '#rc-from', '2026-12-01'); await settle(f);
    submitLast(el); await settle(f); submitLast(el); await settle(f);                         // revisar y confirmar
    expect(api.changeRate).toHaveBeenCalledWith('a1', 4000, '2026-12-01', undefined);
    expect(el.textContent).toContain('No había cuotas generadas desde esa fecha');
    byLabel(el, '', 'Desvincular conductor').click(); await settle(f);
    byText(el, '[role=alertdialog] button', 'Desvincular conductor').click(); await settle(f);
    expect(api.endAssignment).toHaveBeenCalledWith('a1', expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/));
  });
  it('responsive: tabla en escritorio, tarjetas en móvil', async () => {
    expect((await setup(fakeApi(), false)).el.querySelector('table')).not.toBeNull();
    TestBed.resetTestingModule();
    const m = await setup(fakeApi(), true);
    expect(m.el.querySelector('table')).toBeNull();
    expect(m.el.querySelectorAll('ul.cards li').length).toBe(1);
  });
});

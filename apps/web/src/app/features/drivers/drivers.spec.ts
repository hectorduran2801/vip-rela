import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { ApiError } from '../../core/errors';
import { ApiService, Breakpoints, DataService } from '../../core/services';
import { FakeBreakpoints, byText, click, driver, fakeApi, fakeData, settle, typeInto } from '../../testing/fakes';
import { DriverForm, validateDriver } from './driver-form';
import { Drivers, filterDrivers } from './drivers';

const LIST = [driver(), driver({ id: 'd2', operatorCode: '202', nationalId: '4-1-1', firstName: 'Luis', lastName: 'Gómez', status: 'suspended' })];

async function setup(mobile: boolean, data = fakeData({ listDrivers: vi.fn(async () => LIST) })) {
  const bp = new FakeBreakpoints(); bp.isMobile.set(mobile);
  TestBed.configureTestingModule({ providers: [provideRouter([]), { provide: Breakpoints, useValue: bp }, { provide: DataService, useValue: data }] });
  const f = TestBed.createComponent(Drivers);
  await settle(f);
  return { f, el: f.nativeElement as HTMLElement, data };
}

describe('Conductores', () => {
  it('filterDrivers busca por nombre sin acentos, cédula, operador y filtra por estado', () => {
    expect(filterDrivers(LIST, 'gomez', 'all').map((d) => d.id)).toEqual(['d2']);
    expect(filterDrivers(LIST, '8-123', 'all').map((d) => d.id)).toEqual(['d1']);
    expect(filterDrivers(LIST, '101', 'all').length).toBe(1);
    expect(filterDrivers(LIST, '', 'suspended').map((d) => d.id)).toEqual(['d2']);
  });
  it('validateDriver exige campos y formato +507 de WhatsApp', () => {
    expect(Object.keys(validateDriver({ ...driver(), operatorCode: '', firstName: '' }))).toEqual(['operatorCode', 'firstName']);
    expect(validateDriver({ ...driver(), phoneE164: '60000000' })).toEqual({});   // 8 dígitos = Panamá (+507)
    expect(validateDriver({ ...driver(), phoneE164: '1234' })['phoneE164']).toContain('WhatsApp no válido');
    expect(validateDriver({ ...driver(), nationalId: '' })).toEqual({});          // cédula opcional
    expect(validateDriver({ ...driver(), phoneE164: '+50760000000' })).toEqual({});
  });
  it('escritorio: tabla y no tarjetas; móvil: tarjetas y no tabla', async () => {
    let r = await setup(false);
    expect(r.el.querySelector('table')).not.toBeNull();
    expect(r.el.querySelector('ul.cards')).toBeNull();
    TestBed.resetTestingModule();
    r = await setup(true);
    expect(r.el.querySelector('table')).toBeNull();
    expect(r.el.querySelectorAll('ul.cards li').length).toBe(2);
  });
  it('«Nuevo conductor» es un enlace a /drivers/new (página propia); el formulario no pide código de unidad', async () => {
    const { el } = await setup(false);
    expect(byText(el, 'a', 'Nuevo conductor').getAttribute('href')).toBe('/drivers/new');
    expect(el.querySelector('app-driver-form')).toBeNull();
  });
  it('muestra los conductores con recordatorios pausados', async () => {
    const { el } = await setup(false, fakeData({ listDrivers: vi.fn(async () => [driver({ remindersPaused: true })]) }));
    expect(el.textContent).toContain('Pausados');
  });
  it('lista vacía y error muestran estados reales', async () => {
    const empty = await setup(false, fakeData({ listDrivers: vi.fn(async () => []) }));
    expect(empty.el.textContent).toContain('Aún no hay conductores');
    TestBed.resetTestingModule();
    const err = await setup(false, fakeData({ listDrivers: vi.fn(async () => { throw new ApiError('forbidden', 403); }) }));
    expect(err.el.querySelector('[role=alert]')!.textContent).toContain('No tienes permiso');
  });
  it('búsqueda filtra la lista visible', async () => {
    const { f, el } = await setup(false);
    typeInto(el, '#q', 'luis');
    await settle(f);
    expect(el.querySelectorAll('tbody tr').length).toBe(1);
  });
});

describe('DriverForm', () => {
  async function form(data: ReturnType<typeof fakeData>) {
    TestBed.configureTestingModule({ providers: [{ provide: DataService, useValue: data }, { provide: ApiService, useValue: fakeApi() }] });
    const f = TestBed.createComponent(DriverForm);
    await settle(f);
    return { f, el: f.nativeElement as HTMLElement };
  }
  it('no guarda con datos inválidos y muestra errores', async () => {
    const data = fakeData();
    const { f, el } = await form(data);
    (el.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit'));
    await settle(f);
    expect(data.saveDriver).not.toHaveBeenCalled();
    expect(el.textContent).toContain('Indica el código de operador');
  });
  it('guarda y reporta errores de la base de datos en español', async () => {
    const data = fakeData({ saveDriver: vi.fn().mockRejectedValueOnce(new Error('duplicate key value 23505')) });
    const { f, el } = await form(data);
    typeInto(el, '#df-op', '9'); typeInto(el, '#df-id', '1-1-1'); typeInto(el, '#df-fn', 'Eva');
    await settle(f);
    (el.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit'));
    await settle(f);
    expect(data.saveDriver).toHaveBeenCalledWith(expect.objectContaining({ operatorCode: '9', nationalId: '1-1-1', firstName: 'Eva', status: 'active' }));
    expect(el.querySelector('[role=alert]')!.textContent).toContain('Ya existe un registro');
  });
});

describe('Conductor · «Guardando…» nunca se queda colgado', () => {
  const mk = async (saveDriver: () => Promise<string>, listDrivers: () => Promise<ReturnType<typeof driver>[]> = async () => []) => {
    TestBed.configureTestingModule({ providers: [{ provide: DataService, useValue: fakeData({ saveDriver: vi.fn(saveDriver), listDrivers: vi.fn(listDrivers) }) }] });
    const f = TestBed.createComponent(DriverForm); f.componentRef.setInput('driver', driver()); let n = 0; f.componentInstance.saved.subscribe(() => n++); await settle(f);
    const el = f.nativeElement as HTMLElement;
    const submit = () => { (el.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit')); f.detectChanges(); };
    return { f, el, submit, saved: () => n, btn: () => el.querySelector('button[type=submit]') as HTMLButtonElement };
  };
  it('si falla, el botón se recupera y se muestra el motivo', async () => {
    const t = await mk(async () => { throw new ApiError('forbidden', 403); });
    t.submit(); await settle(t.f);
    expect(t.btn().disabled).toBe(false); expect(t.btn().getAttribute('aria-busy')).toBeNull();
    expect(t.el.querySelector('[role=alert]')!.textContent).toContain('No tienes permiso');
  });
  const hang = async (t: Awaited<ReturnType<typeof mk>>) => {
    vi.useFakeTimers();
    try { t.submit(); expect(t.btn().disabled).toBe(true); await vi.advanceTimersByTimeAsync(20_000); await vi.advanceTimersByTimeAsync(20_000); t.f.detectChanges(); } finally { vi.useRealTimers(); }
    await settle(t.f);
  };
  const never = () => new Promise<string>(() => undefined);
  it('tiempo agotado y SÍ se guardó: se da por guardado, sin repetir', async () => {
    const t = await mk(never, async () => [driver()]);
    await hang(t);
    expect(t.saved()).toBe(1);
  });
  it('tiempo agotado y NO se guardó: lo dice y permite reintentar', async () => {
    const t = await mk(never, async () => [driver({ firstName: 'Otro nombre' })]);
    await hang(t);
    expect(t.saved()).toBe(0); expect(t.btn().disabled).toBe(false);
    expect(t.el.querySelector('[role=alert]')!.textContent).toContain('no aparece guardado');
  });
  it('si no se puede comprobar, no deja repetir hasta comprobarlo', async () => {
    let up = false;
    const t = await mk(never, async () => { if (!up) throw new ApiError('api_unreachable', 0); return [driver()]; });
    await hang(t);
    expect(t.btn().disabled).toBe(true);
    up = true; byText(t.el, 'button', 'Comprobar ahora').click(); await settle(t.f);
    expect(t.saved()).toBe(1);
  });
});

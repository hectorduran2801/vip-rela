import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { routes } from '../app.routes';
import type { Assignment, Movement } from '../core/models';
import { ApiService, Breakpoints, DataService } from '../core/services';
import { FakeBreakpoints, byText, driver, fakeApi, fakeData, settle, typeInto, unit } from '../testing/fakes';
import { DriverDetail } from './drivers/driver-detail';
import { MovementList } from './movements/movement-list';
import { Units } from './units/units';
import { validateUnit } from './units/unit-form';

const MOVS: Movement[] = [
  { occurredAt: '2026-11-16T15:00:00Z', kind: 'payment', refId: 'p1', amountCents: 3600, commissionCents: 100, detail: 'vigente' },
  { occurredAt: '2026-11-16T05:00:00Z', kind: 'charge', refId: 'c1', amountCents: 3600, commissionCents: null, detail: '2026-11-16' },
  { occurredAt: '2026-11-15T15:00:00Z', kind: 'payment', refId: 'p0', amountCents: 3600, commissionCents: 100, detail: 'anulado' },
];
const bpWith = (mobile: boolean) => { const b = new FakeBreakpoints(); b.isMobile.set(mobile); return b; };

describe('Historial de movimientos', () => {
  async function setup(api: object, mobile = false) {
    TestBed.configureTestingModule({ providers: [{ provide: ApiService, useValue: api }, { provide: Breakpoints, useValue: bpWith(mobile) }] });
    const f = TestBed.createComponent(MovementList);
    f.componentRef.setInput('movements', MOVS);
    await settle(f);
    return { f, el: f.nativeElement as HTMLElement };
  }
  it('la cuota muestra nombre del día y fecha válida', async () => {
    const { el } = await setup(fakeApi());
    expect(el.textContent).toContain('lunes 16/11');
    expect(el.textContent).not.toContain('0000-00-00');
  });
  it('es solo lectura: no hay botones para anular pagos', async () => {
    const { el } = await setup(fakeApi());
    expect(el.querySelectorAll('button').length).toBe(0);
    expect(el.textContent).not.toContain('Anular pago');
  });
  it('responsive: móvil tarjetas, escritorio tabla', async () => {
    expect((await setup(fakeApi(), true)).el.querySelector('table')).toBeNull();
    TestBed.resetTestingModule();
    expect((await setup(fakeApi(), false)).el.querySelector('table')).not.toBeNull();
  });
});

describe('Unidades', () => {
  it('validateUnit', () => {
    expect(validateUnit({ ...unit(), code: '' })['code']).toBeTruthy();
    expect(validateUnit({ ...unit(), year: 1900 })['year']).toBeTruthy();
    expect(validateUnit({ ...unit(), year: 2020 })).toEqual({});
  });
  async function setup(mobile: boolean) {
    const data = fakeData({ listUnits: vi.fn(async () => [unit({ plate: 'AB-123' }), unit({ id: 'u2', code: 'T-2' })]),
      listAssignments: vi.fn(async () => [{ id: 'a1', driverId: 'd1', unitId: 'u1', unitCode: 'T-1', operatorCode: '101', driverName: 'Ana Pérez', validFrom: '2026-01-01', validTo: null, agreementNote: null, dailyRateCents: 3600 } as Assignment]) });
    TestBed.configureTestingModule({ providers: [provideRouter([]), { provide: DataService, useValue: data }, { provide: Breakpoints, useValue: bpWith(mobile) }] });
    const f = TestBed.createComponent(Units);
    await settle(f);
    return f.nativeElement as HTMLElement;
  }
  it('muestra conductor asignado; tabla en escritorio y tarjetas en móvil', async () => {
    const d = await setup(false);
    expect(d.querySelector('table')).not.toBeNull();
    expect(d.textContent).toContain('Ana Pérez');
    TestBed.resetTestingModule();
    const m = await setup(true);
    expect(m.querySelector('table')).toBeNull();
    expect(m.querySelectorAll('ul.cards li').length).toBe(2);
  });
  it('muestra tarifa diaria y semanal (6 × diaria) de la unidad asignada', async () => {
    const d = await setup(false);
    expect(d.textContent).toContain('$36.00');
    expect(d.textContent).toContain('$216.00');
  });
  it('la administradora ve «Nueva unidad»', async () => {
    expect(byText(await setup(false), 'button', 'Nueva unidad')).toBeDefined();
  });
});

describe('Ficha del conductor', () => {
  it('muestra unidad y saldo desde la vista de posición', async () => {
    const asg = { id: 'a1', driverId: 'd1', unitId: 'u1', unitCode: 'T-1', operatorCode: '101', driverName: 'Ana Pérez', validFrom: '2026-01-01', validTo: null, agreementNote: null, dailyRateCents: 3600 } as Assignment;
    const data = fakeData({ listDrivers: vi.fn(async () => [driver()]), listAssignments: vi.fn(async () => [asg]), listUnits: vi.fn(async () => [unit({ plate: 'AB-123' })]),
      dues: vi.fn(async () => ({ todayCents: 1000, overdueCents: 2600, futureCents: 0, totalPendingCents: 3600, creditCents: 0 })), setRemindersPaused: vi.fn(async () => undefined), position: vi.fn(async () => ({ assignmentId: 'a1', chargedCents: 0, grossCents: 0, commissionCents: 0, netCents: 7200, pendingCents: 3600, creditCents: 0, balanceCents: 3600 })), movements: vi.fn(async () => MOVS) });
    TestBed.configureTestingModule({ providers: [provideRouter([]), { provide: DataService, useValue: data },
      { provide: ApiService, useValue: fakeApi() }, { provide: Breakpoints, useValue: bpWith(false) }] });
    const f = TestBed.createComponent(DriverDetail);
    f.componentRef.setInput('id', 'd1');
    await settle(f);
    const el = f.nativeElement as HTMLElement;
    expect(el.textContent).toContain('Ana Pérez');
    expect(el.textContent).toContain('AB-123');
    expect(el.textContent).toContain('$36.00');
    for (const s of ['Unidad asignada', 'Pagos y movimientos', 'Historial de asignaciones']) expect(el.textContent).toContain(s);
    expect(el.textContent).not.toContain('Registrar pago');
    expect(data.position).toHaveBeenCalledWith('a1');
  });
  async function ficha(drv = driver(), data = fakeData()) {
    const asg = { id: 'a1', driverId: 'd1', unitId: 'u1', unitCode: 'T-1', operatorCode: '101', driverName: 'Ana Pérez', validFrom: '2026-01-01', validTo: null, agreementNote: null, dailyRateCents: 3600 } as Assignment;
    const d = fakeData({ listDrivers: vi.fn(async () => [drv]), listAssignments: vi.fn(async () => [asg]), listUnits: vi.fn(async () => [unit()]),
      dues: vi.fn(async () => ({ todayCents: 1000, overdueCents: 2600, futureCents: 0, totalPendingCents: 3600, creditCents: 0 })), position: vi.fn(async () => null), movements: vi.fn(async () => []),
      setRemindersPaused: vi.fn(async () => undefined), ...data as object });
    TestBed.configureTestingModule({ providers: [provideRouter([]), { provide: DataService, useValue: d }, { provide: ApiService, useValue: fakeApi() }, { provide: Breakpoints, useValue: bpWith(false) }] });
    const f = TestBed.createComponent(DriverDetail);
    f.componentRef.setInput('id', 'd1');
    await settle(f);
    return { f, el: f.nativeElement as HTMLElement, d };
  }
  it('muestra el desglose cuota de hoy / deuda anterior / total calculado por la base de datos', async () => {
    const { el, d } = await ficha();
    const t = el.querySelector('[aria-label="Desglose de la deuda"]')!.textContent!;
    for (const s of ['Cuota de hoy', '$10.00', 'Deuda anterior', '$26.00', 'Deuda total', '$36.00']) expect(t).toContain(s);
    expect((d.dues as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBe('a1');
  });
      it('conductor inexistente: estado vacío', async () => {
    TestBed.configureTestingModule({ providers: [provideRouter([]), { provide: DataService, useValue: fakeData({ listDrivers: vi.fn(async () => []), listAssignments: vi.fn(async () => []), listUnits: vi.fn(async () => []) }) },
      { provide: ApiService, useValue: fakeApi() }, { provide: Breakpoints, useValue: bpWith(false) }] });
    const f = TestBed.createComponent(DriverDetail);
    f.componentRef.setInput('id', 'zzz');
    await settle(f);
    expect((f.nativeElement as HTMLElement).textContent).toContain('Conductor no encontrado');
  });
});

describe('Rutas', () => {
  const flat = (rs: typeof routes, base = ''): { path: string; guarded: boolean; title?: string }[] =>
    rs.flatMap((r) => [{ path: `${base}/${r.path}`.replace(/\/+/g, '/'), guarded: !!r.canActivate?.length, title: r.data?.['title'] as string | undefined }, ...flat(r.children ?? [], `${base}/${r.path}`)]);
  it('el área privada exige sesión; no hay registro, miembros, usuarios ni organizaciones; no quedan guards por rol', () => {
    const all = flat(routes);
    expect(routes.find((r) => r.path === '')!.canActivate?.length).toBe(1);
    expect(all.some((r) => /regist|signup|sign-up|miembro|member|organiz|invit/i.test(r.path))).toBe(false);
    expect(all.some((r) => r.path.endsWith('/configuracion/usuarios'))).toBe(true);
    expect(JSON.stringify(routes, (_, v) => (typeof v === 'function' ? undefined : v))).not.toMatch(/minRole|roleGuard/);
  });
  it('incluye las pantallas de las reglas operativas', () => {
    const paths = flat(routes).map((r) => r.path);
    for (const p of ['/mensajeria', '/mensajeria/plantillas', '/mensajeria/historial', '/mensajeria/whatsapp', '/reportes', '/unidades/:id', '/configuracion']) expect(paths, p).toContain(p);
  });
});

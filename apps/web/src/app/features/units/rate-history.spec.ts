import { TestBed } from '@angular/core/testing';
import { ApiError } from '../../core/errors';
import type { Assignment, RateHistoryItem } from '../../core/models';
import { ApiService, AuthService, Breakpoints } from '../../core/services';
import { FakeAuth, FakeBreakpoints, byText, fakeApi, settle, typeInto } from '../../testing/fakes';
import { RateChange } from './rate-change';
import { RateHistory } from './rate-history';

const ROWS: RateHistoryItem[] = [
  { rateId: 'r2', assignmentId: 'a1', unitId: 'u1', unitCode: '4321', driverId: 'd1', operatorCode: '77', driverName: 'Ana Pérez', previousRateId: 'r1', previousDailyCents: 4000, newDailyCents: 4500,
    validFrom: '2026-11-19', previousValidTo: '2026-11-18', validTo: null, changedBy: 'u9', changedByName: 'Admin Prueba', changedAt: '2026-11-16T20:05:00Z', reason: 'Acuerdo nuevo', isCurrent: true },
  { rateId: 'r1', assignmentId: 'a1', unitId: 'u1', unitCode: '4321', driverId: 'd1', operatorCode: '77', driverName: 'Ana Pérez', previousRateId: null, previousDailyCents: null, newDailyCents: 4000,
    validFrom: '2026-11-02', previousValidTo: null, validTo: '2026-11-18', changedBy: null, changedByName: null, changedAt: '2026-11-02T14:00:00Z', reason: null, isCurrent: false },
];
const text = (e: Element) => e.textContent!.replace(/\s+/g, ' ').trim();

async function mountHistory(o: { role?: 'admin' | 'super_admin' | 'supervisor'; mobile?: boolean; rows?: RateHistoryItem[]; id?: string | null; api?: object } = {}) {
  TestBed.resetTestingModule();
  const bp = new FakeBreakpoints(); bp.isMobile.set(!!o.mobile);
  const api = fakeApi({ rateHistory: vi.fn(async () => o.rows ?? ROWS), ...o.api });
  TestBed.configureTestingModule({ providers: [{ provide: ApiService, useValue: api }, { provide: Breakpoints, useValue: bp }, { provide: AuthService, useValue: new FakeAuth().login(o.role ?? 'admin') }] });
  const f = TestBed.createComponent(RateHistory);
  if (o.id !== null) f.componentRef.setInput('assignmentId', o.id ?? 'a1');
  await settle(f);
  return { f, el: f.nativeElement as HTMLElement, api };
}

describe('Historial de tarifas', () => {
  it('tabla compacta: tarifa anterior → nueva, vigencia, usuario, fecha y hora de 12 h y motivo (más reciente primero)', async () => {
    const { el, api } = await mountHistory();
    expect(api.rateHistory).toHaveBeenCalledWith('a1');
    const heads = Array.from(el.querySelectorAll('thead th')).map((h) => h.textContent!.trim());
    expect(heads).toEqual(['Tarifa anterior → nueva', 'Vigencia', 'Usuario', 'Fecha y hora', 'Motivo']);
    const rows = Array.from(el.querySelectorAll('tbody tr')).map(text);
    expect(rows[0]).toContain('$40.00 → $45.00'); expect(rows[0]).toContain('Vigente'); expect(rows[0]).toContain('19/11/2026 → vigente'); expect(rows[0]).toContain('Admin Prueba');
    expect(rows[0]).toMatch(/16\/11\/2026 \d{1,2}:\d{2} (AM|PM)/i); expect(rows[0]).toContain('Acuerdo nuevo');
    expect(rows[1]).toContain('Tarifa inicial → $40.00'); expect(rows[1]).toContain('02/11/2026 → 18/11/2026'); expect(rows[1]).toContain('—');   // usuario y motivo sin dato: no se inventan
  });
  it('sin asignación concreta usa GET /rate-history y agrega unidad, operario y conductor', async () => {
    const { el, api } = await mountHistory({ id: null });
    expect(api.rateHistory).toHaveBeenCalledWith(undefined);
    expect(Array.from(el.querySelectorAll('thead th')).slice(0, 3).map((h) => h.textContent!.trim())).toEqual(['Unidad', 'Operario', 'Conductor']);
    expect(text(el.querySelector('tbody tr')!)).toContain('4321');
  });
  it('móvil: tarjetas; estado vacío; error con reintento; supervisor no ve nada (la API es ADMIN+)', async () => {
    const m = await mountHistory({ mobile: true });
    expect(el0(m).querySelector('table')).toBeNull(); expect(m.el.querySelectorAll('ul.cards li').length).toBe(2);
    expect(text(m.el.querySelector('ul.cards li')!)).toContain('$40.00 → $45.00');
    const e = await mountHistory({ rows: [] }); expect(e.el.textContent).toContain('Sin cambios de tarifa');
    const err = await mountHistory({ api: { rateHistory: vi.fn(async () => { throw new ApiError('internal_error', 500); }) } });
    expect(err.el.querySelector('[role=alert]')).not.toBeNull();
    const sup = await mountHistory({ role: 'supervisor' });
    expect(sup.el.textContent!.trim()).toBe(''); expect(sup.api.rateHistory).not.toHaveBeenCalled();
  });
});
const el0 = (m: { el: HTMLElement }) => m.el;

describe('Cambio de tarifa: vigencia, motivo, confirmación y errores en español', () => {
  const A = { id: 'a1', unitCode: '4321', driverName: 'Ana Pérez', validFrom: '2026-01-01', validTo: null, dailyRateCents: 4000 } as unknown as Assignment;
  async function mountChange(changeRate: unknown) {
    TestBed.resetTestingModule();
    const api = fakeApi({ changeRate });
    TestBed.configureTestingModule({ providers: [{ provide: ApiService, useValue: api }] });
    const f = TestBed.createComponent(RateChange);
    f.componentRef.setInput('assignment', A);
    const done = vi.fn(); f.componentInstance.done.subscribe(done);
    await settle(f);
    const el = f.nativeElement as HTMLElement;
    const submit = async () => { (el.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit')); await settle(f); };
    return { f, el, api, done, submit };
  }
  it('lleva fecha de vigencia con ayuda, motivo opcional y paso de confirmación; doble envío = una llamada', async () => {
    let release!: () => void;
    const change = vi.fn(() => new Promise((res) => { release = () => res({ assignmentId: 'a1', rateId: 'r2', from: '2026-11-19', previousDailyCents: 4000, newDailyCents: 4500, existingChargesFromDateUnchanged: 0 }); }));
    const { f, el, submit, done } = await mountChange(change);
    expect(el.textContent).toContain('Aplica desde esa fecha hacia adelante'); expect(el.textContent).toContain('no cambia cuotas ya generadas');
    expect(el.querySelector('#rc-from')).not.toBeNull(); expect(el.querySelector('#rc-reason')!.closest('.field')!.textContent).toContain('opcional');
    await submit(); expect(el.querySelector('[role=alert]')!.textContent).toContain('tarifa válida');
    typeInto(el, '#rc-amount', '45'); typeInto(el, '#rc-from', '2026-11-19'); await settle(f);
    await submit(); expect(change).not.toHaveBeenCalled(); expect(el.textContent).toContain('de $40.00 a $45.00 por día desde el 19/11/2026');
    await submit(); const b = byText(el, 'button', 'Confirmar cambio de tarifa'); await submit(); b.click();
    expect(change).toHaveBeenCalledTimes(1); expect(el.querySelector('button.is-busy')).not.toBeNull();
    release(); await settle(f);
    expect(done).toHaveBeenCalledWith(expect.stringContaining('Tarifa actualizada'));
  });
  it.each([
    ['rate_change_retroactive', 'Ya hay cuotas generadas desde esa fecha; la nueva tarifa solo puede aplicar hacia adelante'],
    ['rate_change_closed_week', 'semana ya cerrada'], ['rate_overlap', 'se solapan'], ['assignment_change_retroactive', 'con efecto en el pasado'], ['invalid_dates', 'fechas indicadas no son válidas'],
  ])('error %s se muestra en español y el botón se libera', async (code, frag) => {
    const { f, el, submit } = await mountChange(vi.fn(async () => { throw new ApiError(code, 400); }));
    typeInto(el, '#rc-amount', '45'); await settle(f);
    await submit(); await submit();
    expect(el.querySelector('[role=alert]')!.textContent).toContain(frag);
    expect(el.querySelector('button.is-busy')).toBeNull();
  });
});

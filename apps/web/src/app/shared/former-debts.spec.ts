import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { ApiError } from '../core/errors';
import type { FormerDebt } from '../core/models';
import { ApiService, Breakpoints } from '../core/services';
import { WeekPayments } from '../features/dashboard/week-payments';
import { todayIn } from '../core/dates';
import { TIMEZONE } from '../core/models';
import { FakeBreakpoints, fakeApi, settle } from '../testing/fakes';
import { FormerDebts } from './former-debts';

const DEBT: FormerDebt = { assignmentId: 'a', driverId: 'd1', unitCode: 'P280', operatorCode: '10325', fullName: 'Ex Operario', endedOn: '2026-11-26', pendingCents: 19900 };
async function mk(formerDebts: () => Promise<FormerDebt[]>, detail = false) {
  TestBed.configureTestingModule({ providers: [provideRouter([]), { provide: ApiService, useValue: fakeApi({ formerDebts }) }] });
  const f = TestBed.createComponent(FormerDebts); f.componentRef.setInput('detail', detail); await settle(f);
  const el = f.nativeElement as HTMLElement;
  return { el, stable: () => settle(f), text: () => el.textContent!.replace(/\s+/g, ' ').trim() };
}

describe('Deuda de desvinculados', () => {
  it('en Inicio y Cobranza: cuántos y cuánto, y «Ver cuáles» los muestra ahí mismo sin cambiar de pantalla', async () => {
    const t = await mk(async () => [DEBT]);
    expect(t.text()).toContain('desvinculados con saldo pendiente: 1 · $199.00');
    expect(t.text()).not.toContain('Ex Operario');
    const btn = t.el.querySelector('button')!;
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    btn.click(); await t.stable();
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    expect(t.text()).toContain('Ex Operario · operario 10325 · unidad P280 hasta 26');
    expect(t.el.querySelector('li a')!.getAttribute('href')).toBe('/drivers/d1');
    btn.click(); await t.stable();
    expect(t.text()).not.toContain('Ex Operario');
  });
  it('en Conductores: quién, de qué unidad, hasta cuándo y cuánto, con enlace a su ficha', async () => {
    const t = await mk(async () => [DEBT], true);
    expect(t.text()).toContain('Ex Operario · operario 10325 · unidad P280 hasta 26');
    expect(t.el.querySelector('li a')!.getAttribute('href')).toBe('/drivers/d1');
  });
  it('sin deudas no ocupa sitio; si la consulta falla lo dice (no se confunde con «sin deuda»)', async () => {
    expect((await mk(async () => [])).text()).toBe('');
    TestBed.resetTestingModule();
    expect((await mk(async () => { throw new ApiError('internal', 500); })).text()).toContain('No se pudo consultar');
  });
});

describe('Inicio · pagos de la semana con desvinculados', () => {
  it('no los lista como «no pagaron», pero el dinero recibido ese día sí cuenta', async () => {
    const today = todayIn(TIMEZONE);
    const row = (id: string, ended: boolean, paid: number) => ({ assignmentId: id, unitCode: id, fullName: `Nombre ${id}`, ended, days: [{ date: today, dueCents: 1000, paidCents: paid }] });
    TestBed.configureTestingModule({ providers: [{ provide: Breakpoints, useValue: new FakeBreakpoints() },
      { provide: ApiService, useValue: fakeApi({ collectionBoard: vi.fn(async () => [row('U1', false, 0), row('P280', true, 0), row('P281', true, 1000)]), collectionLastSync: vi.fn(async () => null) }) }] });
    const f = TestBed.createComponent(WeekPayments); await settle(f);
    const text = (f.nativeElement as HTMLElement).textContent!.replace(/\s+/g, ' ');
    expect(text).toContain('No pagaron (1)'); expect(text).toContain('Pagaron completo (0)'); expect(text).toContain('$10.00');
    expect(text).not.toContain('P280');
  });
});

import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { ApiService, AuthService, Breakpoints, DataService } from '../../core/services';
import type { Assignment } from '../../core/models';
import { FakeAuth, FakeBreakpoints, driver, fakeApi, fakeData, settle } from '../../testing/fakes';
import { DriverDetail } from './driver-detail';

const asg = (o: Partial<Assignment> = {}): Assignment => ({ id: 'a1', driverId: 'd1', unitId: 'u1', unitCode: 'P280', operatorCode: '10325', driverName: 'Ex Operario',
  validFrom: '2026-11-23', validTo: '2026-11-26', agreementNote: null, dailyRateCents: 3900, ...o });

describe('Ficha de un conductor desvinculado', () => {
  it('conserva los pagos y movimientos de la unidad donde estuvo, indicando hasta cuándo', async () => {
    const data = fakeData({ listDrivers: vi.fn(async () => [driver()]), listAssignments: vi.fn(async () => [asg({ id: 'old', unitCode: 'P100', validFrom: '2026-10-01', validTo: '2026-10-30' }), asg()]),
      listUnits: vi.fn(async () => []), movements: vi.fn(async () => []) });
    TestBed.configureTestingModule({ providers: [provideRouter([]), { provide: DataService, useValue: data }, { provide: ApiService, useValue: fakeApi() },
      { provide: AuthService, useValue: new FakeAuth().login('admin') }, { provide: Breakpoints, useValue: new FakeBreakpoints() }] });
    const f = TestBed.createComponent(DriverDetail); f.componentRef.setInput('id', 'd1'); await settle(f);
    const text = (f.nativeElement as HTMLElement).textContent!.replace(/\s+/g, ' ');
    expect(data.movements).toHaveBeenCalledWith('a1');
    expect(text).toContain('Sin unidad asignada');
    expect(text).toContain('De la unidad P280, de la que se desvinculó el 26');
    expect(text).toContain('Historial de asignaciones');
  });
});

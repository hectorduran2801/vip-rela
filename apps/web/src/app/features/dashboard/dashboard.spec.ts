import { TestBed } from '@angular/core/testing';
import { ApiError } from '../../core/errors';
import type { DashboardData } from '../../core/models';
import { provideRouter } from '@angular/router';
import { ApiService } from '../../core/services';
import { fakeApi } from '../../testing/fakes';
import { Dashboard } from './dashboard';

const DATA: DashboardData = {
  drivers: { total: 12, active: 9, inactive: 1, suspended: 1, pending_approval: 1 },
  collections: { pending_total_cents: 7200, drivers_with_debt: 2, collected_today_gross_cents: 3700, collected_today_commission_cents: 100,
    collected_today_net_cents: 3600, week_charged_cents: 21600, week_net_cents: 3600, credits_total_cents: 400 },
  by_method: [{ method_code: 'yappy', payments: 1, gross_cents: 3700, commission_cents: 100, net_cents: 3600 }],
  reminders: { scheduled_today: 5, pending_total: 3 },
  whatsapp: { sessions: [{ id: 's1', label: 'Principal', status: 'connected' }] },
};

async function settle(f: { detectChanges(): void; whenStable(): Promise<unknown> }) {
  for (let i = 0; i < 4; i++) { f.detectChanges(); await f.whenStable(); await new Promise((r) => setTimeout(r, 0)); }
  f.detectChanges();
}

async function setup(api: object) {
  TestBed.configureTestingModule({ providers: [provideRouter([]), { provide: ApiService, useValue: api }] });
  const f = TestBed.createComponent(Dashboard);
  await settle(f);
  return { f, el: f.nativeElement as HTMLElement };
}

describe('Dashboard', () => {
  it('muestra los datos que devuelve la API (sin ningún parámetro de organización)', async () => {
    const api = fakeApi({ dashboard: vi.fn(async () => DATA) });
    const { el } = await setup(api);
    expect(api.dashboard).toHaveBeenCalledWith();
    expect(el.textContent).toContain('$72.00');
    expect(el.textContent).toContain('2 conductores con deuda');
    expect(el.textContent).toContain('Conectado');
    expect(el.textContent).not.toMatch(/organizaci/i);
  });
  it('error de la API: mensaje en español y reintento', async () => {
    const dashboard = vi.fn().mockRejectedValueOnce(new ApiError('forbidden', 403)).mockResolvedValue(DATA);
    const { f, el } = await setup(fakeApi({ dashboard }));
    expect(el.querySelector('[role=alert]')!.textContent).toContain('No tienes permiso');
    (el.querySelector('[role=alert] button') as HTMLButtonElement).click();
    await settle(f);
    expect(el.textContent).toContain('$72.00');
  });
  it('accesos rápidos son enlaces reales (nada «próximamente» en el inicio)', async () => {
    const { el } = await setup(fakeApi({ dashboard: vi.fn(async () => DATA) }));
    const links = Array.from(el.querySelectorAll('.quick a'));
    expect(links.map((b) => b.textContent!.trim())).toEqual(['Cobranza y mensajes', 'Buscar conductor', 'Importar Excel', 'Plantillas']);
    expect(links.map((b) => b.getAttribute('href'))).toEqual(['/collections', '/drivers', '/settings/data', '/messages/templates']);
    expect(el.textContent).not.toContain('Próximamente');
  });
  it('sin pagos ni sesiones muestra estados vacíos, no cifras inventadas', async () => {
    const empty: DashboardData = { ...DATA, by_method: [], whatsapp: { sessions: [] } };
    const { el } = await setup(fakeApi({ dashboard: vi.fn(async () => empty) }));
    expect(el.textContent).toContain('WhatsApp sin configurar');
  });
  it('pide los pagos de la semana sin esperar a los totales', async () => {
    const collectionBoard = vi.fn(async () => []);
    const api = fakeApi({ dashboard: vi.fn(() => new Promise<DashboardData>(() => {})), collectionBoard });
    TestBed.configureTestingModule({ providers: [provideRouter([]), { provide: ApiService, useValue: api }] });
    const f = TestBed.createComponent(Dashboard);
    f.detectChanges();
    await new Promise((r) => setTimeout(r, 0));
    expect(collectionBoard).toHaveBeenCalledTimes(1);
  });
});

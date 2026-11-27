import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { todayIn } from '../core/dates';
import { TIMEZONE, type Role, type SendSchedule } from '../core/models';
import { ApiService, AuthService } from '../core/services';
import { FakeAuth, fakeApi } from '../testing/fakes';
import { ScheduleNotice } from './schedule-notice';

const today = () => todayIn(TIMEZONE);
const sched = (o: Partial<SendSchedule> = {}): SendSchedule => ({ id: 's1', name: 'Recordatorio nocturno', localTime: '21:20', weekdays: [1], templateId: 't', templateName: 'T', audience: 'selected', enabled: true,
  lastRunDate: `${today()}T05:00:00.000Z`, lastRunStatus: 'done', lastRunCreated: 49, lastRunTotal: 49, ...o });

async function settle(f: { detectChanges(): void; whenStable(): Promise<unknown> }) {
  for (let i = 0; i < 3; i++) { f.detectChanges(); await f.whenStable(); await new Promise((r) => setTimeout(r, 0)); }
  f.detectChanges();
}
async function setup(list: () => Promise<SendSchedule[]>, role: Role = 'admin') {
  const api = fakeApi({ listSendSchedules: vi.fn(list) });
  TestBed.configureTestingModule({ providers: [provideRouter([]), { provide: ApiService, useValue: api }, { provide: AuthService, useValue: new FakeAuth().login(role) }] });
  const f = TestBed.createComponent(ScheduleNotice);
  await settle(f);
  const tick = async () => { await (f.componentInstance as unknown as { tick(): Promise<void> }).tick(); await settle(f); };
  return { f, api, tick, text: () => (f.nativeElement as HTMLElement).textContent!.replace(/\s+/g, ' ').trim(), el: f.nativeElement as HTMLElement };
}

describe('Aviso de envío programado', () => {
  beforeEach(() => localStorage.clear());

  it('avisa que empezó un envío de hoy y cuántos mensajes salen, con enlace al historial', async () => {
    const t = await setup(async () => [sched()]);
    expect(t.text()).toContain('Se inició el envío programado «Recordatorio nocturno»: 49 mensajes en camino.');
    expect(t.el.querySelector('a')!.getAttribute('href')).toBe('/messages/history');
    expect(t.el.querySelector('[role=status]')).not.toBeNull();
  });
  it('aparece solo cuando el horario se ejecuta, sin recargar la página', async () => {
    let ran = false;
    const t = await setup(async () => [ran ? sched() : sched({ lastRunDate: null, lastRunStatus: null })]);
    expect(t.text()).toBe('');
    ran = true;
    await t.tick();
    expect(t.text()).toContain('Se inició el envío programado');
  });
  it('no avisa de ejecuciones de otros días', async () => {
    const t = await setup(async () => [sched({ lastRunDate: '2020-01-01T05:00:00.000Z' })]);
    expect(t.text()).toBe('');
  });
  it('al cerrarlo no vuelve a salir, ni al recargar', async () => {
    const t = await setup(async () => [sched()]);
    (t.el.querySelector('button') as HTMLButtonElement).click();
    await t.tick();
    expect(t.text()).toBe('');
    TestBed.resetTestingModule();
    expect((await setup(async () => [sched()])).text()).toBe('');
  });
  it('dice la verdad cuando no salió nada', async () => {
    const t = await setup(async () => [sched({ id: 'a', lastRunTotal: 0, lastRunCreated: 0 }), sched({ id: 'b', name: 'B', lastRunStatus: 'error', lastRunCreated: null, lastRunTotal: null }),
      sched({ id: 'c', name: 'C', lastRunStatus: 'missed', lastRunCreated: null, lastRunTotal: null })]);
    expect(t.text()).toContain('«Recordatorio nocturno» se ejecutó, pero no encontró destinatarios: no se envió ningún mensaje.');
    expect(t.text()).toContain('«B» no se pudo ejecutar: no se envió ningún mensaje.');
    expect(t.text()).toContain('«C» no salió hoy');
    expect(t.text()).not.toContain('en camino');
  });
  it('si no se crearon todos, lo indica', async () => {
    expect((await setup(async () => [sched({ lastRunCreated: 45 })])).text()).toContain('45 mensajes en camino (de 49 destinatarios)');
  });
  it('si la consulta falla no muestra nada ni rompe; quien solo consulta no pregunta', async () => {
    expect((await setup(async () => { throw new Error('sin red'); })).text()).toBe('');
    TestBed.resetTestingModule();
    const t = await setup(async () => [sched()], 'supervisor');
    expect(t.api.listSendSchedules).not.toHaveBeenCalled();
    expect(t.text()).toBe('');
  });
});

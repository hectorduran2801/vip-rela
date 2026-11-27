import { Type } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { SAVE_FILE } from './core/download';
import { ApiService, AuthService, Breakpoints, DataService } from './core/services';
import { DriverForm } from './features/drivers/driver-form';
import { Users } from './features/settings/users';
import { FakeAuth, FakeBreakpoints, byText, driver, fakeApi, fakeData, settle, typeInto } from './testing/fakes';

/** Cada acción crítica: al pulsar el botón queda OCUPADO al instante (etiqueta de progreso, aria-busy), el doble clic hace UNA llamada y se libera al terminar. */
const busyOf = (el: HTMLElement, text: string) => Array.from(el.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent!.includes(text) || b.getAttribute('data-busy-label') === text)!;
const hold = <T,>() => { let resolve!: (v: T) => void; let reject!: (e: unknown) => void; const p = new Promise<T>((res, rej) => { resolve = res; reject = rej; }); return { p, resolve, reject }; };

async function mount<T>(cmp: Type<T>, providers: unknown[], inputs: Record<string, unknown> = {}) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [provideRouter([]), { provide: Breakpoints, useValue: new FakeBreakpoints() }, { provide: SAVE_FILE, useValue: () => undefined }, ...providers] as never[] });
  const f = TestBed.createComponent(cmp);
  for (const [k, v] of Object.entries(inputs)) f.componentRef.setInput(k, v);
  await settle(f);
  return { f, el: f.nativeElement as HTMLElement };
}
const auth = (r: 'admin' | 'super_admin' = 'super_admin') => ({ provide: AuthService, useValue: new FakeAuth().login(r) });
function expectBusy(b: HTMLButtonElement, label: string): void {
  expect(b.classList.contains('is-busy')).toBe(true);
  expect(b.getAttribute('data-busy-label')).toBe(label);
  expect(b.getAttribute('aria-busy')).toBe('true');
}

describe('Acciones críticas: estado ocupado inmediato', () => {
  it('guardar conductor: «Guardando…» y una sola llamada a saveDriver', async () => {
    const save = hold<string>();
    const data = fakeData({ saveDriver: vi.fn(() => save.p) });
    const { f, el } = await mount(DriverForm, [{ provide: DataService, useValue: data }, { provide: ApiService, useValue: fakeApi() }], { driver: driver({ phoneE164: '+50760000001' }) });
    (el.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit')); f.detectChanges();
    const b = el.querySelector('form button[type=submit]') as HTMLButtonElement;
    expectBusy(b, 'Guardando…');
    (el.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit'));
    expect(data.saveDriver).toHaveBeenCalledTimes(1);
    save.resolve('d1'); await settle(f);
    expect(el.querySelector('button.is-busy')).toBeNull();
  });

  it('crear cuenta: «Creando…» ocupado y no se envía dos veces', async () => {
    const create = hold<{ mode: 'created' }>();
    const api = fakeApi({ listUsers: vi.fn(async () => []), listInvites: vi.fn(async () => []), createUser: vi.fn(() => create.p) });
    const { f, el } = await mount(Users, [auth(), { provide: ApiService, useValue: api }]);
    byText(el, 'button', 'Nueva cuenta').click(); await settle(f);
    typeInto(el, '#nu-email', 'a@x.co'); await settle(f);
    const form = el.querySelector('form') as HTMLFormElement;
    form.dispatchEvent(new Event('submit')); f.detectChanges();
    expectBusy(el.querySelector('[role=dialog] button[type=submit]') as HTMLButtonElement, 'Creando…');
    form.dispatchEvent(new Event('submit'));
    expect(api.createUser).toHaveBeenCalledTimes(1);
    create.resolve({ mode: 'created' }); await settle(f);
    expect(el.querySelector('button.is-busy')).toBeNull();
  });
});

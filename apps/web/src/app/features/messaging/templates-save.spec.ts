import { TestBed } from '@angular/core/testing';
import { classifyError, errorMessage } from '../../core/errors';
import type { MessageTemplate } from '../../core/models';
import { ApiService, AuthService, Breakpoints, DataService } from '../../core/services';
import { FakeAuth, FakeBreakpoints, byLabel, byText, fakeApi, fakeData, settle, typeInto } from '../../testing/fakes';
import { Templates } from './templates';

/** «Guardar plantilla»: crear, editar (update por id), nombre duplicado, error de red con reintento, doble clic y botón que se vuelve a habilitar. */
const TPL: MessageTemplate[] = [{ id: 't1', name: 'Cobro estándar', body: 'Hola {{nombre}}, {{detalle_deuda}}' }];
const hold = <T,>() => { let resolve!: (v: T) => void; let reject!: (e: unknown) => void; const p = new Promise<T>((res, rej) => { resolve = res; reject = rej; }); return { p, resolve, reject }; };

async function setup(role: 'admin' | 'super_admin', data: object = {}) {
  TestBed.resetTestingModule();
  const d = fakeData({ listTemplates: vi.fn(async () => TPL), saveTemplate: vi.fn(async () => undefined), deleteTemplate: vi.fn(async () => undefined), listAssignments: vi.fn(async () => []), ...data });
  TestBed.configureTestingModule({ providers: [{ provide: DataService, useValue: d }, { provide: ApiService, useValue: fakeApi() }, { provide: AuthService, useValue: new FakeAuth().login(role) }, { provide: Breakpoints, useValue: new FakeBreakpoints() }] });
  const f = TestBed.createComponent(Templates);
  await settle(f);
  return { f, el: f.nativeElement as HTMLElement, d };
}
const submit = (el: HTMLElement) => (el.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit'));

describe.each(['admin', 'super_admin'] as const)('Guardar plantilla (%s)', (role) => {
  it('crear: llama a saveTemplate SIN id, cierra el formulario, avisa «Plantilla guardada» y recarga la lista', async () => {
    const { f, el, d } = await setup(role);
    byText(el, 'button', 'Nueva plantilla').click(); await settle(f);
    typeInto(el, '#tf-name', '  Domingo '); typeInto(el, '#tf-body', 'Hola {{nombre}}'); await settle(f);
    submit(el); await settle(f);
    expect(d.saveTemplate).toHaveBeenCalledTimes(1);
    expect((d.saveTemplate as any).mock.calls[0][0].id).toBeUndefined();
    expect(el.querySelector('form')).toBeNull();
    expect(el.querySelector('.alert.ok')!.textContent).toContain('Plantilla guardada');
    expect(d.listTemplates).toHaveBeenCalledTimes(2);
  });

  it('editar: conserva el id (update por id, no insert) y guarda el texto nuevo', async () => {
    const { f, el, d } = await setup(role);
    byLabel(el, '', 'Editar plantilla').click(); await settle(f);
    expect(el.querySelector('[role=dialog] h2')!.textContent).toContain('Editar plantilla');
    typeInto(el, '#tf-body', 'Nuevo texto {{saldo_total}}'); await settle(f);
    submit(el); await settle(f);
    expect(d.saveTemplate).toHaveBeenCalledWith({ id: 't1', name: 'Cobro estándar', body: 'Nuevo texto {{saldo_total}}' });
  });
});

describe('Guardar plantilla: validaciones y errores', () => {
  it('nombre vacío, texto vacío, texto > 1000 y nombre duplicado: no llama al servicio y dice por qué (en el formulario)', async () => {
    const { f, el, d } = await setup('admin');
    byText(el, 'button', 'Nueva plantilla').click(); await settle(f);
    const btn = () => byText(el, 'button', 'Guardar plantilla');
    expect(btn().disabled).toBe(false);                                    // nunca deshabilitado en silencio
    btn().click(); await settle(f);
    expect(el.querySelector('form [role=alert]')!.textContent).toContain('Escribe un nombre');
    typeInto(el, '#tf-name', 'X'); await settle(f);
    expect(el.querySelector('form [role=alert]')!.textContent).toContain('Escribe el texto');
    typeInto(el, '#tf-body', 'a'.repeat(1001)); await settle(f);
    expect(el.querySelector('form [role=alert]')!.textContent).toContain('supera los 1000');
    typeInto(el, '#tf-body', 'ok'); typeInto(el, '#tf-name', ' cobro ESTÁNDAR '); await settle(f);
    expect(el.querySelector('form [role=alert]')!.textContent).toContain('Ya existe una plantilla con ese nombre');
    expect(d.saveTemplate).not.toHaveBeenCalled();
  });

  it('error 23505 del servidor (nombre único): mensaje en español dentro del formulario, formulario abierto y botón de nuevo habilitado', async () => {
    const dup = Object.assign(new Error('duplicate key value violates unique constraint "message_templates_name_key"'), { code: '23505' });
    const { f, el, d } = await setup('admin', { saveTemplate: vi.fn(async () => { throw dup; }) });
    byText(el, 'button', 'Nueva plantilla').click(); await settle(f);
    typeInto(el, '#tf-name', 'Otra'); typeInto(el, '#tf-body', 'Hola'); await settle(f);
    submit(el); await settle(f);
    expect(el.querySelector('form')).not.toBeNull();
    expect(el.querySelector('form .modal-error')!.textContent).toContain('Ya existe una plantilla con ese nombre');
    const b = byText(el, 'button', 'Guardar plantilla');
    expect(b.classList.contains('is-busy')).toBe(false); expect(b.disabled).toBe(false);
    expect(d.listTemplates).toHaveBeenCalledTimes(1);                      // no recarga si falló
  });

  it('error de red: «Reintentar» dentro del formulario repite el guardado y, al funcionar, cierra', async () => {
    let n = 0;
    const save = vi.fn(async () => { if (n++ === 0) throw new TypeError('Failed to fetch'); });
    const { f, el } = await setup('admin', { saveTemplate: save });
    byText(el, 'button', 'Nueva plantilla').click(); await settle(f);
    typeInto(el, '#tf-name', 'Otra'); typeInto(el, '#tf-body', 'Hola'); await settle(f);
    submit(el); await settle(f);
    expect(el.querySelector('form .modal-error')).not.toBeNull();
    byText(el, 'form .modal-error button', 'Reintentar').click(); await settle(f);
    expect(save).toHaveBeenCalledTimes(2);
    expect(el.querySelector('form')).toBeNull();
    expect(el.querySelector('.alert.error')).toBeNull();
  });

  it('doble clic = UNA llamada; ocupado «Guardando…» mientras dura y se libera al terminar', async () => {
    const h = hold<void>();
    const { f, el, d } = await setup('admin', { saveTemplate: vi.fn(() => h.p) });
    byText(el, 'button', 'Nueva plantilla').click(); await settle(f);
    typeInto(el, '#tf-name', 'Otra'); typeInto(el, '#tf-body', 'Hola'); await settle(f);
    submit(el); f.detectChanges();
    const b = el.querySelector('button[type=submit]') as HTMLButtonElement;
    expect(b.classList.contains('is-busy')).toBe(true); expect(b.getAttribute('data-busy-label')).toBe('Guardando…');
    submit(el); b.click(); b.click();
    expect(d.saveTemplate).toHaveBeenCalledTimes(1);
    h.resolve(); await settle(f);
    expect(el.querySelector('button.is-busy')).toBeNull();
  });

  it('eliminar: una sola llamada aunque se pulse dos veces', async () => {
    const h = hold<void>();
    const { f, el, d } = await setup('super_admin', { deleteTemplate: vi.fn(() => h.p) });
    byLabel(el, '', 'Eliminar plantilla').click(); await settle(f);
    const yes = byText(el, 'button', 'Sí, eliminar'); yes.click(); f.detectChanges(); yes.click();
    expect(d.deleteTemplate).toHaveBeenCalledTimes(1);
    h.resolve(); await settle(f);
  });
});

describe('Errores de plantillas (catálogo)', () => {
  it('23505 sobre message_templates y 0 filas por RLS se explican en español', () => {
    expect(classifyError(Object.assign(new Error('duplicate key value violates unique constraint "message_templates_name_key"'), { code: '23505' })).message).toContain('plantilla con ese nombre');
    expect(errorMessage({ message: 'permission denied: row-level security (0 filas afectadas)', where: 'message_templates' })).toContain('permiso');
  });
});

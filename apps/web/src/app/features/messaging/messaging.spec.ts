import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { ApiError } from '../../core/errors';
import type { MessageTemplate } from '../../core/models';
import { ApiService, Breakpoints, DataService } from '../../core/services';
import { AuthService } from '../../core/services';
import { FakeAuth, FakeBreakpoints, byLabel, byText, fakeApi, fakeData, settle, typeInto } from '../../testing/fakes';
import { Messaging } from './messaging';
import { Templates, bodyWarnings, unknownVars } from './templates';
import { Whatsapp } from './whatsapp';

const TPL: MessageTemplate[] = [{ id: 't1', name: 'Cobro estándar', body: 'Hola {{nombre}}, {{detalle_deuda}}' }];
const bpWith = (m: boolean) => { const b = new FakeBreakpoints(); b.isMobile.set(m); return b; };

describe('Mensajería · pestañas', () => {
  it('cinco pestañas (Conexión, Plantillas, Variables, Horarios, Historial) y ningún aviso grande permanente', async () => {
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    const f = TestBed.createComponent(Messaging);
    await settle(f);
    const el = f.nativeElement as HTMLElement;
    expect(Array.from(el.querySelectorAll('nav a')).map((a) => a.textContent!.trim())).toEqual(['Conexión', 'Plantillas', 'Variables', 'Horarios', 'Historial']);
    expect(Array.from(el.querySelectorAll('nav a')).map((a) => a.getAttribute('href'))).toEqual(['/messages/whatsapp', '/messages/templates', '/messages/variables', '/messages/schedules', '/messages/history']);
    expect(el.querySelector('.alert')).toBeNull();
    expect(el.textContent).not.toContain('envíos.Los horarios');
  });
});

export const CATALOG = [
  ['Datos del conductor', 'nombre', 'Nombre', 'Solo el nombre del conductor.', 'Vanessa'],
  ['Datos del conductor', 'apellido', 'Apellido', 'Solo el apellido.', 'Ejemplo'],
  ['Datos del conductor', 'nombre_completo', 'Nombre completo', 'Nombre y apellido.', 'Vanessa Ejemplo'],
  ['Unidad y operario', 'unidad', 'Unidad', 'Código de la unidad.', '4321'],
  ['Unidad y operario', 'codigo_operario', 'Código de operario', 'Código del operario.', '1234'],
  ['Fechas', 'fecha', 'Fecha', 'Fecha completa en español.', 'lunes 16 de noviembre de 2026'],
  ['Importes financieros', 'cuota_hoy', 'Cuota de hoy', 'Cuota de hoy.', '$40.00'],
  ['Importes financieros', 'pendiente_hoy', 'Pendiente de hoy', 'Lo pendiente de hoy.', '$40.00'],
  ['Importes financieros', 'deuda_anterior', 'Deuda anterior', 'Deuda de días anteriores.', '$0.00'],
  ['Importes financieros', 'deuda_semanal', 'Deuda semanal', 'Deuda de la semana.', '$40.00'],
  ['Importes financieros', 'saldo_total', 'Saldo total', 'Deuda exigible hoy.', '$40.00'],
  ['Importes financieros', 'credito', 'Crédito', 'Saldo a favor.', '$0.00'],
  ['Importes financieros', 'cuenta_semanal', 'Cuenta semanal', 'Cuenta de la semana.', '$240.00'],
  ['Importes financieros', 'pagos_semana', 'Pagos de la semana', 'Pagos de la semana.', '$0.00'],
  ['Textos inteligentes', 'detalle_deuda', 'Detalle de deuda', 'Frase completa según lo que debe.', 'Su cuota pendiente de hoy es de $40.00.'],
  ['Textos inteligentes', 'cuenta_semana', 'Cuenta de la semana (antigua)', 'Cuotas ya generadas de la semana.', '$40.00'],
].map(([group, code, label, description, example]) => ({ group: group!, code: code!, label: label!, description: description!, example: example! }));

const NO_INLINE = (el: HTMLElement): string[] => Array.from(el.querySelectorAll('input[name], textarea[name], select[name]')).filter((i) => !i.closest('[role=dialog]') && !i.closest('[role=alertdialog]') && !i.closest('.limits') && !/search/.test((i as HTMLInputElement).type)).map((i) => i.getAttribute('name')!);
describe('Formularios en modal (Plantillas): nada inline y guardado sin recargar', () => {
  it('Plantillas: «Editar» abre un modal xl; ningún campo queda fuera del dialog; el listado sigue; guardar cierra y actualiza sin recarga; con error el modal queda abierto con lo escrito', async () => {
    const { Templates: T } = await import('./templates');
    TestBed.resetTestingModule();
    let fail = true;
    const d = fakeData({ listTemplates: vi.fn(async () => TPL), listAssignments: vi.fn(async () => []), saveTemplate: vi.fn(async () => { if (fail) { fail = false; throw new TypeError('Failed to fetch'); } }) });
    TestBed.configureTestingModule({ providers: [{ provide: DataService, useValue: d }, { provide: ApiService, useValue: fakeApi({ templateVariables: vi.fn(async () => []) }) }, { provide: Breakpoints, useValue: new FakeBreakpoints() }] });
    const f = TestBed.createComponent(T); await settle(f);
    const el = f.nativeElement as HTMLElement;
    const listBefore = el.querySelector('.tpl-grid')!;
    byLabel(el, '', 'Editar plantilla').click(); await settle(f);
    const dlg = el.querySelector('[role=dialog]')!;
    expect(dlg.className).toContain('size-xl'); expect(dlg.querySelector('h2')!.textContent).toContain('Editar plantilla');
    expect(NO_INLINE(el)).toEqual([]); expect(el.querySelector('.tpl-grid')).toBe(listBefore); expect(el.querySelector('form.panel')).toBeNull();
    expect(dlg.querySelector('.tpl-col-left')).not.toBeNull(); expect(dlg.querySelector('.tpl-col-right')).not.toBeNull();     // editor+variables | vista previa
    typeInto(el, '#tf-body', 'Texto nuevo'); await settle(f);
    expect(TPL[0]!.body).toBe('Hola {{nombre}}, {{detalle_deuda}}');                // copia de trabajo: el listado no muta hasta guardar
    (el.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit')); await settle(f);
    expect(el.querySelector('[role=dialog]')).not.toBeNull(); expect(el.querySelector('[role=dialog] .modal-error')).not.toBeNull();
    expect((el.querySelector('#tf-body') as HTMLTextAreaElement).value).toBe('Texto nuevo');
    byText(el, '[role=dialog] .modal-error button', 'Reintentar').click(); await settle(f);
    expect(el.querySelector('[role=dialog]')).toBeNull(); expect(d.listTemplates).toHaveBeenCalledTimes(2); expect(el.textContent).toContain('Plantilla guardada');
  });
});

describe('Plantillas', () => {
  it('unknownVars detecta variables inexistentes y acepta las válidas (incluidas las del resumen)', () => {
    expect(unknownVars('Hola {{nombre}} {{ unidad }} {{cuenta_semana}} {{pagos_semana}} {{foo}} {{bar}}')).toEqual(['cuenta_semana', 'foo', 'bar']);   // {{cuenta_semana}} ya no existe (el devengo interno no se comunica)
  });
  async function setup(api: object = {}, data: object = {}, mobile = false) {
    TestBed.resetTestingModule();
    const d = fakeData({
      listTemplates: vi.fn(async () => TPL), saveTemplate: vi.fn(async () => undefined), deleteTemplate: vi.fn(async () => undefined),
      listAssignments: vi.fn(async () => [
        { id: 'a1', driverId: 'd1', unitId: 'u1', unitCode: 'T-1', operatorCode: '101', driverName: 'Ana Pérez', validFrom: '2026-01-01', validTo: null, agreementNote: null, dailyRateCents: 3600 },
        { id: 'a0', driverId: 'd0', unitId: 'u0', unitCode: 'T-0', operatorCode: '100', driverName: 'Viejo', validFrom: '2025-01-01', validTo: '2025-12-31', agreementNote: null, dailyRateCents: 3600 }]),
      ...data });
    const bp = new FakeBreakpoints(); bp.isMobile.set(mobile);
    const a = fakeApi({ templateVariables: vi.fn(async () => CATALOG), ...api });
    TestBed.configureTestingModule({ providers: [{ provide: DataService, useValue: d }, { provide: ApiService, useValue: a }, { provide: Breakpoints, useValue: bp }] });
    const f = TestBed.createComponent(Templates);
    await settle(f);
    return { f, el: f.nativeElement as HTMLElement, d, a };
  }
  const open = async (o: Awaited<ReturnType<typeof setup>>, edit = false) => { (edit ? byLabel(o.el, '', 'Editar plantilla') : byText(o.el, 'button', 'Nueva plantilla')).click(); await o.f.whenStable(); await settle(o.f); };
  const text = (e: Element) => e.textContent!.replace(/\s+/g, ' ').trim();

  it('panel de variables agrupado en el orden del contrato, con nombre, código, descripción y ejemplo visibles antes de insertar', async () => {
    const o = await setup(); await open(o);
    expect(Array.from(o.el.querySelectorAll('.var-group > summary strong')).map((s) => s.textContent)).toEqual(['Datos del conductor', 'Unidad y operario', 'Fechas', 'Importes financieros', 'Textos inteligentes', 'Antigua / compatibilidad']);
    const item = Array.from(o.el.querySelectorAll('.var-item')).find((b) => b.textContent!.includes('{{unidad}}'))!;
    expect(text(item)).toContain('Unidad'); expect(text(item)).toContain('Código de la unidad.'); expect(text(item)).toContain('Ejemplo: 4321');
    expect(o.el.querySelectorAll('.var-item').length).toBe(16);
  });
  it('cuenta_semana va aparte como «Antigua / compatibilidad» (no recomendada) y los textos inteligentes llevan su aviso', async () => {
    const o = await setup(); await open(o);
    const legacy = o.el.querySelector('.var-group.legacy')!;
    expect(text(legacy)).toContain('{{cuenta_semana}}'); expect(text(legacy)).toContain('Antigua / compatibilidad'); expect(text(legacy)).toContain('no se recomienda');
    const smart = Array.from(o.el.querySelectorAll('.var-group')).find((g) => g.textContent!.includes('detalle_deuda'))!;
    expect(smart.querySelector('.smart-note')!.textContent).toContain('no le pongas prefijos como «su deuda es» ni punto final después');
    expect(smart.querySelector('.var-item.smart')).not.toBeNull();
    expect(smart.textContent).not.toContain('cuenta_semana');
  });
  it('buscador de variables filtra por nombre, código, descripción o ejemplo', async () => {
    const o = await setup(); await open(o);
    typeInto(o.el, '#var-q', 'crédito'); await settle(o.f);
    expect(Array.from(o.el.querySelectorAll('.var-item code')).map((c) => c.textContent)).toEqual(['{{credito}}']);
    typeInto(o.el, '#var-q', 'zzzz'); await settle(o.f); expect(o.el.textContent).toContain('Ninguna variable coincide');
  });
  it('clic inserta {{codigo}} en la posición del cursor (reemplaza la selección) y deja foco y cursor después', async () => {
    const o = await setup(); await open(o);
    typeInto(o.el, '#tf-body', 'Hola , gracias'); await settle(o.f);
    const ta = o.el.querySelector('#tf-body') as HTMLTextAreaElement;
    document.body.appendChild(o.el);
    ta.focus(); ta.setSelectionRange(5, 5);
    (Array.from(o.el.querySelectorAll('.var-item')).find((b) => b.textContent!.includes('{{nombre}}')) as HTMLButtonElement).click(); await settle(o.f);
    expect(ta.value).toBe('Hola {{nombre}}, gracias');
    expect(ta.selectionStart).toBe(5 + '{{nombre}}'.length); expect(document.activeElement).toBe(ta);
    ta.setSelectionRange(0, 4);
    (Array.from(o.el.querySelectorAll('.var-item')).find((b) => b.textContent!.includes('{{unidad}}')) as HTMLButtonElement).click(); await settle(o.f);
    expect(ta.value).toBe('{{unidad}} {{nombre}}, gracias');
    o.el.remove();
  });
  it('avisos en vivo no bloqueantes: punto pegado a {{detalle_deuda}}, variable desconocida y variable repetida seguida', async () => {
    const o = await setup(); await open(o);
    typeInto(o.el, '#tf-name', 'X'); typeInto(o.el, '#tf-body', 'Hola {{nombre}}{{nombre}} {{detalle_deuda}}. {{xyz}}'); await settle(o.f);
    const w = text(o.el.querySelector('#tf-warn')!);
    expect(w).toContain('quita el punto'); expect(w).toContain('No existe: {{xyz}}; no se enviará el mensaje.'); expect(w).toContain('Repites {{nombre}} seguida.');
    byText(o.el, 'button', 'Guardar plantilla').click(); await settle(o.f);
    expect(o.d.saveTemplate).toHaveBeenCalled();                                             // no bloquea
    expect(bodyWarnings('Hola {{nombre}} y {{nombre}}', ['nombre'])).toEqual([]);          // repetida NO seguida: sin aviso
  });
  it('contador /1000', async () => {
    const o = await setup(); await open(o);
    typeInto(o.el, '#tf-body', 'abc'); await settle(o.f);
    expect(text(o.el.querySelector('#tf-count')!)).toBe('3 / 1000 caracteres');
  });
  it('vista previa «Con valores de ejemplo»: instantánea, sin llamadas, usa los ejemplos del catálogo y respeta saltos de línea', async () => {
    const o = await setup(); await open(o);
    typeInto(o.el, '#tf-body', 'Hola {{nombre_completo}}\nUnidad {{unidad}} operario {{codigo_operario}}, {{fecha}}: {{cuota_hoy}}. {{detalle_deuda}}'); await settle(o.f);
    const b = o.el.querySelector('.wa-bubble')!;
    expect(b.textContent).toBe('Hola Vanessa Ejemplo\nUnidad 4321 operario 1234, lunes 16 de noviembre de 2026: $40.00. Su cuota pendiente de hoy es de $40.00.');
    expect(o.a.previewTemplateDetailed).not.toHaveBeenCalled();
    typeInto(o.el, '#tf-body', 'Hola {{xyz}}'); await settle(o.f);
    expect(o.el.querySelector('.wa-bubble')!.textContent).toBe('Hola {{xyz}}');
    expect(o.el.textContent).toContain('Este mensaje no se enviaría');
  });
  it('vista previa «Con un conductor real»: selector, busy, texto final exacto y variables sin resolver con advertencia', async () => {
    let release!: (v: unknown) => void;
    const o = await setup({ previewTemplateDetailed: vi.fn(() => new Promise((r) => { release = r; })) }); await open(o, true);
    byText(o.el, '.chips button', 'Con un conductor real').click(); await settle(o.f);
    expect(Array.from(o.el.querySelectorAll('#pv-driver option')).map((x) => x.textContent!.trim())).toEqual(['Selecciona un conductor…', '101 · Ana Pérez (T-1)']);
    expect(byText(o.el, 'button', 'Ver vista previa').disabled).toBe(true);
    const sel = o.el.querySelector('#pv-driver') as HTMLSelectElement; sel.value = 'a1'; sel.dispatchEvent(new Event('change')); await settle(o.f);
    const go = byText(o.el, 'button', 'Ver vista previa'); go.click(); o.f.detectChanges(); go.click();
    expect(o.a.previewTemplateDetailed).toHaveBeenCalledTimes(1); expect(go.getAttribute('data-busy-label')).toBe('Generando…');
    expect(o.a.previewTemplateDetailed).toHaveBeenCalledWith('a1', 'Hola {{nombre}}, {{detalle_deuda}}', undefined);
    release({ text: 'Hola Ana, debes $36.00', unresolved: ['deuda_semanal', 'xyz'] }); await settle(o.f);
    expect(o.el.querySelector('.wa-bubble')!.textContent).toBe('Hola Ana, debes $36.00');
    expect(o.el.querySelector('[role=alert]')!.textContent).toContain('Este mensaje no se enviaría: faltan datos para deuda_semanal, xyz.');
  });
  it('error de la vista previa en español', async () => {
    const o = await setup({ previewTemplateDetailed: vi.fn(async () => { throw new ApiError('assignment_not_found', 404); }) }); await open(o, true);
    byText(o.el, '.chips button', 'Con un conductor real').click(); await settle(o.f);
    (o.el.querySelector('#pv-driver') as HTMLSelectElement).value = 'a1'; (o.el.querySelector('#pv-driver') as HTMLSelectElement).dispatchEvent(new Event('change')); await settle(o.f);
    byText(o.el, 'button', 'Ver vista previa').click(); await settle(o.f);
    expect(o.el.querySelector('form [role=alert]')!.textContent).toContain('asignación');
  });
  it('plantilla antigua guardada: no se modifica sola; al abrirla muestra las aclaraciones de significado', async () => {
    const o = await setup({}, { listTemplates: vi.fn(async () => [{ id: 't9', name: 'Vieja', body: 'Hola {{nombre}}, hoy es {{fecha}}. Debe {{saldo_total}}' }]) }); await open(o, true);
    expect((o.el.querySelector('#tf-body') as HTMLTextAreaElement).value).toBe('Hola {{nombre}}, hoy es {{fecha}}. Debe {{saldo_total}}');
    const n = text(o.el.querySelector('#tf-warn')!);
    expect(n).toContain('equivale a {{nombre_completo}}'); expect(n).toContain('nombre_completo'); expect(n).toContain('fecha completa en español'); expect(n).toContain('último saldo válido importado');
    expect(o.d.saveTemplate).not.toHaveBeenCalled();
  });
  it('catálogo: skeleton al cargar y error con «Reintentar»', async () => {
    let n = 0;
    const o = await setup({ templateVariables: vi.fn(async () => { if (n++ === 0) throw new ApiError('internal_error', 500); return CATALOG; }) }); await open(o);
    expect(o.el.querySelector('.tpl-vars [role=alert], .tpl-vars app-error-state')).not.toBeNull();
    byText(o.el, '.tpl-vars button', 'Reintentar').click(); await settle(o.f);
    expect(o.el.querySelectorAll('.var-item').length).toBe(16);
    const h: { r?: (v: unknown) => void } = {};
    const p = await setup({ templateVariables: vi.fn(() => new Promise((r) => { h.r = r; })) }); await open(p);
    expect(p.el.querySelector('.tpl-vars app-loading')).not.toBeNull();
  });
  it('accesibilidad básica: aside etiquetado, buscador con label, variables como botones con nombre accesible, textarea descrito', async () => {
    const o = await setup(); await open(o);
    expect(o.el.querySelector('aside.tpl-vars')!.getAttribute('aria-labelledby')).toBe('vars-title');
    expect(o.el.querySelector('label[for=var-q]')).not.toBeNull();
    expect(o.el.querySelector('.var-item')!.getAttribute('aria-label')).toMatch(/^Insertar .+ \{\{.+\}\}$/);
    expect(o.el.querySelector('#tf-body')!.getAttribute('aria-describedby')).toContain('tf-count');
    expect(o.el.querySelector('[aria-label="Tipo de vista previa"]')).not.toBeNull();
  });
  it('móvil (390 px): los grupos son acordeón cerrado (se abren al buscar)', async () => {
    const o = await setup({}, {}, true); await open(o);
    const groups = Array.from(o.el.querySelectorAll<HTMLDetailsElement>('.var-group'));
    expect(groups.length).toBe(6); expect(groups.every((g) => !g.open)).toBe(true);
    typeInto(o.el, '#var-q', 'unidad'); await settle(o.f);
    expect(Array.from(o.el.querySelectorAll<HTMLDetailsElement>('.var-group')).every((g) => g.open)).toBe(true);
  });
  it('guardar y eliminar siguen funcionando', async () => {
    const o = await setup(); await open(o);
    typeInto(o.el, '#tf-name', 'Domingo'); typeInto(o.el, '#tf-body', 'Hola {{nombre}} {{saldo_total}}'); await settle(o.f);
    byText(o.el, 'button', 'Guardar plantilla').click(); await settle(o.f);
    expect(o.d.saveTemplate).toHaveBeenCalledWith({ name: 'Domingo', body: 'Hola {{nombre}} {{saldo_total}}' });
    byLabel(o.el, '', 'Eliminar plantilla').click(); await settle(o.f);
    expect(o.d.deleteTemplate).not.toHaveBeenCalled();
    byText(o.el, 'button', 'Sí, eliminar').click(); await settle(o.f);
    expect(o.d.deleteTemplate).toHaveBeenCalledWith('t1');
  });
  it('plantilla en uso por horarios: ofrece quitarla de esos horarios (quedan desactivados y sin plantilla) y eliminarla', async () => {
    const SC = (id: string, name: string) => ({ id, name, localTime: '22:00', weekdays: [1, 2, 3], templateId: 't1', templateName: 'T', audience: 'all', enabled: true, lastRunDate: null, lastRunStatus: null, lastRunCreated: null, lastRunTotal: null });
    // Con Supabase directo el error llega como objeto de PostgREST, no como ApiError (así lo vio la usuaria).
    const del = vi.fn().mockRejectedValueOnce({ message: 'template_in_use', code: '23503', where: 'message_templates' }).mockResolvedValueOnce(undefined);
    const save = vi.fn(async () => undefined);
    const o = await setup({ listSendSchedules: vi.fn(async () => [SC('s1', 'Primer recordatorio'), SC('s2', 'Último recordatorio'), SC('s3', 'Otro')]), saveSendSchedule: save, templateUsage: vi.fn(async () => [{ id: 's1', kind: 'debt_first', label: 'Primer recordatorio', localTime: '11:00', weekdays: [1], enabled: true }, { id: 's2', kind: 'debt_last', label: 'Último recordatorio', localTime: '21:00', weekdays: [1], enabled: false }]) },
      { deleteTemplate: del });
    byLabel(o.el, '', 'Eliminar plantilla').click(); await settle(o.f);
    byText(o.el, 'button', 'Sí, eliminar').click(); await settle(o.f);
    const dlg = o.el.querySelector('[role=alertdialog]')!;
    expect(text(dlg)).toContain('Primer recordatorio, Último recordatorio'); expect(text(dlg)).toContain('desactivados y sin plantilla');
    expect(save).not.toHaveBeenCalled();
    byText(o.el, 'button', 'Quitar de los horarios y eliminar').click(); await settle(o.f);
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ id: 's1', templateId: null, enabled: false }));
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ id: 's2', templateId: null, enabled: false }));
    expect(del).toHaveBeenCalledTimes(2);                                  // el 2.º intento ya no tiene horarios
    expect(text(o.el)).toContain('quedaron desactivados y sin plantilla');
  });
});

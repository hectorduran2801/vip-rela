import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { ApiService, AuthService, Breakpoints, DataService } from '../../core/services';
import type { CollectionRow } from '../../core/models';
import { FakeAuth, FakeBreakpoints, byText, fakeApi, fakeData, settle } from '../../testing/fakes';
import { Collection } from './collection';

const row = (o: Partial<CollectionRow> = {}): CollectionRow => ({ assignmentId: 'a1', driverId: 'd1', unitCode: 'T-1', operatorCode: '101', fullName: 'Ana Pérez', driverStatus: 'active', phone: '+50760000001', dailyRateCents: 3600,
  paidWeekCents: 1000, paidTodayCents: 0, pendingCents: 2600, creditCents: 0, previousPendingCents: 0, agreement: null, saldoSource: 'excel', saldoMissing: false, saldoWeek: '2026-11-23', ended: false, days: [{ date: '2026-11-23', dueCents: 3000, paidCents: 3000 }, { date: '2026-11-24', dueCents: 3000, paidCents: 2500 }, { date: '2026-11-25', dueCents: 0, paidCents: 0 }], totalCents: 10500, collectCommission: true, commissionCents: 0, messagesToday: [], ...o });
const ROWS = [row(), row({ assignmentId: 'a2', unitCode: 'T-2', operatorCode: '102', fullName: 'Luis Gómez', phone: '+50760000002', pendingCents: 0 }), row({ assignmentId: 'a3', unitCode: 'T-3', operatorCode: '103', fullName: 'Sin Teléfono', phone: null })];
const TPL = { id: 't1', name: 'Cobro', body: 'Hola {{nombre}}' };

async function setup(rows: CollectionRow[] = ROWS) {
  const api = fakeApi({
    collectionBoard: vi.fn(async () => rows), setCommission: vi.fn(async () => undefined), resolveCollectionMessages: vi.fn(async () => ({ resolved: 1 })), collectionLastSync: vi.fn(async () => ({ importId: 'i1', fileName: 'DATOS.xlsx', appliedAt: '2026-11-24T12:00:00Z' })),
    previewCollectionMessages: vi.fn(async (_id: string, ids: string[]) => ({ whatsappConnected: true, lastSync: { importId: 'i1', fileName: 'DATOS.xlsx', appliedAt: '2026-11-24T12:00:00Z' }, items: ids.map((assignmentId) => ({ assignmentId, unitCode: assignmentId, operatorCode: '1', fullName: 'X', phone: '+50760000001', text: `Mensaje para ${assignmentId}`, unresolved: [], reason: null, alreadySentAt: null })) })),
    sendCollectionMessages: vi.fn(async (b: { assignmentIds: string[] }) => ({ sent: b.assignmentIds.length, failed: 0, results: b.assignmentIds.map((assignmentId) => ({ assignmentId, ok: true })) })),
  });
  const data = fakeData({ listTemplates: vi.fn(async () => [TPL, { id: 't2', name: 'Otra', body: 'x' }]) });
  TestBed.configureTestingModule({ providers: [provideRouter([]), { provide: ApiService, useValue: api }, { provide: DataService, useValue: data },
    { provide: AuthService, useValue: new FakeAuth().login('admin') }, { provide: Breakpoints, useValue: new FakeBreakpoints() }] });
  const f = TestBed.createComponent(Collection); await settle(f);
  const el = f.nativeElement as HTMLElement;
  const boxes = () => Array.from(el.querySelectorAll('tbody input.cob-check')) as HTMLInputElement[];
  const check = async (i: number) => { boxes()[i]!.click(); await settle(f); };
  return { api, f, el, boxes, check };
}

describe('Cobranza', () => {
  it('muestra las unidades con WhatsApp y dinero', async () => {
    const { el } = await setup();
    expect(el.querySelectorAll('tbody tr').length).toBe(3);
    expect(el.textContent).toContain('Ana Pérez');
    expect(el.textContent).toContain('+507');
    expect(el.textContent).toContain('$26.00');
    expect(el.textContent).toContain('Sin WhatsApp');
  });
  it('la fila sin teléfono tiene la casilla deshabilitada', async () => {
    const { boxes } = await setup();
    expect(boxes()[2]!.disabled).toBe(true);
    expect(boxes()[0]!.disabled).toBe(false);
  });
  it('al seleccionar dos filas muestra «2 seleccionados»', async () => {
    const { el, check } = await setup();
    await check(0); await check(1);
    expect(el.querySelector('.cob-bar')!.textContent).toContain('2 seleccionados');
  });
  it('elige plantilla, previsualiza y confirma el envío una sola vez', async () => {
    const { api, f, el, check } = await setup();
    await check(0); await check(1);
    byText(el, 'button', 'Enviar mensaje…').click(); await settle(f);
    const sel = el.querySelector('#cob-tpl') as HTMLSelectElement;
    sel.value = 't1'; sel.dispatchEvent(new Event('change')); await settle(f);
    expect(api.previewCollectionMessages).toHaveBeenCalledWith('t1', ['a1', 'a2']);
    expect(el.textContent).toContain('Mensaje para a1');
    byText(el, 'button', 'Enviar 2 mensajes').click(); await settle(f);
    expect(api.sendCollectionMessages).toHaveBeenCalledTimes(1);
    expect(api.sendCollectionMessages).toHaveBeenCalledWith({ templateId: 't1', assignmentIds: ['a1', 'a2'], batchKey: expect.any(String), repeat: false });
    expect(el.textContent).toContain('2 mensaje(s) en cola');
  });
});

/** Control de mensajes SOLO del día actual: todos los mensajes de hoy por unidad, filtros de plantilla y selección de pendientes. */
describe('Cobranza · jornada diaria de mensajes', () => {
  const NOW = new Date().toISOString();
  const msg = (id: string, template: string, status = 'simulated', at = NOW) => ({ id, template, status, at, body: `Texto ${id}`, error: null });
  const BOARD = [
    row({ assignmentId: 'a1', unitCode: 'T-1', fullName: 'Ana Pérez', messagesToday: [msg('m1', 'Cobro'), msg('m2', 'Aviso'), msg('m3', 'Cobro', 'sent')] }),            // 3 mensajes hoy
    row({ assignmentId: 'a2', unitCode: 'T-2', fullName: 'Luis Gómez', phone: '+50760000002', messagesToday: [] }),                                                    // ninguno
    row({ assignmentId: 'a3', unitCode: 'T-3', fullName: 'Rosa Díaz', phone: '+50760000003', messagesToday: [msg('m4', 'Cobro', 'failed')] }),                           // fallido
    row({ assignmentId: 'a4', unitCode: 'T-4', fullName: 'Pedro Ruiz', phone: '+50760000004', messagesToday: [msg('m5', 'Cobro', 'prepared')] }),                        // en proceso
    row({ assignmentId: 'a5', unitCode: 'T-5', fullName: 'Desvinculado Uno', phone: '+50760000005', ended: true, messagesToday: [] }),
  ];
  async function mk() {
    const api = fakeApi({ collectionBoard: vi.fn(async () => BOARD), collectionLastSync: vi.fn(async () => null) });
    TestBed.configureTestingModule({ providers: [provideRouter([]), { provide: ApiService, useValue: api }, { provide: DataService, useValue: fakeData({ listTemplates: vi.fn(async () => [TPL, { id: 't2', name: 'Aviso', body: 'x' }]) }) },
      { provide: AuthService, useValue: new FakeAuth().login('admin') }, { provide: Breakpoints, useValue: new FakeBreakpoints() }] });
    const f = TestBed.createComponent(Collection); await settle(f);
    const el = f.nativeElement as HTMLElement;
    const units = () => Array.from(el.querySelectorAll('tbody tr td:nth-child(3)')).map((x) => x.textContent!.trim().replace(/Desvinculado/, '').trim());
    const chip = async (label: string) => { (Array.from(el.querySelectorAll('.chip')).find((c) => c.textContent!.trim() === label) as HTMLButtonElement).click(); await settle(f); };
    const pickTpl = async (id: string) => { const sel = el.querySelector('#cob-tpl-bar') as HTMLSelectElement; sel.value = id; sel.dispatchEvent(new Event('change')); await settle(f); };
    return { f, el, units, chip, pickTpl, api };
  }
  it('cada unidad lista TODOS los mensajes de hoy (no solo el último), con plantilla, hora, estado y cantidad', async () => {
    const { el } = await mk();
    const row1 = el.querySelector('tbody tr')!;
    expect(row1.textContent).toContain('3 mensajes hoy');
    expect(row1.querySelectorAll('.cob-today-row').length).toBe(3);
    expect(row1.textContent).toContain('«Cobro»'); expect(row1.textContent).toContain('«Aviso»');
  });
  it('«Ver mensajes» muestra el texto exacto de cada mensaje de hoy', async () => {
    const { f, el } = await mk();
    (el.querySelector('tbody tr button.link') as HTMLButtonElement).click(); await settle(f);
    const dlg = el.querySelector('[role=dialog]')!;
    expect(dlg.querySelectorAll('.cob-msg').length).toBe(3);
    expect(dlg.textContent).toContain('Texto m1'); expect(dlg.textContent).toContain('Texto m2'); expect(dlg.textContent).toContain('Texto m3');
  });
  it('filtros de mensajes: con/sin mensajes hoy, fallidos y en proceso', async () => {
    const { units, chip } = await mk();
    await chip('Sin mensajes hoy'); expect(units()).toEqual(['T-2', 'T-3']);                 // un mensaje FALLIDO no cuenta como enviado; la desvinculada está oculta
    await chip('Con mensajes hoy'); expect(units()).toEqual(['T-1', 'T-4']);                 // el fallido no cuenta como «recibido»
    await chip('Mensajes fallidos'); expect(units()).toEqual(['T-3']);
    await chip('Mensajes en proceso'); expect(units()).toEqual(['T-4']);
  });
  it('con la plantilla elegida: «con la plantilla enviada hoy» y «pendientes de la plantilla»', async () => {
    const { units, chip, pickTpl } = await mk();
    await pickTpl('t1');                                                                      // Cobro
    await chip('Con la plantilla enviada hoy'); expect(units()).toEqual(['T-1', 'T-4']);
    await chip('Pendientes de la plantilla'); expect(units()).toEqual(['T-2', 'T-3']);         // con WhatsApp, no desvinculados, sin Cobro vigente hoy (el fallido sí está pendiente)
  });
  it('«Seleccionar pendientes» respeta los filtros activos y nunca marca desvinculados', async () => {
    const { f, el, units, chip, pickTpl } = await mk();
    await pickTpl('t1');
    (Array.from(el.querySelectorAll('.filterbar .btn')).find((b) => b.textContent!.includes('Seleccionar pendientes de «Cobro»')) as HTMLButtonElement).click(); await settle(f);
    expect(el.querySelector('.cob-bar')!.textContent).toContain('2 seleccionados');          // T-2 y T-3 (T-5 está desvinculado; T-1 y T-4 ya recibieron Cobro)
    const sel = () => (Array.from(el.querySelectorAll('tbody tr')).filter((r) => (r.querySelector('input') as HTMLInputElement).checked).map((r) => r.querySelector('td:nth-child(3)')!.textContent!.trim()));
    expect(sel()).toEqual(['T-2', 'T-3']);
    await chip('Mensajes fallidos'); expect(units()).toEqual(['T-3']);
  });
  it('advierte cuando se selecciona a alguien que ya recibió la plantilla elegida y lo excluirá por defecto', async () => {
    const { f, el, pickTpl } = await mk();
    await pickTpl('t1');
    (el.querySelectorAll('tbody input.cob-check')[0] as HTMLInputElement).click(); await settle(f);          // T-1 ya recibió «Cobro» hoy
    expect(el.querySelector('.cob-bar')!.textContent).toContain('ya recibió hoy «Cobro»');
  });
  it('la unidad desvinculada muestra el aviso y no se puede seleccionar', async () => {
    const { el, f } = await mk();
    (el.querySelector('[aria-label="Semana anterior"]') as HTMLButtonElement).click(); await settle(f);
    const last = el.querySelectorAll('tbody tr')[4]!;
    expect(last.textContent).toContain('Desvinculado'); expect((last.querySelector('input') as HTMLInputElement).disabled).toBe(true);
  });
  it('cada fila se despliega con los días de la semana (informativo): cuota, lo que pagó y la diferencia', async () => {
    const o = await setup();
    const btn = o.el.querySelector<HTMLButtonElement>('button[aria-expanded]')!;
    expect(btn.getAttribute('aria-expanded')).toBe('false'); btn.click(); await settle(o.f);
    const t = o.el.querySelector('.wd-row')!.textContent!.replace(/\s+/g, ' ');
    expect(t).toContain('Lunes'); expect(t).toContain('Cuota'); expect(t).toContain('Diferencia'); expect(t).toContain('Al día'); expect(t).toContain('Faltan $5.00'); expect(t).toContain('Pagado'); expect(t).toContain('Debe hoy'); expect(t).toContain('$105.00');
  });
  it('columna Comisión +$1: activa por defecto; al quitar el check se guarda y se recarga', async () => {
    const o = await setup();
    const cm = o.el.querySelector<HTMLInputElement>('td.c-cm input')!;
    expect(cm.checked).toBe(true);
    cm.checked = false; cm.dispatchEvent(new Event('change')); await settle(o.f);
    expect(o.api.setCommission).toHaveBeenCalledWith('a1', false);
  });
  it('columna MENSAJE del Excel: los «sí» llegan marcados y los «no» sin marcar; lo cambiado a mano es temporal y se puede restaurar', async () => {
    const o = await setup([row({ assignmentId: 'a1', unitCode: 'T-1', sendByExcel: true }), row({ assignmentId: 'a2', unitCode: 'T-2', sendByExcel: false }), row({ assignmentId: 'a3', unitCode: 'T-3', sendByExcel: true, phone: null })]);
    expect(o.boxes().map((b) => b.checked)).toEqual([true, false, false]);
    await o.check(0); expect(o.boxes()[0]!.checked).toBe(false);
    await o.check(1); expect(o.boxes()[1]!.checked).toBe(true);
    [...o.el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent!.includes('Restaurar selección del Excel'))!.click(); await settle(o.f);
    expect(o.boxes().map((b) => b.checked)).toEqual([true, false, false]);
  });
  it('el aviso de varias unidades sale solo si un MISMO operario tiene 2+ en la selección, y dice cuáles; un teléfono compartido no basta', async () => {
    const open = async (rows: CollectionRow[]) => {
      TestBed.resetTestingModule();
      const o = await setup(rows);
      (o.api.previewCollectionMessages as any).mockImplementation(async (_t: string, ids: string[]) => ({ whatsappConnected: true, lastSync: null, items: ids.map((id) => { const r = rows.find((x) => x.assignmentId === id)!; return { assignmentId: id, unitCode: r.unitCode, operatorCode: r.operatorCode, fullName: r.fullName, phone: r.phone, text: 'hola', unresolved: [], reason: null, alreadySentAt: null }; }) }));
      for (let k = 0; k < rows.length; k++) await o.check(k);
      const c = o.f.componentInstance as any; c.openSend(); c.templateId.set('t1'); await c.loadPreview(); await settle(o.f);
      return (o.el.textContent + document.body.textContent!).replace(/\s+/g, ' ');
    };
    const distinct = await open([row({ assignmentId: 'a1', unitCode: 'P781', operatorCode: '1', phone: '+50760000001' }), row({ assignmentId: 'a2', unitCode: 'P831', operatorCode: '2', phone: '+50760000001' })]);
    expect(distinct).not.toContain('tienen varias unidades');
    const dup = await open([row({ assignmentId: 'a1', unitCode: 'P781', operatorCode: '15700', fullName: 'Ambrosio' }), row({ assignmentId: 'a2', unitCode: 'P831', operatorCode: '15700', fullName: 'Ambrosio' })]);
    expect(dup).toContain('15700 · Ambrosio: P781, P831');
  });
});

/** Una unidad desvinculada ya no está en el Excel: fuera de Cobranza. Su historial queda en la ficha y en las semanas pasadas. */
describe('Cobranza · desvinculados', () => {
  const BOARD = [row(), row({ assignmentId: 'a2', unitCode: 'P280', operatorCode: '10325', fullName: 'Ex Operario', ended: true, pendingCents: 19900, paidWeekCents: 500 })];
  const totals = (el: HTMLElement) => el.querySelector('.wk-totals')!.textContent!.replace(/\s+/g, ' ');
  it('en la semana actual no aparece ni cuenta en unidades, deudores o saldo; lo pagado en la semana sí (es dinero recibido)', async () => {
    const { el } = await setup(BOARD);
    expect(el.querySelectorAll('tbody tr').length).toBe(1);
    expect(el.textContent).not.toContain('Ex Operario');
    expect(totals(el)).toContain('Unidades con operario1'); expect(totals(el)).toContain('Con saldo pendiente1');
    expect(totals(el)).toContain('Saldo total (Excel)$26.00'); expect(totals(el)).toContain('Pagado en la semana$15.00');
  });
  it('al mirar una semana anterior sigue visible, marcado como desvinculado', async () => {
    const { el, f } = await setup(BOARD);
    (el.querySelector('[aria-label="Semana anterior"]') as HTMLButtonElement).click(); await settle(f);
    expect(el.querySelectorAll('tbody tr').length).toBe(2);
    expect(el.textContent).toContain('Desvinculado');
  });
});

/** Si un envío falla, se ofrece volver a enviarlo ahí mismo; si quedó «sin confirmar», quien administra lo resuelve tras mirar el chat. */
describe('Cobranza · reintentar lo que no salió', () => {
  const at = (h: number) => new Date(Date.now() - h * 60_000).toISOString();
  const msg = (id: string, status: string, minutesAgo = 5, template = 'Cobro') => ({ id, template, status, at: at(minutesAgo), body: 'x', error: null });
  const BOARD = [
    row({ assignmentId: 'a1', unitCode: 'T-1', messagesToday: [msg('m1', 'failed')] }),
    row({ assignmentId: 'a2', unitCode: 'T-2', phone: '+50760000002', messagesToday: [msg('m2', 'failed', 9)] }),
    row({ assignmentId: 'a3', unitCode: 'T-3', phone: '+50760000003', messagesToday: [msg('m3', 'failed', 9), msg('m4', 'sent', 2)] }),       // ya salió después
    row({ assignmentId: 'a4', unitCode: 'T-4', phone: '+50760000004', messagesToday: [msg('m5', 'unconfirmed')] }),
  ];
  async function mk() {
    const t = await setup(BOARD);
    return { ...t, box: () => t.el.querySelector('.cob-retry')?.textContent?.replace(/\s+/g, ' ').trim() ?? '' };
  }
  it('avisa cuántos no salieron y «Reintentar» abre la vista previa solo con ellos y su plantilla', async () => {
    const { el, f, api, box } = await mk();
    expect(box()).toContain('2 mensajes de «Cobro» no salieron');
    byText(el, '.cob-retry button', 'Reintentar 2').click(); await settle(f);
    expect(api.previewCollectionMessages).toHaveBeenCalledWith('t1', ['a1', 'a2']);
    expect(api.sendCollectionMessages).not.toHaveBeenCalled();                          // nada sale sin confirmar
  });
  it('sin confirmar: pide mirar el chat y, al confirmar que no llegó, lo marca y ofrece reintentar', async () => {
    const { el, f, api, box } = await mk();
    expect(box()).toContain('1 mensaje sin confirmar');
    byText(el, '.cob-retry button', 'No llegó').click(); await settle(f);
    expect(api.resolveCollectionMessages).not.toHaveBeenCalled();
    byText(el, '.cob-retry button', 'Sí, no llegó').click(); await settle(f);
    expect(api.resolveCollectionMessages).toHaveBeenCalledWith(['m5'], false);
  });
  it('sin fallos no ocupa sitio', async () => {
    expect((await setup([row()])).el.querySelector('.cob-retry')).toBeNull();
  });
});

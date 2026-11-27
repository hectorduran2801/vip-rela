import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { ApiError } from '../../core/errors';
import type { TestMessage, TestPreview } from '../../core/models';
import { ApiService, DataService, NEW_KEY } from '../../core/services';
import { routes } from '../../app.routes';
import { superGuard } from '../../core/guards';
import { AuthService } from '../../core/services';
import { byLabel, FakeAuth, waSession, byText, fakeApi, fakeData, settle, typeInto } from '../../testing/fakes';
import { WhatsappTest } from './whatsapp-test';

const PREVIEW = (o: Partial<TestPreview> = {}): TestPreview => ({ recipient: '+50760001234', invalidPhone: false, recipientIsADriver: false, body: 'Hola', chars: 4, sender: '+50761112222', sessionStatus: 'connected', sendingMode: 'test', realTestEnabled: false, ...o });
const MSG = (o: Partial<TestMessage> = {}): TestMessage => ({ id: 'm1', kind: 'test', recipientPhone: '+50760001234', body: 'Hola', requestedMode: 'simulated', status: 'simulated', senderPhone: null, providerMessageId: null, error: null,
  recipientAuthorization: null, createdAt: '2026-11-16T15:00:00Z', processedAt: null, deliveredAt: null,
  authorizedBy: null, claimedAt: null, errorDetail: null, resolvedBy: null, resolvedAt: null, resolutionNote: null, ...o });

async function mk(api: Record<string, unknown> = {}) {
  let n = 0;
  const a = fakeApi({ whatsappSession: vi.fn(async () => waSession({ status: 'connected' })), whatsappTestList: vi.fn(async () => []), whatsappTestPreview: vi.fn(async () => PREVIEW()), whatsappTestSend: vi.fn(async () => MSG()), ...api });
  TestBed.configureTestingModule({ providers: [provideRouter([]), { provide: AuthService, useValue: new FakeAuth().login('super_admin') }, { provide: ApiService, useValue: a },
    { provide: DataService, useValue: fakeData() }, { provide: NEW_KEY, useValue: () => `key-${++n}-abcdefgh` }] });
  const f = TestBed.createComponent(WhatsappTest);
  const el = f.nativeElement as HTMLElement;
  await settle(f);
  const preview = async (phone = '6000-1234', body = 'Hola') => { typeInto(el, '#wt-phone', phone); typeInto(el, '#wt-body', body); f.detectChanges(); byText(el, 'button', 'Vista previa').click(); await settle(f); };
  return { f, el, a: a as unknown as Record<string, ReturnType<typeof vi.fn>>, preview };
}
const sendBtn = (el: HTMLElement) => byText(el, 'button', 'Enviar mensaje de prueba');

describe('Ruta de mensajes de prueba', () => {
  it('lleva superGuard y cuelga de /messages/whatsapp/test', () => {
    const kids = routes.find((r) => r.path === '')!.children!.find((r) => r.path === 'messages')!.children!;
    expect(kids.find((r) => r.path === 'whatsapp/test')!.canActivate).toEqual([superGuard]);
  });
  it('superGuard: SUPER_ADMIN pasa; ADMIN va a /dashboard', async () => {
    for (const [role, ok] of [['super_admin', true], ['admin', false]] as const) {
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({ providers: [provideRouter([]), { provide: AuthService, useValue: new FakeAuth().login(role) }] });
      const r = await TestBed.runInInjectionContext(() => superGuard({} as never, {} as never));
      expect(r === true, role).toBe(ok);
    }
  });
});

describe('Mensaje de prueba · vista previa y bloqueos', () => {
  it('contador /1000 y vista previa con destinatario, emisor, modo y contenido', async () => {
    const { f, el, a, preview } = await mk();
    typeInto(el, '#wt-body', 'Hola'); f.detectChanges(); expect(el.textContent).toContain('4/1000');
    await preview();
    expect(a['whatsappTestPreview']).toHaveBeenCalledWith('6000-1234', 'Hola');
    const t = el.textContent!.replace(/\s+/g, ' ');
    expect(t).toContain('+507 6000 1234'); expect(t).toContain('+507 6111 2222'); expect(t).toContain('Simulado'); expect(t).toContain('Hola');
  });
  it('número inválido: aviso y sin botón de enviar', async () => {
    const { el, preview } = await mk({ whatsappTestPreview: vi.fn(async () => PREVIEW({ recipient: null, invalidPhone: true })) });
    await preview('abc');
    expect(el.querySelector('[role=alert]')!.textContent).toContain('no es válido');
    expect(sendBtn(el)).toBeUndefined();
  });
  it('número de un conductor: bloqueado', async () => {
    const { el, preview, a } = await mk({ whatsappTestPreview: vi.fn(async () => PREVIEW({ recipientIsADriver: true })) });
    await preview();
    expect(el.textContent).toContain('pertenece a un conductor');
    expect(sendBtn(el)).toBeUndefined();
    expect(a['whatsappTestSend']).not.toHaveBeenCalled();
  });
  it('si cambian número o texto tras la vista previa, hay que repetirla', async () => {
    const { f, el, preview } = await mk();
    await preview(); typeInto(el, '#wt-body', 'Otro'); f.detectChanges();
    expect(sendBtn(el).disabled).toBe(true);
    expect(el.textContent).toContain('vuelve a pulsar «Vista previa»');
  });
});

describe('Mensaje de prueba · simulado, idempotencia y real', () => {
  it('simulado por defecto: envía con modo simulated, kind test y clave generada', async () => {
    const { f, el, a, preview } = await mk();
    await preview(); sendBtn(el).click(); await settle(f);
    expect(a['whatsappTestSend']).toHaveBeenCalledTimes(1);
    expect(a['whatsappTestSend']!.mock.calls[0]![0]).toEqual({ phone: '6000-1234', body: 'Hola', mode: 'simulated', idempotencyKey: 'key-1-abcdefgh', kind: 'test' });
    expect(el.textContent).toContain('no se envió nada');
  });
  it('doble clic = UNA sola llamada', async () => {
    let release!: (m: TestMessage) => void;
    const { f, el, a, preview } = await mk({ whatsappTestSend: vi.fn(() => new Promise<TestMessage>((r) => { release = r; })) });
    await preview(); const b = sendBtn(el); b.click(); b.click(); f.detectChanges();
    expect(a['whatsappTestSend']).toHaveBeenCalledTimes(1);
    release(MSG()); await settle(f);
  });
  it('modo de pruebas (real_test_enabled=false): SIN selector de modo ni casillas; se envía simulado', async () => {
    const { f, el, a, preview } = await mk();
    await preview();
    expect(el.querySelector('input[value=real]')).toBeNull();
    expect(el.querySelector('fieldset.wt-mode')).toBeNull();
    expect(el.querySelector('#wt-own')).toBeNull();
    expect(el.querySelector('#wt-auth, #wt-l4')).toBeNull();
    sendBtn(el).click(); await settle(f);
    expect(a['whatsappTestSend']!.mock.calls[0]![0]).toMatchObject({ mode: 'simulated' });
  });
  it('real (solo con real_test_enabled): UNA casilla + confirmación final; envía recipientAuthorization fijo y sin confirmLast4', async () => {
    const { f, el, a, preview } = await mk({ whatsappTestPreview: vi.fn(async () => PREVIEW({ realTestEnabled: true })), whatsappTestSend: vi.fn(async () => MSG({ requestedMode: 'real', status: 'prepared' })) });
    await preview();
    const real = el.querySelector<HTMLInputElement>('input[value=real]')!; expect(real.disabled).toBe(false);
    real.click(); real.dispatchEvent(new Event('change')); f.detectChanges();
    expect(el.querySelector('#wt-l4')).toBeNull(); expect(el.querySelector('#wt-auth')).toBeNull();
    const go = () => byText(el, 'button', 'Continuar');
    expect(go().disabled).toBe(true);
    el.querySelector<HTMLInputElement>('#wt-own')!.click(); f.detectChanges(); expect(go().disabled).toBe(false);
    go().click(); f.detectChanges();
    expect(a['whatsappTestSend']).not.toHaveBeenCalled();
    const confirm = byText(el, 'button', 'Confirmar envío de UN mensaje a +507…1234');
    expect(confirm).toBeTruthy();
    confirm.click(); confirm.click(); await settle(f);
    expect(a['whatsappTestSend']).toHaveBeenCalledTimes(1);
    const req = a['whatsappTestSend']!.mock.calls[0]![0];
    expect(req).toMatchObject({ mode: 'real', recipientAuthorization: 'Confirmado por admin@example.test en pantalla' });
    expect(req).not.toHaveProperty('confirmLast4');
  });
  it('errores de negocio en español', async () => {
    for (const [code, text] of [['real_test_already_pending', 'envío real de prueba pendiente'], ['confirm_last4_mismatch', 'últimos 4 dígitos'], ['recipient_authorization_required', 'quién autoriza'], ['recipient_is_a_driver', 'conductor'], ['invalid_phone', 'no es válido']] as const) {
      TestBed.resetTestingModule();
      const { f, el, preview } = await mk({ whatsappTestSend: vi.fn(async () => { throw new ApiError(code, 409); }) });
      await preview(); sendBtn(el).click(); await settle(f);
      expect(el.querySelector('[role=alert]')!.textContent!.toLowerCase(), code).toContain(text.toLowerCase());
    }
  });
});

describe('Mensaje de prueba · historial', () => {
  it('rótulos por estado; «sent» nunca dice entregado; solo delivered dice Entregado; sin errores técnicos largos en la lista', async () => {
    const list = (['prepared', 'processing', 'simulated', 'sent', 'delivered', 'failed', 'unconfirmed', 'cancelled'] as const).map((status, i) => MSG({ id: `m${i}`, status, requestedMode: status === 'simulated' ? 'simulated' : 'real', error: status === 'failed' ? 'timeout de OpenWA' : null, errorDetail: status === 'failed' ? 'Error: ETIMEDOUT\n at foo' : null }));
    const { el } = await mk({ whatsappTestList: vi.fn(async () => list) });
    const chips = Array.from(el.querySelectorAll('.wt-list li .wt-li-head .chip-s')).map((c) => c.textContent!.trim());
    expect(chips.sort()).toEqual(['Cancelado', 'Enviado al proveedor', 'Enviando', 'Entregado', 'Fallido (confirmado)', 'Preparado / En cola', 'Resultado sin confirmar', 'Simulado'].sort());
    expect(el.querySelector('.wt-list')!.textContent).not.toContain('timeout de OpenWA');
    const sent = Array.from(el.querySelectorAll('.wt-list li')).find((li) => li.textContent!.includes('Enviado al proveedor'))!;
    expect(sent.textContent!.toLowerCase()).not.toContain('entregado');
    const withWord = Array.from(el.querySelectorAll('.wt-list li')).filter((li) => /Entregado/.test(li.querySelector('.chip-s')!.textContent!));
    expect(withWord.length).toBe(1);
  });
  it('colores: ámbar para «sin confirmar» y en curso, rojo SOLO para fallido, verde para simulado/enviado/entregado', async () => {
    const mkli = (status: string) => MSG({ id: status, status: status as never, requestedMode: status === 'simulated' ? 'simulated' : 'real' });
    const { el } = await mk({ whatsappTestList: vi.fn(async () => ['unconfirmed', 'failed', 'sent', 'delivered', 'simulated', 'processing'].map(mkli)) });
    const cls = (txt: string) => Array.from(el.querySelectorAll('.wt-li-head .chip-s')).find((c) => c.textContent!.includes(txt))!.className;
    expect(cls('sin confirmar')).toContain('attn'); expect(cls('sin confirmar')).not.toContain('pending');
    expect(cls('Fallido')).toContain('pending');
    for (const t of ['Enviado al proveedor', 'Entregado', 'Simulado']) expect(cls(t)).toContain('paid');
    expect(cls('Enviando')).toContain('attn');
  });
  it('separa visualmente Reales y Simulados con su conteo', async () => {
    const { el } = await mk({ whatsappTestList: vi.fn(async () => [MSG({ id: 'r1', requestedMode: 'real', status: 'sent' }), MSG({ id: 's1', requestedMode: 'simulated', status: 'simulated' }), MSG({ id: 's2', requestedMode: 'simulated', status: 'simulated' })]) });
    const heads = Array.from(el.querySelectorAll('.wt-group')).map((h) => h.textContent!.replace(/\s+/g, ' ').trim());
    expect(heads).toEqual(['Reales (1)', 'Simulados (no se envió nada) (2)']);
    expect(el.querySelectorAll('[aria-labelledby=wt-g-real] li').length).toBe(1);
    expect(el.querySelectorAll('[aria-labelledby=wt-g-sim] li').length).toBe(2);
  });
  it('fila compacta: fecha y hora 12 h, destinatario formateado, emisor e id del proveedor', async () => {
    const { el } = await mk({ whatsappTestList: vi.fn(async () => [MSG({ requestedMode: 'real', status: 'sent', senderPhone: '+50761112222', providerMessageId: 'prov-123' })]) });
    const head = el.querySelector('.wt-li-head')!.textContent!;
    expect(head).toMatch(/\d{2}\/\d{2}\/\d{4} \d{1,2}:\d{2} (AM|PM)/);
    expect(head).toContain('+507 6000 1234');
    expect(head).toContain('desde +507 6111 2222');
    expect(head).toContain('id prov-123');
  });
  it('«Detalle» abre un panel plegable con operación, modo, autorización, tiempos y error técnico en bloque monoespaciado plegado; resolución si existe', async () => {
    const m = MSG({ id: 'op-9', requestedMode: 'real', status: 'failed', authorizedBy: 'user-7', recipientAuthorization: 'Ana, dueña del número', claimedAt: '2026-11-16T15:00:05Z', processedAt: '2026-11-16T15:00:09Z',
      error: 'timeout de OpenWA', errorDetail: 'Error: ETIMEDOUT\n at foo', resolvedAt: '2026-11-16T16:00:00Z', resolvedBy: 'user-7', resolutionNote: 'No apareció en el chat' });
    const { f, el } = await mk({ whatsappTestList: vi.fn(async () => [m]) });
    expect(el.querySelector('[role=region]')).toBeNull();
    const btn = byLabel(el, '.wt-list', 'Ver detalle del mensaje');
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    btn.click(); await settle(f);
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    const t = el.querySelector('[role=region]')!.textContent!.replace(/\s+/g, ' ');
    for (const s of ['op-9', 'Real', 'user-7', 'Ana, dueña del número', 'Creado', 'Reclamado', 'Procesado', 'No apareció en el chat']) expect(t).toContain(s);
    const det = el.querySelector('[role=region] details') as HTMLDetailsElement;
    expect(det.open).toBe(false);
    expect(Array.from(det.querySelectorAll('pre.wt-pre')).map((x) => x.textContent).join(' ')).toContain('ETIMEDOUT');
    btn.click(); await settle(f);
    expect(el.querySelector('[role=region]')).toBeNull();
  });
  it('«sin confirmar»: aviso ámbar con «Sí llegó» / «No llegó», nota opcional y confirmación; llama a /resolve y recarga', async () => {
    let status: 'unconfirmed' | 'sent' = 'unconfirmed';
    const resolve = vi.fn(async () => { status = 'sent'; return MSG({ status: 'sent' }); });
    const list = vi.fn(async () => [MSG({ requestedMode: 'real', status })]);
    const { f, el } = await mk({ whatsappTestList: list, whatsappTestResolve: resolve });
    expect(el.querySelector('.wa-line.warn')!.textContent).toContain('WhatsApp pudo haber aceptado este mensaje. Revisa el chat del destinatario antes de reintentar');
    byText(el, '.wa-line button', 'Sí llegó').click(); await settle(f);
    expect(resolve).not.toHaveBeenCalled();
    typeInto(el, '[role=alertdialog] input', 'Lo vi en el chat'); await settle(f);
    byText(el, '[role=alertdialog] button', 'Confirmar').click(); await settle(f);
    expect(resolve).toHaveBeenCalledWith('m1', true, 'Lo vi en el chat');
    expect(el.querySelector('.wa-line.warn')).toBeNull();
    expect(el.querySelector('.wt-li-head .chip-s')!.textContent).toContain('Enviado al proveedor');
  });
  it('«No llegó» envía arrived=false; un error del servidor se muestra en español', async () => {
    const resolve = vi.fn(async () => { throw new ApiError('not_unconfirmed', 409); });
    const { f, el } = await mk({ whatsappTestList: vi.fn(async () => [MSG({ requestedMode: 'real', status: 'unconfirmed' })]), whatsappTestResolve: resolve });
    byText(el, '.wa-line button', 'No llegó').click(); await settle(f);
    byText(el, '[role=alertdialog] button', 'Confirmar').click(); await settle(f);
    expect(resolve).toHaveBeenCalledWith('m1', false, '');
    expect(el.querySelector('[role=alert]')!.textContent).toContain('ya no está pendiente de confirmar');
  });
  it('con un REAL sin confirmar el envío real queda deshabilitado con el motivo; el simulado sigue disponible', async () => {
    const { f, el, preview } = await mk({ whatsappTestPreview: vi.fn(async () => PREVIEW({ realTestEnabled: true })), whatsappTestList: vi.fn(async () => [MSG({ requestedMode: 'real', status: 'unconfirmed' })]) });
    await preview();
    expect((el.querySelector('input[value=real]') as HTMLInputElement).disabled).toBe(true);
    expect(el.querySelector('#wt-real-blocked')!.textContent).toContain('Hay un envío real sin confirmar; revísalo antes de enviar otro');
    expect(sendBtn(el).disabled).toBe(false);
    void f;
  });
  it('un unconfirmed SIMULADO o ya resuelto no bloquea el real', async () => {
    const { el, preview } = await mk({ whatsappTestPreview: vi.fn(async () => PREVIEW({ realTestEnabled: true })), whatsappTestList: vi.fn(async () => [MSG({ requestedMode: 'real', status: 'sent' })]) });
    await preview();
    expect((el.querySelector('input[value=real]') as HTMLInputElement).disabled).toBe(false);
    expect(el.querySelector('#wt-real-blocked')).toBeNull();
  });
  it('unconfirmed_result_pending (409) del servidor se muestra en español y el doble clic en «Registrar envío» no duplica', async () => {
    const send = vi.fn(async () => { throw new ApiError('unconfirmed_result_pending', 409); });
    const { f, el, preview } = await mk({ whatsappTestSend: send });
    await preview();
    sendBtn(el).click(); sendBtn(el).click(); await settle(f);
    expect(send).toHaveBeenCalledTimes(1);
    expect(el.querySelector('[role=alert]')!.textContent).toContain('Hay un envío real sin confirmar');
  });
  it('cancelar un mensaje preparado', async () => {
    const cancel = vi.fn(async () => MSG({ status: 'cancelled' }));
    const { f, el } = await mk({ whatsappTestList: vi.fn(async () => [MSG({ status: 'prepared' })]), whatsappTestCancel: cancel });
    byText(el, '.wt-list button', 'Cancelar').click(); await settle(f);
    expect(cancel).toHaveBeenCalledWith('m1');
  });
  it('refresca mientras haya prepared/processing y deja de hacerlo al terminar', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let status: TestMessage['status'] = 'processing';
      const list = vi.fn(async () => [MSG({ status })]);
      TestBed.configureTestingModule({ providers: [provideRouter([]), { provide: AuthService, useValue: new FakeAuth().login('super_admin') }, { provide: ApiService, useValue: fakeApi({ whatsappTestList: list, whatsappSession: vi.fn(async () => waSession({ status: 'connected' })) }) }, { provide: DataService, useValue: fakeData() }] });
      const f = TestBed.createComponent(WhatsappTest); f.detectChanges(); await vi.advanceTimersByTimeAsync(0);
      expect(list).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(4100); expect(list).toHaveBeenCalledTimes(2);
      status = 'sent'; await vi.advanceTimersByTimeAsync(4100); expect(list).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(20000); expect(list).toHaveBeenCalledTimes(3);
    } finally { vi.useRealTimers(); }
  });
});

describe('Mensaje de prueba · sesión no operativa', () => {
  it.each([
    [{ status: 'disconnected' as const }, 'Conecta WhatsApp para habilitar el envío de mensajes'],
    [{ status: 'connected' as const, workerOnline: false }, 'El servicio de WhatsApp no está disponible'],
  ])('formulario deshabilitado con UN solo aviso (%j)', async (o, text) => {
    const { el } = await mk({ whatsappSession: vi.fn(async () => waSession(o)) });
    expect(el.querySelector('fieldset.wt-fs')!.hasAttribute('disabled')).toBe(true);
    const gates = el.querySelectorAll('.wa-gate');
    expect(gates.length).toBe(1);
    expect(gates[0]!.textContent).toContain(text);
    expect(gates[0]!.getAttribute('role')).toBe('status');
    expect((el.querySelector('#wt-phone') as HTMLInputElement).matches(':disabled')).toBe(true);
  });
  it('conectada con envío real desactivado: el formulario SIMULADO sigue habilitado y no hay aviso de desconexión', async () => {
    const { el } = await mk({ whatsappSession: vi.fn(async () => waSession({ status: 'connected', sendingMode: 'test', realTestEnabled: false })) });
    expect(el.querySelector('fieldset.wt-fs')!.hasAttribute('disabled')).toBe(false);
    expect(el.querySelector('#wt-off')).toBeNull();
  });
  it('conectado y con servicio activo el formulario está habilitado', async () => {
    const { el } = await mk();
    expect(el.querySelector('fieldset.wt-fs')!.hasAttribute('disabled')).toBe(false);
    expect(el.querySelector('#wt-off')).toBeNull();
  });
});

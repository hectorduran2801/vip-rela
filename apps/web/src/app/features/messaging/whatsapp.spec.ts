import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { ApiError } from '../../core/errors';
import type { WhatsappRequestResult, WhatsappSession } from '../../core/models';
import { ApiService, AuthService } from '../../core/services';
import { FakeAuth, byText, fakeApi, waSession } from '../../testing/fakes';
import { Whatsapp } from './whatsapp';

const S = waSession;
const R = (o: Partial<WhatsappSession> = {}): WhatsappRequestResult => ({ ...S(o), requested: true });

/** Dobles de las interfaces (ApiService/AuthService); temporizadores falsos: ningún sondeo real. */
async function mk(initial: WhatsappSession | (() => WhatsappSession), extra: Record<string, unknown> = {}, role: 'admin' | 'super_admin' = 'admin') {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(new Date('2026-11-16T15:00:30Z'));
  const get = vi.fn(async () => (typeof initial === 'function' ? initial() : initial));
  TestBed.configureTestingModule({ providers: [provideRouter([]), { provide: ApiService, useValue: fakeApi({ whatsappSession: get, ...extra }) }, { provide: AuthService, useValue: new FakeAuth().login(role) }] });
  const f = TestBed.createComponent(Whatsapp);
  const el = f.nativeElement as HTMLElement;
  const tick = async (ms = 0) => { await vi.advanceTimersByTimeAsync(ms); f.detectChanges(); await vi.advanceTimersByTimeAsync(0); f.detectChanges(); };
  await tick(0);
  return { f, el, get, tick };
}
const until = async (tick: (ms?: number) => Promise<void>, cond: () => boolean) => { for (let i = 0; i < 100 && !cond(); i++) { await new Promise((r) => globalThis.setImmediate?.(r) ?? r(null)); await tick(10); } };
beforeAll(async () => { await import('qrcode'); });
afterEach(() => { vi.useRealTimers(); });
const buttons = (el: HTMLElement) => Array.from(el.querySelectorAll('.wa-actions button')).map((b) => b.textContent!.trim());

describe('Pantalla de WhatsApp · botones según el estado real', () => {
  it.each([
    ['disconnected', ['Conectar WhatsApp']], ['starting', ['Cancelar']], ['qr_pending', ['Cancelar']], ['connecting', ['Cancelar']], ['awaiting_scan', ['Cancelar']],
    ['connected', ['Desconectar', 'Cerrar sesión']], ['failed', ['Reintentar']],
  ] as const)('estado %s → %j', async (status, expected) => {
    const { el } = await mk(S({ status, phoneNumber: '+50760000001', lastError: 'x', qrData: status === 'awaiting_scan' ? 'abc' : null }));
    expect(buttons(el)).toEqual(expected);
  });
  it('ADMIN y SUPER_ADMIN gestionan; el enlace de prueba solo lo ve SUPER_ADMIN', async () => {
    expect((await mk(S({ status: 'connected' }), {}, 'admin')).el.querySelector('a[href$="/whatsapp/test"]')).toBeNull();
    TestBed.resetTestingModule(); vi.useRealTimers();
    const sa = await mk(S({ status: 'connected' }), {}, 'super_admin');
    expect(buttons(sa.el)).toContain('Desconectar');
    expect(sa.el.querySelector('a[href$="/whatsapp/test"]')).not.toBeNull();
  });
  it('muestra número formateado, última conexión en 12 h, sesión cifrada y reconexión automática', async () => {
    const { el } = await mk(S({ status: 'connected', phoneNumber: '+50760000001', lastSeenAt: '2026-11-16T14:05:00Z', sessionPersisted: true }));
    expect(el.textContent).toContain('+507 6000 0001');
    expect(el.textContent).toContain('Última conexión');
    expect(el.textContent).toContain('16/11/2026 9:05 AM');
    expect(el.querySelector('.wa-facts')!.textContent).toMatch(/Sesión persistente\s*Cifrada/);
    expect(el.querySelector('.wa-facts')!.textContent).toMatch(/Reconexión automática\s*Habilitada/);
  });
  it('«Cerrar sesión» solo aparece si hay algo que cerrar; «Conectar WhatsApp» siempre que esté desconectado', async () => {
    const none = await mk(S({ status: 'disconnected', sessionPersisted: false }));
    expect(byText(none.el, 'button', 'Cerrar sesión')).toBeUndefined();
    TestBed.resetTestingModule(); vi.useRealTimers();
    const saved = await mk(S({ status: 'disconnected', sessionPersisted: true }));
    expect(byText(saved.el, 'button', 'Cerrar sesión')).toBeDefined(); expect(byText(saved.el, 'button', 'Conectar WhatsApp')).toBeDefined();
    expect(saved.el.querySelector('.wa-facts')!.textContent).toMatch(/Última conexión\s*Nunca/);
  });
  it('failed: muestra last_error real', async () => {
    const { el } = await mk(S({ status: 'failed', lastError: 'Sesión cerrada desde el teléfono' }));
    expect(el.textContent).toContain('Sesión cerrada desde el teléfono');
  });
  it('worker apagado: UN aviso compacto «WhatsApp no disponible» sin comandos, con Reintentar y detalle técnico plegado', async () => {
    const { el } = await mk(S({ status: 'disconnected', desiredState: 'connected', workerOnline: false, sendingMode: 'unknown' }));
    const w = el.querySelector('#wa-worker')!;
    expect(w.textContent).toContain('WhatsApp no disponible');
    expect(w.textContent).toContain('El servicio de WhatsApp no responde. Estamos intentando recuperarlo; si persiste, avisa a soporte');
    expect(el.textContent).not.toMatch(/pnpm|dev:worker/);
    expect(el.querySelectorAll('.wa-line').length).toBe(1);
    expect(byText(el as HTMLElement, '.wa-line button', 'Reintentar')).toBeDefined();
    expect((w.querySelector('details.tech') as HTMLDetailsElement).open).toBe(false);
    expect(el.querySelector('.wa-badge')!.textContent).toContain('WhatsApp no disponible');
  });
  it('estado de conexión, del servicio y del envío real se muestran por separado', async () => {
    const off = await mk(S({ status: 'connected', workerOnline: false }));
    expect(off.el.querySelector('.wa-facts')!.textContent).toMatch(/Modo de envío\s*Desconocido/);
    expect(off.el.querySelector('.wa-badge')!.textContent).not.toContain('Desconectado');
    TestBed.resetTestingModule(); vi.useRealTimers();
    const dis = await mk(S({ status: 'disconnected' }));
    expect(dis.el.querySelector('.wa-badge')!.textContent).toContain('Desconectado');
    expect(dis.el.querySelector('.wa-line')).toBeNull();   // desconectado NO es «no disponible»
  });
});

describe('Pantalla de WhatsApp · conectado ≠ envío real', () => {
  it('conectado con envíos en prueba: modo «Simulación» y la frase aclaratoria', async () => {
    const { el } = await mk(S({ status: 'connected', sendingMode: 'test' }));
    expect(el.querySelector('.wa-badge')!.textContent).toContain('WhatsApp conectado · Envíos en prueba');
    expect(el.textContent).toMatch(/Modo de envío\s*Simulación/);
    expect(el.textContent).toContain('WhatsApp puede estar conectado y aun así los envíos reales estar desactivados');
  });
  it('envíos reales: «Real»; modo desconocido: «Desconocido»', async () => {
    expect((await mk(S({ status: 'connected', sendingMode: 'real' }))).el.querySelector('.wa-facts')!.textContent).toMatch(/Modo de envío\s*Real/);
    TestBed.resetTestingModule(); vi.useRealTimers();
    const u = await mk(S({ status: 'connected', sendingMode: 'unknown' }));
    expect(u.el.textContent).toMatch(/Modo de envío\s*Desconocido/);
  });
});

describe('Pantalla de WhatsApp · QR', () => {
  const scan = { status: 'awaiting_scan', desiredState: 'connected', qrData: '2@abc,def==', qrExpiresAt: '2026-11-16T15:01:00Z' } as const;
  it('se dibuja solo en awaiting_scan para ADMIN+, con instrucciones y cuenta atrás; no se registra en consola', async () => {
    const spies = (['log', 'info', 'warn', 'debug'] as const).map((k) => vi.spyOn(console, k));
    const { el, tick } = await mk(S(scan));
    await until(tick, () => !!el.querySelector('img'));
    expect(el.querySelector('img[alt^="Código QR"]')!.getAttribute('src')).toMatch(/^data:image\/png;base64,/);
    expect(el.textContent).toContain('Dispositivos vinculados');
    expect(el.textContent).toMatch(/Vence en \d+ s/);
    await tick(40000);
    expect(el.textContent).toContain('Venció; se está renovando');
    for (const sp of spies) expect(sp).not.toHaveBeenCalledWith(expect.stringContaining('2@abc'));
  });
  it('sin QR en ningún otro estado', async () => {
    for (const status of ['disconnected', 'starting', 'qr_pending', 'connecting', 'connected', 'failed'] as const) {
      TestBed.resetTestingModule(); vi.useRealTimers();
      expect((await mk(S({ status, qrData: null }))).el.querySelector('img'), status).toBeNull();
    }
  });
  it('si la API no manda el QR (rol sin permiso), no hay imagen', async () => {
    const { el, tick } = await mk(S({ ...scan, qrData: null, qrExpiresAt: null }));
    await tick(50); expect(el.querySelector('img')).toBeNull();
  });
  it('aparece solo al pasar de starting a awaiting_scan (sondeo rápido)', async () => {
    const seq = [S({ status: 'starting', desiredState: 'connected' }), S(scan)]; let i = 0;
    const { el, tick } = await mk(() => seq[Math.min(i++, 1)]!);
    expect(el.querySelector('img')).toBeNull();
    await tick(5500); await until(tick, () => !!el.querySelector('img'));
    expect(el.querySelector('img')).not.toBeNull();
  });
});

describe('Pantalla de WhatsApp · acciones', () => {
  it('conectar: «solicitado» no es conectado y el doble clic hace una sola solicitud', async () => {
    const connect = vi.fn(() => new Promise<WhatsappRequestResult>(() => undefined));
    const { el, tick } = await mk(S(), { whatsappConnect: connect });
    const b = byText(el, 'button', 'Conectar WhatsApp'); b.click(); b.click(); await tick(0);
    expect(connect).toHaveBeenCalledTimes(1);
  });
  it('tras conectar refleja lo que devuelve la API', async () => {
    const connect = vi.fn(async () => R({ status: 'starting', desiredState: 'connected' }));
    const { el, tick } = await mk(S(), { whatsappConnect: connect });
    byText(el, 'button', 'Conectar WhatsApp').click(); await tick(0);
    expect(el.querySelector('.wa-badge')!.textContent).toContain('Conectando WhatsApp');
    expect(buttons(el)).toEqual(['Cancelar']);
  });
  it('Cancelar desconecta sin confirmación', async () => {
    const disc = vi.fn(async () => R({ status: 'disconnected' }));
    const { el, tick } = await mk(S({ status: 'connecting', desiredState: 'connected' }), { whatsappDisconnect: disc });
    byText(el, 'button', 'Cancelar').click(); await tick(0);
    expect(disc).toHaveBeenCalledTimes(1);
  });
  it('Reintentar vuelve a pedir conectar', async () => {
    const connect = vi.fn(async () => R({ status: 'starting', desiredState: 'connected' }));
    const { el, tick } = await mk(S({ status: 'failed', lastError: 'x' }), { whatsappConnect: connect });
    byText(el, 'button', 'Reintentar').click(); await tick(0);
    expect(connect).toHaveBeenCalledTimes(1);
  });
  it('Desconectar pide confirmación accesible (la sesión se conserva); cancelar no desconecta; confirmar sí', async () => {
    const disc = vi.fn(async () => R({ status: 'connected', desiredState: 'disconnected' }));
    const { el, tick } = await mk(S({ status: 'connected', desiredState: 'connected' }), { whatsappDisconnect: disc });
    byText(el, '.wa-actions button', 'Desconectar').click(); await tick(0);
    const dlg = el.querySelector('[role=alertdialog]')!;
    expect(dlg.getAttribute('aria-modal')).toBe('true');
    expect(dlg.textContent).toContain('La sesión se conserva');
    byText(el, '[role=alertdialog] button', 'Cancelar').click(); await tick(0);
    expect(disc).not.toHaveBeenCalled(); expect(el.querySelector('[role=alertdialog]')).toBeNull();
    byText(el, '.wa-actions button', 'Desconectar').click(); await tick(0);
    byText(el, '[role=alertdialog] button', 'Desconectar').click(); await tick(0);
    expect(disc).toHaveBeenCalledTimes(1);
  });
  it('Cerrar sesión pide confirmación que explica que se eliminan las credenciales; confirmar llama a la API de cierre', async () => {
    const out = vi.fn(async () => R({ status: 'connected', desiredState: 'disconnected', logoutPending: true }));
    const { el, tick } = await mk(S({ status: 'connected', desiredState: 'connected', sessionPersisted: true }), { whatsappLogout: out });
    byText(el, '.wa-actions button', 'Cerrar sesión').click(); await tick(0);
    const dlg = el.querySelector('[role=alertdialog]')!;
    expect(dlg.textContent).toContain('Se eliminan las credenciales guardadas'); expect(dlg.textContent).toContain('escanear un código QR nuevo');
    byText(el, '[role=alertdialog] button', 'Cancelar').click(); await tick(0);
    expect(out).not.toHaveBeenCalled();
    byText(el, '.wa-actions button', 'Cerrar sesión').click(); await tick(0);
    byText(el, '[role=alertdialog] button', 'Cerrar sesión').click(); await tick(0);
    expect(out).toHaveBeenCalledTimes(1);
  });
  it('tras cerrar sesión avisa que VIP no puede garantizar la desvinculación y que quizá haya que quitar el dispositivo en el teléfono', async () => {
    const out = vi.fn(async () => R({ status: 'disconnected', desiredState: 'disconnected', logoutPending: false, sessionPersisted: false }));
    const { el, tick } = await mk(S({ status: 'connected', desiredState: 'connected', sessionPersisted: true }), { whatsappLogout: out });
    byText(el, '.wa-actions button', 'Cerrar sesión').click(); await tick(0);
    expect(el.querySelector('[role=alertdialog]')!.textContent).toContain('no puede garantizar');
    byText(el, '[role=alertdialog] button', 'Cerrar sesión').click(); await tick(0);
    const note = el.querySelector('#wa-logout-note')!;
    expect(note.textContent).toContain('Dispositivos vinculados'); expect(note.textContent).toContain('no puede confirmar');
    expect(note.textContent).not.toMatch(/desvinculado correctamente|completamente desvinculado/i);
  });
  it('error de la API al conectar: mensaje en español con detalle técnico', async () => {
    const { el, tick } = await mk(S(), { whatsappConnect: vi.fn(async () => { throw new ApiError('forbidden', 403); }) });
    byText(el, 'button', 'Conectar WhatsApp').click(); await tick(0);
    expect(el.querySelector('[role=alert]')!.textContent).toContain('No tienes permiso');
    expect(el.querySelector('.err-detail')).not.toBeNull();
  });
  it('API caída: aviso y sin información engañosa de «Activado»', async () => {
    const { el } = await mk(() => { throw new ApiError('api_unreachable', 0); });
    expect(el.textContent).toContain('WhatsApp no disponible');
    expect(el.textContent).not.toMatch(/Modo de envío\s*Real/);
  });
});

describe('Pantalla de WhatsApp · un solo aviso compacto y prueba condicionada', () => {
  it('con la API caída sale UN solo aviso (no dos alertas) con Reintentar y detalle técnico plegado', async () => {
    const { el, get, tick } = await mk(() => { throw new ApiError('schema_outdated', 503); }, {}, 'super_admin');
    expect(el.querySelectorAll('.wa-line').length).toBe(1);
    expect(el.querySelector('.wa-line')!.textContent).toContain('WhatsApp no disponible');
    expect(el.querySelector('.wa-line')!.textContent).toContain('La base de datos no está actualizada');
    const d = el.querySelector('details.err-detail') as HTMLDetailsElement;
    expect(d.open).toBe(false);
    expect(d.textContent).toContain('HTTP 503');
    const calls = get.mock.calls.length;
    byText(el, '.wa-line button', 'Reintentar').click(); await tick(0);
    expect(get.mock.calls.length).toBeGreaterThan(calls);
  });
  it('un error de acción también es un único aviso', async () => {
    const { el, tick } = await mk(S(), { whatsappConnect: vi.fn(async () => { throw new ApiError('forbidden', 403); }) });
    byText(el, 'button', 'Conectar WhatsApp').click(); await tick(0);
    expect(el.querySelectorAll('.wa-line').length).toBe(1);
  });
  const CASES: [string, Partial<WhatsappSession>, boolean, string | null][] = [
    ['conectada + envío real habilitado', { status: 'connected', sendingMode: 'real', realTestEnabled: true }, true, null],
    ['conectada + modo pruebas (real desactivado)', { status: 'connected', sendingMode: 'test', realTestEnabled: false }, true, 'Envío real desactivado: solo puedes enviar mensajes simulados'],
    ['desconectada', { status: 'disconnected' }, false, 'Conecta WhatsApp para habilitar el envío de mensajes'],
    ['worker no disponible (apagado)', { status: 'connected', workerOnline: false }, false, 'El servicio de WhatsApp no está disponible'],
  ];
  it.each(CASES)('prueba · %s', async (_n, o, enabled, hint) => {
    const { el } = await mk(S(o), {}, 'super_admin');
    const row = el.querySelector('.wa-actions')!;
    const test = Array.from(row.querySelectorAll('.btn')).find((b) => b.textContent!.includes('Enviar mensaje de prueba'))!;
    if (enabled) { expect(test.tagName).toBe('A'); expect(test.getAttribute('href')).toBe('/messages/whatsapp/test'); }
    else { expect(test.tagName).toBe('BUTTON'); expect((test as HTMLButtonElement).disabled).toBe(true); expect(test.getAttribute('aria-describedby')).toBe('wa-test-hint'); }
    const gate = el.querySelectorAll('.wa-gate');
    if (hint) {
      expect(gate.length).toBe(1);                                                    // un solo aviso
      expect(gate[0]!.textContent!.trim()).toBe(hint);
      expect(gate[0]!.getAttribute('role')).toBe('status');
      expect(gate[0]!.querySelector('app-icon')!.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true');
      expect(row.contains(gate[0]!)).toBe(false);                                     // el aviso va DEBAJO de la fila de botones, no dentro
      expect(row.nextElementSibling).toBe(gate[0]);
    } else expect(gate.length).toBe(0);
    expect(row.parentElement!.querySelectorAll('.wa-gate, #wa-test-hint').length).toBe(hint ? 1 : 0);
  });
  it('«Cancelar» (conectando) y «Enviar mensaje de prueba» comparten UNA fila; el botón deshabilitado sigue siendo un botón', async () => {
    const { el } = await mk(S({ status: 'connecting', desiredState: 'connected' }), {}, 'super_admin');
    const row = el.querySelector('.wa-actions')!;
    expect(Array.from(row.children).map((c) => c.textContent!.trim())).toEqual(['Cancelar', 'Enviar mensaje de prueba']);
    expect(row.querySelectorAll('button').length).toBe(2);                            // no es texto suelto ni <span>
    expect(row.parentElement!.classList.contains('wa-actions-wrap')).toBe(true);
  });
  it('ADMIN no ve el botón de prueba ni su aviso', async () => {
    const { el } = await mk(S({ status: 'disconnected' }), {}, 'admin');
    expect(el.textContent).not.toContain('Enviar mensaje de prueba');
    expect(el.querySelector('.wa-gate')).toBeNull();
  });
  it('textos de estado: «Conectando WhatsApp» durante todo el proceso, Esperando escaneo, Error del worker, WhatsApp no disponible', async () => {
    const want: [Partial<WhatsappSession>, string][] = [[{ status: 'starting' }, 'Conectando WhatsApp'], [{ status: 'qr_pending' }, 'Conectando WhatsApp'], [{ status: 'awaiting_scan' }, 'Esperando escaneo'],
      [{ status: 'connecting' }, 'Conectando WhatsApp'], [{ status: 'failed', lastError: 'x' }, 'Error del worker'], [{ status: 'connected', workerOnline: false }, 'WhatsApp no disponible'], [{ status: 'disconnected' }, 'Desconectado']];
    for (const [o, label] of want) { TestBed.resetTestingModule(); vi.useRealTimers(); expect((await mk(S(o))).el.querySelector('.wa-badge')!.textContent).toContain(label); }
  });
});

describe('Pantalla de WhatsApp · sin avisos repetidos', () => {
  it('SUPER_ADMIN con el aviso de envío real desactivado no ve además la nota genérica equivalente', async () => {
    const { el } = await mk(S({ status: 'connected', sendingMode: 'test' }), {}, 'super_admin');
    expect(el.querySelectorAll('.wa-gate').length).toBe(1);
    expect(el.querySelector('.wa-real-note')).toBeNull();
  });
});

describe('Pantalla de WhatsApp · «Conectar» con respuesta inmediata y progreso', () => {
  const steps = (el: HTMLElement) => Array.from(el.querySelectorAll('.wa-progress li')).map((l) => ({ t: l.textContent!.replace(/[✓\s]+/g, ' ').trim(), done: l.classList.contains('done'), active: l.classList.contains('active') }));
  it('al pulsar: botón ocupado «Conectando…» y la tarjeta muestra los pasos AL INSTANTE (antes de que responda el servidor); no se vuelve a ofrecer «Conectar»', async () => {
    let release!: (r: WhatsappRequestResult) => void;
    const connect = vi.fn(() => new Promise<WhatsappRequestResult>((r) => { release = r; }));
    const { el, tick } = await mk(S(), { whatsappConnect: connect });
    expect(el.querySelector('.wa-steps-card')).toBeNull();
    const btn = byText(el, '.wa-actions button', 'Conectar WhatsApp');
    btn.click(); await tick(0);                                   // el servidor AÚN no ha respondido
    expect(connect).toHaveBeenCalledTimes(1);
    const b = el.querySelector('.wa-actions button') as HTMLButtonElement;
    expect(b.classList.contains('is-busy')).toBe(true); expect(b.getAttribute('data-busy-label')).toBe('Conectando…'); expect(b.getAttribute('aria-busy')).toBe('true'); expect(b.disabled).toBe(true);
    const st = steps(el);
    expect(st.map((x) => x.t)).toEqual(['Solicitud enviada', 'Iniciando WhatsApp (puede tardar unos segundos)', 'Generando código QR', 'Esperando escaneo', 'Conectando con tu teléfono', 'Conectado']);
    expect(st[0]).toMatchObject({ done: true }); expect(st[1]).toMatchObject({ active: true });
    expect(el.querySelector('.wa-badge')!.textContent).toContain('Conectando WhatsApp');
    b.click(); b.click(); await tick(0);
    expect(connect).toHaveBeenCalledTimes(1);                      // doble clic = una sola solicitud
    release(R({ status: 'disconnected', desiredState: 'connected' })); await tick(0);
    // el servidor aún dice «Desconectado»: se mantiene el progreso y NO reaparece «Conectar»
    const after = el.querySelector('.wa-actions button') as HTMLButtonElement;
    expect(after.classList.contains('is-busy')).toBe(true); expect(after.disabled).toBe(true);   // nunca un «Conectar» activo
    expect(el.querySelector('.wa-steps-card')).not.toBeNull();
  });
  it('los pasos siguen el estado real: iniciando → QR → escaneo → conectando', async () => {
    let status: WhatsappSession['status'] = 'disconnected';
    const { el, tick } = await mk(() => S({ status, desiredState: 'connected', qrData: status === 'awaiting_scan' ? 'abc' : null }), { whatsappConnect: vi.fn(async () => R({ status: 'disconnected', desiredState: 'connected' })) });
    byText(el, '.wa-actions button', 'Conectar WhatsApp').click(); await tick(0);
    const active = () => steps(el).findIndex((x) => x.active);
    expect(active()).toBe(1);
    status = 'starting'; await tick(2100); expect(active()).toBe(1);
    status = 'qr_pending'; await tick(2100); expect(active()).toBe(2);
    status = 'awaiting_scan'; await tick(2100); expect(active()).toBe(3);
    expect(steps(el).slice(0, 3).every((x) => x.done)).toBe(true);
    status = 'connecting'; await tick(2100); expect(active()).toBe(4);
    status = 'connected'; await tick(2100);
    expect(el.querySelector('.wa-steps-card')).toBeNull();
    expect(el.querySelector('.wa-badge')!.textContent).toContain('conectado');
  });
  it('si pasan ~30 s sin avanzar: «Está tardando más de lo normal» y «Reintentar» (que repite la solicitud)', async () => {
    const connect = vi.fn(async () => R({ status: 'disconnected', desiredState: 'connected' }));
    const { el, tick } = await mk(() => S({ status: 'disconnected', desiredState: 'connected' }), { whatsappConnect: connect });
    byText(el, '.wa-actions button', 'Conectar WhatsApp').click(); await tick(0);
    expect(el.textContent).not.toContain('Está tardando más de lo normal');
    await tick(31_000);
    expect(el.querySelector('.wa-steps-card .wa-line')!.textContent).toContain('Está tardando más de lo normal');
    byText(el, '.wa-actions button', 'Reintentar').click(); await tick(0);
    expect(connect).toHaveBeenCalledTimes(2);
  });
  it('Desconectar: botón ocupado «Desconectando…» hasta que el estado real llega a desconectado', async () => {
    let status: WhatsappSession['status'] = 'connected';
    const { el, tick } = await mk(() => S({ status, desiredState: 'connected' }), { whatsappDisconnect: vi.fn(async () => R({ status: 'connected', desiredState: 'disconnected' })) });
    byText(el, '.wa-actions button', 'Desconectar').click(); await tick(0);
    byText(el, '[role=alertdialog] button', 'Desconectar').click(); await tick(0);
    const d = Array.from(el.querySelectorAll('.wa-actions button')).find((b) => b.getAttribute('data-busy-label') === 'Desconectando…');
    expect(d).toBeDefined();
    status = 'disconnected'; await tick(2100);
    expect(buttons(el)).toContain('Conectar WhatsApp');
  });
});

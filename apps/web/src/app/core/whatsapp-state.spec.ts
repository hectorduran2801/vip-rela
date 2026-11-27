import { TestBed } from '@angular/core/testing';
import { ApiError } from './errors';
import type { WhatsappSession } from './models';
import { ApiService, AuthService } from './services';
import { FakeAuth, fakeApi, waSession } from '../testing/fakes';
import { WA_PENDING_TIMEOUT_MS, WA_POLL_FAST_MS, WA_POLL_NORMAL_MS, WA_STALE_MS, WhatsappState } from './whatsapp-state';

/** Reloj y temporizadores falsos: ningún sondeo real; el estado se prueba con respuestas simuladas de la API. */
export async function mkState(initial: WhatsappSession | (() => WhatsappSession), extra: Record<string, unknown> = {}, loggedIn = true) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(new Date('2026-11-16T15:00:30Z'));
  const get = vi.fn(async () => (typeof initial === 'function' ? initial() : initial));
  const auth = new FakeAuth(); if (loggedIn) auth.login('admin');
  TestBed.configureTestingModule({ providers: [{ provide: ApiService, useValue: fakeApi({ whatsappSession: get, ...extra }) }, { provide: AuthService, useValue: auth }] });
  const st = TestBed.inject(WhatsappState);
  const tick = async (ms = 0) => { TestBed.tick(); await vi.advanceTimersByTimeAsync(ms); TestBed.tick(); };
  await tick(0);
  return { st, get, auth, tick };
}
const setHidden = (v: boolean) => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => v }); document.dispatchEvent(new Event('visibilitychange')); };
afterEach(() => { vi.useRealTimers(); setHidden(false); });

const S = waSession;
describe('WhatsappState · semántica de colores y textos', () => {
  it.each([
    ['connected + pruebas', S({ status: 'connected', phoneNumber: '+50760000001', sendingMode: 'test' }), 'test', 'WhatsApp conectado · Envíos en prueba'],
    ['connected + reales', S({ status: 'connected', phoneNumber: '+50760000001', sendingMode: 'real' }), 'ok', 'WhatsApp conectado · Envíos reales'],
    ['connected + modo desconocido', S({ status: 'connected', sendingMode: 'unknown' }), 'test', 'WhatsApp conectado · Modo de envío desconocido'],
    ['starting', S({ status: 'starting' }), 'warn', 'Conectando WhatsApp'],
    ['qr_pending', S({ status: 'qr_pending' }), 'warn', 'Conectando WhatsApp'],
    ['connecting', S({ status: 'connecting' }), 'warn', 'Conectando WhatsApp'],
    ['awaiting_scan', S({ status: 'awaiting_scan' }), 'warn', 'Conectando WhatsApp · Esperando escaneo'],
    ['disconnected', S({ status: 'disconnected' }), 'danger', 'Desconectado'],
    ['failed', S({ status: 'failed', lastError: 'Sesión cerrada' }), 'danger', 'Error del worker'],
    ['worker apagado (aunque la fila diga connected)', S({ status: 'connected', workerOnline: false, sendingMode: 'unknown' }), 'muted', 'WhatsApp no disponible'],
  ] as const)('%s → %s «%s»', async (_n, session, tone, label) => {
    const { st } = await mkState(session);
    expect(st.view().tone).toBe(tone);
    expect(st.view().label).toBe(label);
  });
  it('desired_state=connected NO cuenta como conectado', async () => {
    const { st } = await mkState(S({ status: 'disconnected', desiredState: 'connected' }));
    expect(st.view().tone).toBe('danger');
    expect(st.connected()).toBe(false);
  });
  it('API caída: gris «WhatsApp no disponible» (sin parecer desconectado)', async () => {
    const { st } = await mkState(() => { throw new ApiError('api_unreachable', 0); });
    expect(st.view()).toMatchObject({ tone: 'muted', label: 'WhatsApp no disponible' });
  });
  it('antes de la primera respuesta: gris «Comprobando»', async () => {
    const { st } = await mkState(() => new Promise<never>(() => undefined) as never);
    expect(st.view()).toMatchObject({ tone: 'muted', label: 'Comprobando WhatsApp…' });
  });
  it('respuesta obsoleta (> 90 s sin respuesta correcta): nunca verde; vuelve al recuperar', async () => {
    let fail = false;
    const { st, tick } = await mkState(() => { if (fail) throw new ApiError('api_unreachable', 0); return S({ status: 'connected', sendingMode: 'real' }); });
    expect(st.view().tone).toBe('ok');
    fail = true;
    await tick(WA_STALE_MS + 10_000);
    expect(st.stale()).toBe(true);
    expect(st.view()).toMatchObject({ tone: 'muted', label: 'WhatsApp no disponible' });
    expect(st.connected()).toBe(false);
    fail = false; await tick(WA_POLL_NORMAL_MS + 100);
    expect(st.view().tone).toBe('ok');
  });
  it('sin sesión autorizada no consulta; al iniciar sesión sí; al cerrarla limpia', async () => {
    const { st, get, auth, tick } = await mkState(S({ status: 'connected' }), {}, false);
    await tick(WA_POLL_NORMAL_MS * 2);
    expect(get).not.toHaveBeenCalled();
    auth.login('admin'); await tick(0);
    expect(get).toHaveBeenCalledTimes(1);
    auth.user.set(null); await tick(0);
    expect(st.session()).toBeNull();
    const n = get.mock.calls.length; await tick(WA_POLL_NORMAL_MS * 2);
    expect(get.mock.calls.length).toBe(n);
  });
});

describe('WhatsappState · sondeo', () => {
  it('normal cada 25 s (no antes)', async () => {
    const { get, tick } = await mkState(S({ status: 'connected' }));
    expect(get).toHaveBeenCalledTimes(1);
    await tick(WA_POLL_NORMAL_MS - 1000); expect(get).toHaveBeenCalledTimes(1);
    await tick(2000); expect(get).toHaveBeenCalledTimes(2);
  });
  it('rápido (2 s) mientras haya una conexión en curso (estado transitorio o awaiting_scan), con o sin pantalla abierta', async () => {
    for (const status of ['starting', 'qr_pending', 'connecting', 'awaiting_scan'] as const) {
      TestBed.resetTestingModule();
      const { st, get, tick } = await mkState(S({ status, desiredState: 'connected' }));
      const n = get.mock.calls.length;
      await tick(WA_POLL_FAST_MS * 2 + 100); expect(get.mock.calls.length, `${status} sondea cada ${WA_POLL_FAST_MS} ms`).toBe(n + 2);
      void st;
      vi.useRealTimers();
    }
  });
  it('con la pantalla abierta y estado estable vuelve al ritmo normal; al soltar la pantalla también', async () => {
    const { st, get, tick } = await mkState(S({ status: 'connected', desiredState: 'connected' }));
    const release = st.watch(); await tick(0);
    const n = get.mock.calls.length;
    await tick(WA_POLL_FAST_MS * 3); expect(get.mock.calls.length).toBe(n);
    release(); release();
    await tick(WA_POLL_NORMAL_MS); expect(get.mock.calls.length).toBe(n + 1);
  });
  it('pausa con la pestaña oculta y refresca al volver', async () => {
    const { get, tick } = await mkState(S({ status: 'connected' }));
    setHidden(true);
    await tick(WA_POLL_NORMAL_MS * 3); expect(get).toHaveBeenCalledTimes(1);
    setHidden(false); await tick(0); expect(get).toHaveBeenCalledTimes(2);
  });
  it('nunca solapa peticiones', async () => {
    let release!: (s: WhatsappSession) => void;
    const { st, get, tick } = await mkState(() => new Promise<WhatsappSession>((r) => { release = r; }) as never);
    void st.refresh(); void st.refresh(); await tick(0);
    expect(get).toHaveBeenCalledTimes(1);
    release(S()); await tick(0);
    expect(st.session()).not.toBeNull();
  });
  it('request(): refleja el estado devuelto (no «conectado» por haber pedido) y devuelve el error en español', async () => {
    const connect = vi.fn(async () => ({ ...S({ status: 'disconnected', desiredState: 'connected' }), requested: true }));
    const { st, tick } = await mkState(S(), { whatsappConnect: connect });
    const p = st.request('connect');
    expect(st.pending()?.kind).toBe('connect');                       // solicitud en curso AL INSTANTE, antes de que responda el servidor
    expect(st.view()).toMatchObject({ tone: 'warn', label: 'Conectando WhatsApp' });
    expect(await p).toBeNull();
    expect(st.pending()?.kind).toBe('connect');                       // el servidor aún dice «Desconectado»: se mantiene «Conectando»
    expect(st.view().label).toBe('Conectando WhatsApp');
    expect(st.session()!.desiredState).toBe('connected');
    TestBed.resetTestingModule(); vi.useRealTimers();
    const m = await mkState(S(), { whatsappConnect: vi.fn(async () => { throw new ApiError('forbidden', 403); }) });
    expect(await m.st.request('connect')).toContain('No tienes permiso');
    expect(m.st.pending()).toBeNull();                                // un error libera la solicitud en curso
    void tick;
  });
});

describe('WhatsappState · solicitud en curso', () => {
  it('se mantiene hasta que el estado real avanza; entonces se libera y vuelve el ritmo normal', async () => {
    let status: 'disconnected' | 'starting' | 'connected' = 'disconnected';
    const connect = vi.fn(async () => ({ ...S({ status: 'disconnected', desiredState: 'connected' }), requested: true }));
    const { st, tick } = await mkState(() => S({ status, desiredState: 'connected' }), { whatsappConnect: connect });
    await st.request('connect');
    await tick(WA_POLL_FAST_MS + 50);
    expect(st.pending()).not.toBeNull();                              // sigue «Desconectado» en el servidor
    status = 'starting';
    await tick(WA_POLL_FAST_MS + 50);
    expect(st.pending()).toBeNull();                                  // avanzó: ya manda el estado real
    expect(st.view().label).toBe('Conectando WhatsApp');
    status = 'connected';
    await tick(WA_POLL_FAST_MS + 50);
    expect(st.view().label).toContain('WhatsApp conectado');
  });
  it('si pasan ~30 s sin avanzar: pendingSlow («Está tardando más de lo normal»)', async () => {
    const connect = vi.fn(async () => ({ ...S({ status: 'disconnected', desiredState: 'connected' }), requested: true }));
    const { st, tick } = await mkState(() => S({ status: 'disconnected', desiredState: 'connected' }), { whatsappConnect: connect });
    await st.request('connect');
    expect(st.pendingSlow()).toBe(false);
    await tick(WA_PENDING_TIMEOUT_MS + 2000);
    expect(st.pendingSlow()).toBe(true);
  });
  it('desconectar: «Desconectando WhatsApp» hasta que el estado real llega a desconectado', async () => {
    let status: 'connected' | 'disconnected' = 'connected';
    const disc = vi.fn(async () => ({ ...S({ status: 'connected', desiredState: 'disconnected' }), requested: true }));
    const { st, tick } = await mkState(() => S({ status, desiredState: 'connected' }), { whatsappDisconnect: disc });
    await st.request('disconnect');
    expect(st.view().label).toBe('Desconectando WhatsApp');
    status = 'disconnected';
    await tick(WA_POLL_FAST_MS + 50);
    expect(st.pending()).toBeNull();
    expect(st.view().label).toBe('Desconectado');
  });
});

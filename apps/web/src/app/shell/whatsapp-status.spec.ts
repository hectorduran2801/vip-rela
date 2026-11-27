import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { ApiError } from '../core/errors';
import type { WhatsappSession } from '../core/models';
import { ApiService, AuthService, Breakpoints } from '../core/services';
import { WA_STALE_MS } from '../core/whatsapp-state';
import { Whatsapp } from '../features/messaging/whatsapp';
import { FakeAuth, FakeBreakpoints, byText, fakeApi, waSession } from '../testing/fakes';
import { WhatsappStatus } from './whatsapp-status';

@Component({ template: 'pantalla' }) class Stub {}
const S = waSession;

async function mk(initial: WhatsappSession | (() => WhatsappSession), o: { mobile?: boolean; extra?: Record<string, unknown> } = {}) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(new Date('2026-11-16T15:00:30Z'));
  const get = vi.fn(async () => (typeof initial === 'function' ? initial() : initial));
  const bp = new FakeBreakpoints(); bp.isMobile.set(!!o.mobile);
  TestBed.configureTestingModule({ providers: [provideRouter([{ path: 'messages/whatsapp', component: Stub }]),
    { provide: ApiService, useValue: fakeApi({ whatsappSession: get, ...o.extra }) }, { provide: AuthService, useValue: new FakeAuth().login('admin') }, { provide: Breakpoints, useValue: bp }] });
  const f = TestBed.createComponent(WhatsappStatus);
  const el = f.nativeElement as HTMLElement;
  const tick = async (ms = 0) => { await vi.advanceTimersByTimeAsync(ms); f.detectChanges(); await vi.advanceTimersByTimeAsync(0); f.detectChanges(); };
  await tick(0);
  return { f, el, get, tick, bp };
}
const btn = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('.wa-btn')!;
const tone = (el: HTMLElement) => Array.from(btn(el).classList).find((c) => c.startsWith('tone-'))!;
afterEach(() => vi.useRealTimers());

describe('Indicador de WhatsApp en el encabezado', () => {
  it.each([
    ['connected + pruebas', S({ status: 'connected', sendingMode: 'test' }), 'tone-test', 'WhatsApp conectado · Envíos en prueba'],
    ['connected + reales', S({ status: 'connected', sendingMode: 'real' }), 'tone-ok', 'WhatsApp conectado · Envíos reales'],
    ['awaiting_scan', S({ status: 'awaiting_scan', desiredState: 'connected' }), 'tone-warn', 'Esperando escaneo'],
    ['connecting', S({ status: 'connecting', desiredState: 'connected' }), 'tone-warn', 'Conectando'],
    ['disconnected', S({ status: 'disconnected' }), 'tone-danger', 'Desconectado'],
    ['failed', S({ status: 'failed' }), 'tone-danger', 'Error del worker'],
    ['worker apagado', S({ status: 'connected', workerOnline: false }), 'tone-muted', 'WhatsApp no disponible'],
  ] as const)('%s → %s', async (_n, session, cls, text) => {
    const { el } = await mk(session);
    expect(tone(el)).toBe(cls);
    expect(btn(el).textContent!.replace(/\s+/g, ' ')).toContain(text);
  });
  it('conectado en pruebas lleva la insignia PRUEBA y un punto distinto del verde de envío real', async () => {
    const { el } = await mk(S({ status: 'connected', sendingMode: 'test' }));
    expect(el.querySelector('.wa-chip')!.textContent).toBe('PRUEBA');
    expect(tone(el)).not.toBe('tone-ok');
  });
  it('conectado en real: sin insignia PRUEBA', async () => {
    expect((await mk(S({ status: 'connected', sendingMode: 'real' }))).el.querySelector('.wa-chip')).toBeNull();
  });
  it('API caída → gris «WhatsApp no disponible»', async () => {
    const { el } = await mk(() => { throw new ApiError('api_unreachable', 0); });
    expect(tone(el)).toBe('tone-muted'); expect(btn(el).textContent).toContain('WhatsApp no disponible');
  });
  it('respuesta obsoleta (reloj falso, > 90 s) → gris, nunca verde', async () => {
    let fail = false;
    const { el, tick } = await mk(() => { if (fail) throw new ApiError('api_unreachable', 0); return S({ status: 'connected', sendingMode: 'real' }); });
    expect(tone(el)).toBe('tone-ok');
    fail = true; await tick(WA_STALE_MS + 10_000);
    expect(tone(el)).toBe('tone-muted');
    expect(btn(el).textContent).not.toContain('conectado');
  });
  it('móvil: solo icono + punto (sin texto visible) y nombre accesible', async () => {
    const { el } = await mk(S({ status: 'connected', sendingMode: 'test' }), { mobile: true });
    expect(btn(el).querySelector('.wa-dot')).not.toBeNull();
    expect(btn(el).querySelector('app-icon')).not.toBeNull();
    expect(btn(el).querySelector('.wa-text')).toBeNull();
    expect(btn(el).textContent!.trim()).toBe('');
    expect(btn(el).getAttribute('aria-label')).toContain('WhatsApp conectado · Envíos en prueba');
  });
});

describe('Popover de WhatsApp', () => {
  it('abre con detalle (estado, número, OpenWA, modo, hora 12 h) y cierra con Esc devolviendo el foco', async () => {
    const { f, el, tick } = await mk(S({ status: 'connected', phoneNumber: '+50760000001', sendingMode: 'test' }));
    expect(el.querySelector('#wa-pop')).toBeNull();
    btn(el).click(); await tick(0);
    const pop = el.querySelector('#wa-pop')!;
    expect(btn(el).getAttribute('aria-expanded')).toBe('true');
    expect(pop.getAttribute('role')).toBe('dialog');
    const t = pop.textContent!.replace(/\s+/g, ' ');
    for (const x of ['WhatsApp conectado · Envíos en prueba', '+507 6000 0001', 'En línea', 'Pruebas', '10:00 AM', 'Abrir Mensajería → WhatsApp']) expect(t).toContain(x);
    btn(el).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await tick(0);
    expect(el.querySelector('#wa-pop')).toBeNull();
    expect(document.activeElement).toBe(btn(el));
    expect(f).toBeTruthy();
  });
  it('cierra con clic fuera', async () => {
    const { el, tick } = await mk(S({ status: 'connected' }));
    document.body.appendChild(el);
    btn(el).click(); await tick(0);
    document.body.click(); await tick(0);
    expect(el.querySelector('#wa-pop')).toBeNull();
    el.remove();
  });
  it('worker apagado: «Apagado»; modo y número desconocidos', async () => {
    const { el, tick } = await mk(S({ status: 'connected', workerOnline: false, sendingMode: 'unknown' }));
    btn(el).click(); await tick(0);
    const t = el.querySelector('#wa-pop')!.textContent!.replace(/\s+/g, ' ');
    expect(t).toContain('Apagado'); expect(t).toMatch(/Modo de envío\s*Desconocido/);
    expect(t).toContain('El servicio de WhatsApp no responde. Estamos intentando recuperarlo; si persiste, avisa a soporte');
    expect(t).not.toMatch(/pnpm|dev:worker|comando/i);
    const det = el.querySelector('#wa-pop details.tech') as HTMLDetailsElement;
    expect(det.open).toBe(false); expect(det.textContent).toContain('worker_online=false');
  });
  it('el enlace navega a la pantalla de WhatsApp y cierra el popover', async () => {
    const { el, tick } = await mk(S({ status: 'connected' }));
    btn(el).click(); await tick(0);
    const a = el.querySelector<HTMLAnchorElement>('.wa-link')!;
    expect(a.getAttribute('href')).toBe('/messages/whatsapp');
    a.click(); await tick(0);
    expect(TestBed.inject(Router).url).toBe('/messages/whatsapp');
    expect(el.querySelector('#wa-pop')).toBeNull();
  });
});

describe('Encabezado + pantalla comparten el MISMO estado', () => {
  it('al conectar desde la pantalla el encabezado cambia al instante', async () => {
    const connect = vi.fn(async () => ({ ...S({ status: 'starting', desiredState: 'connected' }), requested: true }));
    const { el, tick, f } = await mk(S({ status: 'disconnected' }), { extra: { whatsappConnect: connect } });
    expect(btn(el).textContent).toContain('Desconectado');
    const screen = TestBed.createComponent(Whatsapp);
    screen.detectChanges(); await tick(0); screen.detectChanges();
    byText(screen.nativeElement, 'button', 'Conectar WhatsApp').click();
    await tick(0); screen.detectChanges();
    expect(btn(el).textContent).toContain('Conectando WhatsApp');
    expect(tone(el)).toBe('tone-warn');
    expect(f).toBeTruthy();
  });
});

describe('Indicador de WhatsApp · primera carga', () => {
  it('antes de la primera respuesta muestra un skeleton neutro (nunca «desconocido»); luego el estado real', async () => {
    let resolve!: (s: WhatsappSession) => void;
    const { el, tick } = await mk(() => undefined as never, { extra: { whatsappSession: vi.fn(() => new Promise<WhatsappSession>((r) => { resolve = r; })) } });
    expect(el.querySelector('.wa-skel')!.getAttribute('aria-busy')).toBe('true');
    expect(el.querySelector('.wa-btn')).toBeNull();
    expect(el.textContent).not.toMatch(/desconocido|no disponible/i);
    resolve(S({ status: 'connected' })); await tick(0);
    expect(el.querySelector('.wa-skel')).toBeNull();
    expect(btn(el).textContent).toContain('WhatsApp conectado');
  });
});

import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SendSchedule } from '../../core/models';
import { ApiService, AuthService, DataService } from '../../core/services';
import { FakeAuth, byLabel, byText, fakeApi, fakeData, settle, typeInto, waSession } from '../../testing/fakes';
import { Schedules, from24, to24 } from './schedules';

const SCH = (o: Partial<SendSchedule> = {}): SendSchedule => ({ id: 's1', name: 'Diez de la noche', localTime: '22:00', weekdays: [1, 2, 3, 4, 5, 6, 7], templateId: 't1', templateName: 'Noche',
  audience: 'all', enabled: true, lastRunDate: '2026-11-23', lastRunStatus: 'done', lastRunCreated: 88, lastRunTotal: 90, ...o });

async function setup(api: object = {}, role: 'admin' | 'supervisor' = 'admin', automatic = true) {
  TestBed.resetTestingModule();
  const a = fakeApi({ listSendSchedules: vi.fn(async () => [SCH()]), saveSendSchedule: vi.fn(async (i: any) => SCH({ ...i, templateName: 'Noche' })), deleteSendSchedule: vi.fn(async () => undefined),
    sendScheduleAudienceCount: vi.fn(async () => 42), whatsappSession: vi.fn(async () => waSession({ automaticEnabled: automatic, status: 'connected', workerHeartbeatAt: new Date().toISOString() })), ...api });
  const d = fakeData({ listTemplates: vi.fn(async () => [{ id: 't1', name: 'Noche', body: 'Hola {{nombre}}' }, { id: 't2', name: 'Otra', body: 'x' }]) });
  TestBed.configureTestingModule({ providers: [provideRouter([]), { provide: ApiService, useValue: a }, { provide: DataService, useValue: d }, { provide: AuthService, useValue: new FakeAuth().login(role === 'admin' ? 'admin' : 'supervisor') }] });
  const f = TestBed.createComponent(Schedules);
  await settle(f);
  return { f, el: f.nativeElement as HTMLElement, a };
}
const text = (e: Element) => e.textContent!.replace(/\s+/g, ' ').trim();

describe('Horarios de envío', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('lista cada horario con hora en 12 h, días, plantilla, audiencia y el resultado del último envío', async () => {
    const o = await setup();
    const c = text(o.el.querySelector('li.card')!);
    expect(c).toContain('Diez de la noche'); expect(c).toContain('Activo'); expect(c).toContain('10:00 PM · Todos los días'); expect(c).toContain('Noche');
    expect(c).toContain('Todos los conductores'); expect(c).toContain('23/11/2026: 88 de 90 mensajes');
  });
  it('avisa cuando el servidor no ejecuta horarios (recordatorios automáticos desactivados)', async () => {
    expect(text((await setup({}, 'admin', false)).el)).toContain('Los envíos automáticos están desactivados en el servidor');
    expect(text((await setup({}, 'admin', true)).el)).not.toContain('Los envíos automáticos están desactivados');
  });
  it('sin horarios: estado vacío que explica el caso de uso', async () => {
    expect(text((await setup({ listSendSchedules: vi.fn(async () => []) })).el)).toContain('Aún no hay horarios');
  });
  it('nuevo horario: valida nombre, hora en 12 h y plantilla si está activo; guarda con hora en 24 h', async () => {
    const o = await setup({ listSendSchedules: vi.fn(async () => []) });
    byText(o.el, 'button', 'Nuevo horario').click(); await settle(o.f);
    byText(o.el, 'button', 'Guardar horario').click(); await settle(o.f);
    expect(o.a.saveSendSchedule).not.toHaveBeenCalled(); expect(text(o.el)).toContain('Escribe un nombre.');
    typeInto(o.el, '#sf-name', 'Cierre'); await settle(o.f);
    expect(o.el.querySelector('input#sf-time')).toBeNull(); expect(text(o.el)).toContain('Hora seleccionada: 9:00 PM · Panamá');      // por defecto, sin texto libre
    const min = o.el.querySelector('#sf-min') as HTMLSelectElement; min.selectedIndex = 30; min.dispatchEvent(new Event('change')); await settle(o.f);
    expect(text(o.el)).toContain('Hora seleccionada: 9:30 PM');
    const sel = o.el.querySelector('#sf-tpl') as HTMLSelectElement; sel.value = sel.options[1]!.value; sel.dispatchEvent(new Event('change')); await settle(o.f);
    const aud = o.el.querySelector('#sf-aud') as HTMLSelectElement; aud.value = 'with_balance'; aud.dispatchEvent(new Event('change')); await settle(o.f);
    expect(text(o.el)).toContain('Hoy llegaría a 42 conductores.'); expect(o.a.sendScheduleAudienceCount).toHaveBeenLastCalledWith('with_balance');
    (o.el.querySelector('input[name=enabled]') as HTMLInputElement).click(); await settle(o.f);
    byText(o.el, 'button', 'Guardar horario').click(); await settle(o.f);
    expect(o.a.saveSendSchedule).toHaveBeenCalledWith({ id: undefined, name: 'Cierre', localTime: '21:30', weekdays: [1, 2, 3, 4, 5, 6, 7], templateId: 't1', audience: 'with_balance', enabled: true, assignmentIds: [] });
  });
  it('las 12 AM y las 12 PM se convierten bien a 24 horas y al revés', () => {
    expect([to24(12, 0, 'AM'), to24(12, 0, 'PM'), to24(1, 5, 'AM'), to24(11, 59, 'PM')]).toEqual(['00:00', '12:00', '01:05', '23:59']);
    expect(from24('00:00')).toEqual({ hour: 12, minute: 0, period: 'AM' }); expect(from24('12:00')).toEqual({ hour: 12, minute: 0, period: 'PM' }); expect(from24('22:15')).toEqual({ hour: 10, minute: 15, period: 'PM' });
  });
  it('conductores elegidos a mano: se marcan en un modal, se puede quitar uno y se guarda la lista', async () => {
    const row = (id: string, unit: string) => ({ assignmentId: id, unitCode: unit, operatorCode: '1', fullName: unit, phone: '+50760000000', saldoCents: 8700 });
    const recipients = vi.fn(async () => [row('a1', 'P1'), row('a2', 'P2')]);
    const o = await setup({ listSendSchedules: vi.fn(async () => []), sendScheduleRecipients: recipients });
    expect(recipients).toHaveBeenCalledTimes(1);                                                  // precargado al entrar
    byText(o.el, 'button', 'Nuevo horario').click(); await settle(o.f);
    typeInto(o.el, '#sf-name', 'Elegidos'); await settle(o.f);
    const aud = o.el.querySelector('#sf-aud') as HTMLSelectElement; aud.value = 'selected'; aud.dispatchEvent(new Event('change')); await settle(o.f);
    byText(o.el, 'button', 'Seleccionar conductores').click(); await settle(o.f);
    byText(o.el, 'button', 'Marcar todos').click(); await settle(o.f); expect(text(o.el)).toContain('2 seleccionados');
    (o.el.querySelectorAll('.pk-list input')[1] as HTMLInputElement).click(); await settle(o.f); expect(text(o.el)).toContain('1 seleccionado');
    byText(o.el, 'button', 'Usar 1 conductor').click(); await settle(o.f);
    byText(o.el, 'button', 'Guardar horario').click(); await settle(o.f);
    expect(o.a.saveSendSchedule).toHaveBeenCalledWith(expect.objectContaining({ audience: 'selected', assignmentIds: ['a1'] }));
  });
  it('un horario activo sin plantilla no se guarda', async () => {
    const o = await setup({ listSendSchedules: vi.fn(async () => []) });
    byText(o.el, 'button', 'Nuevo horario').click(); await settle(o.f);
    typeInto(o.el, '#sf-name', 'X'); (o.el.querySelector('input[name=enabled]') as HTMLInputElement).click(); await settle(o.f);
    byText(o.el, 'button', 'Guardar horario').click(); await settle(o.f);
    expect(text(o.el)).toContain('Un horario activo necesita una plantilla.'); expect(o.a.saveSendSchedule).not.toHaveBeenCalled();
  });
  it('desactivar desde la tarjeta y eliminar con confirmación', async () => {
    const o = await setup();
    byText(o.el, 'button', 'Desactivar').click(); await settle(o.f);
    expect(o.a.saveSendSchedule).toHaveBeenCalledWith(expect.objectContaining({ id: 's1', enabled: false, localTime: '22:00', templateId: 't1' }));
    byLabel(o.el, '', 'Eliminar horario').click(); await settle(o.f);
    expect(o.a.deleteSendSchedule).not.toHaveBeenCalled(); expect(text(o.el.querySelector('[role=alertdialog]')!)).toContain('¿Eliminar el horario «Diez de la noche»?');
    byText(o.el, 'button', 'Eliminar horario').click(); await settle(o.f);
    expect(o.a.deleteSendSchedule).toHaveBeenCalledWith('s1');
  });
  it('un error al guardar se muestra y no cierra el formulario', async () => {
    const o = await setup({ saveSendSchedule: vi.fn(async () => { throw { message: 'template_required', code: '23514' }; }) });
    byLabel(o.el, '', 'Editar horario').click(); await settle(o.f);
    byText(o.el, 'button', 'Guardar horario').click(); await settle(o.f);
    expect(o.el.querySelector('[role=alert]')).not.toBeNull(); expect(o.el.querySelector('#sf-name')).not.toBeNull();
  });
  it('cambios sin guardar: solo si se modificó algo de verdad; abrir y cancelar el selector no cuenta', async () => {
    const o = await setup({ sendScheduleRecipients: vi.fn(async () => []) });
    byText(o.el, 'button', 'Nuevo horario').click(); await settle(o.f);
    expect(o.el.querySelector('.modal-dirty')).toBeNull();
    const aud = o.el.querySelector('#sf-aud') as HTMLSelectElement; aud.value = 'selected'; aud.dispatchEvent(new Event('change')); await settle(o.f);
    aud.value = 'all'; aud.dispatchEvent(new Event('change')); await settle(o.f);
    expect(o.el.querySelector('.modal-dirty')).toBeNull();                                         // volvió a como estaba
    typeInto(o.el, '#sf-name', 'X'); await settle(o.f);
    expect(o.el.querySelector('.modal-dirty')!.textContent).toContain('Cambios sin guardar');
  });
});

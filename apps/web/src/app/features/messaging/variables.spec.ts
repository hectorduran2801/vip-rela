import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiService, AuthService } from '../../core/services';
import { FakeAuth, fakeApi, settle } from '../../testing/fakes';
import { Variables } from './variables';

const VAR = (o = {}) => ({ group: 'Importes financieros', code: 'saldo_total', label: 'Saldo total', description: 'Saldo del Excel + la cuota de hoy', example: '$79.00', customized: false, defaultLabel: 'Saldo total', defaultDescription: 'x', ...o });
const TXT = (o = {}) => ({ key: 'detalle_pendiente', title: 'Cuando debe dinero', text: 'Su saldo pendiente es de {monto}.', defaultText: 'Su saldo pendiente es de {monto}.', customized: false, example: '$79.00', ...o });

async function setup(role: 'admin' | 'supervisor' = 'admin', api: object = {}) {
  TestBed.resetTestingModule();
  const a = fakeApi({ variableEditor: vi.fn(async () => [VAR()]), templateTexts: vi.fn(async () => [TXT()]), saveVariable: vi.fn(async () => undefined), resetVariable: vi.fn(async () => undefined),
    saveTemplateText: vi.fn(async () => undefined), resetTemplateText: vi.fn(async () => undefined), ...api });
  TestBed.configureTestingModule({ providers: [{ provide: ApiService, useValue: a }, { provide: AuthService, useValue: new FakeAuth().login(role) }] });
  const f = TestBed.createComponent(Variables);
  await settle(f);
  return { f, el: f.nativeElement as HTMLElement, a };
}
const type = async (f: any, el: HTMLInputElement | HTMLTextAreaElement, v: string) => { el.value = v; el.dispatchEvent(new Event('input')); await settle(f); };

describe('Variables editables', () => {
  afterEach(() => TestBed.resetTestingModule());
  it('muestra cada variable y las frases; guardar envía el texto editado', async () => {
    const o = await setup();
    expect(o.el.textContent).toContain('{{saldo_total}}'); expect(o.el.textContent).toContain('Cuando debe dinero');
    await type(o.f, o.el.querySelector<HTMLTextAreaElement>('#tx-detalle_pendiente')!, 'Su deuda total al día de hoy es de {monto}.');
    expect(o.el.textContent).toContain('Vista previa: Su deuda total al día de hoy es de $115.00.');
    [...o.el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent!.trim() === 'Guardar' && !b.disabled)!.click(); await settle(o.f);
    expect(o.a.saveTemplateText).toHaveBeenCalledWith('detalle_pendiente', 'Su deuda total al día de hoy es de {monto}.');
    expect(o.el.textContent).toContain('Texto guardado.');
  });
  it('el marcador {monto} es obligatorio: sin él (o con un importe escrito) no se puede guardar; el botón lo inserta', async () => {
    const o = await setup();
    const ta = o.el.querySelector<HTMLTextAreaElement>('#tx-detalle_pendiente')!;
    const save = () => [...o.el.querySelectorAll<HTMLButtonElement>('.vr-actions button')].find((b) => b.textContent!.trim() === 'Guardar')!;
    await type(o.f, ta, 'Debe dinero'); expect(o.el.textContent).toContain('La frase debe incluir {monto}.'); expect(save().disabled).toBe(true);
    await type(o.f, ta, 'Debe $50.00 {monto}'); expect(o.el.textContent).toContain('No escribas importes con $'); expect(save().disabled).toBe(true);
    await type(o.f, ta, 'Debe '); [...o.el.querySelectorAll<HTMLButtonElement>('.vr-actions button')].find((b) => b.textContent!.includes('Insertar'))!.click(); await settle(o.f);
    expect(ta.value).toContain('{monto}');
  });
  it('una variable personalizada se puede restablecer', async () => {
    const o = await setup('admin', { variableEditor: vi.fn(async () => [VAR({ customized: true, label: 'Total hoy' })]) });
    [...o.el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent!.includes('Restablecer original'))!.click(); await settle(o.f);
    expect(o.a.resetVariable).toHaveBeenCalledWith('saldo_total');
  });
  it('un supervisor solo ve los textos: sin botones para editar', async () => {
    const o = await setup('supervisor');
    expect(o.el.querySelectorAll('button').length).toBe(0); expect(o.el.querySelector<HTMLTextAreaElement>('#tx-detalle_pendiente')!.disabled).toBe(true);
  });
});

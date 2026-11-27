import { driver } from '../../testing/fakes';
import { validateDriver, type ConsentForm } from './driver-form';

const C = (collection: Partial<ConsentForm['collection']> = {}, promotional: Partial<ConsentForm['promotional']> = {}): ConsentForm => ({
  collection: { grant: true, source: '', evidence: '', ...collection }, promotional: { grant: false, source: '', evidence: '', ...promotional },
});
const select = (el: HTMLElement, sel: string, v: string) => { const e = el.querySelector(sel) as HTMLSelectElement; e.value = v; e.dispatchEvent(new Event('change')); };

describe('Autorización de WhatsApp · validación', () => {
  it('la casilla de cobranza marcada exige origen y teléfono válido; sin casilla no se pide nada', () => {
    const d = { ...driver(), phoneE164: '+50760000000' };
    expect(validateDriver(d, C())['collectionSource']).toContain('origen');
    expect(validateDriver(d, C({ source: 'verbal_admin' }))).toEqual({});
    expect(validateDriver({ ...d, phoneE164: null }, C({ source: 'verbal_admin' }))['collectionPhone']).toContain('número de WhatsApp');
    expect(validateDriver({ ...d, phoneE164: null }, C({ grant: false }))).toEqual({});
  });
  it('cobranza y promocional son independientes: cada una pide SU origen', () => {
    const d = { ...driver(), phoneE164: '+50760000000' };
    const e = validateDriver(d, C({ source: 'signed_form' }, { grant: true }));
    expect(Object.keys(e)).toEqual(['promotionalSource']);
    expect(validateDriver(d, C({ grant: false }, { grant: true, source: 'other' }))).toEqual({});
  });
  it('una finalidad ya autorizada no vuelve a pedir origen al editar', () => {
    expect(validateDriver({ ...driver(), phoneE164: '+50760000000' }, C(), { collection: true })).toEqual({});
  });
});

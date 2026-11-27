import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiService, AuthService } from '../core/services';
import { FakeAuth, fakeApi, settle } from '../testing/fakes';
import { AccountSwitch } from './account-switch';

const LIST = [{ id: 'me', name: 'Yo', own: true, viewing: true, drivers: 0 }, { id: 'van', name: 'Vanessa S', own: false, viewing: false, drivers: 88 }];
async function setup(role: 'super_admin' | 'admin') {
  TestBed.resetTestingModule();
  const api = fakeApi({ listAccounts: vi.fn(async () => LIST), setAccountView: vi.fn(async () => undefined) });
  TestBed.configureTestingModule({ providers: [{ provide: ApiService, useValue: api }, { provide: AuthService, useValue: new FakeAuth().login(role) }] });
  const f = TestBed.createComponent(AccountSwitch); const reload = vi.fn(); f.componentInstance.reload = reload; await settle(f);
  return { f, el: f.nativeElement as HTMLElement, api, reload };
}
describe('selector de cuenta', () => {
  afterEach(() => TestBed.resetTestingModule());
  it('el SUPER_ADMIN elige una cuenta ajena y la app se recarga', async () => {
    const o = await setup('super_admin');
    const s = o.el.querySelector('select')!; expect(s.textContent).toContain('Mi cuenta (0)'); expect(s.textContent).toContain('Vanessa S (88)');
    s.value = 'van'; s.dispatchEvent(new Event('change')); await settle(o.f);
    expect(o.api.setAccountView).toHaveBeenCalledWith('van'); expect(o.reload).toHaveBeenCalled();
  });
  it('un ADMIN no ve el selector ni consulta cuentas', async () => {
    const o = await setup('admin');
    expect(o.el.querySelector('select')).toBeNull(); expect(o.api.listAccounts).not.toHaveBeenCalled();
  });
});

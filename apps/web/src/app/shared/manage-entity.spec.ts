import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ApiError } from '../core/errors';
import type { DeleteCheck } from '../core/models';
import { ApiService, AuthService } from '../core/services';
import { FakeAuth, byLabel, byText, fakeApi, settle, typeInto } from '../testing/fakes';
import { ManageEntity, plainCounts } from './manage-entity';
import { ToastService } from './toast';

const toasts = () => TestBed.inject(ToastService).items();

@Component({
  imports: [ManageEntity],
  template: `<app-manage-entity kind="drivers" entityId="d1" name="Ana Pérez" [archived]="archived()" (changed)="changed = changed + 1" (deleted)="deleted = deleted + 1" />`,
})
class Host { archived = signal(false); changed = 0; deleted = 0; }

const CHECK_OK: DeleteCheck = { canDelete: true, blockedBy: [], blockers: {}, willDelete: { assignments: 1, daily_charges: 12, rates: 1, pending_jobs: 0, consents: 2 }, activeAssignments: [{ unit_code: 'T-1', driver_name: 'Ana Pérez' }], suggestion: 'delete' };
const CHECK_BLOCKED: DeleteCheck = { canDelete: false, blockedBy: ['payments'], blockers: { payments: 3, adjustments: 1, sent_messages: 0 }, willDelete: {}, activeAssignments: [{ unit_code: 'T-1', driver_name: 'Ana Pérez' }], suggestion: 'archive' };

async function mk(api: object = {}, role: 'admin' | 'super_admin' | 'supervisor' = 'admin') {
  TestBed.resetTestingModule();
  const a = fakeApi({ deleteCheck: vi.fn(async () => CHECK_OK), deleteEntity: vi.fn(async () => ({ deleted: true, deletedCounts: {} })),
    archiveEntity: vi.fn(async () => ({ archived: true, endedAssignments: [{}], chargesCompleted: 3, cancelledJobs: 2, cancelledMessages: 1, pendingCents: 4000 })), reactivateEntity: vi.fn(async () => ({ reactivated: true, hasActiveAssignment: false })), ...api });
  TestBed.configureTestingModule({ providers: [{ provide: ApiService, useValue: a }, { provide: AuthService, useValue: new FakeAuth().login(role) }] });
  const f = TestBed.createComponent(Host); await settle(f);
  return { f, h: f.componentInstance, a, el: f.nativeElement as HTMLElement };
}

describe('Eliminar / Dar de baja / Reactivar (conductores y unidades)', () => {
  it('plainCounts: solo conteos > 0, en lenguaje llano', () => {
    expect(plainCounts({ payments: 3, adjustments: 0, closures: 1 }, { payments: 'pagos', adjustments: 'ajustes', closures: 'cierres' })).toBe('3 pagos, 1 cierres');
  });
  it('iconos con tooltip: «Dar de baja al conductor» y «Eliminar conductor» (rojo); un supervisor no ve nada', async () => {
    const { el } = await mk();
    expect(byLabel(el, '', 'Dar de baja al conductor')).toBeDefined(); expect(byLabel(el, '', 'Eliminar conductor').className).toContain('tone-danger');
    expect((await mk({}, 'supervisor')).el.querySelector('button')).toBeNull();
  });
  it('eliminar sin historial: revisa antes, muestra qué se borrará (conteos), motivo opcional, UNA llamada y avisa al terminar', async () => {
    const { f, h, a, el } = await mk();
    byLabel(el, '', 'Eliminar conductor').click(); await settle(f);
    expect(a.deleteCheck).toHaveBeenCalledWith('drivers', 'd1');
    const dlg = el.querySelector('[role=alertdialog]')!;
    expect(dlg.textContent).toContain('¿Eliminar al conductor Ana Pérez?'); expect(dlg.textContent).toContain('1 asignaciones, 12 cuotas diarias, 1 tarifas, 2 autorizaciones de WhatsApp');
    expect(dlg.textContent).not.toContain('avisos pendientes');                      // conteos en cero no se listan
    typeInto(el, '#me-reason', 'Duplicado'); await settle(f);
    const go = byText(el, '[role=alertdialog] button', 'Eliminar conductor');
    (el.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit')); (el.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit')); go.click(); await settle(f);
    expect(a.deleteEntity).toHaveBeenCalledTimes(1); expect(a.deleteEntity).toHaveBeenCalledWith('drivers', 'd1', 'Duplicado'); expect(h.deleted).toBe(1);
    expect(el.querySelector('[role=alertdialog]')).toBeNull();
  });
  it('con historial: explica por qué (sin error técnico) y ofrece «Dar de baja»; dar de baja cierra y resume lo hecho', async () => {
    const { f, h, a, el } = await mk({ deleteCheck: vi.fn(async () => CHECK_BLOCKED) });
    byLabel(el, '', 'Eliminar conductor').click(); await settle(f);
    const dlg = el.querySelector('[role=alertdialog]')!;
    expect(dlg.textContent).toContain('No se puede eliminar al conductor'); expect(dlg.textContent).toContain('3 pagos, 1 ajustes'); expect(dlg.textContent).toContain('darlo de baja');
    expect(dlg.textContent).toContain('Asignación vigente: T-1 · Ana Pérez'); expect(dlg.textContent).not.toMatch(/409|delete_blocked|error/i);
    expect(a.deleteEntity).not.toHaveBeenCalled();
    byText(el, '[role=alertdialog] button', 'Dar de baja…').click(); await settle(f);
    typeInto(el, '#me-reason2', 'Ya no trabaja'); typeInto(el, '#me-date', '2026-11-20'); await settle(f);
    (el.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit')); await settle(f);
    expect(a.archiveEntity).toHaveBeenCalledTimes(1); expect(a.archiveEntity).toHaveBeenCalledWith('drivers', 'd1', { reason: 'Ya no trabaja', effectiveDate: '2026-11-20' });
    expect(h.changed).toBe(1);
    expect(toasts()).toEqual([expect.objectContaining({ kind: 'ok', text: 'Dado de baja. Se cerraron 1 asignación, 3 cuotas completadas, 3 avisos cancelados. Queda pendiente $40.00.' })]);
    expect(el.querySelector('.alert')).toBeNull();                                      // nada dentro de la celda de la tabla
  });
  it('si alguien registra historial entre la revisión y el clic: el 409 delete_blocked_has_history lleva a la explicación, no a un error', async () => {
    const err = Object.assign(new ApiError('delete_blocked_has_history', 409), { payload: { blockers: { payments: 2 }, suggestion: 'archive' } });
    const { f, el } = await mk({ deleteEntity: vi.fn(async () => { throw err; }) });
    byLabel(el, '', 'Eliminar conductor').click(); await settle(f);
    (el.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit')); await settle(f);
    const dlg = el.querySelector('[role=alertdialog]')!;
    expect(dlg.textContent).toContain('No se puede eliminar'); expect(dlg.textContent).toContain('2 pagos'); expect(byText(el, '[role=alertdialog] button', 'Dar de baja…')).toBeDefined();
  });
  it('errores en español: conductor inexistente al revisar o al archivar; el modal sigue abierto con lo escrito', async () => {
    const a = await mk({ deleteCheck: vi.fn(async () => { throw new ApiError('driver_not_found', 404); }) });
    byLabel(a.el, '', 'Eliminar conductor').click(); await settle(a.f);
    expect(toasts()[0]).toMatchObject({ kind: 'error' }); expect(toasts()[0]!.text).toContain('No se encontró el conductor');
    expect(a.el.querySelector('.alert')).toBeNull(); expect(a.el.querySelector('[role=alertdialog]')).toBeNull();
    const b = await mk({ archiveEntity: vi.fn(async () => { throw new ApiError('already_archived', 409); }) });
    byLabel(b.el, '', 'Dar de baja al conductor').click(); await settle(b.f);
    typeInto(b.el, '#me-reason2', 'x'); (b.el.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit')); await settle(b.f);
    expect(b.el.querySelector('[role=alertdialog] .modal-error')!.textContent).toContain('Ya estaba dado de baja'); expect((b.el.querySelector('#me-reason2') as HTMLInputElement).value).toBe('x');
  });
  it('503 schema_outdated: aviso emergente sin detalle técnico, nada en la celda y el botón vuelve a quedar libre', async () => {
    const check = vi.fn(async () => { throw new ApiError('schema_outdated', 503); });
    const { f, el } = await mk({ deleteCheck: check });
    byLabel(el, '', 'Eliminar conductor').click(); await settle(f);
    expect(toasts()[0]!.text).not.toMatch(/503|schema_outdated|delete-check|Detalle técnico/);
    expect(el.querySelector('.alert')).toBeNull(); expect(el.querySelector('[aria-busy=true]')).toBeNull();
    byLabel(el, '', 'Eliminar conductor').click(); await settle(f);
    expect(check).toHaveBeenCalledTimes(2);
  });
  it('si el servidor no responde, el botón se libera a los 20 s y se explica qué hacer', async () => {
    const { f, el } = await mk({ deleteCheck: vi.fn(() => new Promise(() => undefined)) });
    vi.useFakeTimers();
    try {
      byLabel(el, '', 'Eliminar conductor').click(); f.detectChanges();
      expect(el.querySelector('[aria-busy=true]')).not.toBeNull();
      await vi.advanceTimersByTimeAsync(20_000); f.detectChanges();
      expect(el.querySelector('[aria-busy=true]')).toBeNull();
      expect(toasts()[0]!.text).toContain('tardó demasiado');
    } finally { vi.useRealTimers(); }
  });
  it('dado de baja: aparece «Reactivar conductor»; avisa si no queda asignación vigente', async () => {
    const { f, h, a, el } = await mk(); h.archived.set(true); await settle(f);
    expect(el.querySelector('[aria-label="Dar de baja al conductor"]')).toBeNull();
    byLabel(el, '', 'Reactivar conductor').click(); await settle(f);
    expect(a.reactivateEntity).toHaveBeenCalledWith('drivers', 'd1'); expect(h.changed).toBe(1);
    expect(toasts()[0]!.text).toContain('No tiene una asignación vigente');
  });
});

describe('Tiempo agotado al escribir: se comprueba el estado real antes de permitir repetir', () => {
  const never = () => new Promise<never>(() => undefined);
  async function slow(action: 'delete' | 'archive', second: () => Promise<DeleteCheck>) {
    let n = 0;
    const t = await mk({ deleteCheck: vi.fn(() => (n++ === 0 ? Promise.resolve(CHECK_OK) : second())), deleteEntity: vi.fn(never), archiveEntity: vi.fn(never) });
    byLabel(t.el, '', action === 'delete' ? 'Eliminar conductor' : 'Dar de baja al conductor').click(); await settle(t.f);
    const shown = vi.spyOn(TestBed.inject(ToastService), 'show');
    vi.useFakeTimers();
    try {
      (t.el.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit')); t.f.detectChanges();
      await vi.advanceTimersByTimeAsync(20_000); await vi.advanceTimersByTimeAsync(20_000); t.f.detectChanges();
    } finally { vi.useRealTimers(); }
    await settle(t.f);
    return { ...t, shown };
  }
  it('si en realidad SÍ se eliminó, se trata como hecho (no se repite)', async () => {
    const t = await slow('delete', async () => { throw new ApiError('driver_not_found', 404); });
    expect(t.h.deleted).toBe(1); expect(t.shown).toHaveBeenCalledWith('ok', expect.stringContaining('sí se completó'), 9000);
  });
  it('si NO se eliminó, lo dice, cierra la confirmación y repetir exige revisar otra vez', async () => {
    const t = await slow('delete', async () => CHECK_OK);
    expect(t.h.deleted).toBe(0); expect(t.el.querySelector('[role=alertdialog]')).toBeNull();
    expect(toasts()[0]!.text).toContain('no se ha hecho');
  });
  it('si no se puede comprobar, no se da por hecho ni por fallido', async () => {
    const t = await slow('delete', async () => { throw new ApiError('api_unreachable', 0); });
    expect(t.h.deleted).toBe(0); expect(toasts()[0]!.text).toContain('No se pudo comprobar');
  });
  it('baja que sí quedó registrada: se recarga como hecha', async () => {
    const t = await slow('archive', async () => ({ ...CHECK_OK, archived: true }));
    expect(t.h.changed).toBe(1); expect(t.shown).toHaveBeenCalledWith('ok', expect.stringContaining('sí se completó'), 9000);
  });
});

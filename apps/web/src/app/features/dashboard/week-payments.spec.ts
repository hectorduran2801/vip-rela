import { TestBed } from '@angular/core/testing';
import { addDays } from '@vip/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mondayOf, todayIn } from '../../core/dates';
import { TIMEZONE } from '../../core/models';
import { ApiService } from '../../core/services';
import { fakeApi, settle } from '../../testing/fakes';
import { WeekPayments } from './week-payments';

const today = todayIn(TIMEZONE);
const row = (id: string, paid: number) => ({ assignmentId: id, unitCode: id.toUpperCase(), fullName: `Conductor ${id}`, days: [{ date: today, dueCents: 3000, paidCents: paid }] });

describe('Inicio · pagos de la semana', () => {
  afterEach(() => TestBed.resetTestingModule());
  it('muestra el día de hoy por defecto, separa quién pagó completo, incompleto o nada, y es solo lectura', async () => {
    const board = vi.fn(async () => [row('a', 3000), row('b', 2500), row('c', 0)]);
    TestBed.configureTestingModule({ providers: [{ provide: ApiService, useValue: fakeApi({ collectionBoard: board }) }] });
    const f = TestBed.createComponent(WeekPayments); await settle(f);
    const el = f.nativeElement as HTMLElement; const t = () => el.textContent!.replace(/\s+/g, ' ');
    expect(board).toHaveBeenCalledWith(mondayOf(today));
    expect(t()).toContain('Pagaron completo (1)'); expect(t()).toContain('Pagaron incompleto (1)'); expect(t()).toContain('No pagaron (1)'); expect(t()).toContain('Recibido ese día: $55.00');
    expect(t()).toContain('Conductor a'); expect(t()).not.toContain('Conductor c');
    [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent!.includes('No pagaron'))!.click(); await settle(f);
    expect(t()).toContain('Conductor c'); expect(el.querySelector('input, select, textarea')).toBeNull();
    const days = [...el.querySelectorAll<HTMLButtonElement>('[aria-label="Día"] button')];
    expect(days.length).toBe(7);                                                                  // solo la semana en curso
    expect(days.filter((b) => b.disabled).length).toBe(days.filter((_, i) => addDays(mondayOf(today), i) > today).length);
  });
  it('abierta durante el cambio de día y de semana: pasa sola a la semana nueva, sin semanas anteriores ni botones para cambiarlas', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-11-29T23:59:00-05:00'));                       // domingo 11:59 PM en Panamá
      const board = vi.fn(async (_week: string) => []);
      TestBed.configureTestingModule({ providers: [{ provide: ApiService, useValue: fakeApi({ collectionBoard: board, collectionLastSync: vi.fn(async () => null) }) }] });
      const f = TestBed.createComponent(WeekPayments); await settle(f);
      const el = f.nativeElement as HTMLElement; const days = () => [...el.querySelectorAll<HTMLButtonElement>('[aria-label="Día"] button')];
      expect(board).toHaveBeenLastCalledWith('2026-11-23'); expect(days()[6]!.textContent).toContain('Hoy'); expect(days().every((b) => !b.disabled)).toBe(true);
      vi.setSystemTime(new Date('2026-11-30T00:00:30-05:00'));                       // lunes 12:00 AM
      await (f.componentInstance as any).tick(); await settle(f);
      expect(board).toHaveBeenLastCalledWith('2026-11-30');
      expect(days()[0]!.textContent).toContain('Hoy'); expect(days()[0]!.getAttribute('aria-pressed')).toBe('true');
      expect(days().slice(1).every((b) => b.disabled)).toBe(true);
      expect([...el.querySelectorAll('button')].some((b) => /anterior|siguiente/i.test(b.textContent! + (b.getAttribute('aria-label') ?? '')))).toBe(false);
    } finally { vi.useRealTimers(); }
  });
  it('tras una importación nueva se actualiza sola; sin importación nueva no vuelve a pedir los datos', async () => {
    let id = 'imp-1'; let paid = 0;
    const board = vi.fn(async () => [row('a', paid)]);
    TestBed.configureTestingModule({ providers: [{ provide: ApiService, useValue: fakeApi({ collectionBoard: board, collectionLastSync: vi.fn(async () => ({ importId: id })) }) }] });
    const f = TestBed.createComponent(WeekPayments); await settle(f);
    await (f.componentInstance as any).tick(); await settle(f);
    expect(board).toHaveBeenCalledTimes(1);
    id = 'imp-2'; paid = 3000;
    await (f.componentInstance as any).tick(); await settle(f);
    expect(board).toHaveBeenCalledTimes(2); expect((f.nativeElement as HTMLElement).textContent).toContain('Recibido ese día: $30.00');
  });
});

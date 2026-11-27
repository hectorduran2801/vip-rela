import { Component, computed, inject, input } from '@angular/core';
import { formatUSD } from '@vip/shared';
import { dateTime, dayLabel } from '../../core/dates';
import { TIMEZONE, type Movement } from '../../core/models';
import { Breakpoints } from '../../core/services';
import { EmptyState } from '../../shared/ui';

const KIND: Record<Movement['kind'], string> = { charge: 'Cuota diaria', payment: 'Pago', payment_void: 'Anulación', adjustment: 'Ajuste', opening: 'Deuda anterior' };
const GLYPH: Record<Movement['kind'], string> = { charge: '◷', payment: '✓', payment_void: '↺', adjustment: '±', opening: '⏮' };

/** Historial de movimientos (v_movements), solo lectura: los pagos llegan del Excel y no se registran ni anulan a mano. */
@Component({
  selector: 'app-movement-list',
  imports: [EmptyState],
  templateUrl: './movement-list.html',
})
export class MovementList {
  readonly movements = input.required<Movement[]>();
  protected readonly bp = inject(Breakpoints);
  protected readonly usd = formatUSD;
  private readonly tz = computed(() => TIMEZONE);

  /** Más reciente primero (la vista ya viene así; se ordena de nuevo por si cambia el origen). */
  protected readonly sorted = computed(() => [...this.movements()].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)));
  protected kind(m: Movement): string {
    if (m.kind === 'adjustment') return m.amountCents < 0 ? 'Ajuste (−)' : 'Ajuste (+)';
    return KIND[m.kind] ?? 'Movimiento';
  }
  protected glyph(m: Movement): string { return GLYPH[m.kind] ?? '•'; }
  protected chip(m: Movement): string { return m.kind === 'adjustment' ? (m.amountCents < 0 ? 'adjust-down' : 'adjust-up') : m.kind; }
  /** Efecto en la deuda del conductor: cuotas, deuda anterior y ajustes (+) la suben; los pagos la bajan; una anulación la devuelve. */
  protected effect(m: Movement): number { return m.kind === 'payment' || m.kind === 'payment_void' ? -m.amountCents : m.amountCents; }
  protected signed(m: Movement): string { const e = this.effect(m); return `${e > 0 ? '+' : e < 0 ? '−' : ''}${formatUSD(Math.abs(e))}`; }
  protected voided(m: Movement): boolean { return m.kind === 'payment' && m.detail === 'anulado'; }
  protected when(m: Movement): string { return dateTime(m.occurredAt, this.tz()); }
  protected detail(m: Movement): string {
    if (m.kind === 'charge') return dayLabel(m.detail ?? '');
    if (m.kind === 'payment') return m.detail === 'vigente' ? '' : m.detail === 'anulado' ? 'Anulado' : (m.detail ?? '');
    if (m.kind === 'payment_void') return m.detail ? `Motivo: ${m.detail}` : '';
    if (m.kind === 'opening') return (m.detail ?? '').replace(/^Deuda anterior \(apertura\) al /, 'Apertura al ');
    return m.detail ?? '';
  }
}

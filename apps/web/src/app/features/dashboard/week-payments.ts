import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { formatUSD } from '@vip/shared';
import { addDays } from '@vip/shared';
import { mondayOf, shortDate, todayIn } from '../../core/dates';
import { createLoader } from '../../core/loader';
import { TIMEZONE, type CollectionRow } from '../../core/models';
import { ApiService } from '../../core/services';
import { ErrorState, LoadingState } from '../../shared/ui';

type Kind = 'paid' | 'partial' | 'unpaid';
interface Line { id: string; unit: string; name: string; due: number; paid: number; kind: Kind; ended: boolean }
const DAYS = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];

/** Pagos de la SEMANA EN CURSO, día por día (solo lectura, con los datos del Excel). Cada lunes empieza de nuevo; no muestra semanas anteriores. */
@Component({
  selector: 'app-week-payments',
  imports: [ErrorState, LoadingState],
  template: `<section aria-labelledby="wp-h">
    <h2 id="wp-h">Pagos de la semana</h2>
    <p class="muted wp-range">Semana del {{ dayList()[0]!.short }} al {{ dayList()[6]!.short }} · Cambia sola el lunes {{ nextMonday() }} (hora de Panamá).</p>
    <div class="chips" role="group" aria-label="Día">
      @for (d of dayList(); track d.date) {
        <button type="button" class="chip" [class.on]="day() === d.date" [attr.aria-pressed]="day() === d.date" [disabled]="d.date > today()" (click)="choose(d.date)">{{ d.label }} {{ d.short }}@if (d.date === today()) { · Hoy }</button>
      }
    </div>
    @if (board.error(); as e) { <app-error-state [message]="e" (retry)="board.reload()" /> }
    @else if (board.loading() && !board.data().length) { <app-loading variant="table" [rows]="4" /> }
    @else {
      <div class="chips wp-kinds" role="group" aria-label="Ver">
        <button type="button" class="chip" [class.on]="kind() === 'paid'" [attr.aria-pressed]="kind() === 'paid'" (click)="kind.set('paid')">Pagaron completo ({{ count('paid') }})</button>
        <button type="button" class="chip" [class.on]="kind() === 'partial'" [attr.aria-pressed]="kind() === 'partial'" (click)="kind.set('partial')">Pagaron incompleto ({{ count('partial') }})</button>
        <button type="button" class="chip" [class.on]="kind() === 'unpaid'" [attr.aria-pressed]="kind() === 'unpaid'" (click)="kind.set('unpaid')">No pagaron ({{ count('unpaid') }})</button>
      </div>
      <p class="muted">Recibido ese día: <strong>{{ usd(received()) }}</strong>. Según el último Excel importado.</p>
      @if (!shown().length) { <p class="muted">Nadie en esta lista para ese día.</p> }
      @else {
        <ul class="wp-list" aria-label="Conductores">
          @for (l of shown(); track l.id) {
            <li><strong>{{ l.unit }}</strong><span>{{ l.name }}</span><span class="wp-money">Cuota {{ usd(l.due) }} · Pagó {{ usd(l.paid) }}</span></li>
          }
        </ul>
      }
    }
  </section>`,
})
export class WeekPayments {
  private readonly api = inject(ApiService);
  protected readonly usd = formatUSD;
  /** Fecha actual en Panamá. Se revisa sola: la pantalla puede quedar abierta al pasar la medianoche o el lunes. */
  protected readonly today = signal(todayIn(TIMEZONE));
  private readonly monday = computed(() => mondayOf(this.today()));
  protected readonly dayList = computed(() => DAYS.map((label, i) => { const date = addDays(this.monday(), i); return { label, date, short: shortDate(date) }; }));
  protected readonly nextMonday = computed(() => shortDate(addDays(this.monday(), 7)));
  /** Día elegido a mano; null = seguir al día actual. */
  private readonly picked = signal<string | null>(null);
  protected readonly day = computed(() => this.picked() ?? this.today());
  protected readonly kind = signal<Kind>('paid');
  protected readonly board = createLoader(async () => (await this.api.collectionBoard(this.monday())) ?? [], [] as CollectionRow[]);
  private readonly lines = computed<Line[]>(() => this.board.data().flatMap((r) => {
    const d = r.days?.find((x) => x.date === this.day());
    if (!d || (d.dueCents === 0 && d.paidCents === 0)) return [];          // sin cuota ni pago ese día (p. ej. domingo)
    const kind: Kind = d.paidCents === 0 ? 'unpaid' : d.paidCents < d.dueCents ? 'partial' : 'paid';
    return [{ id: r.assignmentId, unit: r.unitCode, name: r.fullName, due: d.dueCents, paid: d.paidCents, kind, ended: r.ended }];
  }));
  protected readonly active = computed(() => this.lines().filter((l) => !l.ended));
  protected readonly shown = computed(() => this.active().filter((l) => l.kind === this.kind()));
  protected readonly received = computed(() => this.lines().reduce((t, l) => t + l.paid, 0));
  protected count(k: Kind): number { return this.active().filter((l) => l.kind === k).length; }
  protected choose(date: string): void { this.picked.set(date === this.today() ? null : date); }

  /** Identificador de la última importación vista: si cambia, se vuelven a pedir los datos. */
  private importId: string | null | undefined;

  /** Cada 30 s (y al volver a la pestaña): ¿cambió el día o la semana?, ¿hubo una importación nueva? Solo cambia lo que se MUESTRA. */
  protected async tick(): Promise<void> {
    const now = todayIn(TIMEZONE);
    const before = this.monday();
    if (now !== this.today()) this.today.set(now);
    if (this.monday() !== before) { this.picked.set(null); await this.board.reload(); }
    const id = await this.lastImport();
    if (id === undefined) return;                                          // sin respuesta: se reintenta en el siguiente ciclo
    if (this.importId !== undefined && id !== this.importId) await this.board.reload();
    this.importId = id;
  }
  private async lastImport(): Promise<string | null | undefined> {
    try { return (await this.api.collectionLastSync())?.importId ?? null; } catch { return undefined; }
  }

  constructor() {
    void this.board.reload();
    void this.lastImport().then((id) => { this.importId ??= id; });
    const timer = setInterval(() => { void this.tick(); }, 30_000);
    const onVisible = (): void => { if (document.visibilityState === 'visible') void this.tick(); };
    document.addEventListener('visibilitychange', onVisible);
    inject(DestroyRef).onDestroy(() => { clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); });
  }
}

import { Component, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { formatUSD } from '@vip/shared';
import { dateTime, dmy, mondayOf, shiftWeek, todayIn } from '../../core/dates';
import { errorMessage } from '../../core/errors';
import { TIMEZONE, type ImportRow, type ImportRowPatch, type SyncResult, type SyncWarning } from '../../core/models';
import { ApiService } from '../../core/services';
import { BusyButton } from '../../shared/busy';
import { ErrText, LoadingState } from '../../shared/ui';

/** ¿La fecha (YYYY-MM-DD) es un lunes válido? */
export const isMondayDate = (d: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(d) && new Date(`${d}T00:00:00Z`).getUTCDay() === 1;
const isErr = (w: SyncWarning): boolean => w.level === 'error' || w.level === 'blocking';

/**
 * Importación diaria del Excel de cobranza: eliges la semana (lunes), VIP muestra qué cambiaría y «Guardar datos» lo aplica
 * de forma idempotente y todo-o-nada. Reimportar el mismo archivo no duplica nada.
 */
@Component({
  selector: 'app-collection-sync',
  imports: [FormsModule, BusyButton, ErrText, LoadingState],
  template: `<section class="panel cs-panel" aria-labelledby="cs-title">
    <h3 id="cs-title">Guardar los datos del Excel</h3>
    <p class="muted one-line">El archivo no trae fecha: elige la <strong>semana (lunes)</strong> a la que corresponden los pagos de LUNES a DOMINGO. Reimportar el mismo archivo no duplica nada; una celda vacía no borra datos.</p>
    @if (!result()?.applied) {
      <div class="field"><label for="cs-week">Semana (lunes)</label>
        <input id="cs-week" type="date" [ngModel]="week()" (ngModelChange)="setWeek($event)" [disabled]="busy()" />
        <div class="actions"><button type="button" class="btn sm" [disabled]="busy()" (click)="setWeek(thisWeek())">Esta semana</button>
          <button type="button" class="btn sm" [disabled]="busy()" (click)="setWeek(lastWeek())">Semana pasada</button></div>
        @if (week() && !valid()) { <small class="hint pending">Esa fecha no es lunes. <button type="button" class="link" (click)="setWeek(monday())">Usar el lunes {{ dmy(monday()) }}</button></small> }
      </div>
      <div class="field"><label for="cs-dd">Fecha de corte de los datos del Excel</label>
        <input id="cs-dd" type="date" [ngModel]="dataDate()" (ngModelChange)="setDataDate($event)" [max]="today()" [disabled]="busy()" />
        <small class="hint">El día al que corresponde la información del archivo (por defecto hoy). Sirve para avisarte si pisas datos más recientes con una copia anterior de la misma semana.</small></div>
    }
    <div aria-live="polite">
      @if (error(); as e) { <div class="alert error" role="alert"><app-err [text]="e" /></div> }
    </div>
    @if (loading()) { <app-loading variant="stats" label="Calculando qué cambiaría…" /> }
    @if (result(); as r) {
      @if (r.applied) {
        <div class="alert ok" role="status"><strong>{{ r.alreadyUpToDate ? 'Sin cambios: VIP ya tenía estos datos.' : 'Datos guardados.' }}</strong> Semana del {{ dmy(r.weekStart) }}.</div>
      }
      <div class="stats stats-6">
        <div class="card stat"><div class="label">Unidades en el archivo</div><div class="value">{{ r.units.total }}</div></div>
        <div class="card stat"><div class="label">Nuevas</div><div class="value" [class.paid]="r.units.new > 0">{{ r.units.new }}</div></div>
        <div class="card stat" title="Unidades con cambios en datos de la unidad, operario, asignación, cuota, saldo, pagos o acuerdo (cada unidad cuenta una vez)"><div class="label">Con cambios</div><div class="value" [class.credit]="r.units.changed > 0">{{ r.units.changed }}</div></div>
        <div class="card stat"><div class="label">Sin cambios</div><div class="value">{{ r.units.unchanged }}</div></div>
        <div class="card stat"><div class="label">Sin conductor</div><div class="value">{{ r.units.withoutDriver }}</div></div>
        <div class="card stat"><div class="label">Errores</div><div class="value" [class.pending]="r.units.errors > 0">{{ r.units.errors }}</div></div>
      </div>
      @if (r.guard; as g) {
        <div class="alert info cs-guard" role="status">Archivo <strong>{{ g.import.fileName }}</strong> subido el {{ when(g.import.uploadedAt) }}@if (g.import.uploadedBy) { por {{ g.import.uploadedBy }} }
          · huella {{ g.import.sha256.slice(0, 10) }}…@if (g.priorRuns.length) { · <strong>ya se importó antes</strong>: @for (p of g.priorRuns.slice(0, 3); track $index) { semana {{ dmy(p.weekStart) }} el {{ when(p.appliedAt) }}@if (p.appliedBy) { ({{ p.appliedBy }}) }{{ $last ? '' : '; ' }} } }
          @if (g.lastRun) { · Última aplicación en VIP: semana {{ dmy(g.lastRun.weekStart) }}, {{ when(g.lastRun.appliedAt) }} ({{ g.lastRun.fileName }}). }</div>
        @if (g.historical && !r.applied) {
          <div class="alert warn cs-hist" role="alert"><strong>Atención: esta importación es antigua.</strong>
            @if (g.reasons.includes('older_week')) { La semana elegida ({{ dmy(r.weekStart) }}) es anterior a la última semana aplicada ({{ dmy(g.latestWeek ?? r.weekStart) }}). }
            @if (g.reasons.includes('older_data_date') && g.newerData) { Los datos de este archivo tienen fecha de corte {{ dmy(g.dataDate ?? r.weekStart) }}, pero ya se aplicaron a esa semana datos del {{ dmy(g.newerData.dataDate) }} ({{ g.newerData.fileName }}). }
            @if (g.reasons.includes('older_file_for_week')) { Este archivo se subió antes que otro que ya se aplicó a esa misma semana: podría sobrescribir datos más recientes. }
            Si es una corrección histórica intencional, confírmalo e indica el motivo (queda auditado).
            <label class="check"><input type="checkbox" [ngModel]="confirmHist()" (ngModelChange)="confirmHist.set($event)" /> Confirmo que quiero aplicar esta importación antigua</label>
            <div class="field"><label for="cs-note">Motivo de la corrección histórica</label><input id="cs-note" [ngModel]="histNote()" (ngModelChange)="histNote.set($event)" maxlength="500" /></div></div>
        }
      }
      @if (r.rateChanges.length) {
        <ul class="plain cs-rates">@for (c of r.rateChanges; track $index) { <li><span class="chip-s" [class.attn]="c.kind === 'correction'" [class.paid]="c.kind === 'contract'">{{ c.kind === 'correction' ? 'Corrección de cuota' : 'Cambio de cuota' }}</span>
          Unidad {{ c.unitCode }}: {{ usd(c.previousCents) }} → {{ usd(c.newCents) }} @if (c.kind === 'correction') { <span class="muted">(se corrige la cuota registrada y se ajusta lo ya generado; los pagos no cambian)</span> } @else { <span class="muted">(rige desde el día siguiente al último cargo generado)</span> }</li> }</ul>
      }
      <ul class="plain">
        <li><strong>Pagos</strong>: {{ r.payments.new }} nuevos · {{ r.payments.changed }} modificados · {{ r.payments.zeroed }} anulados (0 explícito) · {{ r.payments.unchanged }} sin cambio · {{ r.payments.skippedEmpty }} celdas vacías (no se tocan)@if (r.payments.rejected) { · <span class="chip-s attn">{{ r.payments.rejected }} no se pudieron registrar</span> }</li>
        <li><strong>SALDO</strong>: {{ r.saldo.create }} por crear · {{ r.saldo.adjust }} por ajustar · {{ r.saldo.unchanged }} sin cambio · {{ r.saldo.skipEmpty }} vacíos · diferencia {{ usd(r.saldo.deltaCents) }}@if (r.saldo.skippedNoAssignment) { · {{ r.saldo.skippedNoAssignment }} sin operario (no se concilia) }</li>
        @if (r.assignmentsEnded) { <li><strong>Asignaciones finalizadas</strong>: {{ r.assignmentsEnded }} (unidades que quedaron sin operario; se conserva su historial)</li> }
        @if (r.drivers.created || r.drivers.updated || r.assignmentsCreated) { <li><strong>Operarios</strong>: {{ r.drivers.created }} creados · {{ r.drivers.updated }} actualizados · {{ r.assignmentsCreated }} asignaciones nuevas</li> }
        @if (r.blocked) { <li class="pending"><strong>{{ r.blocked }}</strong> cambio(s) bloqueado(s) (semana cerrada o cambio retroactivo): revisa los avisos.</li> }
      </ul>
      @if (errors().length) {
        <div class="alert error" role="alert"><strong>Corrige estas filas en el Excel y vuelve a subirlo. No se guarda nada mientras haya errores.</strong>
          <ul class="plain">@for (w of errors(); track $index) { <li>Fila {{ w.row }} · columna «{{ w.column }}»: {{ w.message }}</li> }</ul></div>
      }
      <h4 id="cs-tbl">Tabla que se va a importar</h4>
      <p class="muted one-line cs-help">Las filas en <span class="chip-s pending">rojo</span> tienen errores y no se pueden guardar; las <span class="chip-s attn">amarillas</span> traen avisos que no impiden guardar. Las celdas marcadas son las que dieron el aviso: puedes corregirlas aquí mismo (cambia solo VIP; si quieres que no vuelva a pasar, corrige también el Excel).</p>
      <div class="chips sm cs-filters" role="group" aria-label="Filtrar filas">
        @for (f of rowFilters; track f.value) { <button type="button" class="chip" [attr.aria-pressed]="rowFilter() === f.value" (click)="rowFilter.set(f.value)">{{ f.label }} ({{ counts()[f.value] }})</button> }
      </div>
      @if (saving()) { <span class="muted" role="status">Guardando cambio…</span> }
      @if (annotated().length) {
      <div class="cs-wrap">
        <table class="cs-table" aria-labelledby="cs-tbl">
          <colgroup><col style="width:60px" /><col style="width:100px" /><col style="width:120px" /><col style="width:280px" /><col style="width:150px" /><col style="width:150px" />
            <col style="width:110px" /><col style="width:110px" /><col style="width:250px" />@for (d of days; track d) { <col style="width:100px" /> }<col style="width:280px" /></colgroup>
          <thead><tr>
            <th scope="col" class="cs-fix cs-c1 cs-rowno">Fila</th><th scope="col" class="cs-fix cs-c2">Unidad</th><th scope="col">Operario</th><th scope="col">Nombre completo</th><th scope="col">Cédula (opcional)</th><th scope="col">WhatsApp</th>
            <th scope="col" class="num">Cuota</th><th scope="col" class="num">Saldo</th><th scope="col">Acuerdo</th>
            @for (d of days; track d) { <th scope="col" class="num">{{ dayName(d) }}</th> }
            <th scope="col">Qué pasa</th>
          </tr></thead>
          <tbody>
            @for (x of shownRows(); track x.row.id) {
              <tr [class.cs-err]="x.level === 'error'" [class.cs-warn]="x.level === 'warn'">
                <td class="cs-fix cs-c1 cs-rowno">{{ x.row.sourceRow }}</td>
                <td class="cs-fix cs-c2" [class]="cell(x, 'und')"><input class="cs-in" [value]="x.row.unitCode ?? ''" (change)="edit(x.row, { unitCode: val($event) })" aria-label="Unidad" /></td>
                <td [class]="cell(x, 'operador')"><input class="cs-in" [value]="x.row.operatorCode ?? ''" (change)="edit(x.row, { operatorCode: val($event) })" aria-label="Operario" /></td>
                <td [class]="cell(x, 'nombre')"><input class="cs-in" [value]="x.row.fullName ?? ''" (change)="edit(x.row, { fullName: val($event) })" aria-label="Nombre completo" /></td>
                <td><input class="cs-in" [value]="x.row.nationalId ?? ''" (change)="edit(x.row, { nationalId: val($event) })" aria-label="Cédula (opcional)" /></td>
                <td [class]="cell(x, 'whatsapp')"><input class="cs-in" [value]="x.row.rawPhone ?? x.row.phoneE164 ?? ''" (change)="edit(x.row, { phone: val($event) })" aria-label="WhatsApp" /></td>
                <td class="num" [class]="cell(x, 'cuenta')"><input class="cs-in num" inputmode="decimal" [value]="money(x.row.dailyRateCents)" (change)="edit(x.row, { dailyRateCents: cents($event) })" aria-label="Cuota diaria" /></td>
                <td class="num" [class]="cell(x, 'saldo')"><input class="cs-in num" [value]="x.row.rawSaldo ?? ''" (change)="edit(x.row, { rawSaldo: val($event) })" aria-label="Saldo" /></td>
                <td [class]="cell(x, 'acuerdo')"><textarea class="cs-in" rows="1" [value]="x.row.rawAgreement ?? ''" (change)="edit(x.row, { rawAgreement: val($event) })" aria-label="Acuerdo"></textarea></td>
                @for (d of days; track d; let i = $index) {
                  <td class="num" [class]="cell(x, d, 'pagos')"><input class="cs-in num" inputmode="decimal" [value]="money(x.row.dayAmountsCents[i] ?? null)" (change)="editDay(x.row, i, $event)" [attr.aria-label]="'Pago del ' + d" /></td>
                }
                <td class="cs-why">@for (w of x.warns; track $index) { <div [class.pending]="isErr(w)">{{ w.message }}</div> }@if (!x.warns.length) { <span class="muted">Todo bien</span> }</td>
              </tr>
            }
          </tbody>
        </table>
      </div>
      }
      @if (!r.applied) {
        <div class="actions cs-actions">
          <button type="button" class="btn primary" [disabled]="busy() || r.units.errors > 0 || !valid() || (!!r.guard?.historical && !(confirmHist() && histNote().trim().length >= 3))" [appBusy]="busy()" busyLabel="Guardando…" (click)="apply()">Guardar datos</button>
          <button type="button" class="btn" [disabled]="busy()" (click)="cancel.emit()">Descartar</button>
        </div>
      }
    }
  </section>`,
})
export class CollectionSync {
  private readonly api = inject(ApiService);
  readonly importId = input.required<string>();
  readonly applied = output<void>();
  readonly cancel = output<void>();
  protected readonly usd = formatUSD;
  protected readonly dmy = dmy;
  protected readonly monday = computed(() => mondayOf(this.week() || todayIn(TIMEZONE)));
  protected readonly week = signal(mondayOf(todayIn(TIMEZONE)));
  protected readonly valid = computed(() => isMondayDate(this.week()));
  protected readonly result = signal<SyncResult | null>(null);
  protected readonly loading = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly days = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];
  protected readonly rowFilters: { value: 'issues' | 'error' | 'ok' | 'all'; label: string }[] = [{ value: 'issues', label: 'Con avisos o errores' }, { value: 'error', label: 'Con errores' }, { value: 'ok', label: 'Sin problemas' }, { value: 'all', label: 'Todas' }];
  protected readonly rowFilter = signal<'issues' | 'error' | 'ok' | 'all'>('issues');
  private readonly rowsSig = signal<ImportRow[]>([]);
  protected readonly saving = signal(false);
  protected readonly dataDate = signal(todayIn(TIMEZONE));
  protected readonly today = (): string => todayIn(TIMEZONE);
  protected setDataDate(v: string): void { this.dataDate.set(v); this.confirmHist.set(false); if (v && v <= todayIn(TIMEZONE)) void this.preview(); }
  protected readonly confirmHist = signal(false);
  protected readonly histNote = signal('');
  protected readonly when = (iso: string): string => dateTime(iso, TIMEZONE);
  protected readonly isErr = isErr;
  /** Cada fila con su gravedad, sus avisos y las columnas a marcar. */
  protected readonly annotated = computed(() => {
    const by = new Map<number, SyncWarning[]>();
    for (const w of this.result()?.warnings ?? []) by.set(w.row, [...(by.get(w.row) ?? []), w]);
    return this.rowsSig().map((row) => {
      const warns = by.get(row.sourceRow) ?? [];
      return { row, warns, cols: new Set(warns.map((w) => w.column)), level: warns.some(isErr) ? 'error' as const : warns.length ? 'warn' as const : 'ok' as const };
    });
  });
  protected readonly counts = computed(() => { const a = this.annotated(); return { issues: a.filter((x) => x.level !== 'ok').length, error: a.filter((x) => x.level === 'error').length, ok: a.filter((x) => x.level === 'ok').length, all: a.length }; });
  protected readonly shownRows = computed(() => this.annotated().filter((x) => { const f = this.rowFilter(); return f === 'all' || (f === 'issues' && x.level !== 'ok') || (f === 'error' && x.level === 'error') || (f === 'ok' && x.level === 'ok'); }));
  protected dayName(d: string): string { return d.charAt(0).toUpperCase() + d.slice(1); }
  /** Clase de una celda: roja si algún aviso de esa columna es un error; amarilla si solo hay avisos. */
  protected cell(x: { warns: SyncWarning[] }, ...cols: string[]): string {
    const w = x.warns.filter((k) => cols.includes(k.column));
    return w.some(isErr) ? 'cs-bad-err' : w.length ? 'cs-bad-warn' : '';
  }
  protected val(ev: Event): string | null { const v = (ev.target as HTMLInputElement).value.trim(); return v === '' ? null : v; }
  protected money(c: number | null | undefined): string { return c === null || c === undefined ? '' : (c / 100).toFixed(2); }
  protected cents(ev: Event): number | null {
    const v = (ev.target as HTMLInputElement).value.trim().replace(',', '.').replace(/^\$/, '');
    if (v === '') return null; const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
  }
  protected editDay(row: ImportRow, i: number, ev: Event): void {
    const arr = Array.from({ length: 7 }, (_, k) => row.dayAmountsCents[k] ?? null); arr[i] = this.cents(ev);
    void this.edit(row, { dayAmountsCents: arr });
  }
  protected async edit(row: ImportRow, patch: ImportRowPatch): Promise<void> {
    if (this.saving() || this.result()?.applied) return;
    this.saving.set(true); this.error.set(null);
    try { await this.api.updateImportRow(this.importId(), row.id, patch); await this.loadRows(); await this.preview(); }
    catch (e) { this.error.set(errorMessage(e)); } finally { this.saving.set(false); }
  }
  private async loadRows(): Promise<void> { this.rowsSig.set((await this.api.importRows(this.importId(), {})) ?? []); }
  protected readonly errors = computed(() => (this.result()?.warnings ?? []).filter(isErr));
  protected readonly notes = computed(() => (this.result()?.warnings ?? []).filter((w) => !isErr(w)));
  protected readonly thisWeek = () => mondayOf(todayIn(TIMEZONE));
  protected readonly lastWeek = () => shiftWeek(mondayOf(todayIn(TIMEZONE)), -1);
  /** Avisos agrupados por tipo: una línea por tipo con cuántas filas afecta. */
  protected readonly noteGroups = computed(() => {
    const m = new Map<string, { code: string; message: string; count: number; rows: number[] }>();
    for (const w of this.notes()) { const g = m.get(w.code) ?? { code: w.code, message: w.message.replace(/\s*\d{2}\/\d{2}\/\d{4}/, ''), count: 0, rows: [] }; g.count++; g.rows.push(w.row); m.set(w.code, g); }
    return [...m.values()].sort((a, b) => b.count - a.count);
  });
  private seq = 0;

  constructor() { queueMicrotask(async () => { try { await this.loadRows(); } catch (e) { this.error.set(errorMessage(e)); } void this.preview(); }); }

  protected setWeek(v: string): void { this.confirmHist.set(false); this.week.set(v); if (isMondayDate(v)) void this.preview(); else this.result.set(null); }

  protected async preview(): Promise<void> {
    if (!this.valid()) return;
    const mine = ++this.seq;
    this.loading.set(true); this.error.set(null);
    try { const r = await this.api.syncPreview(this.importId(), this.week(), this.dataDate() || undefined); if (mine === this.seq) this.result.set(r); }
    catch (e) { if (mine === this.seq) { this.result.set(null); this.error.set(errorMessage(e)); } }
    finally { if (mine === this.seq) this.loading.set(false); }
  }

  protected async apply(): Promise<void> {
    if (this.busy() || !this.valid() || (this.result()?.units.errors ?? 0) > 0) return;
    this.busy.set(true); this.error.set(null);
    try { this.result.set(await this.api.syncApply(this.importId(), this.week(), this.histNote(), this.confirmHist(), this.dataDate() || undefined)); this.applied.emit(); }
    catch (e) { this.error.set(errorMessage(e)); }
    finally { this.busy.set(false); }
  }
}

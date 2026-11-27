import { Component, DestroyRef, effect, inject, signal, untracked } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { dateTime } from '../../core/dates';
import { createLoader } from '../../core/loader';
import { DRIVER_MESSAGE_LABEL, TIMEZONE, type CollectionBatch, type CollectionMessage, type TestMessageStatus } from '../../core/models';
import { formatPhone } from '../../core/phone';
import { ApiService } from '../../core/services';
import { EmptyState, ErrorState, LoadingState } from '../../shared/ui';

/** Etiquetas y orden de los «valores usados» (las claves internas no se muestran). */
const VAR_LABELS: [string, string][] = [['nombre_completo', 'Nombre completo'], ['nombre', 'Nombre'], ['unidad', 'Unidad'], ['codigo_operario', 'Operario'], ['fecha', 'Fecha'], ['dia_semana', 'Día'],
  ['cuota_diaria', 'Cuota diaria'], ['cuota_hoy', 'Cuota de hoy'], ['pago_hoy', 'Pago de hoy'], ['pagos_semana', 'Pagado en la semana'], ['cuenta_semanal', 'Cuenta semanal'],
  ['saldo_total', 'Saldo pendiente (Excel)'], ['deuda_anterior', 'Saldo del Excel'], ['credito', 'Crédito a favor'], ['detalle_deuda', 'Detalle del saldo'], ['acuerdo', 'Acuerdo']];
/**
 * Historial de mensajes de cobranza. Por DÍA (zona America/Panama) y por LOTE de envío masivo: a quién, con qué plantilla, el texto exacto, el estado,
 * el responsable y la importación del Excel con la que se redactó. El historial se conserva siempre (importar de nuevo no lo toca).
 */
@Component({
  selector: 'app-message-history',
  imports: [EmptyState, ErrorState, LoadingState],
  template: `<div class="page">
    <p class="muted one-line">Mensajes de <strong>hoy</strong> (hora de Panamá). A las 12:00 a. m. empieza una jornada nueva: los mensajes de días anteriores se eliminan.</p>
    @if (batch()) { <div class="filterbar"><button type="button" class="btn sm" (click)="batch.set('')">Quitar filtro de lote</button></div> }

    <h2 id="mh-b">Lotes de envío</h2>
    @if (batches.error(); as e) { <app-error-state [message]="e" (retry)="batches.reload()" /> }
    @if (batches.loading() && !batches.data().length) { <app-loading variant="table" [rows]="3" /> }
    @else if (!batches.error() && !batches.data().length) { <p class="muted">No hay envíos masivos en este período.</p> }
    @else {
      <ul class="plain msg-hist" aria-labelledby="mh-b">
        @for (b of batches.data(); track b.batchId) {
          <li class="card" [class.sel]="batch() === b.batchId">
            <div class="row"><strong>«{{ b.template ?? '—' }}»</strong><span class="muted">{{ when(b.firstAt) }}@if (b.sentBy) { · {{ b.sentBy }} }</span><span class="grow"></span>
              <span class="chip-s paid">{{ b.sent }} enviados</span> @if (b.queued) { <span class="chip-s">{{ b.queued }} en cola</span> } @if (b.failed) { <span class="chip-s attn">{{ b.failed }} con problema</span> }
              <button type="button" class="btn sm" (click)="batch.set(b.batchId)">Ver {{ b.total }} mensajes</button></div>
            <div class="batch-bar" role="progressbar" aria-label="Avance del lote" [attr.aria-valuenow]="done(b)" aria-valuemin="0" aria-valuemax="100">
              <span class="ok" [style.width.%]="pct(b.sent, b.total)"></span><span class="bad" [style.width.%]="pct(b.failed, b.total)"></span><span class="wait" [class.live]="b.queued > 0" [style.width.%]="pct(b.queued, b.total)"></span>
            </div>
            <div class="muted">@if (b.queued) { Enviando… {{ b.total - b.queued }} de {{ b.total }} procesados ({{ done(b) }} %). Se actualiza solo. } @else { Lote terminado: {{ b.sent }} de {{ b.total }} enviados@if (b.failed) { , {{ b.failed }} con problema }. }</div>
          </li>
        }
      </ul>
    }

    <h2 id="mh-m">Mensajes</h2>
    @if (list.error(); as e) { <app-error-state [message]="e" (retry)="list.reload()" /> }
    @if (list.loading() && !list.data().length) { <app-loading variant="table" [rows]="5" /> }
    @else if (!list.error() && !list.data().length) { <app-empty-state icon="chat" title="Sin mensajes" hint="No hay mensajes de cobranza en este período. Selecciona operarios en Cobranza y envía una plantilla." /> }
    @else {
      <ul class="plain msg-hist" aria-labelledby="mh-m">
        @for (m of list.data(); track m.id) {
          <li class="card">
            <div class="row"><strong>{{ m.unitCode ? m.unitCode + ' · ' : '' }}{{ m.name }}</strong><span class="muted">{{ fmt(m.phone) }}</span><span class="grow"></span>
              <span class="chip-s" [class.paid]="ok(m)" [class.attn]="!ok(m)">{{ label(m.status) }}</span></div>
            <div class="muted">Operario {{ m.operatorCode }} · Plantilla «{{ m.template ?? '—' }}» · {{ when(m.at) }}@if (m.sentBy) { · Enviado por {{ m.sentBy }} }</div>
            @if (m.importFile) { <div class="muted">Datos de la importación {{ m.importFile }}@if (m.importAppliedAt) { del {{ when(m.importAppliedAt) }} }</div> }
            <pre class="cob-msg">{{ m.body }}</pre>
            @if (m.error) { <div class="muted">Motivo: {{ m.error }}</div> }
            @if (m.variables) { <details><summary class="muted">Valores usados</summary><dl class="kv">@for (v of vars(m); track v[0]) { <dt>{{ v[0] }}</dt><dd>{{ v[1] }}</dd> }</dl></details> }
          </li>
        }
      </ul>
    }
  </div>`,
})
export class MessageHistory {
  private readonly api = inject(ApiService);
  protected readonly batch = signal('');
  protected readonly list = createLoader(async () => (await this.api.collectionMessages({ batch: this.batch() || undefined })) ?? [], [] as CollectionMessage[]);
  protected readonly batches = createLoader(async () => (await this.api.collectionBatches()) ?? [], [] as CollectionBatch[]);
  protected readonly fmt = formatPhone;
  protected readonly pct = (n: number, t: number): number => (t ? (n / t) * 100 : 0);
  protected readonly done = (b: CollectionBatch): number => (b.total ? Math.round(((b.total - b.queued) / b.total) * 100) : 0);
  protected readonly when = (iso: string): string => dateTime(iso, TIMEZONE);
  protected readonly label = (s: string): string => DRIVER_MESSAGE_LABEL[s as TestMessageStatus] ?? s;
  protected readonly ok = (m: CollectionMessage): boolean => ['sent', 'delivered', 'simulated', 'prepared', 'processing'].includes(m.status);
  protected vars(m: CollectionMessage): [string, string][] { const v = m.variables ?? {}; return VAR_LABELS.filter(([k]) => v[k] !== null && v[k] !== undefined && v[k] !== '').map(([k, l]) => [l, String(v[k])]); }
  constructor() {
    const q = inject(ActivatedRoute).snapshot.queryParamMap.get('batch'); if (q) this.batch.set(q);
    // Se actualiza solo mientras haya mensajes en cola (no hace falta salir y volver a entrar).
    const timer = setInterval(() => { if (this.batches.data().some((b) => b.queued > 0)) { void this.batches.reload(); void this.list.reload(); } }, 4000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
    void this.batches.reload(); effect(() => { this.batch(); untracked(() => { void this.list.reload(); }); });
  }
}

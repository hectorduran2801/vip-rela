import { Component, computed, inject, input, output, signal } from '@angular/core';
import { formatDateTime12h } from '../../core/dates';
import { errorMessage } from '../../core/errors';
import { DRIVER_MESSAGE_LABEL, TIMEZONE, type DriverMessage, type TestMessageStatus } from '../../core/models';
import { formatPhone } from '../../core/phone';
import { ApiService } from '../../core/services';
import { ErrText } from '../../shared/ui';
import { BusyButton } from '../../shared/busy';
import { IconButton } from '../../shared/icon-button';

/** Verde: simulado/enviado/entregado. Ámbar: en curso y «sin confirmar» (advertencia). Rojo: solo fallo confirmado. */
export const messageTone = (s: TestMessageStatus): string => (s === 'delivered' || s === 'sent' || s === 'simulated' ? 'paid' : s === 'failed' ? 'pending' : s === 'unconfirmed' || s === 'prepared' || s === 'processing' ? 'attn' : '');
export const OPEN_STATUSES: readonly TestMessageStatus[] = ['prepared', 'processing'];

/** Fila compacta de un mensaje a conductor: chip de estado, «Detalle» técnico plegable, cancelar (en cola) y resolver «sin confirmar». */
@Component({
  selector: 'app-driver-message-item',
  imports: [IconButton, BusyButton, ErrText],
  template: `<div class="wt-li-head"><span class="chip-s" [class]="'chip-s ' + tone()">{{ labels[m().status] }}</span>
      <strong>{{ who() }}</strong><span class="muted">{{ phone() }}</span>
      <span class="muted wt-when">{{ time(m().createdAt) }}</span>
      <app-icon-button icon="eye" label="Ver detalle del mensaje" [expanded]="open()" [controls]="'dm-d-' + m().id" (click)="open.set(!open())" />
      @if (m().status === 'prepared') { <button type="button" class="btn sm" [disabled]="busy()" (click)="cancel()" [appBusy]="busy()" busyLabel="Cancelando…">Cancelar</button> }</div>
    <p class="wt-body dm-body">{{ m().body }}</p>
    @if (m().status === 'unconfirmed') {
      <p class="wa-line warn" role="status"><span>WhatsApp pudo haber aceptado este mensaje. Revisa el chat del destinatario antes de reintentar.</span>
        <button type="button" class="btn sm" (click)="ask(true)">Sí llegó</button><button type="button" class="btn sm" (click)="ask(false)">No llegó</button></p>
      @if (resolving(); as r) {
        <div class="wt-box" role="alertdialog" aria-label="Confirmar resultado">
          <p><strong>{{ r.arrived ? 'Marcar como enviado (sí llegó)' : 'Marcar como fallido (no llegó)' }}.</strong> No se puede deshacer.</p>
          <div class="field"><label [for]="'dm-n-' + m().id">Nota (opcional)</label><input [id]="'dm-n-' + m().id" maxlength="300" autocomplete="off" [value]="note()" (input)="note.set($any($event.target).value)" /></div>
          <div class="wt-row"><button type="button" class="btn sm" (click)="resolving.set(null)">Volver</button><button type="button" class="btn sm primary" [disabled]="busy()" (click)="confirm()" [appBusy]="busy()" busyLabel="Guardando…">Confirmar</button></div>
        </div>
      }
    }
    @if (error(); as e) { <p class="wa-line bad" role="alert"><span><app-err [text]="e" /></span></p> }
    @if (open()) {
      <div class="wt-box" [id]="'dm-d-' + m().id" role="region" aria-label="Detalle del mensaje">
        <dl class="wt-kv">
          <div><dt>Operación</dt><dd>{{ m().id }}</dd></div><div><dt>Emisor</dt><dd>{{ m().senderPhone ? fmt(m().senderPhone!) : '—' }}</dd></div>
          <div><dt>Id del proveedor</dt><dd>{{ m().providerMessageId ?? '—' }}</dd></div><div><dt>Autorizó (usuario)</dt><dd>{{ m().authorizedBy ?? '—' }}</dd></div>
          <div><dt>Creado</dt><dd>{{ time(m().createdAt) }}</dd></div><div><dt>Reclamado</dt><dd>{{ m().claimedAt ? time(m().claimedAt!) : '—' }}</dd></div>
          <div><dt>Procesado</dt><dd>{{ m().processedAt ? time(m().processedAt!) : '—' }}</dd></div><div><dt>Entregado</dt><dd>{{ m().deliveredAt ? time(m().deliveredAt!) : '—' }}</dd></div>
        </dl>
        @if (m().error || m().errorDetail) { <details class="err-detail"><summary>Error técnico</summary>@if (m().error) { <pre class="wt-pre">{{ m().error }}</pre> }@if (m().errorDetail) { <pre class="wt-pre">{{ m().errorDetail }}</pre> }</details> }
        @if (m().resolvedAt) { <p class="muted">Resuelto {{ time(m().resolvedAt!) }}@if (m().resolvedBy) { por {{ m().resolvedBy }} }@if (m().resolutionNote) { · «{{ m().resolutionNote }}» }</p> }
        @if (m().status === 'sent') { <small class="muted">El proveedor lo aceptó; aún no hay confirmación de entrega.</small> }
      </div>
    }`,
})
export class DriverMessageItem {
  readonly message = input.required<DriverMessage>();
  readonly changed = output<void>();
  private readonly api = inject(ApiService);
  protected readonly labels = DRIVER_MESSAGE_LABEL;
  protected readonly fmt = formatPhone;
  protected readonly time = (iso: string): string => formatDateTime12h(iso, TIMEZONE);
  protected readonly m = this.message;
  protected readonly tone = computed(() => messageTone(this.m().status));
  protected readonly who = computed(() => [this.m().firstName, this.m().lastName].filter(Boolean).join(' ') || 'Conductor');
  protected readonly phone = computed(() => formatPhone(this.m().recipientPhone));
  protected readonly open = signal(false);
  protected readonly resolving = signal<{ arrived: boolean } | null>(null);
  protected readonly note = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  protected ask(arrived: boolean): void { this.note.set(''); this.resolving.set({ arrived }); }
  private async run(fn: () => Promise<unknown>): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true); this.error.set(null);
    try { await fn(); this.resolving.set(null); this.changed.emit(); } catch (e) { this.error.set(errorMessage(e)); } finally { this.busy.set(false); }
  }
  protected confirm(): Promise<void> { const r = this.resolving(); return r ? this.run(() => this.api.resolveDriverMessage(this.m().id, r.arrived, this.note())) : Promise.resolve(); }
  protected cancel(): Promise<void> { return this.run(() => this.api.cancelDriverMessage(this.m().id)); }
}

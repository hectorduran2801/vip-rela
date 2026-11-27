import { Component, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { formatUSD } from '@vip/shared';
import { todayIn } from '../core/dates';
import { ApiError, SAVE_TIMEOUT_MS, errorMessage, splitError, timedOut, withTimeout } from '../core/errors';
import { TIMEZONE, type ArchiveResult, type DeleteCheck, type EntityKind } from '../core/models';
import { Perms } from '../core/permissions';
import { ApiService } from '../core/services';
import { BusyButton } from './busy';
import { IconButton } from './icon-button';
import { Modal } from './modal';
import { ModalError } from './modal-error';
import { ToastService } from './toast';

const BLOCKERS: Record<string, string> = {
  payments: 'pagos', adjustments: 'ajustes', closures: 'cierres semanales', non_daily_charges: 'cargos que no son cuotas diarias', opening_charges: 'deudas anteriores (apertura)',
  sent_notifications: 'avisos enviados', sent_messages: 'mensajes enviados', in_flight: 'mensajes en curso',
};
const SLOW = 'El servidor tardó demasiado en responder. Inténtalo de nuevo.';
const explain = (e: unknown): string => (timedOut(e) ? SLOW : errorMessage(e));
const WILL_DELETE: Record<string, string> = {
  assignments: 'asignaciones', daily_charges: 'cuotas diarias', rates: 'tarifas', exceptions: 'excepciones de tarifa', pending_jobs: 'avisos pendientes', consents: 'autorizaciones de WhatsApp',
  unsent_messages: 'mensajes sin enviar', import_rows_unlinked: 'filas de importación desvinculadas', agreement_history: 'historial de acuerdos',
};
/** Lista llana «3 pagos, 2 ajustes» con solo los conteos mayores que cero. */
export function plainCounts(counts: Record<string, number>, labels: Record<string, string>): string {
  return Object.entries(counts).filter(([k, v]) => Number(v) > 0 && labels[k]).map(([k, v]) => `${v} ${labels[k]}`).join(', ');
}

/**
 * Eliminar / Dar de baja / Reactivar un conductor o una unidad. Iconos con tooltip; cada acción abre una confirmación en lenguaje llano:
 *  - Eliminar: revisa antes (delete-check). Si se puede, muestra qué se borrará (conteos); si está bloqueado por historial, lo explica y ofrece «Dar de baja» (nunca un error técnico).
 *  - Dar de baja (archivar): baja reversible; cierra asignaciones vigentes, completa cuotas hasta la fecha y cancela avisos pendientes.
 *  - Reactivar: vuelve a activarlo.
 */
@Component({
  selector: 'app-manage-entity',
  imports: [BusyButton, FormsModule, IconButton, Modal, ModalError],
  template: `@if (perms.canOperate()) {
    <span class="icon-actions" role="group" [attr.aria-label]="'Baja y eliminación de ' + name()">
      @if (archived()) { <app-icon-button icon="playcircle" [label]="'Reactivar ' + noun()" [labelOnMobile]="labelOnMobile()" [busy]="busy() && mode() === 'reactivate'" (click)="reactivate()" /> }
      @else { <app-icon-button icon="archive" [label]="archiveLabel()" [labelOnMobile]="labelOnMobile()" (click)="openArchive()" /> }
      <app-icon-button icon="trash" [label]="'Eliminar ' + noun()" tone="danger" [labelOnMobile]="labelOnMobile()" [busy]="busy() && mode() === 'checking'" (click)="openDelete()" />
    </span>
    @if (mode() === 'delete') {
      <form (ngSubmit)="doDelete()" novalidate>
        <app-modal #dm [alert]="true" size="sm" [title]="'Eliminar ' + noun()" [busy]="busy()" (closed)="close()">
          <p><strong>¿Eliminar {{ article() }} {{ noun() }} {{ name() }}?</strong></p>
          @if (willDelete()) { <p>Se borrará para siempre: <strong>{{ willDelete() }}</strong>.</p> } @else { <p>No tiene historial ni datos asociados: se borrará solo {{ article() }} {{ noun() }}.</p> }
          <p class="muted">No tiene pagos, ajustes ni mensajes enviados, por eso se puede eliminar. Esta acción no se puede deshacer.</p>
          <div class="field"><label for="me-reason">Motivo (opcional)</label><input id="me-reason" name="reason" autocomplete="off" maxlength="300" [ngModel]="reason()" (ngModelChange)="reason.set($event)" /></div>
          @if (error(); as e) { <app-modal-error title="No se pudo eliminar" [text]="e" /> }
          <div modalFooter class="form-actions"><button type="button" class="btn" [disabled]="busy()" (click)="dm.requestClose()">Cancelar</button>
            <button type="submit" class="btn danger" [disabled]="busy()" [appBusy]="busy()" busyLabel="Eliminando…">{{ 'Eliminar ' + noun() }}</button></div>
        </app-modal>
      </form>
    }
    @if (mode() === 'blocked') {
      <app-modal #bm [alert]="true" size="sm" [title]="'No se puede eliminar ' + article() + ' ' + noun()" (closed)="close()">
        <p>Tiene historial que se debe conservar: <strong>{{ blockedText() || 'movimientos registrados' }}</strong>.</p>
        <p>Lo que sí puedes hacer es <strong>darlo de baja</strong>: deja de aparecer como activo, se cierran sus asignaciones y se cancelan los avisos pendientes, pero el historial se conserva y puedes reactivarlo cuando quieras.</p>
        @if (assignmentsText()) { <p class="muted">Asignación vigente: {{ assignmentsText() }}. Se cerrará al darlo de baja.</p> }
        <div modalFooter class="form-actions"><button type="button" class="btn" (click)="bm.requestClose()">Cancelar</button>
          <button type="button" class="btn primary" (click)="mode.set('archive')">Dar de baja…</button></div>
      </app-modal>
    }
    @if (mode() === 'archive') {
      <form (ngSubmit)="doArchive()" novalidate>
        <app-modal #am size="sm" [alert]="true" [title]="'Dar de baja ' + article() + ' ' + noun()" [busy]="busy()" (closed)="close()">
          <p><strong>¿Dar de baja {{ article() }} {{ noun() }} {{ name() }}?</strong> Se conserva todo el historial. Se cerrarán sus asignaciones vigentes, se completarán las cuotas hasta la fecha indicada y se cancelarán los avisos y mensajes pendientes. Puedes reactivarlo después.</p>
          @if (assignmentsText()) { <p class="muted">Asignación vigente: {{ assignmentsText() }}.</p> }
          <div class="field"><label for="me-date">Fecha efectiva</label><input id="me-date" name="eff" type="date" [ngModel]="effective()" (ngModelChange)="effective.set($event)" /></div>
          <div class="field"><label for="me-reason2">Motivo (opcional)</label><input id="me-reason2" name="reason2" autocomplete="off" maxlength="300" [ngModel]="reason()" (ngModelChange)="reason.set($event)" /></div>
          @if (error(); as e) { <app-modal-error title="No se pudo dar de baja" [text]="e" /> }
          <div modalFooter class="form-actions"><button type="button" class="btn" [disabled]="busy()" (click)="am.requestClose()">Cancelar</button>
            <button type="submit" class="btn primary" [disabled]="busy()" [appBusy]="busy()" busyLabel="Archivando…">Dar de baja</button></div>
        </app-modal>
      </form>
    }
  }`,
})
export class ManageEntity {
  protected readonly perms = inject(Perms);
  private readonly apiOpt = inject(ApiService, { optional: true });
  private get api(): ApiService { if (!this.apiOpt) throw new Error('ApiService no disponible'); return this.apiOpt; }
  readonly kind = input.required<EntityKind>();
  readonly entityId = input.required<string>();
  /** Nombre a mostrar en los textos («Ana Pérez», «T-1»). */
  readonly name = input.required<string>();
  /** Está dado de baja: se ofrece Reactivar en lugar de Dar de baja. */
  readonly archived = input(false);
  readonly labelOnMobile = input(false);
  /** Cambió el estado (dar de baja / reactivar): la pantalla debe recargar. */
  readonly changed = output<void>();
  /** Se eliminó: la pantalla debe salir de la ficha. */
  readonly deleted = output<void>();

  protected readonly mode = signal<'idle' | 'checking' | 'delete' | 'blocked' | 'archive' | 'reactivate'>('idle');
  protected readonly check = signal<DeleteCheck | null>(null);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly reason = signal('');
  protected readonly effective = signal(todayIn(TIMEZONE));
  private readonly blockers = signal<Record<string, number>>({});

  protected readonly noun = computed(() => (this.kind() === 'drivers' ? 'conductor' : 'unidad'));
  protected readonly article = computed(() => (this.kind() === 'drivers' ? 'al' : 'a la'));
  protected readonly archiveLabel = computed(() => (this.kind() === 'drivers' ? 'Dar de baja al conductor' : 'Dar de baja la unidad'));
  protected readonly willDelete = computed(() => plainCounts(this.check()?.willDelete ?? {}, WILL_DELETE));
  protected readonly blockedText = computed(() => plainCounts(this.blockers(), BLOCKERS));
  protected readonly assignmentsText = computed(() => (this.check()?.activeAssignments ?? []).filter((a) => !a.valid_to).map((a) => [a.unit_code, a.driver_name].filter(Boolean).join(' · ')).filter(Boolean).join('; '));

  /** Resultados y errores van como aviso emergente: estos botones viven en una celda de la tabla. El detalle técnico no se muestra. */
  private readonly toasts = inject(ToastService);
  private fail(e: unknown): void { this.toasts.error(splitError(explain(e)).message); }

  /**
   * Tras agotar el tiempo en una escritura NO se sabe si se hizo: se consulta el estado real. `true` = hecha, `false` = no, `null` = no se pudo saber.
   * Si no está hecha se cierra la confirmación: repetir exige volver a revisar (y la base rechaza duplicados).
   */
  private async verify(action: 'delete' | 'archive' | 'reactivate'): Promise<boolean> {
    let done: boolean | null;
    try {
      const c = await withTimeout(this.api.deleteCheck(this.kind(), this.entityId()), SAVE_TIMEOUT_MS);
      done = action === 'archive' ? !!c.archived : action === 'reactivate' ? !c.archived : false;
    } catch (e) {
      done = action === 'delete' && e instanceof ApiError && /_not_found$/.test(e.code) ? true : null;
    }
    this.mode.set('idle');
    if (done) this.toasts.show('ok', 'El servidor tardó en responder, pero la operación sí se completó.', 9000);
    else this.toasts.error(done === false ? 'El servidor tardó demasiado y comprobamos que no se ha hecho. Puedes intentarlo de nuevo.'
      : 'El servidor tardó demasiado. No se pudo comprobar si se hizo: recarga la página antes de repetirlo.');
    return done === true;
  }

  protected close(): void { if (!this.busy()) { this.mode.set('idle'); this.error.set(null); } }

  /** Revisa ANTES de ofrecer eliminar: si hay historial no se muestra un error, se explica y se ofrece dar de baja. */
  protected async openDelete(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true); this.mode.set('checking'); this.error.set(null); this.reason.set('');
    try {
      const c = await withTimeout(this.api.deleteCheck(this.kind(), this.entityId()), SAVE_TIMEOUT_MS);
      this.check.set(c); this.blockers.set(c.blockers ?? {});
      this.mode.set(c.canDelete ? 'delete' : 'blocked');
    } catch (e) {
      this.mode.set('idle'); this.fail(e);
    } finally { this.busy.set(false); }
  }
  protected async openArchive(): Promise<void> {
    if (this.busy()) return;
    this.error.set(null); this.reason.set(''); this.effective.set(todayIn(TIMEZONE));
    this.busy.set(true);
    try {
      const c = await withTimeout(this.api.deleteCheck(this.kind(), this.entityId()), SAVE_TIMEOUT_MS);
      this.check.set(c);
      if (c.archived) { this.toasts.show('ok', 'Ya está dado de baja.'); this.changed.emit(); return; }
    } catch (e) { this.fail(e); return; } finally { this.busy.set(false); }
    this.mode.set('archive');
  }

  protected async doDelete(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true); this.error.set(null);
    try {
      await withTimeout(this.api.deleteEntity(this.kind(), this.entityId(), this.reason()), SAVE_TIMEOUT_MS);
      this.mode.set('idle'); this.deleted.emit();
    } catch (e) {
      if (timedOut(e)) { if (await this.verify('delete')) this.deleted.emit(); }
      else if (e instanceof ApiError && e.code === 'delete_blocked_has_history') {   // alguien registró historial entre la revisión y el clic: se explica y se ofrece dar de baja
        const p = (e.payload ?? {}) as { blockers?: Record<string, number> };
        this.blockers.set(p.blockers ?? {}); this.mode.set('blocked');
      } else this.error.set(explain(e));
    } finally { this.busy.set(false); }
  }

  protected async doArchive(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true); this.error.set(null);
    try {
      const r: ArchiveResult = await withTimeout(this.api.archiveEntity(this.kind(), this.entityId(), { reason: this.reason(), effectiveDate: this.effective() }), SAVE_TIMEOUT_MS);
      this.mode.set('idle');
      const parts = [`Se cerraron ${r.endedAssignments.length} ${r.endedAssignments.length === 1 ? 'asignación' : 'asignaciones'}`, `${r.chargesCompleted} ${r.chargesCompleted === 1 ? 'cuota completada' : 'cuotas completadas'}`,
        `${r.cancelledJobs + r.cancelledMessages} ${r.cancelledJobs + r.cancelledMessages === 1 ? 'aviso cancelado' : 'avisos cancelados'}`];
      this.toasts.show('ok', `Dado de baja. ${parts.join(', ')}.${r.pendingCents > 0 ? ` Queda pendiente ${formatUSD(r.pendingCents)}.` : ''}`, 9000);
      this.changed.emit();
    } catch (e) {
      if (timedOut(e)) { if (await this.verify('archive')) this.changed.emit(); } else this.error.set(explain(e));
    } finally { this.busy.set(false); }
  }

  protected async reactivate(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true); this.mode.set('reactivate');
    try {
      const r = await withTimeout(this.api.reactivateEntity(this.kind(), this.entityId()), SAVE_TIMEOUT_MS);
      this.toasts.show('ok', r.hasActiveAssignment ? 'Reactivado.' : 'Reactivado. No tiene una asignación vigente: asígnala desde Asignaciones.', 9000);
      this.changed.emit();
    } catch (e) {
      if (timedOut(e)) { if (await this.verify('reactivate')) this.changed.emit(); } else this.fail(e);
    } finally { this.busy.set(false); this.mode.set('idle'); }
  }
}

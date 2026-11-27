import { Component, input, output } from '@angular/core';
import { splitError } from '../core/errors';

/**
 * Bloque de error ÚNICO de un modal: título + un solo mensaje principal, el «Detalle técnico» plegado por defecto y, solo cuando tiene sentido, «Reintentar».
 * Úsalo en lugar de repetir el error en varios sitios del modal (ni subtextos bajo el botón ni avisos globales).
 */
@Component({
  selector: 'app-modal-error',
  template: `<div class="modal-error" role="alert">
    <strong class="modal-error-title">{{ title() }}</strong>
    <p class="modal-error-msg">{{ message() ?? parts().message }}</p>
    @if (parts().detail; as d) { <details class="err-detail"><summary>Detalle técnico</summary><code>{{ d }}</code></details> }
    @if (retryable()) { <button type="button" class="btn sm" (click)="retry.emit()">Reintentar</button> }
  </div>`,
})
export class ModalError {
  /** Título breve de la situación («No se puede activar el horario», «No se pudo guardar la plantilla»). */
  readonly title = input.required<string>();
  /** Texto de error ya redactado por errorMessage() (mensaje + detalle técnico tras el separador). */
  readonly text = input.required<string>();
  /** Mensaje principal que sustituye al del error (conserva el detalle técnico). */
  readonly message = input<string | null>(null);
  readonly retryable = input(false);
  readonly retry = output<void>();
  protected parts() { return splitError(this.text()); }
}

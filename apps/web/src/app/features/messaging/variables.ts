import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { errorMessage } from '../../core/errors';
import { createLoader } from '../../core/loader';
import type { TemplateTextItem, VariableEditorItem } from '../../core/models';
import { Perms } from '../../core/permissions';
import { ApiService } from '../../core/services';
import { BusyButton } from '../../shared/busy';
import { ErrorState, LoadingState } from '../../shared/ui';

/**
 * Variables: nombre y descripción de cada variable del selector, y las frases que usa {{detalle_deuda}} («Su saldo pendiente es de {monto}.»).
 * Solo cambia lo que se MUESTRA y redacta; los importes siempre salen del Excel. Cada cambio se puede restablecer al texto original.
 */
@Component({
  selector: 'app-variables',
  imports: [BusyButton, ErrorState, FormsModule, LoadingState],
  template: `<div class="page vr">
    <p class="muted one-line">Edita los textos de las variables. Los importes no se editan: se calculan solos con el Excel. <strong>{{ '{{saldo_total}}' }}</strong> = saldo anterior del Excel + cuotas hasta hoy − pagos hasta hoy (+ $1.00 de comisión si el check de Cobranza está activo).</p>
    @if (msg(); as m) { <div class="alert ok" role="status">{{ m }}</div> }
    @if (error(); as e) { <div class="alert bad" role="alert">{{ e }}</div> }

    <h2 id="vt" class="vr-h">Texto de {{ '{{detalle_deuda}}' }} (lo que recibe el conductor)</h2>
    <p class="muted vr-sub">Es la única variable que arma una frase completa. <code>{{ '{monto}' }}</code> es obligatorio y se reemplaza por el mismo importe que <code>{{ '{{saldo_total}}' }}</code>: no se escribe a mano.</p>
    @if (texts.error(); as e) { <app-error-state [message]="e" (retry)="texts.reload()" /> }
    @else if (texts.loading() && !texts.data().length) { <app-loading variant="list" [rows]="3" label="Cargando textos…" /> }
    @else {
      <div class="vr-list" role="list" aria-labelledby="vt">
        @for (t of texts.data(); track t.key) {
          <section class="vr-card" role="listitem">
            <div class="vr-head"><label [for]="'tx-' + t.key" class="vr-title">{{ t.title }}</label> @if (t.customized) { <span class="chip-s">Personalizado</span> }</div>
            <textarea #ta [id]="'tx-' + t.key" [name]="'tx-' + t.key" rows="2" maxlength="300" [ngModel]="textVal(t)" (ngModelChange)="setDraft(textDraft, t.key, $event)" [disabled]="!perms.canOperate()" [attr.aria-invalid]="textError(t) ? 'true' : null"></textarea>
            @if (textError(t); as e) { <p class="vr-err" role="alert">{{ e }}</p> }
            <p class="vr-prev"><span class="muted">Vista previa:</span> {{ preview(t) }}</p>
            @if (perms.canOperate()) {
              <div class="vr-actions">
                @if (t.key !== 'detalle_al_dia') { <button type="button" class="btn sm" (click)="insertMonto(t, ta)">Insertar {{ '{monto}' }}</button> }
                <button type="button" class="btn primary sm" [appBusy]="busy() === t.key" busyLabel="Guardando…" [disabled]="textVal(t) === t.text || !!textError(t)" (click)="saveText(t)">Guardar</button>
                @if (t.customized) { <button type="button" class="btn sm" (click)="resetText(t)" [disabled]="!!busy()">Restablecer original</button> }
              </div>
            }
          </section>
        }
      </div>
    }

    <!-- Va después de los textos: aparece cuando ellos ya ocupan su sitio, para no desplazarse. -->
    @if (texts.data().length || !texts.loading()) {
    <h2 id="vv" class="vr-h">Todas las variables ({{ vars.data().length }})</h2>
    @if (vars.error(); as e) { <app-error-state [message]="e" (retry)="vars.reload()" /> }
    @else if (vars.loading() && !vars.data().length) { <app-loading variant="list" [rows]="5" label="Cargando variables…" /> }
    @else {
      <div class="vr-list" role="list" aria-labelledby="vv">
        @for (v of vars.data(); track v.code) {
          <section class="vr-card" role="listitem">
            <div class="vr-head"><code class="vr-code">{{ tag(v.code) }}</code> @if (v.customized) { <span class="chip-s">Personalizado</span> }<span class="muted vr-ex">Ejemplo: {{ v.example }}</span></div>
            <div class="vr-grid">
              <div class="field"><label [for]="'vl-' + v.code">Nombre</label>
                <input [id]="'vl-' + v.code" [name]="'vl-' + v.code" maxlength="60" [ngModel]="labelVal(v)" (ngModelChange)="setDraft(labelDraft, v.code, $event)" [disabled]="!perms.canOperate()" /></div>
              <div class="field"><label [for]="'ve-' + v.code">Texto de ejemplo</label>
                <input [id]="'ve-' + v.code" [name]="'ve-' + v.code" maxlength="120" [ngModel]="exVal(v)" (ngModelChange)="setDraft(exDraft, v.code, $event)" [disabled]="!perms.canOperate()" /></div>
              <div class="field vr-wide"><label [for]="'vd-' + v.code">Descripción</label>
                <textarea [id]="'vd-' + v.code" [name]="'vd-' + v.code" rows="2" maxlength="400" [ngModel]="descVal(v)" (ngModelChange)="setDraft(descDraft, v.code, $event)" [disabled]="!perms.canOperate()"></textarea></div>
            </div>
            @if (perms.canOperate()) {
              <div class="vr-actions"><button type="button" class="btn primary sm" [appBusy]="busy() === v.code" busyLabel="Guardando…" [disabled]="!changed(v) || !labelVal(v).trim()" (click)="saveVar(v)">Guardar</button>
                @if (v.customized) { <button type="button" class="btn sm" (click)="resetVar(v)" [disabled]="!!busy()">Restablecer original</button> }</div>
            }
          </section>
        }
      </div>
    }
    }
  </div>`,
})
export class Variables {
  protected readonly perms = inject(Perms);
  private readonly api = inject(ApiService);
  protected readonly vars = createLoader(() => this.api.variableEditor(), [] as VariableEditorItem[]);
  protected readonly texts = createLoader(() => this.api.templateTexts(), [] as TemplateTextItem[]);
  protected readonly labelDraft = signal<Record<string, string>>({});
  protected readonly descDraft = signal<Record<string, string>>({});
  protected readonly exDraft = signal<Record<string, string>>({});
  protected readonly textDraft = signal<Record<string, string>>({});
  protected readonly busy = signal<string | null>(null);
  protected readonly msg = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly tag = (c: string): string => `{{${c}}}`;
  protected readonly labelVal = (v: VariableEditorItem): string => this.labelDraft()[v.code] ?? v.label;
  protected readonly descVal = (v: VariableEditorItem): string => this.descDraft()[v.code] ?? v.description;
  protected readonly textVal = (t: TemplateTextItem): string => this.textDraft()[t.key] ?? t.text;
  protected readonly exVal = (v: VariableEditorItem): string => this.exDraft()[v.code] ?? v.example;
  protected readonly changed = (v: VariableEditorItem): boolean => this.labelVal(v) !== v.label || this.descVal(v) !== v.description || this.exVal(v) !== v.example;
  /** Importe de ejemplo para la vista previa (el real se calcula al enviar: saldo anterior + cuotas − pagos). */
  protected readonly preview = (t: TemplateTextItem): string => this.textVal(t).split('{monto}').join(t.key === 'detalle_credito' ? '$10.00' : '$115.00');
  /** Misma validación que la base: {monto} obligatorio (salvo «al día»), sin importes escritos a mano ni otros marcadores. */
  protected textError(t: TemplateTextItem): string | null {
    const v = this.textVal(t);
    if (!v.trim()) return 'Escribe el texto.';
    if (v.includes('$')) return 'No escribas importes con $: usa {monto} para que el valor se calcule solo.';
    if (/\{\{/.test(v) || v.replace(/\{monto\}/g, '').match(/[{}]/)) return 'Solo se permite el marcador {monto}.';
    if (t.key !== 'detalle_al_dia' && !v.includes('{monto}')) return 'La frase debe incluir {monto}.';
    if (t.key === 'detalle_al_dia' && v.includes('{monto}')) return 'Esta frase no lleva importe.';
    return null;
  }
  protected insertMonto(t: TemplateTextItem, ta: HTMLTextAreaElement): void {
    const v = this.textVal(t); const a = ta.selectionStart ?? v.length; const b = ta.selectionEnd ?? v.length;
    this.setDraft(this.textDraft, t.key, v.slice(0, a) + '{monto}' + v.slice(b));
    setTimeout(() => { ta.focus(); ta.setSelectionRange(a + 7, a + 7); });
  }
  protected readonly anyBusy = computed(() => !!this.busy());

  constructor() { void this.vars.reload(); void this.texts.reload(); }

  protected setDraft(rec: ReturnType<typeof signal<Record<string, string>>>, key: string, v: string): void { rec.set({ ...rec(), [key]: v }); }
  private clear(rec: ReturnType<typeof signal<Record<string, string>>>, key: string): void { const { [key]: _, ...rest } = rec(); rec.set(rest); }
  private async run(key: string, ok: string, fn: () => Promise<void>, after: () => void): Promise<void> {
    if (this.busy()) return;
    this.busy.set(key); this.error.set(null); this.msg.set(null);
    try { await fn(); after(); this.msg.set(ok); await Promise.all([this.vars.reload(), this.texts.reload()]); }
    catch (e) { this.error.set(errorMessage(e)); } finally { this.busy.set(null); }
  }
  protected saveText(t: TemplateTextItem): Promise<void> { return this.run(t.key, 'Texto guardado.', () => this.api.saveTemplateText(t.key, this.textVal(t)), () => this.clear(this.textDraft, t.key)); }
  protected resetText(t: TemplateTextItem): Promise<void> { return this.run(t.key, 'Texto restablecido.', () => this.api.resetTemplateText(t.key), () => this.clear(this.textDraft, t.key)); }
  protected saveVar(v: VariableEditorItem): Promise<void> { return this.run(v.code, 'Variable guardada.', () => this.api.saveVariable(v.code, this.labelVal(v).trim(), this.descVal(v).trim(), this.exVal(v).trim()), () => { this.clear(this.labelDraft, v.code); this.clear(this.descDraft, v.code); this.clear(this.exDraft, v.code); }); }
  protected resetVar(v: VariableEditorItem): Promise<void> { return this.run(v.code, 'Variable restablecida.', () => this.api.resetVariable(v.code), () => { this.clear(this.labelDraft, v.code); this.clear(this.descDraft, v.code); this.clear(this.exDraft, v.code); }); }
}

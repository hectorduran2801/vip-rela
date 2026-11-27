import { Component, inject, signal } from '@angular/core';
import { ApiError, errorMessage } from '../../core/errors';
import { Perms } from '../../core/permissions';
import { ApiService } from '../../core/services';
import { ErrText, LoadingState } from '../../shared/ui';
import { CollectionSync } from './collection-sync';

/**
 * Importar: un solo paso. Se sube el Excel de cobranza (DATOS APP DE COBRANZA), VIP muestra qué cambiaría y avisa de lo que pasa;
 * al guardar solo se aplican las diferencias (la primera vez carga todo; después solo lo que cambió: unidad, operario, cuota, pagos, SALDO).
 */
@Component({
  selector: 'app-imports',
  imports: [ErrText, LoadingState, CollectionSync],
  template: `<div class="page">
    @if (!perms.canOperate()) { <div class="alert info" role="note">Solo ADMIN y SUPER_ADMIN pueden importar.</div> }
    <section class="panel" aria-labelledby="imp-title">
      <h2 id="imp-title">Importar Excel de cobranza</h2>
      <p class="muted">Sube el Excel.</p>
      <label for="xlsx" class="btn primary file-btn">Elegir archivo Excel (.xlsx)</label>
      <input id="xlsx" class="sr-only" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" [disabled]="uploading() || !perms.canOperate()" (change)="onFile($event)" />
      <div aria-live="polite">
        @if (uploading()) { <app-loading variant="stats" label="Leyendo el archivo…" /> }
        @if (error(); as e) { <div class="alert error" role="alert"><app-err [text]="e" /></div> }
      </div>
    </section>
    @if (current(); as c) {
      <h3 class="muted">{{ c.fileName }}</h3>
      <app-collection-sync [importId]="c.importId" (cancel)="reset()" />
    }
  </div>`,
})
export class Imports {
  private readonly api = inject(ApiService);
  protected readonly perms = inject(Perms);
  protected readonly current = signal<{ importId: string; fileName: string } | null>(null);
  protected readonly uploading = signal(false);
  protected readonly error = signal<string | null>(null);

  protected async onFile(ev: Event): Promise<void> {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file || this.uploading() || !this.perms.canOperate()) return;
    if (!/\.xlsx$/i.test(file.name)) { this.error.set('El archivo debe ser un Excel (.xlsx).'); return; }
    if (file.size > 10 * 1024 * 1024) { this.error.set('El archivo supera el máximo de 10 MB.'); return; }
    this.uploading.set(true); this.error.set(null); this.current.set(null);
    try {
      const r = await this.api.uploadImport(file);
      if (r.kind !== 'collection_flat') { await this.api.rejectImport(r.importId).catch(() => undefined); this.error.set(errorMessage(new ApiError('unsupported_workbook', 422))); return; }
      this.current.set({ importId: r.importId, fileName: file.name });
    } catch (e) { this.error.set(errorMessage(e)); } finally { this.uploading.set(false); }
  }
  protected reset(): void { this.current.set(null); this.error.set(null); }
}

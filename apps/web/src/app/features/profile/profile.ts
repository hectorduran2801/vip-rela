import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DisplayName } from '../../core/display-name';
import { errorMessage } from '../../core/errors';
import { BusyButton } from '../../shared/busy';
import { ROLE_LABEL } from '../../core/models';
import { AuthService } from '../../core/services';
import { ROLE_HELP } from '../settings/users';

/** Mi perfil: correo, rol y qué puede hacer. */
@Component({
  selector: 'app-profile',
  imports: [FormsModule, BusyButton],
  template: `<div class="page"><section class="panel" aria-labelledby="pf-title">
    <h2 id="pf-title">Información de la cuenta</h2>
    @if (user(); as u) {
      <dl class="kv"><dt>Correo</dt><dd>{{ u.email }}</dd><dt>Rol</dt><dd><span class="badge">{{ roleLabel[u.role] }}</span></dd></dl>
      <p class="muted">{{ help[u.role] }}</p>
    }
    <form class="field" (ngSubmit)="save()">
      <label for="pf-name">Nombre que se muestra junto al logo VIP</label>
      <input id="pf-name" name="displayName" maxlength="60" placeholder="Ej.: Vanessa Ejemplo" [ngModel]="draft() ?? names.name()" (ngModelChange)="draft.set($event)" autocomplete="name" />
      <small class="muted">Es solo tuyo. Con el menú contraído solo se ve «VIP».</small>
      <div><button type="submit" class="btn primary sm" [appBusy]="busy()" busyLabel="Guardando…" [disabled]="!changed()">Guardar nombre</button></div>
      @if (msg(); as m) { <div class="alert ok" role="status">{{ m }}</div> }
      @if (error(); as e) { <div class="alert bad" role="alert">{{ e }}</div> }
    </form>
    <p class="muted">Si olvidas tu contraseña, pide a quien administra VIP que restablezca tus credenciales.</p>
  </section></div>`,
})
export class Profile {
  protected readonly user = inject(AuthService).user;
  protected readonly roleLabel = ROLE_LABEL;
  protected readonly help = ROLE_HELP;
  protected readonly names = inject(DisplayName);
  protected readonly draft = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly msg = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly changed = computed(() => this.draft() !== null && this.draft()!.trim() !== this.names.name());
  constructor() { const u = this.user(); if (u) void this.names.load(u.userId); }
  protected async save(): Promise<void> {
    if (this.busy() || !this.changed()) return;
    this.busy.set(true); this.error.set(null); this.msg.set(null);
    try { await this.names.save(this.draft()!); this.draft.set(null); this.msg.set('Nombre guardado.'); }
    catch (e) { this.error.set(errorMessage(e)); } finally { this.busy.set(false); }
  }
}

import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import type { AccountInfo } from '../core/models';
import { errorMessage } from '../core/errors';
import { ApiService, AuthService } from '../core/services';

/** Solo SUPER_ADMIN: elegir qué cuenta consulta y administra. Todo lo que haga en una cuenta ajena queda en la auditoría de esa cuenta. */
@Component({
  selector: 'app-account-switch',
  template: `@if (accounts().length > 1) {
    <div class="acc-switch" [class.viewing]="!!other()">
      <label for="acc-sel">@if (other()) { Administrando } @else { Cuenta }</label>
      <select id="acc-sel" [disabled]="busy()" (change)="choose($any($event.target).value)">
        @for (a of accounts(); track a.id) { <option [value]="a.id" [selected]="a.viewing">{{ a.own ? 'Mi cuenta' : a.name }} ({{ a.drivers }})</option> }
      </select>
    </div>
    @if (error(); as e) { <span class="vr-err" role="alert">{{ e }}</span> }
  }`,
})
export class AccountSwitch {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  protected readonly accounts = signal<AccountInfo[]>([]);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly other = computed(() => this.accounts().find((a) => a.viewing && !a.own) ?? null);
  private loaded = false;
  /** Tras cambiar de cuenta se recarga la aplicación: así no queda en pantalla ningún dato de la anterior. */
  reload = (): void => location.reload();

  constructor() {
    effect(() => {
      const role = this.auth.user()?.role;
      untracked(() => {
        if (role !== 'super_admin' || this.loaded) return;
        this.loaded = true;
        void this.api.listAccounts().then((a) => this.accounts.set(a ?? [])).catch(() => { this.loaded = false; });
      });
    });
  }

  protected async choose(id: string): Promise<void> {
    const a = this.accounts().find((x) => x.id === id);
    if (!a || this.busy()) return;
    this.busy.set(true); this.error.set(null);
    try { await this.api.setAccountView(a.own ? null : a.id); this.reload(); }
    catch (e) { this.error.set(errorMessage(e)); this.busy.set(false); }
  }
}

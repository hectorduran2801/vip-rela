import { ErrText } from '../../shared/ui';
import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { errorMessage } from '../../core/errors';
import { AuthService } from '../../core/services';
import { BusyButton } from '../../shared/busy';
import { PasswordField } from '../../shared/password-field';

/** Destino del enlace de recuperación de contraseña: fija una contraseña nueva. */
@Component({
  selector: 'app-reset-password',
  imports: [PasswordField, BusyButton, ErrText, FormsModule, RouterLink],
  template: `<div class="auth-frame"><div class="auth-card">
    <div class="auth-brand"><span class="mark vip" aria-hidden="true">VIP</span><div><strong>VIP</strong><span>Cobranza y operación</span></div></div>
    @if (!ready()) { <p class="muted" role="status">Verificando el enlace…</p> }
    @else if (auth.status() !== 'authenticated') {
      <div class="alert error" role="alert">El enlace de recuperación no es válido o ya venció. Solicita uno nuevo desde el inicio de sesión.</div>
      <p><a routerLink="/login">Volver a iniciar sesión</a></p>
    } @else {
      <form (ngSubmit)="save()">
        <h1>Nueva contraseña</h1>
        @if (auth.mustChangePassword()) { <p class="muted">Entraste con una contraseña temporal. Crea la tuya para continuar.</p> }
        <div class="field"><label for="np">Contraseña nueva (mínimo 8 caracteres)</label>
          <app-password-field inputId="np" name="np" autocomplete="new-password" [ngModel]="password()" (ngModelChange)="password.set($event)" /></div>
        <div class="field"><label for="np2">Repite la contraseña</label>
          <app-password-field inputId="np2" name="np2" autocomplete="new-password" [ngModel]="again()" (ngModelChange)="again.set($event)" /></div>
        <div aria-live="polite">@if (error(); as e) { <div class="alert error" role="alert"><app-err [text]="e" /></div> }</div>
        <button class="btn primary big" type="submit" [disabled]="busy() || password().length < 8 || password() !== again()" [appBusy]="busy()" busyLabel="Guardando…">{{ busy() ? 'Un momento…' : 'Guardar contraseña' }}</button>
      </form>
    }
  </div></div>`,
})
export class ResetPassword {
  protected readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  protected readonly ready = signal(false);
  protected readonly password = signal('');
  protected readonly again = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  constructor() { void this.auth.ready().then(() => this.ready.set(true)); }

  protected async save(): Promise<void> {
    if (this.busy() || this.password().length < 8 || this.password() !== this.again()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.auth.updatePassword(this.password());
      await this.router.navigate(['/']);
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }
}

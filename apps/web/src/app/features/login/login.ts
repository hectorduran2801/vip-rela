import { ErrText } from '../../shared/ui';
import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { errorMessage } from '../../core/errors';
import { AuthService } from '../../core/services';
import { BusyButton } from '../../shared/busy';
import { PasswordField } from '../../shared/password-field';

@Component({
  selector: 'app-login',
  imports: [PasswordField, BusyButton, ErrText, FormsModule],
  templateUrl: './login.html',
})
export class Login {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  protected readonly status = this.auth.status;
  /** Aviso de una sesión restaurada que fue rechazada (cuenta no autorizada). */
  protected readonly notice = this.auth.notice;
  protected readonly email = signal('');
  protected readonly password = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  protected async submit(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.auth.signIn(this.email().trim(), this.password());
      await this.router.navigate(['/']);
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }
}

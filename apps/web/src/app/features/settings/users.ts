import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { dateTime } from '../../core/dates';
import { ApiError, errorMessage } from '../../core/errors';
import { createLoader } from '../../core/loader';
import { ROLE_LABEL, TIMEZONE, type AppUser, type Role, type UserInvite } from '../../core/models';
import { Perms } from '../../core/permissions';
import { ApiService, AuthService, Breakpoints } from '../../core/services';
import { EmptyState, ErrText, ErrorState, LoadingState } from '../../shared/ui';
import { BusyButton } from '../../shared/busy';
import { IconButton } from '../../shared/icon-button';
import { Modal } from '../../shared/modal';
import { ModalError } from '../../shared/modal-error';

export const ROLE_HELP: Record<Role, string> = {
  super_admin: 'Todo lo de ADMIN, más usuarios y roles, configuración técnica y auditoría completa.',
  admin: 'Operación: inicio, conductores y asignaciones, unidades y acuerdos, cobranza y pagos, mensajería y WhatsApp, campañas y configuración operativa.',
  supervisor: 'Rol heredado (ya no se asigna): solo lectura. Reclasifica la cuenta a ADMIN o SUPER_ADMIN, o elimínala.',
};
export const MIN_PASSWORD = 12;
type Assignable = Exclude<Role, 'supervisor'>;
type Pending = { kind: 'suspend' | 'reactivate' | 'delete' | 'reset'; user: AppUser } | null;

/** Usuarios y roles (solo SUPER_ADMIN; guard en la ruta). Las cuentas se crean desde VIP; crear una cuenta NO da acceso por sí sola: lo da el rol. */
@Component({
  selector: 'app-users',
  imports: [ModalError, Modal, IconButton, BusyButton, FormsModule, ErrText, EmptyState, ErrorState, LoadingState],
  templateUrl: './users.html',
})
export class Users {
  protected readonly perms = inject(Perms);
  private readonly api = inject(ApiService);
  private readonly me = inject(AuthService, { optional: true });
  protected readonly bp = inject(Breakpoints);
  /** Roles asignables: solo SUPER_ADMIN y ADMIN. El heredado «supervisor» se muestra pero no se asigna. */
  protected readonly roles: Assignable[] = ['super_admin', 'admin'];
  protected readonly roleLabel = ROLE_LABEL;
  protected readonly help = ROLE_HELP;
  protected readonly min = MIN_PASSWORD;
  protected readonly list = createLoader(async () => (this.perms.isSuper() ? this.api.listUsers() : []), [] as AppUser[]);
  protected readonly invites = createLoader(async () => (this.perms.isSuper() ? ((await this.api.listInvites()) ?? []).filter((i) => !i.consumedAt) : []), [] as UserInvite[]);
  protected readonly rolesShown = computed<Role[]>(() => (this.list.data().some((u) => u.role === 'supervisor') ? [...this.roles, 'supervisor'] : this.roles));

  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly ok = signal<string | null>(null);
  protected readonly pending = signal<Pending>(null);

  // Modal «Nueva cuenta». La contraseña vive solo en este signal y se borra al cerrar o terminar: no se guarda ni se registra.
  protected readonly open = signal(false);
  protected readonly email = signal('');
  protected readonly fullName = signal('');
  protected readonly role = signal<Assignable>('admin');
  /** Credenciales recién generadas (se muestran una sola vez para copiarlas). */
  protected readonly credentials = signal<{ email: string; password: string; role: string; reset?: boolean } | null>(null);
  protected readonly copied = signal(false);
  protected readonly modalError = signal<string | null>(null);
  protected readonly noServiceRole = signal(false);
  protected readonly emailOk = computed(() => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(this.email().trim()));

  constructor() { void this.list.reload(); void this.invites.reload(); }

  protected when(iso: string): string { return iso ? dateTime(iso, TIMEZONE) : ''; }
  protected mine(u: AppUser): boolean { return u.userId === this.me?.user()?.userId; }
  /** Motivo por el que NO se puede suspender/eliminar una cuenta (cadena vacía = se puede): la propia o el último SUPER_ADMIN activo. */
  protected protectedUser(u: AppUser): string {
    if (this.mine(u)) return 'No puedes hacerlo con tu propia cuenta.';
    if (u.role === 'super_admin' && !u.suspendedAt && this.list.data().filter((x) => x.role === 'super_admin' && !x.suspendedAt).length <= 1) return 'Es el único SUPER_ADMIN activo.';
    return '';
  }
  protected reload(): void { void this.list.reload(); void this.invites.reload(); }

  protected openModal(): void { this.clearForm(); this.open.set(true); }
  protected closeModal(): void { this.open.set(false); this.clearForm(); }
  private clearForm(): void { this.email.set(''); this.fullName.set(''); this.role.set('admin'); this.modalError.set(null); this.noServiceRole.set(false); }

  private async run(fn: () => Promise<string>): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true); this.error.set(null); this.ok.set(null);
    try { this.ok.set(await fn()); } catch (e) { this.error.set(errorMessage(e)); } finally { this.busy.set(false); }
  }

  protected async create(): Promise<void> {
    if (this.busy() || !this.emailOk()) return;
    this.busy.set(true); this.modalError.set(null); this.noServiceRole.set(false);
    const email = this.email().trim().toLowerCase();
    try {
      const r = await this.api.createUser({ email, role: this.role(), fullName: this.fullName().trim() || undefined });
      const roleName = ROLE_LABEL[this.role()];
      if (r.mode === 'assigned') this.ok.set(`La cuenta de ${email} ya existía: se le asignó el rol ${roleName}.`);
      else { this.ok.set(null); this.credentials.set(r.temporaryPassword ? { email, password: r.temporaryPassword, role: roleName } : null); if (!r.temporaryPassword) this.ok.set(`Cuenta creada para ${email} con el rol ${roleName}.`); }
      this.copied.set(false);
      this.closeModal(); this.reload();
    } catch (e) {
      this.noServiceRole.set(e instanceof ApiError && e.code === 'service_role_not_configured');
      this.modalError.set(errorMessage(e));
    } finally { this.busy.set(false); }
  }
  protected async copyCredentials(): Promise<void> {
    const c = this.credentials(); if (!c) return;
    const text = `VIP · acceso\nCorreo: ${c.email}\nContraseña temporal: ${c.password}\nAl entrar te pedirá crear tu propia contraseña.`;
    try { await navigator.clipboard.writeText(text); this.copied.set(true); } catch { this.copied.set(false); }
  }
  protected closeCredentials(): void { this.credentials.set(null); this.copied.set(false); }
  protected async inviteOnly(): Promise<void> {
    if (this.busy() || !this.emailOk()) return;
    this.busy.set(true); this.modalError.set(null);
    const email = this.email().trim().toLowerCase();
    try {
      const r = await this.api.inviteUser(email, this.role());
      this.ok.set(r.mode === 'assigned' ? `${email} ya tenía cuenta: se le asignó el rol ${ROLE_LABEL[this.role()]}.` : `Invitación creada para ${email}. Vence ${r.expiresAt ? this.when(r.expiresAt) : 'en 12 h'}: crea la cuenta en Supabase → Authentication → Users con ese correo y el rol se asigna solo.`);
      this.closeModal(); this.reload();
    } catch (e) { this.modalError.set(errorMessage(e)); } finally { this.busy.set(false); }
  }

  protected change(u: AppUser, role: Assignable): Promise<void> {
    return this.run(async () => { await this.api.setUserRole(u.email, role); this.reload(); return `Rol de ${u.email} cambiado a ${ROLE_LABEL[role]}.`; });
  }
  protected confirm(): Promise<void> {
    const p = this.pending();
    if (!p) return Promise.resolve();
    return this.run(async () => {
      try {
        if (p.kind === 'reset') {
          const r = await this.api.resetUserCredentials(p.user.userId);
          this.copied.set(false);
          this.credentials.set({ email: r.email, password: r.temporaryPassword, role: ROLE_LABEL[p.user.role], reset: true });
          return `Credenciales de ${p.user.email} restablecidas.`;
        }
        if (p.kind === 'delete') { await this.api.removeUser(p.user.userId); return `Se quitó el acceso de ${p.user.email}.`; }
        await this.api.suspendUser(p.user.userId, p.kind === 'suspend');
        return p.kind === 'suspend' ? `Cuenta de ${p.user.email} suspendida.` : `Cuenta de ${p.user.email} reactivada.`;
      } finally { this.pending.set(null); this.reload(); }
    });
  }
  protected cancelInvite(i: UserInvite): Promise<void> {
    return this.run(async () => { await this.api.cancelInvite(i.email); this.reload(); return `Invitación de ${i.email} cancelada.`; });
  }
}

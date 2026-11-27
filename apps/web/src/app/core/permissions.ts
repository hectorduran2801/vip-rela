import { Injectable, computed, inject } from '@angular/core';
import type { Role } from './models';
import { AuthService } from './services';

/**
 * Qué muestra la interfaz según el rol (la seguridad real es RLS / API; esto solo oculta o deshabilita).
 * SUPER_ADMIN: todo + usuarios, métodos de pago, configuración. ADMIN: operación completa. SUPERVISOR: lectura + registrar pagos.
 */
@Injectable({ providedIn: 'root' })
export class Perms {
  private readonly auth = inject(AuthService, { optional: true });
  readonly role = computed<Role | null>(() => this.auth?.user()?.role ?? (this.auth ? null : 'super_admin'));
  /** Operación completa: datos maestros, anular, ajustes, cierres, importar, recordatorios, WhatsApp. */
  readonly canOperate = computed(() => this.role() === 'admin' || this.role() === 'super_admin');
  /** Usuarios y permisos, métodos de pago y configuración. */
  readonly isSuper = computed(() => this.role() === 'super_admin');
  /** Registrar pagos: cualquier rol. */
  readonly canRegisterPayment = computed(() => this.role() !== null);
}

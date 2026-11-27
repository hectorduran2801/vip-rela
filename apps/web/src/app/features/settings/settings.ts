import { Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Icon } from '../../shared/ui';
import { Perms } from '../../core/permissions';
import { ROLE_LABEL, TIMEZONE } from '../../core/models';
import { AuthService } from '../../core/services';

interface Card { icon: string; title: string; text: string; link: string; cta: string }

/**
 * Configuración. Operativa (ADMIN y SUPER_ADMIN): métodos de pago, límites de mensajes, datos (importar/exportar), perfil.
 * Solo SUPER_ADMIN: usuarios y roles, configuración técnica y auditoría (las tarjetas ni siquiera se muestran a ADMIN; las rutas tienen guard).
 */
@Component({
  selector: 'app-settings',
  imports: [RouterLink, Icon],
  template: `<div class="page">
    <section aria-labelledby="st-op"><h2 id="st-op" class="sect">Operativa</h2>
      <div class="settings-grid">
        @for (c of operational; track c.title) { <section class="panel" [attr.aria-labelledby]="'st-' + c.icon"><div class="set-head"><span class="set-ico"><app-icon [name]="c.icon" /></span><h3 [id]="'st-' + c.icon">{{ c.title }}</h3></div>
          <p class="muted">{{ c.text }}</p><a class="btn sm" [routerLink]="c.link">{{ c.cta }}</a></section> }
        <section class="panel" aria-labelledby="st-prof"><div class="set-head"><span class="set-ico"><app-icon name="user" /></span><h3 id="st-prof">Mi perfil</h3></div>
          <dl class="kv"><dt>Correo</dt><dd>{{ user()?.email }}</dd><dt>Rol</dt><dd>{{ user() ? roleLabel[user()!.role] : '' }}</dd><dt>Zona horaria</dt><dd>{{ tz }}</dd></dl>
          <a class="btn sm" routerLink="/profile">Ver perfil</a></section>
      </div></section>
    @if (perms.isSuper()) {
      <section aria-labelledby="st-su"><h2 id="st-su" class="sect">Solo SUPER_ADMIN</h2>
        <div class="settings-grid">
          @for (c of superCards; track c.title) { <section class="panel" [attr.aria-labelledby]="'st-' + c.icon"><div class="set-head"><span class="set-ico"><app-icon [name]="c.icon" /></span><h3 [id]="'st-' + c.icon">{{ c.title }}</h3></div>
            <p class="muted">{{ c.text }}</p><a class="btn sm" [routerLink]="c.link">{{ c.cta }}</a></section> }
        </div></section>
    }
  </div>`,
})
export class Settings {
  protected readonly perms = inject(Perms);
  protected readonly user = inject(AuthService).user;
  protected readonly roleLabel = ROLE_LABEL;
  protected readonly tz = TIMEZONE;
  protected readonly operational: Card[] = [
    { icon: 'upload', title: 'Datos', text: 'Sube el Excel de cobranza para cargar o actualizar unidades, operarios, cuotas, pagos y saldos.', link: '/settings/data', cta: 'Importar Excel' },
  ];
  protected readonly superCards: Card[] = [
    { icon: 'shield', title: 'Usuarios y permisos', text: 'Asigna SUPER_ADMIN o ADMIN a cuentas de Supabase Authentication y abre la ventana temporal de altas.', link: '/settings/users', cta: 'Administrar usuarios' },
    { icon: 'settings', title: 'Configuración técnica', text: 'Entorno, zona horaria, modo de envío y estado del servicio de WhatsApp.', link: '/settings/technical', cta: 'Ver entorno' },
    { icon: 'inbox', title: 'Auditoría', text: 'Registro completo de cambios: quién hizo qué y cuándo.', link: '/settings/audit', cta: 'Abrir auditoría' },
  ];
}

import { Component } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

/** Mensajería: Conexión (WhatsApp) · Plantillas · Horarios · Historial. Los mensajes se envían desde Cobranza, eligiendo operarios y plantilla. Sin avisos permanentes: cada pestaña dice lo suyo en una línea. */
@Component({
  selector: 'app-messaging',
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  template: `
    <nav class="tabs" aria-label="Mensajería">
      @for (t of tabs; track t.path) { <a [routerLink]="t.path" routerLinkActive="active" [routerLinkActiveOptions]="{ exact: false }">{{ t.label }}</a> }
    </nav>
    <router-outlet />`,
})
export class Messaging {
  protected readonly tabs = [
    { path: '/messages/whatsapp', label: 'Conexión' },
    { path: '/messages/templates', label: 'Plantillas' },
    { path: '/messages/variables', label: 'Variables' },
    { path: '/messages/schedules', label: 'Horarios' },
    { path: '/messages/history', label: 'Historial' },
  ];
}

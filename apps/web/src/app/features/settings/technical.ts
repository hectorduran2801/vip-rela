import { Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LoadingState } from '../../shared/ui';
import { environment } from '../../../environments/environment';
import { formatDateTime12h } from '../../core/dates';
import { TIMEZONE, WHATSAPP_STATUS_LABEL } from '../../core/models';
import { formatPhone } from '../../core/phone';
import { WhatsappState } from '../../core/whatsapp-state';

/** Configuración técnica (solo SUPER_ADMIN): entorno y estado real del servicio de WhatsApp. Sin secretos: solo datos públicos. */
@Component({
  selector: 'app-technical',
  imports: [RouterLink, LoadingState],
  template: `<div class="page"><section class="panel" aria-labelledby="te-env"><h2 id="te-env">Entorno</h2>
    <dl class="kv"><dt>Zona horaria</dt><dd>{{ tz }}</dd><dt>Proyecto Supabase</dt><dd>{{ host }}</dd><dt>API</dt><dd>{{ api }}</dd><dt>Moneda</dt><dd>USD (importes en centavos)</dd></dl></section>
    <section class="panel" aria-labelledby="te-wa"><h2 id="te-wa">Servicio de WhatsApp</h2>
    @if (!state.loaded()) { <app-loading [rows]="3" label="Consultando WhatsApp…" /> } @else {
    <dl class="kv"><dt>Estado</dt><dd>{{ state.view().label }}</dd><dt>Número</dt><dd>{{ phone() }}</dd><dt>Servicio OpenWA</dt><dd>{{ worker() }}</dd>
      <dt>Modo de envío</dt><dd>{{ mode() }}</dd><dt>Última comprobación</dt><dd>{{ checked() }}</dd>@if (state.session()?.status) { <dt>Estado de la sesión</dt><dd>{{ statusText() }}</dd> }</dl>
    }
    <a class="btn sm" routerLink="/messages/whatsapp">Abrir Conexión</a></section></div>`,
})
export class Technical {
  protected readonly state = inject(WhatsappState);
  protected readonly tz = TIMEZONE;
  protected readonly host = new URL(environment.supabaseUrl).host;
  protected readonly api = environment.apiUrl;
  protected readonly phone = computed(() => formatPhone(this.state.session()?.phoneNumber) || '—');
  protected readonly worker = computed(() => { const s = this.state.session(); return !s || this.state.error() ? 'Desconocido' : s.workerOnline ? 'En línea' : 'Apagado'; });
  protected readonly mode = computed(() => { const s = this.state.session(); return !s || this.state.error() ? 'Desconocido' : s.sendingMode === 'real' ? 'Reales' : s.sendingMode === 'test' ? 'Pruebas (no se envía nada real)' : 'Desconocido'; });
  protected readonly checked = computed(() => { const t = this.state.lastOkAt(); return t === null ? 'Nunca' : formatDateTime12h(new Date(t), TIMEZONE); });
  protected readonly statusText = computed(() => WHATSAPP_STATUS_LABEL[this.state.session()!.status]);
}

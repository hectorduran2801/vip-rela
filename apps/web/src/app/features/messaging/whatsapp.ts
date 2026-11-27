import { Component, DestroyRef, computed, effect, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { formatDateTime12h } from '../../core/dates';
import { TIMEZONE, WHATSAPP_STATUS_LABEL, WHATSAPP_TRANSITIONAL } from '../../core/models';
import { Perms } from '../../core/permissions';
import { formatPhone } from '../../core/phone';
import { WA_UNAVAILABLE_LABEL, WhatsappState } from '../../core/whatsapp-state';
import { ErrText, Icon, LoadingState } from '../../shared/ui';
import { BusyButton } from '../../shared/busy';
import { Modal } from '../../shared/modal';

/** Dibuja el texto del QR como imagen. `qrcode` es CommonJS: según el empaquetador la función vive en el módulo o en `default`. */
export async function qrImage(text: string): Promise<string> {
  const mod = (await import('qrcode')) as typeof import('qrcode') & { default?: typeof import('qrcode') };
  const toDataURL = mod.toDataURL ?? mod.default?.toDataURL;
  return toDataURL(text, { margin: 1, width: 220 });
}

/**
 * Tarjeta de WhatsApp (una sola sesión). Usa el estado compartido `WhatsappState` (el mismo del encabezado): conectar o desconectar
 * aquí cambia el indicador al instante. Independiente de la ruta: puede alojarse en una pestaña de Mensajería.
 * Botones según el estado REAL; el QR solo se muestra a ADMIN+ en `awaiting_scan` y nunca se escribe en consola.
 */
@Component({
  selector: 'app-whatsapp',
  imports: [BusyButton, ErrText, Icon, LoadingState, Modal, RouterLink],
  templateUrl: './whatsapp.html',
})
export class Whatsapp {
  protected readonly state = inject(WhatsappState);
  protected readonly perms = inject(Perms);
  protected readonly labels = WHATSAPP_STATUS_LABEL;
  protected readonly v = this.state.view;
  protected readonly session = this.state.session;
  protected readonly status = computed(() => this.session()?.status ?? 'disconnected');
  /** Confirmación abierta: desconectar (conserva la sesión) o cerrar sesión (elimina las credenciales). */
  protected readonly confirm = signal<'disconnect' | 'logout' | null>(null);
  protected readonly actionError = signal<string | null>(null);
  /** Tras «Cerrar sesión»: aviso fijo (VIP borra sus credenciales, pero no puede garantizar que el dispositivo desaparezca de la cuenta). */
  protected readonly loggedOutNotice = signal(false);
  protected readonly image = signal<string | null>(null);
  private readonly tick = signal(Date.now());
  private qrFor: string | null = null;

  /** Estado de la sesión que el servicio informa (si el dato es dudoso, no se muestran botones de gestión). */
  protected readonly known = computed(() => !!this.session() && !this.state.error() && !this.state.stale());
  /** Una sola fuente de aviso: el error de la acción tiene prioridad sobre el de la consulta; nunca dos alertas. */
  /** «WhatsApp no disponible» (worker sin respuesta, latido caducado o API sin respuesta): distinto de «desconectado» y de «envío real desactivado». */
  protected readonly unavailable = computed(() => this.v().label === WA_UNAVAILABLE_LABEL);
  /** Enviar mensaje de prueba solo con sesión conectada Y servicio activo (mismo criterio que el encabezado). */
  protected readonly gate = this.state.testGate;
  /** Pasos visibles de «Conectar WhatsApp», alimentados por el estado real (status) y por la solicitud local en curso. */
  protected readonly STEP_LABELS = ['Solicitud enviada', 'Iniciando WhatsApp (puede tardar unos segundos)', 'Generando código QR', 'Esperando escaneo', 'Conectando con tu teléfono'];
  protected readonly connectInProgress = computed(() => {
    const p = this.state.pending(); const st = this.status();
    return (p?.kind === 'connect' && st === 'disconnected') || st === 'starting' || st === 'qr_pending' || st === 'awaiting_scan' || st === 'connecting';
  });
  /** Índice del paso activo (0-4): solicitud ya enviada → 1 iniciando, 2 QR, 3 escaneo, 4 conectando. */
  protected readonly activeStep = computed(() => ({ disconnected: 1, starting: 1, qr_pending: 2, awaiting_scan: 3, connecting: 4 } as Record<string, number>)[this.status()] ?? 1);
  protected readonly steps = computed(() => this.STEP_LABELS.map((label, i) => ({ label, done: i < this.activeStep(), active: i === this.activeStep() })));
  protected readonly workBusy = computed(() => this.state.requesting() || this.state.pending() !== null);
  protected readonly connectBusy = computed(() => this.state.pending()?.kind === 'connect' && !this.state.pendingSlow());
  protected readonly disconnectBusy = computed(() => this.state.pending()?.kind === 'disconnect');
  protected readonly logoutBusy = computed(() => this.state.pending()?.kind === 'logout' || !!this.session()?.logoutPending);
  protected readonly phone = computed(() => formatPhone(this.session()?.phoneNumber) || 'Sin número vinculado');
  protected readonly since = computed(() => { const s = this.session()?.statusChangedAt; return s ? formatDateTime12h(s, TIMEZONE) : '—'; });
  /** Última vez que el servicio confirmó la sesión conectada. */
  protected readonly lastConn = computed(() => { const s = this.session(); return s?.lastSeenAt && (s.status === 'connected' || s.sessionPersisted) ? formatDateTime12h(s.lastSeenAt, TIMEZONE) : 'Nunca'; });
  protected readonly persisted = computed(() => {
    const s = this.session();
    return !s ? { label: '—', ok: false } : s.sessionPersisted ? { label: 'Cifrada', ok: true } : { label: s.status === 'connected' ? 'Guardando…' : 'Sin sesión guardada', ok: false };
  });
  /** Estado de la reconexión automática (solo si se desea la conexión). */
  protected readonly reconnection = computed(() => {
    const s = this.session();
    if (!s || !this.known()) return 'Desconocido';
    if (s.status === 'connected') return 'Habilitada';
    if (s.status === 'failed' && s.desiredState === 'connected') return 'Reintentando automáticamente…';
    if (WHATSAPP_TRANSITIONAL.includes(s.status)) return 'Conectando…';
    return s.desiredState === 'connected' ? 'Habilitada' : 'Detenida (desconectado)';
  });
  /** Modo de envío, SEPARADO de «conectado»: conectar una cuenta no activa envíos reales. */
  protected readonly sendMode = computed(() => {
    const s = this.session();
    if (!s || !this.known() || !s.workerOnline) return { label: 'Desconocido', tone: 'muted' };
    return s.sendingMode === 'real' ? { label: 'Real', tone: 'ok' } : s.sendingMode === 'test' ? { label: 'Simulación', tone: 'test' } : { label: 'Desconocido', tone: 'muted' };
  });
  /** «Cerrar sesión» solo se ofrece si hay algo que cerrar: sesión guardada o conexión activa. */
  protected readonly canLogout = computed(() => { const s = this.session(); return !!s && (s.sessionPersisted || s.status === 'connected') && !this.logoutBusy(); });
  protected readonly showQr = computed(() => this.perms.canOperate() && this.status() === 'awaiting_scan' && this.known());
  protected readonly qrLeft = computed(() => {
    const e = this.session()?.qrExpiresAt;
    return e ? Math.max(0, Math.ceil((Date.parse(e) - this.tick()) / 1000)) : null;
  });
  protected readonly badgeTone = computed(() => this.v().tone);

  constructor() {
    const release = this.state.watch();
    const ticker = setInterval(() => this.tick.set(Date.now()), 1000);
    inject(DestroyRef).onDestroy(() => { release(); clearInterval(ticker); });
    effect(() => {
      const code = this.showQr() ? (this.session()?.qrData ?? null) : null;
      if (!code) { this.qrFor = null; this.image.set(null); return; }
      if (this.qrFor === code) return;
      this.qrFor = code;
      void qrImage(code).then((img) => { if (this.qrFor === code) this.image.set(img); }).catch(() => this.image.set(null));
    });
  }

  private async run(kind: 'connect' | 'disconnect' | 'logout'): Promise<void> {
    this.actionError.set(await this.state.request(kind));
  }
  /** «Reintentar»: vuelve a consultar el estado; si hay una conexión que tarda demasiado, repite la solicitud. */
  protected async retry(): Promise<void> {
    this.actionError.set(null);
    if (this.state.pendingSlow()) { await this.run('connect'); return; }
    await this.state.refresh();
  }
  protected connect(): Promise<void> { this.loggedOutNotice.set(false); return this.run('connect'); }
  protected disconnect(): Promise<void> { this.confirm.set(null); return this.run('disconnect'); }
  protected async logout(): Promise<void> {
    this.confirm.set(null);
    await this.run('logout');
    if (!this.actionError()) this.loggedOutNotice.set(true);
  }
}

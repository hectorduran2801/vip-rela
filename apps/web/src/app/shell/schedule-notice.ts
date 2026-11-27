import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { todayIn } from '../core/dates';
import { TIMEZONE, type SendSchedule } from '../core/models';
import { Perms } from '../core/permissions';
import { ApiService } from '../core/services';

const KEY = 'vip.schedule-notices.closed';
const readClosed = (): string[] => { try { return JSON.parse(localStorage.getItem(KEY) ?? '[]') as string[]; } catch { return []; } };
const writeClosed = (v: string[]): void => { try { localStorage.setItem(KEY, JSON.stringify(v.slice(-30))); } catch { /* sin almacenamiento */ } };

interface Notice { key: string; text: string; ok: boolean }

const describe = (s: SendSchedule): { text: string; ok: boolean } => {
  const n = `«${s.name}»`;
  if (s.lastRunStatus === 'missed') return { ok: false, text: `El envío programado ${n} no salió hoy: el servicio no estaba activo a su hora.` };
  if (s.lastRunStatus === 'error') return { ok: false, text: `El envío programado ${n} no se pudo ejecutar: no se envió ningún mensaje.` };
  const created = s.lastRunCreated ?? 0, total = s.lastRunTotal ?? 0;
  if (s.lastRunStatus === 'done' && total === 0) return { ok: false, text: `El envío programado ${n} se ejecutó, pero no encontró destinatarios: no se envió ningún mensaje.` };
  if (s.lastRunStatus === 'done' && created === 0) return { ok: false, text: `El envío programado ${n} se ejecutó, pero no se creó ningún mensaje.` };
  if (s.lastRunStatus === 'running') return { ok: true, text: `Se inició el envío programado ${n}.` };
  return { ok: true, text: `Se inició el envío programado ${n}: ${created} ${created === 1 ? 'mensaje' : 'mensajes'} en camino${created < total ? ` (de ${total} destinatarios)` : ''}.` };
};

/**
 * Aviso de que un horario de envío de la cuenta se ejecutó hoy (se consulta cada 20 s y al volver a la pestaña).
 * Queda visible hasta que se cierra; lo cerrado se recuerda en este navegador.
 */
@Component({
  selector: 'app-schedule-notice',
  imports: [RouterLink],
  template: `@for (n of notices(); track n.key) {
    <div class="alert sched-notice" [class.info]="n.ok" [class.warn]="!n.ok" role="status">
      <span>{{ n.text }}</span>
      <a routerLink="/messages/history">Ver historial</a>
      <button type="button" class="btn sm" (click)="close(n.key)">Cerrar</button>
    </div>
  }`,
})
export class ScheduleNotice {
  private readonly api = inject(ApiService);
  private readonly perms = inject(Perms);
  private readonly schedules = signal<SendSchedule[]>([]);
  private readonly closed = signal<string[]>(readClosed());
  protected readonly notices = computed<Notice[]>(() => {
    const today = todayIn(TIMEZONE);
    return this.schedules().flatMap((s) => {
      if (!s.lastRunStatus || s.lastRunDate?.slice(0, 10) !== today) return [];
      const key = `${s.id}:${today}`;
      return this.closed().includes(key) ? [] : [{ key, ...describe(s) }];
    });
  });

  constructor() {
    void this.tick();
    const timer = setInterval(() => { void this.tick(); }, 20_000);
    const onVisible = (): void => { if (document.visibilityState === 'visible') void this.tick(); };
    document.addEventListener('visibilitychange', onVisible);
    inject(DestroyRef).onDestroy(() => { clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); });
  }

  protected async tick(): Promise<void> {
    if (!this.perms.canOperate() || document.visibilityState === 'hidden') return;
    try { this.schedules.set((await this.api.listSendSchedules()) ?? []); } catch { /* se reintenta en el siguiente ciclo */ }
  }

  protected close(key: string): void {
    const next = [...this.closed(), key];
    this.closed.set(next);
    writeClosed(next);
  }
}

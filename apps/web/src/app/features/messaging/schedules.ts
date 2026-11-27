import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { formatUSD } from '@vip/shared';
import { RouterLink } from '@angular/router';
import { DAY_LABELS, formatTime12h } from '../../core/dates';
import { errorMessage } from '../../core/errors';
import { createLoader } from '../../core/loader';
import { SEND_AUDIENCES, type Recipient, type MessageTemplate, type SendAudience, type SendSchedule } from '../../core/models';
import { Perms } from '../../core/permissions';
import { ApiService, DataService } from '../../core/services';
import { WhatsappState } from '../../core/whatsapp-state';
import { BusyButton } from '../../shared/busy';
import { IconButton } from '../../shared/icon-button';
import { Modal } from '../../shared/modal';
import { EmptyState, ErrText, ErrorState, LoadingState } from '../../shared/ui';

interface Form { id?: string; name: string; hour: number; minute: number; period: 'AM' | 'PM'; weekdays: number[]; templateId: string; audience: SendAudience; enabled: boolean; selected: string[] }
const EMPTY: Form = { name: '', hour: 9, minute: 0, period: 'PM', weekdays: [1, 2, 3, 4, 5, 6, 7], templateId: '', audience: 'all', enabled: false, selected: [] };
const pad = (n: number): string => String(n).padStart(2, '0');
/** Selectores de 12 h → «HH:MM» de 24 h (12 AM = 00, 12 PM = 12). */
export const to24 = (hour: number, minute: number, period: 'AM' | 'PM'): string => `${pad((hour % 12) + (period === 'PM' ? 12 : 0))}:${pad(minute)}`;
export const from24 = (t: string): { hour: number; minute: number; period: 'AM' | 'PM' } => { const [h, m] = t.split(':').map(Number); return { hour: h! % 12 || 12, minute: m ?? 0, period: h! >= 12 ? 'PM' : 'AM' }; };

/**
 * Horarios de envío: «a esta hora, esta plantilla, a esta audiencia». El worker los ejecuta solo si los recordatorios automáticos están activados en
 * el servidor; si no, quedan guardados sin hacer nada (se avisa aquí). Los mensajes se crean con el mismo método que Cobranza (sin duplicados).
 */
@Component({
  selector: 'app-schedules',
  imports: [BusyButton, EmptyState, ErrText, ErrorState, FormsModule, IconButton, LoadingState, Modal, RouterLink],
  templateUrl: './schedules.html',
})
export class Schedules {
  protected readonly perms = inject(Perms);
  private readonly api = inject(ApiService);
  private readonly data = inject(DataService);
  private readonly wa = inject(WhatsappState);
  protected readonly audiences = SEND_AUDIENCES;
  protected readonly usd = formatUSD;
  protected readonly days = DAY_LABELS;
  protected readonly list = createLoader(() => this.api.listSendSchedules(), [] as SendSchedule[]);
  protected readonly templates = createLoader(() => this.data.listTemplates(), [] as MessageTemplate[]);
  protected readonly form = signal<Form | null>(null);
  protected readonly submitted = signal(false);
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly msg = signal<string | null>(null);
  protected readonly confirmDelete = signal<SendSchedule | null>(null);
  protected readonly deleting = signal(false);
  protected readonly count = signal<number | null>(null);
  private countFor = '';
  /** El servicio no ejecuta horarios hasta que se activen los recordatorios automáticos (o si el servicio está apagado). */
  protected readonly notRunning = computed(() => { const s = this.wa.session(); return !!s && !s.automaticEnabled; });
  protected readonly time = (t: string): string => formatTime12h(t);
  protected readonly daysTxt = (w: number[]): string => w.length === 7 ? 'Todos los días' : w.map((d) => DAY_LABELS[d - 1]).join(', ');
  protected readonly audienceLabel = (a: SendAudience): string => SEND_AUDIENCES.find((x) => x.value === a)?.label ?? a;
  protected readonly audienceHint = (a: SendAudience): string => SEND_AUDIENCES.find((x) => x.value === a)?.hint ?? '';
  protected readonly hours = Array.from({ length: 12 }, (_, i) => i + 1);
  protected readonly minutes = Array.from({ length: 60 }, (_, i) => i);
  protected readonly pad = pad;
  protected readonly chosenTime = computed(() => { const f = this.form(); return f ? formatTime12h(to24(f.hour, f.minute, f.period)) : ''; });
  // ───── Conductores elegidos a mano ─────
  /** Se precarga al entrar en Horarios y queda en memoria: abrir el selector no espera. Al abrirlo se refresca en segundo plano (p. ej. tras una importación). */
  protected readonly drivers = createLoader(() => this.api.sendScheduleRecipients(), [] as Recipient[]);
  /** ¿El formulario tiene cambios REALES respecto a como se abrió? (abrir el selector sin confirmar o la carga inicial no cuentan). */
  private readonly snapshot = signal('');
  protected readonly formDirty = computed(() => { const f = this.form(); return !!f && this.key(f) !== this.snapshot(); });
  private key(f: Form): string { return JSON.stringify({ ...f, name: f.name.trim(), weekdays: [...f.weekdays].sort(), selected: f.audience === 'selected' ? [...f.selected].sort() : [] }); }
  protected readonly picking = signal<ReadonlySet<string> | null>(null);
  protected readonly pickQuery = signal('');
  protected readonly pickList = computed(() => { const q = this.pickQuery().trim().toLowerCase(); return this.drivers.data().filter((r) => !q || `${r.unitCode} ${r.operatorCode} ${r.fullName}`.toLowerCase().includes(q)); });
  protected openPicker(): void {
    const f = this.form(); if (!f) return;
    this.pickQuery.set(''); this.picking.set(new Set(f.selected));
    void this.drivers.reload();
  }
  protected pick(id: string, on: boolean): void { const s = new Set(this.picking() ?? []); if (on) s.add(id); else s.delete(id); this.picking.set(s); }
  protected pickAll(on: boolean): void { const s = new Set(this.picking() ?? []); for (const r of this.pickList()) if (on) s.add(r.assignmentId); else s.delete(r.assignmentId); this.picking.set(s); }
  protected confirmPick(): void { const s = this.picking(); if (s) this.patch('selected', [...s]); this.picking.set(null); }
  protected readonly valid = computed(() => { const f = this.form(); return !!f && f.name.trim().length > 0 && f.weekdays.length > 0 && (!f.enabled || !!f.templateId) && (!f.enabled || f.audience !== 'selected' || f.selected.length > 0); });
  protected readonly lastRun = (s: SendSchedule): string => {
    if (!s.lastRunDate || !s.lastRunStatus) return 'Aún no se ha ejecutado';
    const d = s.lastRunDate.split('-').reverse().join('/');
    return s.lastRunStatus === 'done' ? `${d}: ${s.lastRunCreated} de ${s.lastRunTotal} mensajes` : s.lastRunStatus === 'missed' ? `${d}: no se envió (el servicio estaba apagado)` : s.lastRunStatus === 'error' ? `${d}: no se pudo ejecutar` : `${d}: en curso`;
  };

  constructor() {
    const release = this.wa.watch();
    inject(DestroyRef).onDestroy(release);
    void this.list.reload();
    void this.templates.reload();
    void this.drivers.reload();
  }

  protected add(): void { this.msg.set(null); this.error.set(null); this.submitted.set(false); this.form.set({ ...EMPTY, weekdays: [...EMPTY.weekdays], selected: [] }); this.snapshot.set(this.key(this.form()!)); void this.refreshCount(); }
  protected edit(s: SendSchedule): void {
    this.msg.set(null); this.error.set(null); this.submitted.set(false);
    this.form.set({ id: s.id, name: s.name, ...from24(s.localTime), weekdays: [...s.weekdays], templateId: s.templateId ?? '', audience: s.audience, enabled: s.enabled, selected: [...(s.assignmentIds ?? [])] });
    this.snapshot.set(this.key(this.form()!));
    void this.refreshCount();
  }
  protected patch<K extends keyof Form>(k: K, v: Form[K]): void { this.form.update((f) => f && { ...f, [k]: v }); if (k === 'audience') void this.refreshCount(); }
  protected toggleDay(d: number): void {
    const f = this.form(); if (!f) return;
    this.patch('weekdays', f.weekdays.includes(d) ? f.weekdays.filter((x) => x !== d) : [...f.weekdays, d].sort());
  }
  protected async refreshCount(): Promise<void> {
    const a = this.form()?.audience; if (!a) return;
    if (a === 'selected') { this.countFor = a; this.count.set(null); return; }
    this.countFor = a; this.count.set(null);
    try { const n = await this.api.sendScheduleAudienceCount(a); if (this.countFor === a) this.count.set(n); } catch { if (this.countFor === a) this.count.set(null); }
  }

  protected async save(): Promise<void> {
    const f = this.form();
    if (!f || this.saving()) return;
    this.submitted.set(true);
    if (!this.valid()) return;
    this.saving.set(true); this.error.set(null);
    try {
      const saved = await this.api.saveSendSchedule({ id: f.id, name: f.name.trim(), localTime: to24(f.hour, f.minute, f.period), weekdays: f.weekdays, templateId: f.templateId || null, audience: f.audience, enabled: f.enabled, assignmentIds: f.audience === 'selected' ? f.selected : [] });
      this.form.set(null);
      this.msg.set(saved.enabled ? 'Horario guardado y activo.' : 'Horario guardado (desactivado).');
      await this.list.reload();
    } catch (e) { this.error.set(errorMessage(e)); }
    finally { this.saving.set(false); }
  }

  /** Activar/desactivar sin abrir el formulario. */
  protected async toggle(s: SendSchedule): Promise<void> {
    if (this.saving()) return;
    if (!s.enabled && !s.templateId) { this.edit(s); return; }
    this.saving.set(true); this.error.set(null); this.msg.set(null);
    try {
      await this.api.saveSendSchedule({ id: s.id, name: s.name, localTime: s.localTime, weekdays: s.weekdays, templateId: s.templateId, audience: s.audience, assignmentIds: s.assignmentIds ?? [], enabled: !s.enabled });
      this.msg.set(s.enabled ? 'Horario desactivado.' : 'Horario activado.');
      await this.list.reload();
    } catch (e) { this.error.set(errorMessage(e)); }
    finally { this.saving.set(false); }
  }

  protected async remove(): Promise<void> {
    const s = this.confirmDelete();
    if (!s || this.deleting()) return;
    this.deleting.set(true); this.error.set(null);
    try { await this.api.deleteSendSchedule(s.id); this.confirmDelete.set(null); this.msg.set('Horario eliminado.'); await this.list.reload(); }
    catch (e) { this.confirmDelete.set(null); this.error.set(errorMessage(e)); }
    finally { this.deleting.set(false); }
  }
}

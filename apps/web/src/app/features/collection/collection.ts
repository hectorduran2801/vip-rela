import { Component, computed, DestroyRef, effect, inject, signal, untracked } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { addDays, formatUSD } from '@vip/shared';
import { dateTime, mondayOf, shiftWeek, shortDate, todayIn } from '../../core/dates';
import { errorMessage } from '../../core/errors';
import { createLoader } from '../../core/loader';
import { DRIVER_MESSAGE_LABEL, TIMEZONE, type CollectionLastSync, type CollectionPreview, type CollectionRow, type TodayMessage, type CollectionSendResult, type MessageTemplate, type TestMessageStatus } from '../../core/models';
import { usesSurname } from '../messaging/templates';
import { Perms } from '../../core/permissions';
import { formatPhone } from '../../core/phone';
import { ApiService, Breakpoints, DataService, NEW_KEY } from '../../core/services';
import { BusyButton } from '../../shared/busy';
import { Modal } from '../../shared/modal';
import { ModalError } from '../../shared/modal-error';
import { EmptyState, ErrorState, Icon, LoadingState } from '../../shared/ui';

type Segment = 'all' | 'debt' | 'no_debt' | 'paid_today' | 'no_paid_today' | 'partial' | 'agreement' | 'credit' | 'no_phone';
const SEGMENTS: { value: Segment; label: string }[] = [
  { value: 'all', label: 'Todos los activos' }, { value: 'debt', label: 'Con saldo pendiente' }, { value: 'no_debt', label: 'Sin saldo pendiente' },
  { value: 'paid_today', label: 'Con pago hoy' }, { value: 'no_paid_today', label: 'Sin pago hoy' }, { value: 'partial', label: 'Pago parcial' },
  { value: 'agreement', label: 'Con acuerdo' }, { value: 'credit', label: 'Con crédito a favor' }, { value: 'no_phone', label: 'Sin WhatsApp' },
];
/** Control de mensajes SOLO del día actual. Los filtros «de la plantilla» usan la plantilla elegida en la barra. */
type MsgFilter = 'all' | 'sent_today' | 'not_sent_today' | 'tpl_today' | 'tpl_pending' | 'failed' | 'in_progress';
const MSG_FILTERS: { value: MsgFilter; label: string; needsTemplate?: boolean }[] = [
  { value: 'all', label: 'Todos' }, { value: 'sent_today', label: 'Con mensajes hoy' }, { value: 'not_sent_today', label: 'Sin mensajes hoy' },
  { value: 'tpl_today', label: 'Con la plantilla enviada hoy', needsTemplate: true }, { value: 'tpl_pending', label: 'Pendientes de la plantilla', needsTemplate: true },
  { value: 'failed', label: 'Mensajes fallidos' }, { value: 'in_progress', label: 'Mensajes en proceso' },
];
const norm = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const dayOf = (iso: string): string => new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE }).format(new Date(iso));
const sameDay = (iso: string): boolean => todayIn(TIMEZONE) === dayOf(iso);
/** Estados que cuentan como «ya recibió» (los mismos que usa el backend para evitar duplicados): fallidos y cancelados no cuentan. */
const COUNTS = new Set(['prepared', 'processing', 'sent', 'delivered', 'simulated', 'unconfirmed']);
const FAILED = new Set(['failed', 'cancelled', 'unconfirmed']);
const IN_PROGRESS = new Set(['prepared', 'processing']);
/** Motivo (en español) por el que un destinatario queda excluido de un envío. */
export const EXCLUSION: Record<string, string> = {
  no_sync: 'Aún no hay una importación exitosa del Excel', driver_inactive: 'El operario está inactivo', unit_inactive: 'La unidad está inactiva',
  assignment_ended: 'La unidad ya no está asignada a este operario', driver_without_phone: 'No tiene WhatsApp válido',
  phone_shared: 'Su número está registrado en otro operario (podría escribirse a la persona equivocada)', unconfirmed_result_pending: 'Tiene un envío anterior sin confirmar',
  template_unresolved: 'Falta un dato que usa la plantilla', invalid_body: 'El mensaje queda vacío o demasiado largo', template_not_found: 'La plantilla ya no existe', assignment_not_found: 'La asignación ya no existe',
  already_sent_today: 'Ya recibió hoy esta plantilla', manual: 'Excluido por ti',
};
/** Texto en español de cada código de error de un envío individual. */
const SEND_ERR: Record<string, string> = { ...EXCLUSION, send_failed: 'No se pudo enviar' };

/**
 * Cobranza: tabla de unidades con operario, tal como la actualiza el Excel diario. La administradora NO registra pagos aquí.
 * Selecciona a quién escribir, elige una plantilla, revisa el texto real de cada mensaje y confirma. Cada fila indica qué plantilla se le envió por última vez.
 */
import { FormerDebts } from '../../shared/former-debts';

@Component({
  selector: 'app-collection',
  imports: [FormerDebts, NgTemplateOutlet, FormsModule, RouterLink, BusyButton, Modal, ModalError, ErrorState, EmptyState, LoadingState, Icon],
  templateUrl: './collection.html',
})
export class Collection {
  protected readonly perms = inject(Perms);
  private readonly api = inject(ApiService);
  private readonly data = inject(DataService);
  private readonly newKey = inject(NEW_KEY);
  protected readonly bp = inject(Breakpoints);
  protected readonly usd = formatUSD;
  protected readonly shortDate = shortDate;
  protected readonly fmt = formatPhone;
  protected readonly when = (iso: string): string => dateTime(iso, TIMEZONE);
  protected readonly sameDay = sameDay;
  protected readonly surname = usesSurname;
  protected readonly statusLabel = (s: string): string => DRIVER_MESSAGE_LABEL[s as TestMessageStatus] ?? s;
  protected readonly segments = SEGMENTS;
  protected readonly msgFilters = MSG_FILTERS;
  protected readonly hour = (iso: string): string => new Intl.DateTimeFormat('es-PA', { timeZone: TIMEZONE, hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(iso));
  protected readonly okStatus = (s: string): boolean => s === 'sent' || s === 'delivered' || s === 'simulated';
  protected readonly badStatus = (s: string): boolean => FAILED.has(s);

  protected readonly week = signal(mondayOf(todayIn(TIMEZONE)));
  protected readonly thisWeek = computed(() => this.week() === mondayOf(todayIn(TIMEZONE)));
  protected readonly range = computed(() => `${shortDate(this.week())} – ${shortDate(addDays(this.week(), 6))}`);
  protected readonly query = signal('');
  protected readonly segment = signal<Segment>('all');
  protected readonly msgFilter = signal<MsgFilter>('all');
  protected readonly viewing = signal<CollectionRow | null>(null);
  protected readonly selected = signal<ReadonlySet<string>>(new Set());
  /** Filas con el detalle semanal (lun–dom) desplegado. Solo informativo. */
  protected readonly openDays = signal<ReadonlySet<string>>(new Set());
  protected readonly dayNames = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'] as const;
  protected readonly commissionBusy = signal<string | null>(null);
  protected readonly commissionError = signal<string | null>(null);
  /** Comisión de pago ($1.00 Yappy / Punto Pago): se guarda por unidad y la base la suma al importe comunicado. */
  protected async toggleCommission(r: CollectionRow, on: boolean): Promise<void> {
    if (this.commissionBusy() || !this.perms.canOperate()) return;
    this.commissionBusy.set(r.assignmentId); this.commissionError.set(null);
    try { await this.api.setCommission(r.assignmentId, on); await this.board.reload(); }
    catch (e) { this.commissionError.set(errorMessage(e)); await this.board.reload(); } finally { this.commissionBusy.set(null); }
  }
  protected isOpen(r: CollectionRow): boolean { return this.openDays().has(r.assignmentId); }
  protected toggleOpen(r: CollectionRow): void { const s = new Set(this.openDays()); if (!s.delete(r.assignmentId)) s.add(r.assignmentId); this.openDays.set(s); }
  /** Diferencia del día = cuota − pagado: positivo = faltó, negativo = a favor, 0 = al día. */
  protected diff(d: { dueCents: number; paidCents: number }): number { return d.dueCents - d.paidCents; }
  protected weekDue(r: CollectionRow): number { return r.days.reduce((t, d) => t + d.dueCents, 0); }
  protected readonly board = createLoader(() => this.api.collectionBoard(this.week()), [] as CollectionRow[]);
  protected readonly templates = createLoader(() => this.data.listTemplates(), [] as MessageTemplate[]);
  /** Plantilla elegida (la misma para los filtros «de la plantilla», «Seleccionar pendientes» y el envío). */
  protected readonly templateId = signal('');
  protected readonly templateName = computed(() => this.templates.data().find((t) => t.id === this.templateId())?.name ?? '');
  /** ¿Ya recibió HOY esta plantilla? (cuenta lo enviado, en cola o sin confirmar; no lo fallido ni cancelado). */
  protected received(r: CollectionRow, name = this.templateName()): boolean { return !!name && r.messagesToday.some((m) => m.template === name && COUNTS.has(m.status)); }

  /** En la semana actual, las desvinculadas (el Excel las dejó sin operario) no están en Cobranza. Las semanas pasadas se ven como fueron. */
  protected readonly active = computed(() => (this.thisWeek() ? this.board.data().filter((r) => !r.ended) : this.board.data()));
  protected readonly rows = computed(() => {
    const q = norm(this.query());
    return this.active().filter((r) => (!q || [r.unitCode, r.operatorCode, r.fullName, r.phone ?? ''].some((x) => norm(x).includes(q))) && this.inSegment(r, this.segment()) && this.msgOk(r, this.msgFilter()));
  });
  private msgOk(r: CollectionRow, f: MsgFilter): boolean {
    const m = r.messagesToday;
    switch (f) {
      case 'all': return true;
      case 'sent_today': return m.some((x) => COUNTS.has(x.status));
      case 'not_sent_today': return !m.some((x) => COUNTS.has(x.status));
      case 'tpl_today': return this.received(r);
      case 'tpl_pending': return !r.ended && !!r.phone && !this.received(r);
      case 'failed': return m.some((x) => FAILED.has(x.status));
      case 'in_progress': return m.some((x) => IN_PROGRESS.has(x.status));
    }
  }
  private inSegment(r: CollectionRow, f: Segment): boolean {
    switch (f) {
      case 'all': return r.driverStatus === 'active';
      case 'debt': return r.pendingCents > 0;
      case 'no_debt': return r.pendingCents <= 0;
      case 'paid_today': return r.paidTodayCents > 0;
      case 'no_paid_today': return r.paidTodayCents === 0;
      case 'partial': return r.paidTodayCents > 0 && r.pendingCents > 0;      // pagó hoy y todavía debe
      case 'agreement': return !!r.agreement;
      case 'credit': return r.creditCents > 0;
      case 'no_phone': return !r.phone;
    }
  }
  /** ¿Se puede enviar a esta unidad? (con WhatsApp y no desvinculada). */
  protected selectable(r: CollectionRow): boolean { return !!r.phone && !r.ended; }
  protected readonly lastSync = createLoader(() => this.api.collectionLastSync(), null as CollectionLastSync | null);
  protected readonly syncStale = computed(() => { const l = this.lastSync.data(); return !l || !sameDay(l.appliedAt); });
  protected readonly totals = computed(() => {
    const d = this.active();
    return { units: d.length, debtors: d.filter((r) => r.pendingCents > 0).length, pending: d.reduce((s, r) => s + r.pendingCents, 0), paid: this.board.data().reduce((s, r) => s + r.paidWeekCents, 0) };
  });
  protected readonly chosen = computed(() => this.board.data().filter((r) => this.selected().has(r.assignmentId)));
  protected readonly allShown = computed(() => { const sel = this.rows().filter((r) => this.selectable(r)); return sel.length > 0 && sel.every((r) => this.selected().has(r.assignmentId)); });

  // ── Envío ──
  protected readonly sendOpen = signal(false);
  protected readonly preview = signal<CollectionPreview | null>(null);
  protected readonly previewing = signal(false);
  protected readonly sending = signal(false);
  protected readonly repeat = signal(false);
  protected readonly manualOut = signal<ReadonlySet<string>>(new Set());
  protected readonly modalError = signal<string | null>(null);
  protected readonly result = signal<CollectionSendResult | null>(null);
  protected readonly flash = signal<string | null>(null);
  private batchKey = '';
  private preselected = false;
  protected readonly sentBatch = signal('');

  /** Cada seleccionado con su mensaje y el motivo (si lo hay) por el que NO se enviará. */
  protected readonly plan = computed(() => (this.preview()?.items ?? []).map((i) => {
    const dup = !!i.alreadySentAt;
    const reason = i.reason ?? (dup && !this.repeat() ? 'already_sent_today' : this.manualOut().has(i.assignmentId) ? 'manual' : null);
    return { i, reason, dup, canToggle: i.reason === null && !(dup && !this.repeat()) || reason === 'manual' };
  }));
  protected readonly toSend = computed(() => this.plan().filter((x) => !x.reason));
  protected readonly excluded = computed(() => this.plan().filter((x) => !!x.reason));
  protected readonly dupCount = computed(() => this.plan().filter((x) => x.dup && !x.i.reason).length);
  /** Operarios con 2+ unidades DENTRO de lo que se va a enviar (ya sin excluidos ni desvinculados, y solo de la cuenta en pantalla). Se identifica por operario, no por teléfono. */
  protected readonly sharedOperators = computed(() => {
    const m = new Map<string, { operatorCode: string; fullName: string; units: string[] }>();
    for (const x of this.toSend()) {
      const e = m.get(x.i.operatorCode) ?? { operatorCode: x.i.operatorCode, fullName: x.i.fullName, units: [] };
      e.units.push(x.i.unitCode); m.set(x.i.operatorCode, e);
    }
    return [...m.values()].filter((e) => e.units.length > 1);
  });
  protected readonly reasonText = (c: string): string => EXCLUSION[c] ?? c;
  protected readonly canConfirm = computed(() => !this.sending() && !this.previewing() && !!this.templateId() && this.toSend().length > 0 && !!this.preview()?.whatsappConnected && !!this.preview()?.lastSync);

  // ── Lo que no salió hoy: reintentar, o resolver lo «sin confirmar» ──
  /** Por plantilla, las unidades cuyo ÚLTIMO mensaje de hoy con ella falló. */
  protected readonly failedGroups = computed(() => {
    const m = new Map<string, string[]>();
    for (const r of this.active()) {
      if (!this.selectable(r)) continue;
      const last = new Map<string, TodayMessage>();
      for (const x of r.messagesToday) { const p = last.get(x.template); if (!p || x.at >= p.at) last.set(x.template, x); }
      for (const [name, x] of last) if (x.status === 'failed') m.set(name, [...(m.get(name) ?? []), r.assignmentId]);
    }
    return [...m].flatMap(([name, ids]) => { const t = this.templates.data().find((x) => x.name === name); return t ? [{ templateId: t.id, name, ids }] : []; });
  });
  protected readonly unconfirmed = computed(() => this.active().flatMap((r) => r.messagesToday.filter((x) => x.status === 'unconfirmed').map((x) => x.id)));
  /** Abre la vista previa de siempre solo con los que fallaron: nada sale sin confirmarlo. */
  protected retry(g: { templateId: string; ids: string[] }): void {
    this.setTemplate(g.templateId); this.selected.set(new Set(g.ids)); this.preselected = true; this.openSend();
  }
  protected readonly resolveAsk = signal<boolean | null>(null);      // true = «sí llegó», false = «no llegó»
  protected readonly resolving = signal(false);
  protected readonly resolveError = signal<string | null>(null);
  protected async resolve(arrived: boolean): Promise<void> {
    if (this.resolving() || !this.perms.canOperate()) return;
    this.resolving.set(true); this.resolveError.set(null);
    try { await this.api.resolveCollectionMessages(this.unconfirmed(), arrived); this.resolveAsk.set(null); await this.board.reload(); }
    catch (e) { this.resolveError.set(errorMessage(e)); } finally { this.resolving.set(false); }
  }

  constructor() {
    // Mientras haya mensajes en cola, el tablero se actualiza solo: así un fallo (y su «Reintentar») aparece sin recargar.
    const timer = setInterval(() => {
      if (!this.board.loading() && !this.sendOpen() && this.board.data().some((r) => r.messagesToday.some((m) => IN_PROGRESS.has(m.status)))) void this.board.reload();
    }, 8000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
    effect(() => { this.week(); untracked(() => { this.selected.set(new Set()); this.preselected = false; void this.board.reload(); }); });
    // Columna MENSAJE del Excel (guardada en la base): al cargar, llegan marcados los «sí». Solo una vez por carga: no pisa lo que ella marque o quite después.
    effect(() => {
      const rows = this.board.data();
      untracked(() => {
        if (this.preselected || !rows.length) return;
        this.preselected = true;
        this.restoreSelection();
      });
    });
    void this.templates.reload(); void this.lastSync.reload();
  }

  protected move(w: number): void { this.week.set(shiftWeek(this.week(), w)); }
  protected today(): void { this.week.set(mondayOf(todayIn(TIMEZONE))); }
  protected isSel(r: CollectionRow): boolean { return this.selected().has(r.assignmentId); }
  protected toggle(r: CollectionRow, on: boolean): void { const s = new Set(this.selected()); if (on) s.add(r.assignmentId); else s.delete(r.assignmentId); this.selected.set(s); }
  protected toggleAll(on: boolean): void { const s = new Set(this.selected()); for (const r of this.rows()) if (this.selectable(r)) { if (on) s.add(r.assignmentId); else s.delete(r.assignmentId); } this.selected.set(s); }
  protected clear(): void { this.selected.set(new Set()); }
  /** Selecciona automáticamente a los PENDIENTES respetando los filtros activos: con plantilla elegida, los que aún no la recibieron hoy; sin plantilla, los que no han recibido nada hoy. */
  protected selectPending(): void {
    const s = new Set(this.selected());
    for (const r of this.rows()) if (this.selectable(r) && (this.templateId() ? !this.received(r) : !r.messagesToday.some((m) => COUNTS.has(m.status)))) s.add(r.assignmentId);
    this.selected.set(s);
  }
  protected readonly pendingLabel = computed(() => this.templateId() ? `Seleccionar pendientes de «${this.templateName()}»` : 'Seleccionar los que no han recibido mensajes hoy');
  /** Seleccionados que YA recibieron hoy la plantilla elegida (advertencia previa; el envío los excluye por defecto). */
  protected readonly dupSelected = computed(() => this.templateId() ? this.chosen().filter((r) => this.received(r)).length : 0);

  protected openSend(): void {
    if (!this.chosen().length || !this.perms.canOperate()) return;
    this.result.set(null); this.modalError.set(null); this.repeat.set(false); this.preview.set(null); this.manualOut.set(new Set()); this.batchKey = this.newKey();
    if (!this.templateId() && this.templates.data().length === 1) this.templateId.set(this.templates.data()[0]!.id);
    this.sendOpen.set(true);
    if (this.templateId()) void this.loadPreview();
  }
  protected closeSend(): void { this.sendOpen.set(false); if (this.result()) { this.preselected = false; this.selected.set(new Set()); void this.board.reload(); } }      // mensaje nuevo: vuelve la selección guardada
  /** ¿Hay selección guardada del Excel para recuperar? */
  protected readonly hasExcelSelection = computed(() => this.board.data().some((r) => r.sendByExcel === true));
  /** Marca exactamente lo que dice la columna MENSAJE (lo marcado a mano es temporal y no cambia lo guardado). */
  protected restoreSelection(): void { this.selected.set(new Set(this.board.data().filter((r) => r.sendByExcel === true && this.selectable(r)).map((r) => r.assignmentId))); }
  /** Plantilla de la barra (solo filtros y selección; no abre el envío). */
  protected setTemplate(id: string): void { this.templateId.set(id); if (!id && (this.msgFilter() === 'tpl_today' || this.msgFilter() === 'tpl_pending')) this.msgFilter.set('all'); }
  protected pick(id: string): void { this.templateId.set(id); this.repeat.set(false); this.manualOut.set(new Set()); void this.loadPreview(); }
  protected include(id: string, on: boolean): void { const s = new Set(this.manualOut()); if (on) s.delete(id); else s.add(id); this.manualOut.set(s); }
  protected async loadPreview(): Promise<void> {
    const id = this.templateId(); if (!id || this.previewing()) return;
    this.previewing.set(true); this.modalError.set(null);
    try { this.preview.set(await this.api.previewCollectionMessages(id, this.chosen().map((r) => r.assignmentId))); }
    catch (e) { this.modalError.set(errorMessage(e)); } finally { this.previewing.set(false); }
  }
  protected async confirmSend(): Promise<void> {
    if (this.sending() || !this.canConfirm() || !this.perms.canOperate()) return;
    this.sending.set(true); this.modalError.set(null);
    try {
      const r = await this.api.sendCollectionMessages({ templateId: this.templateId(), assignmentIds: this.toSend().map((x) => x.i.assignmentId), batchKey: this.batchKey, repeat: this.repeat() });
      this.result.set(r); this.sentBatch.set(this.batchKey);
      this.flash.set(`${r.sent} mensaje(s) en cola con la plantilla «${this.templates.data().find((t) => t.id === this.templateId())?.name ?? ''}»${r.failed ? ` · ${r.failed} no se enviaron` : ''}.`);
    } catch (e) { this.modalError.set(errorMessage(e)); } finally { this.sending.set(false); }
  }
  protected resultText(id: string): string { const x = this.result()?.results.find((r) => r.assignmentId === id); return !x ? '' : x.ok ? 'En cola' : SEND_ERR[x.error ?? ''] ?? 'No se pudo enviar'; }
  protected resultOk(id: string): boolean { return !!this.result()?.results.find((r) => r.assignmentId === id)?.ok; }
  protected nameOf(id: string): string { const r = this.board.data().find((x) => x.assignmentId === id); return r ? `${r.unitCode} · ${r.fullName}` : id; }
}

import { Perms } from '../../core/permissions';
import { ErrText } from '../../shared/ui';
import { Component, ElementRef, computed, inject, input, output, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { dmy } from '../../core/dates';
import { ApiError, errorMessage } from '../../core/errors';
import { createLoader } from '../../core/loader';
import type { Assignment, MessageTemplate, MessageTemplateInput, TemplateUsage, TemplateVariable } from '../../core/models';
import { ApiService, Breakpoints, DataService } from '../../core/services';
import { EmptyState, ErrorState, LoadingState } from '../../shared/ui';
import { BusyButton } from '../../shared/busy';
import { IconButton } from '../../shared/icon-button';
import { Modal } from '../../shared/modal';
import { ModalError } from '../../shared/modal-error';

/** Códigos del catálogo (respaldo si el catálogo del servidor no carga; la fuente de verdad es GET /templates/variables). */
export const TEMPLATE_CODES = ['nombre', 'nombre_completo', 'unidad', 'codigo_operario', 'fecha', 'cuota_hoy', 'deuda_anterior', 'saldo_total', 'credito',
  'cuenta_semanal', 'pagos_semana', 'detalle_deuda'];
export const GROUP_ORDER = ['Datos del conductor', 'Unidad y operario', 'Fechas', 'Importes financieros', 'Textos inteligentes'] as const;
export const LEGACY_GROUP = 'Antigua / compatibilidad';
/** Variables conservadas por compatibilidad: no se ofrecen como recomendadas. */
export const LEGACY_CODES = new Set(['cuenta_semana']);
export const SMART_GROUP = 'Textos inteligentes';
export const SMART_WARNING = 'Devuelve una frase completa: no le pongas prefijos como «su deuda es» ni punto final después.';
export const MEANING_NOTES: Record<string, string> = {
  nombre: '{{nombre}} equivale a {{nombre_completo}}: el nombre completo de la persona tal como viene en el Excel (no se divide en nombre y apellido).',
  fecha: '{{fecha}} es la fecha completa en español (por ejemplo, lunes 16 de noviembre de 2026).',
  saldo_total: '{{saldo_total}} es el último saldo válido importado del Excel (no se recalcula ni crece solo).',
};
export const MAX_BODY = 1000;
/** ¿La plantilla usa la variable retirada {{apellido}}? (el nombre completo no se divide: ese mensaje no se podría enviar). */
export const usesSurname = (body: string): boolean => /\{\{\s*apellido\s*\}\}/i.test(body);

/** Variables `{{x}}` del texto que no existen (para avisar antes de guardar). */
export function unknownVars(body: string, codes: readonly string[] = TEMPLATE_CODES): string[] {
  const known = new Set(codes);
  return [...new Set([...body.matchAll(/\{\{\s*([^}]*?)\s*\}\}/g)].map((m) => m[1]!))].filter((n) => !known.has(n));
}

/** Avisos en vivo del editor (no bloqueantes). */
export function bodyWarnings(body: string, codes: readonly string[] | null): string[] {
  const w: string[] = [];
  if (/\{\{\s*detalle_deuda\s*\}\}\s*\./.test(body)) w.push('{{detalle_deuda}} ya devuelve una frase completa con su punto final: quita el punto que le pusiste pegado.');
  if (codes) for (const x of unknownVars(body, codes)) w.push(`No existe: {{${x}}}; no se enviará el mensaje.`);
  for (const m of body.matchAll(/\{\{\s*([^}\s]+)\s*\}\}\s*(?=\{\{\s*\1\s*\}\})/g)) w.push(`Repites {{${m[1]}}} seguida.`);
  return [...new Set(w)];
}

/** «Plantilla en uso por horarios»: llega como ApiError (API HTTP) o como objeto de PostgREST {message:'template_in_use', code:'23503'} (Supabase directo). */
export function isTemplateInUse(e: unknown): boolean {
  if (e instanceof ApiError) return e.code === 'template_in_use';
  const o = e as { message?: unknown; code?: unknown } | null;
  return !!o && typeof o === 'object' && (o.message === 'template_in_use' || (o.code === '23503' && /template_in_use/.test(String(o.message ?? ''))));
}

@Component({
  selector: 'app-templates',
  imports: [ModalError, Modal, IconButton, BusyButton, ErrText, FormsModule, EmptyState, ErrorState, LoadingState],
  templateUrl: './templates.html',
})
export class Templates {
  protected readonly perms = inject(Perms);
  protected readonly surname = usesSurname;
  private readonly data = inject(DataService);
  private readonly api = inject(ApiService);
  protected readonly bp = inject(Breakpoints);
  /** Modo incrustado (dentro de Horarios): solo el editor en modal, sin la página de plantillas. */
  readonly embedded = input(false);
  /** Se guardó una plantilla (en modo incrustado el anfitrión recarga sus listas). */
  readonly saved = output<MessageTemplate | null>();
  /** Horarios que comparten la plantilla que se está editando (se pide confirmar antes de guardar). */
  protected readonly shared = signal<TemplateUsage[] | null>(null);
  protected readonly usageTxt = (u: TemplateUsage[]): string => u.map((x) => x.label).join(', ');
  protected readonly smartWarning = SMART_WARNING;
  protected readonly legacyLabel = LEGACY_GROUP;
  protected readonly max = MAX_BODY;
  protected readonly tag = (name: string): string => `{{${name}}}`;
  /** Catálogo de variables del servidor (skeleton al cargar, error con «Reintentar»). */
  protected readonly catalog = createLoader(async () => (await this.api.templateVariables()) ?? [], [] as TemplateVariable[]);
  protected readonly varQuery = signal('');
  private readonly norm = (t: string): string => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  /** Variables agrupadas en el orden del contrato; las antiguas van aparte («Antigua / compatibilidad»). */
  protected readonly groups = computed(() => {
    const q = this.norm(this.varQuery().trim());
    const match = (v: TemplateVariable) => !q || [v.code, v.label, v.description, v.example].some((x) => this.norm(x).includes(q));
    const all = this.catalog.data();
    const names = [...GROUP_ORDER, ...[...new Set(all.map((v) => v.group))].filter((g) => !(GROUP_ORDER as readonly string[]).includes(g))];
    const out = names.map((g) => ({ name: g, legacy: false, vars: all.filter((v) => v.group === g && !LEGACY_CODES.has(v.code) && match(v)) }));
    out.push({ name: LEGACY_GROUP, legacy: true, vars: all.filter((v) => LEGACY_CODES.has(v.code) && match(v)) });
    return out.filter((g) => g.vars.length);
  });
  protected readonly catalogCodes = computed<string[] | null>(() => (this.catalog.data().length ? this.catalog.data().map((v) => v.code) : null));
  protected readonly bodyEl = viewChild<ElementRef<HTMLTextAreaElement>>('bodyEl');
  protected readonly dmy = dmy;
  protected readonly list = createLoader(() => this.data.listTemplates(), [] as MessageTemplate[]);
  protected readonly assignments = createLoader(async () => (await this.data.listAssignments()).filter((a) => !a.validTo), [] as Assignment[]);

  protected readonly form = signal<MessageTemplateInput | null>(null);
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly msg = signal<string | null>(null);
  protected readonly confirmDelete = signal<string | null>(null);
  /** Plantilla en uso por horarios: se ofrece quitársela a esos horarios (quedan desactivados y sin plantilla) y eliminarla. */
  protected readonly detach = signal<{ template: MessageTemplate; usage: TemplateUsage[] } | null>(null);
  protected readonly detaching = signal(false);

  protected readonly previewFor = signal('');
  protected readonly previewDate = signal('');
  protected readonly previewText = signal<string | null>(null);
  protected readonly previewError = signal<string | null>(null);
  protected readonly previewing = signal(false);

  protected readonly warnings = computed(() => bodyWarnings(this.form()?.body ?? '', this.catalogCodes()));
  /** Aclaraciones de significado para plantillas con el estilo antiguo (no se modifican solas). */
  protected readonly notes = computed(() => Object.entries(MEANING_NOTES).filter(([c]) => new RegExp(`\\{\\{\\s*${c}\\s*\\}\\}`).test(this.form()?.body ?? '')).map(([, t]) => t));
  protected readonly previewMode = signal<'example' | 'real'>('example');
  protected readonly previewUnresolved = signal<string[]>([]);
  /** Vista previa instantánea con los ejemplos del catálogo (sin llamadas). */
  protected readonly examplePreview = computed(() => {
    const ex = new Map(this.catalog.data().map((v) => [v.code, v.example]));
    const body = this.form()?.body ?? '';
    const unresolved: string[] = [];
    const text = body.replace(/\{\{\s*([^}]*?)\s*\}\}/g, (m, c: string) => { if (ex.has(c) && ex.get(c)) return ex.get(c)!; unresolved.push(c); return m; });
    return { text, unresolved: [...new Set(unresolved)], ready: this.catalog.data().length > 0 };
  });
  protected readonly deleting = signal(false);
  protected readonly submitted = signal(false);
  /** Por qué no se puede guardar (null = válido). Se muestra junto al botón: el botón ya no se deshabilita en silencio. */
  protected readonly problem = computed<string | null>(() => {
    const f = this.form();
    if (!f) return null;
    const name = f.name.trim();
    if (!name) return 'Escribe un nombre para la plantilla.';
    if (!f.body.trim()) return 'Escribe el texto del mensaje.';
    if (f.body.length > MAX_BODY) return `El texto supera los ${MAX_BODY} caracteres (${f.body.length}).`;
    if (this.list.data().some((t) => t.id !== f.id && t.name.trim().toLowerCase() === name.toLowerCase())) return 'Ya existe una plantilla con ese nombre. Elige otro nombre.';
    return null;
  });
  protected readonly valid = computed(() => !!this.form() && this.problem() === null);

  constructor() { void this.list.reload(); void this.assignments.reload(); void this.catalog.reload(); }

  /** Abre el editor (también desde fuera, p. ej. Horarios → «Editar plantilla»). */
  open(t: MessageTemplate | null): void { this.edit(t); }
  protected edit(t: MessageTemplate | null): void {
    this.form.set(t ? { ...t } : { name: '', body: '' });
    this.error.set(null);
    this.msg.set(null);
    this.submitted.set(false);
    this.previewText.set(null);
    this.previewError.set(null);
    this.previewUnresolved.set([]);
    this.previewMode.set('example');
    this.varQuery.set('');
  }
  protected patch<K extends keyof MessageTemplateInput>(k: K, v: MessageTemplateInput[K]): void { this.form.update((f) => (f ? { ...f, [k]: v } : f)); }
  /** Inserta {{codigo}} en la posición del cursor (o reemplaza la selección) y deja el foco y el cursor justo después. */
  protected insert(name: string): void {
    const ta = this.bodyEl()?.nativeElement;
    const f = this.form();
    if (!f) return;
    const tag = `{{${name}}}`;
    const s = ta ? ta.selectionStart ?? f.body.length : f.body.length;
    const e = ta ? ta.selectionEnd ?? s : s;
    const body = f.body.slice(0, s) + tag + f.body.slice(e);
    if (body.length > MAX_BODY) return;
    if (ta) { ta.value = body; ta.focus(); ta.setSelectionRange(s + tag.length, s + tag.length); }
    this.patch('body', body);
  }

  protected async save(): Promise<void> {
    const f = this.form();
    if (!f || this.saving()) return;
    this.submitted.set(true);
    if (!this.valid()) return;
    if (f.id && !this.sharedOk) {                                  // plantilla compartida: mostrar qué horarios se verán afectados ANTES de guardar
      this.saving.set(true);
      const usage = await this.api.templateUsage(f.id).catch(() => [] as TemplateUsage[]);
      this.saving.set(false);
      if ((usage ?? []).length > 1) { this.shared.set(usage); return; }
    }
    this.sharedOk = false;
    this.saving.set(true);
    this.error.set(null);
    this.msg.set(null);
    try {
      await this.data.saveTemplate(f);
      this.form.set(null);
      this.msg.set('Plantilla guardada.');
      await this.list.reload();
      this.saved.emit(this.list.data().find((x) => x.id === f.id || x.name === f.name.trim()) ?? null);
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.saving.set(false);
    }
  }

  private sharedOk = false;
  protected confirmShared(): void { this.sharedOk = true; this.shared.set(null); void this.save(); }
  protected async remove(t: MessageTemplate): Promise<void> {
    if (this.deleting()) return;
    this.deleting.set(true);
    this.error.set(null);
    this.msg.set(null);
    try {
      await this.data.deleteTemplate(t.id);
      this.confirmDelete.set(null);
      this.msg.set('Plantilla eliminada.');
      await this.list.reload();
    } catch (e) {
      if (isTemplateInUse(e)) {
        const u = await this.api.templateUsage(t.id).catch(() => [] as TemplateUsage[]);
        this.confirmDelete.set(null);
        if (u.length) this.detach.set({ template: t, usage: u }); else this.error.set(errorMessage(e));
      } else this.error.set(errorMessage(e));
    } finally {
      this.deleting.set(false);
    }
  }

  /** Quita la plantilla de los horarios que la usan (quedan desactivados y sin plantilla; se les puede asignar otra después) y la elimina. */
  protected async detachAndDelete(): Promise<void> {
    const d = this.detach();
    if (!d || this.detaching()) return;
    this.detaching.set(true);
    this.error.set(null);
    try {
      const ids = new Set(d.usage.map((x) => x.id));
      for (const sc of (await this.api.listSendSchedules()).filter((x) => ids.has(x.id))) {
        await this.api.saveSendSchedule({ id: sc.id, name: sc.name, localTime: sc.localTime, weekdays: sc.weekdays, templateId: null, audience: sc.audience, assignmentIds: sc.assignmentIds, enabled: false });
      }
      await this.data.deleteTemplate(d.template.id);
      this.detach.set(null);
      this.msg.set(`Plantilla eliminada. Los horarios (${this.usageTxt(d.usage)}) quedaron desactivados y sin plantilla.`);
      await this.list.reload();
    } catch (e) {
      this.detach.set(null);
      this.error.set(errorMessage(e));
    } finally {
      this.detaching.set(false);
    }
  }

  /** Vista previa con datos REALES del conductor elegido (POST /templates/preview; la base de datos arma el texto). */
  protected async preview(body: string): Promise<void> {
    if (!this.previewFor() || !body.trim() || this.previewing()) return;
    this.previewing.set(true);
    this.previewError.set(null);
    this.previewText.set(null);
    this.previewUnresolved.set([]);
    try {
      const r = await this.api.previewTemplateDetailed(this.previewFor(), body, this.previewDate() || undefined);
      this.previewText.set(r.text);
      this.previewUnresolved.set(r.unresolved ?? []);
    } catch (e) {
      this.previewError.set(errorMessage(e));
    } finally {
      this.previewing.set(false);
    }
  }
}

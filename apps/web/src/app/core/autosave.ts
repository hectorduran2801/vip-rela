import { signal } from '@angular/core';
import { errorMessage } from './errors';

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

/** Texto libre normalizado: se recorta; vacío = null (como la base de datos). */
export const norm = (v: string | null | undefined): string | null => { const t = (v ?? '').trim(); return t ? t : null; };

/**
 * Guardado automático (al perder el foco / Enter) con estados visibles.
 * - No envía si el valor no cambió respecto del último valor GUARDADO (aunque se repita el blur).
 * - Serializa: si se edita mientras se guarda, encola solo el último valor.
 * - Tras guardar adopta lo que devuelve el servidor (no queda solo en memoria).
 * - En error conserva lo escrito y permite reintentar.
 */
export class Autosave<T> {
  readonly status = signal<SaveStatus>('idle');
  readonly error = signal<string | null>(null);
  private lastSaved: T;
  private current: T;
  private running: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(initial: T, private readonly eq: (a: T, b: T) => boolean, private readonly persist: (v: T) => Promise<T | void>, private readonly onSaved?: (v: T) => void) {
    this.lastSaved = initial;
    this.current = initial;
  }

  /** Adopta un valor externo (p. ej. al recargar la ficha) sin guardar. */
  reset(v: T): void { this.lastSaved = v; this.current = v; }
  set(v: T): void { this.current = v; }
  get dirty(): boolean { return !this.eq(this.current, this.lastSaved); }

  /** Pide guardar el valor actual si cambió. Devuelve cuando no queda nada pendiente. */
  commit(): Promise<void> {
    if (this.running) return this.running;   // la corrida en curso repetirá con el último valor
    if (!this.dirty) return Promise.resolve();
    this.running = this.loop().finally(() => { this.running = null; });
    return this.running;
  }
  retry(): Promise<void> { return this.commit(); }

  private async loop(): Promise<void> {
    clearTimeout(this.timer);
    while (this.dirty) {
      const v = this.current;
      this.status.set('saving');
      this.error.set(null);
      try {
        const stored = await this.persist(v);
        this.lastSaved = (stored ?? v) as T;
        if (stored !== undefined && this.current === v) this.current = this.lastSaved; // el servidor manda: sin ediciones nuevas, adopta su valor
        this.onSaved?.(this.lastSaved);
      } catch (e) {
        this.status.set('error');
        this.error.set(errorMessage(e));
        return;
      }
    }
    this.status.set('saved');
    this.timer = setTimeout(() => { if (this.status() === 'saved') this.status.set('idle'); }, 2500);
  }

  /** Guarda lo pendiente (al salir de la pantalla). */
  flush(): Promise<void> { return this.commit(); }
  dispose(): void { clearTimeout(this.timer); }
}

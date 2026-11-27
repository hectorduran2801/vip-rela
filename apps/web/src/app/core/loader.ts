import { signal } from '@angular/core';
import { errorMessage } from './errors';

/** Carga asíncrona con estados reales: cargando / error / datos. Sin datos de relleno. */
export function createLoader<T>(fn: () => Promise<T>, initial: T) {
  const data = signal<T>(initial);
  const loading = signal(true);
  const error = signal<string | null>(null);
  let seq = 0;
  const reload = async (): Promise<void> => {
    const mine = ++seq;
    loading.set(true);
    error.set(null);
    try {
      const v = await fn();
      if (mine === seq) data.set(v);
    } catch (e) {
      if (mine === seq) error.set(errorMessage(e));
    } finally {
      if (mine === seq) loading.set(false);
    }
  };
  return { data, loading, error, reload };
}

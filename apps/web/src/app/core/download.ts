import { InjectionToken } from '@angular/core';

/** Guarda un Blob como archivo (descarga con fetch+blob, no enlaces directos). */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Inyectable para poder sustituir la descarga en pruebas. */
export const SAVE_FILE = new InjectionToken<(blob: Blob, filename: string) => void>('SAVE_FILE', { providedIn: 'root', factory: () => saveBlob });

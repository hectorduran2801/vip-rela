import { Injectable, inject, signal } from '@angular/core';
import { ApiService } from './services';

/** Vanessa → «V»; Vanessa Ejemplo → «VE»; Héctor Luis Díaz Córdoba → «HC»: inicial de la primera y de la última palabra, máximo dos, en mayúsculas. */
export function initialsOf(name: string): string {
  // Solo letras: los signos («!», «.», «-», emojis, números) no cuentan como iniciales («N !» → «N», no «N!»).
  const words = name.split(/\s+/).map((w) => w.replace(/^[^\p{L}]+/u, '')).filter(Boolean);
  if (!words.length) return '';
  const first = Array.from(words[0]!)[0]!;
  return (words.length === 1 ? first : first + Array.from(words[words.length - 1]!)[0]!).toLocaleUpperCase('es');
}

/** Nombre que la cuenta actual muestra junto al logo. Se carga al entrar y lo cambia la propia persona desde «Mi perfil». */
@Injectable({ providedIn: 'root' })
export class DisplayName {
  private readonly api = inject(ApiService, { optional: true });
  readonly name = signal('');
  private loadedFor: string | null = null;
  async load(userId: string): Promise<void> {
    if (this.loadedFor === userId || !this.api) return;
    this.loadedFor = userId; this.name.set('');
    try { this.name.set((await this.api.myProfile()).fullName); } catch { this.loadedFor = null; }      // sin nombre no se rompe nada: queda el logo
  }
  async save(value: string): Promise<void> { this.name.set((await this.api!.saveMyName(value)).fullName); }
}

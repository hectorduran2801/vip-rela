import { Injectable, signal } from '@angular/core';

/** Texto final de la ruta de navegación cuando depende de datos (p. ej. el nombre del conductor: «Conductores / Ana Pérez»). */
@Injectable({ providedIn: 'root' })
export class PageCrumb { readonly leaf = signal<string | null>(null); }

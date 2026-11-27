import { Component, inject } from '@angular/core';
import { Router } from '@angular/router';
import { Perms } from '../../core/permissions';
import { DriverForm } from './driver-form';

/** Alta de conductor (página propia). Un conductor puede existir sin unidad: la relación se gestiona en Asignaciones. */
@Component({
  selector: 'app-driver-new',
  imports: [DriverForm],
  template: `<div class="page">
    @if (!perms.canOperate()) { <div class="alert info" role="note">Solo ADMIN y SUPER_ADMIN pueden crear conductores.</div> }
    @else {
      <app-driver-form (saved)="go()" (cancelled)="go()" />
      <p class="muted">El código de unidad no es un dato del conductor: después de crearlo, asígnale una unidad en «Asignaciones de vehículos».</p>
    }
  </div>`,
})
export class DriverNew {
  protected readonly perms = inject(Perms);
  private readonly router = inject(Router);
  protected go(): void { void this.router.navigate(['/drivers']); }
}

import { Component, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { Perms } from '../../core/permissions';

/** Módulo Conductores: Listado · Nuevo conductor · Asignaciones de vehículos. */
@Component({
  selector: 'app-drivers-shell',
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  template: `<nav class="tabs" aria-label="Conductores">
    <a routerLink="/drivers" routerLinkActive="active" [routerLinkActiveOptions]="{ exact: true }">Listado</a>
    @if (perms.canOperate()) { <a routerLink="/drivers/new" routerLinkActive="active">Nuevo conductor</a> }
    <a routerLink="/drivers/assignments" routerLinkActive="active">Asignaciones de vehículos</a>
  </nav><router-outlet />`,
})
export class DriversShell { protected readonly perms = inject(Perms); }

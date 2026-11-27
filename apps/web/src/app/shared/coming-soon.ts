import { Component, inject } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { EmptyState } from './ui';

/** Pantalla honesta para módulos aún no construidos: sin datos inventados. */
@Component({
  selector: 'app-coming-soon',
  imports: [EmptyState],
  template: `<div class="page"><app-empty-state icon="settings" [title]="'Próximamente'"
    [hint]="'El módulo «' + title + '» todavía no está disponible. Estamos trabajando en él.'" /></div>`,
})
export class ComingSoon {
  protected readonly title = String(inject(ActivatedRoute).snapshot.data['title'] ?? 'Módulo');
}

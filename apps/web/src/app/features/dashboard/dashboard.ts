import { Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { formatUSD } from '@vip/shared';
import { createLoader } from '../../core/loader';
import { WHATSAPP_STATUS_LABEL, type DashboardData } from '../../core/models';
import { ApiService } from '../../core/services';
import { EmptyState, ErrorState, Icon, LoadingState } from '../../shared/ui';

import { WeekPayments } from './week-payments';

const WA_LABEL = WHATSAPP_STATUS_LABEL;

import { FormerDebts } from '../../shared/former-debts';

@Component({
  selector: 'app-dashboard',
  imports: [FormerDebts, Icon, RouterLink, EmptyState, ErrorState, LoadingState, WeekPayments],
  templateUrl: './dashboard.html',
})
export class Dashboard {
  private readonly api = inject(ApiService);
  protected readonly usd = formatUSD;
  protected readonly waLabel = WA_LABEL;
  protected readonly loader = createLoader<DashboardData | null>(() => this.api.dashboard(), null);
  protected readonly data = this.loader.data;
  protected readonly quick = [
    { label: 'Cobranza y mensajes', icon: 'wallet', link: '/collections' },
    { label: 'Buscar conductor', icon: 'search', link: '/drivers' },
    { label: 'Importar Excel', icon: 'upload', link: '/settings/data' },
    { label: 'Plantillas', icon: 'chat', link: '/messages/templates' },
  ];

  constructor() { void this.loader.reload(); }
}

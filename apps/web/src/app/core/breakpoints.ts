import { Injectable, signal } from '@angular/core';
import { Breakpoints, MOBILE_QUERY } from './services';

@Injectable()
export class MatchMediaBreakpoints extends Breakpoints {
  private readonly mobile = signal(false);
  readonly isMobile = this.mobile.asReadonly();

  constructor() {
    super();
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      const mql = window.matchMedia(MOBILE_QUERY);
      this.mobile.set(mql.matches);
      mql.addEventListener('change', (e) => this.mobile.set(e.matches));
    }
  }
}

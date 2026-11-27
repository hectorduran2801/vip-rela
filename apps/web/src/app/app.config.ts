import { provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';
import { ApplicationConfig, provideBrowserGlobalErrorListeners, isDevMode } from '@angular/core';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { provideServiceWorker } from '@angular/service-worker';
import { routes } from './app.routes';
import { authInterceptor } from './core/auth.interceptor';
import { MatchMediaBreakpoints } from './core/breakpoints';
import { HttpApiService } from './core/http-api.service';
import { ApiService, AuthService, Breakpoints, DataService } from './core/services';
import { SupabaseAuthService } from './core/supabase-auth.service';
import { SupabaseDataService } from './core/supabase-data.service';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes, withComponentInputBinding()),
    provideHttpClient(withFetch(), withInterceptors([authInterceptor])),
    { provide: AuthService, useClass: SupabaseAuthService },
    { provide: DataService, useClass: SupabaseDataService },
    { provide: ApiService, useClass: HttpApiService },
    { provide: Breakpoints, useClass: MatchMediaBreakpoints },
    provideServiceWorker('ngsw-worker.js', {
      enabled: !isDevMode(),
      registrationStrategy: 'registerWhenStable:30000',
    }),
  ],
};

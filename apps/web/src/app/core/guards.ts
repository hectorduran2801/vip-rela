import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from './services';

/** Exige sesión de la administradora autorizada. Sin sesión (o cuenta no autorizada, ya cerrada) → /login. */
export const authGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  await auth.ready();
  if (auth.status() !== 'authenticated') return router.createUrlTree(['/login']);
  return auth.mustChangePassword() ? router.createUrlTree(['/reset-password']) : true;   // contraseña temporal: debe cambiarla primero
};

/** Para /login: si ya hay sesión, ir al inicio. */
export const anonGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  await auth.ready();
  return auth.status() === 'authenticated' ? router.createUrlTree(['/']) : true;
};

/** Solo SUPER_ADMIN (p. ej. mensajes de prueba de WhatsApp). Otros roles → /dashboard. La seguridad real es la API; esto evita la pantalla. */
export const superGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  await auth.ready();
  return auth.user()?.role === 'super_admin' ? true : router.createUrlTree(['/dashboard']);
};

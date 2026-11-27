import { Routes } from '@angular/router';
import { anonGuard, authGuard, superGuard } from './core/guards';

const crumbDrivers = { label: 'Conductores', link: '/drivers' };
const crumbSettings = { label: 'Configuración', link: '/settings' };

/**
 * Rutas en inglés (textos en español). Las rutas antiguas en español redirigen a las nuevas.
 * PRECEDENCIA: dentro de /drivers, `new` y `assignments` se declaran ANTES de `:id` para que nunca se tomen como un id.
 */
export const routes: Routes = [
  {
    path: 'login',
    canActivate: [anonGuard],
    title: 'Iniciar sesión · VIP',
    loadComponent: () => import('./features/login/login').then((m) => m.Login),
  },
  { path: 'reset-password', title: 'Nueva contraseña · VIP', loadComponent: () => import('./features/login/reset-password').then((m) => m.ResetPassword) },

  // ---- Redirecciones de las rutas antiguas (no rompen enlaces ni marcadores) ----
  { path: 'restablecer', redirectTo: 'reset-password', pathMatch: 'full' },
  { path: 'inicio', redirectTo: 'dashboard', pathMatch: 'full' },
  { path: 'conductores', redirectTo: 'drivers', pathMatch: 'full' },
  { path: 'asignaciones', redirectTo: 'drivers/assignments', pathMatch: 'full' },
  { path: 'conductores/:id', redirectTo: 'drivers/:id', pathMatch: 'full' },
  { path: 'unidades', redirectTo: 'vehicles', pathMatch: 'full' },
  { path: 'unidades/:id', redirectTo: 'vehicles/:id', pathMatch: 'full' },
  { path: 'finanzas', redirectTo: 'collections', pathMatch: 'full' },
  { path: 'finanzas/metodos', redirectTo: 'settings/payment-methods', pathMatch: 'full' },
  { path: 'finanzas/excel', redirectTo: 'settings/data', pathMatch: 'full' },
  // Pagos, Importar/Exportar y Reportes ya no son módulos del menú: viven dentro de Configuración y Cobranza.
  { path: 'payments', redirectTo: 'collections/payments', pathMatch: 'full' },
  { path: 'pagos', redirectTo: 'collections/payments', pathMatch: 'full' },
  { path: 'pagos/historial', redirectTo: 'collections/history', pathMatch: 'full' },
  { path: 'finanzas/pagos', redirectTo: 'collections/payments', pathMatch: 'full' },
  { path: 'finanzas/historial', redirectTo: 'collections/history', pathMatch: 'full' },
  { path: 'cobranza', redirectTo: 'collections', pathMatch: 'full' },
  { path: 'cobranza/pagos', redirectTo: 'collections/payments', pathMatch: 'full' },
  { path: 'cobranza/historial', redirectTo: 'collections/history', pathMatch: 'full' },
  { path: 'cobranza/informes', redirectTo: 'collections', pathMatch: 'full' },
  { path: 'imports', redirectTo: 'settings/data', pathMatch: 'full' },
  { path: 'reports', redirectTo: 'collections', pathMatch: 'full' },
  { path: 'finanzas/avisos', redirectTo: 'messages/history', pathMatch: 'full' },
  { path: 'mensajeria', redirectTo: 'messages', pathMatch: 'full' },
  { path: 'mensajeria/plantillas', redirectTo: 'messages/templates', pathMatch: 'full' },
  { path: 'mensajeria/historial', redirectTo: 'messages/history', pathMatch: 'full' },
  { path: 'mensajeria/whatsapp', redirectTo: 'messages/whatsapp', pathMatch: 'full' },
  { path: 'campanas', redirectTo: 'collections', pathMatch: 'full' },
  { path: 'campaigns', redirectTo: 'collections', pathMatch: 'full' },
  { path: 'messages/send', redirectTo: 'collections', pathMatch: 'full' },
  { path: 'reportes', redirectTo: 'collections', pathMatch: 'full' },
  { path: 'configuracion', redirectTo: 'settings', pathMatch: 'full' },
  { path: 'configuracion/usuarios', redirectTo: 'settings/users', pathMatch: 'full' },
  { path: 'configuracion/datos', redirectTo: 'settings/data', pathMatch: 'full' },
  { path: 'mensajeria/horarios', redirectTo: 'messages/schedules', pathMatch: 'full' },

  {
    path: '',
    canActivate: [authGuard],
    loadComponent: () => import('./shell/shell').then((m) => m.Shell),
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'dashboard' },
      { path: 'dashboard', data: { title: 'Inicio' }, title: 'Inicio · VIP', loadComponent: () => import('./features/dashboard/dashboard').then((m) => m.Dashboard) },
      {
        path: 'drivers', loadComponent: () => import('./features/drivers/drivers-shell').then((m) => m.DriversShell),
        children: [
          { path: '', pathMatch: 'full', data: { title: 'Conductores' }, title: 'Conductores · VIP', loadComponent: () => import('./features/drivers/drivers').then((m) => m.Drivers) },
          { path: 'new', data: { title: 'Nuevo', parent: crumbDrivers }, title: 'Nuevo conductor · VIP', loadComponent: () => import('./features/drivers/driver-new').then((m) => m.DriverNew) },
          { path: 'assignments', data: { title: 'Asignaciones', parent: crumbDrivers }, title: 'Asignaciones · VIP', loadComponent: () => import('./features/assignments/assignments').then((m) => m.Assignments) },
          { path: ':id', data: { title: 'Conductor', parent: crumbDrivers, leaf: true }, title: 'Conductor · VIP', loadComponent: () => import('./features/drivers/driver-detail').then((m) => m.DriverDetail) },
        ],
      },
      { path: 'vehicles', data: { title: 'Unidades' }, title: 'Unidades · VIP', loadComponent: () => import('./features/units/units').then((m) => m.Units) },
      { path: 'vehicles/:id', data: { title: 'Unidad', parent: { label: 'Unidades', link: '/vehicles' }, leaf: true }, title: 'Unidad · VIP', loadComponent: () => import('./features/units/unit-detail').then((m) => m.UnitDetail) },
      { path: 'collections', data: { title: 'Cobranza' }, title: 'Cobranza · VIP', loadComponent: () => import('./features/collection/collection').then((m) => m.Collection) },
      { path: 'collections/payments', redirectTo: 'collections', pathMatch: 'full' },
      { path: 'collections/history', redirectTo: 'collections', pathMatch: 'full' },
      {
        path: 'messages', data: { title: 'Mensajería' }, loadComponent: () => import('./features/messaging/messaging').then((m) => m.Messaging),
        children: [
          { path: '', pathMatch: 'full', redirectTo: 'whatsapp' },
          { path: 'whatsapp', pathMatch: 'full', title: 'Conexión de WhatsApp · VIP', loadComponent: () => import('./features/messaging/whatsapp').then((m) => m.Whatsapp) },
          { path: 'whatsapp/test', canActivate: [superGuard], title: 'Mensaje de prueba · VIP', loadComponent: () => import('./features/messaging/whatsapp-test').then((m) => m.WhatsappTest) },
          { path: 'variables', title: 'Variables · VIP', loadComponent: () => import('./features/messaging/variables').then((m) => m.Variables) },
          { path: 'schedules', title: 'Horarios de envío · VIP', loadComponent: () => import('./features/messaging/schedules').then((m) => m.Schedules) },
          { path: 'templates', title: 'Plantillas · VIP', loadComponent: () => import('./features/messaging/templates').then((m) => m.Templates) },
          { path: 'history', title: 'Historial de mensajes · VIP', loadComponent: () => import('./features/messaging/message-history').then((m) => m.MessageHistory) },
        ],
      },
      { path: 'profile', data: { title: 'Mi perfil', parent: crumbSettings }, title: 'Mi perfil · VIP', loadComponent: () => import('./features/profile/profile').then((m) => m.Profile) },
      { path: 'settings', data: { title: 'Configuración' }, title: 'Configuración · VIP', pathMatch: 'full', loadComponent: () => import('./features/settings/settings').then((m) => m.Settings) },
      { path: 'settings/payment-methods', redirectTo: 'settings', pathMatch: 'full' },
      { path: 'settings/data', data: { title: 'Importar', parent: crumbSettings }, title: 'Importar · VIP', loadComponent: () => import('./features/imports/imports').then((m) => m.Imports) },
      { path: 'settings/users', canActivate: [superGuard], data: { title: 'Usuarios y permisos', parent: crumbSettings }, title: 'Usuarios y permisos · VIP', loadComponent: () => import('./features/settings/users').then((m) => m.Users) },
      { path: 'settings/technical', canActivate: [superGuard], data: { title: 'Configuración técnica', parent: crumbSettings }, title: 'Configuración técnica · VIP', loadComponent: () => import('./features/settings/technical').then((m) => m.Technical) },
      { path: 'settings/audit', canActivate: [superGuard], data: { title: 'Auditoría', parent: crumbSettings }, title: 'Auditoría · VIP', loadComponent: () => import('./features/settings/audit').then((m) => m.Audit) },
    ],
  },
  { path: '**', redirectTo: 'dashboard' },
];

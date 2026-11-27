export interface NavItem { path: string; label: string; icon: string; exact?: boolean }

/**
 * (Histórico) Los 7 módulos del menú principal (idénticos para ADMIN y SUPER_ADMIN). Pagos, Asignaciones, Reportes e Importar/Exportar NO son ítems:
 * viven dentro de Cobranza, Conductores y Configuración. Lo exclusivo de SUPER_ADMIN (usuarios, técnica, auditoría) está dentro de Configuración.
 */
export const NAV: NavItem[] = [
  { path: '/dashboard', label: 'Inicio', icon: 'home', exact: true },
  { path: '/drivers', label: 'Conductores', icon: 'users' },
  { path: '/vehicles', label: 'Unidades', icon: 'truck' },
  { path: '/collections', label: 'Cobranza', icon: 'wallet' },
  { path: '/messages', label: 'Mensajería', icon: 'chat' },
  { path: '/settings', label: 'Configuración', icon: 'settings' },
];

/**
 * Accesos directos SOLO para SUPER_ADMIN, bajo la cabecera «Administración». Son atajos a pantallas que ADMIN alcanza desde dentro de
 * Cobranza y Configuración → Datos (Importar/Exportar, Reportes; Pagos NO tiene atajo: vive solo en la pestaña Pagos de Cobranza) o que son exclusivas de SUPER_ADMIN (Usuarios, Auditoría; guard en la ruta).
 */
export const NAV_SUPER: NavItem[] = [
  { path: '/settings/data', label: 'Importar', icon: 'upload' },
  { path: '/settings/users', label: 'Usuarios y permisos', icon: 'shield' },
  { path: '/settings/audit', label: 'Auditoría', icon: 'inbox' },
];

/**
 * ¿Está activo el ítem? Un módulo permanece resaltado en todas sus subpáginas: «Configuración» incluye /settings/* y /profile.
 * (El atajo de SUPER_ADMIN hacia una subpágina también se marca: es la misma pantalla, un nivel más adentro.)
 */
export function navActive(item: NavItem, url: string, withShortcuts: boolean): boolean {
  const path = url.split(/[?#]/)[0]!;
  const under = (base: string): boolean => path === base || path.startsWith(`${base}/`);
  if (item.exact) return path === item.path;
  // En cualquier /collections/* el sidebar resalta SOLO «Cobranza»: los atajos hacia /collections/* (Reportes) nunca se marcan activos.
  if (withShortcuts && item.path.startsWith('/collections/')) return false;
  if (item.path === '/settings') return under('/settings') || under('/profile');
  return under(item.path);
}

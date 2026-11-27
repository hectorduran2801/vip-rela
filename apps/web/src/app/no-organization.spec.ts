import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * VIP es de instancia única: ningún texto visible, plantilla, ruta ni llamada puede referirse a organizaciones,
 * membresías, roles ni invitaciones. Se revisan los fuentes de producción (no los comentarios ni las pruebas).
 */
const ROOT = join(process.cwd(), 'src', 'app');
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === 'testing' ? [] : files(p);
    return /\.(ts|html)$/.test(n) && !n.endsWith('.spec.ts') ? [p] : [];
  });
}
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('Instancia única: sin organizaciones, roles ni invitaciones', () => {
  const sources = files(ROOT).map((p) => ({ p, s: strip(readFileSync(p, 'utf8')) }));
  it('hay fuentes que revisar', () => expect(sources.length).toBeGreaterThan(40));
  it.each([
    ['organizationId / organization_id', /organization[_ ]?id|organizationName/i],
    ['«organización» en español', /organizaci[oó]n/i],
    ['membresías / miembros', /membership|membres|\/members|miembros?\b/i],
    ['guards/jerarquía de rol antiguos y OPERADOR', /OPERADOR\b|hasMinRole|roleGuard|minRole|\bSUPER ADMIN\b/],
    ['invitar usuarios', /invit(e|ar|aci)/i],
    ['mensaje antiguo', /no pertenece a ninguna/i],
  ])('ningún fuente contiene %s', (_n, re) => {
    // Las invitaciones de CUENTAS INTERNAS (Configuración → Usuarios) son legítimas; ninguna otra parte las menciona.
    const allowed = _n === 'invitar usuarios' ? /settings[\\/]users|http-api\.service|core[\\/]services|core[\\/]models|core[\\/]errors|core[\\/]audit-labels/ : /^$/;
    expect(sources.filter((x) => re.test(x.s) && !allowed.test(x.p)).map((x) => x.p.replace(ROOT, ''))).toEqual([]);
  });
  it('conserva la clave publicable de desarrollo en environment.ts (pública por diseño)', () => {
    const env = readFileSync(join(process.cwd(), 'src', 'environments', 'environment.ts'), 'utf8');
    expect(env).toMatch(/supabasePublishableKey: 'sb_publishable_[A-Za-z0-9_-]{10,}'/);
    expect(strip(env)).not.toMatch(/service_role|sb_secret/);
  });
});

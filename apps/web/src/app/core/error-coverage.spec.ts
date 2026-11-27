import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ApiError, GENERIC_ERROR, errorMessage, splitError } from './errors';
import { KNOWN_AUDIT_ACTIONS, actionLabel, entityLabel } from './audit-labels';

const API = join(process.cwd(), '..', 'api', 'src');
function files(dir: string): string[] { return readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? files(p) : /\.ts$/.test(n) && !/\.test\./.test(n) ? [p] : []; }); }
const apiSrc = files(API).map((f) => readFileSync(f, 'utf8')).join('\n');

/** Códigos de error que la API puede devolver: el mapa de errores de negocio + los `error: '...'` de las rutas. */
function apiCodes(): string[] {
  const out = new Set<string>();
  const map = /const MAP: Record<string, number> = \{([\s\S]*?)\n\};/.exec(apiSrc)?.[1] ?? '';
  for (const m of map.matchAll(/\b([a-z][a-z0-9_]+):\s*\d{3}/g)) out.add(m[1]!);
  for (const m of apiSrc.matchAll(/error: '([a-z][a-z0-9_]+)'/g)) out.add(m[1]!);
  return [...out];
}

describe('Cobertura de errores en español', () => {
  it('hay códigos de la API que revisar', () => expect(apiCodes().length).toBeGreaterThan(40));
  it('TODO código de error de la API tiene mensaje en español (si aparece uno nuevo, esta prueba falla)', () => {
    const missing = apiCodes().filter((c) => !['not_found', 'internal_error'].includes(c)).filter((c) => splitError(errorMessage(new ApiError(c, 400))).message === GENERIC_ERROR);
    expect(missing).toEqual([]);
  });
  it('los pedidos explícitos', () => {
    for (const c of ['schema_outdated', 'unconfirmed_result_pending', 'consent_required', 'too_soon', 'role_deprecated', 'service_role_not_configured', 'auth_user_exists', 'block_not_found', 'wrong_import_kind', 'invalid_resolve', 'note_too_long', 'unit_not_found', 'invalid_kind', 'idempotency_key_required']) {
      const m = splitError(errorMessage(new ApiError(c, 400))).message;
      expect(m, c).not.toBe(GENERIC_ERROR);
      expect(m, c).not.toMatch(/[a-z]+_[a-z]+/);
    }
  });
});

describe('Auditoría en español', () => {
  const dbActions = (): string[] => {
    const dir = join(process.cwd(), '..', '..', 'supabase', 'migrations');
    const sql = readdirSync(dir).map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');
    return [...new Set([...sql.matchAll(/app_private\.audit\('([a-z_.]+)'/g)].map((m) => m[1]!))].filter((a) => !a.endsWith('.') && !a.endsWith('_'));
  };
  it('toda acción fija que registra la base tiene etiqueta', () => {
    const acts = dbActions();
    expect(acts.length).toBeGreaterThan(15);
    expect(acts.filter((a) => actionLabel(a) === 'Acción del sistema')).toEqual([]);
  });
  it('acciones con prefijo (consentimiento, whatsapp.test_message.*, review_notification_*, request_whatsapp_*) y las de los triggers', () => {
    for (const a of ['insert', 'update', 'delete', 'db_reset_dev', 'driver_consent.granted', 'driver_consent.withdrawn', 'whatsapp.test_message.sent', 'whatsapp.test_message.unconfirmed', 'review_notification_approve', 'request_whatsapp_connected', 'set_app_user', 'user_suspended']) {
      expect(actionLabel(a), a).not.toBe('Acción del sistema');
      expect(actionLabel(a), a).not.toMatch(/[a-z]+_[a-z]+|\./);
    }
    expect(KNOWN_AUDIT_ACTIONS.length).toBeGreaterThan(25);
  });
  it('entidades y tablas con nombres amigables', () => {
    for (const e of ['drivers', 'units', 'assignments', 'payments', 'app_settings', 'app_users', 'excel_imports', 'whatsapp_test_message', 'weekly_closures', 'user_invites', 'notification_jobs']) expect(entityLabel(e), e).not.toMatch(/_|Registro del sistema/);
    expect(entityLabel('tabla_nueva')).toBe('Registro del sistema');
  });
});

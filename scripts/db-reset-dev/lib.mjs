// Reinicio CONTROLADO de los datos operativos de PRUEBA de VIP. No ejecuta DROP SCHEMA, no toca Auth ni la estructura.
import { readFileSync } from 'node:fs';

export const DEV = JSON.parse(readFileSync(new URL('../../supabase/dev-project.json', import.meta.url), 'utf8'));

/** Tablas operativas que se vacían (todas en UNA sola sentencia TRUNCATE, sin CASCADE: si algo más las referenciara, falla y revierte). */
export const RESET_TABLES = [
  'excel_payment_changes', 'excel_payment_days', 'collection_week_unit_changes', 'collection_week_units',   // 0026: sincronización de cobranza
  'collection_sync_runs', 'rate_corrections',                                                              // 0028: aplicaciones del Excel y correcciones de cuota
  'payment_allocations', 'payments', 'charges', 'adjustments', 'weekly_closures',
  'rate_exceptions', 'rates', 'assignments',
  'candidate_payments', 'import_rows', 'import_blocks', 'excel_imports',
  'notification_jobs', 'send_schedule_runs', 'whatsapp_test_messages', 'driver_consents', 'drivers', 'unit_agreement_history', 'units',
];
/** Se CONSERVAN: Auth, perfiles y roles, métodos de pago, horarios y plantillas (configuración), ajustes técnicos, sesión de WhatsApp y sus secretos, auditoría. */
export const KEEP_TABLES = ['profiles', 'app_users', 'user_invites', 'payment_methods', 'notification_schedules', 'send_schedules', 'template_variable_settings', 'template_text_settings', 'message_templates', 'app_settings', 'accounts', 'account_view', 'collection_summary', 'collection_summary_state', 'collection_summary_dirty', 'whatsapp_sessions', 'whatsapp_session_secrets', 'audit_logs'];
const KEEP_AUTH = 'auth.users';

export function confirmationPhrase(ref) { return `REINICIAR VIP DEV ${ref}`; }

/** Extrae el proyecto de la cadena de conexión (usuario «postgres.<ref>» del pooler o host «db.<ref>.supabase.co»). */
export function parseTarget(databaseUrl) {
  let u;
  try { u = new URL(databaseUrl); } catch { throw new Error('DATABASE_URL no es una URL válida.'); }
  const user = decodeURIComponent(u.username);
  const m1 = /^postgres\.([a-z0-9]{20})$/.exec(user);
  const m2 = /^db\.([a-z0-9]{20})\.supabase\.co$/.exec(u.hostname);
  const local = ['localhost', '127.0.0.1', '::1', ''].includes(u.hostname) || u.hostname.startsWith('/');
  return { host: u.hostname, database: u.pathname.slice(1) || 'postgres', ref: (m1 ?? m2)?.[1] ?? null, local };
}

/** Rechaza todo lo que no sea el proyecto de desarrollo autorizado. */
export function assertDevTarget({ databaseUrl, env = process.env, allowLocal = false, expectedRef = DEV.ref }) {
  if (/^(production|prod)$/i.test(env.VIP_ENV ?? '') || /^production$/i.test(env.NODE_ENV ?? '')) throw new Error('Entorno de producción detectado (VIP_ENV/NODE_ENV): operación rechazada.');
  const t = parseTarget(databaseUrl);
  if (t.local) { if (!allowLocal) throw new Error('El destino es una base local: solo se admite en pruebas.'); return { ...t, ref: expectedRef }; }
  if (!t.ref) throw new Error('No se pudo identificar el proyecto Supabase en DATABASE_URL (usuario «postgres.<ref>» o host «db.<ref>.supabase.co»): operación rechazada.');
  if (t.ref !== expectedRef) throw new Error(`El proyecto ${t.ref} NO es el proyecto de desarrollo autorizado (${expectedRef}): operación rechazada.`);
  return t;
}

const count = async (c, table) => Number((await c.query(`select count(*) n from ${table}`)).rows[0].n);
/** Tablas de la lista que EXISTEN en la base destino (una migración pendiente puede no haber creado aún alguna): se omiten las ausentes, nunca se crea ni se ignora una existente. */
const present = async (c, tables) => {
  const out = [];
  for (const t of tables) if ((await c.query(`select to_regclass($1) r`, [`public.${t}`])).rows[0].r) out.push(t);
  return out;
};

export async function snapshot(client) {
  const reset = {}; for (const t of await present(client, RESET_TABLES)) reset[t] = await count(client, `public.${t}`);
  const keep = {}; for (const t of KEEP_TABLES) keep[t] = await count(client, `public.${t}`);
  keep[KEEP_AUTH] = await count(client, KEEP_AUTH);
  return { reset, keep };
}

/** Vista previa (solo lectura). Exige que la propia base se declare «development». */
export async function planReset(client) {
  const env = (await client.query(`select environment from public.app_settings`)).rows[0]?.environment;
  if (env !== 'development') throw new Error(`La base de datos declara environment='${env}': solo se reinicia 'development'.`);
  const snap = await snapshot(client);
  const roles = (await client.query(`select role::text r, count(*)::int n from public.app_users group by role order by role`)).rows;
  return { environment: env, ...snap, roles, total: Object.values(snap.reset).reduce((a, b) => a + b, 0) };
}

/** Reinicio en una transacción. Verifica antes y después; ante cualquier error revierte TODO. */
export async function executeReset(client, { typed, ref = DEV.ref, beforeCommit } = {}) {
  if (typed !== confirmationPhrase(ref)) throw new Error('Frase de confirmación incorrecta: no se hizo ningún cambio.');
  await client.query('begin');
  try {
    await client.query(`set local lock_timeout = '8s'`);
    const plan = await planReset(client);
    await client.query(`truncate table ${Object.keys(plan.reset).map((t) => `public.${t}`).join(', ')} restart identity`);   // sin CASCADE
    const after = await snapshot(client);
    const nonEmpty = Object.entries(after.reset).filter(([, n]) => n !== 0);
    if (nonEmpty.length) throw new Error(`Tablas que no quedaron vacías: ${nonEmpty.map(([t]) => t).join(', ')}`);
    for (const [t, n] of Object.entries(plan.keep)) if (after.keep[t] !== n) throw new Error(`La tabla conservada ${t} cambió (${n} → ${after.keep[t]}).`);
    const fk = (await client.query(`select count(*)::int n from pg_constraint c where c.contype='f' and not c.convalidated`)).rows[0].n;
    if (fk) throw new Error('Hay claves foráneas sin validar tras el reinicio.');
    await client.query(`insert into public.audit_logs(actor, action, entity, detail) values (null, 'db_reset_dev', 'database', $1)`, [JSON.stringify({ ref, removed: plan.reset })]);
    if (beforeCommit) await beforeCommit();
    await client.query('commit');
    return { removed: plan.reset, kept: plan.keep, total: plan.total };
  } catch (e) { await client.query('rollback'); throw e; }
}

/** Códigos de error de la API → mensajes en español. */
const MESSAGES: Record<string, string> = {
  forbidden: 'No tienes permiso para realizar esta acción.',
  not_authenticated: 'Tu sesión expiró. Inicia sesión de nuevo.',
  unauthorized: 'Tu sesión expiró. Inicia sesión de nuevo.',
  assignment_not_found: 'No se encontró la asignación del conductor.',
  manual_payments_disabled: 'El registro manual de pagos está deshabilitado: los pagos entran desde el Excel.',
  invalid_method: 'El método de pago no es válido o está desactivado.',
  invalid_amount: 'El monto no es válido.',
  amount_not_covering_commission: 'El monto no cubre la comisión del proveedor.',
  idempotency_conflict: 'Esta operación ya se registró con otros datos. Vuelve a intentarlo desde cero.',
  week_closed: 'La semana ya está cerrada.',
  payment_not_found: 'No se encontró el pago.',
  already_voided: 'Este pago ya fue anulado.',
  notification_not_found: 'No se encontró el aviso.',
  invalid_state: 'El aviso ya no está pendiente de revisión.',
  validation_error: 'Revisa los datos ingresados.',
  invalid_file: 'El archivo no es un Excel (.xlsx) válido.',
  file_too_large: 'El archivo es demasiado grande.',
  whatsapp_unavailable: 'WhatsApp no está disponible en este momento.',
  invalid_body: 'Los datos enviados no son válidos. Revisa el formulario.',
  invalid_input: 'Algún dato tiene un formato inválido.',
  not_awaiting_approval: 'El aviso ya no está pendiente de aprobación.',
  invalid_phone: 'El número no es válido. Escríbelo con código de país, por ejemplo +507 6000 0000.',
  recipient_is_a_driver: 'Ese número pertenece a un conductor: los mensajes de prueba nunca se envían a conductores.',
  recipient_authorization_required: 'Indica quién autoriza que ese número reciba la prueba.',
  confirm_last4_mismatch: 'Los últimos 4 dígitos no coinciden con el número de destino.',
  real_test_already_pending: 'Ya hay un envío real de prueba pendiente. Espera a que termine o cancélalo.',
  not_cancellable: 'Ese mensaje ya no se puede cancelar.',
  method_not_found: 'El método de pago no existe o está desactivado.',
  invalid_mode: 'El modo de envío no es válido.',
  session_not_found: 'No se encontró la sesión de WhatsApp (o el código QR ya venció).',
  assignment_inactive: 'La asignación ya no está vigente.',
  paid_at_in_future: 'La fecha del pago no puede ser futura.',
  reason_required: 'Debes indicar un motivo.',
  week_start_must_be_monday: 'La semana debe empezar en lunes.',
  xlsx_required: 'Sube un archivo Excel válido (.xlsx).',
  file_required: 'Selecciona un archivo.',
  invalid_workbook: 'El libro de Excel no tiene el formato esperado.',
  import_state: 'La importación ya no está en un estado que permita esta acción.',
  unsupported_workbook: 'Este archivo no es el Excel de cobranza. Revisa que tenga las columnas UND, CUENTA, SALDO y LUNES a DOMINGO.',
  historical_import_requires_confirmation: 'Esta importación es anterior a datos más recientes: confírmala de forma explícita e indica el motivo.',
  invalid_data_date: 'La fecha de corte no puede ser futura.',
  import_has_errors: 'El archivo tiene errores: corrígelos en el Excel y vuelve a subirlo. No se guardó nada.',
  import_not_found: 'No se encontró la importación.',
  import_not_confirmed: 'Primero debes confirmar la importación.',
  import_already_applied: 'Esta importación ya fue aplicada.',
  invalid_status: 'El estado indicado no es válido.',
  invalid_email: 'El correo no es válido.',
  not_authorized: 'Esta cuenta no está autorizada para usar VIP',
  auth_check_failed: 'No se pudo comprobar la autorización de la cuenta. Inténtalo de nuevo.',
  db_not_configured: 'La base de datos de VIP aún no está configurada: faltan las migraciones de Supabase. Contacta al administrador técnico.',
  auth_unreachable: 'No se pudo conectar con el servidor. Revisa tu conexión e inténtalo de nuevo.',
  rate_change_retroactive: 'Ya hay cuotas generadas desde esa fecha; la nueva tarifa solo puede aplicar hacia adelante.',
  rate_change_closed_week: 'Esa fecha cae en una semana ya cerrada; no se puede cambiar la tarifa allí.',
  delete_blocked_has_history: 'No se puede eliminar: tiene historial financiero. Puedes darlo de baja (archivar) y reactivarlo después.',
  already_archived: 'Ya estaba dado de baja.', not_archived: 'No está dado de baja.', reason_too_long: 'El motivo es demasiado largo.',
  schedule_not_found: 'No se encontró el horario.',
  activation_not_confirmed: 'Falta la confirmación de la activación. Vuelve a abrir la confirmación y pulsa «Activar horario».',
  template_has_unresolved_variables: 'La plantilla tiene variables que no se pueden resolver; corrígela antes de activar el horario.',
  already_active: 'Este horario ya estaba activo.',
  direct_activation_forbidden: 'Un horario no se activa desde su formulario: usa «Activar horario» y confirma.',
  request_timeout: 'No se pudo cargar la vista previa: el servidor tardó demasiado en responder.',
  whatsapp_other_account: 'El WhatsApp conectado pertenece a otra cuenta: desde esta no se puede enviar ni controlar la conexión.',
  account_not_found: 'Esa cuenta no existe.',
  selection_required: 'Elige al menos un conductor para activar este horario.',
  invalid_name: 'El nombre puede tener hasta 60 caracteres.',
  variable_not_found: 'Esa variable no existe.',
  invalid_label: 'Escribe un nombre para la variable.',
  invalid_text: 'Escribe el texto (hasta 300 caracteres).',
  text_bad_marker: 'Solo se permite el marcador {monto} (y no en la frase «al día»).',
  text_needs_amount: 'La frase debe incluir {monto}: se reemplaza por el importe calculado.',
  text_hardcoded_amount: 'No escribas importes con $: usa {monto} para que el valor se calcule solo.',
  text_no_variables: 'Aquí no se pueden usar variables con {{ }}; usa solo {monto}.',
  template_required: 'Asigna una plantilla antes de activar este horario.',
  template_in_use: 'Esta plantilla está en uso por horarios; asigna otra plantilla a esos horarios antes de eliminarla.',
  rate_overlap: 'Las fechas de esa tarifa se solapan con otra tarifa del mismo conductor.',
  assignment_change_retroactive: 'No se puede modificar la asignación con efecto en el pasado.',
  range_too_large: 'El rango de fechas es demasiado grande. Elige uno más corto.',
  rate_history_immutable: 'El historial de tarifas no se puede editar ni borrar; registra un cambio de tarifa nuevo.',
  assignment_overlap: 'Las fechas se solapan con otra asignación de ese conductor o de esa unidad.',
  driver_already_assigned: 'Ese conductor ya tiene una unidad asignada. Cierra su asignación vigente primero.',
  invalid_dates: 'Las fechas indicadas no son válidas para esta operación.',
  assignment_already_ended: 'La asignación ya estaba cerrada.',
  invalid_range: 'El rango de fechas no es válido (máximo 400 días).',
  invalid_indicator: 'El indicador solicitado no existe.',
  template_not_found: 'No se encontró la plantilla.',
  internal_error: 'Error interno del servidor. Inténtalo más tarde.',
  network: 'No se pudo conectar con el servidor. Revisa tu conexión e inténtalo de nuevo.',
  api_unreachable: 'No se pudo contactar el servidor de VIP. Inténtalo de nuevo; si persiste, avisa a soporte.',
  user_not_found: 'No se encontró esa cuenta.',
  last_super_admin: 'No se puede eliminar, suspender ni degradar al último SUPER_ADMIN activo.',
  user_already_authorized: 'Esa cuenta ya tiene acceso a VIP.',
  invite_not_found: 'No se encontró la invitación.',
  service_role_not_configured: 'Este servidor solo puede invitar: usa «Solo invitar» y luego crea la cuenta en Supabase → Authentication → Users con ese correo; el rol se asigna solo.',
  auth_user_exists: 'Ya existe una cuenta con ese correo en el sistema de acceso.',
  auth_create_failed: 'No se pudo crear la cuenta en el sistema de acceso. Inténtalo de nuevo.',
  auth_reset_failed: 'No se pudieron restablecer las credenciales en el sistema de acceso. Inténtalo de nuevo; la contraseña anterior sigue vigente.',
  cannot_reset_own_credentials: 'No puedes restablecer tus propias credenciales: cambia tu contraseña desde tu perfil.',
  role_deprecated: 'El rol SUPERVISOR ya no se asigna: elige ADMIN o SUPER_ADMIN.',
  consent_required: 'Este conductor no tiene autorización de cobranza vigente. Registra o confirma su autorización en la ficha del conductor.',
  driver_without_phone: 'Falta el teléfono en la ficha del conductor.',
  no_sync: 'Aún no hay una importación exitosa del Excel: importa el archivo antes de enviar.',
  unit_inactive: 'La unidad está inactiva.',
  assignment_ended: 'La unidad ya no está asignada a este operario.',
  phone_shared: 'Ese número está registrado en otro operario: corrígelo antes de enviar.',
  whatsapp_disconnected: 'WhatsApp no está conectado: conéctalo en Mensajería → Conexión.',
  too_many_recipients: 'Son demasiados destinatarios a la vez (máximo 300).',
  already_sent_today: 'Ya se envió hoy un mensaje con esta plantilla a este operario.',
  template_unresolved: 'La plantilla usa datos que este operario no tiene (por ejemplo apellido). Corrige la plantilla o los datos.',
  send_failed: 'No se pudo enviar el mensaje. Inténtalo de nuevo.',
  driver_inactive: 'El conductor no está activo.',
  too_soon: 'Se envió un mensaje hace poco; espera la separación mínima configurada.',
  block_not_found: 'No se encontró ese bloque del Excel en la importación.',
  wrong_import_kind: 'Esta importación no es una planilla de cobranza por bloques: no tiene SALDO que conciliar.',
  not_unconfirmed: 'Ese mensaje ya no está pendiente de confirmar.',
  unconfirmed_result_pending: 'Hay un envío real sin confirmar; revísalo antes de enviar otro.',
  invalid_role: 'El rol indicado no es válido.',
  invalid_minutes: 'Los minutos deben estar entre 0 y 60.',
  organization_mismatch: 'Los datos no corresponden a esta instalación de VIP.',
  idempotency_key_required: 'Falta la clave de la operación: vuelve a intentarlo.',
  agreement_too_long: 'El acuerdo supera los 200 caracteres.',
  note_too_long: 'La observación es demasiado larga.',
  unit_not_found: 'No se encontró la unidad.',
  driver_not_found: 'No se encontró el conductor.',
  invalid_resolve: 'No se pudo confirmar el resultado: los datos no son válidos.',
  invalid_kind: 'El tipo indicado no es válido.',
  admin_already_set: 'Esa cuenta ya tiene un rol asignado.',
  already_set: 'Eso ya estaba configurado.',
  invalid_action: 'La acción indicada no es válida.',
  consent_source_required: 'Indica el origen de la autorización para poder guardarla.',
  consent_requires_phone: 'No hay autorización sin un número de WhatsApp válido.',
  consent_requires_declaration: 'La autorización de WhatsApp solo se registra con su origen desde la ficha del conductor.',
  invalid_purpose: 'La finalidad de la autorización no es válida.',
  database_not_configured: 'El servidor de VIP no tiene conexión configurada a la base de datos. Inícialo con «pnpm dev» (o «pnpm dev:setup» la primera vez) y reintenta.',
  schema_outdated: 'La base de datos no está actualizada con la última versión de VIP. Avisa al administrador técnico.',
  not_configured: 'La aplicación aún no está configurada. Avisa al administrador técnico.',
};

export const GENERIC_ERROR = 'Ocurrió un error inesperado. Inténtalo de nuevo.';
/** Separador (invisible) entre el mensaje y el detalle técnico dentro del texto de error; ver `<app-err>`. */
export const DETAIL_SEP = '\u2063';

export type ErrorOrigin = 'auth' | 'supabase' | 'api' | 'network' | 'desconocido';
export interface ErrorCtx { origin: ErrorOrigin; http?: number; code?: string; message?: string; where?: string }

export class ApiError extends Error {
  /** Mensaje ya redactado (p. ej. api_unreachable incluye método, ruta y HTTP). */
  userMessage?: string;
  /** Cuerpo de la respuesta de error (p. ej. blockers y suggestion de delete_blocked_has_history). */
  payload?: unknown;
  constructor(public readonly code: string, public readonly status = 0, public readonly ctx?: ErrorCtx) {
    super(code);
    this.name = 'ApiError';
  }
}

/** Error «la API no respondió como API» (HTML, 404/502/503/504 sin cuerpo {error}, fallo de red). */
export function apiUnreachable(method: string, path: string, http: number, raw?: string): ApiError {
  const e = new ApiError('api_unreachable', http, { origin: http === 0 ? 'network' : 'api', http, where: `${method} ${path}`, message: raw });
  e.userMessage = 'No se pudo contactar el servidor de VIP. Inténtalo de nuevo; si persiste, avisa a soporte.';
  return e;
}

const AUTH_CODES = new Set(['not_authorized', 'auth_check_failed', 'not_authenticated', 'unauthorized']);
const SUPABASE_CODES = new Set(['db_not_configured', 'auth_unreachable']);
type Obj = Record<string, unknown>;

function pgrstMessage(code: string, text: string): string | null {
  if (code === 'PGRST202' || code === 'PGRST205' || code === '42883' || code === '42P01') return MESSAGES['db_not_configured']!;
  if (code === '42501' || /permission denied|row-level security/i.test(text)) return MESSAGES['forbidden']!;
  if ((code === '23505' || /duplicate key/i.test(text)) && /message_templates/i.test(text)) return 'Ya existe una plantilla con ese nombre. Elige otro nombre.';
  if (code === '23514' && /message_templates/i.test(text)) return 'La plantilla no cumple las reglas: nombre y texto no pueden estar vacíos y el texto admite hasta 1000 caracteres.';
  if ((code === '23505' || /duplicate key/i.test(text)) && /units?[_"' ]*(code|key)|units_/i.test(text)) return 'Ya existe una unidad con ese código (se ignoran mayúsculas y espacios: «P300» = «p300»).';
  if (code === '23505' || /duplicate key/i.test(text)) return 'Ya existe un registro con esos datos (código, cédula o fechas solapadas).';
  if (code === '23P01' || /exclusion/i.test(text)) return MESSAGES['assignment_overlap']!;
  if (code === 'PGRST116') return 'No se encontró el registro.';
  return null;
}

/** Clasifica cualquier error: mensaje en español + contexto técnico (origen, HTTP, código, mensaje original, ruta/tabla). */
export function classifyError(err: unknown): { message: string; ctx: ErrorCtx } {
  if (err instanceof ApiError) {
    const origin: ErrorOrigin = err.ctx?.origin ?? (err.code === 'network' ? 'network' : AUTH_CODES.has(err.code) ? 'auth' : SUPABASE_CODES.has(err.code) ? 'supabase' : 'api');
    const known = err.userMessage ?? MESSAGES[err.code];
    return { message: known ?? GENERIC_ERROR, ctx: { origin, http: err.status || err.ctx?.http, code: err.code, ...err.ctx } };
  }
  if (typeof err === 'string') return { message: MESSAGES[err] ?? GENERIC_ERROR, ctx: { origin: MESSAGES[err] ? 'api' : 'desconocido', code: err } };
  if (err && typeof err === 'object') {
    const o = err as Obj;
    const m = String(o['message'] ?? '');
    const code = o['code'] !== undefined ? String(o['code']) : undefined;
    const http = typeof o['status'] === 'number' ? (o['status'] as number) : undefined;
    const where = typeof o['where'] === 'string' ? (o['where'] as string) : undefined;
    const text = `${m} ${String(o['details'] ?? '')}`;
    const isAuth = /invalid login credentials|email not confirmed|rate limit|too many/i.test(m) || /^Auth/.test(String(o['name'] ?? '')) || o['__isAuthError'] === true;
    const base = { http, code, message: m || undefined, where };
    if (MESSAGES[m]) return { message: MESSAGES[m]!, ctx: { origin: AUTH_CODES.has(m) ? 'auth' : 'api', ...base } };
    if (/invalid login credentials/i.test(m)) return { message: 'Correo o contraseña incorrectos.', ctx: { origin: 'auth', ...base } };
    if (/email not confirmed/i.test(m)) return { message: 'Debes confirmar tu correo antes de entrar.', ctx: { origin: 'auth', ...base } };
    if (/rate limit|too many/i.test(m)) return { message: 'Demasiados intentos. Espera un momento.', ctx: { origin: 'auth', ...base } };
    if (/failed to fetch|networkerror|load failed/i.test(m)) return { message: MESSAGES['network']!, ctx: { origin: 'network', ...base } };
    const pg = pgrstMessage(code ?? '', text);
    if (pg) return { message: pg, ctx: { origin: isAuth ? 'auth' : 'supabase', ...base } };
    if (code || where) return { message: GENERIC_ERROR, ctx: { origin: isAuth ? 'auth' : 'supabase', ...base } };
    return { message: GENERIC_ERROR, ctx: { origin: 'desconocido', ...base } };
  }
  return { message: GENERIC_ERROR, ctx: { origin: 'desconocido', message: String(err) } };
}

const ORIGIN_LABEL: Record<ErrorOrigin, string> = { auth: 'autenticación (Supabase Auth)', supabase: 'Supabase (PostgREST/Postgres)', api: 'API de VIP', network: 'red', desconocido: 'desconocido' };

/** Línea de «Detalle técnico»: origen, HTTP/código, ruta o tabla y mensaje original. */
export function detailLine(ctx: ErrorCtx): string {
  return [`origen: ${ORIGIN_LABEL[ctx.origin]}`, ctx.http ? `HTTP ${ctx.http}` : null, ctx.code ? `código: ${ctx.code}` : null,
    ctx.where ? `ruta/tabla: ${ctx.where}` : null, ctx.message ? `mensaje original: ${ctx.message}` : null].filter(Boolean).join(' · ');
}

/** Mensaje en español + (tras DETAIL_SEP) el detalle técnico. Siempre lleva detalle; también hace console.error estructurado. */
export function errorMessage(err: unknown): string {
  const { message, ctx } = classifyError(err);
  const detail = detailLine(ctx) + (ctx.origin === 'desconocido' && !ctx.message ? ` · valor: ${safeString(err)}` : '');
  console.error('[VIP] error', { message, ...ctx, raw: err });
  return `${message}${DETAIL_SEP}${detail}`;
}
const safeString = (v: unknown): string => { try { return typeof v === 'object' ? JSON.stringify(v) : String(v); } catch { return String(v); } };

/** Separa el texto devuelto por `errorMessage`. */
export function splitError(text: string): { message: string; detail: string | null } {
  const i = text.indexOf(DETAIL_SEP);
  return i < 0 ? { message: text, detail: null } : { message: text.slice(0, i), detail: text.slice(i + 1) };
}

/** ¿El servidor dice que su base de datos no está actualizada (función nueva ausente)? Reintentar no sirve. */
export const isSchemaOutdated = (e: unknown): boolean => e instanceof ApiError && (e.code === 'schema_outdated' || (e.status === 503 && e.code !== 'database_not_configured'));
/** Espera una promesa con límite de tiempo: si tarda más, rechaza con un ApiError visible (nunca queda un estado ocupado colgado). */
/** Para operaciones que escriben: al agotarse el tiempo NO se sabe si se hicieron, así que se pide comprobarlo antes de repetir. */
export const SAVE_TIMEOUT_MS = 20_000;
export const timedOut = (e: unknown): boolean => e instanceof ApiError && e.code === 'request_timeout';

export function withTimeout<T>(p: Promise<T>, ms = 15_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new ApiError('request_timeout', 0)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/** Cambia solo el mensaje de un error ya redactado (conserva el «Detalle técnico» plegado). */
export function withMessage(text: string, message: string): string { const { detail } = splitError(text); return detail ? `${message}${DETAIL_SEP}${detail}` : message; }
export const SCHEMA_OUTDATED_ACTIVATION = 'La base de datos necesita una actualización. Contacta al administrador técnico.';

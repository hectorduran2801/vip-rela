/** Códigos de negocio que la base de datos devuelve como mensaje de excepción → HTTP. */
const MAP: Record<string, number> = {
  not_authenticated: 401, forbidden: 403,
  assignment_not_found: 404, payment_not_found: 404, notification_not_found: 404, session_not_found: 404, import_not_found: 404, block_not_found: 404,
  idempotency_conflict: 409, already_voided: 409, week_closed: 409, not_awaiting_approval: 409,
  organization_mismatch: 422, invalid_amount: 422, invalid_method: 422, amount_not_covering_commission: 422,
  idempotency_key_required: 422, paid_at_in_future: 422, assignment_inactive: 422, reason_required: 422,
  week_start_must_be_monday: 422, import_not_confirmed: 409, import_already_applied: 409, invalid_status: 422,
  import_state: 409, assignment_overlap: 409, assignment_already_ended: 409, driver_already_assigned: 409, invalid_dates: 422,
  agreement_too_long: 422, note_too_long: 422, unit_not_found: 404, invalid_range: 422, invalid_role: 422, invalid_minutes: 422, wrong_import_kind: 409, invalid_resolve: 422, last_super_admin: 409, invalid_indicator: 422, user_not_found: 404, admin_already_set: 409, invalid_action: 422,
  invalid_phone: 422, recipient_is_a_driver: 422, recipient_authorization_required: 422, confirm_last4_mismatch: 422, real_test_already_pending: 409,
  not_cancellable: 409, consent_required: 422, driver_without_phone: 422, driver_inactive: 409, too_soon: 409, invalid_body: 422, invalid_kind: 422, unconfirmed_result_pending: 409, not_unconfirmed: 409, invalid_email: 422, user_already_authorized: 409, invite_not_found: 404, role_deprecated: 422, consent_source_required: 422, consent_requires_phone: 422, consent_requires_declaration: 403, invalid_purpose: 422, driver_not_found: 404, method_not_found: 404, invalid_mode: 422,
  rate_change_retroactive: 409, rate_change_closed_week: 409, rate_overlap: 409, assignment_change_retroactive: 409, range_too_large: 422, rate_history_immutable: 403,
  whatsapp_other_account: 403, account_not_found: 404, selection_required: 422, invalid_name: 422, variable_not_found: 404, invalid_label: 422, invalid_text: 422, text_bad_marker: 422, text_needs_amount: 422, text_hardcoded_amount: 422, text_no_variables: 422, template_required: 422, template_in_use: 409, template_not_found: 404, schedule_not_found: 404,
  activation_not_confirmed: 422, template_has_unresolved_variables: 422, already_active: 409, direct_activation_forbidden: 403,
  delete_blocked_has_history: 409, already_archived: 409, not_archived: 409, reason_too_long: 422,
};

export function mapDbError(e: unknown): { status: number; error: string } | null {
  const msg = e instanceof Error ? e.message : '';
  if (msg in MAP) return { status: MAP[msg]!, error: msg };
  const code = (e as { code?: string }).code;
  if (code === '42501') return { status: 403, error: 'forbidden' };      // permiso denegado / RLS
  if (code === '22P02' || code === '22023') return { status: 422, error: 'invalid_input' };
  // Esquema desactualizado (columna/tabla/función inexistente): la base no tiene aún una migración que el código espera. Error CONTROLADO y accionable, no un 500 genérico.
  if (code === '42703' || code === '42P01' || code === '42883') return { status: 503, error: 'schema_outdated' };
  // El Excel plano usa source_kind='collection_flat', que solo admite la migración 0026: sin ella el CHECK lo rechaza. Es esquema desactualizado, no un fallo interno.
  if (code === '23514' && (e as { constraint?: string }).constraint === 'excel_imports_source_kind_check') return { status: 503, error: 'schema_outdated' };
  return null;
}

/** Errores de activación de horarios cuya explicación (en español, sin datos sensibles) se devuelve también al cliente. */
export const EXPLAINED = new Set(['activation_not_confirmed', 'template_required', 'template_has_unresolved_variables', 'already_active', 'direct_activation_forbidden']);

/** Detalle estructurado para la UI: texto de la base y, si aplica, la lista de variables desconocidas ({{x}} → x). */
export function explainDbError(e: unknown, code: string): { detail?: string; hint?: string; unknown_variables?: string[] } {
  if (!EXPLAINED.has(code)) return {};
  const x = e as { detail?: string; hint?: string };
  const out: { detail?: string; hint?: string; unknown_variables?: string[] } = {};
  if (x.detail) out.detail = x.detail;
  if (x.hint) out.hint = x.hint;
  if (code === 'template_has_unresolved_variables' && x.detail) out.unknown_variables = [...x.detail.matchAll(/\{\{([^{}]*)\}\}/g)].map((m) => m[1]!);
  return out;
}

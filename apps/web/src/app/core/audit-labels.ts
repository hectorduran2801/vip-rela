/** Etiquetas en español de la Auditoría: acciones del servidor (app_private.audit y triggers) y entidades/tablas. El valor técnico solo va en el «Detalle técnico». */
const ACTIONS: Record<string, string> = {
  insert: 'Alta', update: 'Modificación', delete: 'Eliminación',
  apply_directory_import: 'Importación de conductores y unidades aplicada', apply_import: 'Importación de cobranza aplicada', apply_opening_balances: 'Deuda anterior (SALDO) registrada',
  import_driver_name_change: 'Nombre del operario actualizado por el Excel',
  apply_collection_sync: 'Cobranza del Excel sincronizada', collection_sync_opening: 'Deuda anterior (SALDO del Excel) registrada', collection_sync_saldo_adjustment: 'Ajuste por conciliación del SALDO del Excel',
  change_rate: 'Cambio de tarifa', close_week: 'Cierre de semana', create_adjustment: 'Ajuste registrado', end_assignment: 'Asignación terminada', start_assignment: 'Asignación iniciada',
  delete_driver: 'Conductor eliminado', delete_unit: 'Unidad eliminada', archive_driver: 'Conductor archivado', archive_unit: 'Unidad archivada', reactivate_driver: 'Conductor reactivado', reactivate_unit: 'Unidad reactivada',
  notification_cancelled_schedule_changed: 'Mensaje cancelado: el horario cambió', schedule_auto_deactivated: 'Horario desactivado automáticamente (cambió su configuración)', schedule_activated: 'Horario activado', schedule_deactivated: 'Horario desactivado', template_created_from_default: 'Plantilla creada desde el texto base', notification_no_template: 'Mensaje omitido: horario sin plantilla', notification_unresolved: 'Aviso reabierto (sin resolver)', generate_daily_charges: 'Cuotas diarias generadas', ensure_daily_charges: 'Cuotas diarias aseguradas', ensure_daily_charges_gaps: 'Cuotas diarias: huecos detectados', register_payment: 'Pago registrado', void_payment: 'Pago anulado',
  invite_assigned: 'Rol asignado por invitación', invite_cancelled: 'Invitación cancelada', invite_consumed: 'Invitación utilizada', invite_created: 'Invitación creada',
  open_user_creation: 'Ventana de alta de usuarios abierta', remove_app_user: 'Acceso de usuario eliminado', set_app_user: 'Rol de usuario asignado',
  user_suspended: 'Cuenta suspendida', user_reactivated: 'Cuenta reactivada',
  set_unit_agreement: 'Acuerdo de unidad cambiado', set_unit_condition: 'Condición de unidad cambiada',
  'driver_consent.granted': 'Autorización de WhatsApp registrada', 'driver_consent.withdrawn': 'Autorización de WhatsApp retirada',
  'import_end_assignment': 'Asignación finalizada por la importación del Excel', 'import_reopen_assignment': 'Asignación reabierta por la importación del Excel', 'super.account_write': 'Cambio hecho por el SUPER_ADMIN en esta cuenta', 'account.viewed': 'Cuenta de otra persona consultada', 'profile.name_changed': 'Nombre de la cuenta cambiado', 'assignment.commission': 'Comisión de pago activada o desactivada', 'template_variable.saved': 'Variable de plantilla editada', 'template_variable.reset': 'Variable de plantilla restablecida', 'template_text.saved': 'Frase de variable editada', 'template_text.reset': 'Frase de variable restablecida', request_whatsapp_connected: 'Conexión de WhatsApp solicitada', request_whatsapp_disconnected: 'Desconexión de WhatsApp solicitada', request_whatsapp_logout: 'Cierre de sesión de WhatsApp solicitado', user_credentials_reset: 'Credenciales de cuenta restablecidas', 'send_schedule.saved': 'Horario de envío guardado', 'send_schedule.deleted': 'Horario de envío eliminado', 'send_schedule.ran': 'Horario de envío ejecutado',
  review_notification_approve: 'Aviso aprobado', review_notification_edit: 'Aviso editado', review_notification_discard: 'Aviso descartado',
  'whatsapp.driver_message.created': 'Mensaje a conductor creado', 'whatsapp.collection_message.created': 'Mensaje de cobranza enviado con plantilla', 'collection_sync_historical': 'Importación antigua confirmada', 'purge_collection_messages': 'Jornada nueva: mensajes de días anteriores eliminados', 'collection_sync_rate_correction': 'Cuota corregida desde el Excel', 'whatsapp.test_message.created': 'Mensaje de prueba creado', 'whatsapp.test_message.resolved': 'Resultado de mensaje de prueba confirmado',
  db_reset_dev: 'Base de desarrollo reiniciada',
};
const OUTCOME: Record<string, string> = { simulated: 'simulado', sent: 'enviado', delivered: 'entregado', failed: 'fallido', unconfirmed: 'sin confirmar', cancelled: 'cancelado', processing: 'en proceso', prepared: 'preparado' };

export function actionLabel(action: string): string {
  if (ACTIONS[action]) return ACTIONS[action]!;
  const m = /^whatsapp\.test_message\.([a-z_]+)$/.exec(action);
  if (m) return `Mensaje de prueba ${OUTCOME[m[1]!] ?? 'actualizado'}`;
  return 'Acción del sistema';
}

const ENTITIES: Record<string, string> = {
  drivers: 'Conductor', driver: 'Conductor', units: 'Unidad', assignments: 'Asignación', rates: 'Tarifa', rate_exceptions: 'Tarifa especial', payments: 'Pago', payment_methods: 'Método de pago',
  adjustments: 'Ajuste', charges: 'Cuotas', weekly_closures: 'Cierre semanal', app_settings: 'Configuración', app_users: 'Usuario', user_invites: 'Invitación', excel_imports: 'Importación de Excel',
  message_templates: 'Plantilla de mensaje', notification_schedules: 'Horario de recordatorios', notification_jobs: 'Mensaje programado', whatsapp_sessions: 'Sesión de WhatsApp',
  whatsapp_test_message: 'Mensaje de WhatsApp', unit_condition_types: 'Tipo de condición de unidad', profiles: 'Perfil',
};
export const entityLabel = (e: string): string => ENTITIES[e] ?? 'Registro del sistema';
/** Códigos de acción/entidad conocidos (para pruebas). */
export const KNOWN_AUDIT_ACTIONS = Object.keys(ACTIONS);
export const KNOWN_AUDIT_ENTITIES = Object.keys(ENTITIES);

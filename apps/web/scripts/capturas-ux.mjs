// Capturas de la reorganización UX (sidebar de 7 módulos, Cobranza expandible, Mensajería, Conductores con autorización, Configuración,
// Datos) con red SIMULADA: sirve dist/web y responde Supabase y la API con page.route. Todo host externo se ABORTA y no se envía ningún
// WhatsApp. Datos de PRUEBA. Uso:
//   pnpm --filter @vip/web build && PLAYWRIGHT_PATH=/ruta/playwright/index.mjs node apps/web/scripts/capturas-ux.mjs
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, '..', 'dist', 'web', 'browser');
const out = join(here, '..', '..', '..', 'docs', 'capturas-diseno');
mkdirSync(out, { recursive: true });
const { chromium } = await import(process.env.PLAYWRIGHT_PATH ?? 'playwright');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.ico': 'image/x-icon', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const server = createServer((req, res) => {
  let p = join(dist, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!existsSync(p) || statSync(p).isDirectory()) p = join(dist, 'index.html');
  res.writeHead(200, { 'content-type': TYPES[extname(p)] ?? 'application/octet-stream' });
  res.end(readFileSync(p));
});
await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;

// ---------- Datos de PRUEBA ----------
const S = { role: 'super_admin', paid: false, calls: [], delay: 0, wa: {}, slowExport: 0, gaps: [] };
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const drv = (id, op, nid, fn, ln, phone, consent, src, promo = false) => ({ id, operator_code: op, national_id: nid, first_name: fn, last_name: ln, phone: null, phone_e164: phone, whatsapp_consent: consent, whatsapp_consent_source: src,
  promotional_consent: promo, promotional_consent_at: promo ? '2026-11-02T15:00:00Z' : null, reminders_paused: false, reminders_paused_reason: null, license_number: null, license_expires_on: null, status: 'active', notes: null });
const drivers = [
  drv('d1', '101', '8-100-1001', 'Conductor', 'Prueba A', '+50760000001', true, 'legacy_unverified'),
  drv('d2', '202', '8-200-2002', 'Conductora María Fernanda', 'de los Ángeles Prueba B', '+50760000002', true, 'verbal_admin', true),
  drv('d3', '303', '8-300-3003', 'Luis', 'Gómez', '+50760000003', false, null),
  drv('d4', '404', '8-400-4004', 'Eva', 'Ruiz', null, false, null),
  drv('d5', '505', '8-500-5005', 'Mario', 'Soto', '+50760000005', true, 'signed_form'),
];
const MOVS = [
  { assignment_id: 'a1', occurred_at: '2026-11-16T14:05:00Z', kind: 'adjustment', ref_id: 'j2', amount_cents: 700, commission_cents: null, detail: 'Daño en la llanta', actor: null },
  { assignment_id: 'a1', occurred_at: '2026-11-15T17:30:00Z', kind: 'payment_void', ref_id: 'p0', amount_cents: -1000, commission_cents: null, detail: 'Error de digitación', actor: null },
  { assignment_id: 'a1', occurred_at: '2026-11-14T16:10:00Z', kind: 'payment', ref_id: 'p1', amount_cents: 3500, commission_cents: 100, detail: 'vigente', actor: null },
  { assignment_id: 'a1', occurred_at: '2026-11-13T09:00:00Z', kind: 'adjustment', ref_id: 'j1', amount_cents: -500, commission_cents: null, detail: 'Descuento acordado', actor: null },
  { assignment_id: 'a1', occurred_at: '2026-11-12T11:00:00Z', kind: 'charge', ref_id: 'c1', amount_cents: 3600, commission_cents: null, detail: '2026-11-12', actor: null },
  { assignment_id: 'a1', occurred_at: '2026-11-02T12:00:00Z', kind: 'opening', ref_id: 'o1', amount_cents: 5000, commission_cents: null, detail: 'Deuda anterior (apertura) al 2026-11-02', actor: null },
];
const units = ['T-1', 'T-2', 'T-3', 'T-4', 'T-5'].map((c, i) => ({ id: `u${i + 1}`, code: c, plate: `AB-${1000 + i}`, make: 'Toyota', model: 'Corolla', year: 2020, vehicle_status: 'active', notes: null, agreement: i === 0 ? 'CUSTODIA' : null, agreement_note: null }));
const assignments = drivers.map((d, i) => ({ id: `a${i + 1}`, driver_id: d.id, unit_id: `u${i + 1}`, valid_from: '2026-01-05', valid_to: null, agreement_note: null }));
const rates = assignments.map((a) => ({ assignment_id: a.id, daily_amount_cents: 3600, valid_from: '2026-01-05' }));
const CATALOG = [
  ['Datos del conductor', 'nombre', 'Nombre', 'Solo el nombre del conductor.', 'Vanessa'], ['Datos del conductor', 'apellido', 'Apellido', 'Solo el apellido.', 'Ejemplo'], ['Datos del conductor', 'nombre_completo', 'Nombre completo', 'Nombre y apellido.', 'Vanessa Ejemplo'],
  ['Unidad y operario', 'unidad', 'Unidad', 'Código de la unidad asignada.', '4321'], ['Unidad y operario', 'codigo_operario', 'Código de operario', 'Código interno del operario.', '1234'],
  ['Fechas', 'fecha', 'Fecha', 'Fecha completa en español.', 'lunes 16 de noviembre de 2026'],
  ['Importes financieros', 'cuota_hoy', 'Cuota de hoy', 'Cuota diaria de hoy.', '$40.00'], ['Importes financieros', 'pendiente_hoy', 'Pendiente de hoy', 'Lo que falta de la cuota de hoy.', '$40.00'], ['Importes financieros', 'deuda_anterior', 'Deuda anterior', 'Deuda de días anteriores.', '$0.00'],
  ['Importes financieros', 'deuda_semanal', 'Deuda semanal', 'Deuda de la semana en curso.', '$40.00'], ['Importes financieros', 'saldo_total', 'Saldo total', 'Deuda exigible hoy.', '$40.00'], ['Importes financieros', 'credito', 'Crédito', 'Saldo a favor.', '$0.00'],
  ['Importes financieros', 'cuenta_semanal', 'Cuenta semanal', 'Cuenta de la semana.', '$240.00'], ['Importes financieros', 'pagos_semana', 'Pagos de la semana', 'Pagos recibidos en la semana.', '$0.00'],
  ['Textos inteligentes', 'detalle_deuda', 'Detalle de deuda', 'Frase completa según lo que debe.', 'Su cuota pendiente de hoy es de $40.00.'], ['Textos inteligentes', 'cuenta_semana', 'Cuenta de la semana (antigua)', 'Cuotas ya generadas de la semana.', '$40.00'],
].map(([group, code, label, description, example]) => ({ group, code, label, description, example }));
const templates = [{ id: 't1', name: 'Cobro estándar', body: 'Hola {{nombre}}, {{detalle_deuda}}. Saldo total: {{saldo_total}}.' }, { id: 't2', name: 'Último aviso del día', body: '{{nombre}}, unidad {{unidad}}: cuota de hoy {{cuota_hoy}} y deuda anterior {{deuda_anterior}} al {{fecha}}.' }];
const schedules = [
  { id: 's1', kind: 'debt_first', label: 'Primer recordatorio', local_time: '11:00:00', weekdays: [1, 2, 3, 4, 5, 6], template_id: 't1', scope: 'total', enabled: false },
  { id: 's2', kind: 'debt_update', label: 'Recordatorio actualizado', local_time: '17:00:00', weekdays: [1, 2, 3, 4, 5, 6], template_id: 't1', scope: 'today', enabled: false },
  { id: 's3', kind: 'debt_last', label: 'Último recordatorio', local_time: '21:00:00', weekdays: [1, 2, 3, 4, 5, 6], template_id: 't2', scope: 'overdue', enabled: false },
  { id: 's4', kind: 'weekly_summary', label: 'Resumen semanal', local_time: '09:00:00', weekdays: [7], template_id: null, scope: 'total', enabled: false },
];
const job = (id, status, o = {}) => ({ id, schedule_id: 's1', driver_id: 'd1', kind: 'debt_first', local_date: '2026-11-16', status, suggested_body: null, rendered_body: null, error: null, scheduled_for: '2026-11-16T16:00:00Z', sent_at: null, dry_run: null, ...o });
const jobs = [
  job('j2', 'sent', { dry_run: true }), job('j3', 'skipped_paused', { driver_id: 'd2' }), job('j4', 'skipped_paid', { driver_id: 'd3', scheduled_for: '2026-11-15T16:00:00Z' }),
  job('j5', 'skipped_no_consent', { driver_id: 'd4', schedule_id: 's2', scheduled_for: '2026-11-14T22:00:00Z' }), job('j6', 'failed', { error: 'WhatsApp no está conectado', schedule_id: 's3', driver_id: 'd5' }), job('j7', 'sent', { kind: 'payment_receipt', schedule_id: null, driver_id: 'd5', dry_run: true }),
];
const audit = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, actor: i % 3 ? 'a1b2c3d4-0000-0000-0000-000000000000' : null, action: ['update', 'insert', 'driver_consent.granted', 'set_app_user'][i % 4], entity: ['drivers', 'payments', 'driver', 'app_users'][i % 4], entity_id: null, detail: {}, at: `2026-11-16T${String(14 - (i % 6)).padStart(2, '0')}:${10 + i}:00Z` }));

// Cobranza: filas por semana (11-16 actual; otras semanas, otros importes)
const mk = (n, i, extra) => ({ assignment_id: `a${n}`, driver_id: `d${n}`, unit_id: `u${n}`, unit_code: `T-${n}`, operator_code: drivers[n - 1].operator_code, national_id: drivers[n - 1].national_id,
  full_name: `${drivers[n - 1].first_name} ${drivers[n - 1].last_name}`, driver_status: 'active', daily_rate_cents: 3600, week_charged_cents: 21600, day_net_cents: [0, 0, 0, 0, 0, 0, 0], gross_cents: 0, commission_cents: 0, net_cents: 0, week_diff_cents: 0, pending_cents: 0, credit_cents: 0, week_closed: false, planned_cents: 21600, missing_days: 0, ...extra });
const weeklyCur = () => [
  mk(1, 0, { day_net_cents: [3600, 3600, 0, 0, 0, 0, 0], gross_cents: 7300, commission_cents: 100, net_cents: 7200, pending_cents: 26300, previous_pending_cents: 11900, opening_cents: 11900 }),
  S.paid ? mk(2, 0, { day_net_cents: [7200, 0, 0, 0, 0, 0, 0], gross_cents: 7200, net_cents: 7200, pending_cents: 0, credit_cents: 0 }) : mk(2, 0, { pending_cents: 7200, week_charged_cents: 7200 }),
  mk(3, 0, { day_net_cents: [0, 0, 3600, 3600, 3600, 3600, 0], gross_cents: 14500, commission_cents: 100, net_cents: 14400, missing_days: 2, pending_cents: 0 }),
  mk(4, 0, { day_net_cents: [7200, 7200, 7200, 3600, 0, 0, 0], gross_cents: 25200, net_cents: 25200, credit_cents: 3600 }),
  mk(5, 0, { unit_code: '4321', daily_rate_cents: 4000, week_charged_cents: 4000, planned_cents: 24000, day_net_cents: [0, 0, 0, 0, 0, 0, 0], pending_cents: 4000 }),
];
const weeklyPrev = () => [mk(1, 0, { day_net_cents: [3600, 3600, 3600, 3600, 3600, 3600, 0], gross_cents: 21600, net_cents: 21600, week_closed: true }), mk(2, 0, { day_net_cents: [3600, 3600, 0, 0, 0, 0, 0], net_cents: 7200, pending_cents: 14400, week_closed: true })];
const dayRow = (date, i, charge, paid) => ({ date, weekday: i + 1, planned_cents: charge === 0 ? 0 : charge, charge_generated: charge > 0, charge_cents: charge, net_paid_cents: paid, remaining_cents: Math.max(0, charge - paid), status: charge === 0 ? 'no_charge' : paid >= charge ? 'paid' : paid > 0 ? 'partial' : 'pending' });
const detailFor = (ws, row) => row.assignment_id === 'a5' && row.planned_cents === 24000 ? ({ assignment_id: 'a5', previous_pending_cents: 0, previous_credit_cents: 0,
  days: Array.from({ length: 7 }, (_, i) => i === 0 ? { ...dayRow(addDays(ws, 0), 0, 4000, 0) } : i === 6 ? { ...dayRow(addDays(ws, 6), 6, 0, 0), planned_cents: 0 } : { date: addDays(ws, i), weekday: i + 1, planned_cents: 4000, charge_generated: false, charge_cents: 0, net_paid_cents: 0, remaining_cents: 0, status: 'planned' }) })
  : row.assignment_id === 'a3' && row.missing_days === 2 ? ({ assignment_id: 'a3', previous_pending_cents: 0, previous_credit_cents: 0,
  days: Array.from({ length: 7 }, (_, i) => i < 2 ? { date: addDays(ws, i), weekday: i + 1, planned_cents: 3600, charge_generated: false, charge_cents: 0, net_paid_cents: 0, remaining_cents: 0, status: 'missing' } : { ...dayRow(addDays(ws, i), i, i === 6 ? 0 : 3600, row.day_net_cents[i]) }) })
  : ({ assignment_id: row.assignment_id, previous_pending_cents: row.assignment_id === 'a5' ? 3600 : 0, previous_credit_cents: row.assignment_id === 'a4' ? 1000 : 0,
  days: Array.from({ length: 7 }, (_, i) => dayRow(addDays(ws, i), i, i === 6 ? 0 : row.week_charged_cents === 7200 ? (i === 0 ? 3600 : i === 1 ? 3600 : 0) : 3600, row.day_net_cents[i])) });

const RATE_HISTORY = [
  { rate_id: 'r2', assignment_id: 'a1', unit_id: 'u1', unit_code: 'T-1', driver_id: 'd1', operator_code: '101', driver_name: 'Conductor Prueba A', previous_rate_id: 'r1', previous_daily_cents: 4000, new_daily_cents: 4500, valid_from: '2026-11-19', previous_valid_to: '2026-11-18', valid_to: null, changed_by: 'u9', changed_by_name: 'Admin Prueba', changed_at: '2026-11-16T20:05:00Z', reason: 'Acuerdo nuevo con el conductor', is_current: true },
  { rate_id: 'r1', assignment_id: 'a1', unit_id: 'u1', unit_code: 'T-1', driver_id: 'd1', operator_code: '101', driver_name: 'Conductor Prueba A', previous_rate_id: null, previous_daily_cents: null, new_daily_cents: 4000, valid_from: '2026-11-02', previous_valid_to: null, valid_to: '2026-11-18', changed_by: null, changed_by_name: null, changed_at: '2026-11-02T14:00:00Z', reason: null, is_current: false },
];
const jwt = () => `${Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: 'user-1', aud: 'authenticated', role: 'authenticated', exp: 4102444800 })).toString('base64url')}.firma`;
const user = { id: 'user-1', aud: 'authenticated', role: 'authenticated', email: 'admin@example.test', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' };
const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*', 'content-range': '0-0/*' }, body: JSON.stringify(body) });
const SESSION = () => ({ id: 'w1', label: 'Principal', status: 'connected', desired_state: 'connected', phone_number: '+50761112222', last_error: null, worker_heartbeat_at: new Date().toISOString(), status_changed_at: new Date(Date.now() - 3600e3).toISOString(),
  updated_at: new Date().toISOString(), checked_at: new Date().toISOString(), worker_online: true, sending_mode: 'test', real_test_enabled: false, qr_data: null, qr_expires_at: null, ...S.wa });
const DIR_SUMMARY = { kind: 'directory', rows: 4, drivers: { new: 1, existing: 3, toUpdate: 1, unchanged: 2 }, units: { new: 1, existing: 3 }, warningsByType: { 'consent_ignored:missing_origin': 1, consent_withdrawal: 1, 'consent_ignored:missing_phone': 1 },
  consents: { toGrant: 2, toWithdraw: 1, unchanged: 3, ignored: { total: 2, missingOrigin: 1, missingPhone: 1, invalidValue: 0, noDriver: 0 } }, matchCounts: { matched: 3, unmatched: 1 } };
const DIR_ROWS = [
  { id: 'r1', source_row: 2, unit_code: 'T-1', operator_code: '101', national_id: '8-100-1001', full_name: 'Conductor Prueba A', daily_rate_cents: 3600, warnings: [], match_status: 'matched', review_status: 'pending', changes: { driver: { action: 'unchanged' }, consent: { action: 'grant', origin: 'signed_form' } }, consent_request: 'grant', consent_origin: 'signed_form' },
  { id: 'r2', source_row: 3, unit_code: 'T-2', operator_code: '202', national_id: '8-200-2002', full_name: 'Conductora María Fernanda de los Ángeles Prueba B', daily_rate_cents: 3600, warnings: ['consent_withdrawal'], match_status: 'matched', review_status: 'pending', changes: { consent: { action: 'withdraw' } }, consent_request: 'withdraw', consent_origin: null },
  { id: 'r3', source_row: 4, unit_code: 'T-3', operator_code: '303', national_id: '8-300-3003', full_name: 'Luis Gómez', daily_rate_cents: 3600, warnings: ['consent_ignored:missing_origin'], match_status: 'matched', review_status: 'pending', changes: { consent: { action: 'ignored', reason: 'missing_origin' } }, consent_request: null, consent_origin: null },
  { id: 'r4', source_row: 5, unit_code: 'T-9', operator_code: '909', national_id: '8-900-9009', full_name: 'Rosa Nueva', daily_rate_cents: 3000, warnings: ['consent_ignored:missing_phone'], match_status: 'unmatched', review_status: 'pending', changes: { driver: { action: 'create' }, consent: { action: 'ignored', reason: 'missing_phone' } }, consent_request: null, consent_origin: null },
].map((r) => ({ block_index: null, first_name: null, last_name: null, phone_e164: null, row_status: null, raw_agreement: null, raw_saldo: null, day_amounts_cents: [], applied_action: null, applied_note: null, ...r }));
const tm = (id, status, mode, i, o = {}) => ({ id, kind: 'test', recipient_phone: '+50760009999', body: 'Mensaje de prueba de VIP', requested_mode: mode, status, sender_phone: '+50761112222', provider_message_id: status === 'sent' || status === 'delivered' ? 'prov-' + id : null, error: null, recipient_authorization: mode === 'real' ? 'Ana, dueña del número' : null,
  authorized_by: 'user-1', created_at: new Date(Date.now() - i * 900e3).toISOString(), claimed_at: new Date(Date.now() - i * 900e3 + 5e3).toISOString(), processed_at: null, delivered_at: null, error_detail: null, resolved_by: null, resolved_at: null, resolution_note: null, ...o });
const TESTS = [tm('t1', 'unconfirmed', 'real', 0, { error: 'timeout al enviar', error_detail: 'Error: ETIMEDOUT en sendText\n  at OpenWA.send (worker.js:112)' }), tm('t2', 'sent', 'real', 1), tm('t3', 'delivered', 'real', 2, { delivered_at: new Date().toISOString() }), tm('t4', 'failed', 'real', 3, { error: 'sin conexión', error_detail: 'Error: socket closed' }),
  tm('t5', 'simulated', 'simulated', 4), tm('t6', 'simulated', 'simulated', 5), tm('t7', 'prepared', 'simulated', 6)];
const dm = (id, status, i, o = {}) => ({ id, driver_id: 'd1', recipient_phone: '+50760000001', body: 'Hola, recuerda tu cuota de hoy.', status, sender_phone: '+50761112222', provider_message_id: status === 'sent' ? 'prov-' + id : null, error: null, error_detail: null, authorized_by: 'user-1',
  created_at: new Date(Date.now() - i * 900e3).toISOString(), claimed_at: null, processed_at: null, delivered_at: null, resolved_by: null, resolved_at: null, resolution_note: null, first_name: 'Conductor', last_name: 'Prueba A', operator_code: '101', ...o });
const DMSGS = [dm('x1', 'unconfirmed', 1, { error: 'timeout', error_detail: 'Error: ETIMEDOUT en sendText' }), dm('x2', 'sent', 2), dm('x3', 'simulated', 3), dm('x4', 'failed', 4, { error: 'sin conexión' })];
const COB_SUMMARY = { kind: 'cobranza', rows: 5, blocks: 2, warningsByType: { 'amount_over_rate:monday': 3, 'amount_over_rate:wednesday': 1, 'amount_over_rate:friday': 2, 'amount_over_rate:saturday': 1, sunday_amount: 2, zero_rate: 1, unit_without_driver: 1, placeholder_operator: 1, totals_row: 1, invalid_phone: 1, phone_added_507: 2 }, matchCounts: { matched: 4, unmatched: 1 },
  phones: { withValue: 4, valid: 3, invalid: 1, added507: 2, empty: 1, sharedByDrivers: 0 }, saldo: { empty: 1, zero: 1, amount: 3, text: 1, totalAmountCents: 15800 } };
const cr = (id, bid, bi, u, o = {}) => ({ id, block_id: bid, block_index: bi, source_row: 2, unit_code: u, operator_code: u.slice(1), national_id: null, full_name: 'Conductor ' + u, daily_rate_cents: 3900, warnings: [], match_status: 'matched', review_status: 'pending', day_amounts_cents: [], ...o });
const COB_ROWS = [cr('c1', 'blk1', 0, 'P280', { raw_phone: '60001111', phone_e164: '+50760001111', day_amounts_cents: [4500, 3900, 5000, 3900, 6000, 4000, 2000], warnings: ['phone_added_507', 'amount_over_rate:monday', 'amount_over_rate:wednesday', 'amount_over_rate:friday', 'amount_over_rate:saturday', 'sunday_amount'] }), cr('c4', 'blk2', 1, 'P283', { warnings: ['zero_rate', 'placeholder_operator'] }), cr('c5', 'blk2', 1, 'P284', { warnings: ['totals_row'], match_status: 'duplicate' }), cr('c2', 'blk2', 1, 'P281', { raw_phone: '123', warnings: ['invalid_phone'] }), cr('c3', 'blk2', 1, 'P282')];
const orow = (id, u, action, saldo, o = {}) => ({ assignment_id: 'a' + id, import_row_id: id, source_row: 2, unit_code: u, operator_code: u.slice(1), raw_saldo: saldo === null ? null : String(saldo / 100), saldo_excel_cents: saldo, saldo_state: saldo === null ? 'empty' : saldo === 0 ? 'zero' : 'amount',
  pending_before_cents: 0, credit_before_cents: 0, existing_opening_cents: null, existing_opening_week_start: null, prior_records: false, week_activity_cents: 0, action, note: null, ...o });
const OPENING = { import_id: 'i3', block_id: 'blk2', week_start: '2026-11-16', summary: { rows: 6, create: 3, unchanged: 0, conflict: 1, skip_empty: 1, skip_zero: 0, skip_text: 1, no_assignment: 1, ambiguous: 0, create_cents: 15800 },
  rows: [orow('o1', 'P280', 'create', 11900, { prior_records: true }), orow('o2', 'P281', 'create', 3900, { week_activity_cents: 3900 }), orow('o3', 'P282', 'skip_empty', null),
    orow('o4', 'P283', 'conflict', 5000, { existing_opening_cents: 8000, existing_opening_week_start: '2026-11-16' }), orow('o5', 'P284', 'skip_text', null, { raw_saldo: 'ver nota', saldo_state: 'text' }), orow('o6', 'P285', 'no_assignment', 2000, { assignment_id: null })] };
const external = [];

async function wire(ctx) {
  await ctx.route('**/*', async (route) => {
    const url = new URL(route.request().url()); const method = route.request().method();
    if (S.delay && (url.hostname === 'localhost' ? url.pathname.startsWith('/api/v1/') : url.pathname.startsWith('/rest/v1/') && !url.pathname.includes('/rpc/'))) await new Promise((r) => setTimeout(r, S.delay));
    if (url.hostname === 'localhost') {
      if (!url.pathname.startsWith('/api/v1/')) return route.continue();
      const p = url.pathname.replace('/api/v1', ''); S.calls.push(`${method} ${p}${url.search}`);
      if (p === '/whatsapp/session/connect') { S.wa = { ...S.wa, desired_state: 'connected' }; return json(route, { requested: true, ...SESSION() }); }
      if (p === '/whatsapp/session/disconnect') { S.wa = { ...S.wa, desired_state: 'disconnected' }; return json(route, { requested: true, ...SESSION() }); }
      if (p.startsWith('/exports/') && S.slowExport) { await new Promise((r) => setTimeout(r, S.slowExport)); return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="vip-prueba.xlsx"' }, body: 'x' }); }
      if (p === '/whatsapp/session') return json(route, SESSION());
      if (/^\/schedules\/[^/]+\/activation-preview$/.test(p)) return json(route, { schedule: { id: 's1', kind: 'debt_first', label: 'Primer recordatorio', local_time: '11:00:00', weekdays: [1, 2, 3, 4, 5, 6], scope: 'total', enabled: false, timezone: 'America/Panama', next_occurrence: '2026-11-17T16:00:00Z' }, template: { id: 't1', name: 'Cobro estándar', body: 'Hola {{nombre_completo}}, {{detalle_deuda}}' }, text_example: 'Hola Vanessa Ejemplo, Su cuota pendiente de hoy es de $40.00.', uses_variables: ['nombre_completo', 'detalle_deuda'], unknown_variables: [], eligible_drivers: null, eligible_reason: 'el servidor no lo calculó', can_activate: true, blockers: [] });
      if (p === '/schedules/default-templates') return json(route, [{ kind: 'debt_first', suggested_name: 'Primer recordatorio (base)', body: 'Buenos días, {{nombre_completo}}.\n\nUnidad: {{unidad}}\nFecha: {{fecha}}\n\n{{detalle_deuda}}\n\nGracias por su atención.' }, { kind: 'debt_update', suggested_name: 'Recordatorio actualizado (base)', body: 'Buenas tardes, {{nombre_completo}}.\n\n{{detalle_deuda}}' }, { kind: 'debt_last', suggested_name: 'Último recordatorio (base)', body: 'Buenas noches, {{nombre_completo}}.\n\n{{detalle_deuda}}' }, { kind: 'weekly_summary', suggested_name: 'Resumen semanal (base)', body: 'Buenos días, {{nombre_completo}}.\n\nResumen de la semana:\nCuenta semanal: {{cuenta_semanal}}\nPagos recibidos: {{pagos_semana}}' }]);
      if (/^\/templates\/[^/]+\/usage$/.test(p)) return json(route, []);
      if (p === '/templates/variables') return json(route, CATALOG);
      if (p === '/templates/preview' && method === 'POST') return json(route, { text: 'Hola Conductor Prueba A,\nSu cuota pendiente de hoy es de $36.00.', unresolved: (JSON.parse(route.request().postData() || '{}').body || '').includes('{{xyz}}') ? ['xyz'] : [] });
      if (p === '/charges/gaps') return json(route, S.gaps ?? []);
      if (p === '/charges/ensure' && method === 'POST') return json(route, { created: 2, from: '2026-11-03', to: '2026-11-16', days_checked: 14, skipped: null, gaps: [], gaps_total: 0, recovery_days: 14 });
      if (p === '/rate-history' || /^\/assignments\/[^/]+\/rate-history$/.test(p)) return json(route, RATE_HISTORY);
      if (p === '/weekly-collection') { const ws = url.searchParams.get('weekStart'); return json(route, ws === weeklyWs() ? weeklyCur() : weeklyPrev()); }
      if (p === '/weekly-collection/detail') { const ws = url.searchParams.get('weekStart'); return json(route, (ws === weeklyWs() ? weeklyCur() : weeklyPrev()).map((r) => detailFor(ws, r))); }
      if (p === '/payments/preview') return json(route, { grossCents: 7200, commissionCents: 0, netCents: 7200, companyReceivesCents: 7200, balanceBeforeCents: 7200, balanceAfterCents: 0, pendingAfterCents: 0, creditAfterCents: 0, creditGeneratedCents: 0 });
      if (p === '/payments' && method === 'POST') { S.paid = true; return json(route, { payment_id: 'p1', duplicate: false, gross_cents: 7200, commission_cents: 0, net_cents: 7200, applied_cents: 7200, credit_generated_cents: 0, pending_cents: 0, credit_cents: 0, balance_cents: 0, credit_notice_job_id: null, receipt_job_id: null }); }
      if (/^\/drivers\/[^/]+\/consents$/.test(p)) return json(route, [
        { id: 3, purpose: 'promotional', granted: true, source: 'signed_form', evidence: 'Formulario 14', recorded_by: 'user-1', recorded_at: '2026-11-02T15:00:00Z' },
        { id: 2, purpose: 'collection', granted: true, source: 'verbal_admin', evidence: 'Llamada del 10/11', recorded_by: 'user-1', recorded_at: '2026-11-10T15:00:00Z' },
        { id: 1, purpose: 'collection', granted: true, source: 'legacy_unverified', evidence: 'marcado antes del registro de consentimientos; sin constancia verificada', recorded_by: null, recorded_at: '2026-11-01T15:00:00Z' }]);
      if (/^\/drivers\/[^/]+\/consent$/.test(p)) return json(route, { driver_id: 'd1', purpose: 'collection', granted: false, cancelled_jobs: 3 });
      if (p === '/imports/excel') { if ((route.request().postData() ?? '').includes('cobranza')) return json(route, { created: true, importId: 'i3', status: 'previewed', kind: 'cobranza', summary: COB_SUMMARY }); return json(route, { created: true, importId: 'i2', status: 'previewed', kind: 'directory', summary: DIR_SUMMARY }); }
      if (p === '/imports/i3/rows') return json(route, COB_ROWS);
      if (p === '/imports/i3/confirm') return json(route, {});
      if (p === '/imports/i3/opening-balances' && method === 'GET') return json(route, OPENING);
      if (p === '/imports/i3/opening-balances/apply') return json(route, { created: 3, created_cents: 15800, unchanged: 0, conflicts: 1, skipped_empty: 1, skipped_zero: 0, skipped_text: 1, no_assignment: 1, ambiguous: 0 });
      if (p === '/imports' && method === 'GET') return json(route, []);
      if (/^\/imports\/i2\/rows$/.test(p)) return json(route, DIR_ROWS);
      if (p === '/reports/period') return json(route, { from: '2026-11-16', to: '2026-11-22', charges_generated_cents: 13200, adjustments_charged_cents: 0, expected_cents: 13200, payments_count: 2, gross_cents: 10100, commission_cents: 100, net_cents: 10000, applied_cents: 9600, applied_to_period_cents: 9600, prior_debt_recovered_cents: 0, credits_generated_cents: 400, pending_end_cents: 3600, credits_end_cents: 400, drivers_with_debt_end: 1, difference_cents: -3200, recovery_pct: 75.7 });
      if (p === '/reports/period/detail') return json(route, [{ occurred_on: '2026-11-16', kind: 'payment', unit_code: 'T-1', operator_code: '101', full_name: 'Conductor Prueba A', amount_cents: 3700, detail: 'Yappy' }, { occurred_on: '2026-11-17', kind: 'payment', unit_code: 'T-3', operator_code: '303', full_name: 'Luis Gómez', amount_cents: 3600, detail: 'Efectivo' }]);
      if (p === '/reports/series') return json(route, []);
      if (p === '/messages/driver' && method === 'GET') return json(route, DMSGS);
      if (p === '/messages/driver' && method === 'POST') { const b = JSON.parse(route.request().postData()); const m = dm('new1', 'prepared', 0, { body: b.body }); DMSGS.unshift(m); return json(route, m, 201); }
      if (p === '/users/invites') return json(route, [{ email: 'nueva@example.test', role: 'admin', created_at: '2026-11-16T14:00:00Z', expires_at: '2026-11-17T02:00:00Z', consumed_at: null }]);
      if (p === '/users/create') return json(route, { error: 'service_role_not_configured' }, 501);
      if (p === '/whatsapp/test-messages' && method === 'GET') return json(route, TESTS);
      if (p === '/whatsapp/test-messages/preview') return json(route, { recipient: '+50760009999', invalid_phone: false, recipient_is_a_driver: false, body: 'Hola', chars: 4, sender: '+50761112222', session_status: 'connected', sending_mode: 'real', real_test_enabled: true });
      if (p === '/users') return json(route, [{ user_id: 'user-1', email: 'admin@example.test', full_name: 'Administrador de prueba', role: 'super_admin', created_at: '2026-01-01T00:00:00Z', suspended_at: null }, { user_id: 'u2', email: 'ana@example.test', full_name: 'Ana', role: 'admin', created_at: '2026-02-01T00:00:00Z', suspended_at: null }, { user_id: 'u3', email: 'vieja@example.test', full_name: 'Heredada', role: 'supervisor', created_at: '2026-02-01T00:00:00Z', suspended_at: null }, { user_id: 'u4', email: 'pausa@example.test', full_name: 'Suspendida', role: 'admin', created_at: '2026-03-01T00:00:00Z', suspended_at: '2026-11-01T00:00:00Z' }]);
      return json(route, {});
    }
    if (url.hostname.endsWith('supabase.co')) {
      const path = url.pathname;
      if (path === '/auth/v1/token') return json(route, { access_token: jwt(), token_type: 'bearer', expires_in: 3600, expires_at: 4102444800, refresh_token: 'r', user });
      if (path === '/auth/v1/user') return json(route, user);
      if (path === '/rest/v1/rpc/current_app_role') return json(route, S.role);
      if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
      if (path === '/rest/v1/rpc/assignment_dues') return json(route, [{ today_cents: 0, overdue_cents: S.paid ? 0 : 14400, future_cents: 0, total_pending_cents: S.paid ? 0 : 14400, credit_cents: 0 }]);
      const T = { drivers, units, assignments, rates, message_templates: templates, notification_schedules: schedules, notification_jobs: jobs, audit_logs: audit,
        payment_methods: [{ id: 'm1', code: 'cash', label: 'Efectivo', commission_cents: 0, active: true }, { id: 'm2', code: 'yappy', label: 'Yappy', commission_cents: 100, active: true }],
        app_settings: [{ id: true, timezone: 'America/Panama', max_per_driver_per_day: 3, min_minutes_between: 60, grace_minutes: 180 }], v_movements: MOVS, weekly_closures: [{ assignment_id: 'a1', week_start: '2026-11-09', charged_cents: 21600, gross_cents: 21700, commission_cents: 100, net_cents: 21600, pending_cents: 0, credit_cents: 0, closed_at: '2026-11-16T15:00:00Z' }, { assignment_id: 'a2', week_start: '2026-11-09', charged_cents: 21600, gross_cents: 7300, commission_cents: 100, net_cents: 7200, pending_cents: 14400, credit_cents: 0, closed_at: '2026-11-16T15:00:00Z' }] };
      const m = /^\/rest\/v1\/([a-z_]+)$/.exec(path);
      if (m && method === 'GET') return json(route, T[m[1]] ?? []);
      if (m && method === 'POST' && m[1] === 'drivers') return json(route, { id: 'd9' });
      if (m) return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } });
      return json(route, []);
    }
    external.push(url.href); return route.abort();
  });
}
const monday = (d) => { const x = new Date(`${d}T00:00:00Z`); const w = (x.getUTCDay() + 6) % 7; return addDays(d, -w); };
function weeklyWs() { return monday(new Date().toLocaleDateString('en-CA', { timeZone: 'America/Panama' })); }

const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' });
const results = [];
const check = (n, ok, x = '') => { results.push(ok); console.log(`${ok ? 'OK   ' : 'FALLA'} ${n} ${x}`); };
async function open(w, h, path, { collapsed = false, role = 'super_admin' } = {}) {
  S.role = role;
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, serviceWorkers: 'block', locale: 'es-PA', timezoneId: 'America/Panama' });
  await wire(ctx);
  const page = await ctx.newPage();
  await page.addInitScript((c) => { try { localStorage.setItem('vip.sidebar.collapsed', c ? '1' : '0'); } catch {} }, collapsed);
  await page.goto(`${base}/login`); await page.fill('#email', 'admin@example.test'); await page.fill('#password', 'x'); await page.click('button[type=submit]');
  await page.waitForURL('**/dashboard');
  await page.goto(`${base}${path}`); await page.waitForTimeout(900);
  return { ctx, page };
}
const shot = (page, n) => page.screenshot({ path: join(out, `ux-${n}.png`) });
/** Sin desbordamiento horizontal de la página ni de ningún elemento dentro de <main> (salvo contenedores con scroll propio). */
const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1 && Array.from(document.querySelectorAll('main *')).every((e) => { const r = e.getBoundingClientRect(); return r.width === 0 || r.right <= window.innerWidth + 1; }));
const D = { w: 1440, h: 900 };

/** Distancia mínima (px) entre cada botón de una barra de acciones y el borde de su tarjeta/panel/modal contenedor. */
const actionGaps = (page) => page.evaluate(() => {
  const vis = (e) => { const r = e.getBoundingClientRect(); const st = getComputedStyle(e); return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none'; };
  const out = [];
  for (const b of document.querySelectorAll('.form-actions .btn, .actions .btn, .action-bar .btn, .wk-quick .btn, .wa-actions .btn')) {
    if (!vis(b)) continue;
    b.scrollIntoView({ block: 'center' });
    const r = b.getBoundingClientRect();
    for (let a = b.parentElement; a && a !== document.body; a = a.parentElement) {
      if (!a.matches('.card, .panel, .sheet, .wk-detail-row > td, .alert, .wa-steps-card, dialog')) continue;
      if (a.matches('.panel') && a.closest('.modal-body')) continue;   // dentro de un modal el panel no tiene caja propia: manda el modal
      const c = a.getBoundingClientRect();
      const d = Math.min(r.left - c.left, c.right - r.right, c.bottom - r.bottom);
      out.push({ text: (b.textContent || '').trim().slice(0, 28), box: a.className.toString().slice(0, 30), min: Math.round(d) });
    }
  }
  return out.filter((x) => x.min < 12);
});
async function gapCheck(page, name) {
  const bad = await actionGaps(page);
  check(`botones separados del borde (>=12 px): ${name}`, bad.length === 0, bad.length ? JSON.stringify(bad.slice(0, 4)) : '');
}
async function ronda11() {
  for (const [w, h, dev] of [[D.w, D.h, 'escritorio'], [390, 844, 'movil']]) {
    const m = dev === 'movil';
    const scenes = [
      ['plantillas', '/messages/templates', async (p) => { await p.click('button:has-text("Nueva plantilla")'); await p.waitForTimeout(400); }],
      ['horarios', '/messages/schedules', null], ['limites', '/messages/schedules', async (p) => { await p.locator('app-message-limits').scrollIntoViewIfNeeded().catch(() => {}); }],
      ['conductor-nuevo', '/drivers/new', null], ['conductor-ficha', '/drivers/d1', null],
      ['unidad', '/vehicles/u1', null], ['metodos-pago', '/settings/payment-methods', null],
      ['usuarios', '/settings/users', async (p) => { await p.click('button:has-text("Nueva cuenta")'); await p.waitForTimeout(400); }],
      ['importar', '/settings/data', null], ['whatsapp', '/messages/whatsapp', null], ['nuevo-mensaje', '/messages/send', null],
    ];
    for (const [n, path, pre] of scenes) {
      const { ctx, page } = await open(w, h, path); await page.waitForTimeout(500);
      if (pre) await pre(page);
      await gapCheck(page, `${n} ${dev}`);
      if (['plantillas', 'usuarios', 'metodos-pago'].includes(n)) await shot(page, `acciones-${n}-${dev}`);
      await ctx.close();
    }
    // Modal «Historial de movimientos» en sus tres pestañas
    const { ctx, page } = await open(w, h, '/collections'); await page.waitForTimeout(500);
    if (m) { await page.click('button.wk-toggle >> nth=0'); await page.waitForTimeout(300); await page.click('.wk-quick button[aria-label="Más acciones"], .wk-quick app-action-menu button'); await page.click('text=Ver historial'); }
    else { await page.click('button.wk-toggle >> nth=0'); await page.waitForTimeout(400); await page.click('.wk-quick [aria-label="Ver historial"]'); }
    await page.waitForTimeout(700);
    check(`modal financiero ${dev}: 3 pestañas`, (await page.$$('[role=tab]')).length === 3);
    check(`modal financiero ${dev}: sin scroll horizontal`, await page.evaluate(() => { const s = document.querySelector('.fin-modal'); return s.scrollWidth <= s.clientWidth + 1; }));
    await shot(page, `modal-movimientos-${dev}`);
    await page.click('#fin-tab-pago'); await page.waitForTimeout(400); await page.fill('#pay-amount', '72'); await page.waitForTimeout(900); await shot(page, `modal-registrar-pago-${dev}`); await page.evaluate(() => { const b = document.querySelector('.fin-body'); b.scrollTop = b.scrollHeight; }); await page.waitForTimeout(250); await shot(page, `modal-registrar-pago-vista-previa-${dev}`); await gapCheck(page, `modal pago ${dev}`);
    await page.click('#fin-tab-ajustes'); await page.waitForTimeout(400); await page.fill('#adj-amt', '10'); await page.fill('#adj-reason', 'Daño en la llanta'); await page.waitForTimeout(300); await shot(page, `modal-ajustes-${dev}`); await gapCheck(page, `modal ajustes ${dev}`);
    await page.click('#fin-tab-movimientos'); await page.waitForTimeout(300); await gapCheck(page, `modal movimientos ${dev}`);
    await ctx.close();
  }
}

async function ronda12() {
  S.gaps = [
    { assignment_id: 'a5', unit_code: '4321', operator_code: '505', driver_name: 'Mario Soto', gap_date: '2026-11-02', planned_cents: 4000, reason: 'outside_window' },
    { assignment_id: 'a3', unit_code: 'T-3', operator_code: '303', driver_name: 'Eva Ruiz', gap_date: '2026-10-27', planned_cents: 3600, reason: 'closed_week' },
    { assignment_id: 'a3', unit_code: 'T-3', operator_code: '303', driver_name: 'Eva Ruiz', gap_date: '2026-11-16', planned_cents: 3600, reason: 'not_generated' }];
  for (const [w, h, dev] of [[D.w, D.h, 'escritorio'], [390, 844, 'movil']]) {
    const { ctx, page } = await open(w, h, '/collections'); await page.waitForTimeout(600);
    check(`gaps ${dev}: aviso visible`, (await page.textContent('.gap-notice')).includes('Hay 1 cuota sin generar fuera de la ventana de recuperación'));
    await page.click('.gap-notice button:has-text("Ver detalle")'); await page.waitForTimeout(200);
    await shot(page, `cobranza-aviso-huecos-${dev}`);
    const row = page.locator(dev === 'movil' ? 'li.wk-card' : 'tr.wk-row', { hasText: '4321' });
    await row.locator('button.wk-toggle').click(); await page.waitForTimeout(500);
    const chips = await page.$$eval('.wk-day .chip-s', (c) => c.map((x) => x.textContent.trim()));
    check(`caso 4321 ${dev}: Pendiente, 5 × Prevista $40.00, Sin cuota`, JSON.stringify(chips) === JSON.stringify(['Pendiente', 'Prevista $40.00', 'Prevista $40.00', 'Prevista $40.00', 'Prevista $40.00', 'Prevista $40.00', 'Sin cuota']), JSON.stringify(chips));
    check(`caso 4321 ${dev}: sin scroll horizontal`, await noHScroll(page));
    await page.locator('.wk-days').first().scrollIntoViewIfNeeded(); await page.evaluate(() => window.scrollBy(0, 0)); await shot(page, `cobranza-4321-${dev}`);
    await row.locator('button.wk-toggle').click(); await page.waitForTimeout(200);
    const r3 = page.locator(dev === 'movil' ? 'li.wk-card' : 'tr.wk-row', { hasText: 'T-3' });
    await r3.locator('button.wk-toggle').click(); await page.waitForTimeout(500);
    check(`sin generar ${dev}: chip ámbar y ayuda`, (await page.textContent('.wk-detail')).includes('Sin generar $36.00') && (await page.textContent('.wk-detail')).includes('el sistema la generará automáticamente'));
    await page.locator('.wk-days').first().scrollIntoViewIfNeeded(); await shot(page, `cobranza-sin-generar-${dev}`);
    await gapCheck(page, `cobranza r12 ${dev}`);
    await ctx.close();
  }
  { const { ctx, page } = await open(D.w, D.h, '/collections'); await page.waitForTimeout(500);
    await page.click('.gap-notice button:has-text("Recuperar cuotas")'); await page.waitForTimeout(300); await shot(page, 'cobranza-recuperar-cuotas-escritorio'); await gapCheck(page, 'recuperar cuotas'); await ctx.close(); }
  S.gaps = [];
  for (const [w, h, dev] of [[D.w, D.h, 'escritorio'], [390, 844, 'movil']]) {
    let c = await open(w, h, '/vehicles/u1'); await c.page.waitForTimeout(700);
    check(`historial de tarifas unidad ${dev}`, (await c.page.textContent('.rate-history')).includes('$40.00 → $45.00'));
    await c.page.locator('.rate-history').scrollIntoViewIfNeeded(); await shot(c.page, `historial-tarifas-unidad-${dev}`); await c.ctx.close();
    c = await open(w, h, '/messages/schedules'); await c.page.waitForTimeout(700); await c.page.locator('#limites').scrollIntoViewIfNeeded(); await shot(c.page, `limites-recuperacion-${dev}`);
    check(`limites ${dev}: campo de recuperación`, (await c.page.$('#lm-recovery')) !== null); await gapCheck(c.page, `limites r12 ${dev}`); await c.ctx.close();
  }
  { const { ctx, page } = await open(D.w, D.h, '/vehicles/u1'); await page.waitForTimeout(600);
    await page.click('[aria-label="Cambiar tarifa"]'); await page.waitForTimeout(300); await page.fill('#rc-amount', '45'); await page.click('app-rate-change button[type=submit]'); await page.waitForTimeout(300);
    await shot(page, 'cambio-tarifa-confirmacion-escritorio'); await gapCheck(page, 'cambio de tarifa'); await ctx.close(); }
}

/** Campo de contraseña con icono de ojo: tamaño, posición dentro del campo, centrado, sin solape con el texto y reapertura oculta. */
async function pwCheck(page, sel, name) {
  const g = await page.evaluate((s) => {
    const i = document.querySelector(s); const b = i.parentElement.querySelector('.pw-toggle'); const ri = i.getBoundingClientRect(), rb = b.getBoundingClientRect();
    return { w: rb.width, h: rb.height, inside: rb.left >= ri.left && rb.right <= ri.right && rb.top >= ri.top && rb.bottom <= ri.bottom, dy: Math.abs((rb.top + rb.height / 2) - (ri.top + ri.height / 2)),
      pad: parseFloat(getComputedStyle(i).paddingRight), gap: ri.right - rb.left, txt: b.textContent.trim(), type: i.type, btnType: b.type, label: b.getAttribute('aria-label') };
  }, sel);
  check(`contraseña ${name}: icono 36x36 dentro del campo, centrado y sin texto`, g.w >= 36 && g.h >= 36 && g.inside && g.dy <= 1 && g.txt === '' && g.btnType === 'button', JSON.stringify(g));
  check(`contraseña ${name}: el texto no se solapa con el icono (padding derecho >= ancho del icono)`, g.pad >= g.gap, JSON.stringify(g));
  return g;
}
async function ronda13() {
  for (const [w, h, dev] of [[D.w, D.h, 'escritorio'], [390, 844, 'movil']]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, serviceWorkers: 'block', locale: 'es-PA' }); await wire(ctx);
    const page = await ctx.newPage(); await page.goto(`${base}/login`); await page.waitForTimeout(700);
    await page.fill('#password', 'contraseña-de-prueba');
    let g = await pwCheck(page, '#password', `login ${dev} oculta`); check(`login ${dev}: inicia oculta con aria-label «Mostrar contraseña»`, g.type === 'password' && g.label === 'Mostrar contraseña');
    await shot(page, `contrasena-login-oculta-${dev}`);
    await page.click('.pw-toggle'); await page.waitForTimeout(200);
    g = await pwCheck(page, '#password', `login ${dev} visible`); check(`login ${dev}: visible con aria-label «Ocultar contraseña»`, g.type === 'text' && g.label === 'Ocultar contraseña');
    await shot(page, `contrasena-login-visible-${dev}`);
    await ctx.close();
    const { ctx: c2, page: p2 } = await open(w, h, '/settings/users'); await p2.waitForTimeout(500);
    await p2.click('button:has-text("Nueva cuenta")'); await p2.waitForTimeout(300); await p2.fill('#nu-pw', 'abcdefghij');
    await pwCheck(p2, '#nu-pw', `nueva cuenta ${dev}`); await shot(p2, `contrasena-nueva-cuenta-oculta-${dev}`);
    await p2.click('#nu-pw ~ .pw-toggle'); await p2.waitForTimeout(200); await shot(p2, `contrasena-nueva-cuenta-visible-${dev}`);
    check(`nueva cuenta ${dev}: contador n/12 intacto`, (await p2.textContent('#nu-len')).includes('10 / 12'));
    await p2.click('[role=dialog] button:has-text("Cancelar")'); await p2.waitForTimeout(200); await p2.click('.modal-discard .btn.danger'); await p2.waitForTimeout(200); await p2.click('button:has-text("Nueva cuenta")'); await p2.waitForTimeout(300);
    check(`nueva cuenta ${dev}: reabrir deja la contraseña oculta y vacía`, await p2.$eval('#nu-pw', (i) => i.type === 'password' && i.value === ''));
    await gapCheck(p2, `nueva cuenta r13 ${dev}`);
    await c2.close();
  }
}

async function ronda14() {
  for (const [w, h, dev] of [[D.w, D.h, 'escritorio'], [390, 844, 'movil']]) {
    const { ctx, page } = await open(w, h, '/messages/templates'); await page.waitForTimeout(700);
    await page.click('button:has-text("Nueva plantilla")'); await page.waitForTimeout(500);
    await page.fill('#tf-name', 'Recordatorio nuevo');
    await page.fill('#tf-body', 'Hola {{nombre_completo}}\nUnidad {{unidad}}: {{detalle_deuda}}. {{xyz}}');
    await page.waitForTimeout(300);
    check(`plantillas ${dev}: catálogo y avisos`, (await page.$$('.var-item')).length === 16 && (await page.textContent('#tf-warn')).includes('No existe: {{xyz}}'));
    if (dev === 'movil') { await page.click('.var-group >> nth=0 >> summary'); await page.waitForTimeout(150); }
    await shot(page, `plantillas-editor-${dev}`);
    await page.locator('.wa-bubble').first().scrollIntoViewIfNeeded(); await shot(page, `plantillas-vista-ejemplo-${dev}`);
    await page.click('.chips button:has-text("Con un conductor real")'); await page.selectOption('#pv-driver', { index: 1 }); await page.click('button:has-text("Ver vista previa")'); await page.waitForTimeout(500);
    await page.locator('.wa-bubble').first().scrollIntoViewIfNeeded(); await shot(page, `plantillas-vista-real-${dev}`);
    check(`plantillas ${dev}: sin scroll horizontal`, await noHScroll(page)); await gapCheck(page, `plantillas r14 ${dev}`);
    await ctx.close();
  }
}

/** Iconos de acción: ≥36 px (≥44 en móvil), sin solaparse, con nombre accesible. */
async function iconCheck(page, name, mobile) {
  const r = await page.evaluate((min) => {
    const bs = Array.from(document.querySelectorAll('.ibtn')).filter((b) => { const q = b.getBoundingClientRect(); return q.width > 0 && q.height > 0; });
    const rects = bs.map((b) => b.getBoundingClientRect());
    const small = bs.filter((b, i) => rects[i].width < min - 0.5 || rects[i].height < min - 0.5).length;
    let overlap = 0;
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) { const a = rects[i], c = rects[j]; if (a.left < c.right - 1 && c.left < a.right - 1 && a.top < c.bottom - 1 && c.top < a.bottom - 1) overlap++; }
    const unnamed = bs.filter((b) => !b.getAttribute('aria-label')).length;
    return { n: bs.length, small, overlap, unnamed };
  }, mobile ? 44 : 36);
  check(`iconos ${name}: ${r.n} visibles, todos >= ${mobile ? 44 : 36} px, sin solaparse y con aria-label`, r.n > 0 && r.small === 0 && r.overlap === 0 && r.unnamed === 0, JSON.stringify(r));
}
async function ronda15() {
  for (const [w, h, dev] of [[D.w, D.h, 'escritorio'], [390, 844, 'movil']]) {
    const mobile = dev === 'movil';
    let c = await open(w, h, '/settings/users'); await c.page.waitForTimeout(600);
    await iconCheck(c.page, `usuarios ${dev}`, mobile);
    check(`usuarios ${dev}: sin botones de texto «Suspender»/«Eliminar»`, !(await c.page.$$eval('button:not(.ibtn)', (bs) => bs.some((b) => /^(Suspender|Eliminar|Reactivar|Editar)$/.test(b.textContent.trim())))));
    check(`usuarios ${dev}: sin scroll horizontal`, await noHScroll(c.page));
    if (!mobile) { await c.page.locator('tbody tr:nth-child(2) [aria-label="Eliminar cuenta"]').hover(); await c.page.waitForTimeout(600); }
    await shot(c.page, `iconos-usuarios-${dev}`); await c.ctx.close();
    c = await open(w, h, '/drivers/d1'); await c.page.waitForTimeout(700); await iconCheck(c.page, `conductor ${dev}`, mobile); await shot(c.page, `iconos-conductor-${dev}`); await c.ctx.close();
    c = await open(w, h, '/vehicles/u1'); await c.page.waitForTimeout(700); await iconCheck(c.page, `unidad ${dev}`, mobile);
    if (!mobile) { await c.page.locator('[aria-label^="Desactivar unidad"]').hover(); await c.page.waitForTimeout(600); }
    await shot(c.page, `iconos-unidad-${dev}`); await c.ctx.close();
    c = await open(w, h, '/collections'); await c.page.waitForTimeout(600);
    await c.page.locator(mobile ? 'li.wk-card button.wk-toggle' : 'tr.wk-row button.wk-toggle').first().click(); await c.page.waitForTimeout(500);
    if (!mobile) await iconCheck(c.page, `cobranza detalle ${dev}`, mobile);   // en móvil las acciones van en el menú de tres puntos
    if (!mobile) { await c.page.locator('.wk-quick [aria-label="Ver historial"]').hover(); await c.page.waitForTimeout(600); }
    await shot(c.page, `iconos-cobranza-detalle-${dev}`);
    if (!mobile) { await c.page.locator('.wk-quick [aria-label="Ver historial"]').click(); } else { await c.page.locator('.wk-panel app-action-menu button').first().click(); await c.page.click('text=Ver historial'); }
    await c.page.waitForTimeout(600); await iconCheck(c.page, `modal movimientos ${dev}`, mobile); await shot(c.page, `iconos-cobranza-modal-${dev}`); await c.ctx.close();
    c = await open(w, h, '/messages/templates'); await c.page.waitForTimeout(600); await iconCheck(c.page, `plantillas ${dev}`, mobile);
    if (!mobile) { await c.page.locator('[aria-label="Eliminar plantilla"]').first().hover(); await c.page.waitForTimeout(600); }
    await shot(c.page, `iconos-plantillas-${dev}`); await c.ctx.close();
    c = await open(w, h, '/messages/schedules'); await c.page.waitForTimeout(600); await iconCheck(c.page, `horarios ${dev}`, mobile); await shot(c.page, `iconos-horarios-${dev}`); await c.ctx.close();
    c = await open(w, h, '/drivers/assignments'); await c.page.waitForTimeout(600); await iconCheck(c.page, `asignaciones ${dev}`, mobile); await shot(c.page, `iconos-asignaciones-${dev}`); await c.ctx.close();
    c = await open(w, h, '/settings/data'); await c.page.waitForTimeout(600); await shot(c.page, `iconos-importacion-${dev}`); await c.ctx.close();
  }
}

/** El modal cabe en la pantalla (≤ 90 dvh en escritorio, pantalla completa en móvil), centrado, y el fondo no se desplaza. */
async function modalCheck(page, name, mobile) {
  const g = await page.evaluate(() => { const d = document.querySelector('[role=dialog], [role=alertdialog]'); const r = d.getBoundingClientRect(); const b = d.querySelector('.modal-body'); return { h: r.height, vh: window.innerHeight, left: r.left, right: window.innerWidth - r.right, top: r.top, w: r.width, vw: window.innerWidth, locked: document.documentElement.classList.contains('modal-open'), scrolls: b ? b.scrollHeight >= b.clientHeight : false }; });
  check(`modal ${name}: dentro de la pantalla y fondo bloqueado`, g.locked && g.h <= g.vh + 1 && g.top >= -1 && (mobile ? g.w >= g.vw - 1 && g.h >= g.vh - 1 : Math.abs(g.left - g.right) <= 2 && g.h <= g.vh * 0.9 + 1), JSON.stringify(g));
}
async function ronda18() {
  for (const [w, h, dev] of [[D.w, D.h, 'escritorio'], [390, 844, 'movil']]) {
    const mobile = dev === 'movil';
    // plantilla: editor + vista previa; luego error DENTRO del modal y aviso de cambios sin guardar
    let c = await open(w, h, '/messages/templates'); await c.page.waitForTimeout(600);
    await c.page.route('**/rest/v1/message_templates*', (r) => r.request().method() === 'GET' ? r.fallback() : r.fulfill({ status: 409, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify({ code: '23505', message: 'duplicate key value violates unique constraint "message_templates_name_key"' }) }));
    await c.page.locator('[aria-label^="Editar plantilla"]').first().click(); await c.page.waitForTimeout(500);
    await modalCheck(c.page, `plantilla ${dev}`, mobile);
    check(`plantilla ${dev}: sin formulario fuera del modal`, await c.page.evaluate(() => Array.from(document.querySelectorAll('input[name], textarea[name], select[name]')).every((i) => i.closest('[role=dialog]') || i.type === 'search')));
    await shot(c.page, `modal-plantilla-${dev}`);
    await c.page.fill('#tf-body', 'Hola {{nombre_completo}}, {{detalle_deuda}}'); await c.page.waitForTimeout(200);
    await c.page.click('[role=dialog] button:has-text("Guardar plantilla")'); await c.page.waitForTimeout(700);
    check(`plantilla ${dev}: el error queda DENTRO del modal con lo escrito`, (await c.page.$('[role=dialog] .modal-error')) !== null && (await c.page.inputValue('#tf-body')).includes('nombre_completo'));
    await shot(c.page, `modal-error-dentro-${dev}`);
    await c.page.click('[role=dialog] button:has-text("Cancelar")'); await c.page.waitForTimeout(300);
    check(`plantilla ${dev}: cambios sin guardar piden confirmación`, (await c.page.textContent('[role=alertdialog]')).includes('¿Descartar los cambios?'));
    await shot(c.page, `modal-cambios-sin-guardar-${dev}`);
    await c.ctx.close();
    // horario
    c = await open(w, h, '/messages/schedules'); await c.page.waitForTimeout(600);
    await c.page.locator('[aria-label^="Editar horario"]').first().click(); await c.page.waitForTimeout(400);
    await modalCheck(c.page, `horario ${dev}`, mobile); await shot(c.page, `modal-horario-${dev}`); await c.ctx.close();
    // nueva cuenta + confirmación de eliminar
    c = await open(w, h, '/settings/users'); await c.page.waitForTimeout(600);
    await c.page.click('button:has-text("Nueva cuenta")'); await c.page.waitForTimeout(400); await modalCheck(c.page, `nueva cuenta ${dev}`, mobile); await shot(c.page, `modal-nueva-cuenta-${dev}`);
    await c.page.click('[aria-label="Cerrar"]'); await c.page.waitForTimeout(300);
    await c.page.locator('[aria-label="Eliminar cuenta"]:not([aria-disabled=true])').first().click(); await c.page.waitForTimeout(400);
    await modalCheck(c.page, `confirmar eliminar ${dev}`, mobile); await shot(c.page, `modal-confirmar-eliminar-${dev}`);
    check(`confirmar eliminar ${dev}: botón rojo con texto «Eliminar cuenta»`, await c.page.$eval('[role=alertdialog] .btn.danger', (b) => b.textContent.trim() === 'Eliminar cuenta'));
    await c.ctx.close();
  }
}

async function ronda17() {
  for (const [w, h, dev] of [[D.w, D.h, 'escritorio'], [390, 844, 'movil']]) {
    const mobile = dev === 'movil';
    const c = await open(w, h, '/messages/schedules'); await c.page.waitForTimeout(800);
    check(`horarios ${dev}: tarjetas con resumen y vista previa`, (await c.page.$$('li.sched-card')).length >= 3 && (await c.page.$$('li.sched-card .wa-bubble')).length >= 1);
    check(`horarios ${dev}: resumen «A las … · … · Plantilla … · Activo/Desactivado»`, /A las \d{1,2}:\d{2} (a\. m\.|p\. m\.) · .+ · Plantilla .+ · (Activo|Desactivado)/.test(await c.page.textContent('.sched-summary')));
    check(`horarios ${dev}: sin scroll horizontal`, await noHScroll(c.page));
    await c.page.locator('li.sched-card').first().scrollIntoViewIfNeeded(); await shot(c.page, `horarios-tarjetas-${dev}`);
    await c.page.locator('li.sched-card .action-bar button:has-text("Activar horario")').first().click(); await c.page.waitForTimeout(500);
    check(`activación ${dev}: modal con datos y advertencia de mensajes REALES`, (await c.page.textContent('[role=alertdialog]')).includes('Esto enviará mensajes REALES') && (await c.page.textContent('[role=alertdialog]')).includes('No se pudo calcular'));
    await shot(c.page, `horario-activacion-confirmacion-${dev}`);
    await c.page.click('[role=alertdialog] button:has-text("Cancelar")'); await c.page.waitForTimeout(300);
    await c.page.route('**/schedules/*/activation-preview', (r) => r.fulfill({ status: 503, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify({ error: 'schema_outdated' }) }));
    await c.page.locator('li.sched-card .action-bar button:has-text("Activar horario")').first().click(); await c.page.waitForTimeout(500);
    const dl = await c.page.textContent('[role=alertdialog]');
    check(`activación ${dev}: schema_outdated = UN mensaje, sin «Cargando…», sin advertencia REAL, botón deshabilitado`, (await c.page.$$('[role=alertdialog] .modal-error')).length === 1 && !dl.includes('Cargando') && !dl.includes('Esto enviará') && dl.includes('La base de datos necesita una actualización') && await c.page.$eval('[role=alertdialog] .btn.primary', (b) => b.disabled));
    await shot(c.page, `horario-activacion-no-disponible-${dev}`);
    await gapCheck(c.page, `horarios r17 ${dev}`);
    await c.ctx.close();
  }
}
if (process.env.ONLY === 'r17') {
  await ronda17();
  await browser.close(); server.close();
  console.log(`${results.filter(Boolean).length}/${results.length} comprobaciones OK`);
  process.exit(results.every(Boolean) ? 0 : 1);
}
if (process.env.ONLY === 'r18') {
  await ronda18();
  await browser.close(); server.close();
  console.log(`${results.filter(Boolean).length}/${results.length} comprobaciones OK`);
  process.exit(results.every(Boolean) ? 0 : 1);
}
if (process.env.ONLY === 'r15') {
  await ronda15();
  await browser.close(); server.close();
  console.log(`${results.filter(Boolean).length}/${results.length} comprobaciones OK`);
  process.exit(results.every(Boolean) ? 0 : 1);
}
if (process.env.ONLY === 'r14') {
  await ronda14();
  await browser.close(); server.close();
  console.log(`${results.filter(Boolean).length}/${results.length} comprobaciones OK`);
  process.exit(results.every(Boolean) ? 0 : 1);
}
if (process.env.ONLY === 'r13') {
  await ronda13();
  await browser.close(); server.close();
  console.log(`${results.filter(Boolean).length}/${results.length} comprobaciones OK`);
  process.exit(results.every(Boolean) ? 0 : 1);
}
if (process.env.ONLY === 'r12') {
  await ronda12();
  await browser.close(); server.close();
  console.log(`${results.filter(Boolean).length}/${results.length} comprobaciones OK`);
  process.exit(results.every(Boolean) ? 0 : 1);
}
if (process.env.ONLY === 'r11') {
  await ronda11();
  await browser.close(); server.close();
  console.log(`${results.filter(Boolean).length}/${results.length} comprobaciones OK`);
  process.exit(results.every(Boolean) ? 0 : 1);
}

// ===== Sidebar por rol =====
for (const role of ['admin', 'super_admin']) {
  const { ctx, page } = await open(D.w, 700, '/settings', { role });
  const labels = await page.$$eval('nav[aria-label=Principal] a', (a) => a.map((x) => x.textContent.trim()));
  const seven = 'Inicio|Conductores|Unidades|Cobranza|Mensajería|Campañas|Configuración';
  check(`sidebar ${role}`, labels.join('|') === (role === 'admin' ? seven : `${seven}|Importar / Exportar|Reportes|Usuarios y permisos|Auditoría`), labels.join(','));
  await shot(page, `sidebar-${role}-configuracion`);
  await ctx.close();
}
// ===== Configuración ADMIN vs SUPER_ADMIN y guards por URL =====
{
  const { ctx, page } = await open(D.w, D.h, '/settings/audit', { role: 'admin' });
  check('ADMIN por URL a /settings/audit vuelve a /dashboard', page.url().endsWith('/dashboard'), page.url());
  await page.goto(`${base}/settings/users`); await page.waitForTimeout(500); check('ADMIN por URL a /settings/users', page.url().endsWith('/dashboard'), page.url());
  await page.goto(`${base}/settings/technical`); await page.waitForTimeout(500); check('ADMIN por URL a /settings/technical', page.url().endsWith('/dashboard'), page.url());
  await page.goto(`${base}/payments`); await page.waitForTimeout(500); check('/payments redirige a /collections/payments', page.url().endsWith('/collections/payments'), page.url());
  await page.goto(`${base}/settings`); await page.waitForTimeout(600); await shot(page, 'configuracion-admin');
  await ctx.close();
}
{
  const { ctx, page } = await open(D.w, D.h, '/settings', { role: 'super_admin' }); await shot(page, 'configuracion-super');
  for (const [u, n] of [['/settings/users', 'usuarios'], ['/settings/technical', 'tecnica'], ['/settings/audit', 'auditoria'], ['/settings/payment-methods', 'metodos']]) { await page.goto(`${base}${u}`); await page.waitForTimeout(700); await shot(page, `configuracion-${n}`); }
  await ctx.close();
}
// ===== Cobranza =====
{
  const { ctx, page } = await open(D.w, D.h, '/collections');
  await shot(page, 'cobranza-colapsada');
  check('cobranza: sin scroll horizontal', await noHScroll(page));
  const wid = await page.evaluate(() => { const t = document.querySelector('.wk-table').getBoundingClientRect(), m = document.querySelector('main').getBoundingClientRect(); return { t: t.width, m: m.width }; });
  check('cobranza: la tabla ocupa todo el ancho de main', wid.t >= wid.m - 80, JSON.stringify(wid));
  await page.click('button.wk-toggle >> nth=0'); await page.click('button.wk-toggle >> nth=1'); await page.waitForTimeout(400);
  check('cobranza: aria-expanded true', (await page.getAttribute('button.wk-toggle >> nth=0', 'aria-expanded')) === 'true');
  await shot(page, 'cobranza-expandida');
  await page.click('tr.wk-row >> nth=1 >> .amenu button'); await page.waitForTimeout(250); await shot(page, 'cobranza-menu-acciones');
  await page.keyboard.press('Escape');
  await page.click('button:has-text("Cerrar semana")'); await page.waitForTimeout(250); await shot(page, 'cobranza-cierre-confirmacion'); await page.click('button:has-text("Cancelar")');
  await page.click('button[aria-label="Semana anterior"]'); await page.waitForTimeout(700);
  await page.click('button.wk-toggle >> nth=0'); await page.waitForTimeout(400);
  const rng = await page.textContent('.wk-range'); const cur = weeklyWs();
  check('cobranza: semana anterior muestra fechas de la semana anterior', rng.includes(String(new Date(`${addDays(cur, -7)}T00:00:00Z`).getUTCDate())), rng);
  check('cobranza: semana cerrada deshabilita el cierre con motivo', (await page.isDisabled('button:has-text("Cerrar semana")')) && (await page.textContent('#wk-close-why')).includes('ya está cerrada'));
  await shot(page, 'cobranza-semana-anterior');
  await page.click('button:has-text("Hoy")'); await page.waitForTimeout(600);
  // registrar pago → refetch
  await page.click('tr.wk-row >> nth=1 >> .amenu button'); await page.click('[role=menuitem]:has-text("Registrar pago")'); await page.waitForSelector('#pay-amount');
  await page.fill('#pay-amount', '72'); await page.waitForTimeout(700);
  await shot(page, 'cobranza-registrar-pago');
  const before = await page.$eval('tr.wk-row >> nth=1', (r) => r.querySelector('.chip-s').textContent.trim());
  await page.click('button:has-text("Confirmar pago")'); await page.waitForTimeout(900); await page.click('app-payment-sheet button:has-text("Cerrar")'); await page.waitForTimeout(400);
  const after = await page.$eval('tr.wk-row >> nth=1', (r) => r.querySelector('.chip-s').textContent.trim());
  check('cobranza: tras el pago la fila se actualiza (refetch)', before === 'Pendiente' && after === 'Al día', `${before} → ${after}`);
  await shot(page, 'cobranza-tras-pago');
  await ctx.close();
}
{ // sidebar contraído
  const { ctx, page } = await open(D.w, D.h, '/collections', { collapsed: true });
  await page.click('button.wk-toggle >> nth=0'); await page.waitForTimeout(400); await shot(page, 'cobranza-sidebar-contraido-expandida');
  const wid = await page.evaluate(() => ({ t: document.querySelector('.wk-table').getBoundingClientRect().width, m: document.querySelector('main').getBoundingClientRect().width }));
  check('cobranza sidebar contraído: ancho total', wid.t >= wid.m - 80, JSON.stringify(wid)); await ctx.close();
}
for (const [w, h, n] of [[820, 1100, 'tablet'], [1100, 800, 'laptop']]) {
  const { ctx, page } = await open(w, h, '/collections'); await page.click('button.wk-toggle >> nth=0'); await page.waitForTimeout(400);
  check(`cobranza ${n}: sin scroll horizontal`, await noHScroll(page)); await shot(page, `cobranza-${n}-expandida`); await ctx.close();
}
{
  const { ctx, page } = await open(390, 844, '/collections');
  check('cobranza móvil: sin scroll horizontal', await noHScroll(page)); await shot(page, 'cobranza-movil');
  await page.click('button.wk-toggle >> nth=1'); await page.waitForTimeout(400); check('cobranza móvil expandida: sin scroll horizontal', await noHScroll(page));
  await shot(page, 'cobranza-movil-expandida');
  await page.evaluate(() => document.querySelector('.wk-panel').scrollIntoView()); await page.waitForTimeout(200); await shot(page, 'cobranza-movil-detalle'); await ctx.close();
}
// ===== Conductores =====
{
  const { ctx, page } = await open(D.w, D.h, '/drivers'); await shot(page, 'conductores-lista');
  await page.goto(`${base}/drivers/new`); await page.waitForTimeout(700); await shot(page, 'conductor-nuevo-consentimiento');
  await page.click('#df-s-collection').catch(() => {}); await page.click('button:has-text("Guardar")'); await page.waitForTimeout(400); await shot(page, 'conductor-nuevo-error-origen');
  await page.goto(`${base}/drivers/d1`); await page.waitForTimeout(900); await shot(page, 'conductor-ficha-consentimiento');
  await page.click('[aria-label^="Retirar autorización"] >> nth=0'); await page.waitForTimeout(250); await shot(page, 'conductor-retirar-confirmacion');
  await page.click('button:has-text("Sí, retirar")'); await page.waitForTimeout(700); await shot(page, 'conductor-retiro-resultado');
  await page.goto(`${base}/drivers/d2`); await page.waitForTimeout(700); await page.click('[aria-label="Editar conductor"]'); await page.waitForTimeout(500); await shot(page, 'conductor-editar-consentimiento');
  await ctx.close();
}
{ const { ctx, page } = await open(390, 844, '/drivers/new'); check('conductor nuevo móvil: sin scroll horizontal', await noHScroll(page)); await shot(page, 'conductor-nuevo-movil'); await ctx.close(); }
// ===== Mensajería =====
{
  const { ctx, page } = await open(D.w, D.h, '/messages');
  check('mensajería: / redirige a Conexión', page.url().endsWith('/messages/whatsapp'), page.url());
  await shot(page, 'mensajeria-conexion');
  for (const [u, n] of [['/messages/schedules', 'horarios'], ['/messages/templates', 'plantillas'], ['/messages/history', 'historial']]) { await page.goto(`${base}${u}`); await page.waitForTimeout(900); await shot(page, `mensajeria-${n}`); }
  await page.selectOption('#h-st', 'skipped'); await page.waitForTimeout(300); await shot(page, 'mensajeria-historial-filtrado');
  await ctx.close();
}
{ const { ctx, page } = await open(390, 844, '/messages/schedules'); check('mensajería móvil horarios: sin scroll horizontal', await noHScroll(page)); await shot(page, 'mensajeria-horarios-movil');
  await page.goto(`${base}/messages/history`); await page.waitForTimeout(700); check('mensajería móvil historial: sin scroll horizontal', await noHScroll(page)); await shot(page, 'mensajeria-historial-movil'); await ctx.close(); }
// ===== Datos (importar) y campañas =====
{
  const { ctx, page } = await open(D.w, D.h, '/settings/data');
  await page.setInputFiles('#xlsx', { name: 'plantilla.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from('x') }); await page.waitForTimeout(1200);
  await shot(page, 'datos-importar-consentimientos');
  await page.goto(`${base}/campaigns`); await page.waitForTimeout(500); await shot(page, 'campanas');
  await ctx.close();
}
// ===== Usuarios y mensajes de prueba =====
{
  const { ctx, page } = await open(D.w, D.h, '/settings/users'); await page.waitForTimeout(500); await shot(page, 'usuarios-lista');
  await page.click('button:has-text("Nueva cuenta")'); await page.fill('#nu-email', 'nueva@example.test'); await page.fill('#nu-pw', 'clave-larga-de-prueba'); await page.waitForTimeout(250); await shot(page, 'usuarios-nueva-cuenta');
  await page.click('button:has-text("Crear cuenta")'); await page.waitForTimeout(600); await shot(page, 'usuarios-sin-service-role');
  check('usuarios: aviso compacto 501', (await page.textContent('[role=dialog] .modal-error')).includes('solo puede invitar'));
  await ctx.close();
}
{ const { ctx, page } = await open(390, 844, '/settings/users'); check('usuarios móvil: sin scroll horizontal', await noHScroll(page)); await shot(page, 'usuarios-movil'); await ctx.close(); }
{
  const { ctx, page } = await open(D.w, 1100, '/messages/whatsapp/test'); await page.waitForTimeout(500); await shot(page, 'prueba-historial');
  await page.click('.wt-list li >> nth=0 >> [aria-label="Ver detalle del mensaje"]'); await page.waitForTimeout(300); await shot(page, 'prueba-detalle');
  await page.fill('#wt-phone', '+507 6000 9999'); await page.fill('#wt-body', 'Hola'); await page.click('button:has-text("Vista previa")'); await page.waitForTimeout(500);
  check('prueba: real bloqueado por unconfirmed', await page.isDisabled('input[value=real]'));
  await shot(page, 'prueba-real-bloqueado'); await ctx.close();
}
{ const { ctx, page } = await open(390, 844, '/messages/whatsapp/test'); check('prueba móvil: sin scroll horizontal', await noHScroll(page)); await shot(page, 'prueba-movil'); await ctx.close(); }
// ===== Nuevo mensaje a un conductor =====
for (const [w, h, dev] of [[D.w, 1000, 'escritorio'], [390, 844, 'movil']]) {
  S.wa = { sending_mode: 'test' };
  const { ctx, page } = await open(w, h, '/messages/send?driverId=d1'); await page.waitForTimeout(600);
  await page.fill('#sm-body', 'Hola, recuerda tu cuota de hoy.'); await page.waitForTimeout(200);
  check(`nuevo mensaje ${dev}: sin scroll horizontal`, await noHScroll(page)); await shot(page, `enviar-${dev}`);
  await page.click('button:has-text("Enviar mensaje")'); await page.waitForTimeout(300); await shot(page, `enviar-revision-${dev}`);
  await page.click('button:has-text("Confirmar y enviar")'); await page.waitForTimeout(700);
  check(`nuevo mensaje ${dev}: resultado visible`, (await page.textContent('#sm-res')).includes('Resultado')); await shot(page, `enviar-resultado-${dev}`);
  await page.selectOption('#sm-driver', 'd3'); await page.waitForTimeout(300);
  check(`nuevo mensaje ${dev}: sin autorización bloquea`, (await page.isDisabled('button:has-text("Enviar mensaje")')) && (await page.textContent('#sm-reason')).includes('no tiene autorización')); await shot(page, `enviar-sin-autorizacion-${dev}`);
  await ctx.close();
}
S.wa = {};
// ===== Alineación de «Enviar mensaje de prueba» (6 estados × escritorio y móvil) =====
const WA_CASES = [
  ['conectada-real', { sending_mode: 'real', real_test_enabled: true }, true, null],
  ['conectada-modo-pruebas', {}, true, 'Envío real desactivado: solo puedes enviar mensajes simulados'],
  ['desconectada', { status: 'disconnected', desired_state: 'disconnected', phone_number: null }, false, 'Conecta WhatsApp para habilitar el envío de mensajes'],
  ['worker-no-disponible', { worker_online: false }, false, 'El servicio de WhatsApp no está disponible'],
];
for (const [name, wa, enabled, hint] of WA_CASES) for (const [w, h, dev] of [[D.w, 800, 'escritorio'], [390, 844, 'movil']]) {
  S.wa = wa;
  const { ctx, page } = await open(w, h, '/messages/whatsapp'); await page.waitForTimeout(500);
  const info = await page.evaluate(() => { const r = document.querySelector('.wa-actions'); const bs = Array.from(r.querySelectorAll('.btn')).map((b) => b.getBoundingClientRect());
    const g = document.querySelector('.wa-gate'); const rr = r.getBoundingClientRect(); return { n: bs.length, tops: bs.map((b) => Math.round(b.top)), lefts: bs.map((b) => Math.round(b.left)), widths: bs.map((b) => Math.round(b.width)), rowLeft: Math.round(rr.left), gateTop: g ? Math.round(g.getBoundingClientRect().top) : null, gateLeft: g ? Math.round(g.getBoundingClientRect().left) : null, rowBottom: Math.round(rr.bottom) }; });
  const testBtn = await page.$('.wa-actions .btn:has-text("Enviar mensaje de prueba")');
  check(`prueba ${name} ${dev}: botón ${enabled ? 'habilitado' : 'deshabilitado'}`, (await testBtn.evaluate((b) => !b.disabled && b.tagName === 'A')) === enabled || (!enabled && await testBtn.evaluate((b) => b.disabled)));
  check(`prueba ${name} ${dev}: aviso ${hint ? 'debajo y alineado al inicio' : 'ausente'}`, hint ? info.gateTop >= info.rowBottom && Math.abs(info.gateLeft - info.rowLeft) <= 2 && (await page.textContent('.wa-gate')).trim() === hint : info.gateTop === null, JSON.stringify(info));
  check(`prueba ${name} ${dev}: botones ${dev === 'escritorio' ? 'en una fila' : 'apilados a ancho completo'}`, dev === 'escritorio' ? new Set(info.tops).size === 1 : new Set(info.widths).size === 1 && new Set(info.lefts).size === 1 && info.tops[1] > info.tops[0], JSON.stringify(info));
  check(`prueba ${name} ${dev}: sin scroll horizontal`, await noHScroll(page));
  await shot(page, `prueba-estado-${name}-${dev}`); await ctx.close();
}
S.wa = {};
// ===== Cobranza: deuda anterior + Datos: SALDO y teléfonos =====
{
  const { ctx, page } = await open(D.w, D.h, '/collections'); await page.waitForTimeout(500); await shot(page, 'cobranza-deuda-anterior-colapsada');
  await page.click('button.wk-toggle >> nth=0'); await page.waitForTimeout(400); await shot(page, 'cobranza-deuda-anterior-expandida');
  check('cobranza: deuda anterior resaltada', (await page.$$('td.prior')).length > 0);
  check('cobranza: sin scroll horizontal de la página', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)); await ctx.close();
}
{ const { ctx, page } = await open(390, 844, '/collections'); await page.click('button.wk-toggle >> nth=0'); await page.waitForTimeout(400); check('cobranza móvil (deuda anterior): sin scroll horizontal', await noHScroll(page)); await shot(page, 'cobranza-deuda-anterior-movil'); await ctx.close(); }
for (const [w, h, dev] of [[D.w, 1100, 'escritorio'], [390, 844, 'movil']]) {
  const { ctx, page } = await open(w, h, '/settings/data');
  await page.setInputFiles('#xlsx', { name: 'cobranza.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from('cobranza') }); await page.waitForTimeout(1000);
  await shot(page, `datos-cobranza-telefonos-saldo-${dev}`);
  await page.click('button:has-text("Aprobar todas")'); await page.waitForTimeout(700);
  await page.fill('#ob-week', '2026-11-16'); await page.click('button:has-text("Conciliar")'); await page.waitForTimeout(800);
  await page.evaluate(() => document.querySelector('.opening').scrollIntoView()); await page.waitForTimeout(200);
  check(`saldos ${dev}: sin scroll horizontal`, await noHScroll(page)); await shot(page, `datos-saldos-conciliacion-${dev}`);
  await page.click('button:has-text("Registrar deuda anterior")'); await page.waitForTimeout(300); await shot(page, `datos-saldos-confirmacion-${dev}`);
  await page.click('[role=alertdialog] button:has-text("Sí, registrar")'); await page.waitForTimeout(700);
  check(`saldos ${dev}: resultado idempotente`, (await page.textContent('.opening .alert.ok')).includes('idempotente')); await shot(page, `datos-saldos-resultado-${dev}`);
  await ctx.close();
}
// ===== Navegación de Cobranza: el sidebar resalta SOLO «Cobranza» en /collections/* =====
for (const role of ['admin', 'super_admin']) for (const path of ['/collections', '/collections/payments', '/collections/history', '/collections/reports']) {
  for (const [w, h, collapsed, dev] of [[D.w, 800, false, 'expandido'], [D.w, 800, true, 'contraido']]) {
    const { ctx, page } = await open(w, h, '/dashboard', { role, collapsed });
    await page.goto(`${base}${path}`); await page.waitForTimeout(700);      // URL directa
    const active = await page.$$eval('nav[aria-label=Principal] a.active', (a) => a.map((x) => x.getAttribute('aria-label') ?? x.textContent.trim()));
    const labels = await page.$$eval('nav[aria-label=Principal] a', (a) => a.map((x) => x.getAttribute('aria-label') ?? x.textContent.trim()));
    check(`nav ${role} ${path} (${dev}): solo Cobranza activa y sin «Pagos»`, active.length === 1 && active[0] === 'Cobranza' && !labels.includes('Pagos'), JSON.stringify(active));
    if (path === '/collections/payments' || (path === '/collections/history' && role === 'super_admin')) await shot(page, `nav-${role}-${path.split('/').pop()}-${dev}`);
    await ctx.close();
  }
}
{
  const { ctx, page } = await open(390, 844, '/dashboard', { role: 'super_admin' });
  await page.goto(`${base}/collections/payments`); await page.waitForTimeout(700);
  check('nav móvil /collections/payments: sin scroll horizontal', await noHScroll(page)); await shot(page, 'nav-pagos-movil');
  await page.click('button[aria-controls="menu-principal"]'); await page.waitForTimeout(400);
  const act = await page.$$eval('nav[aria-label=Principal] a.active', (a) => a.map((x) => x.textContent.trim()));
  check('nav móvil (drawer): solo Cobranza', act.length === 1 && act[0] === 'Cobranza', JSON.stringify(act)); await shot(page, 'nav-drawer-movil'); await ctx.close();
}
{
  const { ctx, page } = await open(D.w, D.h, '/dashboard');
  await page.goto(`${base}/payments`); await page.waitForTimeout(600); check('/payments redirige a /collections/payments', page.url().endsWith('/collections/payments'), page.url());
  await page.goto(`${base}/pagos`); await page.waitForTimeout(600); check('/pagos redirige a /collections/payments', page.url().endsWith('/collections/payments'), page.url());
  await page.goto(`${base}/cobranza/historial`); await page.waitForTimeout(600); check('/cobranza/historial redirige', page.url().endsWith('/collections/history'), page.url());
  await page.goto(`${base}/collections/payments`); await page.waitForTimeout(700); await shot(page, 'cobranza-pagos');
  await page.goto(`${base}/collections/history`); await page.waitForTimeout(700); await shot(page, 'cobranza-historial'); await ctx.close();
}
// ===== Importación: avisos agrupados por gravedad =====
for (const [w, h, dev] of [[D.w, 1200, 'escritorio'], [390, 844, 'movil']]) {
  const { ctx, page } = await open(w, h, '/settings/data');
  await page.setInputFiles('#xlsx', { name: 'cobranza.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from('cobranza') }); await page.waitForTimeout(1000);
  await page.evaluate(() => document.querySelector('.warn-sum').scrollIntoView()); await page.waitForTimeout(200);
  check(`avisos ${dev}: sin scroll horizontal`, await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)); await shot(page, `importar-avisos-${dev}`);
  await page.evaluate(() => { const d = document.querySelector('details.row-warns'); if (d) { d.open = true; d.scrollIntoView(); } }); await page.waitForTimeout(250);
  await shot(page, `importar-avisos-fila-${dev}`); await ctx.close();
}
// ===== Feedback inmediato: «Conectar WhatsApp» paso a paso, botón ocupado, aviso de demora y exportación en curso =====
for (const [w, h, dev] of [[D.w, D.h, 'escritorio'], [390, 844, 'movil']]) {
  S.wa = { status: 'disconnected', desired_state: 'disconnected', phone_number: null };
  const { ctx, page } = await open(w, h, '/messages/whatsapp'); await page.waitForTimeout(600);
  await page.click('button:has-text("Conectar WhatsApp")'); await page.waitForTimeout(150);
  const busy = await page.$$eval('button.is-busy', (bs) => bs.map((b) => ({ label: b.getAttribute('data-busy-label'), dis: b.disabled || b.getAttribute('aria-disabled') === 'true' })));
  check(`conectar ${dev}: respuesta inmediata (botón ocupado «Conectando…»)`, busy.length > 0 && busy[0].label === 'Conectando…' && busy[0].dis, JSON.stringify(busy));
  check(`conectar ${dev}: pasos visibles al instante`, (await page.$$('.wa-progress li')).length >= 4);
  await shot(page, `conectar-1-solicitud-${dev}`);
  S.wa = { ...S.wa, status: 'starting' }; await page.waitForTimeout(2600); await shot(page, `conectar-2-iniciando-${dev}`);
  S.wa = { ...S.wa, status: 'qr_pending' }; await page.waitForTimeout(2600); await shot(page, `conectar-3-generando-qr-${dev}`);
  S.wa = { ...S.wa, status: 'awaiting_scan', qr_data: 'https://example.invalid/vinculo-de-prueba', qr_expires_at: new Date(Date.now() + 60e3).toISOString() }; await page.waitForTimeout(2600); await shot(page, `conectar-4-esperando-escaneo-${dev}`);
  check(`conectar ${dev}: sin scroll horizontal`, await noHScroll(page));
  S.wa = { ...S.wa, status: 'connected', phone_number: '+50761112222', qr_data: null }; await page.waitForTimeout(2600); await shot(page, `conectar-5-conectado-${dev}`);
  await ctx.close();
}
{
  S.wa = { status: 'disconnected', desired_state: 'disconnected', phone_number: null };
  const { ctx, page } = await open(D.w, D.h, '/messages/whatsapp'); await page.waitForTimeout(600);
  await page.click('button:has-text("Conectar WhatsApp")'); await page.waitForTimeout(31500);
  check('conectar: aviso «Está tardando más de lo normal»', (await page.textContent('main')).includes('Está tardando más de lo normal')); await shot(page, 'conectar-tarda-mas-de-lo-normal-escritorio'); await ctx.close();
  S.wa = {};
}
{
  S.slowExport = 9500;
  const { ctx, page } = await open(D.w, D.h, '/settings/data'); await page.waitForTimeout(600);
  await page.locator('button:has-text("Descargar .xlsx")').first().click(); await page.waitForTimeout(300); await shot(page, 'exportacion-en-curso-escritorio');
  await page.waitForTimeout(8400); check('exportar: aviso de demora a los 8 s', (await page.textContent('main')).includes('tardando más de lo normal')); await shot(page, 'exportacion-tarda-escritorio'); await ctx.close();
  const m = await open(390, 844, '/settings/data'); await m.page.waitForTimeout(600);
  await m.page.locator('button:has-text("Descargar .xlsx")').first().click(); await m.page.waitForTimeout(300); await shot(m.page, 'exportacion-en-curso-movil'); await m.ctx.close();
  S.slowExport = 0;
}
// ===== Ningún input ni botón recorta su texto (placeholder, etiqueta del botón) en 390 px, tablet y escritorio =====
const clipped = (page) => page.evaluate(() => {
  const out = []; const c = document.createElement('canvas').getContext('2d');
  for (const el of document.querySelectorAll('main input:not([type=checkbox]):not([type=radio]):not([type=date]):not([type=file]), main textarea')) {
    const r = el.getBoundingClientRect(); if (!r.width || getComputedStyle(el).visibility === 'hidden') continue;
    const cs = getComputedStyle(el); c.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const text = el.value || el.placeholder || ''; const avail = r.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 4;
    if (!el.value && el.placeholder && c.measureText(text).width > avail) out.push(`placeholder «${text}»`);
  }
  for (const el of document.querySelectorAll('main button, main .btn, main .chip, main .chip-s')) {
    const r = el.getBoundingClientRect(); if (!r.width) continue;
    if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflow !== 'visible') out.push(`botón «${el.textContent.trim().slice(0, 30)}»`);
  }
  return out;
});
for (const [path, name] of [['/collections', 'cobranza'], ['/collections/payments', 'pagos'], ['/collections/history', 'historial'], ['/drivers', 'conductores'], ['/vehicles', 'unidades'], ['/messages/send', 'mensajeria-enviar'], ['/messages/history', 'mensajeria-historial'], ['/settings/audit', 'auditoria']]) {
  for (const [w, h, collapsed, dev] of [[390, 844, false, 'movil'], [820, 1000, false, 'tablet'], [1440, 800, false, 'escritorio-expandido'], [1440, 800, true, 'escritorio-contraido']]) {
    const { ctx, page } = await open(w, h, path, { collapsed }); await page.waitForTimeout(500);
    const bad = await clipped(page);
    check(`sin recortes ${name} (${dev})`, bad.length === 0, bad.join(' | '));
    await ctx.close();
  }
}
// ===== Ronda 11: botones separados del borde y modal financiero =====
await ronda11();
await ronda12();
await ronda13();
await ronda14();
await ronda15();
await ronda17();
await ronda18();
// ===== Skeletons de carga (respuestas retrasadas) =====
async function skeleton(w, h, path, name) {
  const { ctx, page } = await open(w, h, '/dashboard');
  S.delay = 4000; await page.goto(`${base}${path}`); await page.waitForTimeout(700);
  check(`skeleton ${name}`, (await page.$$('.skel-wrap[aria-busy=true], .wa-skel')).length > 0);
  await shot(page, `skeleton-${name}`); S.delay = 0; await ctx.close();
}
await skeleton(D.w, D.h, '/collections', 'cobranza-escritorio');
await skeleton(390, 844, '/collections', 'cobranza-movil');
await skeleton(D.w, D.h, '/drivers', 'conductores-escritorio');
await skeleton(390, 844, '/drivers', 'conductores-movil');
await skeleton(D.w, D.h, '/dashboard', 'inicio-escritorio');
await skeleton(D.w, D.h, '/messages/schedules', 'mensajeria-horarios');
{
  const { ctx, page } = await open(D.w, D.h, '/collections');
  S.delay = 4000; await page.click('button[aria-label="Semana siguiente"]'); await page.waitForTimeout(600); await shot(page, 'skeleton-cobranza-cambio-semana'); S.delay = 0; await ctx.close();
}
await browser.close(); server.close();
console.log(external.length ? `HOSTS EXTERNOS ABORTADOS: ${[...new Set(external)].join(', ')}` : 'Sin peticiones a hosts externos.');
console.log(`${results.filter(Boolean).length}/${results.length} comprobaciones OK`);
process.exit(results.every(Boolean) ? 0 : 1);

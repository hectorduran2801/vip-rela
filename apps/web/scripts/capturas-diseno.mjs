// Verificación en navegador SIN red real: sirve dist/web y simula Supabase y la API con page.route.
// Uso: PLAYWRIGHT_PATH=/ruta/a/node_modules/playwright node apps/web/scripts/capturas-diseno.mjs
// Todo host distinto de localhost se ABORTA (nunca se conecta a Supabase real). Los datos son de PRUEBA, solo para las capturas.
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

// ---------- Datos de PRUEBA (no reales) ----------
const MODE = { role: 'super_admin', htmlApi: false, agreementFails: false };
const drivers = [
  { id: 'd1', operator_code: '101', national_id: '8-100-1001', first_name: 'Conductor', last_name: 'Prueba A', phone: '6000-0001', phone_e164: '+50760000001', whatsapp_consent: true, reminders_paused: false, reminders_paused_reason: null, license_number: 'L-1', license_expires_on: '2027-03-01', status: 'active', notes: null },
  { id: 'd2', operator_code: '202', national_id: '8-200-2002', first_name: 'Conductora', last_name: 'Prueba B', phone: null, phone_e164: '+50760000002', whatsapp_consent: true, reminders_paused: true, reminders_paused_reason: 'Viaje fuera del país', license_number: null, license_expires_on: null, status: 'active', notes: null },
  { id: 'd3', operator_code: '303', national_id: '8-300-3003', first_name: 'Conductor', last_name: 'Prueba C', phone: null, phone_e164: null, whatsapp_consent: false, reminders_paused: false, reminders_paused_reason: null, license_number: null, license_expires_on: null, status: 'suspended', notes: null },
];
const units0 = [
  { id: 'u1', code: 'T-1', plate: 'AB-1234', make: 'Toyota', model: 'Corolla', year: 2020, vehicle_status: 'active', notes: null },
  { id: 'u2', code: 'T-2', plate: 'CD-5678', make: 'Hyundai', model: 'Accent', year: 2019, vehicle_status: 'maintenance', notes: null },
  { id: 'u3', code: 'T-3', plate: null, make: null, model: null, year: null, vehicle_status: 'active', notes: null },
];
const units = units0.map((u, i) => ({ ...u, agreement: i === 0 ? 'CUSTODIA' : i === 2 ? 'chapa y pintura' : null, agreement_note: i === 0 ? 'En el taller por reparación' : null }));

const agreementHistory = [{ id: 1, unit_id: 'u1', agreement: 'CUSTODIA', note: 'En el taller por reparación', previous_agreement: 'CHAPA', previous_note: null, source: 'manual', changed_by: 'user-1', changed_by_profile: { full_name: 'Administrador de prueba', email: 'admin@example.test' }, changed_at: '2026-11-02T15:30:00Z' }];
const assignments = [
  { id: 'a1', driver_id: 'd1', unit_id: 'u1', valid_from: '2026-01-05', valid_to: null, agreement_note: 'Acuerdo verbal: feriados a mitad de tarifa' },
  { id: 'a2', driver_id: 'd2', unit_id: 'u2', valid_from: '2026-02-01', valid_to: null, agreement_note: null },
  { id: 'a0', driver_id: 'd3', unit_id: 'u1', valid_from: '2025-01-01', valid_to: '2026-01-04', agreement_note: null },
];
const rates = [{ assignment_id: 'a1', daily_amount_cents: 3600, valid_from: '2026-01-05' }, { assignment_id: 'a2', daily_amount_cents: 3000, valid_from: '2026-02-01' }, { assignment_id: 'a0', daily_amount_cents: 3000, valid_from: '2025-01-01' }];
const templates = [
  { id: 't1', name: 'Cobro estándar', body: 'Hola {{nombre}}, {{detalle_deuda}}. Saldo total: {{saldo_total}}.' },
  { id: 't2', name: 'Último aviso del día', body: '{{nombre}}, unidad {{unidad}}: cuota de hoy {{cuota_hoy}} y deuda anterior {{deuda_anterior}} al {{fecha}}.' },
];
const schedules = [
  { id: 's1', kind: 'debt_first', label: 'Primer recordatorio', local_time: '11:00:00', weekdays: [1, 2, 3, 4, 5, 6], template_id: 't1', scope: 'total', enabled: false },
  { id: 's2', kind: 'debt_update', label: 'Recordatorio actualizado', local_time: '17:00:00', weekdays: [1, 2, 3, 4, 5, 6], template_id: 't1', scope: 'today', enabled: false },
  { id: 's3', kind: 'debt_last', label: 'Último recordatorio', local_time: '21:00:00', weekdays: [1, 2, 3, 4, 5, 6], template_id: 't2', scope: 'overdue', enabled: true },
  { id: 's4', kind: 'weekly_summary', label: 'Resumen semanal', local_time: '09:00:00', weekdays: [7], template_id: null, scope: 'total', enabled: false },
];
const job = (id, status, o = {}) => ({ id, schedule_id: 's1', driver_id: 'd1', kind: 'debt_first', local_date: '2026-11-16', status, suggested_body: null, rendered_body: null, error: null, scheduled_for: '2026-11-16T16:00:00Z', sent_at: null, dry_run: null, ...o });
const jobs = [
  job('j1', 'awaiting_approval', { kind: 'credit_notice', schedule_id: null, suggested_body: 'Hola, tienes $4.00 a favor en tu cuenta.' }),
  job('j2', 'sent', { dry_run: true }), job('j3', 'skipped_paused', { driver_id: 'd2' }), job('j4', 'skipped_paid'),
  job('j5', 'skipped_frequency', { schedule_id: 's2' }), job('j6', 'failed', { error: 'WhatsApp no está conectado', schedule_id: 's3' }), job('j7', 'pending', { schedule_id: 's3' }),
];
const weekly = [
  { assignment_id: 'a1', driver_id: 'd1', unit_id: 'u1', unit_code: 'T-1', operator_code: '101', national_id: '8-100-1001', full_name: 'Conductor Prueba A', driver_status: 'active', daily_rate_cents: 3600, week_charged_cents: 7200, day_net_cents: [3600, 0, 0, 0, 0, 0, 0], gross_cents: 3700, commission_cents: 100, net_cents: 3600, week_diff_cents: -3600, pending_cents: 3600, credit_cents: 0, week_closed: false },
  { assignment_id: 'a2', driver_id: 'd2', unit_id: 'u2', unit_code: 'T-2', operator_code: '202', national_id: '8-200-2002', full_name: 'Conductora Prueba B', driver_status: 'active', daily_rate_cents: 3000, week_charged_cents: 6000, day_net_cents: [6400, 0, 0, 0, 0, 0, 0], gross_cents: 6400, commission_cents: 0, net_cents: 6400, week_diff_cents: 400, pending_cents: 0, credit_cents: 400, week_closed: false },
];
const summary = { from: '2026-11-16', to: '2026-11-22', charges_generated_cents: 13200, adjustments_charged_cents: 0, expected_cents: 13200, payments_count: 2, gross_cents: 10100, commission_cents: 100, net_cents: 10000, applied_cents: 9600, applied_to_period_cents: 7600, prior_debt_recovered_cents: 2000, credits_generated_cents: 400, pending_end_cents: 3600, credits_end_cents: 400, drivers_with_debt_end: 1, difference_cents: -3200, recovery_pct: 75.8 };
const detailRows = [
  { occurred_on: '2026-11-16', kind: 'allocation', unit_code: 'T-1', operator_code: '101', full_name: 'Conductor Prueba A', amount_cents: 2000, detail: 'cuota del 2026-11-09' },
];
const series = [0, 1, 2, 3].map((i) => ({ week_start: `2026-10-${19 + i * 7 > 31 ? '' : 19 + i * 7}`.replace(/-$/, '') , expected_cents: 12000 + i * 400, gross_cents: 10000, commission_cents: 100, net_cents: 9900 + i * 100, pending_end_cents: 2000, credits_end_cents: 0, difference_cents: -2100 + i * 100, recovery_pct: 82.5 + i }));
series[0].week_start = '2026-10-19'; series[1].week_start = '2026-10-26'; series[2].week_start = '2026-11-02'; series[3].week_start = '2026-11-09';

const jwt = () => `${Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: 'user-1', aud: 'authenticated', role: 'authenticated', exp: 4102444800 })).toString('base64url')}.firma`;
const user = (email) => ({ id: 'user-1', aud: 'authenticated', role: 'authenticated', email, app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' });
const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*', 'content-range': '0-0/*' }, body: JSON.stringify(body) });

const TABLES = { unit_agreement_history: agreementHistory, drivers, units, assignments, rates, payment_methods: [{ id: 'm1', code: 'cash', label: 'Efectivo', commission_cents: 0, active: true }, { id: 'm2', code: 'yappy', label: 'Yappy', commission_cents: 100, active: true }],
  message_templates: templates, notification_schedules: schedules, notification_jobs: jobs, rate_exceptions: [{ id: 'x1', assignment_id: 'a1', on_date: '2026-11-25', amount_cents: 1800, reason: 'Feriado acordado' }],
  app_settings: [{ id: true, business_name: 'VIP', timezone: 'America/Panama', max_per_driver_per_day: 3, min_minutes_between: 60, grace_minutes: 180 }],
  v_assignment_position: [{ assignment_id: 'a1', charged_cents: 7200, gross_cents: 3700, commission_cents: 100, net_cents: 3600, pending_cents: 3600, credit_cents: 0, balance_cents: 3600 }],
  v_movements: [{ assignment_id: 'a1', occurred_at: '2026-11-16T14:00:00Z', kind: 'payment', ref_id: 'p1', amount_cents: 3600, commission_cents: 100, detail: 'vigente' }, { assignment_id: 'a1', occurred_at: '2026-11-16T05:00:00Z', kind: 'charge', ref_id: 'c1', amount_cents: 3600, commission_cents: null, detail: '2026-11-16' }] };

const WA = { status: 'disconnected', desired: 'disconnected', workerOff: false, step: 0, since: '2026-11-16T14:00:00Z', phone: null, error: null, expires: null };
const waState = (extra = {}) => ({ id: 'w1', label: 'Principal', status: WA.status, desired_state: WA.desired, phone_number: WA.phone, last_error: WA.error, worker_heartbeat_at: '2026-11-16T15:00:00Z', status_changed_at: WA.since, worker_online: !WA.workerOff, qr_data: WA.status === 'awaiting_scan' && MODE.role !== 'supervisor' ? '2@VIP-QR-de-prueba-0123456789,abcdefghijklmnop,qrstuvwxyz==' : null, qr_expires_at: WA.status === 'awaiting_scan' ? new Date(Date.now() + 40000).toISOString() : null, ...extra });
/** Simula al worker: tras pedir conectar avanza starting → awaiting_scan → connecting → connected en cada lectura. */
function waHandle(route, p, method) {
  if (method === 'POST' && p.endsWith('/connect')) { WA.desired = 'connected'; WA.step = 0; WA.error = null; return json(route, { requested: true, ...waState() }); }
  if (method === 'POST' && p.endsWith('/disconnect')) { WA.desired = 'disconnected'; WA.status = 'disconnected'; WA.phone = null; WA.step = 0; return json(route, { requested: true, ...waState() }); }
  if (WA.desired === 'connected' && !WA.workerOff && WA.status !== 'connected' && WA.status !== 'failed') {
    const seq = ['starting', 'awaiting_scan', 'awaiting_scan', 'connecting', 'connected'];
    WA.status = seq[Math.min(WA.step++, seq.length - 1)]; WA.since = new Date().toISOString(); if (WA.status === 'connected') WA.phone = '+50760001234';
  }
  return json(route, waState());
}
const external = [];
const calls = [];
async function wire(ctx) {
  await ctx.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (url.hostname === 'localhost') {
      if (url.pathname.startsWith('/api/v1/')) {
        calls.push(`${method} ${url.pathname}${url.search}`);
        const p = url.pathname.replace('/api/v1', '');
        if (MODE.htmlApi) return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><body>Angular dev server</body></html>' });
        if (p === '/users' && method === 'GET') return json(route, [{ user_id: 'user-1', email: 'admin@example.test', full_name: 'Administrador de prueba', role: 'super_admin', created_at: '2026-01-01T00:00:00Z' }, { user_id: 'user-2', email: 'supervisora@example.test', full_name: 'Supervisora de prueba', role: 'supervisor', created_at: '2026-03-01T00:00:00Z' }]);
        if (p === '/imports/excel') { const kind = (route.request().postData() ?? '').includes('plantilla') ? 'directory' : 'cobranza'; return json(route, { created: true, importId: kind === 'directory' ? 'i2' : 'i1', status: 'previewed', kind, summary: kind === 'directory' ? { kind, rows: 3, drivers: { new: 2, existing: 1, toUpdate: 1, unchanged: 0 }, units: { new: 2, existing: 1, withoutDriver: 1, withCondition: 1 }, assignments: { new: 2, same: 0, conflicts: 0 }, rates: { new: 2, same: 0, differs: 1 }, errors: 0, conflicts: 0, duplicates: 0, skipped: 0, warningsByType: {}, conditions: { custody: 1 } } : { kind, blocks: 3, rows: 40, rowsWithWarnings: 2, candidatePayments: 20, warningsByType: { totals_row: 2 }, matchCounts: { unmatched: 38, matched: 2 }, assignmentsResolvable: { skip: 7, latestBlock: 5 } } }); }
        if (p === '/imports' && method === 'GET') return json(route, []);
        if (/^\/imports\/i[12]\/rows$/.test(p)) return json(route, p.includes('i2') ? [{ id: 'r1', source_row: 2, unit_code: 'T-9', operator_code: '501', national_id: '8-500-5000', first_name: 'Rosa', last_name: 'Prueba', phone_e164: '+50760000009', match_status: 'matched', review_status: 'pending', warnings: [], daily_rate_cents: 3600, changes: { driver: { action: 'update', from: { phone_e164: '+50760000000' }, to: { phone_e164: '+50760000009' } }, unit: 'new', assignment: 'new', rate: 'differs' } }, { id: 'r2', source_row: 3, unit_code: 'T-8', operator_code: '502', national_id: '8-500-5001', first_name: 'Luis', last_name: 'Prueba', match_status: 'unmatched', review_status: 'pending', warnings: [], daily_rate_cents: 3000, changes: { driver: { action: 'create' }, unit: 'new', assignment: 'new', rate: 'new' } }] : [{ id: 'r1', block_index: 0, source_row: 5, unit_code: 'T-1', operator_code: '101', national_id: '8-100-1001', full_name: 'Conductor Prueba A', match_status: 'unmatched', review_status: 'pending', warnings: [], daily_rate_cents: 3600 }]);
        if (/^\/imports\/i[12]\/(confirm|apply)$/.test(p)) return json(route, p.endsWith('apply') ? { drivers_created: 2, drivers_updated: 1, units_created: 2, assignments_created: 2, rates_created: 2, rates_changed: 1, skipped: 0, rows_rejected: 0, rows_excluded: 0, issues: [] } : {});
        if (p === '/dashboard') return json(route, { drivers: { total: 3, active: 2, inactive: 0, suspended: 1, pending_approval: 0 }, collections: { pending_total_cents: 3600, drivers_with_debt: 1, collected_today_gross_cents: 3700, collected_today_commission_cents: 100, collected_today_net_cents: 3600, week_charged_cents: 13200, week_net_cents: 10000, credits_total_cents: 400 }, by_method: [{ method_code: 'yappy', payments: 1, gross_cents: 3700, commission_cents: 100, net_cents: 3600 }], reminders: { scheduled_today: 0, pending_total: 1 }, whatsapp: { sessions: [{ id: 'w1', label: 'Principal', status: 'qr_pending' }] } });
        if (p === '/weekly-collection') return json(route, weekly);
        if (p === '/reports/period') return json(route, url.searchParams.get('from') === '2026-11-16' ? summary : { ...summary, from: url.searchParams.get('from'), expected_cents: 12000, net_cents: 9900, pending_end_cents: 2000, credits_end_cents: 0, difference_cents: -2100, recovery_pct: 82.5 });
        if (p === '/reports/period/detail') return json(route, detailRows);
        if (p === '/reports/series') return json(route, series);
        if (p === '/templates/preview') return json(route, { text: 'Hola Conductor Prueba A, su cuota de hoy es $36.00. Saldo total: $36.00.' });
        if (p.startsWith('/whatsapp/session')) return waHandle(route, p, method);
        if (p === '/payments/preview') return json(route, { grossCents: 3700, commissionCents: 100, netCents: 3600, companyReceivesCents: 3600, balanceBeforeCents: 3600, balanceAfterCents: 0, pendingAfterCents: 0, creditAfterCents: 0, creditGeneratedCents: 0 });
        if (p.startsWith('/assignments/') && p.endsWith('/rate')) return json(route, { assignment_id: 'a1', from: '2026-12-01', existing_charges_from_date_unchanged: 3 });
        return json(route, {});
      }
      return route.continue();
    }
    if (url.hostname.endsWith('supabase.co')) {
      const path = url.pathname;
      if (path === '/auth/v1/token') return json(route, { access_token: jwt(), token_type: 'bearer', expires_in: 3600, expires_at: 4102444800, refresh_token: 'r', user: user('admin@example.test') });
      if (path === '/auth/v1/logout') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } });
      if (path === '/auth/v1/user') return json(route, user('admin@example.test'));
      if (path === '/rest/v1/rpc/current_app_role') { calls.push('rpc current_app_role'); return json(route, MODE.role); }
      if (path === '/rest/v1/rpc/set_unit_agreement') {
        const b = JSON.parse(route.request().postData() ?? '{}'); calls.push('rpc set_unit_agreement ' + JSON.stringify(b));
        if (MODE.agreementFails) return json(route, { code: 'P0001', message: 'forbidden' }, 400);
        const u = units.find((x) => x.id === b.p_unit_id); const changed = u.agreement !== b.p_agreement || u.agreement_note !== b.p_note;
        u.agreement = b.p_agreement; u.agreement_note = b.p_note;
        return json(route, { unit_id: u.id, agreement: u.agreement, agreement_note: u.agreement_note, changed });
      }
      if (path === '/rest/v1/rpc/assignment_dues') return json(route, [{ today_cents: 1000, overdue_cents: 2600, future_cents: 0, total_pending_cents: 3600, credit_cents: 0 }]);
      const m = /^\/rest\/v1\/([a-z_]+)$/.exec(path);
      if (m && method === 'GET') { calls.push(`GET supabase ${m[1]}`); return json(route, TABLES[m[1]] ?? []); }
      if (m) { calls.push(`${method} supabase ${m[1]}`); return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } }); }
      if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
      return json(route, {});
    }
    external.push(url.href);
    return route.abort();
  });
}

const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' });
const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok, extra }); console.log(`${ok ? 'OK ' : 'FALLA'} ${name} ${extra}`); };

async function session(viewport, label) {
  const ctx = await browser.newContext({ viewport, serviceWorkers: 'block', locale: 'es-PA', timezoneId: 'America/Panama' });
  await wire(ctx);
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|ERR_FAILED/.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  return { ctx, page, errors, label };
}
const shot = async (s, name) => { await s.page.waitForTimeout(350); await s.page.screenshot({ path: join(out, `${s.label}-${name}.png`), fullPage: false }); };
const noOverflow = async (s, name) => {
  const w = await s.page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  check(`${s.label} sin scroll horizontal de página: ${name}`, w.sw <= w.iw + 1, `(${w.sw}/${w.iw})`);
};

// 1) Cuenta NO autorizada
{
  const s = await session({ width: 1280, height: 800 }, 'escritorio');
  MODE.role = null;
  await s.page.goto(`${base}/`);
  await s.page.waitForURL('**/login');
  await s.page.fill('#email', 'otra@example.test'); await s.page.fill('#password', 'x');
  await s.page.click('button[type=submit]');
  await s.page.waitForSelector('[role=alert]');
  const msg = await s.page.textContent('[role=alert]');
  check('cuenta no autorizada: mensaje claro', msg.includes('Esta cuenta no está autorizada para usar VIP'), msg.trim());
  check('cuenta no autorizada: sigue en /login', s.page.url().endsWith('/login'));
  check('cuenta no autorizada: sin organizaciones en el texto', !/organizaci/i.test(await s.page.textContent('body')));
  await shot(s, '00-login-no-autorizada');
  await s.page.goto(`${base}/conductores`);
  await s.page.waitForURL('**/login');
  check('ruta protegida sin sesión redirige a /login', true);
  MODE.role = 'super_admin';
  await s.ctx.close();
}


const rect = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), b: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) }; }, sel);
async function layout(s) {
  const { page, label } = s; const iw = page.viewportSize().width, ih = page.viewportSize().height;
  const bodyBg = await page.evaluate(() => getComputedStyle(document.querySelector('.crm')).backgroundColor);
  const sb = await rect(page, '.sidebar'); const card = await rect(page, '.main-col');
  if (label === 'movil') {
    check(`${label} la tarjeta usa todo el ancho (margen pequeño)`, card.l <= 8 && iw - card.r <= 8, JSON.stringify(card));
    check(`${label} sin sidebar permanente`, !sb);
    return;
  }
  check(`${label} sidebar expandido ≈240`, Math.abs(sb.w - 240 - 12) <= 14 || Math.abs(sb.w - 240) <= 14, `ancho ${sb.w}`);
  check(`${label} marco oscuro #2F3847`, bodyBg === 'rgb(47, 56, 71)', bodyBg);
  const gap = card.l - sb.r;
  check(`${label} tarjeta pegada al sidebar sin hueco (card.left == sidebar.right + margen 0)`, Math.abs(gap) <= 1, `gap ${gap}`);
  check(`${label} tarjeta llega al margen derecho (ventana - card.right ≈ 12)`, Math.abs(iw - card.r - 12) <= 2, `derecha ${iw - card.r}`);
  check(`${label} tarjeta con margen superior/inferior 12`, Math.abs(card.t - 12) <= 2 && Math.abs(ih - card.b - 12) <= 2, `t ${card.t} b ${ih - card.b}`);
  const radius = await page.evaluate(() => getComputedStyle(document.querySelector('.main-col')).borderRadius);
  check(`${label} esquinas redondeadas 26px`, radius === '26px', radius);
  const sbBorder = await page.evaluate(() => { const c = getComputedStyle(document.querySelector('.sidebar')); return c.borderRightWidth + '|' + c.backgroundColor; });
  check(`${label} sidebar sin borde y sin fondo propio (integrado al marco)`, sbBorder === '0px|rgba(0, 0, 0, 0)', sbBorder);
}
async function collapseCheck(s) {
  const { page, label } = s; const iw = page.viewportSize().width;
  await page.click('.collapse');
  await page.waitForTimeout(500);
  const sb = await rect(page, '.sidebar'); const card = await rect(page, '.main-col');
  check(`${label} sidebar contraído ≈72 (incluye margen 12)`, Math.abs(sb.w - 72) <= 2, `ancho ${sb.w}`);
  check(`${label} contraído: tarjeta sin hueco (card.left == sidebar.right)`, Math.abs(card.l - sb.r) <= 1, `card.l ${card.l} sb.r ${sb.r}`);
  check(`${label} contraído: tarjeta se amplía hasta el margen derecho`, Math.abs(iw - card.r - 12) <= 2, `derecha ${iw - card.r}`);
  check(`${label} aria-expanded=false al contraer`, (await page.getAttribute('.collapse', 'aria-expanded')) === 'false');
  await page.hover('.sidebar nav a:nth-child(2)');
  await page.waitForTimeout(200);
  const tipOpacity = await page.evaluate(() => getComputedStyle(document.querySelector('.sidebar nav a:nth-child(2)'), '::after').opacity);
  check(`${label} tooltip visible al pasar el cursor`, tipOpacity === '1', tipOpacity);
  const m = await page.evaluate(() => {
    const col = document.querySelector('.sidebar').getBoundingClientRect();
    const links = Array.from(document.querySelectorAll('.sidebar nav a')).map((a) => { const r = a.getBoundingClientRect(); const ic = a.querySelector('app-icon svg').getBoundingClientRect(); return { l: r.left, r: r.right, w: r.width, h: r.height, t: r.top, b: r.bottom, ic: ic.left + ic.width / 2 }; });
    const btn = document.querySelector('.sidebar .collapse'); const br = btn.getBoundingClientRect(); const bic = btn.querySelector('app-icon svg').getBoundingClientRect();
    const logo = document.querySelector('.sidebar .mark').getBoundingClientRect();
    return { center: col.left + col.width / 2, links, btn: { l: br.left, r: br.right, w: br.width, h: br.height, ic: bic.left + bic.width / 2 }, logo: logo.left + logo.width / 2 };
  });
  const near = (a, b, tol = 1) => Math.abs(a - b) <= tol;
  check(`${label} contraído: centro de cada icono == centro de la columna (${m.center})`, m.links.every((l) => near(l.ic, m.center)) && near(m.btn.ic, m.center) && near(m.logo, m.center), JSON.stringify(m.links.map((l) => Math.round(l.ic * 10) / 10)));
  check(`${label} contraído: todos los botones del menú con el MISMO ancho y alto`, m.links.every((l) => near(l.w, m.links[0].w) && near(l.h, m.links[0].h)), `${m.links[0].w}x${m.links[0].h}`);
  const act = await page.evaluate(() => { const a = document.querySelector('.sidebar nav a.active'); const r = a.getBoundingClientRect(); const c = document.querySelector('.sidebar').getBoundingClientRect(); return { left: r.left - c.left, right: c.right - r.right }; });
  check(`${label} contraído: margen izquierdo y derecho del botón activo iguales y > 6px (no pegado)`, near(act.left, act.right) && act.left >= 6, `izq ${act.left} der ${act.right}`);
  const gaps = m.links.slice(1).map((l, i) => Math.round((l.t - m.links[i].b) * 10) / 10);
  check(`${label} contraído: separación vertical uniforme`, gaps.every((g) => near(g, gaps[0], 0.6)), gaps.join(','));
  check(`${label} contraído: botón expandir con el mismo ancho y centrado`, near(m.btn.w, m.links[0].w), `${m.btn.w}`);
  await shot(s, '20-sidebar-contraido');
  // persistencia
  await page.reload(); await page.waitForSelector('.crm.collapsed');
  check(`${label} preferencia de contraído guardada`, true);
  // transición: a mitad de camino el ancho es intermedio
  await page.click('.collapse');
  await page.waitForTimeout(90);
  const mid = await rect(page, '.sidebar');
  check(`${label} transición suave (ancho intermedio durante la animación)`, mid.w > 74 && mid.w < 250, `ancho a 90ms ${mid.w}`);
  await page.waitForTimeout(400);
  await shot(s, '21-sidebar-expandido');
}

async function run(viewport, label) {
  units.forEach((u, i) => { u.agreement = i === 0 ? 'CUSTODIA' : i === 2 ? 'chapa y pintura' : null; u.agreement_note = i === 0 ? 'En el taller por reparación' : null; });
  const s = await session(viewport, label);
  const { page } = s;
  const mobile = label === 'movil';
  await page.goto(`${base}/login`);
  await page.fill('#email', 'admin@example.test'); await page.fill('#password', 'prueba');
  await shot(s, '01-login');
  await page.click('button[type=submit]');
  await page.waitForURL(`${base}/dashboard`);
  await page.waitForSelector('.stat');
  check(`${label} login autorizado va directo a /dashboard`, true);
  check(`${label} llamó a current_app_role`, calls.includes('rpc current_app_role'));
  await shot(s, '02-dashboard'); await noOverflow(s, 'dashboard');
  await layout(s);
  if (!mobile) await collapseCheck(s);
  await page.reload(); await page.waitForSelector('.stat');
  check(`${label} sesión persistente tras recargar`, !page.url().includes('login'));

  const visit = async (path, name, ready, prep) => {
    await page.goto(`${base}${path}`);
    await page.waitForSelector(ready, { timeout: 8000 });
    if (prep) await prep();
    await shot(s, name); await noOverflow(s, name);
  };
  const list = mobile ? 'ul.cards li' : 'table tbody tr';

  // Redirecciones y rutas
  for (const [from, to] of [['/asignaciones', '/drivers/assignments'], ['/conductores', '/drivers'], ['/finanzas', '/collections'], ['/finanzas/excel', '/imports'], ['/', '/dashboard']]) {
    await page.goto(`${base}${from}`); await page.waitForSelector('.crm');
    check(`${label} ruta antigua ${from} → ${to}`, new URL(page.url()).pathname === to, new URL(page.url()).pathname);
  }

  // Conductores (módulo con pestañas, migas y menú activo)
  await visit('/drivers', '03-conductores', list);
  check(`${label} responsive conductores: ${mobile ? 'tarjetas' : '<table>'}`, mobile ? !(await page.$('table')) : !!(await page.$('table')));
  const act = async () => page.$$eval('.sidebar nav a.active, .drawer nav a.active', (as) => as.map((a) => a.textContent.trim()));
  if (!mobile) {
    await visit('/drivers/assignments', '04-asignaciones', list);
    check(`${label} /drivers/assignments: «Conductores» sigue ACTIVO (y solo ese)`, JSON.stringify(await act()) === '["Conductores"]', JSON.stringify(await act()));
    check(`${label} migas «Conductores / Asignaciones»`, (await page.textContent('.crumbs')).replace(/\s+/g, '') === 'Conductores/Asignaciones', await page.textContent('.crumbs'));
    const heads = await page.$$eval('thead th', (t) => t.map((x) => x.textContent.trim()));
    check(`${label} tabla de asignaciones con las columnas pedidas`, JSON.stringify(heads) === JSON.stringify(['Código de operario', 'Nombre y apellido', 'Código de unidad', 'Estado de asignación', 'Fecha de inicio', 'Fecha de fin', 'Acciones']), heads.join('|'));
    await visit('/drivers/new', '05-conductor-nuevo', '#df-title');
    check(`${label} formulario de conductor sin código de unidad`, !(await page.$('input[id*=unit], [name*=unit]')));
    check(`${label} /drivers/new: «Conductores» activo y migas «Conductores / Nuevo»`, JSON.stringify(await act()) === '["Conductores"]' && (await page.textContent('.crumbs')).replace(/\s+/g, '') === 'Conductores/Nuevo');
    await page.goto(`${base}/dashboard`); await page.waitForSelector('.stat');
    check(`${label} /dashboard: «Conductores» NO activo`, !(await act()).includes('Conductores'), JSON.stringify(await act()));
    await page.goto(`${base}/vehicles`); await page.waitForSelector('table');
    check(`${label} /vehicles: «Conductores» NO activo`, JSON.stringify(await act()) === '["Unidades"]', JSON.stringify(await act()));
  } else {
    await visit('/drivers/assignments', '04-asignaciones', 'ul.cards li');
    check('movil asignaciones en tarjetas', !(await page.$('table')));
    await visit('/drivers/new', '05-conductor-nuevo', '#df-title');
  }
  await visit('/drivers/d1', '06-ficha-conductor', '[aria-label="Desglose de la deuda"]');
  check(`${label} migas «Conductores / <nombre>»`, (await page.textContent('.crumbs')).replace(/\s+/g, '') === 'Conductores/ConductorPruebaA', await page.textContent('.crumbs'));
  await visit('/vehicles', '07-unidades', list);
  check(`${label} unidades: acuerdo / condición especial visible tal cual`, (await page.textContent('main')).includes('CUSTODIA') && (await page.textContent('main')).includes('chapa y pintura'));
  await visit('/vehicles/u1', '08-unidad-condicion', '[aria-labelledby=ud-cond]');
  check(`${label} ficha de unidad: historial del acuerdo con 12 h`, (await page.textContent('[aria-labelledby=ud-cond]')).includes('10:30 AM'), '');
  await visit('/vehicles/u1', '08b-unidad-editar-condicion', '[aria-labelledby=ud-cond]', async () => { await page.click('button:has-text("Editar")'); await page.waitForSelector('#ag-text'); });
  // Autosave del acuerdo: blur -> Guardando/Guardado, sin boton Guardar, y persiste al recargar
  await page.goto(`${base}/vehicles/u1`); await page.waitForSelector('#ag-text');
  check(`${label} acuerdo: campo de texto libre sin botón Guardar`, !!(await page.$('input#ag-text')) && !(await page.$('app-unit-agreement button:has-text("Guardar")')) && !(await page.$('#uf-cond')));
  await page.fill('#ag-text', 'REVISADO PENDIENTE'); await page.fill('#ag-note', 'esperando repuesto');
  const nCalls = calls.filter((c) => c.startsWith('rpc set_unit_agreement')).length;
  await page.click('main h2:has-text("Acuerdo / condición especial")');
  await page.waitForSelector('text=✓ Guardado');
  check(`${label} acuerdo: guarda al perder el foco (1 solicitud) y muestra «✓ Guardado»`, calls.filter((c) => c.startsWith('rpc set_unit_agreement')).length === nCalls + 1);
  await shot(s, '08d-acuerdo-guardado');
  await page.click('#ag-text'); await page.click('main h2:has-text("Acuerdo / condición especial")'); await page.waitForTimeout(300);
  check(`${label} acuerdo: sin cambios NO envía solicitud`, calls.filter((c) => c.startsWith('rpc set_unit_agreement')).length === nCalls + 1);
  await page.reload(); await page.waitForSelector('#ag-text');
  check(`${label} acuerdo: al recargar aparece exactamente el texto guardado`, (await page.inputValue('#ag-text')) === 'REVISADO PENDIENTE' && (await page.inputValue('#ag-note')) === 'esperando repuesto');
  check(`${label} acuerdo: el historial muestra «anterior → nuevo»`, (await page.textContent('[aria-labelledby=ud-cond]')).includes('→'));
  MODE.agreementFails = true;
  await page.fill('#ag-text', 'OTRO'); await page.keyboard.press('Enter'); await page.waitForSelector('.save-state .alert');
  check(`${label} acuerdo: error con mensaje y «Reintentar», conserva lo escrito`, (await page.textContent('.save-state')).includes('Reintentar') && (await page.inputValue('#ag-text')) === 'OTRO');
  await shot(s, '08e-acuerdo-error');
  MODE.agreementFails = false; await page.click('.save-state button:has-text("Reintentar")'); await page.waitForSelector('text=✓ Guardado');
  await visit('/vehicles', '08f-unidades-acuerdo', list);
  await page.fill('#q', 'otro'); await page.waitForTimeout(250);
  check(`${label} unidades: la búsqueda encuentra el acuerdo (sin distinguir mayúsculas)`, (await page.$$(mobile ? 'ul.cards li' : 'tbody tr')).length === 1);
  await page.fill('#q', ''); await page.check('#cf-none'); await page.waitForTimeout(250);
  check(`${label} unidades: filtro «Sin acuerdo»`, (await page.textContent('main')).includes('T-2') && !(await page.textContent('main')).includes('T-3'));
  await visit('/vehicles/u1', '08c-unidad-cambiar-conductor', '[aria-labelledby=ud-cond]', async () => { await page.click('button:has-text("Cambiar conductor")'); await page.waitForSelector('app-reassign-form'); });
  await visit('/collections', '09-cobranza', list);
  await visit('/collections', '10-registro-pago', list, async () => {
    if (mobile) await page.click('li button:has-text("Registrar pago")'); else { await page.click('td.day-cell'); await page.click('app-collection-detail button:has-text("Registrar pago")'); }
    await page.waitForSelector('app-payment-sheet .sheet'); await page.fill('#pay-amount', '37'); await page.waitForSelector('table[aria-label="Vista previa del pago"]');
  });
  await visit('/payments', '11-pagos-metodos', 'table');
  await visit('/messages', '12-mensajeria', '#sch-title');
  const times = await page.textContent('main');
  check(`${label} horarios en 12 h (11:00 AM, 5:00 PM, 9:00 PM)`, /11:00 AM/.test(times) && /5:00 PM/.test(times) && /9:00 PM/.test(times) && !/\b1[1-9]:00(?! [AP]M)/.test(times.replace(/\d{1,2}:\d{2} [AP]M/g, '')), '');
  await visit('/messages', '12b-horario-editor', '#sch-title', async () => { await page.click(mobile ? 'ul[aria-label=Horarios] li button:has-text("Editar")' : 'tbody button:has-text("Editar")'); await page.waitForSelector('#sf-hour'); });
  check(`${label} editor con hora + minutos + AM/PM`, !!(await page.$('#sf-hour')) && !!(await page.$('#sf-min')) && !!(await page.$('#sf-ampm')) && !(await page.$('#sf-time')));
  await visit('/messages/templates', '13-plantillas', 'text=Variables disponibles');
  await visit('/messages/history', '14-historial', mobile ? 'ul.cards li' : 'table[aria-label="Historial de envíos"]');
  check(`${label} historial con fechas en 12 h`, /\d{2}\/\d{2}\/\d{4} \d{1,2}:\d{2} [AP]M/.test(await page.textContent('main')));
  // WhatsApp: un solo boton, QR automatico y estado real
  Object.assign(WA, { status: 'disconnected', desired: 'disconnected', workerOff: false, step: 0, phone: null, error: null });
  await visit('/messages/whatsapp', '15-whatsapp-desconectado', 'text=WhatsApp principal');
  check(`${label} whatsapp: UN solo botón «Conectar WhatsApp»`, JSON.stringify(await page.$$eval('.actions button', (b) => b.map((x) => x.textContent.trim()))) === '["Conectar WhatsApp"]' && !(await page.$('text=Ver código QR')) && !(await page.$('text=Actualizar estado')));
  await page.click('button:has-text("Conectar WhatsApp")');
  await page.waitForSelector('img[alt^="Código QR"]', { timeout: 15000 });
  check(`${label} whatsapp: el QR aparece solo en la misma pantalla, con instrucciones`, (await page.textContent('main')).includes('Vincular dispositivo') && (await page.textContent('.badge')).trim() === 'Esperando escaneo');
  check(`${label} whatsapp: nunca un mensaje de éxito prematuro`, !/Se pidió conectar/.test(await page.textContent('main')) && !(await page.$('.alert.ok')));
  await shot(s, '16-whatsapp-qr'); await noOverflow(s, 'whatsapp qr');
  await page.waitForSelector('dt:has-text("Número vinculado")', { timeout: 15000 });
  check(`${label} whatsapp: conectado muestra número y «Desconectar»`, (await page.textContent('main')).includes('+50760001234') && !!(await page.$('button:has-text("Desconectar")')));
  await shot(s, '17-whatsapp-conectado'); await noOverflow(s, 'whatsapp conectado');
  await page.click('button:has-text("Desconectar")'); await page.waitForSelector('[role=alertdialog]');
  check(`${label} whatsapp: desconectar pide confirmación`, (await page.textContent('[role=alertdialog]')).includes('¿Desconectar WhatsApp?'));
  await shot(s, '18-whatsapp-confirmar'); await noOverflow(s, 'whatsapp confirmar');
  await page.keyboard.press('Escape'); await page.waitForTimeout(200);
  check(`${label} whatsapp: Esc cierra el diálogo sin desconectar`, !(await page.$('[role=alertdialog]')) && (await page.textContent('.badge')).trim() === 'Conectado');
  await page.click('button:has-text("Desconectar")'); await page.click('[role=alertdialog] button:has-text("Sí, desconectar")');
  await page.waitForSelector('button:has-text("Conectar WhatsApp")');
  WA.workerOff = true;
  await page.click('button:has-text("Conectar WhatsApp")'); await page.waitForSelector('#wa-worker');
  check(`${label} whatsapp: worker apagado → aviso ámbar con pnpm dev:worker y sin éxito`, (await page.textContent('#wa-worker')).includes('pnpm dev:worker') && !(await page.$('.alert.ok')) && (await page.textContent('.badge')).trim() === 'Desconectado');
  await shot(s, '19-whatsapp-worker-apagado'); await noOverflow(s, 'whatsapp worker');
  WA.workerOff = false; Object.assign(WA, { status: 'failed', desired: 'connected', error: 'Sesión cerrada desde el teléfono' });
  await page.reload(); await page.waitForSelector('text=Sesión cerrada desde el teléfono');
  check(`${label} whatsapp: error real y «Reintentar»`, !!(await page.$('button:has-text("Reintentar")')));
  await shot(s, '19b-whatsapp-error');
  Object.assign(WA, { status: 'disconnected', desired: 'disconnected', error: null });
  await visit('/reports', '16-informes', 'button.indicator');

  // Configuración: 2 columnas en escritorio, 1 en móvil; contenido a ancho completo
  await visit('/settings', '17-configuracion', '.settings-grid');
  const cols = await page.$$eval('.settings-grid > section', (xs) => [...new Set(xs.map((x) => Math.round(x.getBoundingClientRect().left)))].length);
  check(`${label} configuración en ${mobile ? 1 : 2} columna(s)`, cols === (mobile ? 1 : 2), `${cols}`);
  check(`${label} configuración sin «nombre del negocio/organización»`, !/organizaci|nombre del negocio/i.test(await page.textContent('main')));
  const titles = await page.$$eval('.settings-grid h2', (h) => h.map((x) => x.textContent.trim()));
  check(`${label} secciones de configuración`, JSON.stringify(titles) === JSON.stringify(['Cuenta', 'Usuarios y permisos', 'Métodos de pago', 'Horarios de recordatorios', 'Conexión WhatsApp', 'Preferencias']), titles.join('|'));
  await visit('/settings/users', '18-usuarios', 'text=Ventana de altas en Supabase Auth');
  await visit('/profile', '19-perfil', '#pf-title');

  // Ancho completo (card.width - padding ≈ ancho del contenido)
  if (!mobile) {
    for (const p of ['/dashboard', '/collections', '/settings', '/reports']) {
      await page.goto(`${base}${p}`); await page.waitForSelector('main .page'); await page.waitForTimeout(400);
      const w = await page.evaluate(() => { const c = document.querySelector('.main-col').getBoundingClientRect(); const m = document.querySelector('main'); const cs = getComputedStyle(m); const pg = document.querySelector('main .page').getBoundingClientRect(); return { card: c.width, pad: parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight), page: pg.width, scrollbar: m.offsetWidth - m.clientWidth }; });
      check(`${label} ${p}: contenido a ancho completo (card ${Math.round(w.card)} − padding ${w.pad} ≈ ${Math.round(w.page)})`, Math.abs(w.card - w.pad - w.page) <= 20, JSON.stringify(w));
    }
  }

  // Importación masiva: ambos tipos
  await visit('/imports', '20-importar', '#xlsx');
  const upload = async (name) => { await page.setInputFiles('#xlsx', { name, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from(name.includes('plantilla') ? 'plantilla' : 'cobranza') }); await page.waitForSelector('[aria-label="Resumen de la vista previa"]'); };
  await upload('cobranza-semanal.xlsx');
  check(`${label} importación cobranza: opción de bloque más reciente con aviso de supuesto`, !!(await page.$('text=Revisión de filas')));
  await shot(s, '21-importar-cobranza-previa'); await noOverflow(s, 'importar cobranza');
  await page.click('button:has-text("Aprobar todas las filas")'); await page.waitForSelector('#a-latest');
  check(`${label} cobranza: checkbox «bloque más reciente» + advertencia + cuántos resuelve`, (await page.textContent('.option')).includes('supuesto sin confirmar') && (await page.textContent('.option')).includes('5'));
  await shot(s, '22-importar-cobranza-aplicar'); await noOverflow(s, 'importar aplicar');
  await page.click('button:has-text("Cerrar")');
  await upload('plantilla-conductores.xlsx'); await page.waitForSelector('text=Conductores por actualizar');
  check(`${label} importación plantilla: tarjetas de categorías`, (await page.textContent('[aria-label="Resumen de la vista previa"]')).includes('Conductores por actualizar'));
  await shot(s, '23-importar-plantilla-previa'); await noOverflow(s, 'importar plantilla');
  check(`${label} plantilla: fila muestra antes → después`, (await page.textContent('main')).includes('→ +50760000009'));
  await page.click('button:has-text("Aprobar todas las filas")'); await page.waitForSelector('#a-rates');
  await page.click('button:has-text("Aplicar importación")'); await page.waitForSelector('text=Conductores actualizados');
  await shot(s, '24-importar-plantilla-resultado'); await noOverflow(s, 'importar resultado');
  check(`${label} exportaciones nuevas (conductores, unidades, asignaciones)`, (await page.$$eval('app-exports-panel li strong', (x) => x.map((y) => y.textContent))).filter((t) => ['Conductores', 'Unidades', 'Asignaciones'].includes(t)).length === 3);

  // Menú de usuario
  await page.goto(`${base}/dashboard`); await page.waitForSelector('.stat');
  check(`${label} no hay botón «Cerrar sesión» suelto en el header`, !(await page.$('header > button[aria-label="Cerrar sesión"]')));
  const btn = page.locator('.user-btn');
  await btn.click(); await page.waitForSelector('[role=menu]');
  check(`${label} menú: aria-expanded=true y foco en el primer elemento`, (await btn.getAttribute('aria-expanded')) === 'true' && (await page.evaluate(() => document.activeElement?.textContent.trim())) === 'Mi perfil');
  await shot(s, '25-menu-usuario'); await noOverflow(s, 'menú usuario');
  const box = await page.evaluate(() => { const r = document.querySelector('.user-menu .menu').getBoundingClientRect(); return { l: r.left, r: r.right, iw: innerWidth }; });
  check(`${label} menú dentro de la ventana`, box.l >= 0 && box.r <= box.iw, JSON.stringify(box));
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown');
  check(`${label} menú: flechas mueven el foco a «Cerrar sesión»`, (await page.evaluate(() => document.activeElement?.textContent.trim())) === 'Cerrar sesión');
  await page.keyboard.press('Escape'); await page.waitForTimeout(150);
  check(`${label} menú: Esc cierra y devuelve el foco al botón`, !(await page.$('[role=menu]')) && (await page.evaluate(() => document.activeElement?.classList.contains('user-btn'))));
  await btn.click(); await page.waitForSelector('[role=menu]'); await page.mouse.click(box.iw / 2, 500); await page.waitForTimeout(150);
  check(`${label} menú: clic fuera lo cierra`, !(await page.$('[role=menu]')));
  await btn.click(); await page.click('[role=menuitem]:has-text("Mi perfil")'); await page.waitForURL('**/profile');
  await btn.click(); await page.click('[role=menuitem]:has-text("Configuración")'); await page.waitForURL('**/settings');
  check(`${label} menú: Mi perfil → /profile y Configuración → /settings`, true);

  if (mobile) {
    await page.goto(`${base}/dashboard`); await page.waitForSelector('.stat');
    await page.click('button[aria-label="Abrir menú"]'); await page.waitForSelector('aside.drawer'); await page.waitForTimeout(350);
    await shot(s, '26-drawer');
    check('movil drawer: foco en el primer enlace', (await page.evaluate(() => document.activeElement?.textContent?.trim())) === 'Inicio');
    for (let i = 0; i < 14; i++) await page.keyboard.press('Tab');
    check('movil drawer: foco atrapado', await page.evaluate(() => !!document.activeElement?.closest('aside.drawer')));
    await page.keyboard.press('Escape'); await page.waitForTimeout(200);
    check('movil drawer: Esc lo cierra', !(await page.$('aside.drawer')));
    await page.click('button[aria-label="Abrir menú"]'); await page.waitForSelector('aside.drawer');
    await page.mouse.click(385, 400); await page.waitForTimeout(200);
    check('movil drawer: clic fuera lo cierra', !(await page.$('aside.drawer')));
  }
  // Cerrar sesión desde el menú
  await page.goto(`${base}/dashboard`); await page.waitForSelector('.stat');
  await btn.click(); await page.click('[role=menuitem]:has-text("Cerrar sesión")'); await page.waitForURL('**/login');
  check(`${label} cerrar sesión desde el menú vuelve a /login`, true);
  check(`${label} sin errores de consola relevantes`, s.errors.filter((e) => !/\[VIP\] error/.test(e)).length === 0, s.errors.slice(0, 2).join(' | '));
  await s.ctx.close();
}

// Roles y errores técnicos (escritorio)
async function roles() {
  for (const role of ['supervisor', 'admin', 'super_admin']) {
    MODE.role = role;
    const s = await session({ width: 1440, height: 900 }, `rol-${role}`);
    const { page } = s;
    await page.goto(`${base}/login`); await page.fill('#email', 'x@example.test'); await page.fill('#password', 'p'); await page.click('button[type=submit]');
    await page.waitForURL('**/dashboard'); await page.waitForSelector('.stat');
    await page.click('.user-btn'); await page.waitForSelector('[role=menu]');
    const head = await page.textContent('.menu-head'); await page.keyboard.press('Escape');
    check(`${role}: el menú muestra el rol`, head.includes(role.toUpperCase()), head.trim());
    await page.goto(`${base}/drivers`); await page.waitForSelector('table');
    const nuevo = !!(await page.$('a:has-text("Nuevo conductor")'));
    check(`${role}: «Nuevo conductor» ${role === 'supervisor' ? 'oculto' : 'visible'}`, nuevo === (role !== 'supervisor'));
    await page.goto(`${base}/collections`); await page.waitForSelector('table');
    check(`${role}: «Cerrar semana» ${role === 'supervisor' ? 'oculto' : 'visible'}`, !!(await page.$('button:has-text("Cerrar semana")')) === (role !== 'supervisor'));
    await page.goto(`${base}/payments`); await page.waitForSelector('table');
    check(`${role}: editar métodos de pago ${role === 'super_admin' ? 'visible' : 'oculto'}`, !!(await page.$('button:has-text("Nuevo método")')) === (role === 'super_admin'));
    await page.goto(`${base}/imports`); await page.waitForSelector('#xlsx');
    check(`${role}: importar ${role === 'supervisor' ? 'deshabilitado' : 'habilitado'}`, (await page.$eval('#xlsx', (e) => e.disabled)) === (role === 'supervisor'));
    await page.goto(`${base}/settings`); await page.waitForSelector('.settings-grid');
    check(`${role}: acceso a «Usuarios y permisos» ${role === 'super_admin' ? 'visible' : 'oculto'}`, !!(await page.$('a[href="/settings/users"]')) === (role === 'super_admin'));
    if (role === 'supervisor') await shot(s, '30-rol-supervisor-importar'); 
    if (role === 'supervisor') { await page.goto(`${base}/imports`); await page.waitForSelector('#xlsx'); await shot(s, '30-rol-supervisor-importar'); await page.goto(`${base}/vehicles/u1`); await page.waitForSelector('[aria-labelledby=ud-cond]'); await shot(s, '31-rol-supervisor-unidad'); }
    if (role === 'super_admin') { await page.goto(`${base}/settings/users`); await page.waitForSelector('table[aria-label=Usuarios]'); await shot(s, '32-rol-super-usuarios'); }
    await s.ctx.close();
  }
  MODE.role = 'super_admin';
  // API que devuelve HTML (dev-server sin proxy) → api_unreachable con detalle técnico
  const s = await session({ width: 1440, height: 900 }, 'error-api');
  const { page } = s;
  await page.goto(`${base}/login`); await page.fill('#email', 'x@example.test'); await page.fill('#password', 'p'); await page.click('button[type=submit]');
  await page.waitForURL('**/dashboard'); await page.waitForSelector('.stat');
  MODE.htmlApi = true;
  await page.goto(`${base}/reports`); await page.waitForSelector('[role=alert]');
  const txt = await page.textContent('[role=alert]');
  check('API no-JSON: mensaje api_unreachable con método, ruta y HTTP', txt.includes('No se pudo contactar la API de VIP (GET /api/v1/reports/period, HTTP 200). Comprueba que Fastify esté en marcha.'), txt.slice(0, 160));
  check('API no-JSON: nunca el comodín genérico', !txt.includes('Ocurrió un error inesperado'));
  await page.click('.err-detail summary');
  check('«Detalle técnico» desplegable con origen y ruta', (await page.textContent('.err-detail code')).includes('origen: API de VIP'), await page.textContent('.err-detail code'));
  await shot(s, '33-error-api-detalle'); await noOverflow(s, 'error api');
  MODE.htmlApi = false;
  await s.ctx.close();
}
await run({ width: 1440, height: 900 }, 'escritorio');
await run({ width: 1024, height: 768 }, 'tablet');
await run({ width: 390, height: 844 }, 'movil');
await roles();

check('ninguna petición salió a hosts externos (todas abortadas)', true, external.length ? `abortadas: ${[...new Set(external)].slice(0, 5).join(', ')}` : 'ninguna');
check('ninguna llamada a /members ni con organizationId', !calls.some((c) => /members|organizationId/i.test(c)));
await browser.close();
server.close();
const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} comprobaciones OK`);
process.exit(bad.length ? 1 : 0);

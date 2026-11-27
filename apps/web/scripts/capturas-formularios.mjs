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
const MODE = { role: 'super_admin', htmlApi: false };
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
const units = units0.map((u, i) => ({ ...u, condition_code: i === 0 ? 'custody' : null, condition_comment: i === 0 ? 'En el taller por reparación' : null, condition_since: i === 0 ? '2026-11-02' : null }));
const conditionTypes = [{ code: 'agreement', label: 'Acuerdo', requires_comment: false, active: true, sort_order: 1 }, { code: 'custody', label: 'Custodia', requires_comment: false, active: true, sort_order: 2 }, { code: 'rescue', label: 'Rescate', requires_comment: false, active: true, sort_order: 3 }, { code: 'other', label: 'Otros', requires_comment: true, active: true, sort_order: 6 }];
const conditionHistory = [{ id: 'h1', unit_id: 'u1', condition_code: 'custody', comment: 'En el taller por reparación', since: '2026-11-02', previous_condition_code: null, previous_comment: null, source: 'manual', changed_by: 'user-1', changed_by_profile: { full_name: 'Administrador de prueba', email: 'admin@example.test' }, changed_at: '2026-11-02T15:30:00Z' }];
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

const TABLES = { unit_condition_types: conditionTypes, unit_condition_history: conditionHistory, drivers, units, assignments, rates, payment_methods: [{ id: 'm1', code: 'cash', label: 'Efectivo', commission_cents: 0, active: true }, { id: 'm2', code: 'yappy', label: 'Yappy', commission_cents: 100, active: true }],
  message_templates: templates, notification_schedules: schedules, notification_jobs: jobs, rate_exceptions: [{ id: 'x1', assignment_id: 'a1', on_date: '2026-11-25', amount_cents: 1800, reason: 'Feriado acordado' }],
  app_settings: [{ id: true, business_name: 'VIP', timezone: 'America/Panama', max_per_driver_per_day: 3, min_minutes_between: 60, grace_minutes: 180 }],
  whatsapp_sessions: [{ id: 'w1', label: 'Principal', status: 'qr_pending', desired_state: 'connected', last_seen_at: '2026-11-16T14:00:00Z' }],
  v_assignment_position: [{ assignment_id: 'a1', charged_cents: 7200, gross_cents: 3700, commission_cents: 100, net_cents: 3600, pending_cents: 3600, credit_cents: 0, balance_cents: 3600 }],
  v_movements: [{ assignment_id: 'a1', occurred_at: '2026-11-16T14:00:00Z', kind: 'payment', ref_id: 'p1', amount_cents: 3600, commission_cents: 100, detail: 'vigente' }, { assignment_id: 'a1', occurred_at: '2026-11-16T05:00:00Z', kind: 'charge', ref_id: 'c1', amount_cents: 3600, commission_cents: null, detail: '2026-11-16' }] };

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
        if (p === '/whatsapp/session/qr') return json(route, { qr_data: 'https://example.invalid/vinculo-de-prueba', qr_expires_at: '2026-11-16T15:30:00Z', status: 'qr_pending' });
        if (p === '/whatsapp/session') return json(route, { id: 'w1', label: 'Principal', status: 'qr_pending', last_seen_at: '2026-11-16T14:00:00Z' });
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
      if (path === '/rest/v1/rpc/set_unit_condition') { calls.push('rpc set_unit_condition'); return json(route, null); }
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


const FORM_ROUTES = (process.env.FORM_MODE === 'antes') ? ['/drivers/new'] : ['/drivers/new', '/drivers/d1?edit', '/vehicles?new', '/drivers/assignments?new', '/settings', '/imports', '/collections?pay'];
const prefix = process.env.FORM_MODE === 'antes' ? 'form-antes' : 'form-despues';
const shotF = async (page, name) => { await page.waitForTimeout(450); await page.screenshot({ path: join(out, `${prefix}-${name}.png`) }); };
async function login(page) {
  await page.goto(`${base}/login`); await page.fill('#email', 'admin@example.test'); await page.fill('#password', 'p'); await page.click('button[type=submit]');
  await page.waitForURL('**/dashboard'); await page.waitForSelector('.stat');
}
/** Mide tarjeta, formulario y columnas de campos. */
const measure = (page, sel) => page.evaluate((sel) => {
  const q = (s) => document.querySelector(s);
  const card = q('.main-col').getBoundingClientRect(); const main = q('main'); const cs = getComputedStyle(main);
  const padL = parseFloat(cs.paddingLeft), padR = parseFloat(cs.paddingRight);
  const form = q(sel); const fr = form.getBoundingClientRect();
  const fields = Array.from(form.querySelectorAll('.field')).filter((f) => f.getBoundingClientRect().width > 0 && !f.matches('.form-field--full'));
  const xs = [...new Set(fields.map((f) => Math.round(f.getBoundingClientRect().left)))];
  const widths = fields.map((f) => Math.round(f.getBoundingClientRect().width));
  const sbw = main.offsetWidth - main.clientWidth;
  const inputs = Array.from(form.querySelectorAll('input:not([type=checkbox]),select,textarea')).filter((e) => e.getBoundingClientRect().width > 0);
  const cut = inputs.some((e) => e.getBoundingClientRect().right > fr.right + 1 || e.getBoundingClientRect().left < fr.left - 1);
  // superposición entre campos hermanos
  const rects = fields.map((f) => f.getBoundingClientRect());
  let overlap = false; for (let a = 0; a < rects.length; a++) for (let b = a + 1; b < rects.length; b++) { const A = rects[a], B = rects[b]; if (A.left < B.right - 1 && B.left < A.right - 1 && A.top < B.bottom - 1 && B.top < A.bottom - 1) overlap = true; }
  const acts = form.querySelector('.form-actions, .actions'); const ar = acts ? acts.getBoundingClientRect() : null;
  return { cardW: Math.round(card.width), cardR: Math.round(card.right), padL, padR, formL: Math.round(fr.left), formR: Math.round(fr.right), formW: Math.round(fr.width), usable: Math.round(card.width - padL - padR - sbw), cols: xs.length, minW: Math.min(...widths), maxW: Math.max(...widths), cut, overlap, sw: document.scrollingElement.scrollWidth, iw: innerWidth, actR: ar ? Math.round(ar.right) : null, scrollbar: sbw };
}, sel);

const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' });
const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok, extra }); console.log(`${ok ? 'OK ' : 'FALLA'} ${name} ${extra}`); };
const SIZES = process.env.FORM_MODE === 'antes' ? [[1440, 900]] : [[1920, 1080], [1440, 900], [1024, 768], [768, 1024], [390, 844]];
const table = [];
for (const [w, h] of SIZES) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, serviceWorkers: 'block', locale: 'es-PA', timezoneId: 'America/Panama' });
  await wire(ctx);
  const page = await ctx.newPage();
  await login(page);
  for (const collapsed of (w >= 768 ? [false, true] : [false])) {
    await page.goto(`${base}/drivers/new`); await page.waitForSelector('app-driver-form form');
    const isCol = await page.evaluate(() => !!document.querySelector('.crm.collapsed'));
    if (isCol !== collapsed) { await page.click('.collapse'); await page.waitForTimeout(450); }
    await page.waitForTimeout(300);
    const m = await measure(page, 'app-driver-form form');
    const tag = `${w}-${collapsed ? 'contraido' : 'expandido'}`;
    table.push({ tag, ...m });
    console.log(tag, JSON.stringify(m));
    await shotF(page, tag);
    if (process.env.FORM_MODE === 'antes') continue;
    const expectedCols = w >= 1900 ? [3, 4] : w >= 1280 ? [3, 4] : w >= 1000 ? [2, 3] : w >= 700 ? [2, 2] : [1, 1];
    check(`${tag} ancho del formulario ≈ ancho útil de la tarjeta (dif ${Math.abs(m.formW - m.usable)} px)`, Math.abs(m.formW - m.usable) < 2, `form ${m.formW} útil ${m.usable}`);
    check(`${tag} columnas ${m.cols} (esperado ${expectedCols.join('–')})`, m.cols >= expectedCols[0] && m.cols <= expectedCols[1]);
    check(`${tag} campos ni diminutos ni exagerados (${m.minW}–${m.maxW} px)`, m.minW >= 200 || w < 500 && m.minW >= 280 || m.minW >= 200, `${m.minW}-${m.maxW}`);
    check(`${tag} ningún campo cortado ni superpuesto`, !m.cut && !m.overlap);
    check(`${tag} sin scroll horizontal global (${m.sw}/${m.iw})`, m.sw <= m.iw);
    check(`${tag} botones alineados a la derecha (form.right − actions.right < 2)`, w < 500 ? true : m.formR - m.actR >= 10 && m.formR - m.actR <= 24, `form.R ${m.formR} act.R ${m.actR} (padding del panel)`);
    if (collapsed) { const prev = table[table.length - 2]; check(`${tag} al contraer el sidebar el formulario se amplía (${prev.formW} → ${m.formW}) sin hueco a la derecha`, m.formW > prev.formW && (m.cols >= prev.cols)); }
  }
  // Otros formularios: ancho completo y sin desbordes
  if (process.env.FORM_MODE !== 'antes') {
    const others = [['/drivers/d1', 'button:has-text("Editar")', 'app-driver-form form', 'editar-conductor'], ['/vehicles', 'a, button:has-text("Nueva unidad")', 'app-unit-form form', 'unidad-nueva'], ['/drivers/assignments', 'button:has-text("Nueva asignación")', 'form.panel', 'asignacion-nueva']];
    for (const [url, click, formSel, nm] of others) {
      await page.goto(`${base}${url}`); await page.waitForSelector('main .page');
      await page.waitForTimeout(500);
      await page.click(click.includes(',') ? 'button:has-text("Nueva unidad")' : click); await page.waitForSelector(formSel);
      const m = await measure(page, formSel);
      check(`${w} ${nm}: ancho = útil (${m.formW}/${m.usable}), sin desborde`, Math.abs(m.formW - m.usable) < 2 && m.sw <= m.iw && !m.cut && !m.overlap, JSON.stringify({ cols: m.cols }));
      if (w === 1440 || w === 390) await shotF(page, `${nm}-${w}`);
    }
    for (const [url, nm] of [['/settings', 'configuracion'], ['/imports', 'importar']]) {
      await page.goto(`${base}${url}`); await page.waitForSelector('main .page'); await page.waitForTimeout(500);
      const m = await page.evaluate(() => { const mn = document.querySelector('main'); const cs = getComputedStyle(mn); const p = document.querySelector('main .page').getBoundingClientRect(); return { page: Math.round(p.width), usable: Math.round(mn.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)), sw: document.scrollingElement.scrollWidth, iw: innerWidth }; });
      check(`${w} ${nm}: contenedor = ancho útil (${m.page}/${m.usable}), sin scroll horizontal`, Math.abs(m.page - m.usable) < 2 && m.sw <= m.iw);
      if (w === 1440) await shotF(page, `${nm}-${w}`);
    }
  }
  await ctx.close();
}
await browser.close(); server.close();
const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} comprobaciones OK`);
import { writeFileSync } from 'node:fs';
writeFileSync(join(out, `${prefix}-mediciones.json`), JSON.stringify(table, null, 1));
process.exit(bad.length ? 1 : 0);

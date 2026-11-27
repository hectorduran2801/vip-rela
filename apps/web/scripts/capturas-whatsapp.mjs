// Capturas de WhatsApp (indicador del encabezado, pantalla y mensaje de prueba) con red SIMULADA: sirve dist/web y responde
// Supabase y la API con page.route. Todo host externo se ABORTA; no se envía ningún WhatsApp. Datos de PRUEBA.
// Uso: pnpm --filter @vip/web build && PLAYWRIGHT_PATH=/ruta/playwright/index.mjs node apps/web/scripts/capturas-whatsapp.mjs
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

const state = { role: 'super_admin', session: {}, calls: [], real: false };
const SESSION = (o) => ({ id: 'w1', label: 'Principal', status: 'disconnected', desired_state: 'disconnected', phone_number: null, last_error: null, worker_heartbeat_at: new Date().toISOString(),
  status_changed_at: new Date(Date.now() - 3600e3).toISOString(), updated_at: new Date().toISOString(), checked_at: new Date().toISOString(), worker_online: true, sending_mode: 'test', real_test_enabled: false,
  qr_data: null, qr_expires_at: null, ...o });
const HISTORY = [
  ['h1', 'prepared', 'real'], ['h2', 'processing', 'real'], ['h3', 'simulated', 'simulated'], ['h4', 'sent', 'real'], ['h5', 'delivered', 'real'], ['h6', 'failed', 'real'], ['h7', 'cancelled', 'simulated'],
].map(([id, status, mode], i) => ({ id, kind: i === 2 ? 'payment_receipt_preview' : 'test', recipient_phone: '+50760009999', body: i === 2 ? 'Comprobante de pago (PRUEBA)\nUnidad P811 · Yappy\nAbono $29.00 · Pendiente $7.00' : 'Mensaje de prueba de VIP', requested_mode: mode, status,
  sender_phone: '+50761112222', provider_message_id: null, error: status === 'failed' ? 'OpenWA: tiempo de espera agotado' : null, recipient_authorization: null, created_at: new Date(Date.now() - i * 600e3).toISOString(), processed_at: null, delivered_at: null }));

const jwt = () => `${Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: 'user-1', aud: 'authenticated', role: 'authenticated', exp: 4102444800 })).toString('base64url')}.firma`;
const user = { id: 'user-1', aud: 'authenticated', role: 'authenticated', email: 'admin@example.test', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' };
const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*', 'content-range': '0-0/*' }, body: JSON.stringify(body) });
const external = [];
async function wire(ctx) {
  await ctx.route('**/*', async (route) => {
    const url = new URL(route.request().url()); const method = route.request().method();
    if (url.hostname === 'localhost') {
      if (!url.pathname.startsWith('/api/v1/')) return route.continue();
      const p = url.pathname.replace('/api/v1', ''); state.calls.push(`${method} ${p}`);
      if (p === '/whatsapp/session') {
        const s = SESSION(state.session);
        if (s.status === 'awaiting_scan' && state.role !== 'supervisor') { s.qr_data = 'https://example.invalid/vinculo-de-prueba-' + Math.floor(Date.now() / 30000); s.qr_expires_at = new Date(Date.now() + 55e3).toISOString(); }
        return json(route, s);
      }
      if (p === '/whatsapp/test-messages/preview') { const b = JSON.parse(route.request().postData()); const d = b.phone.replace(/\D/g, '');
        return json(route, { recipient: /^[1-9]\d{7,14}$/.test(d) ? '+' + d : null, invalid_phone: !/^[1-9]\d{7,14}$/.test(d), recipient_is_a_driver: d.endsWith('0001'), body: b.body, chars: b.body.length, sender: '+50761112222', session_status: 'connected', sending_mode: 'test', real_test_enabled: state.real }); }
      if (p === '/whatsapp/test-messages' && method === 'GET') return json(route, HISTORY);
      if (p === '/whatsapp/test-messages/receipt-preview') return json(route, { gross_cents: 3000, commission_cents: 100, net_cents: 2900, pending_cents: 700, credit_cents: 0, body: 'Comprobante de pago (PRUEBA)\nUnidad P811 · Yappy\nEntregado: $30.00 · Comisión: $1.00\nAbono: $29.00 · Pendiente: $7.00' });
      return json(route, {});
    }
    if (url.hostname.endsWith('supabase.co')) {
      const path = url.pathname;
      if (path === '/auth/v1/token') return json(route, { access_token: jwt(), token_type: 'bearer', expires_in: 3600, expires_at: 4102444800, refresh_token: 'r', user });
      if (path === '/auth/v1/user') return json(route, user);
      if (path === '/rest/v1/rpc/current_app_role') return json(route, state.role);
      if (path === '/rest/v1/payment_methods') return json(route, [{ id: 'm2', code: 'yappy', label: 'Yappy', commission_cents: 100, active: true }, { id: 'm1', code: 'cash', label: 'Efectivo', commission_cents: 0, active: true }]);
      if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
      return json(route, []);
    }
    external.push(url.href); return route.abort();
  });
}
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' });
const results = [];
const check = (n, ok, x = '') => { results.push(ok); console.log(`${ok ? 'OK   ' : 'FALLA'} ${n} ${x}`); };
async function open(w, h, path, collapsed) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, serviceWorkers: 'block', locale: 'es-PA', timezoneId: 'America/Panama' });
  await wire(ctx);
  const page = await ctx.newPage();
  await page.addInitScript((c) => { try { localStorage.setItem('vip.sidebar.collapsed', c ? '1' : '0'); } catch {} }, collapsed);
  await page.goto(`${base}/login`); await page.fill('#email', 'admin@example.test'); await page.fill('#password', 'x'); await page.click('button[type=submit]');
  await page.waitForURL('**/dashboard');
  await page.goto(`${base}${path}`); await page.waitForSelector('.wa-btn'); await page.waitForTimeout(700);
  return { ctx, page };
}
const shot = (page, n) => page.screenshot({ path: join(out, `whatsapp-${n}.png`) });
const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1 && Array.from(document.querySelectorAll('main *')).every((e) => e.getBoundingClientRect().right <= window.innerWidth + 1));

const SCEN = {
  'conectado-prueba': { status: 'connected', desired_state: 'connected', phone_number: '+50761112222', sending_mode: 'test' },
  'conectado-real': { status: 'connected', desired_state: 'connected', phone_number: '+50761112222', sending_mode: 'real' },
  'conectando': { status: 'connecting', desired_state: 'connected' },
  'qr': { status: 'awaiting_scan', desired_state: 'connected' },
  'desconectado': { status: 'disconnected' },
  'error': { status: 'failed', desired_state: 'connected', last_error: 'La sesión fue cerrada desde el teléfono' },
  'worker-apagado': { status: 'disconnected', desired_state: 'connected', worker_online: false, sending_mode: 'unknown', worker_heartbeat_at: new Date(Date.now() - 600e3).toISOString() },
};
for (const [w, h, tag] of [[1440, 900, 'escritorio'], [390, 844, 'movil']]) {
  for (const collapsed of w > 768 ? [false, true] : [false]) {
    const side = collapsed ? 'contraido' : 'expandido';
    for (const [name, s] of Object.entries(SCEN)) {
      state.session = s; state.role = 'super_admin'; state.real = false;
      const { ctx, page } = await open(w, h, '/messages/whatsapp', collapsed);
      if (name === 'qr') await page.waitForSelector('.wa-qr img', { timeout: 8000 }).catch(() => {});
      await shot(page, `pantalla-${name}-${tag}-${side}`);
      check(`${tag} ${side} ${name}: sin scroll horizontal`, await noHScroll(page));
      if (!collapsed || w < 768) {
        const hdr = page.locator('.wa-btn');
        const txt = (await hdr.innerText()).trim();
        if (w < 768) check(`${name} móvil: solo icono+punto`, txt === '');
        else check(`${name}: texto del encabezado «${txt.replace(/\n/g, ' ')}»`, txt.length > 0);
        await page.screenshot({ path: join(out, `whatsapp-encabezado-${name}-${tag}.png`), clip: { x: 0, y: 0, width: w, height: 70 } });
        await hdr.click(); await page.waitForSelector('#wa-pop'); await page.waitForTimeout(200);
        if (['conectado-prueba', 'worker-apagado', 'qr'].includes(name)) await shot(page, `popover-${name}-${tag}`);
        check(`${tag} ${name}: popover dentro de la ventana`, await page.evaluate(() => { const r = document.querySelector('#wa-pop').getBoundingClientRect(); return r.left >= 0 && r.right <= window.innerWidth; }));
        await page.keyboard.press('Escape'); await page.waitForTimeout(150); check(`${name}: Esc cierra el popover`, (await page.locator('#wa-pop').count()) === 0);
      }
      await ctx.close();
    }
  }
}
// API caída (gris)
{ state.session = SCEN['conectado-real'];
  const { ctx, page } = await open(1440, 900, '/messages/whatsapp', false);
  await page.unroute('**/*'); await ctx.route('**/*', (route) => { const u = new URL(route.request().url()); if (u.pathname.startsWith('/api/v1/whatsapp/session')) return route.abort(); if (u.hostname !== 'localhost') return route.abort(); return route.continue(); });
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); await page.locator('.wa-btn').click(); await page.waitForTimeout(1500);
  await shot(page, 'pantalla-api-caida-escritorio-expandido'); await page.locator('.wa-btn').click({ trial: true }).catch(() => {});
  check('API caída: encabezado «Estado desconocido»', (await page.locator('.wa-btn').innerText()).includes('Estado desconocido'));
  await page.screenshot({ path: join(out, 'whatsapp-encabezado-gris-escritorio.png'), clip: { x: 0, y: 0, width: 1440, height: 70 } });
  await ctx.close(); }
// Mensaje de prueba
for (const [w, h, tag] of [[1440, 900, 'escritorio'], [390, 844, 'movil']]) {
  state.session = SCEN['conectado-prueba']; state.role = 'super_admin'; state.real = true;
  const { ctx, page } = await open(w, h, '/messages/whatsapp/test', false);
  await shot(page, `prueba-formulario-${tag}`);
  await page.fill('#wt-phone', '+507 6000 9999'); await page.fill('#wt-body', 'Hola, esto es una prueba de VIP.'); await page.click('button:has-text("Vista previa")'); await page.waitForSelector('[aria-label="Vista previa"]'); await page.waitForTimeout(300);
  await shot(page, `prueba-vista-previa-${tag}`);
  await page.check('input[value=real]'); await page.check('#wt-own'); await page.fill('#wt-auth', 'Yo mismo'); await page.fill('#wt-l4', '9999'); await page.click('button:has-text("Continuar")'); await page.waitForTimeout(300);
  await page.evaluate(() => document.querySelector('[aria-label="Confirmación final"]')?.scrollIntoView({ block: 'center' }));
  await shot(page, `prueba-confirmacion-real-${tag}`);
  check(`${tag} prueba: sin scroll horizontal`, await noHScroll(page));
  await page.click('button:has-text("Volver")'); await page.click('button:has-text("Probar comprobante de pago")'); await page.click('button:has-text("Calcular comprobante")'); await page.waitForSelector('[aria-label=Resultado]');
  await page.evaluate(() => document.querySelector('#wt-receipt')?.scrollIntoView({ block: 'start' })); await page.waitForTimeout(200); await shot(page, `prueba-comprobante-${tag}`);
  await page.evaluate(() => document.querySelector('.wt-list')?.scrollIntoView({ block: 'start' })); await page.waitForTimeout(200); await shot(page, `prueba-historial-${tag}`);
  check(`${tag} prueba: sin scroll horizontal (final)`, await noHScroll(page));
  const txt = await page.locator('.wt-list').innerText();
  check('historial: «sent» no dice entregado', !/Enviado al proveedor[^\n]*\n[^\n]*\n[^\n]*entregado/i.test(txt) && txt.includes('Enviado al proveedor'));
  await ctx.close();
}
// ADMIN: sin enlace/ruta de prueba
{ state.role = 'admin'; state.session = SCEN['conectado-prueba'];
  const { ctx, page } = await open(1440, 900, '/messages/whatsapp', false);
  check('ADMIN no ve «Enviar mensaje de prueba»', (await page.locator('a:has-text("Enviar mensaje de prueba")').count()) === 0);
  await page.goto(`${base}/messages/whatsapp/test`); await page.waitForTimeout(800);
  check('ADMIN en la ruta de prueba es redirigido', !page.url().includes('/whatsapp/test'), page.url());
  await ctx.close(); }
check('ningún host externo contactado', external.every((u) => u.includes('supabase.co') || u.includes('fonts')), external.slice(0, 3).join(' '));
console.log(`${results.filter(Boolean).length}/${results.length} comprobaciones`);
await browser.close(); server.close();

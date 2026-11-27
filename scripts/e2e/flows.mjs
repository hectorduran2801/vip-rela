// Flujos de punta a punta en navegador contra el entorno aislado (`node scripts/e2e/env.mjs`). Datos 100 % inventados.
//   PLAYWRIGHT_PATH=/ruta/playwright/index.mjs node scripts/e2e/flows.mjs
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
const ROOT = new URL('../..', import.meta.url).pathname;
const { chromium } = await import(process.env.PLAYWRIGHT_PATH ?? 'playwright');
const ExcelJS = createRequire(`${ROOT}packages/excel-import/package.json`)('exceljs');
const BASE = 'http://localhost:8090', SHOTS = `${ROOT}.logs/e2e`; mkdirSync(SHOTS, { recursive: true });

async function excel(rows) {
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Hoja1');
  const head = ['und', 'OERADOR', 'CEDULA ', 'NOMBRE Y AELLIDO', 'WHATSAPP', 'CUENTA ', 'ACUERDO', 'SALDO', 'LUNES ', 'MARTES ', 'MIERCOLES  ', 'JUEVES ', 'VIERNES ', 'SABADO', 'DOMINGO ', 'PAGO SEMANAL', 'Cuenta semanal'];
  head.forEach((h, i) => { ws.getCell(2, 2 + i).value = h; });
  rows.forEach((r, n) => [r.unit, r.op, null, r.name, r.wsp, r.rate, null, r.saldo].forEach((v, i) => { if (v !== undefined && v !== null) ws.getCell(3 + n, 2 + i).value = v; }));
  return Buffer.from(await wb.xlsx.writeBuffer());
}
const A = { unit: 'P950', op: '910', name: 'CARLOS PRUEBA', wsp: '+50760009100', rate: 39, saldo: 199 };
const B = { unit: 'P951', op: '911', name: 'MARTA PRUEBA', wsp: '+50760009110', rate: 30, saldo: 50 };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1366, height: 850 } });
const page = await ctx.newPage(); page.setDefaultTimeout(8000);
const problems = []; const results = [];
page.on('console', (m) => { if (m.type() === 'error' && !/NG05604|fetching the script|Failed to load resource/.test(m.text())) problems.push(`consola: ${m.text().slice(0, 200)}`); });
page.on('response', (r) => { if (r.status() >= 500) problems.push(`HTTP ${r.status()} ${new URL(r.url()).pathname}`); });
let n = 0;
async function step(name, fn) {
  n += 1; const t = Date.now();
  try { await fn(); results.push(['OK', name, `${Date.now() - t} ms`]); }
  catch (e) { results.push(['FALLA', name, String(e.message).split('\n')[0].slice(0, 220)]); }
  await page.screenshot({ path: `${SHOTS}/${String(n).padStart(2, '0')}.png`, fullPage: true }).catch(() => {});
  await page.keyboard.press('Escape').catch(() => {});
}
const go = async (path) => { await page.goto(BASE + path); await page.waitForLoadState('networkidle'); };
const text = async () => (await page.locator('main').innerText()).replace(/\s+/g, ' ');
const see = async (s) => page.locator('main').getByText(s, { exact: false }).first().waitFor();
const must = (cond, msg) => { if (!cond) throw new Error(msg); };
const noBusy = async () => must(await page.locator('[aria-busy=true].is-busy').count() === 0, 'quedó un botón ocupado');
const btn = (name) => page.getByRole('button', { name, exact: true }).first();
const dialog = () => page.locator('[role=dialog], [role=alertdialog]').last();
const loaded = async (url) => { await page.waitForURL(url); await page.locator('main app-loading').first().waitFor({ state: 'detached' }); await page.waitForLoadState('networkidle'); };
const openDriver = async (op) => { await go('/drivers'); await page.locator('tbody tr', { has: page.locator(`td:text-is("${op}")`) }).locator('a').first().click(); await loaded(/\/drivers\/[0-9a-f-]{36}/); await page.locator('#dd-name').waitFor(); };
const openUnit = async (code) => { await go('/vehicles'); await page.locator('tbody a', { hasText: code }).first().click(); await loaded(/\/vehicles\/[0-9a-f-]{36}/); await page.getByText('Historial de asignaciones').waitFor(); };
const newDriver = async (op, name) => { await go('/drivers/new'); await page.fill('#df-op', op); await page.fill('#df-fn', name); await btn('Guardar').click(); };
const upload = async (rows, file) => {
  await go('/settings/data');
  await page.setInputFiles('#xlsx', { name: file, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: await excel(rows) });
  await page.getByRole('button', { name: 'Guardar datos' }).waitFor({ timeout: 20000 });
};
const saveImport = async () => { await page.getByRole('button', { name: 'Guardar datos' }).click(); await page.waitForTimeout(2500); await page.waitForLoadState('networkidle'); };

await step('Iniciar sesión', async () => { await go('/login'); await page.fill('input[type=email]', 'admin@e2e.local'); await page.fill('input[type=password]', 'e2e-clave-123'); await page.click('button[type=submit]'); await page.waitForURL(/dashboard/); });

// ── Conductores ──
await step('Crear conductor', async () => { await newDriver('900', 'Elena Prueba'); await page.waitForURL(/\/drivers($|\/(?!new))/); await go('/drivers'); await see('Elena Prueba'); await noBusy(); });
await step('Código de operario repetido: error claro y botón libre', async () => { await newDriver('900', 'Otra Persona'); await dialogOrForm(); });
async function dialogOrForm() { await page.locator('form [role=alert]').first().waitFor(); await noBusy(); must(await btn('Guardar').isEnabled(), 'Guardar quedó deshabilitado'); }
await step('Editar conductor', async () => { await openDriver('900'); await btn('Editar conductor').click(); await page.fill('#df-fn', 'Elena Editada'); await dialog().getByRole('button', { name: 'Guardar', exact: true }).click(); await page.locator('#df-fn').waitFor({ state: 'detached' }); await see('Elena Editada'); await noBusy(); });
for (const [value, label] of [['suspended', 'Suspendido'], ['active', 'Activo']]) {
  await step(`Cambiar estado a ${label}`, async () => { await openDriver('900'); await btn('Editar conductor').click(); await page.selectOption('#df-st', value); await dialog().getByRole('button', { name: 'Guardar', exact: true }).click(); await page.locator('#df-fn').waitFor({ state: 'detached' }); await see(label); });
}

// ── Unidades y asignaciones ──
await step('Crear unidad', async () => { await go('/vehicles'); await btn('Nueva unidad').click(); await page.fill('#uf-code', 'P900'); await dialog().getByRole('button', { name: 'Guardar', exact: true }).click(); await page.locator('#uf-code').waitFor({ state: 'detached' }); await see('P900'); });
await step('Asignar conductor a la unidad', async () => {
  await openUnit('P900'); await btn('Asignar conductor').click();
  await page.selectOption('#ra-driver', { label: '900 · Elena Editada ' }).catch(async () => { const v = await page.locator('#ra-driver option', { hasText: '900' }).getAttribute('value'); await page.selectOption('#ra-driver', v); });
  await page.fill('#ra-rate', '35.00'); await dialog().locator('button[type=submit]').click(); await page.locator('#ra-driver').waitFor({ state: 'detached' }); await see('Elena Editada');
});
await step('Desvincular conductor desde la unidad', async () => {
  await openUnit('P900'); await btn('Desvincular conductor').click(); await dialog().getByRole('button', { name: 'Desvincular conductor', exact: true }).click();
  await page.waitForTimeout(1500); await openUnit('P900'); must(await btn('Asignar conductor').isVisible() || /Sin conductor|desvincul/i.test(await text()), 'la unidad no quedó libre');
});

// ── Eliminar ──
await step('Eliminar conductor sin historial', async () => { await newDriver('901', 'Borrable Prueba'); await page.waitForTimeout(800); await openDriver('901'); await btn('Eliminar conductor').click(); await dialog().locator('button[type=submit]').click(); await page.waitForURL(/\/drivers$/); await page.waitForTimeout(800); must(!(await text()).includes('Borrable'), 'sigue en la lista'); });
await step('Eliminar unidad sin historial', async () => { await go('/vehicles'); await btn('Nueva unidad').click(); await page.fill('#uf-code', 'P999'); await dialog().getByRole('button', { name: 'Guardar', exact: true }).click(); await page.locator('#uf-code').waitFor({ state: 'detached' }); await openUnit('P999'); await btn('Eliminar unidad').click(); await dialog().locator('button[type=submit]').click(); await page.waitForURL(/\/vehicles$/); await page.waitForTimeout(800); must(!(await text()).includes('P999'), 'sigue en la lista'); });

// ── Excel: alta, desvinculación y reimportación ──
await step('Importar Excel (alta de dos unidades con saldo)', async () => { await upload([A, B], 'prueba-1.xlsx'); await saveImport(); await go('/vehicles'); await see('P950'); await see('Carlos Prueba'.toUpperCase()); });
await step('Excel sin operario en P950: la vista previa anuncia la finalización', async () => {
  await upload([{ unit: 'P950' }, B], 'prueba-2.xlsx'); const t = await text(); must(/Asignaciones finalizadas: 1/.test(t), 'no anuncia la finalización'); must(/910/.test(t), 'no nombra al operario'); await saveImport();
});
await step('P950 disponible y sin conductor', async () => { await openUnit('P950'); must(await btn('Asignar conductor').isVisible(), 'no ofrece asignar'); });
await step('Cobranza no muestra al desvinculado y anuncia su deuda aparte', async () => {
  await go('/collections'); await page.waitForTimeout(1200); const t = await text();
  must(!(await page.locator('tbody', { hasText: 'P950' }).count()), 'P950 sigue en la tabla'); must(/desvinculados con saldo pendiente: 2 · \$234\.00/.test(t), 'falta la deuda aparte');
});
await step('Inicio y Cobranza muestran los mismos totales', async () => {
  await go('/collections'); await page.waitForTimeout(1200);
  const cob = (await page.locator('.wk-totals').innerText()).replace(/\s+/g, ' ');
  await go('/dashboard'); await page.waitForTimeout(1500); const ini = await text();
  const saldo = cob.match(/Saldo total \(Excel\) (\$[\d.]+)/i)?.[1]; const deudores = cob.match(/Con saldo pendiente (\d+)/i)?.[1];
  must(saldo === '$50.00', `Cobranza: ${cob}`); must(new RegExp(`Pendiente por cobrar \\(cartera activa\\) \\${saldo} ${deudores} conductor`, 'i').test(ini), `Inicio distinto: ${ini.slice(ini.search(/Pendiente por cobrar/i), ini.search(/Pendiente por cobrar/i) + 90)}`);
  must(/desvinculados con saldo pendiente: 2 · \$234\.00/.test(ini), 'Inicio no muestra la deuda aparte'); must(!/P950/.test(ini), 'Inicio lista la unidad desvinculada');
});
await step('Volver a subir el mismo Excel no reactiva la asignación', async () => { await upload([{ unit: 'P950' }, B], 'prueba-3.xlsx'); must(!/Asignaciones finalizadas/.test(await text()), 'anuncia otra finalización'); await saveImport(); await openUnit('P950'); must(await btn('Asignar conductor').isVisible(), 'se reactivó'); });
await step('Conductores lista la deuda sin unidad y la ficha conserva saldo e historial', async () => {
  await go('/drivers'); await see('Desvinculados con saldo pendiente'); await openDriver('910'); await page.getByText('Saldo pendiente registrado').waitFor(); const t = await text();
  must(/Saldo pendiente registrado: \$199\.00/.test(t), 'no muestra el saldo'); must(/P950/.test(t) && /Historial de asignaciones/.test(t), 'falta el historial');
});

// ── Eliminar bloqueado, baja y reactivación ──
await step('Con historial no se elimina: se ofrece dar de baja', async () => { await openDriver('910'); await btn('Eliminar conductor').click(); await dialog().getByText('No se puede eliminar').waitFor(); await noBusy(); });
await step('Dar de baja conductor', async () => { await openDriver('910'); await btn('Dar de baja al conductor').click(); await dialog().locator('button[type=submit]').click(); await page.getByText('Dado de baja', { exact: false }).first().waitFor(); await see('Inactivo'); });
await step('El dado de baja conserva su deuda consultable', async () => { await go('/drivers'); await see('Desvinculados con saldo pendiente · $234.00'); });
await step('Reactivar conductor', async () => { await openDriver('910'); await btn('Reactivar conductor').click(); await page.getByText('Reactivado', { exact: false }).first().waitFor(); await see('Activo'); });
await step('Dar de baja unidad con historial', async () => { await openUnit('P950'); await btn('Dar de baja la unidad').click(); await dialog().locator('button[type=submit]').click(); await page.getByText('Dado de baja', { exact: false }).first().waitFor(); });
await step('Reactivar unidad', async () => { await openUnit('P950'); await btn('Reactivar unidad').click(); await page.getByText('Reactivado', { exact: false }).first().waitFor(); });

// ── Móvil ──
await page.setViewportSize({ width: 390, height: 844 });
for (const [name, path] of [['Inicio', '/dashboard'], ['Cobranza', '/collections'], ['Conductores', '/drivers'], ['Unidades', '/vehicles']]) {
  await step(`Móvil sin desplazamiento horizontal: ${name}`, async () => { await go(path); await page.waitForTimeout(800); must(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'se desborda'); });
}

console.table(results.map(([r, p, d]) => ({ r, paso: p, detalle: d })));
console.log('problemas de consola/servidor:', [...new Set(problems)].slice(0, 12));
console.log(`${results.filter((r) => r[0] === 'OK').length}/${results.length} pasos correctos`);
await browser.close();
process.exitCode = results.some((r) => r[0] !== 'OK') ? 1 : 0;

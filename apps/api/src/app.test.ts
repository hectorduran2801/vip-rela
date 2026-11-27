import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { SignJWT } from 'jose';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newDb, type Db } from '@vip/db/testing';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createDatabase } from './db.js';
import { resetRoleCache } from './plugins/auth.js';

const SECRET = 'x'.repeat(40);
const sign = (sub: string, o: { exp?: string; secret?: string; role?: string } = {}) =>
  new SignJWT({ role: o.role ?? 'authenticated', email: `${sub}@t.local` }).setProtectedHeader({ alg: 'HS256' })
    .setSubject(sub).setAudience('authenticated').setIssuedAt().setExpirationTime(o.exp ?? '5m').sign(new TextEncoder().encode(o.secret ?? SECRET));

let db: Db, app: FastifyInstance, pool: pg.Pool;
let tAdmin: string, tOut: string, tOps: string, tSup: string;
let a: { driver: string; unit: string; assignment: string };
const h = (t: string) => ({ authorization: `Bearer ${t}` });
let k = 0; const key = () => `api-test-key-${++k}-${Math.random().toString(36).slice(2, 8)}`;
const MON = '2026-03-02';
const post = (url: string, t: string, payload: object = {}) => app.inject({ method: 'POST', url: `/api/v1${url}`, headers: h(t), payload });
const get = (url: string, t: string) => app.inject({ method: 'GET', url: `/api/v1${url}`, headers: h(t) });

beforeAll(async () => {
  db = await newDb(); pool = new pg.Pool({ ...db.connection, max: 8 });
  app = await buildApp(loadConfig({ SUPABASE_JWT_SECRET: SECRET, CORS_ORIGINS: 'https://vip.example', RATE_LIMIT_PER_MINUTE: '100000' }), { db: createDatabase(pool) });
  tAdmin = await sign(db.admin); tOut = await sign(db.outsider); tOps = await sign(db.opsAdmin); tSup = await sign(db.supervisor);
  a = await db.driverWithAssignment({ code: '1', unit: 'P811', dailyCents: 3600, phone: '+50760001111', consent: true });
  for (let i = 0; i < 7; i++) await db.as(db.admin, (q) => q.query(`select public.generate_daily_charges(($1::date + $2::int))`, [MON, i]));
  // Datos de informes: el pago ya no se registra por la API (410); se siembra directo en la base (el Excel lo hace en producción).
  await db.as(db.admin, (q) => q.query(`select public.register_payment($1,'yappy',3700,$2,null,'2026-03-02T09:00:00-05:00',false,'verificado en WhatsApp')`, [a.assignment, 'seed-reports-1']));
});
afterAll(async () => { await app.close(); await pool.end(); await db.close(); });

describe('autenticación y autorización', () => {
  it('health es público y arranca en dry-run', async () => { expect((await app.inject('/health')).json()).toEqual({ status: 'ok', whatsappDryRun: true }); });
  it.each([['sin token', {}], ['token inválido', { authorization: 'Bearer abc.def.ghi' }]])('rechaza %s con 401', async (_n, headers) => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/dashboard', headers })).statusCode).toBe(401);
  });
  it('rechaza un token firmado con otra clave, expirado o con rol service_role', async () => {
    for (const t of [await sign(db.admin, { secret: 'y'.repeat(40) }), await sign(db.admin, { exp: '-1m' }), await sign(db.admin, { role: 'service_role' })]) {
      expect((await get('/dashboard', t)).statusCode).toBe(401);
    }
  });
  it('/me devuelve el rol; un usuario autenticado sin rol NO está autorizado', async () => {
    expect((await get('/me', tAdmin)).json()).toMatchObject({ userId: db.admin, authorized: true, role: 'super_admin' });
    expect((await get('/me', tOps)).json()).toMatchObject({ authorized: true, role: 'admin' });
    expect((await get('/me', tSup)).json()).toMatchObject({ authorized: true, role: 'supervisor' });
    expect((await get('/me', tOut)).json()).toMatchObject({ userId: db.outsider, authorized: false, role: null });
  });
  it('un usuario autenticado que NO es la administradora recibe 403 en todo', async () => {
    const calls = [get('/dashboard', tOut), get('/weekly-collection?weekStart=' + MON, tOut), get('/payment-methods', tOut),
      post('/payments', tOut, { assignmentId: a.assignment, methodCode: 'cash', grossCents: 1000, idempotencyKey: key() }), post('/payments/preview', tOut, { assignmentId: a.assignment, methodCode: 'cash', grossCents: 1000 }),
      post('/charges/generate', tOut, { date: '2026-03-03' }), post('/weeks/close', tOut, { weekStart: MON }), get('/reports/period?from=2026-03-02&to=2026-03-08', tOut),
      post('/assignments/start', tOut, { driverId: a.driver, unitId: a.unit, validFrom: '2026-06-01' }), post(`/assignments/${a.assignment}/rate`, tOut, { dailyCents: 100, from: '2026-06-01' }),
      get('/exports/directory.xlsx', tOut)];
    const r = await Promise.all(calls);
    expect(r.map((x) => x.statusCode)).toEqual(Array(r.length).fill(403));
  });
  it('CORS solo permite los orígenes configurados', async () => {
    const ok = await app.inject({ method: 'OPTIONS', url: '/api/v1/payments', headers: { origin: 'https://vip.example', 'access-control-request-method': 'POST' } });
    const bad = await app.inject({ method: 'OPTIONS', url: '/api/v1/payments', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
    expect(ok.headers['access-control-allow-origin']).toBe('https://vip.example'); expect(bad.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('registro manual de pagos deshabilitado (los pagos entran solo desde el Excel)', () => {
  const countPayments = async () => Number((await db.su.query(`select (select count(*) from public.payments) + (select count(*) from public.adjustments) n`)).rows[0].n);
  it('las rutas manuales responden 410 manual_payments_disabled a un usuario autorizado y no tocan la base', async () => {
    const before = await countPayments();
    const calls = [
      post('/payments/preview', tAdmin, { assignmentId: a.assignment, methodCode: 'yappy', grossCents: 3700 }),
      post('/payments', tAdmin, { assignmentId: a.assignment, methodCode: 'cash', grossCents: 1000, idempotencyKey: key() }),
      post('/payments', tAdmin, { assignmentId: 'no-uuid' }),
      post(`/payments/${randomUUID()}/void`, tAdmin, { reason: 'error de captura' }),
      post('/adjustments', tAdmin, { assignmentId: a.assignment, amountCents: 500, effectiveDate: MON, reason: 'cargo omitido', idempotencyKey: key() }),
      post('/charges/generate', tAdmin, { date: '2026-03-03' }),
      post('/weeks/close', tAdmin, { weekStart: MON }),
    ];
    for (const r of await Promise.all(calls)) { expect(r.statusCode).toBe(410); expect(r.json()).toEqual({ error: 'manual_payments_disabled' }); }
    expect(await countPayments()).toBe(before);
  });
  it('la autenticación y el rol se evalúan antes: sin token 401, sin rol 403, supervisor 403 en las de administradora', async () => {
    for (const [u, b] of [['/payments', {}], ['/payments/preview', {}], [`/payments/${randomUUID()}/void`, {}], ['/adjustments', {}], ['/charges/generate', {}], ['/weeks/close', {}]] as const) {
      expect((await app.inject({ method: 'POST', url: `/api/v1${u}`, payload: b })).statusCode, `401 ${u}`).toBe(401);
      expect((await post(u, tOut, b)).statusCode, `403 ${u}`).toBe(403);
    }
    for (const u of [`/payments/${randomUUID()}/void`, '/adjustments', '/charges/generate', '/weeks/close']) expect((await post(u, tSup, {})).statusCode, `sup ${u}`).toBe(403);
  });
  it('lecturas y motor de cuotas siguen activos', async () => {
    expect((await get('/payment-methods', tAdmin)).statusCode).toBe(200);
    expect((await get('/charges/gaps', tAdmin)).statusCode).toBe(200);
    expect((await post('/charges/ensure', tAdmin, { through: '2026-03-03' })).statusCode).toBe(200);
  });
  it('/notifications/:id/review sigue exigiendo rol de administradora', async () => {
    expect((await post(`/notifications/${randomUUID()}/review`, tOut, { action: 'approve' })).statusCode).toBe(403);
  });
});

describe('informes, plantillas y unidades', () => {
  it('tabla semanal con importes numéricos y saldos calculados', async () => {
    const row = (await get(`/weekly-collection?weekStart=${MON}`, tAdmin)).json().find((x: { operator_code: string }) => x.operator_code === '1');
    expect(row).toMatchObject({ unit_code: 'P811', daily_rate_cents: 3600, commission_cents: 100 });
    expect(row.week_charged_cents).toBeGreaterThanOrEqual(21600);
    expect(row.day_net_cents).toHaveLength(7);
  });
  it('detalle semanal por día: 7 días numéricos, filtro por asignación, lunes obligatorio y permisos', async () => {
    const all = (await get(`/weekly-collection/detail?weekStart=${MON}`, tAdmin)).json();
    expect(all.length).toBeGreaterThan(0);
    const one = (await get(`/weekly-collection/detail?weekStart=${MON}&assignmentId=${a.assignment}`, tAdmin)).json();
    expect(one).toHaveLength(1);
    expect(one[0].days.map((d: { weekday: number }) => d.weekday)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(typeof one[0].previous_pending_cents).toBe('number');
    expect(typeof one[0].days[0].charge_cents).toBe('number');
    expect((await get(`/weekly-collection/detail?weekStart=2026-03-03`, tAdmin)).json().error).toBe('week_start_must_be_monday');
    expect((await get(`/weekly-collection/detail?weekStart=${MON}`, tOut)).statusCode).toBe(403);
    expect((await get(`/weekly-collection/detail?weekStart=${MON}&assignmentId=no-uuid`, tAdmin)).statusCode).toBe(400);
  });
  it('resumen del período, detalle por indicador y serie semanal', async () => {
    const s = (await get(`/reports/period?from=${MON}&to=2026-03-08`, tAdmin)).json();
    const daily = Number((await db.su.query(`select coalesce(sum(amount_cents),0) n from public.charges where kind='daily' and charge_date between '2026-03-02' and '2026-03-08'`)).rows[0].n);
    expect(s).toMatchObject({ expected_cents: daily, commission_cents: 100 });
    expect(s.net_cents).toBe(s.gross_cents - s.commission_cents);
    const d = (await get(`/reports/period/detail?from=${MON}&to=2026-03-08&indicator=commission`, tAdmin)).json();
    expect(d.reduce((x: number, r: { amount_cents: number }) => x + r.amount_cents, 0)).toBe(s.commission_cents);
    expect((await get(`/reports/series?from=${MON}&to=2026-03-15`, tAdmin)).json().map((r: { week_start: string }) => r.week_start)).toEqual([MON, '2026-03-09']);
    expect((await get(`/reports/period/detail?from=${MON}&to=2026-03-08&indicator=inventado`, tAdmin)).statusCode).toBe(400);
    expect((await get(`/reports/period?from=2026-03-08&to=${MON}`, tAdmin)).json().error).toBe('invalid_range');
  });
  it('vista previa de plantilla con datos reales', async () => {
    const r = await post('/templates/preview', tAdmin, { assignmentId: a.assignment, body: 'Unidad {{unidad}}: {{detalle_deuda}}', date: MON });
    expect(r.json().text).toMatch(/^Unidad P811: /);
    expect(r.json().unresolved).toEqual([]);
  });
  it('vista previa: variables desconocidas se reportan en unresolved y no quedan en el texto', async () => {
    const r = await post('/templates/preview', tAdmin, { assignmentId: a.assignment, body: 'Hola {{nombre}} {{inventada}}', date: MON });
    expect(r.statusCode).toBe(200);
    expect(r.json().unresolved).toEqual(['inventada']); expect(r.json().text).not.toContain('{{');
    expect((await post('/templates/preview', tOut, { assignmentId: a.assignment, body: 'x', date: MON })).statusCode).toBe(403);
  });
  it('catálogo de variables para la UI (staff); sin token 401, sin rol 403', async () => {
    for (const t of [tAdmin, tOps, tSup]) {
      const r = await get('/templates/variables', t);
      expect(r.statusCode).toBe(200);
      const rows = r.json() as { group: string; code: string; label: string; description: string; example: string }[];
      expect([...new Set(rows.map((x) => x.group))]).toEqual(['Datos del conductor', 'Unidad y operario', 'Fechas', 'Importes financieros', 'Textos inteligentes']);
      expect(rows.find((x) => x.code === 'detalle_deuda')).toMatchObject({ group: 'Textos inteligentes', example: 'Su cuota pendiente de hoy es de $40.00.' });
      expect(Object.keys(rows[0]!).sort()).toEqual(['code', 'description', 'example', 'group', 'label']);
    }
    expect((await get('/templates/variables', tOut)).statusCode).toBe(403);
    expect((await app.inject('/api/v1/templates/variables')).statusCode).toBe(401);
  });
  it('horarios y plantillas: texto base, crear desde el texto base, uso y vista previa del horario', async () => {
    const dt = await get('/schedules/default-templates', tOps);
    expect(dt.statusCode).toBe(200);
    expect((dt.json() as { kind: string }[]).map((x) => x.kind)).toEqual(['debt_first', 'debt_update', 'debt_last', 'weekly_summary']);
    expect(Object.keys(dt.json()[0]).sort()).toEqual(['body', 'kind', 'suggested_name']);
    expect((await get('/schedules/default-templates', tSup)).statusCode).toBe(200);
    expect((await get('/schedules/default-templates', tOut)).statusCode).toBe(403);
    expect((await app.inject('/api/v1/schedules/default-templates')).statusCode).toBe(401);
    const sid = (await db.su.query(`select id from public.notification_schedules where kind='debt_first'`)).rows[0].id as string;
    // sin plantilla: source none
    const none = await get(`/schedules/${sid}/preview?assignmentId=${a.assignment}&date=${MON}`, tAdmin);
    expect(none.statusCode).toBe(200);
    expect(none.json()).toEqual({ schedule: { id: sid, kind: 'debt_first', label: 'Primer recordatorio', local_time: '11:00:00', enabled: false, template_id: null, template_name: null }, text: null, unresolved: [], source: 'none' });
    // crear desde el texto base y asignar
    const c = await post('/templates/from-default', tOps, { kind: 'debt_first', scheduleId: sid });
    expect(c.statusCode).toBe(201);
    expect(c.json()).toMatchObject({ name: 'Primer recordatorio (texto base)', body: dt.json()[0].body });
    expect((await post('/templates/from-default', tOps, { kind: 'debt_first' })).json().name).toBe('Primer recordatorio (texto base) 2');
    const pv = (await get(`/schedules/${sid}/preview?assignmentId=${a.assignment}&date=${MON}`, tAdmin)).json();
    expect(pv).toMatchObject({ source: 'template', unresolved: [], schedule: { template_id: c.json().id, template_name: 'Primer recordatorio (texto base)' } });
    // mismo motor que /templates/preview con el mismo cuerpo
    expect((await post('/templates/preview', tAdmin, { assignmentId: a.assignment, body: c.json().body, date: MON })).json().text).toBe(pv.text);
    // uso
    const u = await get(`/templates/${c.json().id}/usage`, tAdmin);
    expect(u.json()).toEqual([]);                                  // 0035: el uso se mide contra los horarios de envío; los horarios heredados ya no bloquean ni se listan
    expect((await get(`/templates/${randomUUID()}/usage`, tAdmin)).json()).toEqual({ error: 'template_not_found' });
    // validaciones y permisos
    expect((await post('/templates/from-default', tAdmin, { kind: 'payment_receipt' })).statusCode).toBe(400);
    expect((await post('/templates/from-default', tAdmin, { kind: 'debt_last', scheduleId: randomUUID() })).statusCode).toBe(404);
    expect((await get(`/schedules/${sid}/preview`, tAdmin)).statusCode).toBe(400);
    expect((await get(`/schedules/${randomUUID()}/preview?assignmentId=${a.assignment}`, tAdmin)).statusCode).toBe(404);
    for (const t of [tSup, tOut]) {
      expect((await get(`/schedules/${sid}/preview?assignmentId=${a.assignment}`, t)).statusCode).toBe(403);
      expect((await get(`/templates/${c.json().id}/usage`, t)).statusCode).toBe(403);
      expect((await post('/templates/from-default', t, { kind: 'debt_first' })).statusCode).toBe(403);
    }
    await db.su.query(`update public.notification_schedules set template_id = null where id = $1`, [sid]);     // deja el estado como estaba
  });
  it('activación explícita de horarios: vista previa, activar (confirm:true), desactivar y errores', async () => {
    const sid = (await db.su.query(`select id from public.notification_schedules where kind='debt_last'`)).rows[0].id as string;
    const pv0 = await get(`/schedules/${sid}/activation-preview`, tAdmin);
    expect(pv0.statusCode).toBe(200);
    expect(Object.keys(pv0.json()).sort()).toEqual(['blockers', 'can_activate', 'eligible_drivers', 'eligible_drivers_reason', 'schedule', 'template', 'text_example', 'unknown_variables', 'uses_variables']);
    expect(Object.keys(pv0.json().schedule).sort()).toEqual(['armed_at', 'deactivated_at', 'deactivated_reason', 'enabled', 'id', 'kind', 'label', 'local_time', 'minutes_until_next', 'next_is_today', 'next_occurrence', 'next_occurrence_local', 'scope', 'timezone', 'weekdays']);
    expect(pv0.json()).toMatchObject({ template: null, text_example: null, can_activate: false, blockers: ['no_template'], schedule: { enabled: false, timezone: 'America/Panama' } });
    // sin plantilla / sin confirmar / variables desconocidas
    expect(await post(`/schedules/${sid}/activate`, tAdmin, { confirm: true })).toMatchObject({ statusCode: 422 });
    expect((await post(`/schedules/${sid}/activate`, tAdmin, { confirm: true })).json()).toMatchObject({ error: 'template_required' });
    const bad = (await db.su.query(`insert into public.message_templates(name, body) values ('api-malo', 'Hola {{nombre}} {{foo}}') returning id`)).rows[0].id as string;
    await db.su.query(`update public.notification_schedules set template_id=$2 where id=$1`, [sid, bad]);
    const unk = await post(`/schedules/${sid}/activate`, tAdmin, { confirm: true });
    expect(unk.statusCode).toBe(422);
    expect(unk.json()).toMatchObject({ error: 'template_has_unresolved_variables', unknown_variables: ['foo'] });
    const good = (await db.su.query(`insert into public.message_templates(name, body) values ('api-bueno', 'Hola {{nombre_completo}}. {{detalle_deuda}}') returning id`)).rows[0].id as string;
    await db.su.query(`update public.notification_schedules set template_id=$2 where id=$1`, [sid, good]);
    const pv = (await get(`/schedules/${sid}/activation-preview`, tOps)).json();
    expect(pv).toMatchObject({ can_activate: true, blockers: [], unknown_variables: [], uses_variables: ['detalle_deuda', 'nombre_completo'], template: { id: good, name: 'api-bueno' }, eligible_drivers_reason: null });
    expect(pv.text_example).toBe('Hola Vanessa Ejemplo. Su cuota pendiente de hoy es de $40.00.');
    // confirmación obligatoria
    expect((await post(`/schedules/${sid}/activate`, tAdmin, { confirm: false })).json()).toMatchObject({ error: 'activation_not_confirmed' });
    expect((await post(`/schedules/${sid}/activate`, tAdmin, {})).statusCode).toBe(400);
    expect((await db.su.query(`select enabled from public.notification_schedules where id=$1`, [sid])).rows[0].enabled).toBe(false);
    const act = await post(`/schedules/${sid}/activate`, tAdmin, { confirm: true });
    expect(act.statusCode).toBe(200);
    expect(act.json()).toMatchObject({ id: sid, enabled: true });
    expect(Object.keys(act.json()).sort()).toEqual(['armed_at', 'enabled', 'id', 'next_occurrence', 'next_occurrence_local']);
    expect((await post(`/schedules/${sid}/activate`, tOps, { confirm: true })).statusCode).toBe(409);
    expect((await post(`/schedules/${sid}/activate`, tOps, { confirm: true })).json()).toMatchObject({ error: 'already_active' });
    expect((await get(`/schedules/${sid}/activation-preview`, tAdmin)).json()).toMatchObject({ can_activate: false, blockers: ['already_active'] });
    const off = await post(`/schedules/${sid}/deactivate`, tOps);
    expect(off.json()).toEqual({ id: sid, enabled: false, changed: true });
    expect((await post(`/schedules/${sid}/deactivate`, tOps)).json()).toEqual({ id: sid, enabled: false, changed: false });
    // permisos y no encontrados
    for (const t of [tSup, tOut]) {
      expect((await get(`/schedules/${sid}/activation-preview`, t)).statusCode).toBe(403);
      expect((await post(`/schedules/${sid}/activate`, t, { confirm: true })).statusCode).toBe(403);
      expect((await post(`/schedules/${sid}/deactivate`, t)).statusCode).toBe(403);
    }
    expect((await app.inject({ method: 'POST', url: `/api/v1/schedules/${sid}/activate`, payload: { confirm: true } })).statusCode).toBe(401);
    expect((await get(`/schedules/${randomUUID()}/activation-preview`, tAdmin)).statusCode).toBe(404);
    expect((await post(`/schedules/${randomUUID()}/activate`, tAdmin, { confirm: true })).json()).toEqual({ error: 'schedule_not_found' });
    expect((await post(`/schedules/${randomUUID()}/deactivate`, tAdmin)).statusCode).toBe(404);
    expect((await get(`/schedules/no-uuid/activation-preview`, tAdmin)).statusCode).toBe(400);
    await db.su.query(`update public.notification_schedules set template_id = null, enabled = false where id = $1`, [sid]);
  });
  it('asignaciones y tarifas atómicas; cambiar tarifa no toca cargos ya generados', async () => {
    const u = (await db.su.query(`insert into public.units(code) values ('NU-API') returning id`)).rows[0].id;
    const d = (await db.su.query(`insert into public.drivers(operator_code, national_id, first_name) values ('NA1','NA1','Nuevo') returning id`)).rows[0].id;
    const st = await post('/assignments/start', tAdmin, { driverId: d, unitId: u, validFrom: '2026-03-04', dailyCents: 3600 });
    expect(st.statusCode).toBe(201);
    const id = st.json().assignmentId;
    expect((await post('/assignments/start', tAdmin, { driverId: d, unitId: u, validFrom: '2026-03-05' })).json().error).toBe('assignment_overlap');
    for (let i = 0; i < 4; i++) await db.as(db.admin, (q) => q.query(`select public.generate_daily_charges($1::date)`, [`2026-03-0${4 + i}`]));
    const late = await post(`/assignments/${id}/rate`, tAdmin, { dailyCents: 4000, from: '2026-03-06' });
    expect(late.statusCode).toBe(409); expect(late.json().error).toBe('rate_change_retroactive');   // 06 y 07 ya estaban generados: la tarifa nueva solo aplica hacia adelante
    const ch = await post(`/assignments/${id}/rate`, tAdmin, { dailyCents: 4000, from: '2026-03-08', reason: 'prueba' });
    expect(ch.json().existing_charges_from_date_unchanged).toBe(0);
    expect((await db.su.query(`select amount_cents::int a from public.charges where assignment_id=$1 order by charge_date`, [id])).rows.map((r) => r.a)).toEqual([3600, 3600, 3600, 3600]);
    expect((await post(`/assignments/${id}/end`, tAdmin, { endDate: '2026-03-10' })).statusCode).toBe(204);
  });
  it('una sola sesión de WhatsApp: pedir conectar NO es estar conectado; el estado real y el servicio apagado se informan con la verdad', async () => {
    const sid = (await db.su.query(`select id from public.whatsapp_sessions`)).rows[0].id;
    await db.su.query(`insert into public.whatsapp_session_secrets(session_id, encrypted_session) values ($1,'\\xdeadbeef')`, [sid]);
    const before = (await get('/whatsapp/session', tAdmin)).json();
    expect(before).toMatchObject({ status: 'disconnected', desired_state: 'disconnected', worker_online: false, phone_number: null, qr_data: null });
    expect(JSON.stringify(before)).not.toMatch(/secret|encrypted|deadbeef/);
    // solicitar conectar: solo queda registrada la SOLICITUD; el estado sigue siendo el real (desconectado) y el servicio sigue apagado
    const req = (await post('/whatsapp/session/connect', tAdmin)).json();
    expect(req).toMatchObject({ requested: true, status: 'disconnected', desired_state: 'connected', worker_online: false });
    expect((await db.su.query(`select count(*)::int n from public.audit_logs where action='request_whatsapp_connected'`)).rows[0].n).toBe(1);
    // el worker responde: heartbeat + QR real
    await db.su.query(`update public.whatsapp_sessions set status='awaiting_scan', qr_data='qr-demo', qr_expires_at = now() + interval '1 minute', worker_heartbeat_at = now(), status_changed_at = now()`);
    expect((await get('/whatsapp/session', tAdmin)).json()).toMatchObject({ status: 'awaiting_scan', worker_online: true, qr_data: 'qr-demo' });
    expect((await get('/whatsapp/session', tSup)).json().qr_data).toBeNull();                  // el QR solo lo ve ADMIN o superior
    // QR vencido no se muestra
    await db.su.query(`update public.whatsapp_sessions set qr_expires_at = now() - interval '1 second'`);
    expect((await get('/whatsapp/session', tAdmin)).json().qr_data).toBeNull();
    // conectado: número vinculado; fallo: motivo real
    await db.su.query(`update public.whatsapp_sessions set status='connected', phone_number='+50760001111', qr_data=null, qr_expires_at=null`);
    expect((await get('/whatsapp/session', tAdmin)).json()).toMatchObject({ status: 'connected', phone_number: '+50760001111' });
    await db.su.query(`update public.whatsapp_sessions set status='failed', phone_number=null, last_error='Chrome no pudo iniciar'`);
    expect((await get('/whatsapp/session', tAdmin)).json()).toMatchObject({ status: 'failed', last_error: 'Chrome no pudo iniciar' });
    // un heartbeat antiguo = servicio apagado
    await db.su.query(`update public.whatsapp_sessions set worker_heartbeat_at = now() - interval '2 minutes'`);
    expect((await get('/whatsapp/session', tAdmin)).json().worker_online).toBe(false);
    // desconectar; permisos
    expect((await post('/whatsapp/session/disconnect', tAdmin)).json()).toMatchObject({ requested: true, desired_state: 'disconnected' });
    expect((await post('/whatsapp/session/connect', tSup)).statusCode).toBe(403);               // SUPERVISOR no conecta
    // cerrar sesión (definitivo): solo registra la solicitud; el worker borra las credenciales. Distinto de desconectar.
    expect((await post('/whatsapp/session/logout', tSup)).statusCode).toBe(403);
    const lo = (await post('/whatsapp/session/logout', tAdmin)).json();
    expect(lo).toMatchObject({ requested: true, desired_state: 'disconnected', logout_pending: true, session_persisted: false });
    expect(JSON.stringify(lo)).not.toMatch(/secret|encrypted|deadbeef|lease/);
    expect((await db.su.query(`select count(*)::int n from public.audit_logs where action='request_whatsapp_logout'`)).rows[0].n).toBe(1);
    expect((await get('/whatsapp/session', tOut)).statusCode).toBe(403);
    expect((await app.inject('/api/v1/whatsapp/session')).statusCode).toBe(401);
  });
});

describe('horarios de envío (plantilla + audiencia + hora)', () => {
  const call = (method: 'POST' | 'PUT' | 'DELETE' | 'GET', url: string, t: string, payload?: unknown) => app.inject({ method, url: `/api/v1${url}`, headers: h(t), ...(payload === undefined ? {} : { payload }) });
  it('ADMIN+ crea, edita, activa y elimina horarios; SUPERVISOR no; la plantilla en uso no se borra; cuenta la audiencia', async () => {
    const tpl = (await db.su.query(`insert into public.message_templates(name, body) values ('Noche API','Hola {{nombre}}') returning id`)).rows[0].id;
    const body = { name: 'Diez de la noche', localTime: '22:00', weekdays: [1, 2, 3, 4, 5, 6, 7], templateId: tpl, audience: 'all', enabled: true };
    expect((await call('POST', '/send-schedules', tSup, body)).statusCode).toBe(403);
    expect((await call('GET', '/send-schedules', tSup)).statusCode).toBe(403);
    expect((await call('POST', '/send-schedules', tAdmin, { ...body, localTime: '25:00' })).statusCode).toBe(400);
    expect((await call('POST', '/send-schedules', tAdmin, { ...body, audience: 'nadie' })).statusCode).toBe(400);
    expect((await call('POST', '/send-schedules', tAdmin, { ...body, templateId: null })).statusCode).toBeGreaterThanOrEqual(400);      // activo sin plantilla
    const created = await call('POST', '/send-schedules', tAdmin, body);
    expect(created.statusCode).toBe(201);
    const s = created.json();
    expect(s).toMatchObject({ name: 'Diez de la noche', local_time: '22:00', audience: 'all', enabled: true, template_id: tpl });
    const list = (await call('GET', '/send-schedules', tAdmin)).json();
    expect(list).toHaveLength(1); expect(list[0]).toMatchObject({ template_name: 'Noche API', last_run_date: null });
    expect((await call('GET', '/send-schedules/audience-count?audience=with_balance', tAdmin)).json()).toEqual({ count: expect.any(Number) });
    // plantilla en uso → usage la lista, y sin quitarla del horario la base no la borra
    expect((await get(`/templates/${tpl}/usage`, tAdmin)).json()).toMatchObject([{ label: 'Diez de la noche', kind: 'broadcast', enabled: true }]);
    expect(await db.su.query(`delete from public.message_templates where id=$1`, [tpl]).then(() => 'borrada', (e) => e.message)).toMatch(/template_in_use/);
    const edited = await call('PUT', `/send-schedules/${s.id}`, tAdmin, { ...body, audience: 'with_balance', localTime: '21:30', enabled: false });
    expect(edited.json()).toMatchObject({ audience: 'with_balance', local_time: '21:30', enabled: false });
    expect((await call('DELETE', `/send-schedules/${s.id}`, tSup)).statusCode).toBe(403);
    expect((await call('DELETE', `/send-schedules/${s.id}`, tAdmin)).statusCode).toBe(204);
    expect((await call('GET', '/send-schedules', tAdmin)).json()).toEqual([]);
  });
  it('GET /send-schedules/recipients: lista ligera solo para ADMIN, con el saldo del Excel y sin conductores sin WhatsApp', async () => {
    const r = await get('/send-schedules/recipients', tAdmin);
    expect(r.statusCode).toBe(200);
    for (const x of r.json()) { expect(Object.keys(x).sort()).toEqual(['assignmentId', 'fullName', 'operatorCode', 'phone', 'saldoCents', 'unitCode']); expect(x.phone).toBeTruthy(); }
    expect((await get('/send-schedules/recipients', tSup)).statusCode).toBe(403);
  });
  it('el estado de WhatsApp informa si el worker ejecuta horarios (recordatorios automáticos) y no expone secretos', async () => {
    await db.su.query(`update public.whatsapp_sessions set worker_heartbeat_at = now(), worker_automatic = false`);
    expect((await get('/whatsapp/session', tAdmin)).json()).toMatchObject({ automatic_enabled: false });
    await db.su.query(`update public.whatsapp_sessions set worker_automatic = true`);
    const r = (await get('/whatsapp/session', tAdmin)).json();
    expect(r.automatic_enabled).toBe(true); expect(JSON.stringify(r)).not.toMatch(/secret|encrypted/);
  });
});

describe('WhatsApp: modo de envío y mensajes de prueba', () => {
  const idem = () => `api-tm-${Math.random().toString(36).slice(2)}-xx`;
  it('el modo de envío se informa APARTE de «conectado» y solo si el worker está vivo', async () => {
    await db.su.query(`update public.whatsapp_sessions set status='connected', phone_number='+50760001111', worker_heartbeat_at=now(), worker_dry_run=true, worker_real_test_enabled=false`);
    expect((await get('/whatsapp/session', tAdmin)).json()).toMatchObject({ status: 'connected', worker_online: true, sending_mode: 'test', real_test_enabled: false });
    expect((await get('/whatsapp/session', tSup)).json()).toMatchObject({ sending_mode: 'test' });          // SUPERVISOR consulta
    await db.su.query(`update public.whatsapp_sessions set worker_dry_run=false, worker_real_test_enabled=true`);
    expect((await get('/whatsapp/session', tAdmin)).json()).toMatchObject({ sending_mode: 'real', real_test_enabled: true });
    await db.su.query(`update public.whatsapp_sessions set worker_heartbeat_at = now() - interval '5 minutes'`);   // worker apagado: no se afirma nada
    expect((await get('/whatsapp/session', tAdmin)).json()).toMatchObject({ worker_online: false, sending_mode: 'unknown', real_test_enabled: false });
    expect(typeof (await get('/whatsapp/session', tAdmin)).json().checked_at).toBe('string');
    await db.su.query(`update public.whatsapp_sessions set status='disconnected', phone_number=null, worker_dry_run=null, worker_real_test_enabled=null`);
  });
  it('solo SUPER_ADMIN usa los mensajes de prueba', async () => {
    const b = { phone: '+507 6000-0002', body: 'hola', mode: 'simulated', idempotencyKey: idem() };
    for (const t of [tOps, tSup, tOut]) {
      expect((await post('/whatsapp/test-messages', t, b)).statusCode).toBe(403);
      expect((await post('/whatsapp/test-messages/preview', t, { phone: b.phone, body: b.body })).statusCode).toBe(403);
      expect((await get('/whatsapp/test-messages', t)).statusCode).toBe(403);
    }
    expect((await app.inject({ method: 'POST', url: '/api/v1/whatsapp/test-messages', payload: b })).statusCode).toBe(401);
  });
  it('vista previa → crear (simulado) → listar → cancelar; idempotente', async () => {
    await db.su.query(`update public.whatsapp_sessions set status='connected', phone_number='+50760001111', worker_heartbeat_at=now(), worker_dry_run=true`);
    const pv = (await post('/whatsapp/test-messages/preview', tAdmin, { phone: '507 6000-0002', body: 'hola' })).json();
    expect(pv).toMatchObject({ recipient: '+50760000002', recipient_is_a_driver: false, invalid_phone: false, sender: '+50760001111', sending_mode: 'test' });
    expect((await post('/whatsapp/test-messages/preview', tAdmin, { phone: '12', body: 'x' })).json()).toMatchObject({ invalid_phone: true, recipient: null });
    const b = { phone: '+507 6000-0002', body: 'hola', mode: 'simulated', idempotencyKey: idem() };
    const a = await post('/whatsapp/test-messages', tAdmin, b);
    expect(a.statusCode).toBe(201);
    expect(a.json()).toMatchObject({ status: 'prepared', requested_mode: 'simulated', recipient_phone: '+50760000002', authorized_by: db.admin });
    expect((await post('/whatsapp/test-messages', tAdmin, b)).json().id).toBe(a.json().id);
    expect((await get('/whatsapp/test-messages', tAdmin)).json().some((m: { id: string }) => m.id === a.json().id)).toBe(true);
    expect((await post(`/whatsapp/test-messages/${a.json().id}/cancel`, tAdmin)).json().status).toBe('cancelled');
    await db.su.query(`update public.whatsapp_sessions set status='disconnected', phone_number=null, worker_dry_run=null`);
  });
  it('el envío real exige declaración y confirmación; jamás a un conductor', async () => {
    const real = { phone: '+507 6000-0003', body: 'hola', mode: 'real', idempotencyKey: idem() };
    expect((await post('/whatsapp/test-messages', tAdmin, real)).json().error).toBe('recipient_authorization_required');
    expect((await post('/whatsapp/test-messages', tAdmin, { ...real, recipientAuthorization: 'Propietario', confirmLast4: '1111' })).json().error).toBe('confirm_last4_mismatch');
    const x = await db.driverWithAssignment({ code: 'APITM', unit: 'APITMU', dailyCents: 3600 });
    await db.su.query(`update public.drivers set phone_e164='+50761230000' where id=$1`, [x.driver]);
    expect((await post('/whatsapp/test-messages', tAdmin, { ...real, phone: '+50761230000', recipientAuthorization: 'Propietario', confirmLast4: '0000' })).json().error).toBe('recipient_is_a_driver');
    expect((await post('/whatsapp/test-messages/preview', tAdmin, { phone: '+50761230000', body: 'x' })).json().recipient_is_a_driver).toBe(true);
    expect((await post('/whatsapp/test-messages', tAdmin, { ...real, recipientAuthorization: 'Propietario', confirmLast4: '0003' })).statusCode).toBe(201);
    expect((await post('/whatsapp/test-messages', tAdmin, { ...real, idempotencyKey: idem(), recipientAuthorization: 'Propietario', confirmLast4: '0003' })).json().error).toBe('real_test_already_pending');
    await db.su.query(`update public.whatsapp_test_messages set status='failed' where status='prepared'`);
  });
  it('resultado sin confirmar: lista con detalle técnico, bloquea otro real y se resuelve solo por SUPER_ADMIN', async () => {
    await db.su.query(`update public.whatsapp_test_messages set status='failed' where status in ('prepared','processing','unconfirmed')`);
    const m = (await post('/whatsapp/test-messages', tAdmin, { phone: '+507 6000-0007', body: 'hola', mode: 'real', idempotencyKey: idem(), recipientAuthorization: 'Propietario', confirmLast4: '0007' })).json();
    await db.su.query(`update public.whatsapp_test_messages set status='unconfirmed', error='Resultado sin confirmar', error_detail='sendText could not confirm the result' where id=$1`, [m.id]);
    const row = (await get('/whatsapp/test-messages', tAdmin)).json().find((x: { id: string }) => x.id === m.id);
    expect(row).toMatchObject({ status: 'unconfirmed', error_detail: 'sendText could not confirm the result' });
    expect((await post('/whatsapp/test-messages', tAdmin, { phone: '+507 6000-0007', body: 'otro', mode: 'real', idempotencyKey: idem(), recipientAuthorization: 'Propietario', confirmLast4: '0007' })).json().error).toBe('unconfirmed_result_pending');
    expect((await post(`/whatsapp/test-messages/${m.id}/resolve`, tOps, { arrived: true })).statusCode).toBe(403);
    const ok = await post(`/whatsapp/test-messages/${m.id}/resolve`, tAdmin, { arrived: true, note: 'lo vi en el chat' });
    expect(ok.json()).toMatchObject({ status: 'sent', resolution_note: 'lo vi en el chat', delivered_at: null });
    expect((await post(`/whatsapp/test-messages/${m.id}/resolve`, tAdmin, { arrived: false })).json().error).toBe('not_unconfirmed');
  });
  it('comprobante de prueba: Yappy $30 con deuda $36 → comisión $1, abono $29, pendiente $7', async () => {
    const r = (await post('/whatsapp/test-messages/receipt-preview', tAdmin, { unit: 'P811', methodCode: 'yappy', grossCents: 3000, pendingBeforeCents: 3600 })).json();
    expect(r).toMatchObject({ commission_cents: 100, net_cents: 2900, pending_cents: 700 });
    expect(r.body).toContain('Saldo pendiente: $7.00');
    expect((await post('/whatsapp/test-messages/receipt-preview', tAdmin, { unit: 'P811', methodCode: 'yappy', grossCents: 0, pendingBeforeCents: 1 })).statusCode).toBe(400);
  });
});

describe('consentimiento de WhatsApp por la API', () => {
  const put = (id: string, t: string, payload: unknown) => app.inject({ method: 'PUT', url: `/api/v1/drivers/${id}/consent`, headers: { authorization: `Bearer ${t}` }, payload });
  it('ADMIN registra con origen, retira y consulta el historial; sin origen no; ajeno no', async () => {
    const x = await db.driverWithAssignment({ code: 'APIC', unit: 'APICU', dailyCents: 3600 });
    await db.su.query(`update public.drivers set phone_e164='+50762223333' where id=$1`, [x.driver]);
    expect((await put(x.driver, tOps, { purpose: 'collection', granted: true })).json().error).toBe('consent_source_required');
    expect((await put(x.driver, tOut, { purpose: 'collection', granted: true, source: 'verbal_admin' })).statusCode).toBe(403);
    const ok = await put(x.driver, tOps, { purpose: 'collection', granted: true, source: 'driver_message', evidence: 'chat 2026-11-10' });
    expect(ok.json()).toMatchObject({ granted: true, purpose: 'collection' });
    expect((await put(x.driver, tOps, { purpose: 'collection', granted: false })).json()).toMatchObject({ granted: false });
    const h = (await get(`/drivers/${x.driver}/consents`, tOps)).json();
    expect(h.map((r: { granted: boolean; source: string }) => [r.granted, r.source])).toEqual([[false, 'withdrawal'], [true, 'driver_message']]);
  });
});

describe('mensajes individuales a conductores', () => {
  const key2 = () => `api-dm-${Math.random().toString(36).slice(2)}-xx`;
  it('ADMIN envía a un conductor con consentimiento: sin pedir autorización ni dígitos; bloquea sin consentimiento; idempotente; historial', async () => {
    const x = await db.driverWithAssignment({ code: 'APIDM', unit: 'APIDMU', dailyCents: 3600 });
    await db.su.query(`update public.drivers set phone_e164='+50763334444' where id=$1`, [x.driver]);
    const k = key2();
    expect((await post('/messages/driver', tOps, { driverId: x.driver, body: 'Hola', idempotencyKey: k })).json().error).toBe('consent_required');
    await app.inject({ method: 'PUT', url: `/api/v1/drivers/${x.driver}/consent`, headers: h(tOps), payload: { purpose: 'collection', granted: true, source: 'verbal_admin' } });
    const a = await post('/messages/driver', tOps, { driverId: x.driver, body: 'Hola', idempotencyKey: k });
    expect(a.statusCode).toBe(201);
    expect(a.json()).toMatchObject({ kind: 'driver_message', driver_id: x.driver, recipient_phone: '+50763334444', status: 'prepared', requested_mode: 'auto' });
    expect((await post('/messages/driver', tOps, { driverId: x.driver, body: 'Hola', idempotencyKey: k })).json().id).toBe(a.json().id);
    expect((await post('/messages/driver', tOps, { driverId: x.driver, body: 'Otro', idempotencyKey: key2() })).json().error).toBe('too_soon');
    const list = (await get(`/messages/driver?driverId=${x.driver}`, tOps)).json();
    expect(list).toHaveLength(1); expect(list[0]).toMatchObject({ id: a.json().id, operator_code: 'APIDM' });
    expect((await post(`/messages/driver/${a.json().id}/cancel`, tOps)).json().status).toBe('cancelled');
    for (const t of [tOut]) expect((await post('/messages/driver', t, { driverId: x.driver, body: 'x', idempotencyKey: key2() })).statusCode).toBe(403);
    expect((await post('/messages/driver', tOps, { driverId: 'no-uuid', body: 'x', idempotencyKey: key2() })).statusCode).toBe(400);
    // los mensajes de prueba externos siguen siendo solo de SUPER_ADMIN
    expect((await get('/whatsapp/test-messages', tOps)).statusCode).toBe(403);
  });
});

async function workbook(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Hoja1');
  const head = ['und', 'OERADOR', 'CEDULA', 'NOMBRE Y AELLIDO', 'CUENTA', 'ACUERDO', 'SALDO', 'LUNES ', 'MARTES ', 'MIERCOLES  ', 'JUEVES ', 'VIERNES ', 'SABADO', 'DOMINDO ', 'PAGO SEMANAL', 'Cuenta semanal'];
  const data: Array<[string, string, string, string, number, string, number | null, number[]]> = [['PX1', '70001', '8-7-1', 'JUAN PEREZ', 36, '', null, [36, 0, 0, 0, 0, 0, 0]], ['PX2', '70002', '8-7-2', 'ANA GOMEZ', 34.5, 'CUSTODIA', 40, [34.5, 0, 0, 0, 0, 0, 0]]];
  for (let b = 0; b < 2; b++) {
    const c0 = 2 + b * 18; head.forEach((t, i) => { ws.getCell(1, c0 + i).value = t; });
    data.forEach((r, i) => { const [unit, op, nid, name, rate, agr, saldo, days] = r; [unit, op, nid, name, rate, agr || null, saldo].forEach((v, kk) => { ws.getCell(i + 2, c0 + kk).value = v as never; }); days.forEach((v, kk) => { ws.getCell(i + 2, c0 + 7 + kk).value = v; }); ws.getCell(i + 2, c0 + 14).value = days.reduce((x, y) => x + y, 0) - rate * 6; ws.getCell(i + 2, c0 + 15).value = rate * 6; });
  }
  wb.addWorksheet('Hoja2').addRows([['PX1'], ['PX2']]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
const multipart = (buf: Buffer, filename: string) => {
  const b = '----vipTest';
  return { payload: Buffer.concat([Buffer.from(`--${b}\r\ncontent-disposition: form-data; name="file"; filename="${filename}"\r\ncontent-type: application/octet-stream\r\n\r\n`), buf, Buffer.from(`\r\n--${b}--\r\n`)]), headers: { 'content-type': `multipart/form-data; boundary=${b}` } };
};

describe('importación de Excel por HTTP (PostgreSQL real)', () => {
  let importId: string; let book: Buffer;
  it('sube el archivo, reconoce los bloques y deja todo en preparación', async () => {
    book = await workbook(); const m = multipart(book, 'cobranza.xlsx');
    const driversBefore = Number((await db.su.query(`select count(*) n from public.drivers`)).rows[0].n);
    const r = await app.inject({ method: 'POST', url: '/api/v1/imports/excel', headers: { ...h(tAdmin), ...m.headers }, payload: m.payload });
    expect(r.statusCode).toBe(201); importId = r.json().importId; expect(r.json().summary.blocks).toBe(2);
    expect(Number((await db.su.query(`select count(*) n from public.drivers`)).rows[0].n)).toBe(driversBefore);
    expect((await db.su.query(`select detected_week_start from public.import_blocks where import_id=$1`, [importId])).rows.every((x) => x.detected_week_start === null)).toBe(true);
  });
  it('el mismo archivo no se vuelve a importar; no .xlsx → 415; usuario no autorizado → 403', async () => {
    const m = multipart(book, 'cobranza.xlsx');
    const again = await app.inject({ method: 'POST', url: '/api/v1/imports/excel', headers: { ...h(tAdmin), ...m.headers }, payload: m.payload });
    expect([again.statusCode, again.json().created, again.json().importId]).toEqual([200, false, importId]);
    const txt = multipart(Buffer.from('hola'), 'x.xlsx');
    expect((await app.inject({ method: 'POST', url: '/api/v1/imports/excel', headers: { ...h(tAdmin), ...txt.headers }, payload: txt.payload })).statusCode).toBe(415);
    expect((await app.inject({ method: 'POST', url: '/api/v1/imports/excel', headers: { ...h(tOut), ...m.headers }, payload: m.payload })).statusCode).toBe(403);
    expect((await get(`/imports/${importId}/rows`, tOut)).statusCode).toBe(403);
  });
  it('apply antes de confirmar falla; confirmar + aplicar crea el directorio sin movimientos financieros', async () => {
    expect((await post(`/imports/${importId}/apply`, tAdmin)).json().error).toBe('import_not_confirmed');
    expect((await get(`/imports/${importId}/rows`, tAdmin)).json().length).toBe(4);
    const chargesBefore = Number((await db.su.query(`select count(*) n from public.charges`)).rows[0].n);
    expect((await post(`/imports/${importId}/confirm`, tAdmin, { approve: 'clean' })).statusCode).toBe(200);
    expect((await post(`/imports/${importId}/confirm`, tAdmin, { approve: 'clean' })).statusCode).toBe(409);
    const ap = await post(`/imports/${importId}/apply`, tAdmin, { validFrom: '2026-03-02' });
    expect(ap.json()).toMatchObject({ drivers_created: 2, units_created: 2, assignments_created: 2, rates_created: 2 });
    expect(Number((await db.su.query(`select count(*) n from public.charges`)).rows[0].n)).toBe(chargesBefore);
    expect((await db.su.query(`select daily_amount_cents::int c from public.rates r join public.assignments a2 on a2.id=r.assignment_id join public.drivers d2 on d2.id=a2.driver_id where d2.operator_code='70002'`)).rows[0].c).toBe(3450);
    expect((await get('/imports', tAdmin)).json()[0]).toMatchObject({ status: 'applied' });
  });
  it('apertura de SALDO: conciliación previa (solo lectura) con números como Number y fechas como texto', async () => {
    const blockId = (await db.su.query(`select id from public.import_blocks where import_id=$1 order by block_index limit 1`, [importId])).rows[0].id;
    const charges = Number((await db.su.query(`select count(*) n from public.charges`)).rows[0].n);
    const r = await get(`/imports/${importId}/opening-balances?blockId=${blockId}&weekStart=2026-03-02`, tAdmin);
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body).toMatchObject({ import_id: importId, block_id: blockId, week_start: '2026-03-02', summary: { rows: 2, create: 1, skip_empty: 1, create_cents: 4000, conflict: 0 } });
    const px2 = body.rows.find((x: { unit_code: string }) => x.unit_code === 'PX2');
    expect(px2).toMatchObject({ action: 'create', saldo_state: 'amount', saldo_excel_cents: 4000, pending_before_cents: 0, credit_before_cents: 0, existing_opening_cents: null, existing_opening_week_start: null, raw_saldo: '40' });
    expect(typeof px2.saldo_excel_cents).toBe('number');
    expect(body.rows.find((x: { unit_code: string }) => x.unit_code === 'PX1')).toMatchObject({ action: 'skip_empty', saldo_state: 'empty', saldo_excel_cents: null });
    expect(Number((await db.su.query(`select count(*) n from public.charges`)).rows[0].n)).toBe(charges);
    // validaciones
    expect((await get(`/imports/${importId}/opening-balances?blockId=${blockId}&weekStart=2026-03-03`, tAdmin)).json().error).toBe('week_start_must_be_monday');
    expect((await get(`/imports/${importId}/opening-balances?weekStart=2026-03-02`, tAdmin)).statusCode).toBe(400);
    expect((await get(`/imports/${importId}/opening-balances?blockId=${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}&weekStart=2026-03-02`, tAdmin)).json().error).toBe('block_not_found');
    expect((await get(`/imports/${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}/opening-balances?blockId=${blockId}&weekStart=2026-03-02`, tAdmin)).statusCode).toBe(404);
  });
  it('apertura de SALDO: solo ADMIN o superior (supervisor, externo y sin sesión no)', async () => {
    const blockId = (await db.su.query(`select id from public.import_blocks where import_id=$1 order by block_index limit 1`, [importId])).rows[0].id;
    const url = `/imports/${importId}/opening-balances?blockId=${blockId}&weekStart=2026-03-02`;
    for (const tok of [tSup, tOut]) {
      expect((await get(url, tok)).statusCode).toBe(403);
      expect((await post(`/imports/${importId}/opening-balances/apply`, tok, { blockId, weekStart: '2026-03-02' })).statusCode).toBe(403);
    }
    expect((await app.inject({ method: 'GET', url: `/api/v1${url}` })).statusCode).toBe(401);
    expect((await get(url, tOps)).statusCode).toBe(200);
  });
  it('apertura de SALDO: aplicar crea el cargo `opening` y reaplicar NO duplica', async () => {
    const blockId = (await db.su.query(`select id from public.import_blocks where import_id=$1 order by block_index limit 1`, [importId])).rows[0].id;
    expect((await post(`/imports/${importId}/opening-balances/apply`, tAdmin, { blockId: 'x', weekStart: '2026-03-02' })).statusCode).toBe(400);
    const a1 = await post(`/imports/${importId}/opening-balances/apply`, tAdmin, { blockId, weekStart: '2026-03-02', note: 'semana 1' });
    expect(a1.statusCode).toBe(200);
    expect(a1.json()).toMatchObject({ created: 1, created_cents: 4000, unchanged: 0, conflicts: 0, skipped_empty: 1, week_start: '2026-03-02' });
    const a2 = await post(`/imports/${importId}/opening-balances/apply`, tAdmin, { blockId, weekStart: '2026-03-02' });
    expect(a2.json()).toMatchObject({ created: 0, unchanged: 1 });
    expect((await db.su.query(`select count(*)::int n, sum(amount_cents)::int s, min(charge_date)::text d from public.charges where kind='opening'`)).rows[0]).toEqual({ n: 1, s: 4000, d: '2026-03-01' });
    const after = (await get(`/imports/${importId}/opening-balances?blockId=${blockId}&weekStart=2026-03-02`, tAdmin)).json();
    expect(after.rows.find((x: { unit_code: string }) => x.unit_code === 'PX2')).toMatchObject({ action: 'unchanged', existing_opening_cents: 4000, existing_opening_week_start: '2026-03-02', pending_before_cents: 4000 });
    const row = (await get(`/weekly-collection?weekStart=2026-03-02`, tAdmin)).json().find((x: { unit_code: string }) => x.unit_code === 'PX2');
    expect(row).toMatchObject({ opening_cents: 4000, previous_pending_cents: 4000, previous_credit_cents: 0, week_charged_cents: 0 });
    expect(typeof row.previous_pending_cents).toBe('number');
  });
});

async function directoryBook(rows: Array<(string | number | null)[]>): Promise<Buffer> {
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Plantilla');
  ws.addRow(['Unidad', 'Código de operador', 'Nombre', 'Apellido', 'Cédula', 'WhatsApp', 'Tarifa diaria', 'Estado', 'Acuerdo / condición especial', 'Observación']);
  rows.forEach((r) => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('importación con plantilla (altas, actualizaciones y unidades sin conductor)', () => {
  const up = async (buf: Buffer, name = 'plantilla.xlsx', t = tAdmin) => { const m = multipart(buf, name); return app.inject({ method: 'POST', url: '/api/v1/imports/excel', headers: { ...h(t), ...m.headers }, payload: m.payload }); };
  it('descarga la plantilla (.xlsx) con las columnas esperadas; solo ADMIN o superior', async () => {
    const r = await get('/imports/template.xlsx', tAdmin);
    expect(r.statusCode).toBe(200); expect(r.headers['content-disposition']).toContain('plantilla');
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(r.rawPayload as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(expect.arrayContaining(['Plantilla', 'Instrucciones']));
    expect((await get('/imports/template.xlsx', tSup)).statusCode).toBe(403);
  });
  let id: string;
  it('detecta el tipo «directory», muestra qué cambiaría y no toca nada hasta confirmar y aplicar', async () => {
    const driversBefore = Number((await db.su.query(`select count(*) n from public.drivers`)).rows[0].n);
    const authBefore = Number((await db.su.query(`select count(*) n from auth.users`)).rows[0].n);
    const r = await up(await directoryBook([['PT1', '80001', 'Luis', 'Pérez', '8-8-1', '6000-1111', 36, 'Activo', 'Rescate', null], ['PT2', '80002', 'Ana', 'Gómez', '8-8-2', null, 34.5, 'Activo', null, null],
      ['PT3', null, null, null, null, null, null, null, 'CHAPA', 'En reparación'], ['PT4', null, null, null, null, null, null, null, 'REVISADO PENDIENTE', 'Falta el documento']]));
    expect(r.statusCode).toBe(201); expect(r.json().kind).toBe('directory'); id = r.json().importId;
    expect(r.json().summary).toMatchObject({ kind: 'directory', drivers: { new: 2 }, units: { new: 4 } });
    expect(Number((await db.su.query(`select count(*) n from public.drivers`)).rows[0].n)).toBe(driversBefore);
    expect(Number((await db.su.query(`select count(*) n from auth.users`)).rows[0].n)).toBe(authBefore);
  });
  it('un ADMIN confirma y aplica: crea conductores, unidades (también sin conductor), tarifas y condiciones; no crea cuentas de Auth ni pagos', async () => {
    const authBefore = Number((await db.su.query(`select count(*) n from auth.users`)).rows[0].n);
    expect((await post(`/imports/${id}/confirm`, tOps, { approve: 'clean' })).statusCode).toBe(200);
    const ap = await post(`/imports/${id}/apply`, tOps, { validFrom: '2026-03-02' });
    expect(ap.statusCode).toBe(200);
    expect(ap.json()).toMatchObject({ drivers_created: 2, units_without_driver: 2, agreements_set: 3 });
    const u = (await db.su.query(`select code, agreement a, agreement_note m from public.units where code in ('PT1','PT2','PT3','PT4') order by code`)).rows;
    expect(u).toEqual([{ code: 'PT1', a: 'Rescate', m: null }, { code: 'PT2', a: null, m: null }, { code: 'PT3', a: 'CHAPA', m: 'En reparación' }, { code: 'PT4', a: 'REVISADO PENDIENTE', m: 'Falta el documento' }]);   // texto original, sin catálogo
    expect((await db.su.query(`select count(*)::int n from public.assignments a join public.units un on un.id=a.unit_id where un.code in ('PT3','PT4')`)).rows[0].n).toBe(0);
    expect(Number((await db.su.query(`select count(*) n from auth.users`)).rows[0].n)).toBe(authBefore);
    expect((await app.inject({ method: 'POST', url: `/api/v1/imports/${id}/apply`, headers: h(tOps), payload: {} })).json().error).toBe('import_already_applied');
  });
  it('una actualización: cambia nombre y estado, no pisa la tarifa salvo que se pida, y SUPERVISOR no puede importar', async () => {
    expect((await up(await directoryBook([['PT1', '80001', 'Luis Alberto', 'Pérez', '8-8-1', null, 40, 'Suspendido', null, null]]), 'act.xlsx', tSup)).statusCode).toBe(403);
    const r = await up(await directoryBook([['PT1', '80001', 'Luis Alberto', 'Pérez', '8-8-1', null, 40, 'Suspendido', null, null]]), 'act.xlsx');
    expect(r.json().summary).toMatchObject({ drivers: { existing: 1, toUpdate: 1 }, rates: { differs: 1 } });
    const rid = r.json().importId;
    await post(`/imports/${rid}/confirm`, tAdmin, { approve: 'clean' });
    expect((await post(`/imports/${rid}/apply`, tAdmin, { applyRateChanges: false })).json()).toMatchObject({ drivers_updated: 1, rates_changed: 0 });
    expect((await db.su.query(`select first_name, status from public.drivers where operator_code='80001'`)).rows[0]).toEqual({ first_name: 'Luis Alberto', status: 'suspended' });
    expect((await db.su.query(`select r.daily_amount_cents::int d from public.rates r join public.assignments a on a.id=r.assignment_id join public.drivers dr on dr.id=a.driver_id where dr.operator_code='80001' and r.valid_to is null`)).rows[0].d).toBe(3600);
  });
  it('apply con el tipo equivocado y exportación de unidades con condición', async () => {
    const x = await get('/exports/units.xlsx', tAdmin);
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(x.rawPayload as unknown as ArrayBuffer);
    const ws = wb.getWorksheet('Unidades')!; const header = (ws.getRow(2).values as string[]).slice(1);
    expect(header).toEqual(expect.arrayContaining(['Acuerdo / condición especial', 'Observación']));
    const rows: string[][] = []; ws.eachRow((r, i) => { if (i > 2) rows.push((r.values as string[]).slice(1)); });
    const pt3 = rows.find((r) => r[0] === 'PT3')!; expect(pt3[header.indexOf('Acuerdo / condición especial')]).toBe('CHAPA');
    expect(pt3[header.indexOf('Observación')]).toBe('En reparación');
  });
});

describe('importación con consentimiento de WhatsApp (cobranza)', () => {
  const up = async (buf: Buffer, name: string, t = tAdmin) => { const m = multipart(buf, name); return app.inject({ method: 'POST', url: '/api/v1/imports/excel', headers: { ...h(t), ...m.headers }, payload: m.payload }); };
  const book = async (rows: Array<(string | number | null)[]>) => {
    const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Plantilla');
    ws.addRow(['Unidad', 'Código de operador', 'Nombre', 'Apellido', 'Cédula', 'WhatsApp', 'Tarifa diaria', 'Estado', 'Consentimiento cobranza WhatsApp', 'Origen del consentimiento']);
    rows.forEach((r) => ws.addRow(r)); return Buffer.from(await wb.xlsx.writeBuffer());
  };
  it('la plantilla descargable trae las dos columnas nuevas', async () => {
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load((await get('/imports/template.xlsx', tAdmin)).rawPayload as unknown as ArrayBuffer);
    expect((wb.getWorksheet('Plantilla')!.getRow(1).values as string[]).slice(1)).toEqual(expect.arrayContaining(['Consentimiento cobranza WhatsApp', 'Origen del consentimiento']));
  });
  it('la vista previa trae summary.consents y las advertencias; aplicar registra solo lo válido con quien aplica', async () => {
    const r = await up(await book([
      ['CN1', '90001', 'Rosa', 'A', '9-9-1', '6000-9001', 30, 'Activo', 'SÍ', 'formulario firmado'],
      ['CN2', '90002', 'Raúl', 'B', '9-9-2', '6000-9002', 30, 'Activo', 'SI', null],
      ['CN3', '90003', 'Rita', 'C', '9-9-3', null, 30, 'Activo', 'SI', 'formulario firmado'],
      ['CN4', '90004', 'Rafa', 'D', '9-9-4', '6000-9004', 30, 'Activo', null, null],
    ]), 'consent.xlsx');
    expect(r.statusCode).toBe(201);
    expect(r.json().summary.consents).toEqual({ toGrant: 1, toWithdraw: 0, unchanged: 0, ignored: { total: 2, missingOrigin: 1, missingPhone: 1, invalidValue: 0, noDriver: 0 } });
    const id = r.json().importId;
    expect((await db.su.query(`select count(*)::int n from public.drivers where operator_code like '9000%' and whatsapp_consent`)).rows[0].n).toBe(0);
    const rows = (await get(`/imports/${id}/rows`, tAdmin)).json() as { operator_code: string; warnings: string[]; changes: { consent?: { action: string; reason?: string } } }[];
    expect(rows.find((x) => x.operator_code === '90002')!.warnings).toContain('consent_ignored:missing_origin');
    expect(rows.find((x) => x.operator_code === '90001')!.changes.consent).toMatchObject({ action: 'grant' });
    await post(`/imports/${id}/confirm`, tOps, { approve: 'clean' });
    expect((await post(`/imports/${id}/apply`, tOps, { validFrom: '2026-03-02' })).json()).toMatchObject({ drivers_created: 4, consents_granted: 1, consents_withdrawn: 0 });
    const c = (await db.su.query(`select d.operator_code op, c.source, c.evidence, c.recorded_by from public.driver_consents c join public.drivers d on d.id=c.driver_id where d.operator_code like '9000%'`)).rows;
    expect(c).toEqual([{ op: '90001', source: 'import_declaration', evidence: 'formulario firmado | archivo: consent.xlsx', recorded_by: db.opsAdmin }]);
    expect((await db.su.query(`select operator_code from public.drivers where whatsapp_consent and operator_code like '9000%'`)).rows).toEqual([{ operator_code: '90001' }]);
  });
  it('un «NO» posterior retira el consentimiento y el supervisor heredado no puede importar', async () => {
    const f = await book([['CN1', '90001', null, null, '9-9-1', null, null, null, 'NO', 'retiró por chat']]);
    expect((await up(f, 'retiro.xlsx', tSup)).statusCode).toBe(403);
    const r = await up(f, 'retiro.xlsx');
    expect(r.json().summary.consents).toMatchObject({ toWithdraw: 1, toGrant: 0 });
    await post(`/imports/${r.json().importId}/confirm`, tAdmin, { approve: 'clean' });
    expect((await post(`/imports/${r.json().importId}/apply`, tAdmin, {})).json()).toMatchObject({ consents_withdrawn: 1 });
    expect((await db.su.query(`select whatsapp_consent c from public.drivers where operator_code='90001'`)).rows[0].c).toBe(false);
    expect((await db.su.query(`select granted, source from public.driver_consents d join public.drivers x on x.id=d.driver_id where x.operator_code='90001' order by recorded_at, d.id`)).rows).toEqual([{ granted: true, source: 'import_declaration' }, { granted: false, source: 'withdrawal' }]);
  });
});

describe('exportaciones .xlsx', () => {
  const load = async (res: { rawPayload: Buffer }) => { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(res.rawPayload as unknown as ArrayBuffer); return wb; };
  it('exporta la semana con estructura familiar y cifras separadas', async () => {
    const r = await get(`/exports/weekly.xlsx?weekStart=${MON}`, tAdmin);
    expect(r.statusCode).toBe(200); expect(r.headers['content-disposition']).toContain('vip-cobranza-semanal-2026-03-02.xlsx');
    const ws = (await load(r)).getWorksheet('Semana')!; const header = (ws.getRow(3).values as string[]).slice(1);
    for (const col of ['Unidad', 'Operador', 'Cuenta semanal', 'Total entregado (bruto)', 'Comisión Yappy/Punto Pago', 'Pago neto recibido', 'Pendiente', 'Crédito a favor']) expect(header).toContain(col);
    expect(header.filter((x) => /^(Lunes|Martes|Miércoles|Jueves|Viernes|Sábado|Domingo)/.test(x))).toHaveLength(7);
  });
  it('exporta día, método, deudas, créditos, directorio y movimientos; usuario no autorizado → 403; sin token → 401', async () => {
    const q = (u: string) => get(`/exports/${u}`, tAdmin);
    expect((await load(await q(`day.xlsx?date=${MON}`))).getWorksheet('Día')).toBeTruthy();
    expect((await load(await q(`payments-by-method.xlsx?from=${MON}&to=2026-03-08`))).getWorksheet('Por método')).toBeTruthy();
    expect((await load(await q('pending.xlsx'))).getWorksheet('Deudas')).toBeTruthy();
    expect((await load(await q('credits.xlsx'))).getWorksheet('Créditos')).toBeTruthy();
    expect((await load(await q('directory.xlsx'))).worksheets[0]!.rowCount).toBeGreaterThan(3);
    expect((await load(await q(`movements.xlsx?from=${MON}&to=${MON}`))).getWorksheet('Movimientos')).toBeTruthy();
    expect((await get('/exports/directory.xlsx', tOut)).statusCode).toBe(403);
    expect((await app.inject('/api/v1/exports/directory.xlsx')).statusCode).toBe(401);
  });
});

describe('roles por HTTP (SUPER_ADMIN, ADMIN, SUPERVISOR)', () => {
  const st = async (m: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, t: string, payload?: object) =>
    (await app.inject({ method: m, url: `/api/v1${url}`, headers: h(t), payload })).statusCode;
  it('SUPERVISOR: lee; el registro de pagos está deshabilitado (410); no puede operar', async () => {
    resetRoleCache();
    expect(await st('GET', '/dashboard', tSup)).toBe(200);
    expect(await st('GET', '/payment-methods', tSup)).toBe(200);
    expect(await st('GET', `/weekly-collection?weekStart=${MON}`, tSup)).toBe(200);
    expect(await st('GET', '/exports/drivers.xlsx', tSup)).toBe(200);
    expect(await st('POST', '/payments', tSup, { assignmentId: a.assignment, methodCode: 'cash', grossCents: 500, idempotencyKey: key() })).toBe(410);
    for (const [m, u, b] of [['POST', '/adjustments', { assignmentId: a.assignment, amountCents: 100, effectiveDate: MON, reason: 'prueba', idempotencyKey: key() }],
      ['POST', '/charges/generate', { date: '2026-03-12' }], ['POST', '/weeks/close', { weekStart: MON }], ['POST', '/whatsapp/session/connect', {}],
      ['POST', '/assignments/start', { driverId: a.driver, unitId: a.unit, validFrom: '2030-01-01' }], ['GET', '/users', undefined]] as const)
      expect(await st(m, u, tSup, b), `${m} ${u}`).toBe(403);
  });
  it('ADMIN: opera pero no gestiona usuarios', async () => {
    resetRoleCache();
    expect(await st('POST', '/charges/generate', tOps, { date: '2026-03-12' })).toBe(410);
    expect(await st('POST', '/adjustments', tOps, { assignmentId: a.assignment, amountCents: 100, effectiveDate: MON, reason: 'ajuste admin', idempotencyKey: key() })).toBe(410);
    expect(await st('GET', '/users', tOps)).toBe(403);
    expect(await st('PUT', '/users', tOps, { email: 'x@y.com', role: 'admin' })).toBe(403);
    expect(await st('POST', '/users/creation-window', tOps, { minutes: 5 })).toBe(403);
  });
  it('SUPER_ADMIN: lista usuarios, cambia roles de cuentas existentes y nunca se queda sin SUPER_ADMIN', async () => {
    resetRoleCache();
    const list = (await get('/users', tAdmin)).json();
    expect(list.map((u: { role: string }) => u.role).sort()).toEqual(['admin', 'super_admin', 'supervisor']);
    expect((await app.inject({ method: 'PUT', url: '/api/v1/users', headers: h(tAdmin), payload: { email: 'outsider@test.local', role: 'supervisor' } })).statusCode).toBeGreaterThanOrEqual(400);   // rol retirado
    expect((await app.inject({ method: 'PUT', url: '/api/v1/users', headers: h(tAdmin), payload: { email: 'outsider@test.local', role: 'admin' } })).json()).toMatchObject({ role: 'admin' });
    expect((await app.inject({ method: 'PUT', url: '/api/v1/users', headers: h(tAdmin), payload: { email: 'nadie@test.local', role: 'admin' } })).json().error).toBe('user_not_found');
    expect((await app.inject({ method: 'PUT', url: '/api/v1/users', headers: h(tAdmin), payload: { email: 'admin@test.local', role: 'admin' } })).json().error).toBe('last_super_admin');
    expect(await st('DELETE', `/users/${db.outsider}`, tAdmin)).toBe(204);
    expect(await st('POST', '/users/creation-window', tAdmin, { minutes: 5 })).toBe(200);
    expect(await st('POST', '/users/creation-window', tAdmin, { minutes: 0 })).toBe(200);
    expect(await st('POST', '/users/creation-window', tAdmin, { minutes: 999 })).toBe(400);
    expect(Number((await db.su.query(`select count(*) n from auth.users`)).rows[0].n)).toBe(4);       // ninguna cuenta de Auth se creó
  });
  it('exporta conductores, unidades y asignaciones (.xlsx) con los datos reales', async () => {
    for (const [u, sheet] of [['drivers', 'Conductores'], ['units', 'Unidades'], ['assignments', 'Asignaciones']] as const) {
      const r = await get(`/exports/${u}.xlsx`, tAdmin);
      expect(r.statusCode).toBe(200);
      const wb = new ExcelJS.Workbook(); await wb.xlsx.load(r.rawPayload as unknown as ArrayBuffer);
      expect(wb.getWorksheet(sheet)!.rowCount).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('errores internos', () => {
  it('no filtran detalles de la base de datos', async () => {
    const broken = await buildApp(loadConfig({ SUPABASE_JWT_SECRET: SECRET }), { db: { asUser: async () => { throw new Error('connection to server at "10.0.0.5" password=secret'); }, close: async () => {} } });
    const r = await broken.inject({ method: 'GET', url: '/api/v1/dashboard', headers: h(tAdmin) });
    expect([r.statusCode, r.body]).toEqual([500, '{"error":"internal_error"}']);
    await broken.close();
  });
});

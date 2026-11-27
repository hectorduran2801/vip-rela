import { SignJWT } from 'jose';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newDb, type Db } from '@vip/db/testing';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createDatabase } from './db.js';

const SECRET = 'z'.repeat(40);
const sign = (sub: string) => new SignJWT({ role: 'authenticated', email: `${sub}@t.local` }).setProtectedHeader({ alg: 'HS256' })
  .setSubject(sub).setAudience('authenticated').setIssuedAt().setExpirationTime('5m').sign(new TextEncoder().encode(SECRET));
let db: Db, pool: pg.Pool, a: FastifyInstance, tAdmin: string, tOut: string;
beforeAll(async () => {
  db = await newDb(); pool = new pg.Pool({ ...db.connection, max: 6 });
  a = await buildApp(loadConfig({ SUPABASE_JWT_SECRET: SECRET, RATE_LIMIT_PER_MINUTE: '100000', WHATSAPP_DRY_RUN: 'false' }), { db: createDatabase(pool) });
  tAdmin = await sign(db.opsAdmin); tOut = await sign(db.outsider);
  await db.su.query(`insert into public.excel_imports(file_name, file_sha256, status, source_kind, created_by, applied_at) values ('DATOS.xlsx', 'sha-last-sync', 'applied', 'collection_flat', $1, now())`, [db.opsAdmin]);
  await db.su.query(`insert into public.whatsapp_sessions(label, status, desired_state) select 'Principal', 'connected', 'connected' where not exists (select 1 from public.whatsapp_sessions)`);
  await db.su.query(`update public.whatsapp_sessions set status = 'connected'`);
});
afterAll(async () => { await a.close(); await pool.end(); await db.close(); });
const call = (method: 'GET' | 'POST' | 'PATCH', url: string, t: string, payload?: object) => a.inject({ method, url: `/api/v1${url}`, headers: { authorization: `Bearer ${t}` }, payload });

describe('cobranza: tabla y mensajes por plantilla', () => {
  it('tabla con WhatsApp; vista previa con texto real; envío por plantilla y aviso de «ya enviado»', async () => {
    const x = await db.driverWithAssignment({ code: 'API1', unit: 'APIU1', dailyCents: 3600 });
    await db.su.query(`update public.drivers set phone_e164='+50761112222', first_name='Ana', last_name='Pérez' where id=$1`, [x.driver]);
    const t = (await db.su.query(`insert into public.message_templates(name, body) values ('Aviso', 'Hola {{nombre}}, unidad {{unidad}}') returning id`)).rows[0].id;
    const board = await call('GET', '/collection/board?weekStart=2026-11-23', tAdmin);
    expect(board.statusCode).toBe(200);
    const row = board.json().find((r: any) => r.assignmentId === x.assignment);
    expect(row).toMatchObject({ unitCode: 'APIU1', phone: '+50761112222', messagesToday: [], ended: false });
    const pv = await call('POST', '/collection/messages/preview', tAdmin, { templateId: t, assignmentIds: [x.assignment] });
    expect(pv.json()).toMatchObject({ whatsappConnected: true, lastSync: { fileName: 'DATOS.xlsx' } });
    expect(pv.json().items[0]).toMatchObject({ text: 'Hola Ana, unidad APIU1', unresolved: [], reason: null, phone: '+50761112222', unitCode: 'APIU1' });
    const s1 = await call('POST', '/collection/messages/send', tAdmin, { templateId: t, assignmentIds: [x.assignment], batchKey: 'batch-0001' });
    expect(s1.json()).toMatchObject({ sent: 1, failed: 0 });
    const again = await call('POST', '/collection/messages/send', tAdmin, { templateId: t, assignmentIds: [x.assignment], batchKey: 'batch-0002' });
    expect(again.json().results[0]).toMatchObject({ ok: false, error: 'already_sent_today' });
    const ok = await call('POST', '/collection/messages/send', tAdmin, { templateId: t, assignmentIds: [x.assignment], batchKey: 'batch-0003', repeat: true });
    expect(ok.json().sent).toBe(1);
    const after = (await call('GET', '/collection/board?weekStart=2026-11-23', tAdmin)).json().find((r: any) => r.assignmentId === x.assignment);
    expect(after.messagesToday).toHaveLength(2);                                   // TODOS los mensajes de hoy, no solo el último
    expect(after.messagesToday.map((m: any) => m.template)).toEqual(['Aviso', 'Aviso']);
    expect(after.messagesToday[0]).toMatchObject({ status: 'prepared', body: 'Hola Ana, unidad APIU1' });
    const hist = (await call('GET', '/collection/messages', tAdmin)).json();
    expect(hist[0]).toMatchObject({ template: 'Aviso', unitCode: 'APIU1', importFile: 'DATOS.xlsx', body: 'Hola Ana, unidad APIU1', status: 'prepared' });
    expect(hist[0].variables).toMatchObject({ unidad: 'APIU1' });
    await db.su.query(`update public.whatsapp_sessions set status = 'disconnected'`);
    const off = await call('POST', '/collection/messages/send', tAdmin, { templateId: t, assignmentIds: [x.assignment], batchKey: 'batch-0004', repeat: true });
    expect(off.statusCode).toBe(409); expect(off.json().error).toBe('whatsapp_disconnected');
    await db.su.query(`update public.whatsapp_sessions set status = 'connected'`);
    // jornada nueva: lo de AYER no cuenta (desaparece de la tabla y del historial operativo) aunque siga en la base
    await db.su.query(`update public.whatsapp_test_messages set created_at = created_at - interval '1 day' where kind='collection_message'`);
    expect((await call('GET', '/collection/board?weekStart=2026-11-23', tAdmin)).json().find((r: any) => r.assignmentId === x.assignment).messagesToday).toEqual([]);
    expect((await call('GET', '/collection/messages', tAdmin)).json()).toEqual([]);
    expect((await call('GET', '/collection/batches', tAdmin)).json()).toEqual([]);
  });
  it('sin rol no puede ver ni enviar', async () => {
    expect((await call('GET', '/collection/board?weekStart=2026-11-23', tOut)).statusCode).toBe(403);
    expect((await call('POST', '/collection/messages/send', tOut, { templateId: '7d158f1f-3ee7-4326-915a-70d5b133924b', assignmentIds: ['7d158f1f-3ee7-4326-915a-70d5b133924b'], batchKey: 'batch-0009' })).statusCode).toBe(403);
  });
  it('corrige una fila del archivo antes de guardar (PATCH) y normaliza el WhatsApp; sin rol no puede', async () => {
    const imp = (await db.su.query(`insert into public.excel_imports(file_name, file_sha256, status, source_kind, created_by) values ('t.xlsx', 'sha-patch-1', 'confirmed', 'collection_flat', $1) returning id`, [db.opsAdmin])).rows[0].id;
    const blk = (await db.su.query(`insert into public.import_blocks(import_id, block_index, start_column, header_variant) values ($1, 0, 'A', 'flat') returning id`, [imp])).rows[0].id;
    const row = (await db.su.query(`insert into public.import_rows(block_id, source_row, unit_code, daily_rate_cents) values ($1, 4, 'P9', 0) returning id`, [blk])).rows[0].id;
    expect((await call('PATCH', `/imports/${imp}/rows/${row}`, tOut, { dailyRateCents: 3600 })).statusCode).toBe(403);
    const r = await call('PATCH', `/imports/${imp}/rows/${row}`, tAdmin, { dailyRateCents: 3600, phone: '6000-1234', dayAmountsCents: [null, 1500, null, null, null, null, null] });
    expect(r.statusCode).toBe(204);
    const x = (await db.su.query(`select daily_rate_cents, phone_e164, raw_phone, day_amounts_cents from public.import_rows where id=$1`, [row])).rows[0];
    expect(x).toMatchObject({ phone_e164: '+50760001234', raw_phone: '6000-1234' });
    expect(Number(x.daily_rate_cents)).toBe(3600); expect(x.day_amounts_cents).toEqual([null, '1500', null, null, null, null, null]);
    expect((await call('PATCH', `/imports/${imp}/rows/${row}`, tAdmin, {})).statusCode).toBe(400);
  });
});

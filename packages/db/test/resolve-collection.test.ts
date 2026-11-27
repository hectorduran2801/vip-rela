import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newDb, type Db } from './harness.js';

/** 0057: la administradora resuelve SUS mensajes de cobranza sin confirmar; ni otra cuenta ni un supervisor. */
let db: Db; let other: string; let driver: string; let n = 0;
const MAIN = '00000000-0000-4000-8000-000000000001';
const message = async () => (await db.su.query(`insert into public.whatsapp_test_messages(kind, recipient_phone, body, requested_mode, authorized_by, idempotency_key, driver_id, status, account_id)
  values ('collection_message','+50760001234','x','auto',$1,$2,$3,'unconfirmed',$4) returning id`, [db.admin, `r-${++n}-${Date.now()}-abcdefgh`, driver, MAIN])).rows[0].id as string;
const resolve = (who: string, id: string, arrived = false) => db.as(who, (q) => q.one(`select * from public.resolve_test_message($1,$2,null)`, [id, arrived]));
const status = async (id: string) => (await db.su.query(`select status from public.whatsapp_test_messages where id=$1`, [id])).rows[0].status;

beforeAll(async () => {
  db = await newDb();
  other = db.outsider;
  await db.su.query(`insert into public.app_users(user_id, role, created_by) values ($1,'admin',$2)`, [other, db.admin]);
  driver = (await db.driverWithAssignment({ code: 'R1', unit: 'RU1', from: '2026-11-01' })).driver;
}, 120_000);
afterAll(async () => { await db.close(); });

describe('resolver mensajes de cobranza sin confirmar', () => {
  it('la administradora de la cuenta: «no llegó» queda fallido (se puede reintentar) y «sí llegó» enviado', async () => {
    const a = await message(), b = await message();
    await resolve(db.opsAdmin, a, false); await resolve(db.opsAdmin, b, true);
    expect([await status(a), await status(b)]).toEqual(['failed', 'sent']);
  });
  it('otra cuenta y el supervisor no pueden', async () => {
    const m = await message();
    await expect(resolve(other, m)).rejects.toThrow();
    await expect(resolve(db.supervisor, m)).rejects.toThrow();
    expect(await status(m)).toBe('unconfirmed');
  });
});

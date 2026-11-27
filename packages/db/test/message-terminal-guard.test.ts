import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newDb, type Db } from './harness.js';

describe('0034 · un mensaje terminado no vuelve a ser enviable', () => {
  let db: Db; let did: string;
  const add = async (status: string) => (await db.su.query(
    `insert into public.whatsapp_test_messages(kind, recipient_phone, body, requested_mode, status, driver_id, authorized_by, idempotency_key) values ('collection_message','+50761230000','x','auto',$1,$2,$3,$4) returning id`, [status, did, db.admin, `mg-${Math.random().toString(36).slice(2)}-key-0001`])).rows[0].id as string;
  beforeAll(async () => {
    db = await newDb();
    did = (await db.driverWithAssignment({ code: 'MG1', unit: 'MG-U1', phone: '+50761230000' })).driver;
  }, 120_000);
  afterAll(async () => { await db.close(); });

  it('«simulated» es definitivo: ningún UPDATE (ni siquiera del dueño) lo devuelve a prepared/processing/sent', async () => {
    const id = await add('simulated');
    for (const to of ['prepared', 'processing', 'sent', 'delivered']) {
      expect(await db.su.query(`update public.whatsapp_test_messages set status=$2 where id=$1`, [id, to]).then(() => 'permitido', (e) => e.message), to).toMatch(/simulated_message_is_final/);
    }
    expect((await db.su.query(`select status from public.whatsapp_test_messages where id=$1`, [id])).rows[0].status).toBe('simulated');
    expect(await db.asService((q) => q.fails(`update public.whatsapp_test_messages set status='prepared' where id='${id}'`))).toMatch(/simulated_message_is_final/);
  });
  it('un mensaje enviado, entregado, fallido o cancelado no vuelve a la cola; los estados válidos siguen funcionando', async () => {
    for (const st of ['sent', 'delivered', 'failed', 'cancelled']) {
      const id = await add(st);
      for (const to of ['prepared', 'processing']) expect(await db.su.query(`update public.whatsapp_test_messages set status=$2 where id=$1`, [id, to]).then(() => 'ok', (e) => e.message), `${st}→${to}`).toMatch(/finished_message_cannot_reopen/);
    }
    const p = await add('prepared');
    await db.su.query(`update public.whatsapp_test_messages set status='processing' where id=$1`, [p]);
    await db.su.query(`update public.whatsapp_test_messages set status='simulated' where id=$1`, [p]);
    expect((await db.su.query(`select status from public.whatsapp_test_messages where id=$1`, [p])).rows[0].status).toBe('simulated');
  });
  it('el worker no reclama un mensaje simulado (la cola solo toma «prepared»)', async () => {
    await add('simulated');
    const r = await db.asService((q) => q.rows(`select (m).id from public.claim_test_message() m`));
    expect(r[0]?.id ?? null).toBeNull();
  });
});

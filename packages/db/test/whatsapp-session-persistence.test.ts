import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newDb, type Db } from './harness.js';

describe('0033 · persistencia y cierre de la sesión de WhatsApp', () => {
  let db: Db; let sid: string;
  beforeAll(async () => { db = await newDb(); sid = (await db.su.query(`select id from public.whatsapp_sessions`)).rows[0].id; }, 120_000);
  afterAll(async () => { await db.close(); });

  it('solo ADMIN+ puede pedir «cerrar sesión»: marca la solicitud, deja desired_state en desconectado y audita', async () => {
    expect(await db.as(db.supervisor, (q) => q.fails(`select public.request_whatsapp_logout()`))).toMatch(/permission|forbidden|admin|denied/i);
    expect(await db.asAnon((q) => q.fails(`select public.request_whatsapp_logout()`))).toMatch(/permission denied/);
    await db.su.query(`update public.whatsapp_sessions set desired_state='connected'`);
    await db.as(db.opsAdmin, (q) => q.rows(`select public.request_whatsapp_logout()`));
    const r = (await db.su.query(`select desired_state, logout_requested_at from public.whatsapp_sessions`)).rows[0];
    expect(r.desired_state).toBe('disconnected'); expect(r.logout_requested_at).not.toBeNull();
    expect((await db.su.query(`select count(*)::int n from public.audit_logs where action='request_whatsapp_logout'`)).rows[0].n).toBe(1);
  });

  it('el cliente no puede escribir ni leer los secretos, el lease ni las marcas de persistencia', async () => {
    await db.su.query(`insert into public.whatsapp_session_secrets(session_id, encrypted_session) values ($1,'\\xdeadbeef') on conflict do nothing`, [sid]);
    for (const who of [db.admin, db.opsAdmin, db.supervisor]) {
      expect(await db.as(who, (q) => q.fails(`select encrypted_session from public.whatsapp_session_secrets`))).toMatch(/permission denied/);
      expect(await db.as(who, (q) => q.fails(`delete from public.whatsapp_session_secrets`))).toMatch(/permission denied/);
      for (const col of ['session_persisted = true', `lease_owner = 'x'`, 'logout_requested_at = now()', 'status = \'connected\'']) {
        expect(await db.as(who, (q) => q.fails(`update public.whatsapp_sessions set ${col}`)), col).toMatch(/permission denied/);
      }
    }
  });

  it('cerrar sesión no toca conductores, unidades, plantillas, pagos ni saldos (son tablas independientes de la sesión)', async () => {
    const fk = (await db.su.query(`select count(*)::int n from pg_constraint c join pg_class t on t.oid=c.confrelid where t.relname='whatsapp_sessions' and c.contype='f'`)).rows[0].n;
    expect(fk).toBe(1);                                                    // solo whatsapp_session_secrets depende de la sesión
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newDb, type Db } from './harness.js';

/** Importaciones simultáneas, con envíos y con la actualización diaria: sin duplicados, sin bloqueos largos y con el resumen coherente. */
let db: Db; let week: string; let other: string; let accB: string;
const MAIN = '00000000-0000-4000-8000-000000000001'; const N = 60;
beforeAll(async () => {
  db = await newDb();
  week = (await db.su.query(`select app_private.week_start_of((now() at time zone app_private.tz())::date)::text d`)).rows[0].d;
  other = db.outsider;
  await db.su.query(`insert into public.app_users(user_id, role, created_by) values ($1,'admin',$2)`, [other, db.admin]);
  accB = (await db.su.query(`select account_id a from public.app_users where user_id=$1`, [other])).rows[0].a;
}, 120_000);
afterAll(async () => { await db.close(); });

let sha = 0;
const stage = async (account: string, prefix: string, paid: number) => {
  const imp = (await db.su.query(`insert into public.excel_imports(file_name, file_sha256, status, source_kind, created_by, account_id) values ('c.xlsx',$1,'confirmed','collection_flat',$2,$3) returning id`, [`cc-${++sha}`, db.admin, account])).rows[0].id;
  const blk = (await db.su.query(`insert into public.import_blocks(import_id, block_index, start_column, header_variant, account_id) values ($1,1,'A','PLANO',$2) returning id`, [imp, account])).rows[0].id;
  await db.su.query(`insert into public.import_rows(block_id, source_row, unit_code, operator_code, full_name, daily_rate_cents, raw_saldo, phone_e164, day_amounts_cents, account_id)
    select $1, g+2, $3||g, $3||'OP'||g, 'PERSONA '||g, 3400, '100', '+507'||(62000000+g), array[$4::bigint,null,null,null,null,null,null], $5 from generate_series(1,$2) g`, [blk, N, prefix, paid, account]);
  return imp;
};
const apply = (who: string, imp: string) => db.as(who, (q) => q.one(`select public.apply_collection_sync($1,$2::date,null,false) r`, [imp, week]));
const check = async (account: string, prefix: string, paid: number) => {
  const r = (await db.su.query(`select (select count(*) from public.units where account_id=$1 and code like $2)::int u, (select count(*) from public.assignments where account_id=$1 and valid_to is null)::int a,
    (select count(*) from public.payments where account_id=$1 and voided_at is null)::int p, (select coalesce(sum(net_cents),0) from public.payments where account_id=$1 and voided_at is null)::int n`, [account, prefix + '%'])).rows[0];
  expect(r).toEqual({ u: N, a: N, p: N, n: N * paid });
  const dup = (await db.su.query(`select count(*)::int d from (select assignment_id, pay_date from public.excel_payment_days where account_id=$1 group by 1,2 having count(*)>1) x`, [account])).rows[0].d;
  expect(dup).toBe(0);
};
const summaryMatches = async (who: string, account: string) => {
  const s = (await db.as(who, (q) => q.rows(`select public.collection_summary_rows($1::date) d`, [week]))).map((r: any) => r.d);
  const fresh = (await db.su.query(`select data from app_private.collection_rows($1,$2::date) order by unit_code`, [account, week])).rows.map((r) => r.data);
  expect(s).toEqual(fresh);
};
const timed = async (fn: () => Promise<unknown>) => { const t = Date.now(); await fn(); return Date.now() - t; };

describe('concurrencia', () => {
  it('dos importaciones simultáneas de la misma cuenta (mismo contenido): una detrás de otra, sin duplicados', async () => {
    const a = await stage(MAIN, 'CA-', 1000), b = await stage(MAIN, 'CA-', 1000);
    const ms = await timed(async () => { const r = await Promise.allSettled([apply(db.opsAdmin, a), apply(db.opsAdmin, b)]); expect(r.map((x) => x.status)).toEqual(['fulfilled', 'fulfilled']); });
    await check(MAIN, 'CA-', 1000); await summaryMatches(db.opsAdmin, MAIN); expect(ms).toBeLessThan(30_000);
  });
  it('dos importaciones simultáneas con importes distintos: queda una corrección completa, nunca mezcla ni doble pago', async () => {
    const a = await stage(MAIN, 'CA-', 1100), b = await stage(MAIN, 'CA-', 1200);
    const r = await Promise.allSettled([apply(db.opsAdmin, a), apply(db.opsAdmin, b)]);
    expect(r.filter((x) => x.status === 'fulfilled').length).toBeGreaterThanOrEqual(1);
    const n = (await db.su.query(`select coalesce(sum(net_cents),0)::int n, count(*)::int c from public.payments where account_id=$1 and voided_at is null`, [MAIN])).rows[0];
    expect(n.c).toBe(N); expect([N * 1100, N * 1200]).toContain(n.n); await summaryMatches(db.opsAdmin, MAIN);
  });
  it('cuentas distintas a la vez: cada una con sus datos', async () => {
    const a = await stage(MAIN, 'CA-', 1300), b = await stage(accB, 'CB-', 2000);
    const r = await Promise.allSettled([apply(db.opsAdmin, a), apply(other, b)]);
    expect(r.map((x) => x.status)).toEqual(['fulfilled', 'fulfilled']);
    await check(MAIN, 'CA-', 1300); await check(accB, 'CB-', 2000); await summaryMatches(db.opsAdmin, MAIN); await summaryMatches(other, accB);
  });
  it('importar mientras se crean y procesan mensajes: no se pierde ni se duplica nada', async () => {
    const tpl = (await db.su.query(`insert into public.message_templates(name, body) values ('CC','Hola {{nombre}} {{saldo_total}}') returning id`)).rows[0].id;
    const ids = (await db.su.query(`select id from public.assignments where account_id=$1 and valid_to is null order by id limit 20`, [MAIN])).rows.map((x) => x.id);
    const imp = await stage(MAIN, 'CA-', 1400);
    const send = async () => { for (const id of ids) await db.as(db.opsAdmin, (q) => q.one(`select * from public.create_collection_message($1,$2,$3,false)`, [id, tpl, `cc-msg-${id}`])); };
    const work = async () => { for (let i = 0; i < 20; i++) { const m = await db.asService((q) => q.one(`select * from public.claim_test_message()`)) as any; if (m?.id) await db.asService((q) => q.one(`select public.complete_test_message($1,'simulated')`, [m.id])); } };
    const r = await Promise.allSettled([apply(db.opsAdmin, imp), send(), work()]);
    expect(r.map((x) => x.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled']);
    expect((await db.su.query(`select count(*)::int n, count(distinct idempotency_key)::int k from public.whatsapp_test_messages where kind='collection_message'`)).rows[0]).toEqual({ n: 20, k: 20 });
    await check(MAIN, 'CA-', 1400); await summaryMatches(db.opsAdmin, MAIN);
  });
  it('importar durante la actualización diaria y lecturas: sin bloqueos largos; el resumen queda al día', async () => {
    await db.su.query(`update public.collection_summary_state set computed_on = computed_on - 1`);
    const imp = await stage(MAIN, 'CA-', 1500);
    const ms = await timed(async () => {
      const r = await Promise.allSettled([apply(db.opsAdmin, imp), db.asService((q) => q.one(`select public.refresh_collection_summaries()`)),
        db.as(db.opsAdmin, (q) => q.rows(`select public.collection_summary_rows($1::date)`, [week])), db.as(db.opsAdmin, (q) => q.rows(`select public.collection_summary_rows($1::date)`, [week]))]);
      expect(r.map((x) => x.status === 'rejected' ? String((x as PromiseRejectedResult).reason?.message) : 'ok')).toEqual(['ok', 'ok', 'ok', 'ok']);
    });
    expect(ms).toBeLessThan(30_000); await check(MAIN, 'CA-', 1500); await summaryMatches(db.opsAdmin, MAIN);
  });
});

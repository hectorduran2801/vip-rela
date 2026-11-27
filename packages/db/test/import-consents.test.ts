import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newDb, type Db } from './harness.js';

let db: Db; let sha = 0; let n = 0;
beforeAll(async () => { db = await newDb(); });
afterAll(async () => { await db.close(); });

type Row = { op: string; unit?: string; first?: string; phone?: string | null; req?: 'grant' | 'withdraw' | null; origin?: string | null };
async function stage(rows: Row[], fileName = 'directorio.xlsx', status = 'confirmed') {
  const imp = (await db.su.query(`insert into public.excel_imports(file_name, file_sha256, status, created_by, source_kind) values ($1,$2,$3,$4,'directory') returning id`, [fileName, `c-${++sha}`, status, db.admin])).rows[0].id;
  const blk = (await db.su.query(`insert into public.import_blocks(import_id, block_index, start_column, header_variant) values ($1,1,'A','plantilla') returning id`, [imp])).rows[0].id;
  let k = 1;
  for (const r of rows) await db.su.query(`insert into public.import_rows(block_id, source_row, unit_code, operator_code, national_id, full_name, first_name, phone_e164, match_status, review_status, consent_request, consent_origin)
    values ($1,$2,$3,$4,$5,$6,$6,$7,'matched','approved',$8,$9)`, [blk, ++k, r.unit ?? '', r.op, `ID-${r.op}`, r.first ?? 'Conductor', r.phone ?? null, r.req ?? null, r.origin ?? null]);
  return imp as string;
}
const apply = (imp: string, uid = db.opsAdmin) => db.as(uid, async (q) => (await q.one(`select public.apply_directory_import($1, '2026-03-02'::date, 'active', false) r`, [imp])).r);
const fresh = async (phone: string | null = '+50769990001', consent = false) => {
  n += 1; const x = await db.driverWithAssignment({ code: `K${n}`, unit: `KU${n}`, dailyCents: 3600, consent, phone: `+5076999${String(2000 + n)}` });
  if (!phone) await db.su.query(`update public.drivers set phone_e164=null where id=$1`, [x.driver]);
  if (consent) await db.su.query(`update public.drivers set whatsapp_consent_source='verbal_admin', whatsapp_consent_at=now() where id=$1`, [x.driver]);
  return { ...x, op: `K${n}` };
};
const drv = async (id: string) => (await db.su.query(`select whatsapp_consent c, whatsapp_consent_source s, promotional_consent p from public.drivers where id=$1`, [id])).rows[0];
const hist = async (id: string) => (await db.su.query(`select purpose, granted, source, evidence, recorded_by from public.driver_consents where driver_id=$1 order by recorded_at, id`, [id])).rows;

describe('apply_directory_import con consentimiento de cobranza', () => {
  it('SI con origen y teléfono: registra import_declaration con evidencia (origen + archivo) y recorded_by = quien aplica', async () => {
    const x = await fresh();
    const r = await apply(await stage([{ op: x.op, req: 'grant', origin: 'formulario firmado' }], 'dir-nov.xlsx'));
    expect(r).toMatchObject({ consents_granted: 1, consents_withdrawn: 0, consents_unchanged: 0, consents_ignored: 0 });
    expect(await drv(x.driver)).toEqual({ c: true, s: 'import_declaration', p: false });                 // promocional NO se toca
    expect(await hist(x.driver)).toEqual([{ purpose: 'collection', granted: true, source: 'import_declaration', evidence: 'formulario firmado | archivo: dir-nov.xlsx', recorded_by: db.opsAdmin }]);
    expect((await db.su.query(`select count(*)::int c from public.audit_logs where action='driver_consent.granted' and entity_id=$1`, [x.driver])).rows[0].c).toBe(1);
  });
  it('SI sin origen (defensa en SQL): ignorado, informado y la fila se aplica igual', async () => {
    const x = await fresh();
    const r = await apply(await stage([{ op: x.op, first: 'Renombrado', req: 'grant', origin: '  ' }]));
    expect(r).toMatchObject({ consents_granted: 0, consents_ignored: 1, drivers_updated: 1 });
    expect(r.issues.map((i: { issue: string }) => i.issue)).toContain('consent_ignored_missing_origin');
    expect((await drv(x.driver)).c).toBe(false); expect(await hist(x.driver)).toEqual([]);
    expect((await db.su.query(`select first_name from public.drivers where id=$1`, [x.driver])).rows[0].first_name).toBe('Renombrado');
  });
  it('SI sin teléfono válido: ignorado; con teléfono traído en la misma fila SÍ consiente (se guarda antes)', async () => {
    const x = await fresh(null);
    const r = await apply(await stage([{ op: x.op, req: 'grant', origin: 'formulario' }]));
    expect(r).toMatchObject({ consents_granted: 0, consents_ignored: 1 });
    expect(r.issues.map((i: { issue: string }) => i.issue)).toContain('consent_ignored_missing_phone');
    expect((await db.su.query(`select applied_note from public.import_rows where operator_code=$1`, [x.op])).rows[0].applied_note).toMatch(/falta teléfono/);
    expect((await drv(x.driver)).c).toBe(false);
    const y = await fresh(null);
    expect(await apply(await stage([{ op: y.op, phone: '+50761112222', req: 'grant', origin: 'formulario' }]))).toMatchObject({ consents_granted: 1 });
    expect((await drv(y.driver)).c).toBe(true);
  });
  it('NO retira, registra historial (source withdrawal) y cancela los envíos pendientes', async () => {
    const x = await fresh('+50769990001', true);
    await db.su.query(`insert into public.notification_jobs(driver_id, kind, local_date, scheduled_for, status) values ($1,'debt_reminder','2026-03-02',now(),'pending'), ($1,'debt_update','2026-03-02',now(),'awaiting_approval'), ($1,'debt_last','2026-03-02',now(),'sent')`, [x.driver]);
    const r = await apply(await stage([{ op: x.op, req: 'withdraw', origin: 'retiró por chat' }], 'retiro.xlsx'));
    expect(r).toMatchObject({ consents_withdrawn: 1, consent_jobs_cancelled: 2 });
    expect(await drv(x.driver)).toEqual({ c: false, s: null, p: false });
    expect((await db.su.query(`select status from public.notification_jobs where driver_id=$1 order by kind`, [x.driver])).rows.map((j) => j.status)).toEqual(['sent', 'cancelled', 'cancelled']);
    expect(await hist(x.driver)).toEqual([{ purpose: 'collection', granted: false, source: 'withdrawal', evidence: 'retiró por chat | archivo: retiro.xlsx', recorded_by: db.opsAdmin }]);
  });
  it('vacío = sin cambio (ni consiente ni retira); NO sobre quien no consentía no cambia nada', async () => {
    const on = await fresh('+50769990001', true); const off = await fresh();
    const r = await apply(await stage([{ op: on.op, first: 'Otro' }, { op: off.op, req: 'withdraw' }]));
    expect(r).toMatchObject({ consents_granted: 0, consents_withdrawn: 0, consents_unchanged: 1 });
    expect((await drv(on.driver)).c).toBe(true); expect((await drv(off.driver)).c).toBe(false);
    expect(await hist(on.driver)).toEqual([]); expect(await hist(off.driver)).toEqual([]);
  });
  it('idempotencia: reimportar el mismo SI en otro archivo no duplica historial; el mismo archivo no se reaplica', async () => {
    const x = await fresh();
    const a = await stage([{ op: x.op, req: 'grant', origin: 'formulario' }]);
    await apply(a);
    const b = await stage([{ op: x.op, req: 'grant', origin: 'formulario' }]);
    expect(await apply(b)).toMatchObject({ consents_granted: 0, consents_unchanged: 1 });
    expect(await hist(x.driver)).toHaveLength(1);
    expect(await db.as(db.opsAdmin, (q) => q.fails(`select public.apply_directory_import($1)`, [a]))).toBe('import_already_applied');
    expect(await hist(x.driver)).toHaveLength(1);
  });
  it('un teléfono sin pedido de consentimiento NUNCA consiente (conductor nuevo y existente)', async () => {
    const x = await fresh();
    const r = await apply(await stage([{ op: x.op, phone: '+50760001111' }, { op: 'NUEVO-1', first: 'Nuevo', phone: '+50760002222' }]));
    expect(r).toMatchObject({ consents_granted: 0, consents_withdrawn: 0, drivers_created: 1 });
    const all = (await db.su.query(`select whatsapp_consent c, whatsapp_consent_source s from public.drivers where operator_code in ($1,'NUEVO-1')`, [x.op])).rows;
    expect(all).toEqual([{ c: false, s: null }, { c: false, s: null }]);
    expect(await hist(x.driver)).toEqual([]);
  });
  it('conductor nuevo con SI + origen + teléfono nace con consentimiento registrado', async () => {
    const r = await apply(await stage([{ op: 'NUEVO-2', first: 'Nuevo', phone: '+50760003333', req: 'grant', origin: 'declaración de la administradora' }]));
    expect(r).toMatchObject({ drivers_created: 1, consents_granted: 1 });
    const d = (await db.su.query(`select id, whatsapp_consent c, whatsapp_consent_source s from public.drivers where operator_code='NUEVO-2'`)).rows[0];
    expect([d.c, d.s]).toEqual([true, 'import_declaration']); expect(await hist(d.id)).toHaveLength(1);
  });
  it('permisos: ADMIN y SUPER_ADMIN aplican; supervisor heredado, usuario sin rol y anon no', async () => {
    const x = await fresh(); const y = await fresh();
    const rows = (op: string) => [{ op, req: 'grant' as const, origin: 'formulario' }];
    expect(await apply(await stage(rows(x.op)), db.admin)).toMatchObject({ consents_granted: 1 });                   // SUPER_ADMIN
    expect((await hist(x.driver))[0]!.recorded_by).toBe(db.admin);
    const imp = await stage(rows(y.op));
    for (const uid of [db.supervisor, db.outsider]) expect(await db.as(uid, (q) => q.fails(`select public.apply_directory_import($1)`, [imp]))).toBe('forbidden');
    expect(await db.asAnon((q) => q.fails(`select public.apply_directory_import($1)`, [imp]))).toMatch(/permission denied/);
    expect(await hist(y.driver)).toEqual([]);
    expect(await apply(imp, db.opsAdmin)).toMatchObject({ consents_granted: 1 });                                       // ADMIN
    expect((await hist(y.driver))[0]!.recorded_by).toBe(db.opsAdmin);
  });
  it('el esquema conserva grants y search_path vacío de la función; las filas de staging no se ven sin rol', async () => {
    const f = (await db.su.query(`select p.proconfig, p.prosecdef, has_function_privilege('anon', p.oid, 'execute') anon, has_function_privilege('authenticated', p.oid, 'execute') auth, has_function_privilege('public', p.oid, 'execute') pub
      from pg_proc p where p.proname='apply_directory_import'`)).rows;
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ prosecdef: true, anon: false, auth: true, pub: false });
    expect(f[0].proconfig).toContain('search_path=""');
    expect(await db.as(db.outsider, (q) => q.rows(`select consent_origin from public.import_rows`))).toEqual([]);
  });
  it('no crea cuentas de Auth ni toca pagos', async () => {
    const c = async (t: string) => Number((await db.su.query(`select count(*) n from ${t}`)).rows[0].n);
    const before = [await c('auth.users'), await c('public.payments'), await c('public.charges')];
    const x = await fresh(); await apply(await stage([{ op: x.op, req: 'grant', origin: 'formulario' }]));
    expect([await c('auth.users'), await c('public.payments'), await c('public.charges')]).toEqual(before);
  });
});

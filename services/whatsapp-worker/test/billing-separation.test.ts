import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newDb, type Db } from './support/harness.js';
import { at, enableSchedules, jobs, makeProcessor, seedDriver } from './support/fixtures.js';

let db: Db;
beforeEach(async () => { db = await newDb(); });
afterEach(async () => { await db.close(); });

const count = async (t: string) => (await db.su.query(`select count(*)::int c from public.${t}`)).rows[0].c as number;
const ensure = (through: string) => db.asService((q) => q.one(`select public.ensure_daily_charges($1::date) r`, [through])).then((x) => x.r);

describe('el worker de WhatsApp NO genera cuotas (las genera el motor de cobranza de la API)', () => {
  it('varios ticks del worker (con y sin sesión) no crean ningún cargo aunque haya asignación y tarifa vigentes', async () => {
    await enableSchedules(db);
    const d = await db.driverWithAssignment({ code: '9', unit: 'U-9', dailyCents: 4000, phone: '+50760000009', consent: true, from: '2026-11-16' });
    const dry = makeProcessor(db, { clock: at('11:05') });
    const noSession = makeProcessor(db, { clock: at('17:05'), dryRun: false });        // OpenWA desconectado
    await dry.proc.tick(); await noSession.proc.tick(); await dry.proc.tick();
    expect(await count('charges')).toBe(0);
    expect(d.assignment).toBeTruthy();
    await Promise.all([dry.workerDb.close(), noSession.workerDb.close()]);
  });

  it('sin cargos generados no se programan recordatorios de deuda; cuando el motor genera, el siguiente tick los programa y envía solo lo exigible', async () => {
    await enableSchedules(db);
    await db.driverWithAssignment({ code: '9', unit: 'U-9', dailyCents: 4000, phone: '+50760000009', consent: true, from: '2026-11-16' });
    const a = makeProcessor(db, { clock: at('11:05') });
    expect((await a.proc.tick()).scheduled).toBe(0);
    expect(await count('notification_jobs')).toBe(0);

    expect((await ensure('2026-11-16')).created).toBe(1);                              // lo hace el motor (API), no el worker
    const b = makeProcessor(db, { clock: at('11:10') });
    const r = await b.proc.tick();
    expect(r.scheduled).toBe(1); expect(r.sent).toBe(1);
    expect((await jobs(db, `kind='debt_first'`))[0].rendered_body).toContain('$40.00');
    expect(await count('charges')).toBe(1);
    await Promise.all([a.workerDb.close(), b.workerDb.close()]);
  });

  it('con el worker apagado las cuotas se siguen generando: ensure es independiente y no envía nada', async () => {
    await seedDriver(db, '3', { chargeCents: null });
    await db.su.query(`insert into public.rates(assignment_id, daily_amount_cents, valid_from) select id, 3600, '2026-11-16' from public.assignments`);
    expect((await ensure('2026-11-17')).created).toBe(2);
    expect((await ensure('2026-11-17')).created).toBe(0);
    expect(await count('notification_jobs')).toBe(0);
  });
});

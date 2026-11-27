import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { inject } from 'vitest';
import { connConfig } from './pg-cluster.js';

/** Una base nueva por archivo de pruebas (clonada de la plantilla con todas las migraciones). */
export async function newDb(opts: { arming?: boolean } = {}) {
  const c = inject('pgCluster');
  const name = `t_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const admin = new pg.Client(connConfig(c, 'postgres'));
  await admin.connect();
  await admin.query(`create database ${name} template vip_template`);
  await admin.end();

  const open = async () => { const cl = new pg.Client(connConfig(c, name)); await cl.connect(); return cl; };
  const su = await open();                         // superusuario: solo para preparar datos de prueba
  const open_clients: pg.Client[] = [su];
  // Las pruebas fijan horas en el pasado mientras armed_at (0025) usa el reloj real: trigger SOLO de pruebas que deja armed_at nulo (comportamiento anterior).
  if (!opts.arming) {
    await su.query(`create function app_private.test_disarm() returns trigger language plpgsql as $$ begin
        if tg_op = 'UPDATE' and new.deactivated_reason = 'config_changed' and old.enabled then new.enabled := true; new.deactivated_reason := null; new.deactivated_at := null; end if;   -- las pruebas antiguas editan horarios activos y esperan que sigan activos
        new.armed_at := null; return new; end $$;
      create trigger zz_test_disarm before insert or update on public.notification_schedules for each row execute function app_private.test_disarm()`);
  }
  // 0029 cierra el registro manual de pagos para `authenticated` (el flujo real los recibe del Excel). Estas pruebas de la cola los usan como preparación de datos:
  // se devuelve el permiso SOLO en la base de prueba.
  await su.query(`do $$ declare f regprocedure; begin
    for f in select p.oid::regprocedure from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('register_payment', 'void_payment', 'create_adjustment', 'close_week', 'generate_daily_charges')
    loop execute format('grant execute on function %s to authenticated', f); end loop; end $$`);
  const claims = (sub: string | null, role: string) => JSON.stringify(sub ? { sub, role } : { role });

  /** Ejecuta `fn` como el usuario autenticado (RLS activa), en su propia transacción. */
  async function as<T>(userId: string, fn: (q: Q) => Promise<T>, client?: pg.Client): Promise<T> {
    const cl = client ?? await open();
    try {
      await cl.query('begin');
      try {
        await cl.query('set local role authenticated');
        await cl.query(`select set_config('request.jwt.claims', $1, true)`, [claims(userId, 'authenticated')]);
        const r = await fn(makeQ(cl));
        await cl.query('commit');
        return r;
      } catch (e) { await cl.query('rollback'); throw e; }
    } finally { if (!client) await cl.end().catch(() => undefined); }
  }
  async function asService<T>(fn: (q: Q) => Promise<T>): Promise<T> {
    const cl = await open();
    try {
      await cl.query('begin');
      try {
        await cl.query('set local role service_role');
        await cl.query(`select set_config('request.jwt.claims', $1, true)`, [claims(null, 'service_role')]);
        const r = await fn(makeQ(cl)); await cl.query('commit'); return r;
      } catch (e) { await cl.query('rollback'); throw e; }
    } finally { await cl.end().catch(() => undefined); }
  }
  async function asAnon<T>(fn: (q: Q) => Promise<T>): Promise<T> {
    const cl = await open();
    try {
      await cl.query('begin');
      try {
        await cl.query('set local role anon');
        const r = await fn(makeQ(cl)); await cl.query('commit'); return r;
      } catch (e) { await cl.query('rollback'); throw e; }
    } finally { await cl.end().catch(() => undefined); }
  }

  async function user(email: string): Promise<string> {
    const r = await su.query(`insert into auth.users(email, raw_user_meta_data) values ($1, '{"full_name":"Prueba"}') returning id`, [email]);
    return r.rows[0].id;
  }
  /** La única administradora autorizada y un usuario autenticado NO autorizado (para probar el aislamiento). */
  const outsider = await user('outsider@test.local');           // se crea ANTES: tras autorizar a la administradora el alta de usuarios se cierra
  const adminId = await user('admin@test.local');
  await su.query(`select public.authorize_admin($1)`, [adminId]);

  async function driverWithAssignment(opts: { code: string; unit: string; dailyCents?: number; phone?: string; consent?: boolean; from?: string; status?: string }) {
    const d = (await su.query(`insert into public.drivers(operator_code, national_id, first_name, last_name, phone_e164, whatsapp_consent, status)
      values ($1,$2,'Conductor',$1,$3,$4,$5) returning id`, [opts.code, `ID-${opts.code}`, opts.phone ?? null, opts.consent ?? false, opts.status ?? 'active'])).rows[0].id;
    const u = (await su.query(`insert into public.units(code) values ($1) returning id`, [opts.unit])).rows[0].id;
    const a = (await su.query(`insert into public.assignments(driver_id, unit_id, valid_from) values ($1,$2,$3) returning id`, [d, u, opts.from ?? '2026-01-01'])).rows[0].id;
    if (opts.dailyCents !== undefined)
      await su.query(`insert into public.rates(assignment_id, daily_amount_cents, valid_from) values ($1,$2,$3)`, [a, opts.dailyCents, opts.from ?? '2026-01-01']);
    return { driver: d as string, unit: u as string, assignment: a as string };
  }

  return {
    connection: connConfig(c, name),
    su, as, asService, asAnon, user, admin: adminId, outsider, driverWithAssignment, open,
    async close() {
      await Promise.all(open_clients.map((c) => c.end().catch(() => undefined)));
      const admin = new pg.Client(connConfig(c, 'postgres'));
      await admin.connect(); await admin.query(`drop database if exists ${name} with (force)`); await admin.end();
    },
  };
}

export interface Q {
  query: pg.Client['query'];
  one: (sql: string, params?: unknown[]) => Promise<any>;
  rows: (sql: string, params?: unknown[]) => Promise<any[]>;
  /** Devuelve el mensaje de error (código de negocio) o null si no falló; usa SAVEPOINT para no abortar la transacción. */
  fails: (sql: string, params?: unknown[]) => Promise<string | null>;
}
function makeQ(cl: pg.Client): Q {
  return {
    query: cl.query.bind(cl) as pg.Client['query'],
    one: async (sql, params) => (await cl.query(sql, params as any[])).rows[0],
    rows: async (sql, params) => (await cl.query(sql, params as any[])).rows,
    fails: async (sql, params) => {
      await cl.query('savepoint sp');
      try { await cl.query(sql, params as any[]); await cl.query('release savepoint sp'); return null; }
      catch (e) { await cl.query('rollback to savepoint sp'); return (e as Error).message; }
    },
  };
}
export type Db = Awaited<ReturnType<typeof newDb>>;

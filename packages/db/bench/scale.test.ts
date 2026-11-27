import { describe, it } from 'vitest';
import { newDb } from '../test/harness.js';

/** Medición (no es regresión): 100/500/1000/5000 unidades. */
const MAIN = '00000000-0000-4000-8000-000000000001';
const ms = async (fn: () => Promise<unknown>) => { const t = performance.now(); await fn(); return Math.round(performance.now() - t); };

describe('escala', () => {
  for (const N of [100, 500, 1000, 5000]) {
    it(`${N} unidades`, async () => {
      const db = await newDb(); const q = (s: string, p: unknown[] = []) => db.su.query(s, p);
      const week = (await q(`select app_private.week_start_of((now() at time zone app_private.tz())::date)::text d`)).rows[0].d;
      await q(`insert into public.payment_methods(code,label) values ('excel','Excel') on conflict (code) do nothing`);
      await q(`insert into public.drivers(operator_code, first_name, last_name, phone_e164, status) select 'S'||g, 'Conductor '||g, '', '+507'||(60000000+g), 'active' from generate_series(1,$1) g`, [N]);
      await q(`insert into public.units(code) select 'SU-'||g from generate_series(1,$1) g`, [N]);
      await q(`insert into public.assignments(driver_id, unit_id, valid_from) select d.id, u.id, '2026-01-01' from public.drivers d join public.units u on substr(u.code,4) = substr(d.operator_code,2)`);
      await q(`insert into public.rates(assignment_id, daily_amount_cents, valid_from) select id, 3400, '2026-01-01' from public.assignments`);
      await q(`insert into public.collection_week_units(week_start, unit_id, unit_code, assignment_id, driver_id, saldo_excel_cents) select $1::date, a.unit_id, 'x', a.id, a.driver_id, 10000 from public.assignments a`, [week]);
      await q(`insert into public.charges(assignment_id, kind, charge_date, amount_cents, week_start) select a.id, 'daily', $1::date + g, 3400, $1::date from public.assignments a, generate_series(0,2) g`, [week]);
      await q(`insert into public.payments(assignment_id, method_id, gross_cents, net_cents, applied_cents, week_start, registered_by, idempotency_key, paid_at)
        select a.id, (select id from public.payment_methods where code='excel'), 3000, 3000, 3000, $1::date, $2, 'sc-'||a.id||'-'||g, ($1::date + g + time '12:00') at time zone 'America/Panama' from public.assignments a, generate_series(0,2) g`, [week, db.admin]);
      await q(`insert into public.excel_payment_days(assignment_id, pay_date, week_start, driver_id, amount_cents, payment_id) select p.assignment_id, (p.paid_at at time zone 'America/Panama')::date, p.week_start, a.driver_id, p.net_cents, p.id from public.payments p join public.assignments a on a.id=p.assignment_id`);
      await q('analyze');
      const bulk = await ms(() => q(`select * from app_private.collection_rows($1,$2::date)`, [MAIN, week]));
      let old: number | string = '—';
      if (N <= 500) { await q('begin'); await q(`select set_config('request.jwt.claims',$1,true)`, [JSON.stringify({ sub: db.opsAdmin, role: 'authenticated' })]); old = await ms(() => q(`select * from app_private.collection_rows_reference($1::date)`, [week])); await q('rollback'); }
      const read = () => db.as(db.opsAdmin, (x) => x.rows(`select public.collection_summary_rows($1::date)`, [week]));
      const full = await ms(read); const cached = await ms(read);
      await q(`update public.assignments set collect_commission=false where id=(select id from public.assignments limit 1)`);
      const one = await ms(read);
      await q(`update public.collection_summary_state set computed_on = computed_on - 1`);
      const daily = await ms(() => db.asService((x) => x.one(`select public.refresh_collection_summaries()`)));
      console.log(`ESCALA N=${N} | anterior ${old} ms | en bloque ${bulk} ms | resumen completo ${full} ms | lectura ${cached} ms | cambio de 1 ${one} ms | actualización diaria ${daily} ms`);
      await db.close();
    }, 600_000);
  }
});

import { describe, expect, it } from 'vitest';
import { newDb } from '../test/harness.js';

/** Creación de mensajes en masa (manual: uno a uno como la API; programado: run_send_schedules). Nada se envía. */
const ms = async (fn: () => Promise<unknown>) => { const t = performance.now(); await fn(); return Math.round(performance.now() - t); };
describe('envíos masivos', () => {
  for (const N of [100, 500]) {
    it(`${N} destinatarios`, async () => {
      const db = await newDb(); const q = (s: string, p: unknown[] = []) => db.su.query(s, p);
      const week = (await q(`select app_private.week_start_of((now() at time zone app_private.tz())::date)::text d`)).rows[0].d;
      await q(`insert into public.drivers(operator_code, first_name, last_name, phone_e164, status) select 'M'||g, 'Persona '||g, '', '+507'||(63000000+g), 'active' from generate_series(1,$1) g`, [N]);
      await q(`insert into public.units(code) select 'MU-'||g from generate_series(1,$1) g`, [N]);
      await q(`insert into public.assignments(driver_id, unit_id, valid_from) select d.id, u.id, '2026-01-01' from public.drivers d join public.units u on substr(u.code,4) = substr(d.operator_code,2)`);
      await q(`insert into public.rates(assignment_id, daily_amount_cents, valid_from) select id, 3400, '2026-01-01' from public.assignments`);
      await q(`insert into public.collection_week_units(week_start, unit_id, unit_code, assignment_id, driver_id, saldo_excel_cents) select $1::date, a.unit_id, 'x', a.id, a.driver_id, 10000 from public.assignments a`, [week]);
      await q(`insert into public.excel_imports(file_name, file_sha256, status, source_kind, created_by, applied_at) values ('m.xlsx','m-sha','applied','collection_flat',$1,now())`, [db.admin]);
      const tpl = (await q(`insert into public.message_templates(name, body) values ('M','Hola {{nombre}}, {{detalle_deuda}} {{saldo_total}}') returning id`)).rows[0].id;
      await q('analyze');
      const ids = (await q(`select id from public.assignments order by id`)).rows.map((x) => x.id);
      const manual = await ms(async () => { for (const id of ids) await db.as(db.opsAdmin, (x) => x.one(`select id from public.create_collection_message($1,$2,$3,false)`, [id, tpl, `man-${id}-key`])); });
      await q('delete from public.whatsapp_test_messages');
      await db.as(db.opsAdmin, (x) => x.one(`select * from public.save_send_schedule(null,'N','00:01'::time,'{1,2,3,4,5,6,7}'::smallint[],$1,'all',true)`, [tpl]));
      const at = (await q(`select (((now() at time zone app_private.tz())::date + time '00:30') at time zone app_private.tz())::text t`)).rows[0].t;
      const sched = await ms(() => db.asService((x) => x.one(`select public.run_send_schedules($1::timestamptz) r`, [at])));
      expect((await q(`select count(*)::int n from public.whatsapp_test_messages`)).rows[0].n).toBe(N);
      console.log(`ENVIO N=${N} | manual (uno a uno) ${manual} ms = ${(manual / N).toFixed(1)} ms/mensaje | programado ${sched} ms = ${(sched / N).toFixed(1)} ms/mensaje`);
      await db.close();
    }, 900_000);
  }
});

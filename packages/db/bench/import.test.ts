import { describe, it } from 'vitest';
import { newDb } from '../test/harness.js';

/** Medición de la importación completa (preview + aplicar) con y sin el resumen. */
const ms = async (fn: () => Promise<unknown>) => { const t = performance.now(); await fn(); return Math.round(performance.now() - t); };
describe('importación', () => {
  for (const N of [100, 500, 1000]) {
    it(`${N} filas`, async () => {
      const out: string[] = [];
      for (const summary of [true]) {
        const db = await newDb(); const q = (s: string, p: unknown[] = []) => db.su.query(s, p);
        if (!summary) await q('drop trigger summary_import on public.excel_imports');
        const week = (await q(`select app_private.week_start_of((now() at time zone app_private.tz())::date)::text d`)).rows[0].d;
        const stage = async (tag: string, paid: number) => {
          const imp = (await q(`insert into public.excel_imports(file_name, file_sha256, status, source_kind, created_by) values ('p.xlsx',$1,'confirmed','collection_flat',$2) returning id`, [tag, db.admin])).rows[0].id;
          const blk = (await q(`insert into public.import_blocks(import_id, block_index, start_column, header_variant) values ($1,1,'A','PLANO') returning id`, [imp])).rows[0].id;
          await q(`insert into public.import_rows(block_id, source_row, unit_code, operator_code, full_name, daily_rate_cents, raw_saldo, phone_e164, day_amounts_cents)
            select $1, g+2, 'IM-'||g, 'IMOP'||g, 'PERSONA '||g, 3400, '100', '+507'||(61000000+g), array[$3::bigint, null, null, null, null, null, null] from generate_series(1,$2) g`, [blk, N, paid]);
          return imp;
        };
        const apply = (imp: string) => db.as(db.opsAdmin, async (x) => { await x.one(`select public.preview_collection_sync($1,$2::date)`, [imp, week]); return x.one(`select public.apply_collection_sync($1,$2::date,null,false)`, [imp, week]); });
        const a = await stage('a', 3000); const first = await ms(() => apply(a));
        const b = await stage('b', 3000); const same = await ms(() => apply(b));
        const c = await stage('c', 3100); const changed = await ms(() => apply(c));
        out.push(`${summary ? 'CON resumen' : 'sin resumen'}: primera ${first} ms, sin cambios ${same} ms, todos los pagos cambiados ${changed} ms`);
        await db.close();
      }
      console.log(`IMPORT N=${N} | ${out.join(' || ')}`);
    }, 900_000);
  }
});

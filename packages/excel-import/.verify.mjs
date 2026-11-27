// Verificación de SOLO LECTURA de la última importación frente a lo que quedó en VIP.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import pg from '/Users/hector/Documents/IDEAS/vip/node_modules/.pnpm/pg@8.23.1/node_modules/pg/lib/index.js';
import { previewImport } from './dist/preview.js';

const c = new pg.Client({ connectionString: process.env.DU.replace(/[?&]sslmode=[^&]*/, ''), ssl: { rejectUnauthorized: false } });
await c.connect();
await c.query('set default_transaction_read_only = on');
const q = async (s, p) => (await c.query(s, p)).rows;

const imps = await q(`select id, account_id, status, file_sha256, to_char(created_at at time zone 'America/Panama','HH24:MI') creada, to_char(applied_at at time zone 'America/Panama','HH24:MI') aplicada, summary->'collection_sync' s from public.excel_imports order by created_at desc limit 3`);
console.table(imps.map((i) => ({ estado: i.status, creada: i.creada, aplicada: i.aplicada, cuenta: i.account_id.startsWith('00000000-0000-4000') ? 'Vanessa' : 'otra', sha: i.file_sha256.slice(0, 8) })));
const last = imps.find((i) => i.status === 'applied');
const sum = Object.values(last.s ?? {})[0] ?? {};
console.log('resumen de la última aplicada:', JSON.stringify({ unidades: sum.units, pagos: sum.payments, finalizadas: sum.assignments_ended, nuevas: sum.assignments_created, operarios: sum.drivers, bloqueadas: sum.blocked }));

const file = ['/Users/hector/Downloads/hector.xlsx', '/Users/hector/Desktop/hector.xlsx'].find((f) => existsSync(f) && createHash('sha256').update(readFileSync(f)).digest('hex') === last.file_sha256);
console.log('archivo en tu equipo que corresponde:', file ?? 'ninguno (se compara con lo guardado de la importación)');
let rows;
if (file) rows = (await previewImport(readFileSync(file), 'x.xlsx', {})).blocks.flatMap((b) => b.rows);
else rows = (await q(`select r.unit_code "unitCode", r.operator_code "operatorCode", r.day_amounts_cents "dayAmountsCents", r.phone_e164 "phoneE164", r.daily_rate_cents "dailyRateCents", r.send_flag "sendFlag" from public.import_rows r join public.import_blocks b on b.id=r.block_id where b.import_id=$1`, [last.id]))
  .map((r) => ({ ...r, dayAmountsCents: (r.dayAmountsCents ?? []).map((x) => (x === null ? null : Number(x))), dailyRateCents: r.dailyRateCents === null ? null : Number(r.dailyRateCents) }));

const A = last.account_id;
const week = (await q(`select app_private.week_start_of((now() at time zone 'America/Panama')::date)::text w`))[0].w;
const today = (await q(`select (now() at time zone 'America/Panama')::date::text d`))[0].d;
const asg = await q(`select u.code, d.operator_code op, d.phone_e164 tel, coalesce((to_jsonb(a)->>'send_default')::boolean,false) msg, (select r.daily_amount_cents from public.rates r where r.assignment_id=a.id and r.valid_to is null limit 1) cuota
  from public.units u left join public.assignments a on a.unit_id=u.id and (a.valid_to is null or a.valid_to > $2::date) left join public.drivers d on d.id=a.driver_id where u.account_id=$1`, [A, today]);
const pays = await q(`select u.code, x.pay_date::text d, x.amount_cents::int c, d.operator_code op, (a.valid_to is null or a.valid_to > $3::date) vigente from public.excel_payment_days x join public.assignments a on a.id=x.assignment_id join public.units u on u.id=a.unit_id join public.drivers d on d.id=a.driver_id where x.week_start=$2 and u.account_id=$1`, [A, week, today]);

const key = (s) => String(s ?? '').replace(/\s+/g, '').toUpperCase();
const op = (s) => { const v = String(s ?? '').trim(); return v && !/^0+$/.test(v) ? v : null; };
const db = new Map(asg.map((x) => [key(x.code), x]));
const days = Array.from({ length: 7 }, (_, i) => { const d = new Date(`${week}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + i); return d.toISOString().slice(0, 10); });
const bad = { asignacion: [], pagos: [], pagoEnUnidadSinOperario: [], whatsapp: [], cuota: [], mensaje: [] };
let checked = 0;
for (const r of rows.filter((x) => x.unitCode)) {
  const k = key(r.unitCode), v = db.get(k), o = op(r.operatorCode);
  if ((v?.op ?? null) !== o) bad.asignacion.push(`${k} excel=${o} vip=${v?.op ?? null}`);
  if (o && v?.op === o) {
    if (r.phoneE164 && v.tel !== r.phoneE164) bad.whatsapp.push(k);
    if (r.dailyRateCents && Number(v.cuota) !== r.dailyRateCents) bad.cuota.push(k);
    if (r.sendFlag !== null && r.sendFlag !== undefined && v.msg !== r.sendFlag) bad.mensaje.push(k);
    days.forEach((d, i) => {
      const x = r.dayAmountsCents?.[i];
      if (x === null || x === undefined) return;
      checked++;
      const have = pays.filter((p) => key(p.code) === k && p.d === d && p.vigente).reduce((t, p) => t + p.c, 0);
      if (have !== x) bad.pagos.push(`${k} día ${d.slice(8)} excel=${x / 100} vip=${have / 100}`);
    });
  }
}
for (const p of pays) if (p.c > 0 && !p.vigente) bad.pagoEnUnidadSinOperario.push(`${p.code} día ${p.d.slice(8)} $${p.c / 100} (operario ${p.op})`);
console.log('filas comparadas', rows.filter((x) => x.unitCode).length, '· días con importe revisados', checked);
for (const [n, l] of Object.entries(bad)) console.log(`${n}: ${l.length}`, l.slice(0, 10).join(' | '));
for (const u of ['P781', 'P831']) {
  const r = rows.find((x) => key(x.unitCode) === u);
  console.log(u, '| Excel: operario', op(r?.operatorCode), 'días', JSON.stringify(r?.dayAmountsCents?.slice(0, 3)), '| VIP: operario', db.get(u)?.op ?? null, 'pagos', JSON.stringify(pays.filter((p) => key(p.code) === u).sort((a, b) => a.d.localeCompare(b.d)).map((p) => `${p.d.slice(8)}:$${p.c / 100}`)));
}
console.log('operarios con 2+ vigentes:', (await q(`select count(*)::int n from (select a.driver_id from public.assignments a where a.account_id=$1 and (a.valid_to is null or a.valid_to > $2::date) group by 1 having count(*)>1) x`, [A, today]))[0].n,
  '· pagos duplicados:', (await q(`select count(*)::int n from (select p.assignment_id, p.paid_at::date from public.payments p join public.payment_methods m on m.id=p.method_id where m.code='excel' and p.voided_at is null and p.week_start=$1 group by 1,2 having count(*)>1) x`, [week]))[0].n,
  '· mensajes en la última media hora:', (await q(`select count(*)::int n from public.whatsapp_test_messages where created_at > now() - interval '30 minutes'`))[0].n);
console.log('pagos Excel de la semana en VIP: $' + pays.reduce((t, p) => t + p.c, 0) / 100, '· suma en filas con operario del Excel: $' + rows.filter((r) => op(r.operatorCode)).reduce((t, r) => t + (r.dayAmountsCents ?? []).reduce((s, x) => s + (x ?? 0), 0), 0) / 100);
await c.end();

#!/usr/bin/env node
// Verificación MANUAL (no es una prueba): muestra el summary y los primeros avisos de un Excel de cobranza plana.
// Uso:  pnpm --filter @vip/excel-import build && node packages/excel-import/scripts/inspect-flat.mjs /ruta/datos.xlsx [--issues=40] [--all]
// Solo LEE el archivo (no lo copia, no toca ninguna base de datos).
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { detectImportKind, previewImport } from '../dist/index.js';

const args = process.argv.slice(2);
const path = args.find((a) => !a.startsWith('--'));
const limit = Number((args.find((a) => a.startsWith('--issues=')) ?? '--issues=25').split('=')[1]);
if (!path) { console.error('Uso: node inspect-flat.mjs <archivo.xlsx> [--issues=N] [--all]'); process.exit(2); }

const buf = readFileSync(path);
const kind = await detectImportKind(buf);
const p = await previewImport(buf, basename(path), {});
const { issues, ...summary } = p.summary;
const rows = p.blocks.flatMap((b) => b.rows);
console.log('kind detectado:', kind, '| sha256:', p.fileSha256.slice(0, 16) + '…');
console.log('\n== summary ==');
console.log(JSON.stringify(summary, null, 2));
console.log('\n== extra ==');
console.log(JSON.stringify({
  filasConNombre: rows.filter((r) => r.fullName).length, filasSinNombre: rows.filter((r) => !r.fullName).length,
  filasConOperario: rows.filter((r) => r.operatorCode).length, filasSinOperario: rows.filter((r) => !r.operatorCode).length,
  filasConCedula: rows.filter((r) => r.nationalId).length, saldoVacio: rows.filter((r) => r.saldoState === 'empty').length,
  cuotaCero: rows.filter((r) => r.dailyRateCents === 0).length, cuotaVacia: rows.filter((r) => r.dailyRateCents == null).length,
  semanaDetectada: p.blocks[0]?.detectedWeekStart ?? null,
}, null, 2));
const shown = (args.includes('--all') ? issues : issues.filter((i) => i.level !== 'info').concat(issues.filter((i) => i.level === 'info'))).slice(0, args.includes('--all') ? Infinity : limit);
console.log(`\n== primeros avisos (${shown.length} de ${p.summary.issuesTotal}; errores primero) ==`);
const order = { error: 0, warning: 1, info: 2 };
for (const i of [...shown].sort((a, b) => order[a.level] - order[b.level] || a.row - b.row))
  console.log(`[${i.level}] fila ${i.row} · ${i.column} · ${i.code}: ${i.message}`);
console.log('\n== muestra de 3 filas ==');
for (const r of rows.slice(0, 3)) console.log(JSON.stringify({ fila: r.sourceRow, unit: r.unitCode, op: r.operatorCode, nid: r.nationalId, nombreCompleto: r.fullName, tel: r.phoneE164, cuenta: r.dailyRateCents, saldo: r.rawSaldo, dias: r.dayAmountsCents, semanal: [r.excelWeeklyDiffCents, r.excelWeeklyExpectedCents] }));

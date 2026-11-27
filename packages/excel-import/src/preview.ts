import type ExcelJS from 'exceljs';
import { cobranzaBuckets, directoryBuckets } from './buckets.js';
import { cobranzaSheet, hasCobranzaBlocks, loadWorkbook, parseCobranzaSheet, sha256Hex } from './parser.js';
import { findFlatHeader, flatBuckets, parseFlatSheet } from './flat.js';
import { findTemplateHeader, parseDirectorySheet, TEMPLATE_SHEET } from './directory.js';
import type { Directory, DriverRef, ImportKind, ImportPreview, PreviewContext } from './types.js';

const norm = (s: string) => s.trim().toLowerCase();

/** Hoja de plantilla si existe una llamada 'Plantilla', o la hoja de cobranza (Hoja1/primera). */
function sheetFor(wb: ExcelJS.Workbook): { kind: ImportKind; ws: ExcelJS.Worksheet } {
  const tpl = wb.worksheets.find((w) => norm(w.name) === norm(TEMPLATE_SHEET));
  if (tpl) return { kind: 'directory', ws: tpl };
  const ws = cobranzaSheet(wb);
  if (!ws) throw new Error('El archivo no contiene hojas.');
  if (hasCobranzaBlocks(ws)) return { kind: 'cobranza', ws };
  // Cobranza plana: cabeceras en cualquiera de las primeras filas (hoja principal primero, luego las demás); antes que la plantilla, que comparte columnas.
  for (const w of [ws, ...wb.worksheets.filter((x) => x !== ws)]) if (findFlatHeader(w)) return { kind: 'collection_flat', ws: w };
  if (findTemplateHeader(ws)) return { kind: 'directory', ws };
  throw new Error("No se reconoce el formato: no es el Excel de cobranza (cabecera 'und') ni la plantilla (Código de operador, Cédula...).");
}

/** Detecta el tipo de archivo: 'directory' (plantilla), 'cobranza' (bloques 'und') o 'collection_flat' (cobranza plana). Lanza error si no reconoce ninguno. */
export async function detectImportKind(buffer: Uint8Array): Promise<ImportKind> {
  return sheetFor(await loadWorkbook(buffer)).kind;
}

const asDrivers = (dir?: Directory): DriverRef[] | undefined => dir?.drivers.map((d) => ({ id: d.id, operatorCode: d.operatorCode, nationalId: d.nationalId }));

/**
 * VISTA PREVIA pura (sin base de datos): detecta el tipo de archivo, interpreta las filas, concilia con lo existente
 * (`ctx.directory` o `ctx.drivers`) y calcula las diferencias y los buckets del `summary`.
 */
export async function previewImport(buffer: Uint8Array, fileName: string, ctx: PreviewContext = {}): Promise<ImportPreview> {
  const wb = await loadWorkbook(buffer);
  const { kind, ws } = sheetFor(wb);
  const fileSha256 = sha256Hex(buffer);
  if (kind === 'directory') {
    const { blocks, summary } = parseDirectorySheet(ws, ctx.directory);
    return { kind, fileName, fileSha256, blocks, summary: { ...summary, kind, ...directoryBuckets(summary, blocks, ctx.directory) } };
  }
  if (kind === 'collection_flat') {
    const { blocks, summary, issues, issuesTotal } = parseFlatSheet(ws, findFlatHeader(ws)!, ctx.directory);
    return { kind, fileName, fileSha256, blocks, summary: { ...summary, kind, ...flatBuckets(summary, blocks), issues, issuesTotal } };
  }
  const { blocks, summary } = parseCobranzaSheet(wb, asDrivers(ctx.directory) ?? ctx.drivers ?? [], ctx.directory);
  return { kind, fileName, fileSha256, blocks, summary: { ...summary, kind, ...cobranzaBuckets(summary, blocks, ctx.directory) } };
}

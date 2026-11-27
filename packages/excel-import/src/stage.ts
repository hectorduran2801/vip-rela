import { BLOCKING_WARNINGS, DIRECTORY_BLOCKING_WARNINGS, FLAT_ERROR_WARNINGS, type ConfirmOptions, type ConfirmResult, type Directory, type DriverRef, type ImportPreview, type Queryable, type StageContext, type StageResult } from './types.js';
import { previewImport } from './preview.js';

/** Carga los conductores existentes existentes (solo SELECT; RLS aplica al rol del cliente). */
export async function loadDrivers(client: Queryable): Promise<DriverRef[]> {
  const r = await client.query('select id, operator_code, national_id from public.drivers');
  return r.rows.map((x) => ({ id: x.id, operatorCode: x.operator_code, nationalId: x.national_id }));
}

/** Directorio vigente para la vista previa con diferencias: conductores, unidades y asignaciones vigentes con su tarifa vigente (solo SELECT). */
export async function loadDirectory(client: Queryable): Promise<Directory> {
  const d = await client.query('select id, operator_code, national_id, first_name, last_name, phone_e164, status, whatsapp_consent from public.drivers');
  const u = await client.query('select code, agreement from public.units');
  const a = await client.query(
    `select a.driver_id, u.code, rt.daily_amount_cents from public.assignments a join public.units u on u.id = a.unit_id
       left join public.rates rt on rt.assignment_id = a.id and rt.valid_to is null where a.valid_to is null`);
  return {
    drivers: d.rows.map((x) => ({ id: x.id, operatorCode: x.operator_code, nationalId: x.national_id, firstName: x.first_name, lastName: x.last_name, phoneE164: x.phone_e164, status: x.status, whatsappConsent: !!x.whatsapp_consent })),
    units: u.rows.map((x) => x.code),
    unitAgreements: Object.fromEntries(u.rows.map((x) => [String(x.code).trim().toUpperCase(), x.agreement ?? null])),
    assignments: a.rows.map((x) => ({ driverId: x.driver_id, unitCode: x.code, dailyRateCents: x.daily_amount_cents == null ? null : Number(x.daily_amount_cents) })),
  };
}

export class ImportStateError extends Error {}

/**
 * Parsea, concilia y escribe SOLO en excel_imports / import_blocks / import_rows / candidate_payments.
 * Nunca toca drivers, assignments, charges ni payments. Idempotente por sha256 del archivo: si ya existe
 * devuelve la importación existente (created=false) sin escribir nada más.
 * El llamador abre la transacción y fija el rol/claims (RLS: solo la administradora autorizada puede insertar;
 * cualquier otro usuario recibe el error de RLS de PostgreSQL). Si algo falla, haga rollback de la transacción.
 */
export async function stageImport(client: Queryable, ctx: StageContext, buffer: Uint8Array, fileName: string): Promise<StageResult> {
  const directory = await loadDirectory(client);
  const preview = await previewImport(buffer, fileName, { directory });
  return stagePreview(client, ctx, preview);
}

/** Variante que escribe una vista previa ya calculada con `previewImport`. */
export async function stagePreview(client: Queryable, ctx: StageContext, preview: ImportPreview): Promise<StageResult> {
  const ins = await client.query(
    `insert into public.excel_imports(file_name, file_sha256, summary, created_by, source_kind)
     values ($1,$2,$3::jsonb,$4,$5) on conflict (account_id, file_sha256) do nothing returning id, status`,
    [preview.fileName, preview.fileSha256, JSON.stringify(preview.summary), ctx.userId, preview.kind]);
  if (ins.rows.length === 0) {
    const ex = await client.query('select id, status, summary from public.excel_imports where file_sha256=$1', [preview.fileSha256]);
    const e = ex.rows[0];
    return { created: false, importId: e.id, status: e.status, fileSha256: preview.fileSha256, summary: e.summary };
  }
  const importId: string = ins.rows[0].id;

  for (const b of preview.blocks) {
    const blk = await client.query(
      `insert into public.import_blocks(import_id, block_index, start_column, header_variant, detected_week_start)
       values ($1,$2,$3,$4,null) returning id`,
      [importId, b.blockIndex, b.startColumn, b.headerVariant]);
    const blockId: string = blk.rows[0].id;
    for (let i = 0; i < b.rows.length; i += 500) {
      const chunk = b.rows.slice(i, i + 500).map((r) => ({
        source_row: r.sourceRow, unit_code: r.unitCode, operator_code: r.operatorCode, national_id: r.nationalId, full_name: r.fullName,
        daily_rate_cents: r.dailyRateCents, raw_agreement: r.rawAgreement, raw_saldo: r.rawSaldo, days: r.dayAmountsCents,
        diff: r.excelWeeklyDiffCents, expected: r.excelWeeklyExpectedCents, formulas: r.originalFormulas, warnings: r.warnings,
        match_status: r.matchStatus, driver: r.matchedDriverId, first_name: r.firstName ?? null, last_name: r.lastName ?? null,
        phone: r.phoneE164 ?? null, raw_phone: r.rawPhone ?? null, row_status: r.rowStatus ?? null, changes: r.changes ?? {},
        agr: r.unitAgreement ?? null, agr_note: r.unitAgreementNote ?? null, consent_request: r.consentRequest ?? null, consent_origin: r.consentOrigin ?? null,
        send_flag: r.sendFlag ?? null,
      }));
      const res = await client.query(
        `insert into public.import_rows(block_id, source_row, unit_code, operator_code, national_id, full_name,
           daily_rate_cents, raw_agreement, raw_saldo, day_amounts_cents, excel_weekly_diff_cents, excel_weekly_expected_cents,
           original_formulas, warnings, match_status, matched_driver_id, first_name, last_name, phone_e164, raw_phone, row_status, changes, unit_agreement, unit_agreement_note, consent_request, consent_origin, send_flag)
         select $1::uuid, j.source_row, j.unit_code, j.operator_code, j.national_id, j.full_name, j.daily_rate_cents, j.raw_agreement, j.raw_saldo,
           (select array_agg(x::bigint order by o) from jsonb_array_elements_text(j.days) with ordinality t(x,o)),
           j.diff, j.expected, j.formulas, array(select jsonb_array_elements_text(j.warnings)), j.match_status, j.driver, j.first_name, j.last_name, j.phone, j.raw_phone, j.row_status, j.changes, j.agr, j.agr_note, j.consent_request, j.consent_origin, j.send_flag
         from jsonb_to_recordset($2::jsonb) as j(source_row int, unit_code text, operator_code text, national_id text, full_name text,
           daily_rate_cents bigint, raw_agreement text, raw_saldo text, days jsonb, diff bigint, expected bigint, formulas jsonb,
           warnings jsonb, match_status text, driver uuid, first_name text, last_name text, phone text, raw_phone text, row_status text, changes jsonb, agr text, agr_note text, consent_request text, consent_origin text, send_flag boolean)
         returning id, source_row`, [blockId, JSON.stringify(chunk)]);
      const idBySource = new Map<number, string>(res.rows.map((x) => [x.source_row, x.id]));
      // Importes históricos → SOLO candidatos pendientes (sin fecha ni método); los ceros no son un pago.
      // Cobranza plana: los importes LUN–DOM los lee apply_collection_sync directamente de day_amounts_cents (no hay candidatos).
      const cands = preview.kind === 'collection_flat' ? [] : b.rows.filter((r) => r.matchStatus !== 'ignored').flatMap((r) => {
        const rowId = idBySource.get(r.sourceRow);
        return rowId ? r.dayAmountsCents.flatMap((a, d) => (a != null && a > 0 ? [{ row: rowId, wd: d + 1, amt: a }] : [])) : [];
      });
      if (cands.length) await client.query(
        `insert into public.candidate_payments(import_row_id, weekday, amount_cents, status)
         select c.row, c.wd, c.amt, 'pending' from jsonb_to_recordset($1::jsonb) as c(row uuid, wd smallint, amt bigint)`,
        [JSON.stringify(cands)]);
    }
  }
  return { created: true, importId, status: 'previewed', fileSha256: preview.fileSha256, summary: preview.summary };
}

/** Revisión previa a confirmar: filas de la importación (opcionalmente filtradas por estado de conciliación). */
export async function listImportRows(client: Queryable, importId: string, filter: { matchStatus?: string; onlyWithWarnings?: boolean } = {}) {
  const r = await client.query(
    `select r.*, b.block_index from public.import_rows r join public.import_blocks b on b.id = r.block_id
     where b.import_id = $1 and ($2::text is null or r.match_status = $2) and (not $3::boolean or cardinality(r.warnings) > 0)
     order by b.block_index, r.source_row`, [importId, filter.matchStatus ?? null, filter.onlyWithWarnings ?? false]);
  return r.rows;
}

/**
 * Confirma la importación: la marca 'confirmed' y marca como 'approved' las filas elegidas.
 * NO crea cargos, pagos, conductores ni asignaciones, y deja los candidate_payments en 'pending'.
 */
export async function confirmImport(client: Queryable, ctx: StageContext, importId: string, opts: ConfirmOptions): Promise<ConfirmResult> {
  const cur = await client.query('select status, source_kind from public.excel_imports where id=$1 for update', [importId]);
  if (cur.rows.length === 0) throw new ImportStateError('Importación no encontrada.');
  if (cur.rows[0].status !== 'previewed') throw new ImportStateError(`La importación ya está ${cur.rows[0].status}.`);
  const blocking = (cur.rows[0].source_kind === 'directory' ? DIRECTORY_BLOCKING_WARNINGS : cur.rows[0].source_kind === 'collection_flat' ? FLAT_ERROR_WARNINGS : BLOCKING_WARNINGS) as readonly string[];
  const upd = opts.approve === 'clean'
    ? await client.query(
      `update public.import_rows r set review_status='approved' from public.import_blocks b
       where b.id=r.block_id and b.import_id=$1 and r.match_status in ('matched','unmatched')
         and not exists (select 1 from unnest(r.warnings) w where split_part(w, ':', 1) = any($2::text[])) returning r.id`,
      [importId, blocking])
    : await client.query(
      `update public.import_rows r set review_status='approved' from public.import_blocks b
       where b.id=r.block_id and b.import_id=$1 and r.id = any($2::uuid[]) returning r.id`,
      [importId, opts.approve]);
  await client.query(`update public.excel_imports set status='confirmed' where id=$1`, [importId]);
  return { importId, approvedRows: upd.rows.length, status: 'confirmed' };
}

/** Descarta la importación (status 'rejected'); el mismo archivo seguirá sin poder reimportarse. */
export async function rejectImport(client: Queryable, ctx: StageContext, importId: string): Promise<void> {
  const r = await client.query(`update public.excel_imports set status='rejected' where id=$1 and status='previewed' returning id`, [importId]);
  if (r.rows.length === 0) throw new ImportStateError('La importación no existe o ya no está en vista previa.');
}

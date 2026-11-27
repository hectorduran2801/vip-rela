import multipart from '@fastify/multipart';
import { ImportStateError, buildDirectoryTemplate, normalizePhone, confirmImport, listImportRows, rejectImport, stageImport } from '@vip/excel-import';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Tx } from '../db.js';
import { mapDbError } from '../errors.js';
import { requireAdmin } from '../plugins/auth.js';

const uuid = z.string().uuid();
const asClient = (tx: Tx) => ({ query: async (sql: string, params?: unknown[]) => ({ rows: await tx.rows(sql, params) }) });

export const importRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAdmin);
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 5 } });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ImportStateError) return reply.code(409).send({ error: 'import_state', message: err.message });
    if ((err as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') return reply.code(413).send({ error: 'file_too_large' });
    const mapped = mapDbError(err);
    if (mapped) return reply.code(mapped.status).send({ error: mapped.error });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.code(status).send({ error: status === 401 ? 'not_authenticated' : (err as Error).message });
    req.log.error({ err: { message: (err as Error).message, code: (err as { code?: string }).code } }, 'unhandled');
    return reply.code(500).send({ error: 'internal_error' });
  });

  // Plantilla sencilla para futuras importaciones (altas y actualizaciones).
  app.get('/imports/template.xlsx', async (_req, reply) => {
    const buf = await buildDirectoryTemplate();
    return reply.header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('content-disposition', 'attachment; filename="vip-plantilla-importacion.xlsx"').header('cache-control', 'no-store').send(buf);
  });

  app.get('/imports', async (req, reply) => {
    return req.db((tx) => tx.rows(`select i.id, i.file_name, i.status, i.summary, i.created_at, i.applied_at, p.full_name created_by_name
      from public.excel_imports i left join public.profiles p on p.id = i.created_by order by i.created_at desc limit 100`));
  });

  // Sube el .xlsx: reconoce los bloques, concilia y deja TODO en preparación. No toca conductores ni finanzas.
  app.post('/imports/excel', async (req, reply) => {
    const file = await req.file();
    if (!file) return reply.code(400).send({ error: 'file_required' });
    const buf = await file.toBuffer();
    if (!/\.xlsx$/i.test(file.filename) || buf.length < 4 || buf.readUInt32BE(0) !== 0x504b0304) return reply.code(415).send({ error: 'xlsx_required' });
    const userId = req.user!.id;
    let result;
    try {
      result = await req.db((tx) => stageImport(asClient(tx), { userId }, buf, file.filename));
    } catch (e) {
      if (e instanceof Error && /No se encontr|bloque|und/i.test(e.message) && !(e as { code?: string }).code) return reply.code(422).send({ error: 'invalid_workbook', message: e.message });
      throw e;
    }
    return reply.code(result.created ? 201 : 200).send({ ...result, kind: (result.summary as { kind?: string } | undefined)?.kind ?? 'cobranza' });
  });

  app.get<{ Params: { id: string } }>('/imports/:id/rows', async (req, reply) => {
    const id = uuid.safeParse(req.params.id);
    const q = z.object({ matchStatus: z.enum(['unmatched', 'matched', 'conflict', 'duplicate', 'ignored']).optional(), onlyWithWarnings: z.enum(['true', 'false']).optional() }).safeParse(req.query);
    if (!id.success || !q.success) return reply.code(400).send({ error: 'invalid_body' });
    const rows = await req.db((tx) => listImportRows(asClient(tx), id.data, { matchStatus: q.data.matchStatus, onlyWithWarnings: q.data.onlyWithWarnings === 'true' }));
    return rows.slice(0, 5000);
  });

  // Corregir una fila del archivo ANTES de guardar (solo en VIP: el Excel original no cambia). Cada campo es opcional; vacío = sin dato.
  const cents = z.number().int().min(0).max(100_000_000).nullable();
  app.patch<{ Params: { id: string; rowId: string } }>('/imports/:id/rows/:rowId', async (req, reply) => {
    const p = z.object({ id: uuid, rowId: uuid }).safeParse(req.params);
    const b = z.object({
      unitCode: z.string().trim().max(40).nullable(), operatorCode: z.string().trim().max(40).nullable(), fullName: z.string().trim().max(200).nullable(),
      nationalId: z.string().trim().max(40).nullable(), phone: z.string().trim().max(40).nullable(), dailyRateCents: cents, rawAgreement: z.string().trim().max(300).nullable(),
      rawSaldo: z.string().trim().max(40).nullable(), dayAmountsCents: z.array(cents).length(7),
    }).partial().safeParse(req.body);
    if (!p.success || !b.success) return reply.code(400).send({ error: 'invalid_body' });
    const d = b.data; const sets: string[] = []; const vals: unknown[] = [p.data.id, p.data.rowId];
    const put = (col: string, v: unknown, cast = '') => { vals.push(v); sets.push(`${col} = $${vals.length}${cast}`); };
    const txt = (v: string | null | undefined) => (v === undefined ? undefined : v === null || v === '' ? null : v);
    if (d.unitCode !== undefined) put('unit_code', txt(d.unitCode));
    if (d.operatorCode !== undefined) put('operator_code', txt(d.operatorCode));
    if (d.fullName !== undefined) put('full_name', txt(d.fullName));
    if (d.nationalId !== undefined) put('national_id', txt(d.nationalId));
    if (d.rawAgreement !== undefined) put('raw_agreement', txt(d.rawAgreement));
    if (d.rawSaldo !== undefined) put('raw_saldo', txt(d.rawSaldo));
    if (d.dailyRateCents !== undefined) put('daily_rate_cents', d.dailyRateCents);
    if (d.dayAmountsCents !== undefined) put('day_amounts_cents', d.dayAmountsCents, '::bigint[]');
    if (d.phone !== undefined) { put('raw_phone', txt(d.phone)); put('phone_e164', d.phone ? normalizePhone(d.phone) : null); }
    if (!sets.length) return reply.code(400).send({ error: 'invalid_body' });
    const r = await req.db((tx) => tx.one(`update public.import_rows r set ${sets.join(', ')} from public.import_blocks bl, public.excel_imports i
        where bl.id = r.block_id and i.id = bl.import_id and i.id = $1 and r.id = $2 and i.status <> 'rejected' returning r.id`, vals));
    if (!r) return reply.code(404).send({ error: 'import_not_found' });
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>('/imports/:id/confirm', async (req, reply) => {
    const id = uuid.safeParse(req.params.id);
    const b = z.object({ approve: z.union([z.literal('clean'), z.array(uuid).max(5000)]) }).safeParse(req.body);
    if (!id.success || !b.success) return reply.code(400).send({ error: 'invalid_body' });
    return req.db((tx) => confirmImport(asClient(tx), { userId: req.user!.id }, id.data, { approve: b.data.approve }));
  });

  app.post<{ Params: { id: string } }>('/imports/:id/reject', async (req, reply) => {
    const id = uuid.safeParse(req.params.id);
    if (!id.success) return reply.code(400).send({ error: 'invalid_body' });
    await req.db((tx) => rejectImport(asClient(tx), { userId: req.user!.id }, id.data));
    return reply.code(204).send();
  });

  // ───── Apertura de SALDO (deuda arrastrada): conciliación previa y aplicación ─────
  // El SALDO del Excel es la DEUDA pendiente arrastrada de la semana anterior. Los bloques NO traen fecha: la semana la elige quien aplica.
  // La vista previa es solo lectura; la aplicación crea cargos `opening` auditados (idempotente: reaplicar no duplica ni sobrescribe).
  const week = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  app.get<{ Params: { id: string } }>('/imports/:id/opening-balances', async (req, reply) => {
    const id = uuid.safeParse(req.params.id);
    const q = z.object({ blockId: uuid, weekStart: week }).safeParse(req.query);
    if (!id.success || !q.success) return reply.code(400).send({ error: 'invalid_body' });
    const rows = await req.db((tx) => tx.rows(
      `select assignment_id, import_row_id, source_row, unit_code, operator_code, raw_saldo, saldo_excel_cents, saldo_state, pending_before_cents, credit_before_cents,
              existing_opening_cents, existing_opening_week_start::text as existing_opening_week_start, prior_records, week_activity_cents, action, note
         from public.preview_opening_balances($1, $2, $3::date)`, [id.data, q.data.blockId, q.data.weekStart]));
    const out = rows.map((r) => ({
      ...r, source_row: Number(r.source_row), saldo_excel_cents: num(r.saldo_excel_cents), pending_before_cents: num(r.pending_before_cents), credit_before_cents: num(r.credit_before_cents),
      existing_opening_cents: num(r.existing_opening_cents), week_activity_cents: num(r.week_activity_cents),
    }));
    const count = (a: string) => out.filter((r) => r.action === a).length;
    return {
      import_id: id.data, block_id: q.data.blockId, week_start: q.data.weekStart,
      summary: {
        rows: out.length, create: count('create'), unchanged: count('unchanged'), conflict: count('conflict'), skip_empty: count('skip_empty'), skip_zero: count('skip_zero'),
        skip_text: count('skip_text'), no_assignment: count('no_assignment'), ambiguous: count('ambiguous'),
        create_cents: out.filter((r) => r.action === 'create').reduce((s, r) => s + (r.saldo_excel_cents ?? 0), 0),
      },
      rows: out,
    };
  });

  app.post<{ Params: { id: string } }>('/imports/:id/opening-balances/apply', async (req, reply) => {
    const id = uuid.safeParse(req.params.id);
    const b = z.object({ blockId: uuid, weekStart: week, note: z.string().trim().max(500).nullish() }).safeParse(req.body);
    if (!id.success || !b.success) return reply.code(400).send({ error: 'invalid_body' });
    return (await req.db((tx) => tx.one(`select public.apply_opening_balances($1, $2, $3::date, $4) r`, [id.data, b.data.blockId, b.data.weekStart, b.data.note ?? null])))!.r;
  });

  // ───── Excel de cobranza plano (DATOS APP DE COBRANZA): vista previa y sincronización idempotente de una semana ─────
  // La semana NO viene en el archivo: la elige quien importa (lunes). La aplicación es transaccional y no se puede con errores.
  app.get<{ Params: { id: string } }>('/imports/:id/sync-preview', async (req, reply) => {
    const id = uuid.safeParse(req.params.id); const q = z.object({ weekStart: week, dataDate: week.optional() }).safeParse(req.query);
    if (!id.success || !q.success) return reply.code(400).send({ error: 'invalid_body' });
    return (await req.db((tx) => tx.one(`select public.preview_collection_sync($1, $2::date, $3::date) r`, [id.data, q.data.weekStart, q.data.dataDate ?? null])))!.r;
  });
  app.post<{ Params: { id: string } }>('/imports/:id/sync-apply', async (req, reply) => {
    const id = uuid.safeParse(req.params.id);
    const b = z.object({ weekStart: week, dataDate: week.optional(), note: z.string().trim().max(500).nullish(), confirmHistorical: z.boolean().default(false) }).safeParse(req.body);
    if (!id.success || !b.success) return reply.code(400).send({ error: 'invalid_body' });
    try {
      return await req.db(async (tx) => {
        const imp = await tx.one(`select status from public.excel_imports where id = $1`, [id.data]);
        if (!imp) return reply.code(404).send({ error: 'import_not_found' });
        const pre = (await tx.one(`select public.preview_collection_sync($1, $2::date, $3::date) r`, [id.data, b.data.weekStart, b.data.dataDate ?? null]))!.r as { units: { errors: number } };
        if (pre.units.errors > 0) return reply.code(409).send({ error: 'import_has_errors', errors: pre.units.errors });   // nada se guarda con errores
        if (imp.status === 'previewed') await confirmImport(asClient(tx), { userId: req.user!.id }, id.data, { approve: 'clean' });
        return (await tx.one(`select public.apply_collection_sync($1, $2::date, $3, $4, $5::date) r`, [id.data, b.data.weekStart, b.data.note ?? null, b.data.confirmHistorical, b.data.dataDate ?? null]))!.r;
      }).then(async (r) => {
        // Las cuotas de hoy deben existir ANTES de mensajear: sin ellas, los pagos recién importados se descuentan solo del saldo anterior y el mensaje diría $0.00.
        await req.db((tx) => tx.one(`select public.ensure_daily_charges() r`)).catch(() => undefined);
        return r;
      });
    } catch (e) {
      // Importación antigua: se devuelve la información de la protección para que la persona confirme de forma explícita (con nota).
      if ((e as { message?: string }).message === 'historical_import_requires_confirmation') {
        let guard: unknown = null; try { guard = JSON.parse((e as { detail?: string }).detail ?? 'null'); } catch { /* sin detalle */ }
        return reply.code(409).send({ error: 'historical_import_requires_confirmation', guard });
      }
      throw e;
    }
  });

  // Aplica según el TIPO de archivo: «cobranza» (apply_import) o «directory» (plantilla: apply_directory_import).
  // Importes, SALDO y pagos NO pasan a finanzas; nunca se crean cuentas de Auth para conductores.
  app.post<{ Params: { id: string } }>('/imports/:id/apply', async (req, reply) => {
    const id = uuid.safeParse(req.params.id);
    const b = z.object({
      validFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(), initialStatus: z.enum(['active', 'inactive', 'pending_approval']).default('active'),
      resolve: z.enum(['skip', 'latest_block']).default('skip'), applyRateChanges: z.boolean().default(false),
    }).safeParse(req.body ?? {});
    if (!id.success || !b.success) return reply.code(400).send({ error: 'invalid_body' });
    return req.db(async (tx) => {
      const imp = await tx.one(`select source_kind from public.excel_imports where id = $1`, [id.data]);
      if (!imp) return reply.code(404).send({ error: 'import_not_found' });
      const d = b.data;
      return imp.source_kind === 'directory'
        ? (await tx.one(`select public.apply_directory_import($1, $2::date, $3, $4) r`, [id.data, d.validFrom ?? null, d.initialStatus, d.applyRateChanges]))!.r
        : (await tx.one(`select public.apply_import($1, $2::date, $3, $4) r`, [id.data, d.validFrom ?? null, d.initialStatus, d.resolve]))!.r;
    });
  });
};

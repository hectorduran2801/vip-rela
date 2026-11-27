import { ERROR_WARNINGS, type Buckets, type ConsentSummary, type Directory, type ImportSummary, type ParsedBlock, type ParsedRow } from './types.js';
import type { BaseSummary } from './parser.js';

const key = (s: string) => s.trim().toUpperCase();
const hasError = (r: ParsedRow) => r.warnings.some((w) => (ERROR_WARNINGS as readonly string[]).includes(w.split(':')[0]!));
const EMPTY_DIR: Directory = { drivers: [], units: [], assignments: [] };

/** Unidades sin conductor y acuerdos (por unidad única; una unidad con acuerdos distintos —sin distinguir mayúsculas— es ambigua y no se cuenta). */
function unitStats(rows: ParsedRow[], dir: Directory) {
  const live = rows.filter((r) => (r.matchStatus === 'matched' || r.matchStatus === 'unmatched') && r.unitCode?.trim());
  const hasDriver = (r: ParsedRow) => !!(r.operatorCode?.trim() && r.nationalId?.trim());
  const driverUnits = new Set(live.filter(hasDriver).map((r) => key(r.unitCode!)));
  const assigned = new Set(dir.assignments.map((a) => key(a.unitCode)));
  const withoutDriver = new Set(live.filter((r) => !hasDriver(r)).map((r) => key(r.unitCode!)).filter((k) => !driverUnits.has(k) && !assigned.has(k)));
  const agr = new Map<string, Set<string>>();
  for (const r of live) if (r.unitAgreement && r.unitAgreement !== '-') { const k = key(r.unitCode!); (agr.get(k) ?? agr.set(k, new Set()).get(k)!).add(r.unitAgreement.toUpperCase()); }
  let withAgreement = 0, ambiguous = 0;
  for (const set of agr.values()) { if (set.size > 1) ambiguous++; else withAgreement++; }
  return { withoutDriver: withoutDriver.size, withAgreement, ambiguous };
}

function common(base: BaseSummary, rows: ParsedRow[]): Pick<Buckets, 'errors' | 'driversPendingReview' | 'conflicts' | 'duplicates' | 'skipped'> {
  const live = rows.filter((r) => r.matchStatus !== 'ignored');
  return {
    errors: live.filter(hasError).length, driversPendingReview: 0, conflicts: base.matchCounts.conflict, duplicates: base.matchCounts.duplicate,
    skipped: base.matchCounts.ignored + base.emptyRowsSkipped,
  };
}

/** Buckets de la plantilla: una fila = un conductor. */
export function directoryBuckets(base: BaseSummary, blocks: ParsedBlock[], dir: Directory = EMPTY_DIR): Buckets & { uniqueDrivers: number; consents: ConsentSummary } {
  const rows = blocks.flatMap((b) => b.rows);
  const ok = rows.filter((r) => r.matchStatus === 'matched' || r.matchStatus === 'unmatched');
  const b: Buckets = {
    drivers: { new: 0, existing: 0, toUpdate: 0, unchanged: 0 }, units: { new: 0, existing: 0, withoutDriver: 0, withAgreement: 0 },
    assignments: { new: 0, same: 0, conflicts: 0 }, rates: { new: 0, same: 0, differs: 0 }, ...common(base, rows),
  };
  const us = unitStats(rows, dir);
  b.units.withoutDriver = us.withoutDriver; b.units.withAgreement = us.withAgreement;
  let withDriver = 0;
  const consents: ConsentSummary = { toGrant: 0, toWithdraw: 0, unchanged: 0, ignored: { total: 0, missingOrigin: 0, missingPhone: 0, invalidValue: 0, noDriver: 0 } };
  const units = new Map<string, boolean>();
  for (const r of ok) {
    const c = r.changes ?? {};
    if (!c.driver) { /* unidad sin conductor */ } else if (c.driver.action === 'pending_review') { b.driversPendingReview++; } else if (c.driver.action === 'create') { b.drivers.new++; withDriver++; }
    else { withDriver++; b.drivers.existing++; if (c.driver?.action === 'update') b.drivers.toUpdate++; else b.drivers.unchanged++; }
    const cs = c.consent;
    if (cs?.action === 'grant') consents.toGrant++; else if (cs?.action === 'withdraw') consents.toWithdraw++; else if (cs?.action === 'unchanged') consents.unchanged++;
    else if (cs?.action === 'ignored') {
      consents.ignored.total++;
      if (cs.reason === 'missing_origin') consents.ignored.missingOrigin++; else if (cs.reason === 'missing_phone') consents.ignored.missingPhone++;
      else if (cs.reason === 'invalid_value') consents.ignored.invalidValue++; else consents.ignored.noDriver++;
    }
    if (c.unit && c.unit.action !== 'none' && r.unitCode) units.set(key(r.unitCode), c.unit.action === 'new');
    if (c.assignment?.action === 'new') b.assignments.new++; else if (c.assignment?.action === 'same') b.assignments.same++; else if (c.assignment?.action === 'conflict') b.assignments.conflicts++;
    if (c.rate?.action === 'new') b.rates.new++; else if (c.rate?.action === 'same') b.rates.same++; else if (c.rate?.action === 'differs') b.rates.differs++;
  }
  for (const isNew of units.values()) isNew ? b.units.new++ : b.units.existing++;
  return { ...b, uniqueDrivers: withDriver, consents };
}

/**
 * Buckets de cobranza sobre conductores/unidades ÚNICOS (agrupados por código de operador entre todos los bloques),
 * replicando las reglas de public.apply_import. Los conductores con cédulas distintas se omiten de los buckets de conductores.
 */
export function cobranzaBuckets(base: BaseSummary, blocks: ParsedBlock[], dirIn?: Directory):
  Buckets & Pick<ImportSummary, 'uniqueDrivers' | 'assignmentsResolvable' | 'ambiguity'> {
  const dir = dirIn ?? EMPTY_DIR;
  const all = blocks.flatMap((bl) => bl.rows.map((r) => ({ r, bi: bl.blockIndex })));
  const eligible = all.filter(({ r }) => (r.matchStatus === 'matched' || r.matchStatus === 'unmatched') && r.operatorCode?.trim() && r.nationalId?.trim());
  const groups = new Map<string, { r: ParsedRow; bi: number }[]>();
  for (const x of eligible) { const k = x.r.operatorCode!.trim(); (groups.get(k) ?? groups.set(k, []).get(k)!).push(x); }

  const byOp = new Map(dir.drivers.map((d) => [key(d.operatorCode), d]));
  const byId = new Map(dir.drivers.map((d) => [key(d.nationalId), d]));
  const unitSet = new Set(dir.units.map(key));
  const asgByDriver = new Map(dir.assignments.map((a) => [a.driverId, a]));
  const unitTaken = new Set(dir.assignments.map((a) => key(a.unitCode)));
  const claimed = new Set<string>();

  const out: Buckets = {
    drivers: { new: 0, existing: 0, toUpdate: 0, unchanged: 0 }, units: { new: 0, existing: 0, withoutDriver: 0, withAgreement: 0 },
    assignments: { new: 0, same: 0, conflicts: 0 }, rates: { new: 0, same: 0, differs: 0 }, ...common(base, all.map((x) => x.r)),
  };
  const us = unitStats(all.map((x) => x.r), dir);
  out.units.withoutDriver = us.withoutDriver; out.units.withAgreement = us.withAgreement;
  const amb = { unitAmbiguous: 0, rateAmbiguous: 0, nationalIdsDiffer: 0, unitsWithSeveralDrivers: 0, agreementAmbiguous: us.ambiguous };
  const res = { skip: 0, latestBlock: 0 };
  // Conductores pendientes de revisión: filas con unidad y UNO solo de operario/cédula (identidad incompleta; con ninguno es «unidad sin conductor»).
  const pend = new Set<string>();
  for (const { r } of all) {
    if (r.matchStatus !== 'matched' && r.matchStatus !== 'unmatched') continue;
    const op = r.operatorCode?.trim(), nid = r.nationalId?.trim();
    if (r.unitCode?.trim() && !!op !== !!nid) pend.add(op ? `op:${key(op)}` : `id:${key(nid!)}`);
  }
  out.driversPendingReview = pend.size;

  const sets = (xs: { r: ParsedRow }[]) => ({
    units: [...new Set(xs.map((x) => x.r.unitCode?.trim()).filter((u): u is string => !!u).map(key))],
    rates: [...new Set(xs.map((x) => x.r.dailyRateCents).filter((c): c is number => !!c && c > 0))],
  });

  for (const [, xs] of [...groups].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const nids = new Set(xs.map((x) => x.r.nationalId!.trim()));
    if (nids.size > 1) { amb.nationalIdsDiffer++; continue; }
    const nid = [...nids][0]!;
    const op = xs[0]!.r.operatorCode!.trim();
    const drv = byOp.get(key(op)) ?? byId.get(key(nid));
    if (drv) out.drivers.existing++, out.drivers.unchanged++; else out.drivers.new++;

    const full = sets(xs);
    const maxB = Math.max(...xs.map((x) => x.bi));
    const latest = sets(xs.filter((x) => x.bi === maxB));
    const uAmb = full.units.length > 1, rAmb = full.rates.length > 1;
    if (uAmb) amb.unitAmbiguous++;
    if (rAmb) amb.rateAmbiguous++;
    if (!uAmb && !rAmb) res.skip++;
    if ((!uAmb && !rAmb) || (latest.units.length <= 1 && latest.rates.length <= 1)) res.latestBlock++;

    // Buckets de asignación/tarifa en modo 'skip': lo ambiguo no se cuenta.
    if (full.units.length !== 1) continue;
    const uk = full.units[0]!;
    const cur = drv ? asgByDriver.get(drv.id) : undefined;
    let curRate: number | null | undefined;
    if (cur) {
      if (key(cur.unitCode) === uk) { out.assignments.same++; curRate = cur.dailyRateCents; } else out.assignments.conflicts++;
    } else if (unitTaken.has(uk) || claimed.has(uk)) out.assignments.conflicts++;
    else { out.assignments.new++; claimed.add(uk); curRate = null; }
    if (curRate !== undefined && full.rates.length === 1) {
      const rate = full.rates[0]!;
      if (curRate === null) out.rates.new++; else if (curRate === rate) out.rates.same++; else out.rates.differs++;
    }
  }

  // Unidades únicas del archivo
  const unitCodes = new Set(all.filter(({ r }) => r.matchStatus === 'matched' || r.matchStatus === 'unmatched').map(({ r }) => r.unitCode?.trim()).filter((u): u is string => !!u).map(key));
  for (const u of unitCodes) unitSet.has(u) ? out.units.existing++ : out.units.new++;
  const opsByUnit = new Map<string, Set<string>>();
  for (const { r } of eligible) if (r.unitCode?.trim()) { const k = key(r.unitCode); (opsByUnit.get(k) ?? opsByUnit.set(k, new Set()).get(k)!).add(r.operatorCode!.trim()); }
  amb.unitsWithSeveralDrivers = [...opsByUnit.values()].filter((s) => s.size > 1).length;

  return { ...out, uniqueDrivers: groups.size - amb.nationalIdsDiffer, assignmentsResolvable: res, ambiguity: amb };
}

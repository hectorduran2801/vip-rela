import type { DriverRef, ParsedBlock } from './types.js';

const key = (s: string) => s.trim().toUpperCase();

/**
 * Concilia cada fila contra los conductores EXISTENTES (solo lectura) por operator_code + national_id.
 * matched: ambos coinciden con el mismo conductor. conflict: el operador y la cédula apuntan a conductores
 * distintos, o uno existe con el otro dato diferente. duplicate (ya marcado) se conserva salvo conflicto.
 * unmatched: ninguno existe. Las filas 'ignored' no se tocan.
 */
export function reconcile(blocks: ParsedBlock[], drivers: DriverRef[]): void {
  const byOp = new Map(drivers.map((d) => [key(d.operatorCode), d]));
  const byId = new Map(drivers.map((d) => [key(d.nationalId), d]));
  for (const b of blocks) for (const r of b.rows) {
    if (r.matchStatus === 'ignored') continue;
    const dOp = r.operatorCode ? byOp.get(key(r.operatorCode)) : undefined;
    const dId = r.nationalId ? byId.get(key(r.nationalId)) : undefined;
    let status: 'matched' | 'conflict' | 'unmatched' = 'unmatched';
    let driver: DriverRef | undefined;
    if (dOp && dId) { if (dOp.id === dId.id) { status = 'matched'; driver = dOp; } else { status = 'conflict'; r.warnings.push('conflict_operator_and_national_id_belong_to_different_drivers'); } }
    else if (dOp) {
      if (r.nationalId) { status = 'conflict'; r.warnings.push('conflict_operator_exists_with_other_national_id'); }
      else { status = 'matched'; driver = dOp; r.warnings.push('partial_identifier_match'); }
    } else if (dId) {
      if (r.operatorCode) { status = 'conflict'; r.warnings.push('conflict_national_id_exists_with_other_operator'); }
      else { status = 'matched'; driver = dId; r.warnings.push('partial_identifier_match'); }
    }
    if (status === 'conflict') r.matchStatus = 'conflict';
    else if (r.matchStatus === 'duplicate') { /* se conserva */ }
    else { r.matchStatus = status; r.matchedDriverId = driver?.id ?? null; }
  }
}

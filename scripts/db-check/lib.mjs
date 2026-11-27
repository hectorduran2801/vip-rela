// Compatibilidad entre el esquema que espera el código (supabase/schema-manifest.json) y el de una base real.
import { readFileSync } from 'node:fs';

export const INVENTORY_SQL = readFileSync(new URL('./inventory.sql', import.meta.url), 'utf8');

/** Inventario como objeto { "tipo nombre": huella }, ordenado para que el archivo sea estable. */
export async function inventory(client) {
  const rows = (await client.query(INVENTORY_SQL)).rows;
  return Object.fromEntries(rows.map((r) => [r.k, String(r.v)]).sort(([a], [b]) => a.localeCompare(b)));
}

/** missing: lo que el código espera y no está; different: está pero con otra definición. Lo que sobre en la base no es un problema. */
export function compare(expected, actual) {
  return {
    missing: Object.keys(expected).filter((k) => !(k in actual)),
    different: Object.keys(expected).filter((k) => k in actual && actual[k] !== expected[k]),
  };
}

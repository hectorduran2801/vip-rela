-- VIP · 0040 · Una celda SALDO vacía en un Excel IMPORTADO significa «sin deuda de semanas anteriores» = $0.00 (no «saldo desconocido»).
--   · saldo anterior de una asignación gestionada por el Excel = SALDO de la importación MÁS RECIENTE de esa unidad; vacío → 0.
--     Una importación nueva con SALDO vacío reemplaza (no conserva) una deuda anterior obsoleta.
--   · «Nunca importada» sigue siendo distinto: managed = false (cálculo anterior).
--   · saldo_total y detalle_deuda salen de la misma función (app_private.saldo_total, 0038) que Cobranza, vistas previas, mensajes y horarios.
-- No modifica datos. Reversible: restablecer app_private.excel_saldo (0032).
set search_path = public, extensions;

create or replace function app_private.excel_saldo(p_assignment uuid) returns table (managed boolean, saldo_cents bigint, week_start date)
language sql stable security definer set search_path = '' as $$
  select (l.assignment_id is not null),
         case when l.assignment_id is null then null else coalesce(l.saldo_excel_cents, 0) end,
         l.week_start
    from (select 1) one
    left join lateral (select w.assignment_id, w.saldo_excel_cents, w.week_start from public.collection_week_units w
                        where w.assignment_id = p_assignment order by w.week_start desc limit 1) l on true
$$;
revoke all on function app_private.excel_saldo(uuid) from public, anon, authenticated;
grant execute on function app_private.excel_saldo(uuid) to authenticated, service_role;

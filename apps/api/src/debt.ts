/**
 * Regla ÚNICA de VIP: la cartera activa son las asignaciones vigentes. Una asignación está FINALIZADA desde su día de fin (igual que en Cobranza
 * y en los mensajes). Su deuda no se pierde ni se mezcla con la activa: se informa y se consulta aparte.
 */
const ENDED = `(a.valid_to is not null and a.valid_to <= (now() at time zone app_private.tz())::date)`;
/** Saldo de cada asignación: el último del Excel si lo gestiona el Excel; si no, el calculado. */
const POSITIONS = `select p.assignment_id, p.driver_id, ${ENDED} ended, a.valid_to,
    case when e.managed then greatest(coalesce(e.saldo_cents, 0), 0) else p.pending_cents end pending,
    case when e.managed then greatest(-coalesce(e.saldo_cents, 0), 0) else p.credit_cents end credit
  from public.v_assignment_position p join public.assignments a on a.id = p.assignment_id cross join lateral app_private.excel_saldo(p.assignment_id) e`;

export const ACTIVE_TOTALS_SQL = `select coalesce(sum(pending) filter (where not ended), 0)::bigint pending, coalesce(sum(credit) filter (where not ended), 0)::bigint credit,
    count(distinct driver_id) filter (where not ended and pending > 0)::int debtors from (${POSITIONS}) x`;

export const FORMER_DEBTS_SQL = `select x.assignment_id, x.driver_id, u.code unit_code, d.operator_code, btrim(d.first_name || ' ' || coalesce(d.last_name, '')) full_name,
    x.valid_to::text ended_on, x.pending::bigint pending
  from (${POSITIONS}) x join public.assignments a on a.id = x.assignment_id join public.units u on u.id = a.unit_id join public.drivers d on d.id = x.driver_id
  where x.ended and x.pending > 0 order by x.pending desc, u.code`;

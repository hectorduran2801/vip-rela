-- VIP · 0051 · Corrige 0050: en una fila SIN operario, un 0 explícito vuelve a ANULAR el pago ya importado de la asignación que se finalizó
-- (regla «cero explícito anula, celda vacía no modifica»). Solo ceros: la fila no registra pagos nuevos, ni saldo, ni tarifa. No modifica datos por sí sola.
set search_path = public, extensions;
do $mig$
declare d text := pg_get_functiondef('app_private.collection_sync(uuid, date, boolean, text)'::regprocedure);
  old text := 'v_asg_found := false; v_asg_end := null; v_asg_ended := false;          -- sin operario: la fila no mueve pagos, saldo ni tarifa';
  new text := $n$if 0 = any (coalesce(r.day_amounts_cents, '{}'::bigint[]))
           and (asg.valid_to is null or app_private.ended_by_import(asg.id))
           and exists (select 1 from public.excel_payment_days x where x.assignment_id = asg.id and x.week_start = p_week and x.amount_cents > 0) then
          -- hay pagos que anular con un 0 explícito: la fila actúa SOLO sobre esos días de la asignación finalizada
          r.day_amounts_cents := array(select case when t.v = 0 then 0::bigint end from unnest(r.day_amounts_cents) with ordinality t(v, o) order by t.o);
          v_sstate := 'empty'; v_saldo := null; r.daily_rate_cents := null;
          v_asg_end := coalesce(asg.valid_to, v_end); asg.valid_to := v_asg_end; v_asg_ended := true;
        else
          v_asg_found := false; v_asg_end := null; v_asg_ended := false;          -- sin operario: la fila no mueve pagos, saldo ni tarifa
        end if;$n$;
begin
  if position(old in d) = 0 then raise exception 'no se encontró el punto de 0050'; end if;
  execute replace(d, old, new);
end $mig$;
alter function app_private.collection_sync(uuid, date, boolean, text) owner to vip_app;

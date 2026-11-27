-- VIP · 0030 · Jornada diaria de mensajes de cobranza.
-- El control de mensajes es solo del DÍA ACTUAL (America/Panama). A las 12:00 a. m. empieza otra jornada: los indicadores salen de la fecha (nada que reiniciar) y los
-- mensajes de cobranza de días anteriores YA TERMINADOS se eliminan del historial operativo. Se conservan: los pendientes (prepared), en proceso (processing) y con resultado
-- sin confirmar (unconfirmed), cualquiera sea su fecha; los mensajes de otros tipos (prueba, comprobante, mensaje individual); y la auditoría (audit_logs).
-- Esta migración SOLO crea la función; no borra nada al aplicarla. La ejecuta el worker (service_role) una vez por día local, o un SUPER_ADMIN/ADMIN a mano.
-- Efecto lateral conocido: `driver_delete_check` cuenta los mensajes enviados como bloqueo de borrado; tras la purga, un conductor sin historial financiero podrá eliminarse.
-- Reversible: drop function public.purge_collection_messages(). Lo eliminado no se recupera (queda el conteo en auditoría).
set search_path = public, extensions;

create function public.purge_collection_messages() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_start timestamptz := (date_trunc('day', now() at time zone app_private.tz())) at time zone app_private.tz(); v_n int; v_by jsonb;
begin
  if not app_private.is_service() then perform app_private.assert_admin(); end if;
  with d as (
    delete from public.whatsapp_test_messages m
     where m.kind = 'collection_message' and m.created_at < v_start and m.status in ('sent', 'delivered', 'simulated', 'failed', 'cancelled')
    returning m.status),
  g as (select status, count(*) c from d group by status)
  select coalesce(sum(c), 0)::int, coalesce(jsonb_object_agg(status, c), '{}'::jsonb) into v_n, v_by from g;
  if v_n > 0 then
    perform app_private.audit('purge_collection_messages', 'whatsapp_test_message', null, jsonb_build_object('deleted', v_n, 'by_status', v_by, 'before', v_start));
  end if;
  return jsonb_build_object('deleted', v_n, 'by_status', v_by, 'before', v_start);
end $$;
revoke all on function public.purge_collection_messages() from public, anon, authenticated;
grant execute on function public.purge_collection_messages() to service_role;

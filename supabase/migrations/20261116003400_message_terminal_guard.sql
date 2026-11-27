-- 0034 · Un mensaje que ya terminó NO puede volver a ser enviable.
-- Defensa en profundidad: ningún código lo hace hoy, pero la base no lo impedía (un UPDATE directo podía devolver un mensaje
-- «simulated» a «prepared» y el worker lo habría reclamado para enviarlo de verdad cuando se activen los envíos reales).
--   · «simulated» es definitivo: nunca cambia de estado.
--   · «sent», «delivered», «failed» y «cancelled» no vuelven a «prepared» ni a «processing».
create function app_private.message_terminal_guard() returns trigger language plpgsql as $$
begin
  if old.status = 'simulated' and new.status is distinct from 'simulated' then
    raise exception 'simulated_message_is_final' using errcode = '23514', detail = 'Un mensaje simulado nunca puede volver a ser enviable.';
  end if;
  if old.status in ('sent', 'delivered', 'failed', 'cancelled') and new.status in ('prepared', 'processing') then
    raise exception 'finished_message_cannot_reopen' using errcode = '23514', detail = 'Un mensaje terminado no puede volver a la cola de envío.';
  end if;
  return new;
end $$;
create trigger message_terminal_guard before update of status on public.whatsapp_test_messages
  for each row execute function app_private.message_terminal_guard();

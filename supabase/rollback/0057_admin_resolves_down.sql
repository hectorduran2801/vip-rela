-- Reversión de 0057: solo el SUPER_ADMIN resuelve los mensajes de cobranza (definición de 0018). No toca datos.
begin;
create or replace function public.resolve_test_message(p_id uuid, p_arrived boolean, p_note text default null)
returns public.whatsapp_test_messages language plpgsql security definer set search_path = '' as $$
declare r public.whatsapp_test_messages; k text;
begin
  select kind into k from public.whatsapp_test_messages where id = p_id;
  if k = 'driver_message' then perform app_private.assert_admin(); else perform app_private.assert_super(); end if;
  update public.whatsapp_test_messages set status = case when p_arrived then 'sent' else 'failed' end, resolved_by = auth.uid(), resolved_at = now(),
         resolution_note = nullif(btrim(left(p_note, 300)), '')
   where id = p_id and status = 'unconfirmed' returning * into r;
  if not found then raise exception 'not_unconfirmed' using errcode = '55000'; end if;
  perform app_private.audit('whatsapp.test_message.resolved', 'whatsapp_test_message', r.id, jsonb_build_object('arrived', p_arrived));
  return r;
end $$;
commit;

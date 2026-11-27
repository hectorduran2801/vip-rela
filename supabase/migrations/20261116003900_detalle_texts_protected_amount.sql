-- VIP · 0039 · Las frases de {{detalle_deuda}} que recibe el conductor llevan SIEMPRE el marcador dinámico {monto} (el mismo importe que {{saldo_total}}).
--   · «Cuando debe» y «Cuando tiene saldo a favor» deben contener {monto}; «Cuando está al día» no lleva importe.
--   · {monto} es el único marcador permitido (un único importe consolidado) y no se aceptan importes escritos a mano ($).
-- El cálculo NO cambia: sigue siendo app_private.saldo_total (0038), única fuente para Cobranza, variables, vistas previas y horarios.
set search_path = public, extensions;

create or replace function public.save_template_text(p_key text, p_text text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.assert_admin();
  if p_key not in ('detalle_pendiente','detalle_al_dia','detalle_credito') then raise exception 'variable_not_found' using errcode = 'P0002'; end if;
  if nullif(btrim(p_text), '') is null or char_length(p_text) > 300 then raise exception 'invalid_text' using errcode = '22023'; end if;
  if p_text ~ '\{\{' then raise exception 'text_no_variables' using errcode = '22023'; end if;
  if p_text like '%$%' then raise exception 'text_hardcoded_amount' using errcode = '22023'; end if;
  if regexp_replace(p_text, '\{monto\}', '', 'g') ~ '[{}]' then raise exception 'text_bad_marker' using errcode = '22023'; end if;
  if p_key <> 'detalle_al_dia' and position('{monto}' in p_text) = 0 then raise exception 'text_needs_amount' using errcode = '22023'; end if;
  if p_key = 'detalle_al_dia' and position('{monto}' in p_text) > 0 then raise exception 'text_bad_marker' using errcode = '22023'; end if;
  insert into public.template_text_settings(key, text, updated_by) values (p_key, btrim(p_text), auth.uid())
  on conflict (key) do update set text = excluded.text, updated_by = auth.uid(), updated_at = now();
  perform app_private.audit('template_text.saved', 'template_text_settings', null, jsonb_build_object('key', p_key));
end $$;
revoke all on function public.save_template_text(text, text) from public, anon;
grant execute on function public.save_template_text(text, text) to authenticated, service_role;

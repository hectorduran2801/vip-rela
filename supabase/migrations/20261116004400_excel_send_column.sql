-- VIP · 0044 · Columna ENVIAR del Excel de cobranza (sí/no): preselecciona conductores en Cobranza. No envía nada por sí sola.
--   · Se guarda por fila importada; vale la importación APLICADA más reciente. Sin columna = null (no se preselecciona nada).
set search_path = public, extensions;

alter table public.import_rows add column send_flag boolean;

create function app_private.excel_send_flag(p_unit_code text) returns boolean language sql stable security definer set search_path = '' as $$
  select r.send_flag from public.excel_imports i
    join public.import_blocks b on b.import_id = i.id join public.import_rows r on r.block_id = b.id
   where i.status = 'applied' and i.source_kind = 'collection_flat'
     and upper(regexp_replace(r.unit_code, '\s+', '', 'g')) = upper(regexp_replace(p_unit_code, '\s+', '', 'g'))
     and i.id = (select x.id from public.excel_imports x where x.status = 'applied' and x.source_kind = 'collection_flat' order by x.applied_at desc nulls last limit 1)
   limit 1
$$;
revoke all on function app_private.excel_send_flag(text) from public, anon, authenticated;
grant execute on function app_private.excel_send_flag(text) to authenticated, service_role;

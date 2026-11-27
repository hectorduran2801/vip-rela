-- VIP · 0049 · NO APLICAR EN REMOTO sin autorización expresa.
-- Columna MENSAJE del Excel de cobranza: se guarda en la asignación (unidad + conductor) y es la selección INICIAL de destinatarios. No envía nada.
--   · Se actualiza al APLICAR cada importación, solo en la cuenta del archivo. Sin la columna (send_flag null) se conserva lo guardado.
--   · Reutiliza import_rows.send_flag (0044) y sustituye a app_private.excel_send_flag.
set search_path = public, extensions;

alter table public.assignments add column send_default boolean not null default false;

create function app_private.apply_send_selection(p_import uuid) returns void language sql security definer set search_path = '' as $$
  update public.assignments a set send_default = x.flag
    from (select u.id unit_id, i.account_id, bool_or(r.send_flag) flag
            from public.excel_imports i join public.import_blocks b on b.import_id = i.id join public.import_rows r on r.block_id = b.id
            join public.units u on u.account_id = i.account_id and upper(regexp_replace(u.code, '\s+', '', 'g')) = upper(regexp_replace(r.unit_code, '\s+', '', 'g'))
           where i.id = p_import and r.send_flag is not null
           group by u.id, i.account_id) x
   where a.unit_id = x.unit_id and a.account_id = x.account_id and (a.valid_to is null or a.valid_to >= (now() at time zone app_private.tz())::date)
     and a.send_default is distinct from x.flag
$$;
create function app_private.on_import_applied() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'applied' and new.source_kind = 'collection_flat' then perform app_private.apply_send_selection(new.id); end if;
  return null;
end $$;
create trigger send_selection after insert or update of status on public.excel_imports for each row execute function app_private.on_import_applied();
revoke all on function app_private.apply_send_selection(uuid), app_private.on_import_applied() from public, anon, authenticated;

-- Lo ya importado (si traía la columna).
do $$ declare r record; begin
  for r in select distinct on (account_id) id from public.excel_imports where status = 'applied' and source_kind = 'collection_flat' order by account_id, applied_at desc nulls last loop
    perform app_private.apply_send_selection(r.id);
  end loop;
end $$;
drop function app_private.excel_send_flag(text);

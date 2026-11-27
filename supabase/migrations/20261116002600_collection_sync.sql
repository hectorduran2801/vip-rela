-- VIP · 0026 · Sincronización de la COBRANZA del Excel en formato PLANO (una fila = una unidad; LUNES…DOMINGO = pagos recibidos).
-- ADITIVA y NO destructiva: no modifica ni borra filas existentes. Cambios sobre estructura existente (cada uno justificado):
--   · `drivers.national_id` deja de ser NOT NULL (la cédula del operario es opcional; UNIQUE admite varios NULL). Ninguna fila cambia.
--   · Se QUITA la restricción de exclusión «un conductor no puede tener asignaciones solapadas» (assignments, por driver_id): un operario puede llevar
--     2+ unidades a la vez (una asignación por unidad; cobranza, pagos y saldos siguen separados por asignación). La exclusión por UNIDAD se conserva
--     (una unidad nunca tiene dos conductores a la vez). No se borra ni se altera ninguna asignación; es relajar una regla, reversible con el mismo `exclude`.
--   · `excel_imports.source_kind` amplía su CHECK con 'collection_flat' (drop + add del CHECK: no toca datos; los valores existentes siguen válidos).
--   · NO se toca `reassign_unit` (conserva su aviso `driver_already_assigned` para el flujo manual de la interfaz); la sincronización gestiona sus propias asignaciones.
-- Piezas nuevas: tablas excel_payment_days / excel_payment_changes (pagos del Excel idempotentes + auditoría append-only),
--   collection_week_units / collection_week_unit_changes (foto semanal por unidad + historial), y las funciones
--   public.preview_collection_sync (solo lectura) y public.apply_collection_sync (transaccional, idempotente), ambas ADMIN+.
--
-- REGLAS (confirmadas por el dueño):
--  1. SALDO = CONCILIACIÓN semanal, nunca deuda/pago duplicado: delta = SALDO − assignment_position(asignación, DOMINGO anterior).pending_cents.
--     Los movimientos de conciliación se fechan ese domingo, por lo que reimportar la semana con otro SALDO solo crea la DIFERENCIA adicional.
--     delta>0 → cargo `opening` si la asignación aún no tiene (índice único: uno por asignación); si ya tiene, ajuste positivo (cargo `adjustment`).
--     delta<0 → ajuste negativo auditado (crédito). Sin diferencia no se crea nada. SALDO vacío = sin dato; 0 explícito sí concilia.
--  2. Cuota (CUENTA) 0 → advertencia informativa, sin tarifa ni cargos; vacía = sin cambio; distinta de la vigente → nueva tarifa con change_rate (0021),
--     desde el lunes de la semana o, si ya hay cargos generados desde esa fecha, desde el día siguiente al último cargo (hacia adelante: nunca se reescribe nada).
--  5. Pagos LUN–DOM idempotentes por (asignación, fecha): celda vacía = sin dato; mismo valor = 0 movimientos; cambio = anular el vigente (void_payment) y
--     registrar el nuevo (método 'excel'); 0 explícito = anular sin reemplazo. Neto final = importe del Excel; nunca se borra nada.
--  7. Unidades por código (sin mayúsculas/espacios): igual no se toca; distinto → solo los campos distintos; nueva → crear; ausente → no se toca.
--  8. Foto semanal por (semana, unidad); sus cambios se conservan en collection_week_unit_changes.
-- NOTA PARA EL PARSER (siguiente fase): `import_rows.day_amounts_cents` YA distingue celda vacía (elemento NULL) de 0 explícito (0), igual que
--   `daily_rate_cents` (NULL vs 0) y `raw_saldo` (NULL/'' vs '0'); no hace falta columna nueva. El parser debe marcar el archivo con
--   `excel_imports.source_kind = 'collection_flat'` y dejar los 7 importes (lun→dom) en `day_amounts_cents` y el teléfono normalizado en `phone_e164`.
set search_path = public, extensions;

-- ───────── 1. Restricciones relajadas ─────────
alter table public.drivers alter column national_id drop not null;

do $$
declare v_name text;
begin
  select c.conname into v_name from pg_constraint c
   where c.conrelid = 'public.assignments'::regclass and c.contype = 'x' and pg_get_constraintdef(c.oid) ilike '%(driver_id WITH =%';
  if v_name is not null then execute format('alter table public.assignments drop constraint %I', v_name); end if;
end $$;

do $$
declare v_name text;
begin
  select c.conname into v_name from pg_constraint c
   where c.conrelid = 'public.excel_imports'::regclass and c.contype = 'c' and pg_get_constraintdef(c.oid) like '%source_kind%';
  if v_name is null then raise exception 'No se encontró el CHECK de excel_imports.source_kind'; end if;
  execute format('alter table public.excel_imports drop constraint %I', v_name);
end $$;
alter table public.excel_imports add constraint excel_imports_source_kind_check check (source_kind in ('cobranza', 'directory', 'collection_flat'));

-- ───────── 2. Estado de los pagos importados (idempotencia) + auditoría append-only ─────────
create table public.excel_payment_days (
  assignment_id uuid not null references public.assignments(id),
  pay_date date not null,
  week_start date not null,
  driver_id uuid not null references public.drivers(id),         -- operario de la asignación en ese período
  amount_cents bigint not null check (amount_cents >= 0),          -- importe VIGENTE importado (0 = anulado sin reemplazo)
  payment_id uuid references public.payments(id),                  -- pago vigente (null si el importe es 0)
  revision int not null default 1 check (revision >= 1),           -- sube en cada cambio: forma parte de la idempotency_key del pago
  first_import_id uuid, last_import_id uuid,                       -- sin FK a propósito: el staging puede limpiarse
  last_imported_at timestamptz not null default now(),
  primary key (assignment_id, pay_date),
  check (week_start = pay_date - (extract(isodow from pay_date)::int - 1)),
  check ((amount_cents = 0) = (payment_id is null))
);
create index excel_payment_days_week_idx on public.excel_payment_days(week_start);

create table public.excel_payment_changes (
  id bigint generated always as identity primary key,
  assignment_id uuid not null references public.assignments(id),
  pay_date date not null,
  week_start date not null,
  driver_id uuid not null references public.drivers(id),
  previous_cents bigint,                                           -- null = no había pago importado
  new_cents bigint not null check (new_cents >= 0),
  delta_cents bigint not null,
  action text not null check (action in ('create', 'change', 'zero')),
  previous_payment_id uuid references public.payments(id),
  new_payment_id uuid references public.payments(id),
  import_id uuid,
  changed_by uuid references public.profiles(id),
  changed_at timestamptz not null default now()
);
create index excel_payment_changes_asg_idx on public.excel_payment_changes(assignment_id, pay_date, id);
create trigger no_mutation before update or delete on public.excel_payment_changes for each row execute function app_private.block_mutation();

-- ───────── 3. Foto semanal por (semana, unidad) + historial append-only ─────────
-- Sin FK a unidad/asignación/conductor a propósito (como charges.source_import_id): es una foto HISTÓRICA y no debe impedir eliminar maestros sin movimientos.
create table public.collection_week_units (
  week_start date not null check (extract(isodow from week_start) = 1),
  unit_id uuid not null,
  unit_code text not null,
  assignment_id uuid,
  driver_id uuid,
  operator_code text,
  daily_rate_cents bigint check (daily_rate_cents is null or daily_rate_cents >= 0),   -- cuota efectiva de esa semana (Excel; vacío = la vigente)
  agreement text,                                                                       -- acuerdo vigente tras sincronizar
  phone_e164 text,                                                                      -- WhatsApp del operario tras sincronizar
  saldo_excel_cents bigint,                                                             -- SALDO del Excel (null = vacío / sin dato)
  saldo_pending_before_cents bigint,                                                    -- deuda pendiente que VIP calculaba al domingo anterior ANTES de conciliar
  saldo_delta_cents bigint not null default 0,                                          -- conciliación aplicada acumulada de la semana (+ deuda, − crédito)
  saldo_steps int not null default 0,                                                   -- cuántos movimientos de conciliación lleva la semana (clave de idempotencia)
  first_import_id uuid, last_import_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (week_start, unit_id)
);
create unique index collection_week_units_asg_uq on public.collection_week_units(week_start, assignment_id) where assignment_id is not null;

create table public.collection_week_unit_changes (
  id bigint generated always as identity primary key,
  week_start date not null,
  unit_id uuid not null,
  unit_code text not null,
  previous jsonb,                                                   -- null = primera foto de esa semana/unidad
  new jsonb not null,
  changed_fields text[] not null,
  import_id uuid,
  changed_by uuid references public.profiles(id),
  changed_at timestamptz not null default now()
);
create index collection_week_unit_changes_idx on public.collection_week_unit_changes(week_start, unit_id, id);
create trigger no_mutation before update or delete on public.collection_week_unit_changes for each row execute function app_private.block_mutation();

-- RLS: lectura para el personal; escritura solo vía funciones (security definer).
do $$ declare t text; begin
  foreach t in array array['excel_payment_days', 'excel_payment_changes', 'collection_week_units', 'collection_week_unit_changes'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
    execute format('create policy %I on public.%I for select to authenticated using (app_private.is_staff())', t || '_select', t);
  end loop;
end $$;
grant usage, select on sequence public.excel_payment_changes_id_seq, public.collection_week_unit_changes_id_seq to service_role;

-- ───────── 4. Utilidad: advertencias con forma fija ─────────
create function app_private.cs_warn(p_row int, p_col text, p_code text, p_msg text, p_level text default 'warning') returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object('row', p_row, 'column', p_col, 'code', p_code, 'message', p_msg, 'level', p_level)
$$;
revoke all on function app_private.cs_warn(int, text, text, text, text) from public, anon, authenticated;

-- ───────── 5. Núcleo compartido: vista previa (p_apply = false, sin escrituras) y aplicación (p_apply = true) ─────────
-- Una sola lógica para ambas: lo que la vista previa muestra es lo que la aplicación hace.
create function app_private.collection_sync(p_import uuid, p_week date, p_apply boolean, p_note text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_imp record; v_tz text := app_private.tz(); v_today date := (now() at time zone app_private.tz())::date;
  r record; u record; drv record; asg record; snap record; v_dups text[]; i int; d date; v_seen_ops text[] := '{}'; v_first_op boolean; v_pre bigint; v_conf text[]; v_born boolean; v_asg_end date; v_asg_ended boolean;
  v_days constant text[] := array['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];
  v_st_found boolean; v_st_pay uuid; v_st_amt bigint; v_st_rev int; v_zero constant uuid := '00000000-0000-0000-0000-000000000000';
  c_total int := 0; c_unchanged int := 0; c_changed int := 0; c_new int := 0; c_nodrv int := 0; c_err int := 0; c_empty int := 0; c_blocked int := 0;
  p_new int := 0; p_chg int := 0; p_zero int := 0; p_same int := 0; p_skip int := 0; p_rej int := 0; p_net bigint := 0;
  s_create int := 0; s_same int := 0; s_adj int := 0; s_empty int := 0; s_inv int := 0; s_noasg int := 0; s_delta bigint := 0;
  c_drv_created int := 0; c_drv_updated int := 0; c_snap_new int := 0; c_snap_chg int := 0; c_rate int := 0; c_units_created int := 0; c_asg_created int := 0;
  v_warn jsonb := '[]'::jsonb; v_rates jsonb := '[]'::jsonb; v_touched uuid[] := '{}'; v_touched_date date := null;
  -- por fila
  v_unorm text; v_ucode text; v_op text; v_nid text; v_ag text; v_name text; v_has_data boolean; v_raw text; v_num text; v_dec numeric; v_saldo bigint; v_sstate text; v_phone text;
  v_unit_exists boolean; v_unit_id uuid; v_unit_new boolean; v_drv_id uuid; v_drv_new boolean; v_fill_nid boolean; v_drv_active boolean; v_drv_phone text; v_cur_name text;
  v_asg_found boolean; v_asg_id uuid; v_asg_create boolean; v_op_change boolean; v_fin_block boolean; v_changed boolean; v_has_asg boolean; v_closed boolean;
  v_carry bigint; v_ag_cur text; v_ag_change boolean; v_phone_set boolean; v_rate_done boolean; v_cur_rate bigint; v_from date; v_last_ch date; v_fail text;
  v_new_rate bigint; v_eff_rate bigint; v_eff_ag text; v_eff_phone text; v_eff_op text; v_pending bigint; v_delta bigint; v_opening boolean; v_steps int; v_prev_delta bigint;
  v_cum_delta bigint; v_orig_pending bigint; v_saldo_keep bigint; v_week_ch bigint; v_week_n int;
  -- por día
  v_new bigint; v_prev bigint; v_act text; v_why text; v_key text; v_rev int; v_ok boolean; v_err text; v_res jsonb; v_new_pay uuid; v_prev_active boolean; v_paid_at timestamptz; v_txt text;
  v_snap_new jsonb; v_snap_old jsonb; v_fields text[]; v_new_cum int;
  v_method uuid; v_drv_final uuid; v_pdrv record; v_adj uuid; v_charge boolean;
begin
  if p_week is null or extract(isodow from p_week) <> 1 then raise exception 'week_start_must_be_monday' using errcode = '22023'; end if;
  select i.* into v_imp from public.excel_imports i where i.id = p_import for update;
  if not found then raise exception 'import_not_found' using errcode = 'P0002'; end if;
  if v_imp.source_kind <> 'collection_flat' then raise exception 'wrong_import_kind' using errcode = '22023'; end if;
  if v_imp.status = 'rejected' or (p_apply and v_imp.status not in ('confirmed', 'applied')) then raise exception 'import_not_confirmed' using errcode = '22023'; end if;
  if p_apply then perform pg_advisory_xact_lock(7405211, (p_week - date '2000-01-01')); end if;      -- una sincronización a la vez por semana

  select coalesce(array_agg(k), '{}') into v_dups from (
    select upper(regexp_replace(ir.unit_code, '\s+', '', 'g')) k from public.import_rows ir join public.import_blocks b on b.id = ir.block_id
     where b.import_id = p_import and ir.match_status <> 'ignored' and ir.review_status <> 'rejected' and nullif(btrim(coalesce(ir.unit_code, '')), '') is not null
     group by 1 having count(*) > 1) x;

  -- Un mismo código de operario con nombres distintos es un conflicto de identidad para REVISIÓN MANUAL: solo se acepta que sean iguales (sin mayúsculas, tildes ni espacios) o que uno
  -- esté contenido en el otro (nombre abreviado). Compartir una palabra NO basta (Juan Carlos Pérez ≠ Juan Carlos Rodríguez). No se unifica nada automáticamente.
  select coalesce(array_agg(distinct x.op), '{}') into v_conf from (
    select nullif(btrim(ir.operator_code), '') op, app_private.name_tokens(ir.full_name) tk, ir.id rid
      from public.import_rows ir join public.import_blocks b on b.id = ir.block_id
     where b.import_id = p_import and ir.match_status <> 'ignored' and ir.review_status <> 'rejected' and nullif(btrim(ir.operator_code), '') is not null
       and nullif(btrim(ir.operator_code), '') !~ '^0+$' and cardinality(app_private.name_tokens(ir.full_name)) > 0) x
    join (select nullif(btrim(ir.operator_code), '') op, app_private.name_tokens(ir.full_name) tk, ir.id rid
      from public.import_rows ir join public.import_blocks b on b.id = ir.block_id
     where b.import_id = p_import and ir.match_status <> 'ignored' and ir.review_status <> 'rejected' and nullif(btrim(ir.operator_code), '') is not null
       and nullif(btrim(ir.operator_code), '') !~ '^0+$' and cardinality(app_private.name_tokens(ir.full_name)) > 0) y
      on y.op = x.op and y.rid <> x.rid and not (x.tk <@ y.tk or y.tk <@ x.tk);

  for r in select ir.* from public.import_rows ir join public.import_blocks b on b.id = ir.block_id
            where b.import_id = p_import and ir.match_status <> 'ignored' and ir.review_status <> 'rejected' order by b.block_index, ir.source_row loop
    v_unorm := upper(regexp_replace(coalesce(r.unit_code, ''), '\s+', '', 'g'));
    v_op := nullif(btrim(coalesce(r.operator_code, '')), ''); if v_op ~ '^0+$' then v_op := null; end if;            -- 0 / vacío = sin operario
    v_nid := nullif(btrim(coalesce(r.national_id, '')), ''); if v_nid ~ '^0+$' then v_nid := null; end if;            -- 0 / vacío = cédula ausente
    v_ag := nullif(regexp_replace(btrim(coalesce(r.raw_agreement, '')), '\s+', ' ', 'g'), '');
    v_name := nullif(regexp_replace(btrim(coalesce(r.full_name, '')), '\s+', ' ', 'g'), '');   -- nombre COMPLETO tal cual (sin dividir)
    v_raw := nullif(btrim(coalesce(r.raw_saldo, '')), '');
    v_phone := case when btrim(coalesce(r.phone_e164, '')) ~ '^\+[1-9][0-9]{7,14}$' then btrim(r.phone_e164) end;
    v_has_data := v_op is not null or v_nid is not null or v_name is not null or v_ag is not null or v_raw is not null or coalesce(r.daily_rate_cents, 0) > 0
                  or v_phone is not null or exists (select 1 from unnest(coalesce(r.day_amounts_cents, '{}'::bigint[])) x where x is not null);
    if v_unorm = '' then
      if v_has_data then c_err := c_err + 1; v_warn := v_warn || app_private.cs_warn(r.source_row, 'und', 'missing_unit', 'La fila tiene datos pero no código de unidad: se omite.', 'error');
      else c_empty := c_empty + 1; end if;
      continue;
    end if;
    c_total := c_total + 1;
    v_pre := c_new + c_drv_created + c_drv_updated + c_asg_created + p_new + p_chg + p_zero + s_create + s_adj + c_rate + c_snap_chg;
    if v_op is not null and v_op = any (v_conf) then
      c_err := c_err + 1; v_warn := v_warn || app_private.cs_warn(r.source_row, 'operador', 'operator_identity_conflict', 'El operario ' || v_op || ' aparece con nombres de personas distintas en el archivo: corrige el código o el nombre antes de guardar.', 'error'); continue;
    end if;
    if v_unorm = any (v_dups) then
      c_err := c_err + 1; v_warn := v_warn || app_private.cs_warn(r.source_row, 'und', 'duplicate_unit', 'La unidad aparece más de una vez en el archivo: se omiten esas filas.', 'error'); continue;
    end if;

    -- ── SALDO (interpretación; la conciliación va después) ──
    v_saldo := null;
    if v_raw is null then v_sstate := 'empty';
    else
      v_num := regexp_replace(v_raw, '^\$\s*', '');
      if v_num ~ '^-?[0-9]+,[0-9]{3}$' then v_sstate := 'text';
      -- un SALDO negativo es CRÉDITO a favor (se concilia como ajuste negativo)
      elsif v_num ~ '^-?[0-9]+([.,][0-9]+)?$' then v_dec := replace(v_num, ',', '.')::numeric; v_saldo := round(v_dec * 100)::bigint; v_sstate := 'amount';
      else v_sstate := 'text'; end if;
    end if;

    -- ── Unidad ──
    select un.* into u from public.units un where upper(regexp_replace(un.code, '\s+', '', 'g')) = v_unorm order by un.created_at limit 1;
    v_unit_exists := found; v_unit_id := case when v_unit_exists then u.id end; v_unit_new := not v_unit_exists;
    v_ucode := case when v_unit_exists then u.code else btrim(r.unit_code) end;
    v_changed := false; v_fin_block := false; v_fill_nid := false; v_drv_new := false; v_drv_id := null; v_drv_active := true; v_drv_phone := null; v_cur_name := null;
    v_asg_create := false; v_op_change := false; v_rate_done := false; v_phone_set := false; v_ag_change := false; v_carry := null;

    -- ── Operario ──
    if v_op is not null then
      select dd.* into drv from public.drivers dd where dd.operator_code = v_op;
      if found then
        v_drv_id := drv.id; v_drv_active := drv.active; v_drv_phone := drv.phone_e164;
        v_cur_name := regexp_replace(btrim(coalesce(drv.first_name, '') || ' ' || coalesce(drv.last_name, '')), '\s+', ' ', 'g');
        if v_name is not null and cardinality(app_private.name_tokens(v_cur_name)) > 0 and cardinality(app_private.name_tokens(v_name)) > 0 and not (app_private.name_tokens(v_cur_name) <@ app_private.name_tokens(v_name) or app_private.name_tokens(v_name) <@ app_private.name_tokens(v_cur_name)) then
          c_err := c_err + 1; v_warn := v_warn || app_private.cs_warn(r.source_row, 'operador', 'operator_identity_conflict', 'El operario ' || v_op || ' está registrado como «' || v_cur_name || '» y el Excel trae «' || v_name || '»: pueden ser personas distintas. Revisa a mano antes de guardar.', 'error'); continue;
        end if;
        -- La cédula es OPCIONAL y secundaria: solo completa la que falta; nunca sobrescribe, nunca bloquea ni genera avisos (lo que identifica es el código de operario).
        if v_nid is not null and drv.national_id is null and not exists (select 1 from public.drivers x where x.national_id = v_nid and x.id <> drv.id) then v_fill_nid := true; end if;
      else
        v_drv_new := true;
        if v_nid is not null and exists (select 1 from public.drivers x where x.national_id = v_nid) then v_nid := null; end if;      -- cédula ya usada por otro operario: se crea sin cédula (sin error)
      end if;
    else c_nodrv := c_nodrv + 1;
    end if;

    -- ── Asignación de la unidad en la semana ──
    select a.* into asg from public.assignments a where a.unit_id = coalesce(v_unit_id, v_zero) and a.valid_from <= p_week + 6 and (a.valid_to is null or a.valid_to >= p_week)
     order by a.valid_from desc limit 1;
    v_asg_found := found;
    v_asg_end := case when v_asg_found then asg.valid_to end;
    v_asg_ended := v_asg_found and v_asg_end is not null and v_asg_end <= (now() at time zone app_private.tz())::date;       -- asignación ya terminada (p. ej. desvinculada)
    if not v_asg_found and v_unit_exists and exists (select 1 from public.assignments a2 where a2.unit_id = v_unit_id and a2.valid_from > p_week + 6) then
      c_err := c_err + 1; v_warn := v_warn || app_private.cs_warn(r.source_row, 'semana', 'historical_before_assignment', 'La unidad tiene una asignación que empieza después de esa semana: no se importan datos anteriores a su asignación actual (no se modifica nada).', 'error'); continue;
    end if;
    -- Unidad DESVINCULADA a mano (end_assignment): si el Excel todavía la trae con el mismo operario (dato desactualizado), NO se reasigna sola; se muestra como conflicto.
    -- Un operario distinto sí es una asignación nueva legítima. Reasignar a propósito se hace con «Asignar conductor».
    if v_asg_ended and v_op is not null
       and exists (select 1 from public.drivers d3 where d3.id = asg.driver_id and d3.operator_code = v_op)
       and exists (select 1 from public.audit_logs l where l.action = 'end_assignment' and l.entity_id = asg.id) then
      c_err := c_err + 1; v_warn := v_warn || app_private.cs_warn(r.source_row, 'operador', 'unit_unlinked_manually', 'La unidad fue desvinculada del operario ' || v_op || ' en VIP (' || to_char(v_asg_end, 'DD/MM/YYYY') || ') y el Excel todavía la trae con él: no se reasigna sola. Deja el operario vacío (0) en esa fila, o reasigna a propósito desde Unidades → Asignar conductor.', 'error'); continue;
    end if;
    if v_unit_exists and v_op is not null and not v_asg_found and exists (
         select 1 from public.assignments a2 join public.drivers d2 on d2.id = a2.driver_id
          where a2.unit_id = v_unit_id and a2.valid_to is not null and d2.operator_code = v_op
            and exists (select 1 from public.audit_logs l where l.action = 'end_assignment' and l.entity_id = a2.id)
            and not exists (select 1 from public.assignments a3 where a3.unit_id = v_unit_id and a3.valid_from > a2.valid_to)) then
      c_err := c_err + 1; v_warn := v_warn || app_private.cs_warn(r.source_row, 'operador', 'unit_unlinked_manually', 'La unidad fue desvinculada del operario ' || v_op || ' en VIP y el Excel todavía la trae con él: no se reasigna sola. Deja el operario vacío (0) en esa fila, o reasigna a propósito desde Unidades → Asignar conductor.', 'error'); continue;
    end if;
    if v_op is not null then
      if v_asg_found and (v_drv_new or asg.driver_id <> v_drv_id) then
        -- Cambio de operario: cierra la vigente (valid_to) y abre otra desde el lunes; solo si no reescribe historia ya cobrada.
        v_fail := case
          when asg.valid_from >= p_week then 'la asignación vigente empieza dentro de esa semana'
          when asg.valid_to is not null then 'la asignación vigente ya tiene fecha de fin'
          when exists (select 1 from public.charges c where c.assignment_id = asg.id and c.kind = 'daily' and c.charge_date >= p_week) then 'la asignación vigente ya tiene cuotas generadas desde ese lunes'
          when exists (select 1 from public.rates rt where rt.assignment_id = asg.id and rt.valid_from >= p_week) then 'la asignación vigente tiene una tarifa que empieza desde ese lunes'
          when exists (select 1 from public.weekly_closures w where w.assignment_id = asg.id and w.week_start >= p_week) then 'la semana ya está cerrada para la asignación vigente' end;
        if v_fail is not null then
          v_fin_block := true; c_blocked := c_blocked + 1;
          v_warn := v_warn || app_private.cs_warn(r.source_row, 'operador', 'operator_change_retroactive', 'No se cambia el operario de la unidad: ' || v_fail || '. Se omiten sus pagos, saldo y tarifa.', 'blocking');
        else v_op_change := true; v_changed := true; end if;
      elsif not v_asg_found then v_asg_create := true; v_changed := true; end if;
    end if;
    v_asg_id := case when v_asg_found and not v_op_change then asg.id end;       -- la asignación de la semana (null si hay que crearla)
    v_has_asg := v_asg_found or v_asg_create;
    v_closed := v_asg_id is not null and exists (select 1 from public.weekly_closures w where w.assignment_id = v_asg_id and w.week_start = p_week);
    if v_closed then
      v_fin_block := true; c_blocked := c_blocked + 1;
      v_warn := v_warn || app_private.cs_warn(r.source_row, 'semana', 'week_closed', 'La semana ya está cerrada para esta asignación: no se aplican cambios retroactivos (pagos, saldo ni tarifa).', 'blocking');
    end if;
    v_eff_op := coalesce(v_op, case when v_asg_found then (select dd.operator_code from public.drivers dd where dd.id = asg.driver_id) end);

    -- ── Aplicar: unidad, operario, asignación ──
    if p_apply then
      if v_unit_new then
        perform set_config('vip.source', 'import', true);
        insert into public.units(code, agreement) values (btrim(r.unit_code), case when length(v_ag) <= 200 then v_ag end) returning id into v_unit_id;
        perform set_config('vip.source', '', true);
        c_units_created := c_units_created + 1;
      end if;
    end if;
    if v_unit_new then c_new := c_new + 1; end if;

    -- Operario: crear / completar cédula (sin tocar consentimiento ni nombre existentes)
    if v_drv_new and not v_fin_block then
      c_drv_created := c_drv_created + 1; v_changed := true;
      if p_apply then
        insert into public.drivers(operator_code, national_id, first_name, last_name, phone_e164, status)
        values (v_op, v_nid, coalesce(v_name, 'Sin nombre'), '', v_phone, 'active') returning id into v_drv_id;
        v_phone_set := v_phone is not null;
      end if;
      v_drv_phone := v_phone;
    elsif v_drv_new and v_fin_block then v_drv_new := false;
    end if;
    if v_fill_nid and not v_fin_block then
      c_drv_updated := c_drv_updated + 1; v_changed := true;
      if p_apply then update public.drivers set national_id = v_nid where id = v_drv_id and national_id is null; end if;
    end if;

    -- Nombre completo del operario existente: se compara contra first_name || ' ' || last_name (sin mayúsculas ni espacios repetidos).
    -- Igual = sin escribir ni auditar; distinto = first_name := nombre completo, last_name := ''; vacío en el Excel = nunca sobrescribe.
    -- La tabla drivers audita el UPDATE (valor anterior/nuevo, usuario); además se deja constancia con la importación.
    v_first_op := v_op is not null and not (v_op = any (v_seen_ops));      -- operario con varias unidades: solo la primera fila fija su nombre (así reimportar no alterna entre variantes)
    if v_op is not null then v_seen_ops := v_seen_ops || v_op; end if;
    if v_name is not null and v_op is not null and v_first_op and not v_fin_block and not v_drv_new and v_drv_id is not null
       and lower(v_cur_name) <> lower(v_name) then
      c_drv_updated := c_drv_updated + 1; v_changed := true;
      if p_apply then
        update public.drivers set first_name = v_name, last_name = '' where id = v_drv_id;
        perform app_private.audit('import_driver_name_change', 'drivers', v_drv_id, jsonb_build_object('import_id', p_import, 'operator_code', v_op,
          'previous', v_cur_name, 'new', v_name));
      end if;
    end if;

    -- Teléfono: completa solo si falta; uno distinto NO se pisa (nunca concede consentimiento)
    if v_phone is not null and v_op is not null and not v_fin_block and not v_drv_new then
      if v_drv_phone is null then
        v_phone_set := true; v_changed := true; c_drv_updated := c_drv_updated + 1; v_drv_phone := v_phone;
        if p_apply then update public.drivers set phone_e164 = v_phone where id = v_drv_id and phone_e164 is null; end if;
      elsif v_drv_phone <> v_phone then
        v_warn := v_warn || app_private.cs_warn(r.source_row, 'whatsapp', 'phone_conflict', 'El WhatsApp del Excel difiere del registrado: no se modifica.');
      end if;
    elsif btrim(coalesce(r.raw_phone, '')) <> '' and v_phone is null then
      v_warn := v_warn || app_private.cs_warn(r.source_row, 'whatsapp', 'phone_invalid', 'El WhatsApp del Excel no es un número válido: se ignora.', 'info');
    end if;

    -- Acuerdo: texto libre; vacío = sin cambio; distinto = actualiza con historial
    v_ag_cur := case when v_unit_exists then u.agreement end;
    if v_ag is not null then
      if length(v_ag) > 200 then v_warn := v_warn || app_private.cs_warn(r.source_row, 'acuerdo', 'agreement_too_long', 'El acuerdo supera 200 caracteres: no se guarda.');
      elsif v_unit_exists and (v_ag_cur is null or upper(regexp_replace(btrim(v_ag_cur), '\s+', ' ', 'g')) <> upper(v_ag)) then
        v_ag_change := true; v_changed := true;
        if p_apply then
          perform set_config('vip.source', 'import', true);
          update public.units set agreement = v_ag where id = v_unit_id;
          perform set_config('vip.source', '', true);
        end if;
      end if;
    end if;
    v_eff_ag := case when v_ag is not null and length(v_ag) <= 200 and not (v_unit_exists and not v_ag_change) then v_ag else v_ag_cur end;
    if v_unit_exists and not v_ag_change then v_eff_ag := v_ag_cur; end if;

    -- Cuota vigente y cuota nueva
    if v_asg_found then
      select rt.daily_amount_cents into v_cur_rate from public.rates rt where rt.assignment_id = asg.id and rt.valid_from <= p_week + 6 and (rt.valid_to is null or rt.valid_to >= p_week + 6) limit 1;
    else v_cur_rate := null; end if;
    v_new_rate := r.daily_rate_cents;
    if v_new_rate is not null and v_new_rate = 0 then
      v_warn := v_warn || app_private.cs_warn(r.source_row, 'cuenta', 'rate_zero', 'La cuota (CUENTA) es 0: la unidad se importa sin crear tarifa ni cargos.', 'info');
    elsif v_new_rate is not null and v_new_rate < 0 then
      v_warn := v_warn || app_private.cs_warn(r.source_row, 'cuenta', 'rate_invalid', 'La cuota es negativa: se ignora.'); v_new_rate := null;
    end if;

    -- Cambio de operario / asignación nueva (apply)
    if p_apply and (v_op_change or v_asg_create) and not v_fin_block then
      if v_op_change then
        select rt.daily_amount_cents into v_carry from public.rates rt where rt.assignment_id = asg.id and rt.valid_to is null;
        update public.assignments set valid_to = p_week - 1 where id = asg.id;
        update public.rates set valid_to = p_week - 1 where assignment_id = asg.id and valid_to is null;
      end if;
      begin
        insert into public.assignments(driver_id, unit_id, valid_from) values (v_drv_id, v_unit_id, p_week) returning id into v_asg_id;
        c_asg_created := c_asg_created + 1;
        if coalesce(nullif(v_new_rate, 0), nullif(v_carry, 0)) is not null then
          insert into public.rates(assignment_id, daily_amount_cents, valid_from, reason)
          values (v_asg_id, coalesce(nullif(v_new_rate, 0), nullif(v_carry, 0)), p_week, 'Tarifa inicial de la asignación (Excel, semana ' || p_week || ')');
        end if;
        v_rate_done := true;
      exception when exclusion_violation then
        raise exception 'assignment_overlap' using errcode = '23P01', hint = 'Fila ' || r.source_row || ': la unidad tiene otra asignación que se solapa.';
      end;
      v_has_asg := true;
    elsif (v_op_change or v_asg_create) and not v_fin_block then
      v_rate_done := true; c_asg_created := c_asg_created + 1;
      if v_op_change then select rt.daily_amount_cents into v_carry from public.rates rt where rt.assignment_id = asg.id and rt.valid_to is null; end if;
    end if;
    -- cuota efectiva de la semana (foto)
    v_eff_rate := case when v_new_rate is not null then v_new_rate when v_op_change or v_asg_create then v_carry else v_cur_rate end;
    if v_op_change or v_asg_create then v_eff_rate := coalesce(v_new_rate, v_carry); end if;

    -- Tarifa: cambio hacia adelante con el historial de 0021 (nunca reescribe cargos generados)
    v_born := false;
    if v_new_rate is not null and v_new_rate > 0 and v_asg_found and not v_asg_ended and not v_op_change and not v_fin_block and v_asg_id is not null and v_cur_rate is distinct from v_new_rate then
      -- CORRECCIÓN: la cuota vigente nació en esta semana (o después) → se corrigió un dato mal cargado: se corrige en su lugar, con historial y ajuste de lo ya generado.
      -- CAMBIO CONTRACTUAL: la cuota vigente viene de antes → rige hacia adelante (change_rate), como siempre.
      v_born := exists (select 1 from public.rates rt where rt.assignment_id = v_asg_id and rt.valid_to is null and rt.valid_from >= p_week)
                and not exists (select 1 from public.weekly_closures w where w.assignment_id = v_asg_id and w.week_start >= p_week);
    end if;
    if v_born and v_new_rate is not null and v_new_rate > 0 and v_asg_found and not v_asg_ended and not v_op_change and not v_fin_block and v_asg_id is not null and v_cur_rate is distinct from v_new_rate then
      if p_apply then perform app_private.correct_rate(v_asg_id, v_new_rate, p_week, p_import, r.id); end if;
      c_rate := c_rate + 1; v_changed := true;
      v_rates := v_rates || jsonb_build_object('row', r.source_row, 'unit_code', btrim(r.unit_code), 'assignment_id', v_asg_id, 'previous_cents', v_cur_rate, 'new_cents', v_new_rate,
        'kind', 'correction', 'effective_from', p_week, 'existing_charges_unchanged', 0);
      v_born := false;
    elsif v_new_rate is not null and v_new_rate > 0 and v_asg_found and not v_asg_ended and not v_op_change and not v_fin_block and v_asg_id is not null and v_cur_rate is distinct from v_new_rate then
      select max(c.charge_date) into v_last_ch from public.charges c where c.assignment_id = v_asg_id and c.kind = 'daily' and c.charge_date >= p_week;
      v_from := case when v_last_ch is null then greatest(p_week, asg.valid_from) else v_last_ch + 1 end;
      select count(*), coalesce(sum(c.amount_cents), 0) into v_week_n, v_week_ch from public.charges c where c.assignment_id = v_asg_id and c.kind = 'daily' and c.week_start = p_week;
      v_fail := case
        when v_from < asg.valid_from or (asg.valid_to is not null and v_from > asg.valid_to) then 'invalid_dates'
        when exists (select 1 from public.rates rt where rt.assignment_id = v_asg_id and rt.valid_to is null and v_from <= rt.valid_from) then 'invalid_dates'
        when exists (select 1 from public.weekly_closures w where w.assignment_id = v_asg_id and w.week_start + 6 >= v_from) then 'rate_change_closed_week' end;
      if v_fail is not null then
        v_warn := v_warn || app_private.cs_warn(r.source_row, 'cuenta', 'rate_change_not_applied', 'La cuota del Excel difiere de la vigente pero no se puede cambiar (' || v_fail || ').', 'blocking');
        c_blocked := c_blocked + 1;
      else
        if p_apply then
          begin
            perform public.change_rate(v_asg_id, v_new_rate, v_from, 'Cuota del Excel (semana ' || p_week || ')');
          exception when others then
            v_fail := sqlerrm;
          end;
        end if;
        if v_fail is not null then
          v_warn := v_warn || app_private.cs_warn(r.source_row, 'cuenta', 'rate_change_not_applied', 'No se pudo cambiar la cuota: ' || v_fail, 'blocking'); c_blocked := c_blocked + 1;
        else
          c_rate := c_rate + 1; v_changed := true;
          v_rates := v_rates || jsonb_build_object('row', r.source_row, 'unit_code', btrim(r.unit_code), 'assignment_id', v_asg_id, 'previous_cents', v_cur_rate,
            'new_cents', v_new_rate, 'effective_from', v_from, 'generated_charges_in_week', v_week_n, 'generated_week_cents', v_week_ch,
            'kind', 'contract', 'excel_week_cents', v_new_rate * 6, 'difference_cents', v_new_rate * 6 - v_week_ch, 'existing_charges_unchanged', v_week_n);
        end if;
      end if;
    end if;

    -- ── Conductor definitivo de la asignación (activo) ──
    v_drv_final := case when v_op_change or v_asg_create then v_drv_id when v_asg_found then asg.driver_id end;
    if v_drv_final is not null then
      select dd.id, dd.active, dd.operator_code into v_pdrv from public.drivers dd where dd.id = v_drv_final;
      if found then v_drv_active := v_pdrv.active; end if;
    end if;

    -- ── SALDO: conciliación contra la posición al domingo anterior ──
    select * into snap from public.collection_week_units w where w.week_start = p_week and w.unit_id = coalesce(v_unit_id, v_zero);
    v_prev_delta := coalesce(snap.saldo_delta_cents, 0); v_steps := coalesce(snap.saldo_steps, 0);
    v_saldo_keep := snap.saldo_excel_cents; v_orig_pending := snap.saldo_pending_before_cents; v_cum_delta := v_prev_delta; v_new_cum := v_steps;
    if v_sstate = 'empty' then s_empty := s_empty + 1;
    elsif v_sstate = 'text' then
      s_inv := s_inv + 1; v_warn := v_warn || app_private.cs_warn(r.source_row, 'saldo', 'saldo_invalid', 'El SALDO no es un importe numérico interpretable: se omite.');
    elsif not v_has_asg then
      s_noasg := s_noasg + 1; v_warn := v_warn || app_private.cs_warn(r.source_row, 'saldo', 'saldo_without_assignment', 'La unidad no tiene operario/asignación: el SALDO no se concilia.', 'info');
    elsif v_fin_block then
      s_inv := s_inv + 1;
    else
      v_saldo_keep := v_saldo;
      v_pending := case when v_asg_id is null then 0 else (select pos.pending_cents from public.assignment_position(v_asg_id, p_week - 1) pos) end;
      v_delta := v_saldo - v_pending;
      v_orig_pending := v_pending - v_prev_delta;
      if v_delta = 0 then s_same := s_same + 1;
      else
        v_opening := v_delta > 0 and (v_asg_id is null or not exists (select 1 from public.charges c where c.assignment_id = v_asg_id and c.kind = 'opening'));
        if v_opening then s_create := s_create + 1; else s_adj := s_adj + 1; end if;
        s_delta := s_delta + v_delta; v_cum_delta := v_prev_delta + v_delta; v_new_cum := v_steps + 1;
        if p_apply then
          if v_opening then
            insert into public.charges(assignment_id, kind, charge_date, amount_cents, week_start, source_import_id, source_row_id)
            values (v_asg_id, 'opening', p_week - 1, v_delta, app_private.week_start_of(p_week - 1), p_import, r.id) on conflict (assignment_id) where kind = 'opening' do nothing;
            get diagnostics i = row_count;
            if i = 0 then v_opening := false; s_create := s_create - 1; s_adj := s_adj + 1; end if;      -- otra importación la creó entre tanto
            if v_opening then perform app_private.audit('collection_sync_opening', 'charges', null, jsonb_build_object('assignment_id', v_asg_id, 'week_start', p_week,
              'saldo_cents', v_saldo, 'pending_before_cents', v_pending, 'delta_cents', v_delta, 'import_id', p_import)); end if;
          end if;
          if not v_opening then
            insert into public.adjustments(assignment_id, effective_date, amount_cents, reason, idempotency_key, created_by)
            values (v_asg_id, p_week - 1, v_delta, 'Conciliación SALDO del Excel, semana ' || p_week || case when v_delta > 0 then ' (deuda anterior)' else ' (crédito)' end,
                    'excel-saldo:' || v_asg_id || ':' || p_week || ':' || (v_steps + 1), auth.uid()) returning id into v_adj;
            if v_delta > 0 then
              insert into public.charges(assignment_id, kind, charge_date, amount_cents, week_start, adjustment_id, source_import_id, source_row_id)
              values (v_asg_id, 'adjustment', p_week - 1, v_delta, app_private.week_start_of(p_week - 1), v_adj, p_import, r.id);
            end if;
            perform app_private.audit('collection_sync_saldo_adjustment', 'adjustments', v_adj, jsonb_build_object('assignment_id', v_asg_id, 'week_start', p_week,
              'saldo_cents', v_saldo, 'pending_before_cents', v_pending, 'delta_cents', v_delta, 'import_id', p_import));
          end if;
          if not (v_drv_final = any (v_touched)) then v_touched := v_touched || v_drv_final; end if;
          v_touched_date := greatest(coalesce(v_touched_date, p_week), p_week);
        end if;
      end if;
    end if;

    -- ── PAGOS lunes–domingo ──
    if not v_has_asg then
      select count(*) into i from unnest(coalesce(r.day_amounts_cents, '{}'::bigint[])) x where x is not null;
      if i > 0 then
        p_rej := p_rej + i; v_warn := v_warn || app_private.cs_warn(r.source_row, 'pagos', 'payments_without_assignment', 'La unidad no tiene operario/asignación: no se registran sus ' || i || ' pagos del Excel.');
      end if;
    end if;
    if v_has_asg then
      for i in 1 .. 7 loop
        d := p_week + i - 1;
        v_new := case when coalesce(array_length(r.day_amounts_cents, 1), 0) >= i then r.day_amounts_cents[i] end;
        if v_new is null then p_skip := p_skip + 1; continue; end if;
        if v_new < 0 then
          p_rej := p_rej + 1; v_warn := v_warn || app_private.cs_warn(r.source_row, v_days[i], 'payment_invalid', 'Importe negativo: se omite.'); continue;
        end if;
        v_st_found := false; v_st_pay := null; v_st_amt := null; v_st_rev := 0; v_prev := 0; v_prev_active := false;
        if v_asg_id is not null then
          select s.payment_id, s.amount_cents, s.revision into v_st_pay, v_st_amt, v_st_rev from public.excel_payment_days s where s.assignment_id = v_asg_id and s.pay_date = d;
          v_st_found := found;
          if v_st_found then
            v_prev := v_st_amt;
            v_prev_active := v_st_pay is not null and exists (select 1 from public.payments p where p.id = v_st_pay and p.voided_at is null);
            if v_st_amt > 0 and not v_prev_active then
              v_prev := 0;          -- el pago importado fue anulado fuera de la importación
              if v_new = v_st_amt then
                p_same := p_same + 1;
                v_warn := v_warn || app_private.cs_warn(r.source_row, v_days[i], 'payment_voided_outside_import', 'El pago importado de este día fue anulado manualmente: no se vuelve a crear con el mismo importe.', 'info');
                continue;
              end if;
            end if;
          end if;
        end if;
        if v_new = v_prev then p_same := p_same + 1; continue; end if;
        v_act := case when v_new = 0 then 'zero' when v_prev = 0 then 'create' else 'change' end;
        v_why := case
          when v_fin_block then 'week_closed'
          when v_new > 0 and d > v_today then 'future_date'
          when v_new > 0 and not v_drv_active then 'driver_inactive'
          when v_new > 0 and v_unit_exists and not u.active then 'unit_inactive'
          when v_new > 0 and v_asg_found and not v_op_change and (asg.valid_from > d or (asg.valid_to is not null and asg.valid_to < d)) then 'outside_assignment' end;
        if v_why is not null then
          if v_why <> 'week_closed' then
            p_rej := p_rej + 1;
            v_warn := v_warn || app_private.cs_warn(r.source_row, v_days[i], 'payment_not_applied_' || v_why, 'El pago del ' || to_char(d, 'DD/MM/YYYY') || ' no se registra: ' || case v_why
              when 'future_date' then 'es una fecha futura (elige la semana correcta o espera a ese día).'
              when 'driver_inactive' then 'el operario está inactivo.' when 'unit_inactive' then 'la unidad está inactiva.'
              when 'outside_assignment' then 'la fecha queda fuera de la asignación del operario.' else v_why end);
          end if;
          continue;
        end if;
        if exists (select 1 from public.payments p where v_asg_id is not null and p.assignment_id = v_asg_id and p.voided_at is null and (p.paid_at at time zone v_tz)::date = d
                      and (v_st_pay is null or p.id <> v_st_pay)) then
          v_warn := v_warn || app_private.cs_warn(r.source_row, v_days[i], 'manual_payment_same_day', 'Ya existe un pago registrado manualmente ese día: el importe del Excel se suma como pago aparte; verifique que no sea el mismo.', 'info');
        end if;

        v_ok := true; v_new_pay := null;
        if p_apply then
          v_ok := false; v_err := null;
          begin
            v_rev := coalesce(v_st_rev, 0) + 1;
            v_paid_at := least(((d + time '12:00') at time zone v_tz), now());
            if v_prev > 0 and v_prev_active then
              v_txt := case when v_act = 'zero' then 'anulado por importación del Excel (0 explícito): ' else 'corregido por importación del Excel: ' end
                       || app_private.fmt_usd(v_prev) || ' → ' || app_private.fmt_usd(v_new) || ' (semana ' || p_week || ')';
              perform public.void_payment(v_st_pay, v_txt);
            end if;
            if v_new > 0 then
              select pm.id into v_method from public.payment_methods pm where pm.code = 'excel';
              if v_method is null then
                insert into public.payment_methods(code, label, commission_cents) values ('excel', 'Excel', 0) on conflict (code) do nothing;
              end if;
              v_key := 'excel:' || v_asg_id || ':' || d || ':r' || v_rev;
              v_res := public.register_payment(v_asg_id, 'excel', v_new, v_key, 'Excel ' || p_week, v_paid_at, false, 'Importación del Excel (semana ' || p_week || ')');
              v_new_pay := (v_res ->> 'payment_id')::uuid;
            end if;
            insert into public.excel_payment_days(assignment_id, pay_date, week_start, driver_id, amount_cents, payment_id, revision, first_import_id, last_import_id)
            values (v_asg_id, d, p_week, v_drv_final, v_new, v_new_pay, v_rev, p_import, p_import)
            on conflict (assignment_id, pay_date) do update set week_start = excluded.week_start, driver_id = excluded.driver_id, amount_cents = excluded.amount_cents,
              payment_id = excluded.payment_id, revision = excluded.revision, last_import_id = excluded.last_import_id, last_imported_at = now();
            insert into public.excel_payment_changes(assignment_id, pay_date, week_start, driver_id, previous_cents, new_cents, delta_cents, action,
              previous_payment_id, new_payment_id, import_id, changed_by)
            values (v_asg_id, d, p_week, v_drv_final, case when v_st_found then v_prev else null end, v_new, v_new - v_prev, v_act,
              case when v_prev > 0 then v_st_pay end, v_new_pay, p_import, auth.uid());
            v_ok := true;
          exception when others then v_err := sqlerrm;
          end;
          if not v_ok then
            p_rej := p_rej + 1; v_warn := v_warn || app_private.cs_warn(r.source_row, v_days[i], 'payment_failed', 'No se pudo aplicar el pago de ' || d || ': ' || v_err, 'blocking'); c_blocked := c_blocked + 1;
            continue;
          end if;
          if not (v_drv_final = any (v_touched)) then v_touched := v_touched || v_drv_final; end if;
          v_touched_date := greatest(coalesce(v_touched_date, d), d);
        end if;
        if v_act = 'create' then p_new := p_new + 1; elsif v_act = 'change' then p_chg := p_chg + 1; else p_zero := p_zero + 1; end if;
        p_net := p_net + (v_new - v_prev);
      end loop;
    end if;

    -- ── Foto semanal ──
    if v_unit_exists or p_apply then
      v_eff_phone := coalesce(v_drv_phone, case when v_op is not null and not v_fin_block then v_phone end);
      if not v_unit_exists and not p_apply then v_eff_phone := v_phone; end if;
      v_snap_new := jsonb_build_object('unit_code', v_ucode, 'assignment_id', coalesce(v_asg_id, snap.assignment_id), 'driver_id', coalesce(v_drv_final, snap.driver_id),
        'operator_code', coalesce(v_eff_op, snap.operator_code), 'daily_rate_cents', coalesce(case when v_fin_block then null else v_eff_rate end, snap.daily_rate_cents),
        'agreement', coalesce(v_eff_ag, snap.agreement), 'phone_e164', coalesce(v_eff_phone, snap.phone_e164), 'saldo_excel_cents', v_saldo_keep,
        'saldo_pending_before_cents', v_orig_pending, 'saldo_delta_cents', v_cum_delta);
      v_snap_old := case when snap.week_start is null then null else jsonb_build_object('unit_code', snap.unit_code, 'assignment_id', snap.assignment_id, 'driver_id', snap.driver_id,
        'operator_code', snap.operator_code, 'daily_rate_cents', snap.daily_rate_cents, 'agreement', snap.agreement, 'phone_e164', snap.phone_e164,
        'saldo_excel_cents', snap.saldo_excel_cents, 'saldo_pending_before_cents', snap.saldo_pending_before_cents, 'saldo_delta_cents', snap.saldo_delta_cents) end;
      if v_snap_old is distinct from v_snap_new then
        if snap.week_start is null then c_snap_new := c_snap_new + 1; else c_snap_chg := c_snap_chg + 1; end if;
        if p_apply then
          select coalesce(array_agg(k order by k), '{}') into v_fields from jsonb_each(v_snap_new) e(k, v) where v_snap_old is null or v_snap_old -> k is distinct from v;
          insert into public.collection_week_units(week_start, unit_id, unit_code, assignment_id, driver_id, operator_code, daily_rate_cents, agreement, phone_e164,
            saldo_excel_cents, saldo_pending_before_cents, saldo_delta_cents, saldo_steps, first_import_id, last_import_id)
          values (p_week, v_unit_id, v_ucode, nullif(v_snap_new ->> 'assignment_id', '')::uuid, nullif(v_snap_new ->> 'driver_id', '')::uuid, v_snap_new ->> 'operator_code',
            (v_snap_new ->> 'daily_rate_cents')::bigint, v_snap_new ->> 'agreement', v_snap_new ->> 'phone_e164', (v_snap_new ->> 'saldo_excel_cents')::bigint,
            (v_snap_new ->> 'saldo_pending_before_cents')::bigint, v_cum_delta, v_new_cum, p_import, p_import)
          on conflict (week_start, unit_id) do update set unit_code = excluded.unit_code, assignment_id = excluded.assignment_id, driver_id = excluded.driver_id,
            operator_code = excluded.operator_code, daily_rate_cents = excluded.daily_rate_cents, agreement = excluded.agreement, phone_e164 = excluded.phone_e164,
            saldo_excel_cents = excluded.saldo_excel_cents, saldo_pending_before_cents = excluded.saldo_pending_before_cents, saldo_delta_cents = excluded.saldo_delta_cents,
            saldo_steps = excluded.saldo_steps, last_import_id = excluded.last_import_id, updated_at = now();
          insert into public.collection_week_unit_changes(week_start, unit_id, unit_code, previous, new, changed_fields, import_id, changed_by)
          values (p_week, v_unit_id, v_ucode, v_snap_old, v_snap_new, v_fields, p_import, auth.uid());
        end if;
      end if;
    end if;

    -- «Con cambios»: cualquier cambio de la unidad, del operario, la asignación, la cuota, el saldo, los pagos o el acuerdo; una unidad con varios cambios cuenta UNA vez.
    if not v_unit_new then
      if v_changed or (c_new + c_drv_created + c_drv_updated + c_asg_created + p_new + p_chg + p_zero + s_create + s_adj + c_rate + c_snap_chg) <> v_pre then c_changed := c_changed + 1; else c_unchanged := c_unchanged + 1; end if;
    end if;
  end loop;

  -- ── Resultado ──
  declare
    v_any boolean := (c_new + c_changed + c_drv_created + c_drv_updated + p_new + p_chg + p_zero + s_create + s_adj + c_rate + c_snap_new + c_snap_chg + c_asg_created) > 0;
    v_out jsonb; v_drv uuid;
  begin
    if p_apply and v_touched <> '{}' then
      foreach v_drv in array v_touched loop perform app_private.reevaluate_reminders(v_drv, coalesce(v_touched_date, p_week)); end loop;     -- los recordatorios pendientes se reajustan (sin crear trabajos)
    end if;
    v_out := jsonb_build_object('import_id', p_import, 'week_start', p_week, 'applied', p_apply,
      'units', jsonb_build_object('total', c_total, 'unchanged', c_unchanged, 'changed', c_changed, 'new', c_new, 'without_driver', c_nodrv, 'errors', c_err),
      'payments', jsonb_build_object('new', p_new, 'changed', p_chg, 'zeroed', p_zero, 'unchanged', p_same, 'skipped_empty', p_skip, 'rejected', p_rej, 'net_delta_cents', p_net),
      'saldo', jsonb_build_object('create', s_create, 'unchanged', s_same, 'adjust', s_adj, 'skip_empty', s_empty, 'skipped_invalid', s_inv, 'skipped_no_assignment', s_noasg, 'delta_cents', s_delta),
      'rate_changes', v_rates,
      'drivers', jsonb_build_object('created', c_drv_created, 'updated', c_drv_updated),
      'assignments_created', c_asg_created, 'snapshots', jsonb_build_object('created', c_snap_new, 'changed', c_snap_chg),
      'rows_empty', c_empty, 'blocked', c_blocked, 'warnings', v_warn, 'already_up_to_date', not v_any);
    if p_apply then
      if v_any then
        perform app_private.audit('apply_collection_sync', 'excel_imports', p_import, (v_out - 'warnings') || jsonb_build_object('warnings_count', jsonb_array_length(v_warn), 'note', nullif(btrim(p_note), '')));
      end if;
      if v_any or v_imp.status <> 'applied' then
        update public.excel_imports set status = 'applied', applied_by = coalesce(applied_by, auth.uid()), applied_at = coalesce(applied_at, now()),
          summary = jsonb_set(summary, '{collection_sync}', coalesce(summary -> 'collection_sync', '{}'::jsonb)
                    || jsonb_build_object(p_week::text, (v_out - 'warnings') || jsonb_build_object('warnings_count', jsonb_array_length(v_warn), 'note', nullif(btrim(p_note), ''))), true)
         where id = p_import;
      end if;
    end if;
    return v_out;
  end;
end $$;
revoke all on function app_private.collection_sync(uuid, date, boolean, text) from public, anon, authenticated;

-- ───────── 6. API pública (ADMIN+ / SUPER_ADMIN) ─────────
create function public.preview_collection_sync(p_import uuid, p_week_start date) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.assert_admin();
  return app_private.collection_sync(p_import, p_week_start, false, null);
end $$;

create function public.apply_collection_sync(p_import uuid, p_week_start date, p_note text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.assert_admin();
  return app_private.collection_sync(p_import, p_week_start, true, p_note);
end $$;

revoke all on function public.preview_collection_sync(uuid, date), public.apply_collection_sync(uuid, date, text) from public, anon, authenticated;
grant execute on function public.preview_collection_sync(uuid, date), public.apply_collection_sync(uuid, date, text) to authenticated, service_role;

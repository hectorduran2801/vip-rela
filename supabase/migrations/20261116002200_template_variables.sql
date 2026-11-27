-- ══════════════════════════════════════════════════════════════════════════
-- 0022 · Catálogo de variables de plantillas de WhatsApp
-- Aditiva y no destructiva: no toca filas existentes (ni el cuerpo de plantillas guardadas); solo redefine funciones
-- y amplía el check de estados de notification_jobs con `skipped_unresolved`.
--   · Una sola función de resolución (app_private.resolve_template) para vista previa y envío.
--   · Variables con significado exacto; `detalle_deuda` = frase completa según la situación financiera REAL.
--   · Variable desconocida o sin dato → el mensaje NO se envía (skipped_unresolved) y la vista previa las lista.
-- ══════════════════════════════════════════════════════════════════════════

-- ───────── 1. Nuevo estado de trabajo ─────────
alter table public.notification_jobs drop constraint notification_jobs_status_check;
alter table public.notification_jobs add constraint notification_jobs_status_check
  check (status in ('pending','awaiting_approval','processing','sent','failed',
    'skipped_paid','skipped_credit','skipped_no_consent','skipped_paused','skipped_frequency','skipped_unresolved','cancelled','discarded'));

-- ───────── 2. Fecha completa en español (es-PA), sin depender del locale del servidor ─────────
create function app_private.fecha_es(p_date date) returns text language sql immutable set search_path = '' as $$
  select (array['domingo','lunes','martes','miércoles','jueves','viernes','sábado'])[extract(dow from p_date)::int + 1]
      || ' ' || extract(day from p_date)::int::text || ' de '
      || (array['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'])[extract(month from p_date)::int]
      || ' de ' || extract(year from p_date)::int::text
$$;

-- ───────── 3. Variables resueltas con datos reales ─────────
-- Valores jsonb: texto, o null cuando falta el dato (la variable queda «sin resolver»).
-- Obligaciones (assignment_coverage, FIFO): deuda_anterior = apertura + fechas < lunes de la semana; deuda_semanal = fechas del lunes a hoy
-- (sin apertura); saldo_total = deuda_anterior + deuda_semanal (exigible hoy; no incluye cargos con fecha futura).
create or replace function app_private.template_vars(p_assignment uuid, p_date date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  a record; d record; u record;
  v_w date := app_private.week_start_of(p_date); v_tz text := app_private.tz();
  v_ant bigint; v_sem bigint; v_hoy bigint; v_cuota bigint; v_atr bigint; v_tot bigint; v_cred bigint; v_abono bigint;
  v_planned bigint; v_pagos bigint; v_charged bigint; v_detail text; v_first text; v_last text; v_op text;
begin
  select * into a from public.assignments where id = p_assignment;
  select * into d from public.drivers where id = a.driver_id;
  select * into u from public.units where id = a.unit_id;

  select coalesce(sum(c.remaining_cents) filter (where c.kind = 'opening' or c.charge_date < v_w), 0)::bigint,
         coalesce(sum(c.remaining_cents) filter (where c.kind <> 'opening' and c.charge_date >= v_w and c.charge_date <= p_date), 0)::bigint,
         coalesce(sum(c.remaining_cents) filter (where c.kind = 'daily' and c.charge_date = p_date), 0)::bigint,
         coalesce(sum(c.amount_cents) filter (where c.kind = 'daily' and c.charge_date = p_date), 0)::bigint
    into v_ant, v_sem, v_hoy, v_cuota
    from public.assignment_coverage(p_assignment) c;
  v_atr := v_sem - v_hoy;                         -- cuotas de días anteriores de esta semana, aún pendientes
  v_tot := v_ant + v_sem;
  select pos.credit_cents into v_cred from public.assignment_position(p_assignment) pos;
  -- abono = neto recibido hoy (pagos vigentes; la comisión del proveedor no cuenta; los anulados no existen para el cálculo)
  select coalesce(sum(p.net_cents), 0)::bigint into v_abono from public.payments p
   where p.assignment_id = p_assignment and p.voided_at is null and (p.paid_at at time zone v_tz)::date = p_date;
  select coalesce(sum(public.planned_daily_cents(p_assignment, v_w + i)), 0)::bigint into v_planned from generate_series(0, 6) i;
  select coalesce(sum(p.net_cents), 0)::bigint into v_pagos from public.payments p
   where p.assignment_id = p_assignment and p.voided_at is null and p.week_start = v_w;
  select coalesce(sum(c.amount_cents), 0)::bigint into v_charged from public.charges c
   where c.assignment_id = p_assignment and c.week_start = v_w and c.kind <> 'opening';

  v_detail := case
    when v_tot = 0 and v_cred > 0 then 'Su cuenta está al día y tiene un saldo a favor de ' || app_private.fmt_usd(v_cred) || '.'
    when v_tot = 0 then 'Su cuenta está al día.'
    else
      case when v_abono > 0 then 'Hemos registrado un abono de ' || app_private.fmt_usd(v_abono) || '. ' else '' end
      || case
        when v_hoy = 0 then 'Tiene un saldo pendiente de ' || app_private.fmt_usd(v_tot) || ' correspondiente a cuotas anteriores.'
        when v_ant = 0 and v_atr = 0 then
          case when v_abono > 0 then 'Su saldo pendiente de hoy es de ' || app_private.fmt_usd(v_hoy) || '.'
               else 'Su cuota pendiente de hoy es de ' || app_private.fmt_usd(v_hoy) || '.' end
        when v_atr = 0 then 'Tiene una deuda anterior de ' || app_private.fmt_usd(v_ant) || ' y una cuota pendiente de hoy de ' || app_private.fmt_usd(v_hoy)
                            || '. Su saldo total pendiente es de ' || app_private.fmt_usd(v_tot) || '.'
        when v_ant = 0 then 'Tiene cuotas atrasadas de esta semana por ' || app_private.fmt_usd(v_atr) || ' y una cuota pendiente de hoy de ' || app_private.fmt_usd(v_hoy)
                            || '. Su saldo total pendiente es de ' || app_private.fmt_usd(v_tot) || '.'
        else 'Tiene una deuda anterior de ' || app_private.fmt_usd(v_ant) || ', cuotas atrasadas de esta semana por ' || app_private.fmt_usd(v_atr)
             || ' y una cuota pendiente de hoy de ' || app_private.fmt_usd(v_hoy) || '. Su saldo total pendiente es de ' || app_private.fmt_usd(v_tot) || '.'
      end
  end;

  v_first := nullif(regexp_replace(btrim(d.first_name), '\s+', ' ', 'g'), '');
  v_last := nullif(regexp_replace(btrim(coalesce(d.last_name, '')), '\s+', ' ', 'g'), '');
  v_op := nullif(btrim(d.operator_code), '');
  return jsonb_build_object(
    'nombre', v_first, 'apellido', v_last,
    'nombre_completo', nullif(concat_ws(' ', v_first, v_last), ''),
    'unidad', nullif(btrim(u.code), ''), 'codigo_operario', v_op,
    'fecha', app_private.fecha_es(p_date),
    'cuota_hoy', app_private.fmt_usd(v_cuota), 'pendiente_hoy', app_private.fmt_usd(v_hoy),
    'deuda_anterior', app_private.fmt_usd(v_ant), 'deuda_semanal', app_private.fmt_usd(v_sem),
    'saldo_total', app_private.fmt_usd(v_tot), 'credito', app_private.fmt_usd(v_cred),
    'cuenta_semanal', app_private.fmt_usd(v_planned), 'pagos_semana', app_private.fmt_usd(v_pagos),
    'detalle_deuda', v_detail,
    'cuenta_semana', app_private.fmt_usd(v_charged));      -- anterior: cuotas GENERADAS de la semana (sin apertura); se conserva por compatibilidad
end $$;

-- ───────── 4. Resolvedor único ─────────
-- Devuelve {text, unresolved[]}. Una variable `{{x}}` es «sin resolver» si no existe o su valor es null/vacío; en `text` se elimina
-- (nunca queda «{{x}}» en el mensaje). Quien envía debe NO enviar si `unresolved` no está vacío.
create function app_private.render_template_ex(p_body text, p_vars jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare m text[]; v_out text := coalesce(p_body, ''); v_val text; v_key text; v_unres text[] := '{}';
begin
  for m in select regexp_matches(coalesce(p_body, ''), '(\{\{\s*([^{}]*?)\s*\}\})', 'g') loop
    v_key := m[2];
    v_val := case when v_key = '' then null else p_vars ->> v_key end;
    if v_val is null or btrim(v_val) = '' then
      if not (coalesce(nullif(v_key, ''), '(vacía)') = any (v_unres)) then v_unres := v_unres || coalesce(nullif(v_key, ''), '(vacía)'); end if;
      v_out := replace(v_out, m[1], '');
    else
      v_out := replace(v_out, m[1], v_val);
    end if;
  end loop;
  return jsonb_build_object('text', v_out, 'unresolved', to_jsonb(v_unres));
end $$;

-- Compatibilidad: misma firma que antes, devuelve solo el texto (sin «{{x}}» residuales).
create or replace function app_private.render_template(p_body text, p_vars jsonb) returns text
language sql immutable set search_path = '' as $$ select app_private.render_template_ex(p_body, p_vars) ->> 'text' $$;

create function app_private.resolve_template(p_assignment uuid, p_body text, p_date date) returns jsonb
language sql stable security definer set search_path = '' as $$
  select app_private.render_template_ex(p_body, app_private.template_vars(p_assignment, p_date))
$$;
revoke all on function app_private.fecha_es(date), app_private.render_template_ex(text, jsonb), app_private.resolve_template(uuid, text, date) from public, anon, authenticated;
grant execute on function app_private.fecha_es(date), app_private.render_template_ex(text, jsonb) to authenticated, service_role;

-- Vista previa: MISMO resolvedor que el envío. Cambia la forma: texto → jsonb {text, unresolved[]}.
drop function public.preview_template(uuid, text, date);
create function public.preview_template(p_assignment uuid, p_body text, p_date date default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app_private.assert_staff();
  if not exists (select 1 from public.assignments where id = p_assignment) then raise exception 'assignment_not_found' using errcode = 'P0002'; end if;
  return app_private.resolve_template(p_assignment, p_body, coalesce(p_date, (now() at time zone app_private.tz())::date));
end $$;
revoke all on function public.preview_template(uuid, text, date) from public, anon, authenticated;
grant execute on function public.preview_template(uuid, text, date) to authenticated, service_role;

-- ───────── 5. Catálogo para la UI ─────────
create function public.template_variables()
returns table ("group" text, code text, label text, description text, example text)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app_private.assert_staff();
  return query select v.g, v.c, v.l, v.d, v.e from (values
    (1, 'Datos del conductor', 'nombre', 'Nombre', 'Nombre del conductor (campo nombre).', 'Vanessa'),
    (2, 'Datos del conductor', 'apellido', 'Apellido', 'Apellido del conductor. Si no está registrado, la variable queda sin resolver y el mensaje no se envía.', 'Ejemplo'),
    (3, 'Datos del conductor', 'nombre_completo', 'Nombre completo', 'Nombre y apellido sin espacios dobles ni sobrantes (si falta el apellido, solo el nombre).', 'Vanessa Ejemplo'),
    (4, 'Unidad y operario', 'unidad', 'Unidad', 'Código de la unidad asignada.', '4321'),
    (5, 'Unidad y operario', 'codigo_operario', 'Código de operario', 'Código de operario del conductor.', '1234'),
    (6, 'Fechas', 'fecha', 'Fecha', 'Fecha local completa de Panamá, en español.', 'lunes 16 de noviembre de 2026'),
    (7, 'Importes financieros', 'cuota_hoy', 'Cuota de hoy', 'Cuota diaria generada de hoy ($0.00 si no hay cuota, p. ej. domingo).', '$40.00'),
    (8, 'Importes financieros', 'pendiente_hoy', 'Pendiente de hoy', 'Lo que sigue pendiente de la cuota de hoy tras aplicar los pagos a las deudas más antiguas primero.', '$15.00'),
    (9, 'Importes financieros', 'deuda_anterior', 'Deuda anterior', 'Pendiente de semanas anteriores (incluye la apertura/SALDO), después de aplicar pagos.', '$20.00'),
    (10, 'Importes financieros', 'deuda_semanal', 'Deuda de la semana', 'Pendiente de la semana actual (del lunes a hoy), después de aplicar pagos. No incluye la deuda anterior ni es la cuenta semanal prevista.', '$40.00'),
    (11, 'Importes financieros', 'saldo_total', 'Saldo total', 'Deuda exigible hoy: deuda anterior + deuda de la semana, sin duplicar.', '$60.00'),
    (12, 'Importes financieros', 'credito', 'Crédito a favor', 'Saldo a favor disponible del conductor.', '$0.00'),
    (13, 'Importes financieros', 'cuenta_semanal', 'Cuenta semanal prevista', 'Cuenta ordinaria prevista de la semana (suma de las cuotas diarias planificadas según las tarifas vigentes cada día). No es lo ya generado.', '$240.00'),
    (14, 'Importes financieros', 'pagos_semana', 'Pagos de la semana', 'Pagos netos registrados en la semana actual (sin comisiones; los anulados no cuentan).', '$25.00'),
    (15, 'Importes financieros', 'cuenta_semana', 'Cuotas generadas de la semana (anterior)', 'Variable anterior, se conserva por compatibilidad: suma de las cuotas ya generadas en la semana, sin apertura.', '$240.00'),
    (16, 'Textos inteligentes', 'detalle_deuda', 'Detalle de la deuda', 'Frase completa (termina en punto) según la situación real al momento del envío: cuota de hoy, abonos, deuda anterior, cuotas atrasadas, saldo a favor o cuenta al día. Úsela sola, sin texto delante ni punto detrás.', 'Su cuota pendiente de hoy es de $40.00.')
  ) as v(o, g, c, l, d, e) order by v.o;
end $$;
revoke all on function public.template_variables() from public, anon, authenticated;
grant execute on function public.template_variables() to authenticated, service_role;

-- ───────── 6. Recordatorios: alcance «total» = deuda EXIGIBLE hoy (anterior + hoy), sin cargos de fecha futura ─────────
create or replace function app_private.reevaluate_reminders(p_driver uuid, p_local_date date) returns void
language plpgsql security definer set search_path = '' as $$
declare j record; x record; v_amount bigint;
begin
  for j in select nj.id, nj.local_date, coalesce(s.scope, 'total') as scope,
                  (select a2.id from public.assignments a2 where a2.driver_id = p_driver and a2.valid_from <= nj.local_date
                      and (a2.valid_to is null or a2.valid_to >= nj.local_date) order by a2.valid_from desc limit 1) as assignment_id
             from public.notification_jobs nj left join public.notification_schedules s on s.id = nj.schedule_id
            where nj.driver_id = p_driver and nj.status = 'pending' and nj.kind in ('debt_reminder','debt_first','debt_update','debt_last')
              for update of nj loop
    if j.assignment_id is null then continue; end if;
    select * into x from public.assignment_dues(j.assignment_id, j.local_date);
    v_amount := case j.scope when 'today' then x.today_cents when 'overdue' then x.overdue_cents else x.today_cents + x.overdue_cents end;
    if v_amount <= 0 then
      update public.notification_jobs set status = case when x.credit_cents > 0 then 'skipped_credit' else 'skipped_paid' end where id = j.id;
    end if;
  end loop;
end $$;

-- ───────── 7. Envío: textos de respaldo con detalle_deuda completo + resolvedor único + skipped_unresolved ─────────
create or replace function public.prepare_notification_send(p_job_id uuid, p_now timestamptz default now()) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare j record; d record; a record; u record; s record; st record; pay record; pm record; x record; pos record;
  v_body text; v_amount bigint; v_tpl text; v_res jsonb; v_sent_today int; v_last timestamptz; v_is_debt boolean; v_greet text; v_unres text;
begin
  select * into j from public.notification_jobs where id = p_job_id for update;
  if not found or j.status <> 'processing' then raise exception 'job_not_processing' using errcode = '22023'; end if;
  select * into d from public.drivers where id = j.driver_id;
  v_is_debt := j.kind in ('debt_reminder','debt_first','debt_update','debt_last');
  if d.status <> 'active' then
    update public.notification_jobs set status = 'cancelled', error = 'conductor no activo' where id = p_job_id;
    return jsonb_build_object('action', 'skip', 'reason', 'cancelled');
  end if;
  if not d.whatsapp_consent or d.phone_e164 is null then
    update public.notification_jobs set status = 'skipped_no_consent' where id = p_job_id;
    return jsonb_build_object('action', 'skip', 'reason', 'skipped_no_consent');
  end if;
  if d.reminders_paused and (v_is_debt or j.kind = 'weekly_summary') then
    update public.notification_jobs set status = 'skipped_paused' where id = p_job_id;
    return jsonb_build_object('action', 'skip', 'reason', 'skipped_paused');
  end if;
  select a2.* into a from public.assignments a2 where a2.driver_id = j.driver_id and a2.valid_from <= j.local_date
     and (a2.valid_to is null or a2.valid_to >= j.local_date) order by a2.valid_from desc limit 1;
  if not found then
    update public.notification_jobs set status = 'cancelled', error = 'sin asignación vigente' where id = p_job_id;
    return jsonb_build_object('action', 'skip', 'reason', 'cancelled');
  end if;
  perform 1 from public.assignments where id = a.id for share;       -- serializa con register_payment (FOR UPDATE)
  if exists (select 1 from public.notification_jobs o where o.driver_id = j.driver_id and o.id < j.id and o.status = 'processing') then
    return jsonb_build_object('action', 'defer', 'reason', 'otro_envio_en_curso');
  end if;
  select * into u from public.units where id = a.unit_id;
  select * into pos from public.assignment_position(a.id);
  select * into st from public.app_settings;
  select * into s from public.notification_schedules where id = j.schedule_id;

  if v_is_debt or j.kind = 'weekly_summary' then
    if v_is_debt then
      select count(*), max(sent_at) into v_sent_today, v_last from public.notification_jobs
       where driver_id = j.driver_id and local_date = j.local_date and status = 'sent' and kind in ('debt_reminder','debt_first','debt_update','debt_last');
      if v_sent_today >= st.max_per_driver_per_day or (v_last is not null and v_last > p_now - make_interval(mins => st.min_minutes_between)) then
        update public.notification_jobs set status = 'skipped_frequency' where id = p_job_id;
        return jsonb_build_object('action', 'skip', 'reason', 'skipped_frequency');
      end if;
      select * into x from public.assignment_dues(a.id, j.local_date);
      v_amount := case coalesce(s.scope, 'total') when 'today' then x.today_cents when 'overdue' then x.overdue_cents else x.today_cents + x.overdue_cents end;
      if v_amount <= 0 then
        update public.notification_jobs set status = case when x.credit_cents > 0 then 'skipped_credit' else 'skipped_paid' end where id = p_job_id;
        return jsonb_build_object('action', 'skip', 'reason', case when x.credit_cents > 0 then 'skipped_credit' else 'skipped_paid' end);
      end if;
    end if;
    select t.body into v_tpl from public.message_templates t where t.id = s.template_id;
    if v_tpl is null then
      v_greet := case j.kind when 'debt_first' then 'Buenos días' when 'weekly_summary' then 'Buenos días' when 'debt_last' then 'Buenas noches' else 'Buenas tardes' end;
      v_tpl := case when j.kind = 'weekly_summary'
        then v_greet || E', {{nombre_completo}}.\n\nUnidad: {{unidad}}\nFecha: {{fecha}}\n\nResumen de la semana:\nCuenta semanal: {{cuenta_semanal}}\nPagos recibidos: {{pagos_semana}}\n\n{{detalle_deuda}}\n\nGracias por su atención.'
        else v_greet || E', {{nombre_completo}}.\n\nUnidad: {{unidad}}\nFecha: {{fecha}}\n\n{{detalle_deuda}}\n\nGracias por su atención.' end;
    end if;
    v_res := app_private.resolve_template(a.id, v_tpl, j.local_date);
    if jsonb_array_length(v_res -> 'unresolved') > 0 then
      select string_agg('{{' || e || '}}', ', ') into v_unres from jsonb_array_elements_text(v_res -> 'unresolved') e;
      update public.notification_jobs set status = 'skipped_unresolved', error = 'Variables sin resolver: ' || v_unres where id = p_job_id;
      perform app_private.audit('notification_unresolved', 'notification_jobs', p_job_id, jsonb_build_object('kind', j.kind, 'unresolved', v_res -> 'unresolved'));
      return jsonb_build_object('action', 'skip', 'reason', 'skipped_unresolved', 'unresolved', v_res -> 'unresolved');
    end if;
    v_body := v_res ->> 'text';
  elsif j.kind = 'payment_receipt' then
    select p.* into pay from public.payments p where p.id = j.payment_id;
    if pay.voided_at is not null then
      update public.notification_jobs set status = 'cancelled' where id = p_job_id;
      return jsonb_build_object('action', 'skip', 'reason', 'cancelled');
    end if;
    select * into pm from public.payment_methods where id = pay.method_id;
    v_body := E'Estimado conductor, hemos registrado su pago correctamente.\nUnidad: ' || u.code || E'\nMétodo: ' || pm.label
      || E'\nMonto entregado: ' || app_private.fmt_usd(pay.gross_cents)
      || case when pay.commission_cents > 0 then E'\nComisión del proveedor: ' || app_private.fmt_usd(pay.commission_cents) else '' end
      || E'\nAbono a su cuenta: ' || app_private.fmt_usd(pay.net_cents)
      || case when pos.pending_cents > 0 then E'\nSaldo pendiente: ' || app_private.fmt_usd(pos.pending_cents)
              when pos.credit_cents > 0 then E'\nSaldo a favor: ' || app_private.fmt_usd(pos.credit_cents) else E'\nSu cuenta está al día.' end || E'\nGracias por su pago.';
  elsif j.kind = 'credit_notice' then
    if j.approved_by is null then raise exception 'not_approved' using errcode = '42501'; end if;
    v_body := j.suggested_body;
  end if;
  return jsonb_build_object('action', 'send', 'phone', d.phone_e164, 'body', v_body, 'job_id', j.id);
end $$;

-- Permisos: las funciones redefinidas con create or replace conservan los suyos; las nuevas se fijaron arriba.
revoke all on function public.prepare_notification_send(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.prepare_notification_send(uuid, timestamptz) to service_role;

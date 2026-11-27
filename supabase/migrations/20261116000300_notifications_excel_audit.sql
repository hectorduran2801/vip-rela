-- VIP · 0003 · WhatsApp (una sola sesión), plantillas, horarios, cola, zona de preparación del Excel y auditoría.
set search_path = public, extensions;

-- Una única sesión de OpenWA (el índice impide una segunda fila).
create table public.whatsapp_sessions (
  id uuid primary key default gen_random_uuid(),
  label text not null default 'Principal',
  status text not null default 'disconnected' check (status in ('disconnected','qr_pending','connecting','connected','failed')),
  desired_state text not null default 'disconnected' check (desired_state in ('connected','disconnected')),
  qr_data text,
  qr_expires_at timestamptz,
  last_seen_at timestamptz,
  updated_at timestamptz not null default now()
);
create unique index whatsapp_single_session on public.whatsapp_sessions ((true));
insert into public.whatsapp_sessions(label) values ('Principal');

-- Sin ningún permiso para anon/authenticated: solo el servidor (service_role).
create table public.whatsapp_session_secrets (
  session_id uuid primary key references public.whatsapp_sessions(id) on delete cascade,
  encrypted_session bytea not null,
  updated_at timestamptz not null default now()
);

create table public.message_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (length(btrim(name)) > 0),
  body text not null check (length(btrim(body)) > 0 and length(body) <= 1000),
  created_at timestamptz not null default now()
);

create table public.notification_schedules (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('debt_reminder','debt_first','debt_update','debt_last','weekly_summary')),
  label text not null unique check (length(btrim(label)) > 0),
  local_time time not null,
  weekdays smallint[] not null check (weekdays <@ array[1,2,3,4,5,6,7]::smallint[] and cardinality(weekdays) > 0),
  template_id uuid references public.message_templates(id) on delete set null,
  scope text not null default 'total' check (scope in ('total','today','overdue')),
  enabled boolean not null default false                      -- apagado por defecto
);
insert into public.notification_schedules(kind, label, local_time, weekdays) values
  ('debt_first',  'Primer recordatorio',      '11:00', '{1,2,3,4,5,6}'),
  ('debt_update', 'Recordatorio actualizado', '17:00', '{1,2,3,4,5,6}'),
  ('debt_last',   'Último recordatorio',      '21:00', '{1,2,3,4,5,6}'),
  ('weekly_summary', 'Resumen semanal',       '09:00', '{7}');

create table public.notification_jobs (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid not null references public.drivers(id),
  kind text not null check (kind in ('debt_reminder','debt_first','debt_update','debt_last','weekly_summary','payment_receipt','credit_notice')),
  local_date date not null,
  payment_id uuid references public.payments(id),
  schedule_id uuid references public.notification_schedules(id) on delete set null,
  scheduled_for timestamptz not null,
  status text not null default 'pending' check (status in ('pending','awaiting_approval','processing','sent','failed',
    'skipped_paid','skipped_credit','skipped_no_consent','skipped_paused','skipped_frequency','cancelled','discarded')),
  attempts int not null default 0,
  claimed_at timestamptz,
  suggested_body text,
  rendered_body text,
  approved_by uuid references public.profiles(id),
  approved_at timestamptz,
  dry_run boolean,
  error text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  check ((kind in ('payment_receipt','credit_notice')) = (payment_id is not null)),
  check (kind <> 'credit_notice' or status in ('awaiting_approval','discarded','cancelled') or approved_by is not null)   -- jamás sin aprobación
);
create unique index notification_jobs_schedule_once on public.notification_jobs(driver_id, schedule_id, local_date) where schedule_id is not null;
create unique index notification_jobs_payment_once on public.notification_jobs(payment_id, kind) where payment_id is not null;
create index notification_jobs_due on public.notification_jobs(scheduled_for) where status = 'pending';
create index notification_jobs_status on public.notification_jobs(status);
create index notification_jobs_driver_day on public.notification_jobs(driver_id, local_date);

-- ───────── Zona de preparación del Excel (no afecta saldos) ─────────
create table public.excel_imports (
  id uuid primary key default gen_random_uuid(),
  file_name text not null,
  file_sha256 text not null unique,                       -- el mismo archivo no se importa dos veces
  status text not null default 'previewed' check (status in ('previewed','confirmed','applied','rejected')),
  summary jsonb not null default '{}',
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  applied_by uuid references public.profiles(id),
  applied_at timestamptz
);
create table public.import_blocks (
  id uuid primary key default gen_random_uuid(),
  import_id uuid not null references public.excel_imports(id) on delete cascade,
  block_index int not null, start_column text not null, header_variant text not null,
  detected_week_start date,                               -- NULL hasta confirmar con la administradora
  unique (import_id, block_index)
);
create table public.import_rows (
  id uuid primary key default gen_random_uuid(),
  block_id uuid not null references public.import_blocks(id) on delete cascade,
  source_row int not null,
  unit_code text, operator_code text, national_id text, full_name text,
  daily_rate_cents bigint,
  raw_agreement text, raw_saldo text,                     -- crudos, sin interpretar
  day_amounts_cents bigint[],
  excel_weekly_diff_cents bigint, excel_weekly_expected_cents bigint,
  original_formulas jsonb not null default '{}',
  warnings text[] not null default '{}',
  match_status text not null default 'unmatched' check (match_status in ('unmatched','matched','conflict','duplicate','ignored')),
  matched_driver_id uuid references public.drivers(id),
  review_status text not null default 'pending' check (review_status in ('pending','approved','rejected')),
  applied_action text check (applied_action in ('created','linked','skipped','rejected','excluded')),
  applied_note text,
  unique (block_id, source_row)
);
create index import_rows_block_idx on public.import_rows(block_id);
create table public.candidate_payments (                  -- NO cuentan en ningún saldo
  id uuid primary key default gen_random_uuid(),
  import_row_id uuid not null references public.import_rows(id) on delete cascade,
  weekday smallint not null check (weekday between 1 and 7),
  amount_cents bigint not null check (amount_cents >= 0),
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  unique (import_row_id, weekday)
);

-- ───────── Auditoría append-only ─────────
create table public.audit_logs (
  id bigint generated always as identity primary key,
  actor uuid,                                             -- null = servidor / worker
  action text not null, entity text not null, entity_id uuid,
  detail jsonb not null default '{}',
  at timestamptz not null default now()
);
create index audit_logs_at on public.audit_logs(at desc);
create index audit_logs_entity on public.audit_logs(entity, entity_id);
create trigger no_mutation before update or delete on public.audit_logs for each row execute function app_private.block_mutation();

create function app_private.audit(p_action text, p_entity text, p_entity_id uuid, p_detail jsonb) returns void
language sql security definer set search_path = '' as $$
  insert into public.audit_logs(actor, action, entity, entity_id, detail) values (auth.uid(), p_action, p_entity, p_entity_id, coalesce(p_detail, '{}'::jsonb))
$$;

create function app_private.audit_row() returns trigger language plpgsql security definer set search_path = '' as $$
declare v_row jsonb := to_jsonb(coalesce(new, old));
begin
  insert into public.audit_logs(actor, action, entity, entity_id, detail)
  values (auth.uid(), lower(tg_op), tg_table_name, case when (v_row ->> 'id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then (v_row ->> 'id')::uuid end,
          case tg_op when 'INSERT' then jsonb_build_object('new', to_jsonb(new)) when 'DELETE' then jsonb_build_object('old', to_jsonb(old))
                     else jsonb_build_object('old', to_jsonb(old), 'new', to_jsonb(new)) end);
  return coalesce(new, old);
end $$;
create trigger audit after insert or update or delete on public.drivers for each row execute function app_private.audit_row();
create trigger audit after insert or update or delete on public.units for each row execute function app_private.audit_row();
create trigger audit after insert or update or delete on public.assignments for each row execute function app_private.audit_row();
create trigger audit after insert or update or delete on public.rates for each row execute function app_private.audit_row();
create trigger audit after insert or update or delete on public.rate_exceptions for each row execute function app_private.audit_row();
create trigger audit after insert or update or delete on public.payment_methods for each row execute function app_private.audit_row();
create trigger audit after insert or update or delete on public.notification_schedules for each row execute function app_private.audit_row();
create trigger audit after insert or update or delete on public.message_templates for each row execute function app_private.audit_row();
create trigger audit after insert or update or delete on public.excel_imports for each row execute function app_private.audit_row();
create trigger audit after update on public.app_settings for each row execute function app_private.audit_row();

-- VIP · 0002 · Finanzas: métodos, cargos, pagos, ajustes, cierres y cálculo de posición.
-- El saldo NO se almacena (se calcula). Pagos, cargos y ajustes no se editan ni se borran.
set search_path = public, extensions;

create table public.payment_methods (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[a-z_]+$'),
  label text not null,
  commission_cents bigint not null default 0 check (commission_cents >= 0),   -- descuento del PROVEEDOR por operación
  active boolean not null default true
);
insert into public.payment_methods(code, label, commission_cents) values ('cash', 'Efectivo', 0), ('yappy', 'Yappy', 100), ('punto_pago', 'Punto Pago', 100);

create table public.adjustments (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references public.assignments(id),
  effective_date date not null,
  amount_cents bigint not null check (amount_cents <> 0),     -- + aumenta deuda, − otorga crédito
  reason text not null check (length(btrim(reason)) >= 3),
  idempotency_key text not null unique,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now()
);

create table public.charges (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references public.assignments(id),
  kind text not null check (kind in ('daily', 'adjustment')),
  charge_date date not null,
  amount_cents bigint not null check (amount_cents > 0),
  week_start date not null,
  adjustment_id uuid references public.adjustments(id),
  created_at timestamptz not null default now(),
  check ((kind = 'adjustment') = (adjustment_id is not null)),
  check (week_start = (charge_date - ((extract(isodow from charge_date)::int) - 1)))
);
create unique index charges_one_daily_per_day on public.charges(assignment_id, charge_date) where kind = 'daily';
create index charges_assignment_date_idx on public.charges(assignment_id, charge_date, created_at, id);
create index charges_week_idx on public.charges(week_start);

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references public.assignments(id),
  method_id uuid not null references public.payment_methods(id),
  gross_cents bigint not null check (gross_cents > 0),
  commission_cents bigint not null default 0 check (commission_cents >= 0),
  net_cents bigint not null check (net_cents > 0),
  applied_cents bigint not null check (applied_cents >= 0),
  credit_generated_cents bigint not null default 0 check (credit_generated_cents >= 0),
  reference text,
  notes text,
  paid_at timestamptz not null default now(),
  week_start date not null,
  idempotency_key text not null unique check (length(btrim(idempotency_key)) > 0),
  registered_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  voided_at timestamptz,
  voided_by uuid references public.profiles(id),
  void_reason text,
  check (net_cents = gross_cents - commission_cents),
  check (net_cents = applied_cents + credit_generated_cents),
  check ((voided_at is null) = (voided_by is null) and (voided_at is null) = (void_reason is null))
);
create index payments_assignment_idx on public.payments(assignment_id, paid_at);
create index payments_week_idx on public.payments(week_start);

create table public.payment_allocations (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references public.payments(id),
  charge_id uuid not null references public.charges(id),
  amount_cents bigint not null check (amount_cents > 0)
);
create index payment_allocations_payment_idx on public.payment_allocations(payment_id);

create table public.weekly_closures (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references public.assignments(id),
  week_start date not null check (extract(isodow from week_start) = 1),
  charged_cents bigint not null, gross_cents bigint not null, commission_cents bigint not null, net_cents bigint not null,
  pending_cents bigint not null,            -- deuda que se arrastra
  credit_cents bigint not null,             -- el crédito NUNCA se borra al cerrar
  closed_by uuid not null references public.profiles(id),
  closed_at timestamptz not null default now(),
  unique (assignment_id, week_start)
);

-- ───────── Posición (saldo) y cobertura FIFO ─────────
create function public.assignment_position(p_assignment uuid, p_as_of date default null, p_extra_net bigint default 0)
returns table (charged_cents bigint, gross_cents bigint, commission_cents bigint, net_cents bigint,
               pending_cents bigint, credit_cents bigint, balance_cents bigint)
language sql stable security invoker set search_path = '' as $$
  with a as (select a.id, app_private.tz() as timezone from public.assignments a where a.id = p_assignment),
  ch as (select coalesce(sum(c.amount_cents), 0)::bigint v from public.charges c
          where c.assignment_id = p_assignment and (p_as_of is null or c.charge_date <= p_as_of)),
  pay as (select coalesce(sum(p.gross_cents), 0)::bigint g, coalesce(sum(p.commission_cents), 0)::bigint cm, coalesce(sum(p.net_cents), 0)::bigint n
            from public.payments p, a where p.assignment_id = p_assignment and p.voided_at is null
             and (p_as_of is null or (p.paid_at at time zone a.timezone)::date <= p_as_of)),
  adj as (select coalesce(sum(-x.amount_cents) filter (where x.amount_cents < 0), 0)::bigint v from public.adjustments x
           where x.assignment_id = p_assignment and (p_as_of is null or x.effective_date <= p_as_of))
  select ch.v, pay.g, pay.cm, pay.n,
         greatest(ch.v - (pay.n + adj.v + p_extra_net), 0)::bigint,
         greatest((pay.n + adj.v + p_extra_net) - ch.v, 0)::bigint,
         (ch.v - (pay.n + adj.v + p_extra_net))::bigint
  from a, ch, pay, adj
$$;

create function public.assignment_coverage(p_assignment uuid, p_extra_net bigint default 0)
returns table (charge_id uuid, charge_date date, kind text, amount_cents bigint, covered_cents bigint, remaining_cents bigint)
language sql stable security invoker set search_path = '' as $$
  with funds as (
    select (coalesce((select sum(p.net_cents) from public.payments p where p.assignment_id = p_assignment and p.voided_at is null), 0)
          + coalesce((select sum(-x.amount_cents) from public.adjustments x where x.assignment_id = p_assignment and x.amount_cents < 0), 0)
          + p_extra_net)::bigint f),
  ordered as (
    select c.id, c.charge_date, c.kind, c.amount_cents,
           sum(c.amount_cents) over (order by c.charge_date, c.created_at, c.id rows between unbounded preceding and current row) cum
      from public.charges c where c.assignment_id = p_assignment)
  select o.id, o.charge_date, o.kind, o.amount_cents,
         greatest(0, least(o.amount_cents, funds.f - (o.cum - o.amount_cents)))::bigint,
         (o.amount_cents - greatest(0, least(o.amount_cents, funds.f - (o.cum - o.amount_cents))))::bigint
    from ordered o, funds order by o.charge_date, o.id
$$;

-- Desglose a una fecha: cuota de hoy / deuda anterior / futuro / total / crédito.
create function public.assignment_dues(p_assignment uuid, p_date date)
returns table (today_cents bigint, overdue_cents bigint, future_cents bigint, total_pending_cents bigint, credit_cents bigint)
language sql stable security invoker set search_path = '' as $$
  with cov as (select charge_date, remaining_cents from public.assignment_coverage(p_assignment))
  select coalesce(sum(remaining_cents) filter (where charge_date = p_date), 0)::bigint,
         coalesce(sum(remaining_cents) filter (where charge_date < p_date), 0)::bigint,
         coalesce(sum(remaining_cents) filter (where charge_date > p_date), 0)::bigint,
         coalesce(sum(remaining_cents), 0)::bigint,
         (select pos.credit_cents from public.assignment_position(p_assignment) pos)
    from cov
$$;

create view public.v_assignment_position with (security_invoker = true) as
select a.id as assignment_id, a.driver_id, a.unit_id, p.* from public.assignments a cross join lateral public.assignment_position(a.id) p;

create view public.v_collection_totals with (security_invoker = true) as
select p.week_start, m.code as method_code, count(*)::bigint as payments, sum(p.gross_cents)::bigint as gross_cents,
       sum(p.commission_cents)::bigint as commission_cents, sum(p.net_cents)::bigint as net_cents
  from public.payments p join public.payment_methods m on m.id = p.method_id where p.voided_at is null group by p.week_start, m.code;

create view public.v_movements with (security_invoker = true) as
select c.assignment_id, c.created_at as occurred_at, 'charge'::text as kind, c.id as ref_id, c.amount_cents, null::bigint as commission_cents, c.charge_date::text as detail, null::uuid as actor
  from public.charges c where c.kind = 'daily'
union all
select p.assignment_id, p.paid_at, 'payment', p.id, p.net_cents, p.commission_cents, case when p.voided_at is null then 'vigente' else 'anulado' end, p.registered_by from public.payments p
union all
select p.assignment_id, p.voided_at, 'payment_void', p.id, -p.net_cents, null, p.void_reason, p.voided_by from public.payments p where p.voided_at is not null
union all
select a.assignment_id, a.created_at, 'adjustment', a.id, a.amount_cents, null, a.reason, a.created_by from public.adjustments a;

-- Inmutabilidad
create trigger no_delete before delete on public.payments for each row execute function app_private.block_mutation();
create trigger no_delete before delete on public.charges for each row execute function app_private.block_mutation();
create trigger no_update before update on public.charges for each row execute function app_private.block_mutation();
create trigger no_mutation before update or delete on public.adjustments for each row execute function app_private.block_mutation();
create trigger no_mutation before update or delete on public.payment_allocations for each row execute function app_private.block_mutation();
create trigger no_mutation before update or delete on public.weekly_closures for each row execute function app_private.block_mutation();

create function app_private.payments_only_void() returns trigger language plpgsql as $$
begin
  if (new.id, new.assignment_id, new.method_id, new.gross_cents, new.commission_cents, new.net_cents, new.applied_cents,
      new.credit_generated_cents, new.reference, new.notes, new.paid_at, new.week_start, new.idempotency_key, new.registered_by, new.created_at)
     is distinct from
     (old.id, old.assignment_id, old.method_id, old.gross_cents, old.commission_cents, old.net_cents, old.applied_cents,
      old.credit_generated_cents, old.reference, old.notes, old.paid_at, old.week_start, old.idempotency_key, old.registered_by, old.created_at)
     or old.voided_at is not null then
    raise exception 'Un pago registrado solo puede anularse (void_payment)' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger only_void before update on public.payments for each row execute function app_private.payments_only_void();

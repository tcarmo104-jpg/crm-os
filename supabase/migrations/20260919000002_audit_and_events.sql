-- =============================================================================
-- 0002 AUDITORÍA + EVENT STREAM (outbox transaccional)
-- =============================================================================
-- audit_logs   : quién / qué / cuándo / desde dónde / antes / después. Append-only.
-- domain_events: un único stream de eventos de dominio. Se escribe en la MISMA
--                transacción que el cambio (outbox) y alimenta timeline,
--                automatizaciones, scoring, analytics y notificaciones.
--                El "customer timeline" (Fase 2) será una vista filtrada por customer_id.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- audit_logs
-- ---------------------------------------------------------------------------
create table public.audit_logs (
  id           bigint generated always as identity primary key,
  org_id       uuid not null,            -- sin FK: la auditoría sobrevive a la organización
  actor_id     uuid,                     -- null = sistema / service_role
  action       text not null,            -- '<tabla>.<insert|update|delete>'
  entity_type  text not null,
  entity_id    uuid,
  old_values   jsonb,                    -- en UPDATE: solo columnas que cambiaron
  new_values   jsonb,
  ip           inet,
  created_at   timestamptz not null default now()
);
create index audit_logs_org_created_idx on public.audit_logs (org_id, created_at desc);
create index audit_logs_entity_idx on public.audit_logs (org_id, entity_type, entity_id, created_at desc);

create or replace function app.audit_prevent_mutation() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'audit_logs is append-only' using errcode = '42501';
end $$;

create trigger audit_logs_no_update before update or delete on public.audit_logs
  for each row execute function app.audit_prevent_mutation();
create trigger audit_logs_no_truncate before truncate on public.audit_logs
  for each statement execute function app.audit_prevent_mutation();

create or replace function app.audit_row_change() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_old jsonb; v_new jsonb; v_row jsonb;
  v_old_d jsonb; v_new_d jsonb;
  v_id uuid; v_org uuid; v_ip inet;
begin
  if tg_op = 'INSERT' then
    v_new := to_jsonb(new); v_row := v_new;
  elsif tg_op = 'DELETE' then
    v_old := to_jsonb(old); v_row := v_old;
  else
    v_old := to_jsonb(old); v_new := to_jsonb(new); v_row := v_new;
  end if;

  v_id  := (v_row ->> 'id')::uuid;
  v_org := case when tg_table_name = 'organizations' then v_id else (v_row ->> 'org_id')::uuid end;

  if tg_op = 'UPDATE' then
    select jsonb_object_agg(k, v_old -> k), jsonb_object_agg(k, v_new -> k)
      into v_old_d, v_new_d
    from jsonb_object_keys(v_new) as k
    where k <> 'updated_at' and (v_old -> k) is distinct from (v_new -> k);
    if v_new_d is null then return new; end if;   -- solo cambió updated_at
    v_old := v_old_d; v_new := v_new_d;
  end if;

  begin
    v_ip := nullif(trim(split_part(
      coalesce(nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-forwarded-for', ''),
      ',', 1)), '')::inet;
  exception when others then
    v_ip := null;
  end;

  insert into public.audit_logs (org_id, actor_id, action, entity_type, entity_id, old_values, new_values, ip)
  values (v_org, auth.uid(), tg_table_name || '.' || lower(tg_op), tg_table_name, v_id, v_old, v_new, v_ip);

  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;

create trigger organizations_audit after insert or update or delete on public.organizations
  for each row execute function app.audit_row_change();
create trigger teams_audit after insert or update or delete on public.teams
  for each row execute function app.audit_row_change();
create trigger memberships_audit after insert or update or delete on public.memberships
  for each row execute function app.audit_row_change();

-- ---------------------------------------------------------------------------
-- domain_events (outbox)
-- ---------------------------------------------------------------------------
create table public.domain_events (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id) on delete cascade,
  type          text not null check (type ~ '^[a-z_]+(\.[a-z_]+)+$'),   -- p.ej. 'quote.accepted'
  entity_type   text,
  entity_id     uuid,
  customer_id   uuid,                 -- FK a customers se agrega en la Fase 2
  payload       jsonb not null default '{}'::jsonb,
  actor_id      uuid,
  occurred_at   timestamptz not null default now(),
  -- estado de entrega (uso interno de workers)
  attempts      int not null default 0,
  locked_until  timestamptz,
  processed_at  timestamptz,
  dead_at       timestamptz,
  last_error    text
);
create index domain_events_pending_idx on public.domain_events (occurred_at, id)
  where processed_at is null and dead_at is null;
create index domain_events_org_idx on public.domain_events (org_id, occurred_at desc);
create index domain_events_customer_idx on public.domain_events (org_id, customer_id, occurred_at desc)
  where customer_id is not null;

create or replace function app.emit_event(
  p_org uuid, p_type text, p_entity_type text, p_entity_id uuid,
  p_payload jsonb default '{}'::jsonb, p_customer uuid default null
) returns uuid language sql security definer set search_path = '' as $$
  insert into public.domain_events (org_id, type, entity_type, entity_id, customer_id, payload, actor_id)
  values (p_org, p_type, p_entity_type, p_entity_id, p_customer, coalesce(p_payload, '{}'::jsonb), auth.uid())
  returning id
$$;

-- Reclama un lote para procesarlo. SKIP LOCKED => varios workers sin pisarse.
create or replace function app.claim_events(p_limit int default 100, p_lock interval default interval '1 minute')
returns setof public.domain_events language sql security definer set search_path = '' as $$
  update public.domain_events e
     set locked_until = now() + p_lock, attempts = e.attempts + 1
   where e.id in (
     select id from public.domain_events
      where processed_at is null and dead_at is null
        and (locked_until is null or locked_until < now())
      order by occurred_at, id
      limit p_limit
      for update skip locked)
  returning e.*
$$;

create or replace function app.complete_event(p_id uuid) returns void
language sql security definer set search_path = '' as $$
  update public.domain_events set processed_at = now(), locked_until = null, last_error = null where id = p_id
$$;

-- Reintento con backoff exponencial (5s, 10s, 20s, ... máx 1h); dead-letter tras p_max intentos.
create or replace function app.fail_event(p_id uuid, p_error text, p_max int default 8) returns void
language sql security definer set search_path = '' as $$
  update public.domain_events
     set last_error   = left(p_error, 2000),
         locked_until = now() + least(interval '1 hour', interval '5 seconds' * power(2, attempts - 1)),
         dead_at      = case when attempts >= p_max then now() end
   where id = p_id
$$;

-- ---------------------------------------------------------------------------
-- Privilegios + RLS
-- ---------------------------------------------------------------------------
revoke all on public.audit_logs, public.domain_events from anon, authenticated;
grant select on public.audit_logs to authenticated;
grant select, insert on public.audit_logs to service_role;
grant all on public.domain_events to service_role;

alter table public.audit_logs    enable row level security;
alter table public.domain_events enable row level security;

create policy audit_logs_select on public.audit_logs
  for select to authenticated using ((select app.has_permission(org_id, 'audit:read')));
-- domain_events: sin políticas para clientes. Solo service_role (RLS bypass).
-- La lectura para usuarios llegará vía vistas/RPC que respeten permisos a nivel de registro.

revoke all on function app.audit_prevent_mutation(), app.audit_row_change(),
  app.emit_event(uuid, text, text, uuid, jsonb, uuid),
  app.claim_events(int, interval), app.complete_event(uuid), app.fail_event(uuid, text, int)
  from public, anon, authenticated;
grant execute on function app.emit_event(uuid, text, text, uuid, jsonb, uuid),
  app.claim_events(int, interval), app.complete_event(uuid), app.fail_event(uuid, text, int)
  to service_role;

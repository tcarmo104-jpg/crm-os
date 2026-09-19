-- =============================================================================
-- 0009 PIPELINES, OPORTUNIDADES Y LOG DE TRANSICIONES DE ESTADO
-- =============================================================================
-- Reglas que viven en la base de datos (no en la interfaz):
--   * TODA transición de estado (lead u oportunidad) queda registrada con quién, cuándo, de qué
--     a qué, por qué y por qué vía. Lo hace un trigger: no hay forma de cambiar un estado sin log.
--   * El log es append-only.
--   * Una oportunidad hereda su propietario del cliente: nunca es visible para quien no ve al cliente.
--   * Perder una oportunidad exige un motivo; reabrir una cerrada exige manager/admin.
--   * Los cambios de estado solo se hacen por RPC (las columnas de estado no son escribibles).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- ENDURECIMIENTO: can_access_row NUNCA devuelve NULL.
-- Con un registro sin propietario (p_owner NULL) la comparación `p_owner = auth.uid()` daba NULL, y el patrón
--   if not found or not app.can_access_row(...) then raise ...
-- deja pasar el NULL sin lanzar el error (NOT NULL = NULL). Así un vendedor podía operar por RPC sobre
-- registros sin propietario (p. ej. add_customer_identifier en la Fase 2). Ahora es false.
-- ---------------------------------------------------------------------------
create or replace function app.can_access_row(p_org uuid, p_perm text, p_owner uuid, p_team uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(
    case app.permission_scope(p_org, p_perm)
      when 'org'  then true
      when 'team' then p_owner = auth.uid()
                       or (p_team is not null and p_team = app.my_team_id(p_org))
      when 'own'  then p_owner = auth.uid()
      else false
    end, false)
$$;

-- ---------------------------------------------------------------------------
-- ENDURECIMIENTO: el orden cronológico debe ser real dentro de una transacción.
-- now() es CONSTANTE en toda la transacción: dos eventos del mismo request (p. ej. «cliente creado» y
-- «lead recibido», o las dos transiciones de convert_lead) empataban y se mostraban en orden aleatorio.
-- ---------------------------------------------------------------------------
alter table public.domain_events alter column occurred_at set default clock_timestamp();
alter table public.audit_logs    alter column created_at  set default clock_timestamp();

-- ---------------------------------------------------------------------------
-- Los datos DERIVADOS de un cliente no pueden ser más visibles que el cliente (regla de §12).
-- Misma idea que 0004: solo cambia datos de la matriz; es reversible.
-- ---------------------------------------------------------------------------
update public.role_permissions rp
   set scope = 'own'
  from public.roles r
 where r.id = rp.role_id
   and r.org_id is null
   and r.key in ('marketing', 'customer_service', 'analyst', 'viewer')
   and rp.permission_key ~ '^(opportunities|quotes|sales|conversations|tasks|cases):'
   and rp.scope = 'org';

-- ---------------------------------------------------------------------------
-- Registro de tablas que referencian a customers (lo usa merge_customers).
-- Toda tabla nueva con customer_id debe registrarse aquí: una prueba estructural lo exige.
-- ---------------------------------------------------------------------------
create table app.customer_merge_targets (table_name text primary key);
revoke all on app.customer_merge_targets from public, anon, authenticated;
insert into app.customer_merge_targets values ('customer_identifiers'), ('leads'), ('domain_events'), ('opportunities');

-- ---------------------------------------------------------------------------
-- Pipelines y etapas
-- ---------------------------------------------------------------------------
create table public.pipelines (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  name        text not null check (char_length(btrim(name)) between 1 and 80),
  is_default  boolean not null default false,
  archived_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (id, org_id)
);
create unique index pipelines_one_default on public.pipelines (org_id) where is_default and archived_at is null;
create unique index pipelines_name_uk on public.pipelines (org_id, lower(btrim(name))) where archived_at is null;

create table public.pipeline_stages (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  pipeline_id uuid not null,
  name        text not null check (char_length(btrim(name)) between 1 and 60),
  kind        text not null check (kind in ('open', 'won', 'lost')),
  position    int  not null default 0,
  probability int  not null default 0,
  archived_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (id, org_id),
  foreign key (pipeline_id, org_id) references public.pipelines (id, org_id) on delete cascade,
  check (case kind when 'won' then probability = 100 when 'lost' then probability = 0
                   else probability between 0 and 99 end)
);
create unique index pipeline_stages_name_uk on public.pipeline_stages (pipeline_id, lower(btrim(name))) where archived_at is null;
create index pipeline_stages_pipeline_idx on public.pipeline_stages (pipeline_id, kind, position);

create trigger pipelines_touch before update on public.pipelines for each row execute function app.touch_updated_at();
create trigger pipeline_stages_touch before update on public.pipeline_stages for each row execute function app.touch_updated_at();

-- Posición automática (de 10 en 10, dentro del mismo tipo de etapa).
create or replace function app.pipeline_stages_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if exists (select 1 from public.pipelines p where p.id = new.pipeline_id and p.archived_at is not null) then
      raise exception 'pipeline is archived' using errcode = '23514';
    end if;
    if (select count(*) from public.pipeline_stages s where s.pipeline_id = new.pipeline_id and s.archived_at is null) >= 25 then
      raise exception 'stage limit reached' using errcode = '53400';
    end if;
    if new.position = 0 then
      new.position := coalesce((select max(s.position) from public.pipeline_stages s
                                 where s.pipeline_id = new.pipeline_id and s.kind = new.kind), 0) + 10;
    end if;
    return new;
  end if;

  if new.kind <> old.kind or new.pipeline_id <> old.pipeline_id or new.org_id <> old.org_id then
    raise exception 'stage kind and pipeline are immutable' using errcode = '23514';
  end if;

  if new.archived_at is not null and old.archived_at is null then
    if exists (select 1 from public.opportunities o where o.stage_id = new.id and o.status = 'open') then
      raise exception 'stage_in_use' using errcode = '23514';
    end if;
    -- Cada pipeline conserva al menos una etapa activa de cada tipo (abierta, ganada, perdida).
    if not exists (select 1 from public.pipeline_stages s
                    where s.pipeline_id = new.pipeline_id and s.kind = new.kind
                      and s.archived_at is null and s.id <> new.id) then
      raise exception 'last_stage_of_kind' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
create trigger pipeline_stages_guard_trg before insert or update on public.pipeline_stages
  for each row execute function app.pipeline_stages_guard();

create or replace function app.pipelines_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.archived_at is not null and old.archived_at is null then
    if old.is_default then
      raise exception 'default_pipeline' using errcode = '23514';
    end if;
    if exists (select 1 from public.opportunities o where o.pipeline_id = new.id and o.status = 'open') then
      raise exception 'pipeline_in_use' using errcode = '23514';
    end if;
  end if;
  if new.is_default is distinct from old.is_default and auth.uid() is not null
     and current_setting('app.pipeline_default_change', true) is distinct from 'on' then
    raise exception 'use set_default_pipeline' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger pipelines_guard_trg before update on public.pipelines
  for each row execute function app.pipelines_guard();

-- Etapas por defecto (las usa el pipeline inicial y cada pipeline nuevo).
create or replace function app.add_default_stages(p_org uuid, p_pipe uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.pipeline_stages (org_id, pipeline_id, name, kind, position, probability) values
    (p_org, p_pipe, 'Nuevo',       'open', 10, 10),
    (p_org, p_pipe, 'Contactado',  'open', 20, 25),
    (p_org, p_pipe, 'Propuesta',   'open', 30, 50),
    (p_org, p_pipe, 'Negociación', 'open', 40, 75),
    (p_org, p_pipe, 'Ganada',      'won',  10, 100),
    (p_org, p_pipe, 'Perdida',     'lost', 10, 0);
end $$;

-- Pipeline por defecto de cada organización (nueva o existente).
create or replace function app.seed_default_pipeline(p_org uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_pipe uuid;
begin
  if exists (select 1 from public.pipelines where org_id = p_org) then return; end if;
  insert into public.pipelines (org_id, name, is_default) values (p_org, 'Ventas', true) returning id into v_pipe;
  perform app.add_default_stages(p_org, v_pipe);
end $$;

-- Un pipeline nuevo nace SIEMPRE con etapas (un INSERT directo lo dejaría inutilizable).
create or replace function public.create_pipeline(p_org uuid, p_name text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_pipe uuid;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not app.has_permission(p_org, 'pipelines:manage') then raise exception 'not allowed' using errcode = '42501'; end if;
  if btrim(coalesce(p_name, '')) = '' then raise exception 'name_required' using errcode = '22023'; end if;
  if (select count(*) from public.pipelines where org_id = p_org and archived_at is null) >= 10 then
    raise exception 'pipeline limit reached' using errcode = '53400';
  end if;
  insert into public.pipelines (org_id, name) values (p_org, btrim(p_name)) returning id into v_pipe;
  perform app.add_default_stages(p_org, v_pipe);
  return v_pipe;
end $$;

create or replace function app.organizations_seed_pipeline() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform app.seed_default_pipeline(new.id);
  return null;
end $$;
create trigger organizations_seed_pipeline_trg after insert on public.organizations
  for each row execute function app.organizations_seed_pipeline();

select app.seed_default_pipeline(id) from public.organizations;   -- organizaciones existentes

-- Cambiar el pipeline por defecto (atómico).
create or replace function public.set_default_pipeline(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select org_id into v_org from public.pipelines where id = p_id and archived_at is null;
  if v_org is null or not app.has_permission(v_org, 'pipelines:manage') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform set_config('app.pipeline_default_change', 'on', true);
  update public.pipelines set is_default = false where org_id = v_org and is_default and id <> p_id;
  update public.pipelines set is_default = true where id = p_id;
  perform set_config('app.pipeline_default_change', 'off', true);
end $$;

-- ---------------------------------------------------------------------------
-- Log de transiciones de estado (append-only)
-- ---------------------------------------------------------------------------
create table public.state_transitions (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  entity_type text not null check (entity_type in ('lead', 'opportunity')),
  entity_id   uuid not null,
  from_state  text,
  to_state    text not null,
  actor_id    uuid,
  source      text not null default 'user' check (source in ('user', 'system', 'api', 'automation')),
  reason      text check (char_length(reason) <= 500),
  meta        jsonb not null default '{}'::jsonb,    -- ids/tipos de etapa para analítica de embudo
  occurred_at timestamptz not null default clock_timestamp()
);
create index state_transitions_entity_idx on public.state_transitions (org_id, entity_type, entity_id, occurred_at, id);

create or replace function app.state_transitions_immutable() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'state_transitions is append-only' using errcode = '42501';
  end if;
  -- Se permite la cascada al eliminar la organización completa.
  if tg_op = 'DELETE' and not exists (select 1 from public.organizations where id = old.org_id) then
    return old;
  end if;
  raise exception 'state_transitions is append-only' using errcode = '42501';
end $$;
create trigger state_transitions_no_mutation before update or delete on public.state_transitions
  for each row execute function app.state_transitions_immutable();
create trigger state_transitions_no_truncate before truncate on public.state_transitions
  for each statement execute function app.state_transitions_immutable();

-- ---------------------------------------------------------------------------
-- Leads: máquina de estados
-- ---------------------------------------------------------------------------
alter table public.leads
  add column disqualified_reason text check (char_length(disqualified_reason) <= 500),
  add column converted_opportunity_id uuid;

create or replace function app.leads_status_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_reason text := nullif(btrim(coalesce(current_setting('app.transition_reason', true), '')), '');
begin
  if new.status = old.status then return new; end if;

  if not (
       (old.status = 'new'          and new.status in ('contacted', 'qualified', 'disqualified'))
    or (old.status = 'contacted'    and new.status in ('qualified', 'disqualified', 'new'))
    or (old.status = 'qualified'    and new.status in ('converted', 'disqualified', 'contacted'))
    or (old.status = 'disqualified' and new.status = 'new')
  ) then
    raise exception 'invalid_transition: % -> %', old.status, new.status using errcode = '23514';
  end if;

  if new.status = 'disqualified' then
    if v_reason is null or char_length(v_reason) < 3 then
      raise exception 'reason_required' using errcode = '23514';
    end if;
    new.disqualified_reason := left(v_reason, 500);
  elsif old.status = 'disqualified' then
    new.disqualified_reason := null;
  end if;

  if new.status = 'converted' and new.converted_opportunity_id is null then
    raise exception 'convert_requires_opportunity' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger leads_status_guard_trg before update of status on public.leads
  for each row execute function app.leads_status_guard();

-- ---------------------------------------------------------------------------
-- Oportunidades
-- ---------------------------------------------------------------------------
create table public.opportunities (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references public.organizations(id) on delete cascade,
  customer_id         uuid not null,
  pipeline_id         uuid not null,
  stage_id            uuid not null,
  title               text not null check (char_length(btrim(title)) between 1 and 160),
  amount              numeric(14, 2) not null default 0 check (amount >= 0),
  currency            text check (currency ~ '^[A-Z]{3}$'),
  expected_close_date date,
  product_interest    text check (char_length(product_interest) <= 200),
  status              text not null default 'open' check (status in ('open', 'won', 'lost')),
  lost_reason         text check (char_length(lost_reason) <= 500),
  closed_at           timestamptz,
  owner_id            uuid references auth.users(id) on delete set null,
  team_id             uuid,
  custom_fields       jsonb not null default '{}'::jsonb,
  created_by          uuid references auth.users(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (id, org_id),
  foreign key (customer_id, org_id) references public.customers (id, org_id),
  foreign key (pipeline_id, org_id) references public.pipelines (id, org_id),
  foreign key (stage_id, org_id)    references public.pipeline_stages (id, org_id),
  foreign key (team_id, org_id)     references public.teams (id, org_id) on delete set null (team_id),
  check ((status = 'lost') = (lost_reason is not null)),
  check ((status = 'open') = (closed_at is null))
);
create index opportunities_org_status_idx   on public.opportunities (org_id, status, stage_id);
create index opportunities_customer_idx     on public.opportunities (customer_id);
create index opportunities_owner_idx        on public.opportunities (org_id, owner_id, status);
create index opportunities_org_created_idx on public.opportunities (org_id, created_at desc, id desc);

alter table public.leads
  add foreign key (converted_opportunity_id, org_id) references public.opportunities (id, org_id);

create or replace function app.opportunities_prepare() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_uid    uuid := auth.uid();
  v_kind   text;
  v_reason text := nullif(btrim(coalesce(current_setting('app.transition_reason', true), '')), '');
  v_org_scope public.permission_scope;
begin
  new.title := btrim(new.title);

  if tg_op = 'INSERT' then
    -- Propietario y equipo: SIEMPRE los del cliente (fuente única de verdad).
    select c.owner_id, c.team_id into new.owner_id, new.team_id
      from public.customers c where c.id = new.customer_id and c.org_id = new.org_id and c.deleted_at is null;
    if not found then
      raise exception 'customer not found' using errcode = '22023';
    end if;
    if new.currency is null then
      select o.currency into new.currency from public.organizations o where o.id = new.org_id;
    end if;
  else
    if new.pipeline_id <> old.pipeline_id or new.org_id <> old.org_id
       or (new.customer_id <> old.customer_id and current_setting('app.customer_merge', true) is distinct from 'on') then
      raise exception 'pipeline and customer are immutable' using errcode = '23514';
    end if;
    v_org_scope := case when v_uid is null then 'org'::public.permission_scope
                        else app.permission_scope(new.org_id, 'opportunities:update') end;
    -- Una oportunidad cerrada es de solo lectura, salvo para manager/admin.
    if old.status <> 'open' and v_org_scope is distinct from 'org'
       and (new.stage_id <> old.stage_id or new.title <> old.title or new.amount <> old.amount
            or new.expected_close_date is distinct from old.expected_close_date) then
      raise exception 'only managers can change a closed opportunity' using errcode = '42501';
    end if;
  end if;

  if tg_op = 'INSERT' or new.stage_id <> old.stage_id then
    select s.kind into v_kind from public.pipeline_stages s
     where s.id = new.stage_id and s.pipeline_id = new.pipeline_id and s.org_id = new.org_id and s.archived_at is null;
    if v_kind is null then
      raise exception 'invalid_stage' using errcode = '23514';
    end if;
    if tg_op = 'INSERT' and v_kind <> 'open' then
      raise exception 'a new opportunity must start in an open stage' using errcode = '23514';
    end if;

    new.status    := v_kind;
    new.closed_at := case when v_kind = 'open' then null else now() end;
    if v_kind = 'lost' then
      if v_reason is null or char_length(v_reason) < 3 then
        raise exception 'reason_required' using errcode = '23514';
      end if;
      new.lost_reason := left(v_reason, 500);
    else
      new.lost_reason := null;
    end if;
  end if;
  return new;
end $$;
create trigger opportunities_prepare_trg before insert or update on public.opportunities
  for each row execute function app.opportunities_prepare();
create trigger opportunities_custom_fields_trg before insert or update on public.opportunities
  for each row execute function app.custom_fields_trigger();
create trigger opportunities_touch before update on public.opportunities
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Registro automático de transiciones + eventos (leads y oportunidades)
-- ---------------------------------------------------------------------------
create or replace function app.log_transition() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_reason text := nullif(btrim(coalesce(current_setting('app.transition_reason', true), '')), '');
  v_src    text := coalesce(nullif(current_setting('app.transition_source', true), ''),
                            case when auth.uid() is null then 'system' else 'user' end);
  v_from   record;
  v_to     record;
begin
  if tg_table_name = 'leads' then
    if tg_op = 'INSERT' or new.status is distinct from old.status then
      insert into public.state_transitions (org_id, entity_type, entity_id, from_state, to_state, actor_id, source, reason)
      values (new.org_id, 'lead', new.id, case when tg_op = 'UPDATE' then old.status end, new.status, auth.uid(), v_src, v_reason);
      if tg_op = 'UPDATE' then
        perform app.emit_event(new.org_id, 'lead.status_changed', 'lead', new.id,
          jsonb_build_object('from', old.status, 'to', new.status, 'reason', left(v_reason, 200)), new.customer_id);
      end if;
    end if;
    return null;
  end if;

  -- oportunidades
  select s.name, s.kind, s.id into v_to from public.pipeline_stages s where s.id = new.stage_id;
  if tg_op = 'INSERT' then
    insert into public.state_transitions (org_id, entity_type, entity_id, from_state, to_state, actor_id, source, reason, meta)
    values (new.org_id, 'opportunity', new.id, null, v_to.name, auth.uid(), v_src, v_reason,
            jsonb_build_object('to_stage_id', v_to.id, 'to_kind', v_to.kind, 'amount', new.amount));
    perform app.emit_event(new.org_id, 'opportunity.created', 'opportunity', new.id,
      jsonb_build_object('title', new.title, 'amount', new.amount, 'stage', v_to.name), new.customer_id);
  elsif new.stage_id <> old.stage_id then
    select s.name, s.kind, s.id into v_from from public.pipeline_stages s where s.id = old.stage_id;
    insert into public.state_transitions (org_id, entity_type, entity_id, from_state, to_state, actor_id, source, reason, meta)
    values (new.org_id, 'opportunity', new.id, v_from.name, v_to.name, auth.uid(), v_src, v_reason,
            jsonb_build_object('from_stage_id', v_from.id, 'from_kind', v_from.kind,
                               'to_stage_id', v_to.id, 'to_kind', v_to.kind, 'amount', new.amount));
    perform app.emit_event(new.org_id,
      case v_to.kind when 'won' then 'opportunity.won' when 'lost' then 'opportunity.lost' else 'opportunity.stage_changed' end,
      'opportunity', new.id,
      jsonb_build_object('title', new.title, 'from', v_from.name, 'to', v_to.name, 'amount', new.amount,
                         'reason', left(v_reason, 200)),
      new.customer_id);
  end if;
  return null;
end $$;

create trigger leads_log_transition_trg after insert or update of status on public.leads
  for each row execute function app.log_transition();
create trigger opportunities_log_transition_trg after insert or update of stage_id on public.opportunities
  for each row execute function app.log_transition();

-- Estado inicial de los leads que ya existían (para que el historial esté completo).
insert into public.state_transitions (org_id, entity_type, entity_id, from_state, to_state, source, occurred_at)
select org_id, 'lead', id, null, status, 'system', created_at from public.leads;

-- ---------------------------------------------------------------------------
-- Los leads abiertos y las oportunidades abiertas siguen al cliente al reasignarlo.
-- ---------------------------------------------------------------------------
create or replace function app.customers_after_update() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.owner_id is distinct from old.owner_id then
    update public.leads
       set owner_id = new.owner_id, team_id = new.team_id
     where customer_id = new.id and org_id = new.org_id
       and status in ('new', 'contacted', 'qualified');
    update public.opportunities
       set owner_id = new.owner_id, team_id = new.team_id
     where customer_id = new.id and org_id = new.org_id and status = 'open';
    perform app.emit_event(new.org_id, 'customer.assigned', 'customer', new.id,
                           jsonb_build_object('owner_id', new.owner_id), new.id);
  end if;
  if new.do_not_contact is distinct from old.do_not_contact then
    perform app.emit_event(new.org_id,
      case when new.do_not_contact then 'customer.dnc_set' else 'customer.dnc_cleared' end,
      'customer', new.id, jsonb_build_object('reason', new.dnc_reason), new.id);
  end if;
  return null;
end $$;

-- ---------------------------------------------------------------------------
-- Campos personalizados también para oportunidades
-- ---------------------------------------------------------------------------
alter table public.custom_field_definitions drop constraint custom_field_definitions_entity_check;
alter table public.custom_field_definitions
  add constraint custom_field_definitions_entity_check check (entity in ('customer', 'lead', 'opportunity'));

create or replace function app.custom_fields_trigger() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_entity text := case tg_table_name when 'customers' then 'customer' when 'leads' then 'lead'
                                            when 'opportunities' then 'opportunity' end;
begin
  if tg_op = 'INSERT' or new.custom_fields is distinct from old.custom_fields then
    perform app.validate_custom_fields(new.org_id, v_entity, new.custom_fields);
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- RPC: transiciones (las columnas de estado no son escribibles por los usuarios)
-- ---------------------------------------------------------------------------
create or replace function public.set_lead_status(p_lead uuid, p_to text, p_reason text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare l public.leads%rowtype;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into l from public.leads where id = p_lead for update;
  if not found or not app.can_access_row(l.org_id, 'leads:update', l.owner_id, l.team_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_to = 'converted' then
    raise exception 'use convert_lead' using errcode = '22023';
  end if;
  perform set_config('app.transition_reason', coalesce(p_reason, ''), true);
  perform set_config('app.transition_source', 'user', true);
  update public.leads set status = p_to where id = l.id;
  perform set_config('app.transition_reason', '', true);
  perform set_config('app.transition_source', '', true);
end $$;

create or replace function app.create_opportunity_core(
  p_org uuid, p_customer uuid, p_title text, p_amount numeric, p_pipeline uuid,
  p_expected date, p_interest text, p_actor uuid
) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_pipe uuid; v_stage uuid; v_id uuid;
begin
  if p_pipeline is null then
    select id into v_pipe from public.pipelines where org_id = p_org and is_default and archived_at is null;
  else
    select id into v_pipe from public.pipelines where id = p_pipeline and org_id = p_org and archived_at is null;
  end if;
  if v_pipe is null then raise exception 'pipeline not found' using errcode = '22023'; end if;

  select s.id into v_stage from public.pipeline_stages s
   where s.pipeline_id = v_pipe and s.kind = 'open' and s.archived_at is null
   order by s.position, s.created_at limit 1;
  if v_stage is null then raise exception 'pipeline has no open stage' using errcode = '22023'; end if;

  insert into public.opportunities (org_id, customer_id, pipeline_id, stage_id, title, amount,
                                    expected_close_date, product_interest, created_by)
  values (p_org, p_customer, v_pipe, v_stage, p_title, coalesce(p_amount, 0), p_expected,
          nullif(btrim(coalesce(p_interest, '')), ''), p_actor)
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.create_opportunity(
  p_customer uuid, p_title text, p_amount numeric default 0, p_pipeline uuid default null,
  p_expected_close date default null, p_product_interest text default null
) returns uuid language plpgsql security definer set search_path = '' as $$
declare c public.customers%rowtype;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into c from public.customers where id = p_customer and deleted_at is null;
  if not found or not app.can_access_row(c.org_id, 'customers:read', c.owner_id, c.team_id)
     or not app.has_permission(c.org_id, 'opportunities:create') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if btrim(coalesce(p_title, '')) = '' then raise exception 'name_required' using errcode = '22023'; end if;
  return app.create_opportunity_core(c.org_id, c.id, p_title, p_amount, p_pipeline, p_expected_close, p_product_interest, auth.uid());
end $$;

create or replace function public.move_opportunity(p_id uuid, p_stage uuid, p_reason text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare o public.opportunities%rowtype;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into o from public.opportunities where id = p_id for update;
  if not found or not app.can_access_row(o.org_id, 'opportunities:update', o.owner_id, o.team_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform set_config('app.transition_reason', coalesce(p_reason, ''), true);
  perform set_config('app.transition_source', 'user', true);
  update public.opportunities set stage_id = p_stage where id = o.id;
  perform set_config('app.transition_reason', '', true);
  perform set_config('app.transition_source', '', true);
end $$;

-- Convierte un lead en oportunidad (atómico). Desde nuevo/contactado pasa primero por "calificado" (queda en el log).
create or replace function public.convert_lead(
  p_lead uuid, p_pipeline uuid default null, p_title text default null, p_amount numeric default 0
) returns uuid language plpgsql security definer set search_path = '' as $$
declare l public.leads%rowtype; c public.customers%rowtype; v_opp uuid; v_title text;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into l from public.leads where id = p_lead for update;
  if not found or not app.can_access_row(l.org_id, 'leads:update', l.owner_id, l.team_id)
     or not app.has_permission(l.org_id, 'opportunities:create') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if l.status in ('converted', 'disqualified') then
    raise exception 'lead_not_convertible' using errcode = '23514';
  end if;
  select * into c from public.customers where id = l.customer_id and deleted_at is null;
  if not found then raise exception 'customer not found' using errcode = '22023'; end if;

  v_title := coalesce(nullif(btrim(coalesce(p_title, '')), ''),
                      nullif(btrim(coalesce(l.product_interest, '')), ''), 'Oportunidad de ' || c.full_name);
  v_opp := app.create_opportunity_core(l.org_id, l.customer_id, left(v_title, 160), p_amount, p_pipeline, null,
                                       l.product_interest, auth.uid());

  perform set_config('app.transition_source', 'user', true);
  if l.status in ('new', 'contacted') then
    perform set_config('app.transition_reason', 'Conversión a oportunidad', true);
    update public.leads set status = 'qualified' where id = l.id;
  end if;
  perform set_config('app.transition_reason', 'Convertido en oportunidad', true);
  update public.leads set status = 'converted', converted_opportunity_id = v_opp where id = l.id;
  perform set_config('app.transition_reason', '', true);
  perform set_config('app.transition_source', '', true);
  return v_opp;
end $$;

-- ---------------------------------------------------------------------------
-- merge_customers: ahora usa el registro de tablas (ver app.customer_merge_targets)
-- ---------------------------------------------------------------------------
create or replace function public.merge_customers(p_keep uuid, p_drop uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  k public.customers%rowtype;
  d public.customers%rowtype;
  v_locked int;
  t text;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if p_keep = p_drop then
    raise exception 'cannot merge a customer with itself' using errcode = '22023';
  end if;

  select count(*) into v_locked from (
    select 1 from public.customers where id in (p_keep, p_drop) and deleted_at is null order by id for update) s;
  if v_locked <> 2 then
    raise exception 'customer not found' using errcode = '22023';
  end if;
  select * into k from public.customers where id = p_keep;
  select * into d from public.customers where id = p_drop;

  if k.org_id <> d.org_id then
    raise exception 'customers belong to different organizations' using errcode = '42501';
  end if;
  if app.permission_scope(k.org_id, 'customers:update') is distinct from 'org' then
    raise exception 'only managers can merge customers' using errcode = '42501';
  end if;
  if k.type <> d.type then
    raise exception 'cannot merge a person with a company' using errcode = '22023';
  end if;

  perform set_config('app.customer_merge', 'on', true);
  -- Toda tabla con customer_id está en el registro (una prueba estructural lo exige).
  for t in select table_name from app.customer_merge_targets order by table_name loop
    execute format('update public.%I set customer_id = $1 where customer_id = $2 and org_id = $3', t)
      using k.id, d.id, k.org_id;
  end loop;
  update public.customers set company_id = k.id where company_id = d.id and org_id = k.org_id and id <> k.id;

  update public.identity_reviews
     set status = case when (customer_id = k.id and candidate_id = d.id) or (customer_id = d.id and candidate_id = k.id)
                       then 'merged' else 'dismissed' end,
         resolved_by = auth.uid(), resolved_at = now()
   where org_id = k.org_id and status = 'pending'
     and (customer_id = d.id or candidate_id = d.id);

  update public.customers set
    city              = coalesce(k.city, d.city),
    country           = coalesce(k.country, d.country),
    address           = coalesce(k.address, d.address),
    preferred_channel = coalesce(k.preferred_channel, d.preferred_channel),
    company_id        = coalesce(k.company_id, d.company_id),
    custom_fields     = d.custom_fields || k.custom_fields,
    owner_id          = coalesce(k.owner_id, d.owner_id),
    first_contact_at  = least(k.first_contact_at, d.first_contact_at),
    -- Seguridad: si cualquiera pidió no ser contactado, el cliente fusionado tampoco.
    do_not_contact    = k.do_not_contact or d.do_not_contact,
    dnc_reason        = case when k.do_not_contact then k.dnc_reason when d.do_not_contact then d.dnc_reason end
  where id = k.id;

  update public.customers set deleted_at = now(), merged_into_id = k.id where id = d.id;

  -- Lo abierto que venía del cliente absorbido pasa al responsable del cliente resultante.
  select * into k from public.customers where id = k.id;
  update public.leads set owner_id = k.owner_id, team_id = k.team_id
   where customer_id = k.id and org_id = k.org_id and status in ('new', 'contacted', 'qualified');
  update public.opportunities set owner_id = k.owner_id, team_id = k.team_id
   where customer_id = k.id and org_id = k.org_id and status = 'open';
  perform set_config('app.customer_merge', 'off', true);

  perform app.emit_event(k.org_id, 'customer.merged', 'customer', k.id,
                         jsonb_build_object('dropped_id', d.id, 'dropped_name', d.full_name), k.id);
end $$;

-- ---------------------------------------------------------------------------
-- Privilegios + RLS
-- ---------------------------------------------------------------------------
revoke all on public.pipelines, public.pipeline_stages, public.state_transitions, public.opportunities
  from anon, authenticated;

grant select on public.pipelines, public.pipeline_stages, public.state_transitions, public.opportunities to authenticated;
grant update (name, archived_at) on public.pipelines to authenticated;
grant insert (org_id, pipeline_id, name, kind, position, probability) on public.pipeline_stages to authenticated;
grant update (name, position, probability, archived_at) on public.pipeline_stages to authenticated;
grant update (title, amount, expected_close_date, product_interest, custom_fields) on public.opportunities to authenticated;
grant all on public.pipelines, public.pipeline_stages, public.state_transitions, public.opportunities to service_role;

alter table public.pipelines         enable row level security;
alter table public.pipeline_stages   enable row level security;
alter table public.state_transitions enable row level security;
alter table public.opportunities     enable row level security;

create policy pipelines_select on public.pipelines for select to authenticated using ((select app.is_member(org_id)));
create policy pipelines_update on public.pipelines for update to authenticated
  using ((select app.has_permission(org_id, 'pipelines:manage')))
  with check ((select app.has_permission(org_id, 'pipelines:manage')));

create policy pipeline_stages_select on public.pipeline_stages for select to authenticated using ((select app.is_member(org_id)));
create policy pipeline_stages_insert on public.pipeline_stages for insert to authenticated
  with check ((select app.has_permission(org_id, 'pipelines:manage')));
create policy pipeline_stages_update on public.pipeline_stages for update to authenticated
  using ((select app.has_permission(org_id, 'pipelines:manage')))
  with check ((select app.has_permission(org_id, 'pipelines:manage')));

create policy opportunities_select on public.opportunities for select to authenticated
  using ((select app.can_access_row(org_id, 'opportunities:read', owner_id, team_id)));
create policy opportunities_update on public.opportunities for update to authenticated
  using ((select app.can_access_row(org_id, 'opportunities:update', owner_id, team_id)))
  with check ((select app.can_access_row(org_id, 'opportunities:update', owner_id, team_id)));

-- El historial se ve con el mismo alcance que el registro al que pertenece.
create policy state_transitions_select on public.state_transitions for select to authenticated
  using ((entity_type = 'opportunity' and exists (select 1 from public.opportunities o where o.id = entity_id))
      or (entity_type = 'lead'        and exists (select 1 from public.leads l where l.id = entity_id)));

create trigger pipelines_audit after insert or update or delete on public.pipelines
  for each row execute function app.audit_row_change();
create trigger pipeline_stages_audit after insert or update or delete on public.pipeline_stages
  for each row execute function app.audit_row_change();
create trigger opportunities_audit after insert or update or delete on public.opportunities
  for each row execute function app.audit_row_change();

revoke all on function app.pipeline_stages_guard(), app.pipelines_guard(), app.seed_default_pipeline(uuid), app.add_default_stages(uuid, uuid),
  app.organizations_seed_pipeline(), app.state_transitions_immutable(), app.leads_status_guard(),
  app.opportunities_prepare(), app.log_transition(), app.customers_after_update(), app.custom_fields_trigger(),
  app.create_opportunity_core(uuid, uuid, text, numeric, uuid, date, text, uuid)
  from public, anon, authenticated;

revoke all on function public.create_pipeline(uuid, text), public.set_default_pipeline(uuid), public.set_lead_status(uuid, text, text),
  public.create_opportunity(uuid, text, numeric, uuid, date, text), public.move_opportunity(uuid, uuid, text),
  public.convert_lead(uuid, uuid, text, numeric), public.merge_customers(uuid, uuid) from public, anon;
grant execute on function public.create_pipeline(uuid, text), public.set_default_pipeline(uuid), public.set_lead_status(uuid, text, text),
  public.create_opportunity(uuid, text, numeric, uuid, date, text), public.move_opportunity(uuid, uuid, text),
  public.convert_lead(uuid, uuid, text, numeric), public.merge_customers(uuid, uuid) to authenticated, service_role;

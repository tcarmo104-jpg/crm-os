-- =============================================================================
-- 0007 CUSTOMER 360 + RESOLUCIÓN DE IDENTIDAD + LEADS
-- =============================================================================
-- Reglas de negocio implementadas aquí (no en la UI):
--   * Un cliente es una identidad permanente. Un lead es una SEÑAL de entrada que se
--     resuelve contra los clientes existentes ANTES de crear nada.
--   * Un identificador (teléfono, email, handle) pertenece a un solo cliente por organización
--     (índice único). La resolución se serializa con locks para no crear duplicados en paralelo.
--   * Visibilidad: vendedor solo ve lo suyo; sales_manager, su equipo; admin/manager, todo.
--     La resolución corre con privilegios del sistema, así que detecta duplicados sin exponer
--     datos de clientes ajenos.
--   * Confianza alta (identificador exacto) → se une. Confianza media (mismo nombre, sin
--     identificador común) → se crea el cliente y se abre una revisión humana. Nunca se
--     fusiona automáticamente.
--   * "No contactar" lo puede activar quien tenga acceso al cliente, pero solo un manager/admin lo levanta.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Normalización de nombres (espejo exacto en src/lib/identity.ts → nameKey)
-- ---------------------------------------------------------------------------
create or replace function app.normalize_name(p text) returns text
language sql immutable set search_path = '' as $$
  select btrim(regexp_replace(
    lower(translate(normalize(coalesce(p, ''), NFC),   -- NFC: une letra + acento combinado (Excel/Mac)
      'áàäâãéèëêíìïîóòöôõúùüûñçÁÀÄÂÃÉÈËÊÍÌÏÎÓÒÖÔÕÚÙÜÛÑÇ',
      'aaaaaeeeeiiiiooooouuuuncaaaaaeeeeiiiiooooouuuunc')),
    '[^a-z0-9]+', ' ', 'g'))
$$;

-- ---------------------------------------------------------------------------
-- customers
-- ---------------------------------------------------------------------------
create table public.customers (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references public.organizations(id) on delete cascade,
  type              text not null default 'person' check (type in ('person', 'company')),
  full_name         text not null check (char_length(btrim(full_name)) between 1 and 160),
  name_key          text not null default '',
  company_id        uuid,
  owner_id          uuid references auth.users(id) on delete set null,
  team_id           uuid,
  city              text check (char_length(city) <= 120),
  country           text check (country ~ '^[A-Z]{2}$'),
  address           text check (char_length(address) <= 300),
  preferred_channel text check (preferred_channel in ('whatsapp', 'phone', 'email', 'instagram', 'facebook')),
  -- Derivado de eventos (Fase 4). Ningún usuario lo edita.
  lifecycle_stage   text not null default 'prospect' check (lifecycle_stage in ('prospect', 'active', 'recurring', 'inactive')),
  do_not_contact    boolean not null default false,
  dnc_reason        text check (char_length(dnc_reason) <= 300),
  dnc_at            timestamptz,
  dnc_by            uuid references auth.users(id) on delete set null,
  custom_fields     jsonb not null default '{}'::jsonb,
  first_contact_at  timestamptz not null default now(),
  created_by        uuid references auth.users(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  merged_into_id    uuid references public.customers(id),
  deleted_at        timestamptz,
  unique (id, org_id),
  foreign key (company_id, org_id) references public.customers (id, org_id),
  foreign key (team_id, org_id) references public.teams (id, org_id) on delete set null (team_id),
  check (id <> company_id)
);
create index customers_org_created_idx on public.customers (org_id, created_at desc, id desc) where deleted_at is null;
create index customers_org_owner_idx   on public.customers (org_id, owner_id) where deleted_at is null;
create index customers_org_namekey_idx on public.customers (org_id, name_key) where deleted_at is null;

-- ---------------------------------------------------------------------------
-- customer_identifiers: lo que permite reconocer al mismo cliente en cualquier canal
-- ---------------------------------------------------------------------------
create table public.customer_identifiers (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations(id) on delete cascade,
  customer_id  uuid not null,
  type         text not null check (type in ('phone', 'email', 'instagram', 'facebook', 'external')),
  value        text not null,   -- SIEMPRE normalizado (E.164, minúsculas, sin @)
  source       text,
  created_at   timestamptz not null default now(),
  foreign key (customer_id, org_id) references public.customers (id, org_id) on delete cascade,
  unique (org_id, type, value),
  check (case type
           when 'phone' then value ~ '^\+[1-9][0-9]{6,14}$'
           when 'email' then value = lower(value) and value ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
           else value = lower(value) and char_length(value) between 1 and 200 and value !~ '[[:space:]]'
         end)
);
create index customer_identifiers_customer_idx on public.customer_identifiers (customer_id);

-- ---------------------------------------------------------------------------
-- leads (señales de entrada)
-- ---------------------------------------------------------------------------
create table public.leads (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.organizations(id) on delete cascade,
  customer_id      uuid not null,
  owner_id         uuid references auth.users(id) on delete set null,
  team_id          uuid,
  status           text not null default 'new' check (status in ('new', 'contacted', 'qualified', 'disqualified', 'converted')),
  source           text not null default 'api' check (char_length(source) between 1 and 60),
  channel          text check (char_length(channel) <= 60),
  campaign         text check (char_length(campaign) <= 120),
  ad               text check (char_length(ad) <= 120),
  form             text check (char_length(form) <= 120),
  product_interest text check (char_length(product_interest) <= 200),
  external_id      text check (char_length(external_id) between 1 and 200),
  contact_name     text,
  contact_email    text,
  contact_phone    text,
  resolution       text not null check (resolution in ('created', 'matched', 'review', 'conflict')),
  consent          boolean,
  notes            text check (char_length(notes) <= 2000),
  custom_fields    jsonb not null default '{}'::jsonb,
  raw_payload      jsonb not null default '{}'::jsonb,
  received_at      timestamptz not null default now(),
  created_by       uuid references auth.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (id, org_id),
  foreign key (customer_id, org_id) references public.customers (id, org_id),
  foreign key (team_id, org_id) references public.teams (id, org_id) on delete set null (team_id)
);
-- Idempotencia: reintentos del mismo webhook/API no duplican leads.
create unique index leads_external_uk on public.leads (org_id, source, external_id) where external_id is not null;
create index leads_org_received_idx on public.leads (org_id, received_at desc, id desc);
create index leads_customer_idx on public.leads (customer_id);
create index leads_owner_idx on public.leads (org_id, owner_id);

-- ---------------------------------------------------------------------------
-- identity_reviews: cola de revisión humana (duplicados posibles / conflictos)
-- ---------------------------------------------------------------------------
create table public.identity_reviews (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id) on delete cascade,
  kind          text not null check (kind in ('possible_duplicate', 'identifier_conflict', 'duplicate_attempt')),
  customer_id   uuid not null,
  candidate_id  uuid,
  reason        text,
  created_by    uuid references auth.users(id) on delete set null,
  status        text not null default 'pending' check (status in ('pending', 'merged', 'dismissed')),
  resolved_by   uuid references auth.users(id) on delete set null,
  resolved_at   timestamptz,
  created_at    timestamptz not null default now(),
  foreign key (customer_id, org_id) references public.customers (id, org_id),
  foreign key (candidate_id, org_id) references public.customers (id, org_id)
);
create unique index identity_reviews_pair_uk on public.identity_reviews
  (org_id, least(customer_id, candidate_id), greatest(customer_id, candidate_id), kind)
  where status = 'pending' and candidate_id is not null;
create unique index identity_reviews_attempt_uk on public.identity_reviews (org_id, customer_id, created_by)
  where kind = 'duplicate_attempt' and status = 'pending';
create index identity_reviews_org_idx on public.identity_reviews (org_id, status, created_at desc);

-- La FK diferida de la Fase 1: los eventos apuntan al cliente.
alter table public.domain_events
  add constraint domain_events_customer_fk foreign key (customer_id) references public.customers(id);

-- ---------------------------------------------------------------------------
-- Triggers de customers
-- ---------------------------------------------------------------------------
create or replace function app.customers_prepare() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_team uuid;
begin
  new.full_name := btrim(new.full_name);
  new.name_key  := app.normalize_name(new.full_name);

  -- Propietario: debe ser miembro activo; el equipo se deriva de su membresía.
  if tg_op = 'INSERT' or new.owner_id is distinct from old.owner_id then
    if tg_op = 'UPDATE' and v_uid is not null
       and app.permission_scope(new.org_id, 'customers:update') is distinct from 'org' then
      raise exception 'only managers can reassign customers' using errcode = '42501';
    end if;
    if new.owner_id is null then
      new.team_id := null;
    else
      select m.team_id into v_team from public.memberships m
       where m.org_id = new.org_id and m.user_id = new.owner_id and m.status = 'active';
      if not found then
        raise exception 'owner must be an active member of the organization' using errcode = '23514';
      end if;
      new.team_id := v_team;
    end if;
  end if;

  -- Empresa a la que pertenece (debe ser un cliente de tipo empresa de la misma organización).
  if new.company_id is not null and (tg_op = 'INSERT' or new.company_id is distinct from old.company_id) then
    if not exists (select 1 from public.customers c
                    where c.id = new.company_id and c.org_id = new.org_id and c.type = 'company' and c.deleted_at is null) then
      raise exception 'company_id must reference a company of the same organization' using errcode = '23514';
    end if;
  end if;

  -- No contactar: activar es libre; levantarlo exige manager/admin.
  if tg_op = 'UPDATE' and new.do_not_contact is distinct from old.do_not_contact then
    if old.do_not_contact and v_uid is not null
       and app.permission_scope(new.org_id, 'customers:update') is distinct from 'org' then
      raise exception 'only managers can clear do-not-contact' using errcode = '42501';
    end if;
    new.dnc_at := case when new.do_not_contact then now() end;
    new.dnc_by := case when new.do_not_contact then v_uid end;
    if not new.do_not_contact then new.dnc_reason := null; end if;
  elsif tg_op = 'INSERT' and new.do_not_contact then
    new.dnc_at := now();
    new.dnc_by := v_uid;
  end if;

  return new;
end $$;

create trigger customers_prepare_trg before insert or update on public.customers
  for each row execute function app.customers_prepare();
create trigger customers_custom_fields_trg before insert or update on public.customers
  for each row execute function app.custom_fields_trigger();
create trigger customers_touch before update on public.customers
  for each row execute function app.touch_updated_at();

create or replace function app.customers_after_update() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.owner_id is distinct from old.owner_id then
    -- Los leads abiertos siguen al cliente.
    update public.leads
       set owner_id = new.owner_id, team_id = new.team_id
     where customer_id = new.id and org_id = new.org_id
       and status in ('new', 'contacted', 'qualified');
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
create trigger customers_after_update_trg after update on public.customers
  for each row execute function app.customers_after_update();

create trigger leads_custom_fields_trg before insert or update on public.leads
  for each row execute function app.custom_fields_trigger();
create trigger leads_touch before update on public.leads
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Auditoría (sin secretos ni payloads crudos)
-- ---------------------------------------------------------------------------
create or replace function app.audit_row_change() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_old jsonb; v_new jsonb; v_row jsonb;
  v_old_d jsonb; v_new_d jsonb;
  v_id uuid; v_org uuid; v_ip inet;
begin
  if tg_op = 'INSERT' then
    v_new := to_jsonb(new) - 'token_hash' - 'key_hash' - 'raw_payload'; v_row := v_new;
  elsif tg_op = 'DELETE' then
    v_old := to_jsonb(old) - 'token_hash' - 'key_hash' - 'raw_payload'; v_row := v_old;
  else
    v_old := to_jsonb(old) - 'token_hash' - 'key_hash' - 'raw_payload';
    v_new := to_jsonb(new) - 'token_hash' - 'key_hash' - 'raw_payload'; v_row := v_new;
  end if;

  v_id  := (v_row ->> 'id')::uuid;
  v_org := case when tg_table_name = 'organizations' then v_id else (v_row ->> 'org_id')::uuid end;

  if tg_op = 'UPDATE' then
    select jsonb_object_agg(k, v_old -> k), jsonb_object_agg(k, v_new -> k)
      into v_old_d, v_new_d
    from jsonb_object_keys(v_new) as k
    where k <> 'updated_at' and (v_old -> k) is distinct from (v_new -> k);
    if v_new_d is null then return new; end if;
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

create trigger customers_audit after insert or update or delete on public.customers
  for each row execute function app.audit_row_change();
create trigger customer_identifiers_audit after insert or update or delete on public.customer_identifiers
  for each row execute function app.audit_row_change();
create trigger leads_audit after insert or update or delete on public.leads
  for each row execute function app.audit_row_change();
create trigger identity_reviews_audit after insert or update or delete on public.identity_reviews
  for each row execute function app.audit_row_change();

-- ---------------------------------------------------------------------------
-- RESOLUCIÓN DE IDENTIDAD (interna; la usan create_customer e ingest_lead)
--   p_ids: [{"type":"phone","value":"+573001112233"}, ...]  ya normalizados
--   Devuelve el cliente y el resultado: created | review | matched | conflict
-- ---------------------------------------------------------------------------
create or replace function app.resolve_customer(
  p_org uuid, p_name text, p_ids jsonb, p_type text, p_owner uuid, p_actor uuid,
  p_source text, p_attrs jsonb, p_enrich boolean
) returns table (out_customer_id uuid, out_outcome text)
language plpgsql security definer set search_path = '' as $$
declare
  r record;
  v_matches uuid[];
  v_primary uuid;
  v_other uuid;
  v_new uuid;
  v_cand uuid;
  v_name text := nullif(btrim(coalesce(p_name, '')), '');
  v_key text;
  v_reviewed boolean := false;
begin
  if p_ids is null or jsonb_typeof(p_ids) <> 'array' or jsonb_array_length(p_ids) = 0 then
    raise exception 'contact_required' using errcode = '22023';
  end if;
  if jsonb_array_length(p_ids) > 10 then
    raise exception 'too many identifiers' using errcode = '22023';
  end if;
  if p_type not in ('person', 'company') then
    raise exception 'invalid customer type' using errcode = '22023';
  end if;

  -- Serializa por identificador. Orden estable => sin deadlocks entre transacciones.
  for r in
    select distinct e ->> 'type' as t, e ->> 'value' as v
      from jsonb_array_elements(p_ids) e order by 1, 2
  loop
    perform pg_advisory_xact_lock(hashtextextended(p_org::text || '|' || r.t || '|' || r.v, 0));
  end loop;

  select array_agg(c.id order by c.first_contact_at, c.id) into v_matches
    from public.customers c
   where c.org_id = p_org and c.deleted_at is null
     and exists (
       select 1 from public.customer_identifiers ci
        where ci.customer_id = c.id and ci.org_id = p_org
          and (ci.type, ci.value) in (select e ->> 'type', e ->> 'value' from jsonb_array_elements(p_ids) e));

  -- Sin coincidencia: cliente nuevo (+ revisión si el nombre ya existe).
  if v_matches is null then
    insert into public.customers (org_id, type, full_name, owner_id, created_by, city, country, address,
                                  preferred_channel, custom_fields)
    values (p_org, p_type, coalesce(v_name, 'Sin nombre'), p_owner, p_actor,
            nullif(btrim(p_attrs ->> 'city'), ''), nullif(upper(btrim(p_attrs ->> 'country')), ''),
            nullif(btrim(p_attrs ->> 'address'), ''), nullif(p_attrs ->> 'preferred_channel', ''),
            coalesce(p_attrs -> 'custom_fields', '{}'::jsonb))
    returning id into v_new;

    insert into public.customer_identifiers (org_id, customer_id, type, value, source)
    select distinct p_org, v_new, e ->> 'type', e ->> 'value', p_source
      from jsonb_array_elements(p_ids) e;

    perform app.emit_event(p_org, 'customer.created', 'customer', v_new,
                           jsonb_build_object('source', p_source), v_new);

    if v_name is not null then
      v_key := app.normalize_name(v_name);
      if position(' ' in v_key) > 0 then          -- solo nombres con 2+ palabras
        for v_cand in
          select c.id from public.customers c
           where c.org_id = p_org and c.deleted_at is null and c.id <> v_new
             and c.type = p_type and c.name_key = v_key
           order by c.first_contact_at limit 3
        loop
          insert into public.identity_reviews (org_id, kind, customer_id, candidate_id, reason, created_by)
          values (p_org, 'possible_duplicate', v_new, v_cand, 'same_name', p_actor)
          on conflict do nothing;
          v_reviewed := true;
        end loop;
      end if;
    end if;

    if v_reviewed then
      perform app.emit_event(p_org, 'identity.review_needed', 'customer', v_new,
                             jsonb_build_object('kind', 'possible_duplicate'), v_new);
      return query select v_new, 'review'::text;
    end if;
    return query select v_new, 'created'::text;
    return;
  end if;

  -- Coincidencia: el cliente más antiguo es el principal.
  v_primary := v_matches[1];

  if p_enrich then
    insert into public.customer_identifiers (org_id, customer_id, type, value, source)
    select distinct p_org, v_primary, e ->> 'type', e ->> 'value', p_source
      from jsonb_array_elements(p_ids) e
    on conflict (org_id, type, value) do nothing;
  end if;

  if array_length(v_matches, 1) > 1 then
    -- Los identificadores del mensaje pertenecen a clientes distintos: probablemente son la misma persona.
    foreach v_other in array v_matches[2:array_length(v_matches, 1)] loop
      insert into public.identity_reviews (org_id, kind, customer_id, candidate_id, reason, created_by)
      values (p_org, 'identifier_conflict', v_primary, v_other, 'shared_identifiers', p_actor)
      on conflict do nothing;
    end loop;
    perform app.emit_event(p_org, 'identity.review_needed', 'customer', v_primary,
                           jsonb_build_object('kind', 'identifier_conflict'), v_primary);
    return query select v_primary, 'conflict'::text;
    return;
  end if;

  return query select v_primary, 'matched'::text;
end $$;

-- ---------------------------------------------------------------------------
-- create_customer: alta manual por una persona usuaria
--   created          → cliente nuevo (propietario: quien lo crea)
--   existing         → ya existía y la persona tiene acceso: se devuelve su id
--   duplicate_hidden → ya existe pero pertenece a otra persona: NO se revela nada,
--                      y se deja una alerta para managers/admins
-- ---------------------------------------------------------------------------
create or replace function public.create_customer(
  p_org uuid, p_type text, p_full_name text, p_ids jsonb, p_attrs jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_res record;
  v_can boolean;
begin
  if v_uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not app.has_permission(p_org, 'customers:create') then
    raise exception 'not allowed to create customers' using errcode = '42501';
  end if;
  if btrim(coalesce(p_full_name, '')) = '' then
    raise exception 'name_required' using errcode = '22023';
  end if;

  select * into v_res from app.resolve_customer(
    p_org, p_full_name, p_ids, coalesce(p_type, 'person'), v_uid, v_uid, 'manual', coalesce(p_attrs, '{}'::jsonb), false);

  if v_res.out_outcome in ('matched', 'conflict') then
    select app.can_access_row(c.org_id, 'customers:read', c.owner_id, c.team_id) into v_can
      from public.customers c where c.id = v_res.out_customer_id;
    if v_can then
      return jsonb_build_object('outcome', 'existing', 'customer_id', v_res.out_customer_id);
    end if;
    insert into public.identity_reviews (org_id, kind, customer_id, reason, created_by)
    values (p_org, 'duplicate_attempt', v_res.out_customer_id, 'manual_create', v_uid)
    on conflict do nothing;
    perform app.emit_event(p_org, 'identity.duplicate_attempt', 'customer', v_res.out_customer_id,
                           jsonb_build_object('attempted_by', v_uid), v_res.out_customer_id);
    return jsonb_build_object('outcome', 'duplicate_hidden');
  end if;

  return jsonb_build_object('outcome', 'created', 'customer_id', v_res.out_customer_id);
end $$;

-- ---------------------------------------------------------------------------
-- add_customer_identifier
-- ---------------------------------------------------------------------------
create or replace function public.add_customer_identifier(p_customer uuid, p_type text, p_value text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c public.customers%rowtype;
  v_other uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  select * into c from public.customers where id = p_customer and deleted_at is null;
  if not found or not app.can_access_row(c.org_id, 'customers:update', c.owner_id, c.team_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(c.org_id::text || '|' || p_type || '|' || p_value, 0));

  select ci.customer_id into v_other from public.customer_identifiers ci
   where ci.org_id = c.org_id and ci.type = p_type and ci.value = p_value;
  if found then
    if v_other = c.id then
      return jsonb_build_object('outcome', 'exists');
    end if;
    insert into public.identity_reviews (org_id, kind, customer_id, candidate_id, reason, created_by)
    values (c.org_id, 'identifier_conflict', c.id, v_other, 'identifier_in_use', auth.uid())
    on conflict do nothing;
    return jsonb_build_object('outcome', 'conflict');       -- no se revela a quién pertenece
  end if;

  insert into public.customer_identifiers (org_id, customer_id, type, value, source)
  values (c.org_id, c.id, p_type, p_value, 'manual');
  return jsonb_build_object('outcome', 'added');
end $$;

-- ---------------------------------------------------------------------------
-- merge_customers: fusiona p_drop dentro de p_keep (solo manager/admin)
-- ---------------------------------------------------------------------------
create or replace function public.merge_customers(p_keep uuid, p_drop uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  k public.customers%rowtype;
  d public.customers%rowtype;
  v_locked int;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if p_keep = p_drop then
    raise exception 'cannot merge a customer with itself' using errcode = '22023';
  end if;

  -- Bloqueo en orden estable de id (evita deadlocks).
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

  -- IMPORTANTE: toda tabla nueva con FK a customers debe agregarse aquí.
  -- Una prueba estructural falla si se olvida.
  update public.customer_identifiers set customer_id = k.id where customer_id = d.id and org_id = k.org_id;
  update public.leads                set customer_id = k.id where customer_id = d.id and org_id = k.org_id;
  update public.domain_events        set customer_id = k.id where customer_id = d.id and org_id = k.org_id;
  update public.customers            set company_id  = k.id where company_id  = d.id and org_id = k.org_id and id <> k.id;

  update public.identity_reviews
     set status = case when (customer_id = k.id and candidate_id = d.id) or (customer_id = d.id and candidate_id = k.id)
                       then 'merged' else 'dismissed' end,
         resolved_by = auth.uid(), resolved_at = now()
   where org_id = k.org_id and status = 'pending'
     and (customer_id = d.id or candidate_id = d.id
          or (customer_id = k.id and candidate_id = d.id) or (customer_id = d.id and candidate_id = k.id));

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

  perform app.emit_event(k.org_id, 'customer.merged', 'customer', k.id,
                         jsonb_build_object('dropped_id', d.id, 'dropped_name', d.full_name), k.id);
end $$;

create or replace function public.dismiss_review(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  select org_id into v_org from public.identity_reviews where id = p_id;
  if v_org is null or app.permission_scope(v_org, 'customers:update') is distinct from 'org' then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update public.identity_reviews
     set status = 'dismissed', resolved_by = auth.uid(), resolved_at = now()
   where id = p_id and status = 'pending';
end $$;

-- ---------------------------------------------------------------------------
-- Línea de tiempo del cliente (respeta la visibilidad del cliente)
-- ---------------------------------------------------------------------------
create or replace function public.customer_timeline(p_customer uuid, p_limit int default 50, p_before timestamptz default null)
returns table (id uuid, type text, occurred_at timestamptz, actor_id uuid, entity_type text, entity_id uuid, payload jsonb)
language plpgsql stable security definer set search_path = '' as $$
declare c public.customers%rowtype;
begin
  select * into c from public.customers x where x.id = p_customer and x.deleted_at is null;
  if not found or not app.can_access_row(c.org_id, 'customers:read', c.owner_id, c.team_id) then
    return;
  end if;
  return query
    select e.id, e.type, e.occurred_at, e.actor_id, e.entity_type, e.entity_id, e.payload
      from public.domain_events e
     where e.org_id = c.org_id and e.customer_id = p_customer
       and (p_before is null or e.occurred_at < p_before)
     order by e.occurred_at desc, e.id desc
     limit least(greatest(p_limit, 1), 200);
end $$;

-- ---------------------------------------------------------------------------
-- Privilegios + RLS
-- ---------------------------------------------------------------------------
revoke all on public.customers, public.customer_identifiers, public.leads, public.identity_reviews
  from anon, authenticated;

grant select on public.customers, public.customer_identifiers, public.leads, public.identity_reviews to authenticated;
grant update (full_name, city, country, address, preferred_channel, company_id, custom_fields,
              do_not_contact, dnc_reason, owner_id) on public.customers to authenticated;
grant delete on public.customer_identifiers to authenticated;
grant update (notes, product_interest, custom_fields) on public.leads to authenticated;
grant all on public.customers, public.customer_identifiers, public.leads, public.identity_reviews to service_role;

alter table public.customers            enable row level security;
alter table public.customer_identifiers enable row level security;
alter table public.leads                enable row level security;
alter table public.identity_reviews     enable row level security;

create policy customers_select on public.customers for select to authenticated
  using (deleted_at is null and (select app.can_access_row(org_id, 'customers:read', owner_id, team_id)));
create policy customers_update on public.customers for update to authenticated
  using (deleted_at is null and (select app.can_access_row(org_id, 'customers:update', owner_id, team_id)))
  with check ((select app.can_access_row(org_id, 'customers:update', owner_id, team_id))
              or (select app.permission_scope(org_id, 'customers:update')) = 'org');

-- Los identificadores se ven/borran según el acceso al cliente (RLS de customers aplica en el subquery).
create policy customer_identifiers_select on public.customer_identifiers for select to authenticated
  using (exists (select 1 from public.customers c where c.id = customer_id));
create policy customer_identifiers_delete on public.customer_identifiers for delete to authenticated
  using (exists (select 1 from public.customers c
                  where c.id = customer_id
                    and app.can_access_row(c.org_id, 'customers:update', c.owner_id, c.team_id)));

create policy leads_select on public.leads for select to authenticated
  using ((select app.can_access_row(org_id, 'leads:read', owner_id, team_id)));
create policy leads_update on public.leads for update to authenticated
  using ((select app.can_access_row(org_id, 'leads:update', owner_id, team_id)))
  with check ((select app.can_access_row(org_id, 'leads:update', owner_id, team_id)));

create policy identity_reviews_select on public.identity_reviews for select to authenticated
  using ((select app.permission_scope(org_id, 'customers:update')) = 'org');

-- Funciones internas: nadie las llama directamente (solo otras funciones SECURITY DEFINER).
revoke all on function app.normalize_name(text), app.customers_prepare(), app.customers_after_update(),
  app.resolve_customer(uuid, text, jsonb, text, uuid, uuid, text, jsonb, boolean)
  from public, anon, authenticated;

revoke all on function public.create_customer(uuid, text, text, jsonb, jsonb),
  public.add_customer_identifier(uuid, text, text), public.merge_customers(uuid, uuid),
  public.dismiss_review(uuid), public.customer_timeline(uuid, int, timestamptz)
  from public, anon;
grant execute on function public.create_customer(uuid, text, text, jsonb, jsonb),
  public.add_customer_identifier(uuid, text, text), public.merge_customers(uuid, uuid),
  public.dismiss_review(uuid), public.customer_timeline(uuid, int, timestamptz)
  to authenticated, service_role;

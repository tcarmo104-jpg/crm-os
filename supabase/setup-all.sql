-- =============================================================================
-- CRM OS · INSTALACIÓN COMPLETA DE LA BASE DE DATOS (proyecto Supabase VACÍO)
-- Pégalo entero en SQL Editor → New query → Run. Va en UNA transacción: si algo falla,
-- no queda nada a medias y puedes corregir y volver a ejecutarlo.
-- Al final debe mostrar una fila con estado = LISTO.
-- Generado con scripts/build-setup-sql.sh a partir de supabase/migrations/*.sql
-- =============================================================================
begin;

-- ---------------- 20260919000001_foundation.sql ----------------
-- =============================================================================
-- 0001 FOUNDATION: multi-tenancy, RBAC, Row Level Security
-- =============================================================================
-- Principios:
--   * Toda tabla de negocio lleva org_id y RLS activado. Sin excepciones.
--   * Las funciones helper viven en el schema `app` (no expuesto por PostgREST).
--   * Los roles `anon` y `authenticated` reciben solo los privilegios que se
--     otorgan explícitamente aquí (deny by default).
--   * `service_role` (workers/backend de confianza) omite RLS: nunca en el frontend.
-- =============================================================================

create schema if not exists app;

create type public.membership_status as enum ('invited', 'active', 'suspended');
-- Orden importa: own < team < org (max() devuelve el alcance más amplio)
create type public.permission_scope as enum ('own', 'team', 'org');

-- ---------------------------------------------------------------------------
-- Utilidad: updated_at
-- ---------------------------------------------------------------------------
create or replace function app.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Organizaciones (tenant raíz)
-- ---------------------------------------------------------------------------
create table public.organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(name) between 2 and 120),
  slug        text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
  currency    text not null default 'COP' check (currency ~ '^[A-Z]{3}$'),
  timezone    text not null default 'America/Bogota',
  locale      text not null default 'es-CO',
  settings    jsonb not null default '{}'::jsonb,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
create trigger organizations_touch before update on public.organizations
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Perfiles (1:1 con auth.users)
-- ---------------------------------------------------------------------------
create table public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text,
  full_name   text,
  avatar_url  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create trigger profiles_touch before update on public.profiles
  for each row execute function app.touch_updated_at();

create or replace function app.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, new.raw_user_meta_data ->> 'full_name')
  on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function app.handle_new_user();

-- ---------------------------------------------------------------------------
-- Equipos
-- ---------------------------------------------------------------------------
create table public.teams (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  name        text not null check (char_length(name) between 1 and 80),
  region      text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (org_id, name),
  unique (id, org_id)   -- habilita FK compuestas que impiden referencias entre tenants
);
create trigger teams_touch before update on public.teams
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- RBAC: permisos, roles (de sistema: org_id null) y matriz rol→permiso→alcance
-- ---------------------------------------------------------------------------
create table public.permissions (
  key          text primary key check (key ~ '^[a-z_]+:[a-z_]+$'),
  module       text generated always as (split_part(key, ':', 1)) stored,
  description  text
);

create table public.roles (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid references public.organizations(id) on delete cascade,  -- null = rol de sistema
  key          text not null check (key ~ '^[a-z_]+$'),
  name         text not null,
  description  text,
  created_at   timestamptz not null default now()
);
create unique index roles_system_key_uk on public.roles (key) where org_id is null;
create unique index roles_org_key_uk on public.roles (org_id, key) where org_id is not null;

create table public.role_permissions (
  role_id         uuid not null references public.roles(id) on delete cascade,
  permission_key  text not null references public.permissions(key) on delete cascade,
  scope           public.permission_scope not null default 'org',
  primary key (role_id, permission_key)
);

-- ---------------------------------------------------------------------------
-- Membresías (usuario ↔ organización, con rol, equipo y región)
-- ---------------------------------------------------------------------------
create table public.memberships (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  role_id     uuid not null references public.roles(id),
  team_id     uuid,
  status      public.membership_status not null default 'active',
  region      text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (org_id, user_id),
  foreign key (team_id, org_id) references public.teams (id, org_id)
    on delete set null (team_id)
);
create index memberships_user_active_idx on public.memberships (user_id, org_id) where status = 'active';
create index memberships_org_team_idx on public.memberships (org_id, team_id);
create trigger memberships_touch before update on public.memberships
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Seed: permisos
-- ---------------------------------------------------------------------------
insert into public.permissions (key, description)
select m || ':' || a, initcap(a) || ' ' || m
from unnest(array['customers','leads','opportunities','quotes','sales','conversations','tasks','cases','products']) m,
     unnest(array['read','create','update','delete']) a;

insert into public.permissions (key, description) values
  ('users:manage',        'Gestionar miembros y sus roles'),
  ('teams:manage',        'Gestionar equipos'),
  ('roles:manage',        'Gestionar roles personalizados'),
  ('settings:manage',     'Configuración de la organización'),
  ('integrations:manage', 'Gestionar integraciones y API keys'),
  ('pipelines:manage',    'Configurar pipelines y etapas'),
  ('sla:manage',          'Configurar reglas SLA'),
  ('assignment:manage',   'Configurar el motor de asignación'),
  ('fields:manage',       'Gestionar campos personalizados'),
  ('sequences:read',      'Ver secuencias'),
  ('sequences:manage',    'Crear y editar secuencias'),
  ('automations:read',    'Ver automatizaciones'),
  ('automations:manage',  'Crear y editar automatizaciones'),
  ('reports:read',        'Ver reportes y dashboards'),
  ('reports:export',      'Exportar reportes'),
  ('ai:use',              'Usar el asistente de IA'),
  ('ai:analyst',          'Usar el AI Business Analyst'),
  ('coaching:manage',     'Enviar coaching a vendedores'),
  ('audit:read',          'Consultar la auditoría'),
  ('org:delete',          'Eliminar la organización');

-- ---------------------------------------------------------------------------
-- Seed: roles de sistema
--   super_admin = propietario de la organización (facturación, eliminar org).
--   El "super admin de plataforma" NO es un rol de tenant: opera con service_role.
-- ---------------------------------------------------------------------------
insert into public.roles (key, name, description) values
  ('super_admin',      'Super administrador', 'Propietario de la organización'),
  ('admin',            'Administrador',       'Administración completa excepto eliminar la organización'),
  ('manager',          'Manager',             'Gestión comercial a nivel organización'),
  ('sales_manager',    'Sales Manager',       'Gestión comercial de su equipo'),
  ('sales_agent',      'Vendedor',            'Trabaja sus propios registros'),
  ('marketing',        'Marketing',           'Leads, campañas y secuencias'),
  ('customer_service', 'Servicio al cliente', 'Soporte y postventa'),
  ('analyst',          'Analista',            'Lectura y reportes'),
  ('viewer',           'Solo lectura',        'Consulta básica');

create function pg_temp.g(p_role text, p_mods text[], p_acts text[], p_scope public.permission_scope)
returns void language sql as $$
  insert into public.role_permissions (role_id, permission_key, scope)
  select r.id, m || ':' || a, p_scope
  from public.roles r, unnest(p_mods) m, unnest(p_acts) a
  where r.org_id is null and r.key = p_role
  on conflict (role_id, permission_key) do update set scope = excluded.scope
$$;

do $seed$
declare
  data_mods text[] := array['customers','leads','opportunities','quotes','sales','conversations','tasks','cases'];
begin
  -- super_admin: todo; admin: todo menos org:delete
  insert into public.role_permissions (role_id, permission_key, scope)
  select r.id, p.key, 'org' from public.roles r, public.permissions p
  where r.org_id is null and r.key = 'super_admin';

  insert into public.role_permissions (role_id, permission_key, scope)
  select r.id, p.key, 'org' from public.roles r, public.permissions p
  where r.org_id is null and r.key = 'admin' and p.key <> 'org:delete';

  -- manager (org)
  perform pg_temp.g('manager', data_mods || 'products'::text, array['read','create','update'], 'org');
  perform pg_temp.g('manager', array['sequences'], array['read','manage'], 'org');
  perform pg_temp.g('manager', array['automations'], array['read'], 'org');
  perform pg_temp.g('manager', array['reports'], array['read','export'], 'org');
  perform pg_temp.g('manager', array['ai'], array['use','analyst'], 'org');
  perform pg_temp.g('manager', array['coaching','assignment'], array['manage'], 'org');

  -- sales_manager (equipo)
  perform pg_temp.g('sales_manager', data_mods, array['read','create','update'], 'team');
  perform pg_temp.g('sales_manager', array['products'], array['read'], 'org');
  perform pg_temp.g('sales_manager', array['sequences','automations'], array['read'], 'org');
  perform pg_temp.g('sales_manager', array['reports'], array['read'], 'team');
  perform pg_temp.g('sales_manager', array['ai'], array['use'], 'team');
  perform pg_temp.g('sales_manager', array['coaching'], array['manage'], 'team');

  -- sales_agent (propios)
  perform pg_temp.g('sales_agent', array['customers','leads','opportunities','quotes','conversations','tasks'],
                    array['read','create','update'], 'own');
  perform pg_temp.g('sales_agent', array['sales'], array['read'], 'own');
  perform pg_temp.g('sales_agent', array['cases'], array['read','create'], 'own');
  perform pg_temp.g('sales_agent', array['products','sequences'], array['read'], 'org');
  perform pg_temp.g('sales_agent', array['reports'], array['read'], 'own');
  perform pg_temp.g('sales_agent', array['ai'], array['use'], 'own');

  -- marketing (org)
  perform pg_temp.g('marketing', array['leads'], array['read','create','update'], 'org');
  perform pg_temp.g('marketing', array['customers','opportunities','products'], array['read'], 'org');
  perform pg_temp.g('marketing', array['sequences'], array['read','manage'], 'org');
  perform pg_temp.g('marketing', array['automations'], array['read'], 'org');
  perform pg_temp.g('marketing', array['reports'], array['read','export'], 'org');
  perform pg_temp.g('marketing', array['ai'], array['use'], 'org');

  -- customer_service (org)
  perform pg_temp.g('customer_service', array['customers'], array['read','update'], 'org');
  perform pg_temp.g('customer_service', array['conversations','cases','tasks'], array['read','create','update'], 'org');
  perform pg_temp.g('customer_service', array['opportunities','quotes','sales','products'], array['read'], 'org');
  perform pg_temp.g('customer_service', array['ai'], array['use'], 'org');
  perform pg_temp.g('customer_service', array['reports'], array['read'], 'own');

  -- analyst (org, solo lectura + reportes)
  perform pg_temp.g('analyst', data_mods || 'products'::text, array['read'], 'org');
  perform pg_temp.g('analyst', array['reports'], array['read','export'], 'org');
  perform pg_temp.g('analyst', array['ai'], array['use','analyst'], 'org');

  -- viewer (org, solo lectura básica)
  perform pg_temp.g('viewer', array['customers','leads','opportunities','quotes','sales','products'], array['read'], 'org');
  perform pg_temp.g('viewer', array['reports'], array['read'], 'org');
end
$seed$;

-- ---------------------------------------------------------------------------
-- Helpers de autorización (SECURITY DEFINER para evitar recursión de RLS).
-- Todas leen auth.uid() del JWT del invocador.
-- ---------------------------------------------------------------------------
create or replace function app.is_member(p_org uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.memberships m
    join public.organizations o on o.id = m.org_id and o.deleted_at is null
    where m.org_id = p_org and m.user_id = auth.uid() and m.status = 'active'
  )
$$;

create or replace function app.permission_scope(p_org uuid, p_perm text) returns public.permission_scope
language sql stable security definer set search_path = '' as $$
  select max(rp.scope)
  from public.memberships m
  join public.organizations o on o.id = m.org_id and o.deleted_at is null
  join public.role_permissions rp on rp.role_id = m.role_id
  where m.org_id = p_org and m.user_id = auth.uid() and m.status = 'active'
    and rp.permission_key = p_perm
$$;

create or replace function app.has_permission(p_org uuid, p_perm text) returns boolean
language sql stable security definer set search_path = '' as $$
  select app.permission_scope(p_org, p_perm) is not null
$$;

create or replace function app.my_team_id(p_org uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select m.team_id from public.memberships m
  where m.org_id = p_org and m.user_id = auth.uid() and m.status = 'active'
$$;

-- Acceso a nivel de registro. Las tablas de dominio (Fase 2+) lo usarán así:
--   using (app.can_access_row(org_id, 'leads:read', owner_id, team_id))
create or replace function app.can_access_row(p_org uuid, p_perm text, p_owner uuid, p_team uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select case app.permission_scope(p_org, p_perm)
    when 'org'  then true
    when 'team' then p_owner = auth.uid()
                     or (p_team is not null and p_team = app.my_team_id(p_org))
    when 'own'  then p_owner = auth.uid()
    else false
  end
$$;

create or replace function app.shares_org_with(p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.memberships mine
    join public.memberships theirs on theirs.org_id = mine.org_id
    where mine.user_id = auth.uid() and mine.status = 'active' and theirs.user_id = p_user
  )
$$;

-- ---------------------------------------------------------------------------
-- Guardas de membresías (escalada de privilegios y propiedad de la organización)
-- ---------------------------------------------------------------------------
create or replace function app.memberships_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_sa        uuid;
  v_role_org  uuid;
  v_org       uuid;
  v_touches   boolean := false;
  v_bootstrap boolean := false;
  v_remaining int;
begin
  -- Cascada por eliminación de la organización: permitir.
  if tg_op = 'DELETE' and not exists (select 1 from public.organizations where id = old.org_id) then
    return old;
  end if;

  select id into v_sa from public.roles where org_id is null and key = 'super_admin';

  if tg_op in ('INSERT', 'UPDATE') then
    v_org := new.org_id;
    select org_id into v_role_org from public.roles where id = new.role_id;
    if v_role_org is not null and v_role_org <> new.org_id then
      raise exception 'role belongs to another organization' using errcode = '23514';
    end if;
    if tg_op = 'UPDATE' and (new.org_id <> old.org_id or new.user_id <> old.user_id) then
      raise exception 'org_id and user_id are immutable' using errcode = '23514';
    end if;
  else
    v_org := old.org_id;
  end if;

  -- Solo un super_admin puede otorgar, modificar o quitar el rol super_admin.
  -- (Sin auth.uid() = contexto de confianza: workers/migraciones.)
  if auth.uid() is not null then
    if tg_op in ('INSERT', 'UPDATE') then
      if new.role_id = v_sa then v_touches := true; end if;
    end if;
    if tg_op in ('UPDATE', 'DELETE') then
      if old.role_id = v_sa then v_touches := true; end if;
    end if;

    if v_touches then
      -- Bootstrap: el primer super_admin de una organización nueva.
      if tg_op = 'INSERT' then
        v_bootstrap := not exists (
          select 1 from public.memberships where org_id = new.org_id and role_id = v_sa);
      end if;

      if not v_bootstrap and not exists (
        select 1 from public.memberships m
        where m.org_id = v_org and m.user_id = auth.uid()
          and m.status = 'active' and m.role_id = v_sa
      ) then
        raise exception 'only a super_admin can grant, change or remove the super_admin role'
          using errcode = '42501';
      end if;
    end if;
  end if;

  -- La organización siempre conserva al menos un super_admin activo.
  if tg_op in ('UPDATE', 'DELETE') then
    if old.role_id = v_sa and old.status = 'active' then
      if tg_op = 'DELETE' or new.role_id <> v_sa or new.status <> 'active' then
        select count(*) into v_remaining from public.memberships
        where org_id = old.org_id and role_id = v_sa and status = 'active' and id <> old.id;
        if v_remaining = 0 then
          raise exception 'organization must keep at least one active super_admin'
            using errcode = '23514';
        end if;
      end if;
    end if;
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;

create trigger memberships_guard_trg before insert or update or delete on public.memberships
  for each row execute function app.memberships_guard();

-- ---------------------------------------------------------------------------
-- Privilegios (deny by default) + RLS
-- ---------------------------------------------------------------------------
revoke all on public.organizations, public.profiles, public.teams, public.permissions,
              public.roles, public.role_permissions, public.memberships from anon, authenticated;

grant select on public.organizations, public.profiles, public.teams, public.permissions,
                public.roles, public.role_permissions, public.memberships to authenticated;
grant update (name, currency, timezone, locale, settings) on public.organizations to authenticated;
grant update (full_name, avatar_url) on public.profiles to authenticated;
grant insert, update, delete on public.teams to authenticated;
grant insert, update, delete on public.memberships to authenticated;

grant all on public.organizations, public.profiles, public.teams, public.permissions,
             public.roles, public.role_permissions, public.memberships to service_role;

alter table public.organizations    enable row level security;
alter table public.profiles         enable row level security;
alter table public.teams            enable row level security;
alter table public.permissions      enable row level security;
alter table public.roles            enable row level security;
alter table public.role_permissions enable row level security;
alter table public.memberships      enable row level security;

-- organizations: sin INSERT/DELETE para clientes (se crea vía create_organization)
create policy organizations_select on public.organizations
  for select to authenticated using ((select app.is_member(id)));
create policy organizations_update on public.organizations
  for update to authenticated
  using ((select app.has_permission(id, 'settings:manage')))
  with check ((select app.has_permission(id, 'settings:manage')));

-- profiles
create policy profiles_select on public.profiles
  for select to authenticated
  using (id = (select auth.uid()) or (select app.shares_org_with(id)));
create policy profiles_update on public.profiles
  for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- teams
create policy teams_select on public.teams
  for select to authenticated using ((select app.is_member(org_id)));
create policy teams_insert on public.teams
  for insert to authenticated with check ((select app.has_permission(org_id, 'teams:manage')));
create policy teams_update on public.teams
  for update to authenticated
  using ((select app.has_permission(org_id, 'teams:manage')))
  with check ((select app.has_permission(org_id, 'teams:manage')));
create policy teams_delete on public.teams
  for delete to authenticated using ((select app.has_permission(org_id, 'teams:manage')));

-- catálogo de permisos y roles (lectura)
create policy permissions_select on public.permissions
  for select to authenticated using (true);
create policy roles_select on public.roles
  for select to authenticated using (org_id is null or (select app.is_member(org_id)));
create policy role_permissions_select on public.role_permissions
  for select to authenticated
  using (exists (select 1 from public.roles r where r.id = role_id));

-- memberships
create policy memberships_select on public.memberships
  for select to authenticated
  using (user_id = (select auth.uid()) or (select app.is_member(org_id)));
create policy memberships_insert on public.memberships
  for insert to authenticated with check ((select app.has_permission(org_id, 'users:manage')));
create policy memberships_update on public.memberships
  for update to authenticated
  using ((select app.has_permission(org_id, 'users:manage')))
  with check ((select app.has_permission(org_id, 'users:manage')));
create policy memberships_delete on public.memberships
  for delete to authenticated using ((select app.has_permission(org_id, 'users:manage')));

-- Funciones: solo authenticated/service_role pueden ejecutarlas
revoke all on schema app from public, anon;
grant usage on schema app to authenticated, service_role;
revoke all on all functions in schema app from public, anon;
grant execute on function app.is_member(uuid), app.permission_scope(uuid, text),
  app.has_permission(uuid, text), app.my_team_id(uuid),
  app.can_access_row(uuid, text, uuid, uuid), app.shares_org_with(uuid)
  to authenticated, service_role;


-- ---------------- 20260919000002_audit_and_events.sql ----------------
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


-- ---------------- 20260919000003_onboarding.sql ----------------
-- =============================================================================
-- 0003 ONBOARDING: creación de organizaciones
-- =============================================================================
-- Los clientes no pueden hacer INSERT directo en organizations. Este RPC crea la
-- organización y a su creador como super_admin de forma atómica, con validaciones.
-- =============================================================================

create or replace function public.create_organization(p_name text, p_slug text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_slug text := lower(trim(p_slug));
  v_org  uuid;
  v_role uuid;
begin
  if v_user is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  if v_slug = any (array['admin','api','app','www','support','help','status','login',
                         'signup','auth','billing','docs','static','assets','mail','root']) then
    raise exception 'slug "%" is reserved', v_slug using errcode = '23514';
  end if;

  -- Límite provisional anti-abuso (el rate limiting real vive en el borde/API).
  if (select count(*) from public.organizations
       where created_by = v_user and deleted_at is null) >= 5 then
    raise exception 'organization limit reached' using errcode = '53400';
  end if;

  select id into v_role from public.roles where org_id is null and key = 'super_admin';

  insert into public.organizations (name, slug, created_by)
  values (trim(p_name), v_slug, v_user)
  returning id into v_org;

  insert into public.memberships (org_id, user_id, role_id)
  values (v_org, v_user, v_role);

  perform app.emit_event(v_org, 'organization.created', 'organization', v_org,
                         jsonb_build_object('name', trim(p_name)));
  return v_org;
end $$;

revoke all on function public.create_organization(text, text) from public, anon;
grant execute on function public.create_organization(text, text) to authenticated, service_role;


-- ---------------- 20260919000004_customer_visibility.sql ----------------
-- =============================================================================
-- 0004 VISIBILIDAD DE CLIENTES
-- =============================================================================
-- Regla de negocio:
--   * super_admin, admin y manager  -> ven TODOS los clientes (alcance org)
--   * sales_manager                 -> los clientes de su equipo (alcance team)
--   * sales_agent                   -> solo SUS clientes (alcance own)
--   * marketing, customer_service, analyst, viewer -> alcance own: solo los
--     clientes que se les asignen explícitamente (no ven la base completa).
-- Cambia únicamente datos de la matriz de permisos; es reversible.
-- =============================================================================
update public.role_permissions rp
   set scope = 'own'
  from public.roles r
 where r.id = rp.role_id
   and r.org_id is null
   and r.key in ('marketing', 'customer_service', 'analyst', 'viewer')
   and rp.permission_key like 'customers:%'
   and rp.scope = 'org';


-- ---------------- 20260919000005_invitations_and_worker_api.sql ----------------
-- =============================================================================
-- 0005 INVITACIONES + API PARA WORKERS
-- =============================================================================
-- Invitaciones:
--   * El token (64 hex, ~244 bits) se devuelve UNA sola vez; en BD solo se guarda su SHA-256.
--   * Un admin (users:manage) invita por email + rol (+ equipo). NO se puede invitar como
--     super_admin: se invita como admin y luego un super_admin lo promueve.
--   * Al aceptar se exige que el usuario autenticado tenga ese email y lo haya VERIFICADO.
--   * Reinvitar al mismo email invalida la invitación anterior (equivale a "reenviar").
-- Workers:
--   * PostgREST solo expone `public`; estos wrappers dan acceso a la cola de eventos
--     y son ejecutables ÚNICAMENTE por service_role.
-- =============================================================================

create table public.invitations (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations(id) on delete cascade,
  email        text not null check (email = lower(email) and email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  role_id      uuid not null references public.roles(id),
  team_id      uuid,
  token_hash   text not null unique,
  invited_by   uuid references auth.users(id) on delete set null,
  expires_at   timestamptz not null default now() + interval '7 days',
  accepted_at  timestamptz,
  accepted_by  uuid references auth.users(id) on delete set null,
  revoked_at   timestamptz,
  created_at   timestamptz not null default now(),
  foreign key (team_id, org_id) references public.teams (id, org_id)
    on delete set null (team_id)
);
create unique index invitations_pending_uk on public.invitations (org_id, email)
  where accepted_at is null and revoked_at is null;
create index invitations_org_idx on public.invitations (org_id, created_at desc);

-- La auditoría nunca debe guardar el hash del token.
create or replace function app.audit_row_change() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_old jsonb; v_new jsonb; v_row jsonb;
  v_old_d jsonb; v_new_d jsonb;
  v_id uuid; v_org uuid; v_ip inet;
begin
  if tg_op = 'INSERT' then
    v_new := to_jsonb(new) - 'token_hash'; v_row := v_new;
  elsif tg_op = 'DELETE' then
    v_old := to_jsonb(old) - 'token_hash'; v_row := v_old;
  else
    v_old := to_jsonb(old) - 'token_hash'; v_new := to_jsonb(new) - 'token_hash'; v_row := v_new;
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

create trigger invitations_audit after insert or update or delete on public.invitations
  for each row execute function app.audit_row_change();

-- Privilegios + RLS: lectura por quien administra usuarios; las escrituras solo por RPC.
revoke all on public.invitations from anon, authenticated;
grant select (id, org_id, email, role_id, team_id, invited_by, expires_at, accepted_at, revoked_at, created_at)
  on public.invitations to authenticated;   -- sin token_hash
grant all on public.invitations to service_role;
alter table public.invitations enable row level security;
create policy invitations_select on public.invitations
  for select to authenticated using ((select app.has_permission(org_id, 'users:manage')));

-- ---------------------------------------------------------------------------
-- create_invitation: devuelve el token en claro (única vez)
-- ---------------------------------------------------------------------------
create or replace function public.create_invitation(
  p_org uuid, p_email text, p_role_key text, p_team_id uuid default null
) returns text language plpgsql security definer set search_path = '' as $$
declare
  v_user  uuid := auth.uid();
  v_email text := lower(trim(p_email));
  v_role  uuid;
  v_token text;
  v_id    uuid;
begin
  if v_user is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not app.has_permission(p_org, 'users:manage') then
    raise exception 'not allowed to invite users' using errcode = '42501';
  end if;
  if p_role_key = 'super_admin' then
    raise exception 'cannot invite as super_admin; invite as admin and promote afterwards'
      using errcode = '42501';
  end if;

  select id into v_role from public.roles
   where key = p_role_key and (org_id is null or org_id = p_org)
   order by org_id nulls last limit 1;
  if v_role is null then
    raise exception 'unknown role' using errcode = '22023';
  end if;

  if exists (select 1 from public.memberships m join auth.users u on u.id = m.user_id
              where m.org_id = p_org and lower(u.email) = v_email) then
    raise exception 'user is already a member' using errcode = '23505';
  end if;

  -- Reinvitar invalida la invitación pendiente anterior.
  update public.invitations set revoked_at = now()
   where org_id = p_org and email = v_email and accepted_at is null and revoked_at is null;

  v_token := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');

  insert into public.invitations (org_id, email, role_id, team_id, token_hash, invited_by)
  values (p_org, v_email, v_role, p_team_id,
          encode(sha256(convert_to(v_token, 'UTF8')), 'hex'), v_user)
  returning id into v_id;

  perform app.emit_event(p_org, 'invitation.created', 'invitation', v_id,
                         jsonb_build_object('email', v_email, 'role', p_role_key));
  return v_token;
end $$;

-- ---------------------------------------------------------------------------
-- revoke_invitation
-- ---------------------------------------------------------------------------
create or replace function public.revoke_invitation(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  select org_id into v_org from public.invitations where id = p_id;
  if v_org is null or not app.has_permission(v_org, 'users:manage') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update public.invitations set revoked_at = now()
   where id = p_id and accepted_at is null and revoked_at is null;
end $$;

-- ---------------------------------------------------------------------------
-- get_invitation: vista previa para el invitado (requiere sesión y conocer el token)
-- ---------------------------------------------------------------------------
create or replace function public.get_invitation(p_token text)
returns table (org_name text, role_name text, email text, status text)
language sql stable security definer set search_path = '' as $$
  select o.name, r.name, i.email,
         case when i.accepted_at is not null then 'accepted'
              when i.revoked_at  is not null then 'revoked'
              when i.expires_at < now()      then 'expired'
              else 'pending' end
    from public.invitations i
    join public.organizations o on o.id = i.org_id
    join public.roles r on r.id = i.role_id
   where i.token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex')
     and auth.uid() is not null
$$;

-- ---------------------------------------------------------------------------
-- accept_invitation
-- ---------------------------------------------------------------------------
create or replace function public.accept_invitation(p_token text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_user  uuid := auth.uid();
  v_inv   public.invitations%rowtype;
  v_email text;
  v_conf  timestamptz;
  v_mem   public.memberships%rowtype;
begin
  if v_user is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  select * into v_inv from public.invitations
   where token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex')
   for update;
  if not found then
    raise exception 'invitation_not_found' using errcode = 'P0002';
  end if;
  if v_inv.accepted_at is not null then
    raise exception 'invitation_accepted' using errcode = '55000';
  end if;
  if v_inv.revoked_at is not null then
    raise exception 'invitation_revoked' using errcode = '55000';
  end if;
  if v_inv.expires_at < now() then
    raise exception 'invitation_expired' using errcode = '55000';
  end if;

  select lower(email), email_confirmed_at into v_email, v_conf from auth.users where id = v_user;
  if v_conf is null then
    raise exception 'email_not_verified' using errcode = '42501';
  end if;
  if v_email is distinct from v_inv.email then
    raise exception 'email_mismatch' using errcode = '42501';
  end if;

  select * into v_mem from public.memberships where org_id = v_inv.org_id and user_id = v_user;
  if found then
    if v_mem.status <> 'active' then
      raise exception 'membership_exists' using errcode = '55000';
    end if;
  else
    insert into public.memberships (org_id, user_id, role_id, team_id)
    values (v_inv.org_id, v_user, v_inv.role_id, v_inv.team_id);
  end if;

  update public.invitations set accepted_at = now(), accepted_by = v_user where id = v_inv.id;
  perform app.emit_event(v_inv.org_id, 'invitation.accepted', 'invitation', v_inv.id,
                         jsonb_build_object('user_id', v_user));
  return v_inv.org_id;
end $$;

revoke all on function public.create_invitation(uuid, text, text, uuid),
  public.revoke_invitation(uuid), public.get_invitation(text), public.accept_invitation(text)
  from public, anon;
grant execute on function public.create_invitation(uuid, text, text, uuid),
  public.revoke_invitation(uuid), public.get_invitation(text), public.accept_invitation(text)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- API para workers (solo service_role)
-- ---------------------------------------------------------------------------
create or replace function public.worker_claim_events(p_limit int default 100)
returns setof public.domain_events language sql security definer set search_path = '' as $$
  select * from app.claim_events(p_limit)
$$;
create or replace function public.worker_complete_event(p_id uuid) returns void
language sql security definer set search_path = '' as $$
  select app.complete_event(p_id)
$$;
create or replace function public.worker_fail_event(p_id uuid, p_error text) returns void
language sql security definer set search_path = '' as $$
  select app.fail_event(p_id, p_error)
$$;

revoke all on function public.worker_claim_events(int), public.worker_complete_event(uuid),
  public.worker_fail_event(uuid, text) from public, anon, authenticated;
grant execute on function public.worker_claim_events(int), public.worker_complete_event(uuid),
  public.worker_fail_event(uuid, text) to service_role;


-- ---------------- 20260919000006_custom_fields.sql ----------------
-- =============================================================================
-- 0006 CAMPOS PERSONALIZADOS
-- =============================================================================
-- Cada organización define sus campos (por entidad). Los valores viven en una
-- columna jsonb `custom_fields` de la entidad y SE VALIDAN en la base de datos
-- contra las definiciones: no se puede guardar un valor de tipo incorrecto ni una
-- clave que no exista, venga de la UI, del CSV o de la API.
-- =============================================================================

create table public.custom_field_definitions (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  entity      text not null check (entity in ('customer', 'lead')),
  key         text not null check (key ~ '^[a-z][a-z0-9_]{1,39}$'),
  label       text not null check (char_length(btrim(label)) between 1 and 80),
  type        text not null check (type in ('text','number','date','select','multi_select','boolean','currency','url','phone','email')),
  options     jsonb not null default '[]'::jsonb,
  position    int  not null default 0,
  archived_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (org_id, entity, key),
  check (case when jsonb_typeof(options) = 'array'
              then (type in ('select', 'multi_select')) = (jsonb_array_length(options) > 0)
              else false end)
);
create index custom_field_defs_org_idx on public.custom_field_definitions (org_id, entity, position);

create trigger custom_field_defs_touch before update on public.custom_field_definitions
  for each row execute function app.touch_updated_at();

-- La clave y el tipo no cambian: invalidarían los datos ya guardados.
create or replace function app.custom_field_defs_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.org_id <> old.org_id or new.entity <> old.entity or new.key <> old.key or new.type <> old.type then
    raise exception 'custom field key, type and entity are immutable' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger custom_field_defs_guard_trg before update on public.custom_field_definitions
  for each row execute function app.custom_field_defs_guard();

-- ---------------------------------------------------------------------------
-- Validación de valores
-- ---------------------------------------------------------------------------
create or replace function app.validate_custom_fields(p_org uuid, p_entity text, p_values jsonb)
returns void language plpgsql stable security definer set search_path = '' as $$
declare
  k text; v jsonb; d public.custom_field_definitions%rowtype; s text; e text;
begin
  if p_values is null or p_values = '{}'::jsonb then return; end if;
  if jsonb_typeof(p_values) <> 'object' then
    raise exception 'custom_field: value must be an object' using errcode = '22023';
  end if;
  if octet_length(p_values::text) > 8192 then
    raise exception 'custom_field: too large' using errcode = '22023';
  end if;

  for k, v in select key, value from jsonb_each(p_values) loop
    select * into d from public.custom_field_definitions
     where org_id = p_org and entity = p_entity and key = k;   -- archivados siguen siendo claves conocidas
    if not found then
      raise exception 'custom_field: unknown field %', k using errcode = '22023';
    end if;
    if jsonb_typeof(v) = 'null' then continue; end if;   -- null limpia el valor

    if d.type in ('text', 'url', 'phone', 'email') then
      if jsonb_typeof(v) <> 'string' then
        raise exception 'custom_field: % must be text', k using errcode = '22023';
      end if;
      s := v #>> '{}';
      if char_length(s) > 500 then
        raise exception 'custom_field: % is too long', k using errcode = '22023';
      end if;
      if d.type = 'email' and s !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
        raise exception 'custom_field: % must be an email', k using errcode = '22023';
      elsif d.type = 'url' and s !~* '^https?://[^[:space:]]+$' then
        raise exception 'custom_field: % must be a http(s) url', k using errcode = '22023';
      elsif d.type = 'phone' and s !~ '^[+0-9 ()-]{6,20}$' then
        raise exception 'custom_field: % must be a phone number', k using errcode = '22023';
      end if;
    elsif d.type in ('number', 'currency') then
      if jsonb_typeof(v) <> 'number' then
        raise exception 'custom_field: % must be a number', k using errcode = '22023';
      end if;
    elsif d.type = 'boolean' then
      if jsonb_typeof(v) <> 'boolean' then
        raise exception 'custom_field: % must be true or false', k using errcode = '22023';
      end if;
    elsif d.type = 'date' then
      s := v #>> '{}';
      if jsonb_typeof(v) <> 'string' or s !~ '^\d{4}-\d{2}-\d{2}$' then
        raise exception 'custom_field: % must be a date (YYYY-MM-DD)', k using errcode = '22023';
      end if;
      begin
        perform s::date;
      exception when others then
        raise exception 'custom_field: % is not a valid date', k using errcode = '22023';
      end;
    elsif d.type = 'select' then
      if jsonb_typeof(v) <> 'string' or not (d.options @> jsonb_build_array(v #>> '{}')) then
        raise exception 'custom_field: % must be one of the allowed options', k using errcode = '22023';
      end if;
    elsif d.type = 'multi_select' then
      if jsonb_typeof(v) <> 'array' or jsonb_array_length(v) > 50 then
        raise exception 'custom_field: % must be a list of options', k using errcode = '22023';
      end if;
      for e in select jsonb_array_elements_text(v) loop
        if not (d.options @> jsonb_build_array(e)) then
          raise exception 'custom_field: % has an option that is not allowed', k using errcode = '22023';
        end if;
      end loop;
    end if;
  end loop;
end $$;

-- Trigger genérico para las tablas con columna custom_fields.
create or replace function app.custom_fields_trigger() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_entity text := case tg_table_name when 'customers' then 'customer' when 'leads' then 'lead' end;
begin
  if tg_op = 'INSERT' or new.custom_fields is distinct from old.custom_fields then
    perform app.validate_custom_fields(new.org_id, v_entity, new.custom_fields);
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Privilegios + RLS + auditoría
-- ---------------------------------------------------------------------------
revoke all on public.custom_field_definitions from anon, authenticated;
grant select on public.custom_field_definitions to authenticated;
grant insert (org_id, entity, key, label, type, options, position) on public.custom_field_definitions to authenticated;
grant update (label, options, position, archived_at) on public.custom_field_definitions to authenticated;
grant all on public.custom_field_definitions to service_role;

alter table public.custom_field_definitions enable row level security;
create policy custom_field_defs_select on public.custom_field_definitions
  for select to authenticated using ((select app.is_member(org_id)));
create policy custom_field_defs_insert on public.custom_field_definitions
  for insert to authenticated with check ((select app.has_permission(org_id, 'fields:manage')));
create policy custom_field_defs_update on public.custom_field_definitions
  for update to authenticated
  using ((select app.has_permission(org_id, 'fields:manage')))
  with check ((select app.has_permission(org_id, 'fields:manage')));

create trigger custom_field_defs_audit after insert or update or delete on public.custom_field_definitions
  for each row execute function app.audit_row_change();

revoke all on function app.custom_field_defs_guard(), app.validate_custom_fields(uuid, text, jsonb),
  app.custom_fields_trigger() from public, anon, authenticated;


-- ---------------- 20260919000007_customers_identity.sql ----------------
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


-- ---------------- 20260919000008_lead_ingestion_and_api_keys.sql ----------------
-- =============================================================================
-- 0008 CAPTURA DE LEADS + LLAVES DE API
-- =============================================================================
-- Flujo: captura → (identificadores ya normalizados por el servidor) → resolución de
-- identidad → lead. Toda entrada (API, webhook, CSV) pasa por app.ingest_lead_core.
--   * ingest_lead   : solo service_role (la llama el endpoint público tras autenticar la llave).
--   * import_leads  : personas con permiso leads:create (importación CSV), hasta 500 filas por llamada.
-- Llaves de API: se muestran una sola vez; en BD solo el SHA-256. Límite de peticiones por llave.
-- =============================================================================

create or replace function app.ingest_lead_core(
  p_org uuid, p_payload jsonb, p_owner_new uuid, p_actor uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_source     text := coalesce(nullif(btrim(p_payload ->> 'source'), ''), 'api');
  v_ext        text := nullif(btrim(p_payload ->> 'external_id'), '');
  v_res        record;
  v_cust       public.customers%rowtype;
  v_lead       uuid;
  v_existing   public.leads%rowtype;
  v_resolution text;
begin
  if char_length(v_source) > 60 then
    raise exception 'source is too long' using errcode = '22023';
  end if;

  -- Idempotencia: el mismo external_id de la misma fuente devuelve el lead existente.
  if v_ext is not null then
    select * into v_existing from public.leads
     where org_id = p_org and source = v_source and external_id = v_ext;
    if found then
      return jsonb_build_object('lead_id', v_existing.id, 'customer_id', v_existing.customer_id,
                                'outcome', v_existing.resolution, 'deduplicated', true);
    end if;
  end if;

  select * into v_res from app.resolve_customer(
    p_org, p_payload ->> 'name', p_payload -> 'identifiers',
    coalesce(nullif(p_payload ->> 'type', ''), 'person'),
    p_owner_new, p_actor, v_source, coalesce(p_payload -> 'attrs', '{}'::jsonb), true);

  select * into v_cust from public.customers where id = v_res.out_customer_id;
  v_resolution := case v_res.out_outcome when 'created' then 'created' when 'review' then 'review'
                                         when 'conflict' then 'conflict' else 'matched' end;

  insert into public.leads (
    org_id, customer_id, owner_id, team_id, source, channel, campaign, ad, form, product_interest,
    external_id, contact_name, contact_email, contact_phone, resolution, consent, notes,
    custom_fields, raw_payload, created_by)
  values (
    p_org, v_cust.id, v_cust.owner_id, v_cust.team_id, v_source,
    nullif(btrim(p_payload ->> 'channel'), ''), nullif(btrim(p_payload ->> 'campaign'), ''),
    nullif(btrim(p_payload ->> 'ad'), ''), nullif(btrim(p_payload ->> 'form'), ''),
    nullif(btrim(p_payload ->> 'product_interest'), ''), v_ext,
    nullif(btrim(p_payload ->> 'name'), ''), nullif(btrim(p_payload ->> 'email'), ''),
    nullif(btrim(p_payload ->> 'phone'), ''), v_resolution,
    case when p_payload ? 'consent' then (p_payload ->> 'consent')::boolean end,
    nullif(btrim(p_payload ->> 'notes'), ''),
    coalesce(p_payload -> 'custom_fields', '{}'::jsonb),
    coalesce(p_payload -> 'raw', '{}'::jsonb), p_actor)
  returning id into v_lead;

  perform app.emit_event(p_org, 'lead.created', 'lead', v_lead,
    jsonb_build_object('source', v_source, 'channel', p_payload ->> 'channel',
                       'campaign', p_payload ->> 'campaign', 'resolution', v_resolution,
                       'do_not_contact', v_cust.do_not_contact),
    v_cust.id);

  return jsonb_build_object('lead_id', v_lead, 'customer_id', v_cust.id,
                            'outcome', v_resolution, 'deduplicated', false);
end $$;

-- Endpoint público (tras autenticar la llave): solo service_role.
create or replace function public.ingest_lead(p_org uuid, p_payload jsonb) returns jsonb
language sql security definer set search_path = '' as $$
  select app.ingest_lead_core(p_org, p_payload, null, null)
$$;

-- Importación CSV / carga masiva por una persona con permiso.
create or replace function public.import_leads(p_org uuid, p_rows jsonb, p_assign_to_me boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid     uuid := auth.uid();
  v_owner   uuid;
  v_results jsonb := '[]'::jsonb;
  v_out     jsonb;
  i         int;
begin
  if v_uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not app.has_permission(p_org, 'leads:create') then
    raise exception 'not allowed to import leads' using errcode = '42501';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'rows must be an array' using errcode = '22023';
  end if;
  if jsonb_array_length(p_rows) > 500 then
    raise exception 'too many rows (max 500 per call)' using errcode = '22023';
  end if;

  -- Quien no ve toda la cartera queda como propietario de lo que importa (para poder verlo).
  if p_assign_to_me or app.permission_scope(p_org, 'customers:read') is distinct from 'org' then
    v_owner := v_uid;
  end if;

  for i in 0 .. jsonb_array_length(p_rows) - 1 loop
    begin
      v_out := app.ingest_lead_core(p_org, p_rows -> i, v_owner, v_uid);
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'row', i, 'outcome', v_out ->> 'outcome', 'deduplicated', (v_out ->> 'deduplicated')::boolean));
    exception when others then
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'row', i, 'error_code', sqlstate,
        -- solo se expone el mensaje de errores de validación conocidos
        'error', case when sqlstate = '22023' then sqlerrm else null end));
    end;
  end loop;

  return v_results;
end $$;

-- ---------------------------------------------------------------------------
-- Llaves de API
-- ---------------------------------------------------------------------------
create table public.api_keys (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references public.organizations(id) on delete cascade,
  name               text not null check (char_length(btrim(name)) between 1 and 80),
  key_prefix         text not null,
  key_hash           text not null unique,
  rate_limit_per_min int  not null default 120 check (rate_limit_per_min between 1 and 6000),
  created_by         uuid references auth.users(id) on delete set null,
  created_at         timestamptz not null default now(),
  last_used_at       timestamptz,
  revoked_at         timestamptz
);
create index api_keys_org_idx on public.api_keys (org_id, created_at desc);

create table public.api_rate_limits (
  key_id        uuid not null references public.api_keys(id) on delete cascade,
  window_start  timestamptz not null,
  hits          int not null default 0,
  primary key (key_id, window_start)
);

create trigger api_keys_audit after insert or update or delete on public.api_keys
  for each row execute function app.audit_row_change();

create or replace function public.create_api_key(p_org uuid, p_name text) returns text
language plpgsql security definer set search_path = '' as $$
declare v_key text;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not app.has_permission(p_org, 'integrations:manage') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if (select count(*) from public.api_keys where org_id = p_org and revoked_at is null) >= 20 then
    raise exception 'api key limit reached' using errcode = '53400';
  end if;

  v_key := 'crm_' || replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  insert into public.api_keys (org_id, name, key_prefix, key_hash, created_by)
  values (p_org, btrim(p_name), left(v_key, 12),
          encode(sha256(convert_to(v_key, 'UTF8')), 'hex'), auth.uid());
  return v_key;
end $$;

create or replace function public.revoke_api_key(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  select org_id into v_org from public.api_keys where id = p_id;
  if v_org is null or not app.has_permission(v_org, 'integrations:manage') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update public.api_keys set revoked_at = now() where id = p_id and revoked_at is null;
end $$;

-- Autenticación de la llave + límite de peticiones (solo service_role).
create or replace function public.api_authenticate(p_key_hash text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_key  public.api_keys%rowtype;
  v_win  timestamptz := date_trunc('minute', now());
  v_hits int;
begin
  select * into v_key from public.api_keys where key_hash = p_key_hash;
  if not found or v_key.revoked_at is not null then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;

  insert into public.api_rate_limits (key_id, window_start, hits) values (v_key.id, v_win, 1)
  on conflict (key_id, window_start) do update set hits = public.api_rate_limits.hits + 1
  returning hits into v_hits;

  if v_hits > v_key.rate_limit_per_min then
    return jsonb_build_object('ok', false, 'reason', 'rate_limited',
      'retry_after', greatest(1, ceil(extract(epoch from (v_win + interval '1 minute' - now())))::int));
  end if;

  update public.api_keys set last_used_at = now()
   where id = v_key.id and (last_used_at is null or last_used_at < now() - interval '1 minute');
  delete from public.api_rate_limits where key_id = v_key.id and window_start < now() - interval '1 hour';

  return jsonb_build_object('ok', true, 'org_id', v_key.org_id, 'key_id', v_key.id);
end $$;

-- ---------------------------------------------------------------------------
-- Privilegios + RLS
-- ---------------------------------------------------------------------------
revoke all on public.api_keys, public.api_rate_limits from anon, authenticated;
grant select (id, org_id, name, key_prefix, rate_limit_per_min, created_by, created_at, last_used_at, revoked_at)
  on public.api_keys to authenticated;   -- sin key_hash
grant all on public.api_keys, public.api_rate_limits to service_role;

alter table public.api_keys enable row level security;
alter table public.api_rate_limits enable row level security;
create policy api_keys_select on public.api_keys for select to authenticated
  using ((select app.has_permission(org_id, 'integrations:manage')));
-- api_rate_limits: sin políticas (solo service_role).

revoke all on function app.ingest_lead_core(uuid, jsonb, uuid, uuid) from public, anon, authenticated;

revoke all on function public.ingest_lead(uuid, jsonb), public.api_authenticate(text)
  from public, anon, authenticated;
grant execute on function public.ingest_lead(uuid, jsonb), public.api_authenticate(text) to service_role;

revoke all on function public.import_leads(uuid, jsonb, boolean), public.create_api_key(uuid, text),
  public.revoke_api_key(uuid) from public, anon;
grant execute on function public.import_leads(uuid, jsonb, boolean), public.create_api_key(uuid, text),
  public.revoke_api_key(uuid) to authenticated, service_role;


-- ---------------- 20260919000009_pipelines_opportunities.sql ----------------
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


-- ---------------- 20260919000010_tasks_activities.sql ----------------
-- =============================================================================
-- 0010 TAREAS Y ACTIVIDADES
-- =============================================================================
--   * Tarea = algo POR HACER (asignada, con vencimiento). Actividad = algo que YA pasó (llamada,
--     reunión, nota) y no se edita: un error se corrige con una nota nueva.
--   * Una tarea vinculada a una oportunidad hereda su cliente (nunca hay inconsistencia).
--   * Crear una tarea o actividad exige tener acceso al cliente/oportunidad al que se vincula.
--   * Cambiar de responsable una tarea: vendedor no; sales manager, dentro de su equipo; manager/admin, a cualquiera.
--   * Las tareas abiertas siguen al cliente cuando se reasigna o se fusiona.
--   * Todo pasa por RPC: los estados (abierta/hecha/cancelada) no son escribibles directamente.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- tasks
-- ---------------------------------------------------------------------------
create table public.tasks (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organizations(id) on delete cascade,
  title          text not null check (char_length(btrim(title)) between 1 and 160),
  description    text check (char_length(description) <= 2000),
  type           text not null default 'follow_up' check (type in ('call', 'whatsapp', 'email', 'meeting', 'follow_up', 'other')),
  priority       text not null default 'normal' check (priority in ('low', 'normal', 'high')),
  due_at         timestamptz,
  status         text not null default 'open' check (status in ('open', 'done', 'cancelled')),
  assignee_id    uuid references auth.users(id) on delete set null,
  team_id        uuid,
  customer_id    uuid,
  opportunity_id uuid,
  outcome        text check (char_length(outcome) <= 500),
  completed_at   timestamptz,
  completed_by   uuid references auth.users(id) on delete set null,
  created_by     uuid references auth.users(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (id, org_id),
  foreign key (customer_id, org_id)    references public.customers (id, org_id),
  foreign key (opportunity_id, org_id) references public.opportunities (id, org_id),
  foreign key (team_id, org_id)        references public.teams (id, org_id) on delete set null (team_id),
  check ((status = 'done') = (completed_at is not null))
);
create index tasks_assignee_idx    on public.tasks (org_id, assignee_id, status, due_at);
create index tasks_customer_idx    on public.tasks (customer_id);
create index tasks_opportunity_idx on public.tasks (opportunity_id);

-- ---------------------------------------------------------------------------
-- activities (inmutables)
-- ---------------------------------------------------------------------------
create table public.activities (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organizations(id) on delete cascade,
  customer_id    uuid not null,
  opportunity_id uuid,
  type           text not null check (type in ('call', 'whatsapp', 'email', 'meeting', 'note')),
  direction      text check (direction in ('inbound', 'outbound')),
  summary        text not null check (char_length(btrim(summary)) between 1 and 2000),
  occurred_at    timestamptz not null default now(),
  created_by     uuid references auth.users(id) on delete set null,
  created_at     timestamptz not null default now(),
  foreign key (customer_id, org_id)    references public.customers (id, org_id),
  foreign key (opportunity_id, org_id) references public.opportunities (id, org_id),
  -- llamadas, WhatsApp y correos requieren dirección (entrante/saliente); notas y reuniones no
  check (type in ('note', 'meeting') or direction is not null)
);
create index activities_customer_idx on public.activities (customer_id, occurred_at desc);

create or replace function app.activities_immutable() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'activities are immutable' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' and not exists (select 1 from public.organizations where id = old.org_id) then
    return old;   -- cascada al eliminar la organización
  end if;
  -- El cliente absorbido en una fusión mueve sus actividades: única modificación permitida.
  if tg_op = 'UPDATE' and current_setting('app.customer_merge', true) = 'on'
     and new.customer_id is distinct from old.customer_id
     and (new.id, new.org_id, new.type, new.direction, new.summary, new.occurred_at, new.opportunity_id, new.created_by, new.created_at)
         is not distinct from (old.id, old.org_id, old.type, old.direction, old.summary, old.occurred_at, old.opportunity_id, old.created_by, old.created_at) then
    return new;
  end if;
  raise exception 'activities are immutable' using errcode = '42501';
end $$;
create trigger activities_no_mutation before update or delete on public.activities
  for each row execute function app.activities_immutable();
create trigger activities_no_truncate before truncate on public.activities
  for each statement execute function app.activities_immutable();

-- ---------------------------------------------------------------------------
-- Guardas de tasks
-- ---------------------------------------------------------------------------
create or replace function app.tasks_prepare() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_uid   uuid := auth.uid();
  v_team  uuid;
  v_scope public.permission_scope;
  v_opp_customer uuid;
begin
  new.title := btrim(new.title);

  -- Vinculada a una oportunidad: el cliente es el de la oportunidad.
  if new.opportunity_id is not null then
    select o.customer_id into v_opp_customer from public.opportunities o
     where o.id = new.opportunity_id and o.org_id = new.org_id;
    new.customer_id := v_opp_customer;
  end if;

  if tg_op = 'UPDATE' then
    if new.org_id <> old.org_id or new.opportunity_id is distinct from old.opportunity_id
       or (new.customer_id is distinct from old.customer_id and current_setting('app.customer_merge', true) is distinct from 'on') then
      raise exception 'task links are immutable' using errcode = '23514';
    end if;
    -- Una tarea cerrada es de solo lectura (se reabre con reopen_task).
    if old.status <> 'open' and current_setting('app.task_transition', true) is distinct from 'on'
       and (new.title <> old.title or new.due_at is distinct from old.due_at or new.assignee_id is distinct from old.assignee_id
            or new.priority <> old.priority or new.type <> old.type or new.description is distinct from old.description) then
      raise exception 'task_closed' using errcode = '23514';
    end if;
  end if;

  if tg_op = 'INSERT' or new.assignee_id is distinct from old.assignee_id then
    if new.assignee_id is null then
      new.team_id := null;
    else
      select m.team_id into v_team from public.memberships m
       where m.org_id = new.org_id and m.user_id = new.assignee_id and m.status = 'active';
      if not found then
        raise exception 'assignee must be an active member of the organization' using errcode = '23514';
      end if;
      new.team_id := v_team;
    end if;
    -- Reasignar una tarea existente: solo manager/admin (a cualquiera) o sales manager (dentro de su equipo).
    if tg_op = 'UPDATE' and v_uid is not null and current_setting('app.system_reassign', true) is distinct from 'on' then
      v_scope := app.permission_scope(new.org_id, 'tasks:update');
      if v_scope is distinct from 'org'
         and not (v_scope = 'team' and new.team_id is not null and new.team_id = app.my_team_id(new.org_id)) then
        raise exception 'only managers can reassign tasks' using errcode = '42501';
      end if;
    end if;
  end if;
  return new;
end $$;
create trigger tasks_prepare_trg before insert or update on public.tasks
  for each row execute function app.tasks_prepare();
create trigger tasks_touch before update on public.tasks
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Las tareas abiertas siguen al cliente al reasignarlo (solo las que tenía el responsable anterior:
-- lo asignado a mano a otra persona no se toca).
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
    perform set_config('app.system_reassign', 'on', true);
    update public.tasks
       set assignee_id = new.owner_id
     where customer_id = new.id and org_id = new.org_id and status = 'open'
       and assignee_id is not distinct from old.owner_id;
    perform set_config('app.system_reassign', 'off', true);
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
-- Registro de fusión + fusión ampliada (tareas y actividades)
-- ---------------------------------------------------------------------------
insert into app.customer_merge_targets values ('tasks'), ('activities');

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
  -- El orden (alfabético) importa: 'opportunities' va antes que 'tasks', y las tareas heredan el cliente de su oportunidad.
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
  perform set_config('app.system_reassign', 'on', true);
  update public.tasks set assignee_id = k.owner_id
   where customer_id = k.id and org_id = k.org_id and status = 'open'
     and assignee_id is not distinct from d.owner_id and d.owner_id is distinct from k.owner_id;
  perform set_config('app.system_reassign', 'off', true);
  perform set_config('app.customer_merge', 'off', true);

  perform app.emit_event(k.org_id, 'customer.merged', 'customer', k.id,
                         jsonb_build_object('dropped_id', d.id, 'dropped_name', d.full_name), k.id);
end $$;

-- ---------------------------------------------------------------------------
-- RPC de tareas
-- ---------------------------------------------------------------------------
create or replace function public.create_task(
  p_org uuid, p_title text, p_type text default 'follow_up', p_due timestamptz default null,
  p_priority text default 'normal', p_description text default null,
  p_customer uuid default null, p_opportunity uuid default null, p_assignee uuid default null
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_uid   uuid := auth.uid();
  v_asg   uuid;
  v_scope public.permission_scope;
  v_team  uuid;
  c public.customers%rowtype;
  o public.opportunities%rowtype;
  v_id uuid;
begin
  if v_uid is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not app.has_permission(p_org, 'tasks:create') then raise exception 'not allowed' using errcode = '42501'; end if;
  if btrim(coalesce(p_title, '')) = '' then raise exception 'name_required' using errcode = '22023'; end if;
  if p_due is not null and (p_due < now() - interval '1 year' or p_due > now() + interval '5 years') then
    raise exception 'due date out of range' using errcode = '22023';
  end if;

  -- Solo se vincula a lo que la persona puede ver.
  if p_opportunity is not null then
    select * into o from public.opportunities where id = p_opportunity and org_id = p_org;
    if not found or not app.can_access_row(o.org_id, 'opportunities:read', o.owner_id, o.team_id) then
      raise exception 'not allowed' using errcode = '42501';
    end if;
  end if;
  if p_customer is not null then
    select * into c from public.customers where id = p_customer and org_id = p_org and deleted_at is null;
    if not found or not app.can_access_row(c.org_id, 'customers:read', c.owner_id, c.team_id) then
      raise exception 'not allowed' using errcode = '42501';
    end if;
    if p_opportunity is not null and o.customer_id <> p_customer then
      raise exception 'opportunity belongs to another customer' using errcode = '22023';
    end if;
  end if;

  -- Responsable: por defecto quien la crea; asignar a otra persona depende del alcance.
  v_asg := coalesce(p_assignee, v_uid);
  if v_asg <> v_uid then
    v_scope := app.permission_scope(p_org, 'tasks:create');
    select m.team_id into v_team from public.memberships m
     where m.org_id = p_org and m.user_id = v_asg and m.status = 'active';
    if v_scope is distinct from 'org'
       and not (v_scope = 'team' and v_team is not null and v_team = app.my_team_id(p_org)) then
      raise exception 'only managers can assign tasks to others' using errcode = '42501';
    end if;
  end if;

  insert into public.tasks (org_id, title, description, type, priority, due_at, assignee_id, customer_id, opportunity_id, created_by)
  values (p_org, p_title, nullif(btrim(coalesce(p_description, '')), ''), coalesce(p_type, 'follow_up'),
          coalesce(p_priority, 'normal'), p_due, v_asg, p_customer, p_opportunity, v_uid)
  returning id into v_id;

  perform app.emit_event(p_org, 'task.created', 'task', v_id,
    jsonb_build_object('title', left(btrim(p_title), 160), 'type', coalesce(p_type, 'follow_up'),
                       'due_at', p_due, 'assignee_id', v_asg),
    (select t.customer_id from public.tasks t where t.id = v_id));
  return v_id;
end $$;

create or replace function app.task_transition(p_id uuid, p_to text, p_text text) returns void
language plpgsql security definer set search_path = '' as $$
declare t public.tasks%rowtype;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into t from public.tasks where id = p_id for update;
  if not found or not app.can_access_row(t.org_id, 'tasks:update', t.assignee_id, t.team_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_to in ('done', 'cancelled') and t.status <> 'open' then
    raise exception 'task_not_open' using errcode = '23514';
  end if;
  if p_to = 'open' and t.status = 'open' then
    raise exception 'task_not_closed' using errcode = '23514';
  end if;

  perform set_config('app.task_transition', 'on', true);
  update public.tasks set
    status       = p_to,
    completed_at = case when p_to = 'done' then now() end,
    completed_by = case when p_to = 'done' then auth.uid() end,
    outcome      = case when p_to = 'open' then null else left(nullif(btrim(coalesce(p_text, '')), ''), 500) end
   where id = t.id;
  perform set_config('app.task_transition', 'off', true);

  perform app.emit_event(t.org_id, 'task.' || case p_to when 'done' then 'completed' when 'cancelled' then 'cancelled' else 'reopened' end,
    'task', t.id, jsonb_build_object('title', t.title, 'outcome', left(nullif(btrim(coalesce(p_text, '')), ''), 200)),
    t.customer_id);
end $$;

create or replace function public.complete_task(p_id uuid, p_outcome text default null) returns void
language sql security definer set search_path = '' as $$ select app.task_transition(p_id, 'done', p_outcome) $$;
create or replace function public.cancel_task(p_id uuid, p_reason text default null) returns void
language sql security definer set search_path = '' as $$ select app.task_transition(p_id, 'cancelled', p_reason) $$;
create or replace function public.reopen_task(p_id uuid) returns void
language sql security definer set search_path = '' as $$ select app.task_transition(p_id, 'open', null) $$;

-- ---------------------------------------------------------------------------
-- RPC de actividades
-- ---------------------------------------------------------------------------
create or replace function public.log_activity(
  p_customer uuid, p_type text, p_summary text, p_direction text default null,
  p_opportunity uuid default null, p_occurred_at timestamptz default null
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  c public.customers%rowtype;
  o public.opportunities%rowtype;
  v_id uuid;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into c from public.customers where id = p_customer and deleted_at is null;
  -- Registrar una interacción es escribir en el historial del cliente: exige poder actualizarlo.
  if not found or not app.can_access_row(c.org_id, 'customers:update', c.owner_id, c.team_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if btrim(coalesce(p_summary, '')) = '' then raise exception 'name_required' using errcode = '22023'; end if;
  if p_occurred_at is not null and (p_occurred_at > now() + interval '5 minutes' or p_occurred_at < now() - interval '1 year') then
    raise exception 'date out of range' using errcode = '22023';
  end if;
  if p_opportunity is not null then
    select * into o from public.opportunities where id = p_opportunity and org_id = c.org_id and customer_id = c.id;
    if not found or not app.can_access_row(o.org_id, 'opportunities:read', o.owner_id, o.team_id) then
      raise exception 'not allowed' using errcode = '42501';
    end if;
  end if;

  insert into public.activities (org_id, customer_id, opportunity_id, type, direction, summary, occurred_at, created_by)
  values (c.org_id, c.id, p_opportunity, p_type, p_direction, btrim(p_summary), coalesce(p_occurred_at, now()), auth.uid())
  returning id into v_id;

  perform app.emit_event(c.org_id, 'activity.logged', 'activity', v_id,
    jsonb_build_object('type', p_type, 'direction', p_direction, 'summary', left(btrim(p_summary), 140),
                       'opportunity_id', p_opportunity), c.id);
  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- Privilegios + RLS + auditoría
-- ---------------------------------------------------------------------------
revoke all on public.tasks, public.activities from anon, authenticated;
grant select on public.tasks, public.activities to authenticated;
grant update (title, description, type, priority, due_at, assignee_id) on public.tasks to authenticated;
grant all on public.tasks, public.activities to service_role;

alter table public.tasks      enable row level security;
alter table public.activities enable row level security;

create policy tasks_select on public.tasks for select to authenticated
  using ((select app.can_access_row(org_id, 'tasks:read', assignee_id, team_id)));
create policy tasks_update on public.tasks for update to authenticated
  using ((select app.can_access_row(org_id, 'tasks:update', assignee_id, team_id)))
  with check ((select app.permission_scope(org_id, 'tasks:update')) is not null);

-- Las actividades se ven con el mismo alcance que el cliente (RLS de customers aplica en el subquery).
create policy activities_select on public.activities for select to authenticated
  using (exists (select 1 from public.customers c where c.id = customer_id));

create trigger tasks_audit after insert or update or delete on public.tasks
  for each row execute function app.audit_row_change();
create trigger activities_audit after insert on public.activities
  for each row execute function app.audit_row_change();

revoke all on function app.activities_immutable(), app.tasks_prepare(), app.customers_after_update(),
  app.task_transition(uuid, text, text) from public, anon, authenticated;

revoke all on function public.create_task(uuid, text, text, timestamptz, text, text, uuid, uuid, uuid),
  public.complete_task(uuid, text), public.cancel_task(uuid, text), public.reopen_task(uuid),
  public.log_activity(uuid, text, text, text, uuid, timestamptz), public.merge_customers(uuid, uuid)
  from public, anon;
grant execute on function public.create_task(uuid, text, text, timestamptz, text, text, uuid, uuid, uuid),
  public.complete_task(uuid, text), public.cancel_task(uuid, text), public.reopen_task(uuid),
  public.log_activity(uuid, text, text, text, uuid, timestamptz), public.merge_customers(uuid, uuid)
  to authenticated, service_role;

commit;

-- Comprobación final: 'tablas' y 'tablas_con_rls' deben ser iguales.
select 'LISTO' as estado,
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r') as tablas,
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity) as tablas_con_rls,
  (select count(*) from public.permissions) as permisos,
  (select count(*) from public.roles where org_id is null) as roles_base;

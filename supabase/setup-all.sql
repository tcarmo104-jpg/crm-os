-- =============================================================================
-- CRM OS · INSTALACIÓN COMPLETA (solo para un proyecto Supabase VACÍO)
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


-- ---------------- 20260919000011_products_quotes.sql ----------------
-- =============================================================================
-- 0011 CATÁLOGO DE PRODUCTOS Y COTIZACIONES
-- =============================================================================
-- Reglas que viven en la base de datos (no en la interfaz):
--   * El DINERO se calcula en la BD (numeric, redondeo por línea) y nadie escribe totales.
--   * Una cotización enviada es INMUTABLE: cambiarla = nueva versión (la anterior queda «reemplazada»).
--   * Cada línea guarda una FOTO del producto (nombre, precio, IVA): cambiar el catálogo después
--     no altera cotizaciones ya hechas.
--   * Descuentos por encima del límite de la organización exigen manager/admin para enviarse.
--   * Numeración correlativa por organización (COT-0001…), sin repetidos aunque haya concurrencia.
--   * Solo puede haber UNA cotización aceptada por oportunidad.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Contadores (numeración correlativa)
-- ---------------------------------------------------------------------------
create table app.org_counters (
  org_id uuid not null references public.organizations(id) on delete cascade,
  key    text not null,
  value  int  not null default 0,
  primary key (org_id, key)
);
revoke all on app.org_counters from public, anon, authenticated;

-- Atómico: el UPSERT bloquea la fila del contador, así dos transacciones nunca reciben el mismo número.
-- Si la transacción se revierte, el contador también: no quedan huecos.
create or replace function app.next_number(p_org uuid, p_key text) returns int
language sql security definer set search_path = '' as $$
  insert into app.org_counters (org_id, key, value) values (p_org, p_key, 1)
  on conflict (org_id, key) do update set value = app.org_counters.value + 1
  returning value
$$;

-- Límite de descuento sin aprobación (por organización; 10 % por defecto).
create or replace function app.quote_discount_limit(p_org uuid) returns numeric
language sql stable security definer set search_path = '' as $$
  select coalesce((select nullif(o.settings ->> 'quote_discount_limit_pct', '')::numeric
                     from public.organizations o where o.id = p_org), 10)
$$;

-- ---------------------------------------------------------------------------
-- Ampliar el log de transiciones a cotizaciones, ventas y casos
-- ---------------------------------------------------------------------------
alter table public.state_transitions drop constraint state_transitions_entity_type_check;
alter table public.state_transitions
  add constraint state_transitions_entity_type_check check (entity_type in ('lead', 'opportunity', 'quote', 'sale', 'case'));

-- ---------------------------------------------------------------------------
-- products (catálogo: productos y servicios)
-- ---------------------------------------------------------------------------
create table public.products (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  kind        text not null default 'product' check (kind in ('product', 'service')),
  sku         text check (char_length(sku) between 1 and 60),
  name        text not null check (char_length(btrim(name)) between 1 and 160),
  description text check (char_length(description) <= 1000),
  unit        text not null default 'unidad' check (char_length(btrim(unit)) between 1 and 30),
  unit_price  numeric(14, 2) not null default 0 check (unit_price >= 0 and unit_price <= 1000000000),
  tax_rate    numeric(5, 2)  not null default 0 check (tax_rate between 0 and 100),
  active      boolean not null default true,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (id, org_id)
);
create unique index products_sku_uk on public.products (org_id, lower(sku)) where sku is not null;
create index products_org_idx on public.products (org_id, active, kind, name);

create or replace function app.products_prepare() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.name := btrim(new.name);
  new.sku  := nullif(btrim(coalesce(new.sku, '')), '');
  if tg_op = 'UPDATE' and (new.kind <> old.kind or new.org_id <> old.org_id) then
    raise exception 'product kind is immutable' using errcode = '23514';
  end if;
  if tg_op = 'INSERT' then new.created_by := coalesce(new.created_by, auth.uid()); end if;
  return new;
end $$;
create trigger products_prepare_trg before insert or update on public.products
  for each row execute function app.products_prepare();
create trigger products_touch before update on public.products
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- quotes
-- ---------------------------------------------------------------------------
create table public.quotes (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organizations(id) on delete cascade,
  number          text not null,
  version         int  not null default 1 check (version >= 1),
  opportunity_id  uuid not null,
  customer_id     uuid not null,
  status          text not null default 'draft' check (status in ('draft', 'sent', 'accepted', 'rejected', 'superseded')),
  currency        text check (currency ~ '^[A-Z]{3}$'),
  valid_until     date,
  notes           text check (char_length(notes) <= 2000),
  subtotal        numeric(14, 2) not null default 0,     -- suma de líneas brutas (cantidad × precio)
  discount_total  numeric(14, 2) not null default 0,
  tax_total       numeric(14, 2) not null default 0,
  total           numeric(14, 2) not null default 0,
  max_discount_pct numeric(5, 2) not null default 0,
  owner_id        uuid references auth.users(id) on delete set null,
  team_id         uuid,
  parent_quote_id uuid references public.quotes(id),
  sent_at         timestamptz,
  decided_at      timestamptz,
  decided_by      uuid references auth.users(id) on delete set null,
  created_by      uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (id, org_id),
  unique (org_id, number, version),
  foreign key (opportunity_id, org_id) references public.opportunities (id, org_id),
  foreign key (customer_id, org_id)    references public.customers (id, org_id),
  foreign key (team_id, org_id)        references public.teams (id, org_id) on delete set null (team_id),
  -- aceptada/rechazada siempre tienen fecha de decisión (una rechazada puede pasar luego a «reemplazada»)
  check (status not in ('accepted', 'rejected') or decided_at is not null)
);
-- Una sola cotización aceptada por oportunidad.
create unique index quotes_one_accepted_uk on public.quotes (opportunity_id) where status = 'accepted';
create index quotes_customer_idx    on public.quotes (customer_id);
create index quotes_opportunity_idx on public.quotes (opportunity_id, version desc);
create index quotes_org_created_idx on public.quotes (org_id, created_at desc, id desc);

-- ---------------------------------------------------------------------------
-- quote_items (foto del producto en el momento de cotizar)
-- ---------------------------------------------------------------------------
create table public.quote_items (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id) on delete cascade,
  quote_id      uuid not null,
  position      int  not null default 1,
  product_id    uuid,
  description   text not null check (char_length(btrim(description)) between 1 and 300),
  unit          text not null default 'unidad' check (char_length(btrim(unit)) between 1 and 30),
  quantity      numeric(12, 3) not null check (quantity > 0 and quantity <= 1000000),
  unit_price    numeric(14, 2) not null check (unit_price >= 0 and unit_price <= 1000000000),
  discount_pct  numeric(5, 2)  not null default 0 check (discount_pct between 0 and 100),
  tax_rate      numeric(5, 2)  not null default 0 check (tax_rate between 0 and 100),
  line_gross    numeric(14, 2) not null default 0,
  line_discount numeric(14, 2) not null default 0,
  line_tax      numeric(14, 2) not null default 0,
  line_total    numeric(14, 2) not null default 0,
  created_at    timestamptz not null default now(),
  foreign key (quote_id, org_id)   references public.quotes (id, org_id) on delete cascade,
  foreign key (product_id, org_id) references public.products (id, org_id)
);
create index quote_items_quote_idx on public.quote_items (quote_id, position);

-- Cálculo de la línea (SIEMPRE en la BD; redondeo a 2 decimales por línea).
create or replace function app.quote_items_prepare() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_status text;
begin
  select q.status into v_status from public.quotes q where q.id = new.quote_id and q.org_id = new.org_id for share;
  if v_status is null then raise exception 'quote not found' using errcode = '22023'; end if;
  if v_status <> 'draft' then raise exception 'quote_locked' using errcode = '23514'; end if;

  new.description := btrim(new.description);
  new.line_gross    := round(new.quantity * new.unit_price, 2);
  new.line_discount := round(new.line_gross * new.discount_pct / 100, 2);
  new.line_tax      := round((new.line_gross - new.line_discount) * new.tax_rate / 100, 2);
  new.line_total    := new.line_gross - new.line_discount + new.line_tax;
  return new;
end $$;
create trigger quote_items_prepare_trg before insert or update on public.quote_items
  for each row execute function app.quote_items_prepare();

-- Bloquea borrar líneas de una cotización que ya no es borrador.
create or replace function app.quote_items_guard_delete() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_status text;
begin
  -- Se permite la cascada al eliminar la organización completa.
  if not exists (select 1 from public.organizations where id = old.org_id) then return old; end if;
  select q.status into v_status from public.quotes q where q.id = old.quote_id;
  if v_status is not null and v_status <> 'draft' then raise exception 'quote_locked' using errcode = '23514'; end if;
  return old;
end $$;
create trigger quote_items_guard_delete_trg before delete on public.quote_items
  for each row execute function app.quote_items_guard_delete();

-- Totales de la cotización: se recalculan desde las líneas.
create or replace function app.recalc_quote(p_quote uuid) returns void
language sql security definer set search_path = '' as $$
  update public.quotes q set
    subtotal = s.g, discount_total = s.d, tax_total = s.t, total = s.tot, max_discount_pct = s.m
  from (select coalesce(sum(line_gross), 0) g, coalesce(sum(line_discount), 0) d, coalesce(sum(line_tax), 0) t,
               coalesce(sum(line_total), 0) tot, coalesce(max(discount_pct), 0) m
          from public.quote_items where quote_id = p_quote) s
  where q.id = p_quote
$$;

create or replace function app.quote_items_after() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform app.recalc_quote(case when tg_op = 'DELETE' then old.quote_id else new.quote_id end);
  return null;
end $$;
create trigger quote_items_after_trg after insert or update or delete on public.quote_items
  for each row execute function app.quote_items_after();

-- ---------------------------------------------------------------------------
-- Guardas de la cotización
-- ---------------------------------------------------------------------------
create or replace function app.quotes_prepare() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    if new.org_id <> old.org_id or new.opportunity_id <> old.opportunity_id or new.number <> old.number
       or new.version <> old.version
       or (new.customer_id <> old.customer_id and current_setting('app.customer_merge', true) is distinct from 'on') then
      raise exception 'quote identity is immutable' using errcode = '23514';
    end if;
    -- Una cotización ya enviada no se edita (se revisa: nueva versión).
    if old.status <> 'draft' and current_setting('app.quote_transition', true) is distinct from 'on'
       and (new.valid_until is distinct from old.valid_until or new.notes is distinct from old.notes) then
      raise exception 'quote_locked' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
create trigger quotes_prepare_trg before insert or update on public.quotes
  for each row execute function app.quotes_prepare();
create trigger quotes_touch before update on public.quotes
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Registro genérico de cambios de estado (cotizaciones, ventas, casos)
-- ---------------------------------------------------------------------------
create or replace function app.log_status_change() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_type   text := case tg_table_name when 'quotes' then 'quote' when 'sales' then 'sale' when 'cases' then 'case' end;
  v_reason text := nullif(btrim(coalesce(current_setting('app.transition_reason', true), '')), '');
  v_src    text := coalesce(nullif(current_setting('app.transition_source', true), ''),
                            case when auth.uid() is null then 'system' else 'user' end);
begin
  if tg_op = 'INSERT' or new.status is distinct from old.status then
    insert into public.state_transitions (org_id, entity_type, entity_id, from_state, to_state, actor_id, source, reason)
    values (new.org_id, v_type, new.id, case when tg_op = 'UPDATE' then old.status end, new.status, auth.uid(), v_src, v_reason);
  end if;
  return null;
end $$;
create trigger quotes_log_status_trg after insert or update of status on public.quotes
  for each row execute function app.log_status_change();

-- El historial se ve con el mismo alcance que el registro al que pertenece.
drop policy state_transitions_select on public.state_transitions;
create policy state_transitions_select on public.state_transitions for select to authenticated
  using ((entity_type = 'opportunity' and exists (select 1 from public.opportunities o where o.id = entity_id))
      or (entity_type = 'lead'        and exists (select 1 from public.leads l where l.id = entity_id))
      or (entity_type = 'quote'       and exists (select 1 from public.quotes q where q.id = entity_id)));

-- ---------------------------------------------------------------------------
-- Las cotizaciones abiertas siguen al cliente (además de leads, oportunidades y tareas)
-- ---------------------------------------------------------------------------
create or replace function app.customers_after_update() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.owner_id is distinct from old.owner_id then
    update public.leads
       set owner_id = new.owner_id, team_id = new.team_id
     where customer_id = new.id and org_id = new.org_id and status in ('new', 'contacted', 'qualified');
    update public.opportunities
       set owner_id = new.owner_id, team_id = new.team_id
     where customer_id = new.id and org_id = new.org_id and status = 'open';
    update public.quotes
       set owner_id = new.owner_id, team_id = new.team_id
     where customer_id = new.id and org_id = new.org_id and status in ('draft', 'sent');
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

insert into app.customer_merge_targets values ('quotes');

-- ---------------------------------------------------------------------------
-- RPC de cotizaciones
-- ---------------------------------------------------------------------------
create or replace function public.create_quote(p_opportunity uuid, p_valid_until date default null, p_notes text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  o public.opportunities%rowtype;
  v_id uuid;
  v_n int;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into o from public.opportunities where id = p_opportunity;
  if not found or not app.can_access_row(o.org_id, 'opportunities:read', o.owner_id, o.team_id)
     or not app.has_permission(o.org_id, 'quotes:create') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if o.status <> 'open' then raise exception 'opportunity_closed' using errcode = '23514'; end if;
  if p_valid_until is not null and (p_valid_until < current_date or p_valid_until > current_date + 730) then
    raise exception 'date out of range' using errcode = '22023';
  end if;

  v_n := app.next_number(o.org_id, 'quote');
  insert into public.quotes (org_id, number, opportunity_id, customer_id, currency, valid_until, notes, owner_id, team_id, created_by)
  values (o.org_id, 'COT-' || lpad(v_n::text, 4, '0'), o.id, o.customer_id, o.currency,
          coalesce(p_valid_until, current_date + 15), nullif(btrim(coalesce(p_notes, '')), ''), o.owner_id, o.team_id, auth.uid())
  returning id into v_id;

  perform app.emit_event(o.org_id, 'quote.created', 'quote', v_id,
    jsonb_build_object('number', 'COT-' || lpad(v_n::text, 4, '0'), 'opportunity_id', o.id), o.customer_id);
  return v_id;
end $$;

-- Acceso de edición a una cotización (borrador + permiso + alcance).
create or replace function app.quote_for_edit(p_id uuid) returns public.quotes
language plpgsql security definer set search_path = '' as $$
declare q public.quotes%rowtype;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into q from public.quotes where id = p_id for update;
  if not found or not app.can_access_row(q.org_id, 'quotes:update', q.owner_id, q.team_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return q;
end $$;

create or replace function public.add_quote_item(
  p_quote uuid, p_product uuid default null, p_description text default null, p_quantity numeric default 1,
  p_unit_price numeric default null, p_discount_pct numeric default 0, p_tax_rate numeric default null
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  q public.quotes%rowtype;
  p public.products%rowtype;
  v_id uuid;
begin
  q := app.quote_for_edit(p_quote);
  if q.status <> 'draft' then raise exception 'quote_locked' using errcode = '23514'; end if;
  if (select count(*) from public.quote_items where quote_id = q.id) >= 100 then
    raise exception 'item limit reached' using errcode = '53400';
  end if;

  if p_product is not null then
    select * into p from public.products where id = p_product and org_id = q.org_id and active;
    if not found then raise exception 'product not found' using errcode = '22023'; end if;
  end if;
  if p_product is null and (btrim(coalesce(p_description, '')) = '' or p_unit_price is null) then
    raise exception 'name_required' using errcode = '22023';
  end if;

  insert into public.quote_items (org_id, quote_id, position, product_id, description, unit, quantity, unit_price, discount_pct, tax_rate)
  values (q.org_id, q.id,
          coalesce((select max(position) from public.quote_items where quote_id = q.id), 0) + 1,
          p_product,
          coalesce(nullif(btrim(coalesce(p_description, '')), ''), p.name),
          coalesce(p.unit, 'unidad'),
          coalesce(p_quantity, 1),
          coalesce(p_unit_price, p.unit_price),
          coalesce(p_discount_pct, 0),
          coalesce(p_tax_rate, p.tax_rate, 0))
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.update_quote_item(
  p_item uuid, p_quantity numeric, p_unit_price numeric, p_discount_pct numeric, p_description text default null
) returns void language plpgsql security definer set search_path = '' as $$
declare v_quote uuid; q public.quotes%rowtype;
begin
  select quote_id into v_quote from public.quote_items where id = p_item;
  if v_quote is null then raise exception 'not allowed' using errcode = '42501'; end if;
  q := app.quote_for_edit(v_quote);
  update public.quote_items set
    quantity = p_quantity, unit_price = p_unit_price, discount_pct = p_discount_pct,
    description = coalesce(nullif(btrim(coalesce(p_description, '')), ''), description)
  where id = p_item;
end $$;

create or replace function public.remove_quote_item(p_item uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_quote uuid; q public.quotes%rowtype;
begin
  select quote_id into v_quote from public.quote_items where id = p_item;
  if v_quote is null then raise exception 'not allowed' using errcode = '42501'; end if;
  q := app.quote_for_edit(v_quote);
  delete from public.quote_items where id = p_item;
end $$;

-- Transiciones de estado de la cotización.
create or replace function app.quote_transition(p_id uuid, p_to text, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare q public.quotes%rowtype;
begin
  q := app.quote_for_edit(p_id);

  if p_to = 'sent' then
    if q.status <> 'draft' then raise exception 'quote_not_sendable' using errcode = '23514'; end if;
    if not exists (select 1 from public.quote_items where quote_id = q.id) then
      raise exception 'quote_empty' using errcode = '23514';
    end if;
    if q.valid_until is null or q.valid_until < current_date then
      raise exception 'quote_expired' using errcode = '23514';
    end if;
    -- Descuentos altos: solo un manager/admin puede enviar (aprobación humana).
    if q.max_discount_pct > app.quote_discount_limit(q.org_id)
       and app.permission_scope(q.org_id, 'quotes:update') is distinct from 'org' then
      raise exception 'discount_requires_approval' using errcode = '42501';
    end if;
  elsif p_to = 'accepted' then
    if q.status <> 'sent' then raise exception 'quote_not_sent' using errcode = '23514'; end if;
    if q.valid_until < current_date then raise exception 'quote_expired' using errcode = '23514'; end if;
  elsif p_to = 'rejected' then
    if q.status <> 'sent' then raise exception 'quote_not_sent' using errcode = '23514'; end if;
  else
    raise exception 'invalid quote status' using errcode = '22023';
  end if;

  perform set_config('app.quote_transition', 'on', true);
  perform set_config('app.transition_reason', coalesce(p_reason, ''), true);
  update public.quotes set
    status     = p_to,
    sent_at    = case when p_to = 'sent' then now() else sent_at end,
    decided_at = case when p_to in ('accepted', 'rejected') then now() end,
    decided_by = case when p_to in ('accepted', 'rejected') then auth.uid() end
   where id = q.id;
  perform set_config('app.transition_reason', '', true);
  perform set_config('app.quote_transition', 'off', true);

  perform app.emit_event(q.org_id, 'quote.' || p_to, 'quote', q.id,
    jsonb_build_object('number', q.number, 'version', q.version, 'total', q.total, 'currency', q.currency,
                       'reason', left(nullif(btrim(coalesce(p_reason, '')), ''), 200)), q.customer_id);
end $$;

create or replace function public.send_quote(p_id uuid) returns void
language sql security definer set search_path = '' as $$ select app.quote_transition(p_id, 'sent', null) $$;
create or replace function public.accept_quote(p_id uuid) returns void
language sql security definer set search_path = '' as $$ select app.quote_transition(p_id, 'accepted', null) $$;
create or replace function public.reject_quote(p_id uuid, p_reason text default null) returns void
language sql security definer set search_path = '' as $$ select app.quote_transition(p_id, 'rejected', p_reason) $$;

-- Nueva versión: copia las líneas a un borrador v+1 y marca la anterior como «reemplazada».
create or replace function public.revise_quote(p_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare q public.quotes%rowtype; v_new uuid;
begin
  q := app.quote_for_edit(p_id);
  if q.status not in ('sent', 'rejected') then raise exception 'quote_not_revisable' using errcode = '23514'; end if;
  if not app.has_permission(q.org_id, 'quotes:create') then raise exception 'not allowed' using errcode = '42501'; end if;
  if exists (select 1 from public.opportunities o where o.id = q.opportunity_id and o.status <> 'open') then
    raise exception 'opportunity_closed' using errcode = '23514';
  end if;

  perform set_config('app.quote_transition', 'on', true);
  perform set_config('app.transition_reason', 'Nueva versión', true);
  update public.quotes set status = 'superseded' where id = q.id;
  perform set_config('app.transition_reason', '', true);
  perform set_config('app.quote_transition', 'off', true);

  insert into public.quotes (org_id, number, version, opportunity_id, customer_id, currency, valid_until, notes,
                             owner_id, team_id, parent_quote_id, created_by)
  values (q.org_id, q.number, q.version + 1, q.opportunity_id, q.customer_id, q.currency,
          greatest(coalesce(q.valid_until, current_date), current_date + 15), q.notes, q.owner_id, q.team_id, q.id, auth.uid())
  returning id into v_new;

  insert into public.quote_items (org_id, quote_id, position, product_id, description, unit, quantity, unit_price, discount_pct, tax_rate)
  select org_id, v_new, position, product_id, description, unit, quantity, unit_price, discount_pct, tax_rate
    from public.quote_items where quote_id = q.id order by position;

  perform app.emit_event(q.org_id, 'quote.created', 'quote', v_new,
    jsonb_build_object('number', q.number, 'version', q.version + 1, 'opportunity_id', q.opportunity_id), q.customer_id);
  return v_new;
end $$;

-- ---------------------------------------------------------------------------
-- Privilegios + RLS + auditoría
-- ---------------------------------------------------------------------------
revoke all on public.products, public.quotes, public.quote_items from anon, authenticated;
grant select on public.products, public.quotes, public.quote_items to authenticated;
grant insert (org_id, kind, sku, name, description, unit, unit_price, tax_rate, active) on public.products to authenticated;
grant update (sku, name, description, unit, unit_price, tax_rate, active) on public.products to authenticated;
grant update (valid_until, notes) on public.quotes to authenticated;
grant all on public.products, public.quotes, public.quote_items to service_role;

alter table public.products    enable row level security;
alter table public.quotes      enable row level security;
alter table public.quote_items enable row level security;

create policy products_select on public.products for select to authenticated
  using ((select app.has_permission(org_id, 'products:read')));
create policy products_insert on public.products for insert to authenticated
  with check ((select app.has_permission(org_id, 'products:create')));
create policy products_update on public.products for update to authenticated
  using ((select app.has_permission(org_id, 'products:update')))
  with check ((select app.has_permission(org_id, 'products:update')));

create policy quotes_select on public.quotes for select to authenticated
  using ((select app.can_access_row(org_id, 'quotes:read', owner_id, team_id)));
create policy quotes_update on public.quotes for update to authenticated
  using ((select app.can_access_row(org_id, 'quotes:update', owner_id, team_id)))
  with check ((select app.can_access_row(org_id, 'quotes:update', owner_id, team_id)));

-- Las líneas se ven con el mismo alcance que su cotización (RLS de quotes aplica en el subquery).
create policy quote_items_select on public.quote_items for select to authenticated
  using (exists (select 1 from public.quotes q where q.id = quote_id));

create trigger products_audit    after insert or update or delete on public.products    for each row execute function app.audit_row_change();
create trigger quotes_audit      after insert or update or delete on public.quotes      for each row execute function app.audit_row_change();
create trigger quote_items_audit after insert or update or delete on public.quote_items for each row execute function app.audit_row_change();

revoke all on function app.next_number(uuid, text), app.quote_discount_limit(uuid), app.products_prepare(),
  app.quote_items_prepare(), app.quote_items_guard_delete(), app.recalc_quote(uuid), app.quote_items_after(),
  app.quotes_prepare(), app.log_status_change(), app.customers_after_update(), app.quote_for_edit(uuid),
  app.quote_transition(uuid, text, text) from public, anon, authenticated;

revoke all on function public.create_quote(uuid, date, text),
  public.add_quote_item(uuid, uuid, text, numeric, numeric, numeric, numeric),
  public.update_quote_item(uuid, numeric, numeric, numeric, text), public.remove_quote_item(uuid),
  public.send_quote(uuid), public.accept_quote(uuid), public.reject_quote(uuid, text), public.revise_quote(uuid)
  from public, anon;
grant execute on function public.create_quote(uuid, date, text),
  public.add_quote_item(uuid, uuid, text, numeric, numeric, numeric, numeric),
  public.update_quote_item(uuid, numeric, numeric, numeric, text), public.remove_quote_item(uuid),
  public.send_quote(uuid), public.accept_quote(uuid), public.reject_quote(uuid, text), public.revise_quote(uuid)
  to authenticated, service_role;


-- ---------------- 20260919000012_sales_postsale.sql ----------------
-- =============================================================================
-- 0012 VENTAS Y POSTVENTA
-- =============================================================================
--   * Una venta nace SOLO de una cotización ACEPTADA y guarda una FOTO inmutable de ella
--     (líneas, precios, IVA, totales): nada posterior (catálogo, nuevas versiones) la altera.
--   * Registrar la venta cierra la oportunidad como ganada y abre el seguimiento postventa
--     (confirmar entrega, satisfacción, recompra) como tareas del responsable.
--   * Una cotización no puede tener dos ventas activas (ni con llamadas simultáneas).
--   * Anular una venta es cosa de manager/admin y exige motivo.
--   * Casos de soporte/reclamo/garantía con estados y su historial.
--   * Todo pasa por RPC: ningún estado ni monto es escribible directamente.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- sales + sale_items
-- ---------------------------------------------------------------------------
create table public.sales (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organizations(id) on delete cascade,
  number         text not null,
  customer_id    uuid not null,
  opportunity_id uuid not null,
  quote_id       uuid not null,
  status         text not null default 'confirmed' check (status in ('confirmed', 'delivered', 'cancelled')),
  currency       text check (currency ~ '^[A-Z]{3}$'),
  subtotal       numeric(14, 2) not null,
  discount_total numeric(14, 2) not null,
  tax_total      numeric(14, 2) not null,
  total          numeric(14, 2) not null,
  sold_at        timestamptz not null default now(),
  delivered_at   timestamptz,
  cancelled_at   timestamptz,
  cancel_reason  text check (char_length(cancel_reason) <= 500),
  owner_id       uuid references auth.users(id) on delete set null,
  team_id        uuid,
  sold_by        uuid references auth.users(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (id, org_id),
  unique (org_id, number),
  foreign key (customer_id, org_id)    references public.customers (id, org_id),
  foreign key (opportunity_id, org_id) references public.opportunities (id, org_id),
  foreign key (quote_id, org_id)       references public.quotes (id, org_id),
  foreign key (team_id, org_id)        references public.teams (id, org_id) on delete set null (team_id),
  check ((status = 'cancelled') = (cancelled_at is not null)),
  check ((status = 'delivered') = (delivered_at is not null) or status = 'cancelled')
);
-- Una sola venta ACTIVA por cotización.
create unique index sales_one_active_per_quote_uk on public.sales (quote_id) where status <> 'cancelled';
create index sales_customer_idx    on public.sales (customer_id);
create index sales_opportunity_idx on public.sales (opportunity_id);
create index sales_org_sold_idx    on public.sales (org_id, sold_at desc, id desc);

create table public.sale_items (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id) on delete cascade,
  sale_id       uuid not null,
  position      int  not null,
  product_id    uuid,
  description   text not null,
  unit          text not null,
  quantity      numeric(12, 3) not null,
  unit_price    numeric(14, 2) not null,
  discount_pct  numeric(5, 2)  not null,
  tax_rate      numeric(5, 2)  not null,
  line_gross    numeric(14, 2) not null,
  line_discount numeric(14, 2) not null,
  line_tax      numeric(14, 2) not null,
  line_total    numeric(14, 2) not null,
  created_at    timestamptz not null default now(),
  foreign key (sale_id, org_id)    references public.sales (id, org_id) on delete cascade,
  foreign key (product_id, org_id) references public.products (id, org_id)
);
create index sale_items_sale_idx on public.sale_items (sale_id, position);

-- La foto de la venta es inmutable (solo se admite la cascada al eliminar la organización).
create or replace function app.sale_items_immutable() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'TRUNCATE' then raise exception 'sale items are immutable' using errcode = '42501'; end if;
  if tg_op = 'DELETE' and not exists (select 1 from public.organizations where id = old.org_id) then return old; end if;
  raise exception 'sale items are immutable' using errcode = '42501';
end $$;
create trigger sale_items_no_mutation before update or delete on public.sale_items
  for each row execute function app.sale_items_immutable();
create trigger sale_items_no_truncate before truncate on public.sale_items
  for each statement execute function app.sale_items_immutable();

create or replace function app.sales_prepare() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.org_id <> old.org_id or new.number <> old.number or new.opportunity_id <> old.opportunity_id
     or new.quote_id <> old.quote_id or new.currency is distinct from old.currency
     or new.subtotal <> old.subtotal or new.discount_total <> old.discount_total
     or new.tax_total <> old.tax_total or new.total <> old.total or new.sold_at <> old.sold_at
     or (new.customer_id <> old.customer_id and current_setting('app.customer_merge', true) is distinct from 'on') then
    raise exception 'a sale is immutable' using errcode = '23514';
  end if;
  if new.status <> old.status and current_setting('app.sale_transition', true) is distinct from 'on' then
    raise exception 'sale status changes only through its functions' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger sales_prepare_trg before update on public.sales
  for each row execute function app.sales_prepare();
create trigger sales_touch before update on public.sales
  for each row execute function app.touch_updated_at();
create trigger sales_log_status_trg after insert or update of status on public.sales
  for each row execute function app.log_status_change();

-- ---------------------------------------------------------------------------
-- Casos de postventa (soporte, reclamos, garantías, devoluciones)
-- ---------------------------------------------------------------------------
create table public.cases (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  number      text not null,
  customer_id uuid not null,
  sale_id     uuid,
  kind        text not null default 'support' check (kind in ('support', 'complaint', 'warranty', 'return', 'question')),
  priority    text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  status      text not null default 'open' check (status in ('open', 'in_progress', 'resolved', 'closed')),
  title       text not null check (char_length(btrim(title)) between 1 and 160),
  description text check (char_length(description) <= 2000),
  resolution  text check (char_length(resolution) <= 2000),
  assignee_id uuid references auth.users(id) on delete set null,
  team_id     uuid,
  created_by  uuid references auth.users(id) on delete set null,
  resolved_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (id, org_id),
  unique (org_id, number),
  foreign key (customer_id, org_id) references public.customers (id, org_id),
  foreign key (sale_id, org_id)     references public.sales (id, org_id),
  foreign key (team_id, org_id)     references public.teams (id, org_id) on delete set null (team_id),
  check ((status in ('resolved', 'closed')) = (resolution is not null))
);
create index cases_customer_idx on public.cases (customer_id);
create index cases_assignee_idx on public.cases (org_id, assignee_id, status);

create or replace function app.cases_prepare() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); v_team uuid; v_scope public.permission_scope;
begin
  new.title := btrim(new.title);
  if tg_op = 'UPDATE' and (new.org_id <> old.org_id or new.number <> old.number or new.sale_id is distinct from old.sale_id
      or (new.customer_id <> old.customer_id and current_setting('app.customer_merge', true) is distinct from 'on')) then
    raise exception 'case links are immutable' using errcode = '23514';
  end if;
  if tg_op = 'INSERT' or new.assignee_id is distinct from old.assignee_id then
    if new.assignee_id is null then
      new.team_id := null;
    else
      select m.team_id into v_team from public.memberships m
       where m.org_id = new.org_id and m.user_id = new.assignee_id and m.status = 'active';
      if not found then raise exception 'assignee must be an active member of the organization' using errcode = '23514'; end if;
      new.team_id := v_team;
    end if;
    if tg_op = 'UPDATE' and v_uid is not null then
      v_scope := app.permission_scope(new.org_id, 'cases:update');
      if v_scope is distinct from 'org'
         and not (v_scope = 'team' and new.team_id is not null and new.team_id = app.my_team_id(new.org_id)) then
        raise exception 'only managers can reassign cases' using errcode = '42501';
      end if;
    end if;
  end if;
  if tg_op = 'UPDATE' and new.status <> old.status and current_setting('app.case_transition', true) is distinct from 'on' then
    raise exception 'case status changes only through its functions' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger cases_prepare_trg before insert or update on public.cases
  for each row execute function app.cases_prepare();
create trigger cases_touch before update on public.cases
  for each row execute function app.touch_updated_at();
create trigger cases_log_status_trg after insert or update of status on public.cases
  for each row execute function app.log_status_change();

insert into app.customer_merge_targets values ('sales'), ('cases');

-- El historial de ventas y casos se ve con el alcance del registro.
drop policy state_transitions_select on public.state_transitions;
create policy state_transitions_select on public.state_transitions for select to authenticated
  using ((entity_type = 'opportunity' and exists (select 1 from public.opportunities o where o.id = entity_id))
      or (entity_type = 'lead'        and exists (select 1 from public.leads l where l.id = entity_id))
      or (entity_type = 'quote'       and exists (select 1 from public.quotes q where q.id = entity_id))
      or (entity_type = 'sale'        and exists (select 1 from public.sales s where s.id = entity_id))
      or (entity_type = 'case'        and exists (select 1 from public.cases c where c.id = entity_id)));

-- ---------------------------------------------------------------------------
-- create_sale: de una cotización ACEPTADA (atómico: venta + foto + oportunidad ganada + postventa)
-- ---------------------------------------------------------------------------
create or replace function public.create_sale(p_quote uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  q public.quotes%rowtype;
  o public.opportunities%rowtype;
  c public.customers%rowtype;
  v_won uuid;
  v_id uuid;
  v_number text;
  v_note text;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;

  select * into q from public.quotes where id = p_quote for update;
  if not found or not app.can_access_row(q.org_id, 'sales:create', q.owner_id, q.team_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if q.status <> 'accepted' then raise exception 'quote_not_accepted' using errcode = '23514'; end if;
  if exists (select 1 from public.sales s where s.quote_id = q.id and s.status <> 'cancelled') then
    raise exception 'sale_already_exists' using errcode = '23505';
  end if;

  select * into o from public.opportunities where id = q.opportunity_id for update;
  if o.status = 'lost' then raise exception 'opportunity_closed' using errcode = '23514'; end if;
  select * into c from public.customers where id = q.customer_id;

  v_number := 'VTA-' || lpad(app.next_number(q.org_id, 'sale')::text, 4, '0');
  insert into public.sales (org_id, number, customer_id, opportunity_id, quote_id, currency,
                            subtotal, discount_total, tax_total, total, owner_id, team_id, sold_by)
  values (q.org_id, v_number, q.customer_id, q.opportunity_id, q.id, q.currency,
          q.subtotal, q.discount_total, q.tax_total, q.total, q.owner_id, q.team_id, auth.uid())
  returning id into v_id;

  insert into public.sale_items (org_id, sale_id, position, product_id, description, unit, quantity, unit_price,
                                 discount_pct, tax_rate, line_gross, line_discount, line_tax, line_total)
  select org_id, v_id, position, product_id, description, unit, quantity, unit_price,
         discount_pct, tax_rate, line_gross, line_discount, line_tax, line_total
    from public.quote_items where quote_id = q.id order by position;

  -- La oportunidad se cierra como ganada por el valor neto (sin impuestos) de lo vendido.
  if o.status = 'open' then
    select s.id into v_won from public.pipeline_stages s
     where s.pipeline_id = o.pipeline_id and s.kind = 'won' and s.archived_at is null order by s.position limit 1;
    if v_won is null then raise exception 'pipeline has no won stage' using errcode = '22023'; end if;
    perform set_config('app.transition_reason', 'Venta ' || v_number, true);
    perform set_config('app.transition_source', 'system', true);
    update public.opportunities set stage_id = v_won, amount = q.subtotal - q.discount_total where id = o.id;
    perform set_config('app.transition_reason', '', true);
    perform set_config('app.transition_source', '', true);
  end if;

  -- Seguimiento postventa: tareas del responsable (o sin asignar si el cliente no tiene dueño).
  v_note := 'Seguimiento postventa de ' || v_number
            || case when c.do_not_contact then E'\nATENCIÓN: el cliente pidió no ser contactado.' else '' end;
  insert into public.tasks (org_id, title, description, type, due_at, assignee_id, opportunity_id, created_by) values
    (q.org_id, 'Confirmar la entrega con ' || c.full_name,           v_note, 'call',      now() + interval '3 days',  q.owner_id, o.id, auth.uid()),
    (q.org_id, 'Encuesta de satisfacción a ' || c.full_name,         v_note, 'follow_up', now() + interval '10 days', q.owner_id, o.id, auth.uid()),
    (q.org_id, 'Ofrecer recompra o renovación a ' || c.full_name,    v_note, 'follow_up', now() + interval '60 days', q.owner_id, o.id, auth.uid());

  perform app.emit_event(q.org_id, 'sale.created', 'sale', v_id,
    jsonb_build_object('number', v_number, 'total', q.total, 'currency', q.currency, 'quote_number', q.number), q.customer_id);
  return v_id;
end $$;

create or replace function app.sale_transition(p_id uuid, p_to text, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare s public.sales%rowtype;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into s from public.sales where id = p_id for update;
  if not found or not app.can_access_row(s.org_id, 'sales:update', s.owner_id, s.team_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  if p_to = 'delivered' then
    if s.status <> 'confirmed' then raise exception 'sale_not_confirmed' using errcode = '23514'; end if;
  elsif p_to = 'cancelled' then
    if s.status = 'cancelled' then raise exception 'sale_already_cancelled' using errcode = '23514'; end if;
    -- Anular dinero ya registrado: solo manager/admin, y con motivo.
    if app.permission_scope(s.org_id, 'sales:update') is distinct from 'org' then
      raise exception 'only managers can cancel sales' using errcode = '42501';
    end if;
    if char_length(btrim(coalesce(p_reason, ''))) < 3 then raise exception 'reason_required' using errcode = '23514'; end if;
  else
    raise exception 'invalid sale status' using errcode = '22023';
  end if;

  perform set_config('app.sale_transition', 'on', true);
  perform set_config('app.transition_reason', coalesce(p_reason, ''), true);
  update public.sales set
    status        = p_to,
    delivered_at  = case when p_to = 'delivered' then now() else delivered_at end,
    cancelled_at  = case when p_to = 'cancelled' then now() end,
    cancel_reason = case when p_to = 'cancelled' then left(btrim(p_reason), 500) end
   where id = s.id;
  perform set_config('app.transition_reason', '', true);
  perform set_config('app.sale_transition', 'off', true);

  if p_to = 'cancelled' then
    -- El seguimiento pendiente de una venta anulada deja de tener sentido.
    update public.tasks set status = 'cancelled', outcome = 'Venta anulada'
     where org_id = s.org_id and opportunity_id = s.opportunity_id and status = 'open'
       and description like 'Seguimiento postventa de ' || s.number || '%';
  end if;

  perform app.emit_event(s.org_id, 'sale.' || p_to, 'sale', s.id,
    jsonb_build_object('number', s.number, 'total', s.total, 'reason', left(nullif(btrim(coalesce(p_reason, '')), ''), 200)), s.customer_id);
end $$;

create or replace function public.mark_sale_delivered(p_id uuid) returns void
language sql security definer set search_path = '' as $$ select app.sale_transition(p_id, 'delivered', null) $$;
create or replace function public.cancel_sale(p_id uuid, p_reason text) returns void
language sql security definer set search_path = '' as $$ select app.sale_transition(p_id, 'cancelled', p_reason) $$;

-- ---------------------------------------------------------------------------
-- Casos
-- ---------------------------------------------------------------------------
create or replace function public.open_case(
  p_org uuid, p_customer uuid, p_title text, p_kind text default 'support', p_description text default null,
  p_priority text default 'normal', p_sale uuid default null, p_assignee uuid default null
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  c public.customers%rowtype;
  s public.sales%rowtype;
  v_asg uuid;
  v_team uuid;
  v_scope public.permission_scope;
  v_id uuid;
  v_n int;
begin
  if v_uid is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not app.has_permission(p_org, 'cases:create') then raise exception 'not allowed' using errcode = '42501'; end if;
  if btrim(coalesce(p_title, '')) = '' then raise exception 'name_required' using errcode = '22023'; end if;

  select * into c from public.customers where id = p_customer and org_id = p_org and deleted_at is null;
  if not found or not app.can_access_row(c.org_id, 'customers:read', c.owner_id, c.team_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_sale is not null then
    select * into s from public.sales where id = p_sale and org_id = p_org;
    if not found or not app.can_access_row(s.org_id, 'sales:read', s.owner_id, s.team_id) then
      raise exception 'not allowed' using errcode = '42501';
    end if;
    if s.customer_id <> p_customer then raise exception 'sale belongs to another customer' using errcode = '22023'; end if;
  end if;

  v_asg := coalesce(p_assignee, v_uid);
  if v_asg <> v_uid then
    v_scope := app.permission_scope(p_org, 'cases:create');
    select m.team_id into v_team from public.memberships m where m.org_id = p_org and m.user_id = v_asg and m.status = 'active';
    if v_scope is distinct from 'org' and not (v_scope = 'team' and v_team is not null and v_team = app.my_team_id(p_org)) then
      raise exception 'only managers can assign cases to others' using errcode = '42501';
    end if;
  end if;

  v_n := app.next_number(p_org, 'case');
  insert into public.cases (org_id, number, customer_id, sale_id, kind, priority, title, description, assignee_id, created_by)
  values (p_org, 'CAS-' || lpad(v_n::text, 4, '0'), p_customer, p_sale, coalesce(p_kind, 'support'), coalesce(p_priority, 'normal'),
          p_title, nullif(btrim(coalesce(p_description, '')), ''), v_asg, v_uid)
  returning id into v_id;

  perform app.emit_event(p_org, 'case.opened', 'case', v_id,
    jsonb_build_object('number', 'CAS-' || lpad(v_n::text, 4, '0'), 'title', left(btrim(p_title), 160), 'kind', coalesce(p_kind, 'support')), p_customer);
  return v_id;
end $$;

create or replace function public.set_case_status(p_id uuid, p_to text, p_note text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare c public.cases%rowtype; v_ok boolean;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into c from public.cases where id = p_id for update;
  if not found or not app.can_access_row(c.org_id, 'cases:update', c.assignee_id, c.team_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  v_ok := (c.status = 'open'        and p_to in ('in_progress', 'resolved'))
       or (c.status = 'in_progress' and p_to in ('resolved', 'open'))
       or (c.status = 'resolved'    and p_to in ('closed', 'open'))
       or (c.status = 'closed'      and p_to = 'open');
  if not v_ok then raise exception 'invalid_transition: % -> %', c.status, p_to using errcode = '23514'; end if;
  if c.status = 'closed' and app.permission_scope(c.org_id, 'cases:update') is distinct from 'org' then
    raise exception 'only managers can reopen a closed case' using errcode = '42501';
  end if;
  if p_to = 'resolved' and char_length(btrim(coalesce(p_note, ''))) < 3 then
    raise exception 'reason_required' using errcode = '23514';    -- la solución es obligatoria
  end if;

  perform set_config('app.case_transition', 'on', true);
  perform set_config('app.transition_reason', coalesce(p_note, ''), true);
  update public.cases set
    status      = p_to,
    resolution  = case when p_to = 'resolved' then left(btrim(p_note), 2000)
                       when p_to = 'closed' then resolution else null end,
    resolved_at = case when p_to = 'resolved' then now() when p_to = 'closed' then resolved_at else null end
   where id = c.id;
  perform set_config('app.transition_reason', '', true);
  perform set_config('app.case_transition', 'off', true);

  perform app.emit_event(c.org_id, 'case.status_changed', 'case', c.id,
    jsonb_build_object('number', c.number, 'from', c.status, 'to', p_to), c.customer_id);
end $$;

-- ---------------------------------------------------------------------------
-- Privilegios + RLS + auditoría
-- ---------------------------------------------------------------------------
revoke all on public.sales, public.sale_items, public.cases from anon, authenticated;
grant select on public.sales, public.sale_items, public.cases to authenticated;
grant update (title, description, priority, assignee_id) on public.cases to authenticated;
grant all on public.sales, public.sale_items, public.cases to service_role;

alter table public.sales      enable row level security;
alter table public.sale_items enable row level security;
alter table public.cases      enable row level security;

create policy sales_select on public.sales for select to authenticated
  using ((select app.can_access_row(org_id, 'sales:read', owner_id, team_id)));
create policy sale_items_select on public.sale_items for select to authenticated
  using (exists (select 1 from public.sales s where s.id = sale_id));
create policy cases_select on public.cases for select to authenticated
  using ((select app.can_access_row(org_id, 'cases:read', assignee_id, team_id)));
create policy cases_update on public.cases for update to authenticated
  using ((select app.can_access_row(org_id, 'cases:update', assignee_id, team_id)))
  with check ((select app.permission_scope(org_id, 'cases:update')) is not null);

create trigger sales_audit      after insert or update or delete on public.sales      for each row execute function app.audit_row_change();
create trigger sale_items_audit after insert on public.sale_items                     for each row execute function app.audit_row_change();
create trigger cases_audit      after insert or update or delete on public.cases      for each row execute function app.audit_row_change();

revoke all on function app.sale_items_immutable(), app.sales_prepare(), app.cases_prepare(),
  app.sale_transition(uuid, text, text) from public, anon, authenticated;

revoke all on function public.create_sale(uuid), public.mark_sale_delivered(uuid), public.cancel_sale(uuid, text),
  public.open_case(uuid, uuid, text, text, text, text, uuid, uuid), public.set_case_status(uuid, text, text)
  from public, anon;
grant execute on function public.create_sale(uuid), public.mark_sale_delivered(uuid), public.cancel_sale(uuid, text),
  public.open_case(uuid, uuid, text, text, text, text, uuid, uuid), public.set_case_status(uuid, text, text)
  to authenticated, service_role;


-- ---------------- 20260919000013_inbox_whatsapp.sql ----------------
-- =============================================================================
-- 0013 INBOX OMNICANAL (WhatsApp Cloud API)
-- =============================================================================
-- Flujo: webhook firmado → raw_events (durable) → normalización → resolución de identidad
--        → conversación → mensaje. Envío: cola en BD → reclamo atómico → API de Meta.
-- Reglas que viven en la base de datos:
--   * Un mensaje entrante se registra UNA sola vez (dedupe por id externo), aunque Meta reintente
--     o lleguen en paralelo.
--   * Un contacto nuevo nace como cliente + lead (misma resolución de identidad de la Fase 2).
--   * Solo se envía texto libre dentro de las 24 h posteriores al último mensaje del cliente;
--     fuera de esa ventana, solo plantillas aprobadas.
--   * «No contactar»: bloquea plantillas y mensajes proactivos; solo se permite RESPONDER dentro
--     de la ventana a un cliente que acaba de escribir.
--   * Los mensajes son de solo-anexar; los estados solo avanzan (enviado → entregado → leído).
--   * Envío «como máximo una vez»: un mensaje con resultado desconocido NO se reenvía solo.
--   * Los tokens de acceso están en una tabla que ningún usuario (ni admin) puede leer.
--   * Solo lo que Meta firmó con el App Secret entra (verificado en el servidor, antes de esto).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Canales y credenciales
-- ---------------------------------------------------------------------------
create table public.channels (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id) on delete cascade,
  kind          text not null default 'whatsapp' check (kind in ('whatsapp')),
  name          text not null check (char_length(btrim(name)) between 1 and 80),
  external_id   text not null check (external_id ~ '^[0-9]{5,30}$'),          -- phone_number_id de Meta
  display_phone text check (char_length(display_phone) <= 30),
  status        text not null default 'active' check (status in ('active', 'paused')),
  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (id, org_id),
  unique (kind, external_id)          -- el webhook se enruta por este id: no puede repetirse entre organizaciones
);

create table public.channel_secrets (
  channel_id   uuid primary key references public.channels(id) on delete cascade,
  access_token text not null check (char_length(access_token) between 20 and 2000),
  updated_at   timestamptz not null default now(),
  updated_by   uuid references auth.users(id) on delete set null
);

create table public.message_templates (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  channel_id  uuid not null,
  name        text not null check (name ~ '^[a-z0-9_]{1,200}$'),                -- nombre en Meta
  language    text not null check (language ~ '^[a-z]{2,3}(_[A-Z]{2})?$'),      -- es, es_CO, en_US
  body        text not null check (char_length(btrim(body)) between 1 and 1024),
  param_count int  not null default 0,
  status      text not null default 'approved' check (status in ('approved', 'disabled')),
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (id, org_id),
  unique (channel_id, name, language),
  foreign key (channel_id, org_id) references public.channels (id, org_id) on delete cascade
);

-- Los marcadores deben ser {{1}}, {{2}}… sin saltos (así los exige Meta).
create or replace function app.message_templates_prepare() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_max int; v_cnt int;
begin
  select coalesce(max(n), 0), count(distinct n) into v_max, v_cnt
    from (select (m[1])::int as n from regexp_matches(new.body, '\{\{(\d{1,2})\}\}', 'g') m) x;
  if v_max > 10 or v_cnt <> v_max then
    raise exception 'template_placeholders' using errcode = '23514';
  end if;
  new.param_count := v_max;
  new.body := btrim(new.body);
  return new;
end $$;
create trigger message_templates_prepare_trg before insert or update on public.message_templates
  for each row execute function app.message_templates_prepare();
create trigger channels_touch before update on public.channels for each row execute function app.touch_updated_at();
create trigger message_templates_touch before update on public.message_templates for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Conversaciones y mensajes
-- ---------------------------------------------------------------------------
create table public.conversations (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null references public.organizations(id) on delete cascade,
  channel_id           uuid not null,
  customer_id          uuid not null,
  thread_key           text not null check (thread_key ~ '^[0-9]{6,20}$'),     -- wa_id del contacto
  contact_name         text check (char_length(contact_name) <= 160),
  status               text not null default 'open' check (status in ('open', 'closed')),
  owner_id             uuid references auth.users(id) on delete set null,       -- sigue al dueño del cliente
  team_id              uuid,
  last_message_at      timestamptz,
  last_inbound_at      timestamptz,
  last_message_preview text check (char_length(last_message_preview) <= 140),
  last_direction       text check (last_direction in ('inbound', 'outbound')),
  needs_reply          boolean not null default false,
  unread               boolean not null default false,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (id, org_id),
  unique (channel_id, thread_key),
  foreign key (channel_id, org_id)  references public.channels (id, org_id),
  foreign key (customer_id, org_id) references public.customers (id, org_id),
  foreign key (team_id, org_id)     references public.teams (id, org_id) on delete set null (team_id)
);
create index conversations_inbox_idx    on public.conversations (org_id, last_message_at desc nulls last, id desc);
create index conversations_customer_idx on public.conversations (customer_id);
create index conversations_reply_idx    on public.conversations (org_id, needs_reply) where needs_reply;

create table public.messages (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organizations(id) on delete cascade,
  channel_id      uuid not null,
  conversation_id uuid not null,
  direction       text not null check (direction in ('inbound', 'outbound')),
  kind            text not null default 'text' check (kind in ('text', 'template', 'media', 'other')),
  body            text not null check (char_length(body) between 1 and 4096),
  external_id     text check (char_length(external_id) <= 200),                 -- wamid
  status          text not null check (status in ('received', 'queued', 'sending', 'sent', 'delivered', 'read', 'failed')),
  error_code      text check (char_length(error_code) <= 40),
  error           text check (char_length(error) <= 300),
  attempts        int not null default 0,
  template_id     uuid,
  template_params jsonb,
  sent_by         uuid references auth.users(id) on delete set null,
  occurred_at     timestamptz not null,
  created_at      timestamptz not null default clock_timestamp(),
  meta            jsonb not null default '{}'::jsonb,
  foreign key (channel_id, org_id)      references public.channels (id, org_id),
  foreign key (conversation_id, org_id) references public.conversations (id, org_id) on delete cascade,
  foreign key (template_id, org_id)     references public.message_templates (id, org_id),
  check ((direction = 'inbound') = (status = 'received'))
);
-- Deduplicación: el mismo id externo no se registra dos veces en un canal.
create unique index messages_external_uk on public.messages (channel_id, external_id) where external_id is not null;
create index messages_conversation_idx on public.messages (conversation_id, occurred_at, created_at);
create index messages_queue_idx on public.messages (created_at) where status in ('queued', 'sending');

-- Solo-anexar: el contenido no cambia y nada se borra (salvo al eliminar la organización).
create or replace function app.messages_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'TRUNCATE' then raise exception 'messages are append-only' using errcode = '42501'; end if;
  if tg_op = 'DELETE' then
    if not exists (select 1 from public.organizations where id = old.org_id) then return old; end if;
    raise exception 'messages are append-only' using errcode = '42501';
  end if;
  if new.org_id <> old.org_id or new.channel_id <> old.channel_id or new.conversation_id <> old.conversation_id
     or new.direction <> old.direction or new.kind <> old.kind or new.body <> old.body
     or new.template_id is distinct from old.template_id or new.template_params is distinct from old.template_params
     or new.sent_by is distinct from old.sent_by or new.occurred_at <> old.occurred_at
     or (old.external_id is not null and new.external_id is distinct from old.external_id) then
    raise exception 'messages are immutable' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger messages_guard_trg before update or delete on public.messages
  for each row execute function app.messages_guard();
create trigger messages_no_truncate before truncate on public.messages
  for each statement execute function app.messages_guard();

create or replace function app.conversations_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.org_id <> old.org_id or new.channel_id <> old.channel_id or new.thread_key <> old.thread_key
     or (new.customer_id <> old.customer_id and current_setting('app.customer_merge', true) is distinct from 'on') then
    raise exception 'conversation identity is immutable' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger conversations_guard_trg before update on public.conversations
  for each row execute function app.conversations_guard();
create trigger conversations_touch before update on public.conversations
  for each row execute function app.touch_updated_at();

insert into app.customer_merge_targets values ('conversations');

-- Las conversaciones siguen al cliente (abiertas y cerradas: son su historial).
create or replace function app.customers_after_update() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.owner_id is distinct from old.owner_id then
    update public.leads
       set owner_id = new.owner_id, team_id = new.team_id
     where customer_id = new.id and org_id = new.org_id and status in ('new', 'contacted', 'qualified');
    update public.opportunities
       set owner_id = new.owner_id, team_id = new.team_id
     where customer_id = new.id and org_id = new.org_id and status = 'open';
    update public.quotes
       set owner_id = new.owner_id, team_id = new.team_id
     where customer_id = new.id and org_id = new.org_id and status in ('draft', 'sent');
    update public.conversations
       set owner_id = new.owner_id, team_id = new.team_id
     where customer_id = new.id and org_id = new.org_id;
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
-- Cola de webhooks (durable) — solo el servidor la toca
-- ---------------------------------------------------------------------------
create table public.raw_events (
  id              bigint generated always as identity primary key,
  provider        text not null default 'meta',
  payload         jsonb not null,
  status          text not null default 'pending' check (status in ('pending', 'processed', 'failed')),
  attempts        int not null default 0,
  last_attempt_at timestamptz,
  last_error      text check (char_length(last_error) <= 300),
  received_at     timestamptz not null default now(),
  processed_at    timestamptz
);
create index raw_events_pending_idx on public.raw_events (received_at) where status = 'pending';

-- ---------------------------------------------------------------------------
-- Utilidades internas
-- ---------------------------------------------------------------------------
create or replace function app.render_template(p_body text, p_params text[]) returns text
language plpgsql immutable set search_path = '' as $$
declare v text := p_body; i int;
begin
  for i in 1 .. coalesce(array_length(p_params, 1), 0) loop
    v := replace(v, '{{' || i || '}}', p_params[i]);
  end loop;
  return v;
end $$;

create or replace function app.message_rank(p_status text) returns int
language sql immutable set search_path = '' as $$
  select case p_status when 'queued' then 0 when 'sending' then 1 when 'sent' then 2 when 'delivered' then 3 when 'read' then 4 else -1 end
$$;

-- ---------------------------------------------------------------------------
-- Gestión de canales (solo quien tiene settings:manage)
-- ---------------------------------------------------------------------------
create or replace function public.create_channel(
  p_org uuid, p_name text, p_external_id text, p_display_phone text default null, p_access_token text default null
) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not app.has_permission(p_org, 'settings:manage') then raise exception 'not allowed' using errcode = '42501'; end if;
  insert into public.channels (org_id, name, external_id, display_phone, created_by)
  values (p_org, btrim(p_name), btrim(p_external_id), nullif(btrim(coalesce(p_display_phone, '')), ''), auth.uid())
  returning id into v_id;
  if p_access_token is not null and btrim(p_access_token) <> '' then
    insert into public.channel_secrets (channel_id, access_token, updated_by) values (v_id, btrim(p_access_token), auth.uid());
  end if;
  perform app.emit_event(p_org, 'channel.created', 'channel', v_id, jsonb_build_object('name', btrim(p_name)), null);
  return v_id;
end $$;

create or replace function public.save_channel_token(p_channel uuid, p_token text) returns void
language plpgsql security definer set search_path = '' as $$
declare c public.channels%rowtype;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into c from public.channels where id = p_channel;
  if not found or not app.has_permission(c.org_id, 'settings:manage') then raise exception 'not allowed' using errcode = '42501'; end if;
  insert into public.channel_secrets (channel_id, access_token, updated_by) values (p_channel, btrim(p_token), auth.uid())
  on conflict (channel_id) do update set access_token = excluded.access_token, updated_at = now(), updated_by = auth.uid();
  -- El evento NO incluye el token.
  perform app.emit_event(c.org_id, 'channel.token_updated', 'channel', c.id, '{}'::jsonb, null);
end $$;

-- Solo responde SI hay token (nunca cuál): para mostrar «configurado / falta» sin exponer el secreto.
create or replace function public.channel_token_status(p_org uuid)
returns table (channel_id uuid, has_token boolean) language plpgsql security definer stable set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not app.has_permission(p_org, 'settings:manage') then raise exception 'not allowed' using errcode = '42501'; end if;
  return query select c.id, exists (select 1 from public.channel_secrets s where s.channel_id = c.id)
                 from public.channels c where c.org_id = p_org order by c.created_at;
end $$;

create or replace function public.set_channel_status(p_channel uuid, p_status text) returns void
language plpgsql security definer set search_path = '' as $$
declare c public.channels%rowtype;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into c from public.channels where id = p_channel;
  if not found or not app.has_permission(c.org_id, 'settings:manage') then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_status not in ('active', 'paused') then raise exception 'invalid status' using errcode = '22023'; end if;
  update public.channels set status = p_status where id = p_channel;
  perform app.emit_event(c.org_id, 'channel.' || p_status, 'channel', c.id, '{}'::jsonb, null);
end $$;

-- ---------------------------------------------------------------------------
-- ENTRADA: mensaje recibido (lo llama el servidor con la llave de servicio)
-- ---------------------------------------------------------------------------
create or replace function public.ingest_whatsapp_message(
  p_phone_number_id text, p_thread text, p_contact_name text, p_external_id text,
  p_kind text, p_body text, p_occurred_at timestamptz, p_meta jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  ch     public.channels%rowtype;
  conv   public.conversations%rowtype;
  cust   public.customers%rowtype;
  v_res  jsonb;
  v_msg  uuid;
  v_at   timestamptz;
  v_body text;
  v_norm text;
  v_name text := nullif(btrim(coalesce(p_contact_name, '')), '');
  v_new  boolean := false;
  v_reopened boolean := false;
  v_optout boolean := false;
  v_kind text := case when p_kind in ('text', 'media', 'other') then p_kind else 'other' end;
begin
  if p_thread !~ '^[0-9]{6,20}$' then raise exception 'invalid thread' using errcode = '22023'; end if;
  if coalesce(btrim(p_external_id), '') = '' or char_length(p_external_id) > 200 then
    raise exception 'invalid external id' using errcode = '22023';
  end if;

  select * into ch from public.channels where kind = 'whatsapp' and external_id = p_phone_number_id;
  if not found then return jsonb_build_object('ok', false, 'reason', 'unknown_channel'); end if;

  if exists (select 1 from public.messages where channel_id = ch.id and external_id = p_external_id) then
    return jsonb_build_object('ok', true, 'deduplicated', true);
  end if;

  -- Serializa por conversación: dos mensajes simultáneos del mismo contacto nuevo no duplican nada.
  perform pg_advisory_xact_lock(hashtextextended('wa|' || ch.id::text || '|' || p_thread, 0));
  if exists (select 1 from public.messages where channel_id = ch.id and external_id = p_external_id) then
    return jsonb_build_object('ok', true, 'deduplicated', true);
  end if;

  v_at   := least(coalesce(p_occurred_at, clock_timestamp()), clock_timestamp());    -- nunca en el futuro
  v_body := left(coalesce(nullif(btrim(coalesce(p_body, '')), ''), '[Mensaje vacío]'), 4096);

  select * into conv from public.conversations where channel_id = ch.id and thread_key = p_thread for update;
  if not found then
    v_res := app.ingest_lead_core(ch.org_id, jsonb_build_object(
      'source', 'whatsapp', 'channel', 'whatsapp', 'name', coalesce(v_name, '+' || p_thread),
      'identifiers', jsonb_build_array(jsonb_build_object('type', 'phone', 'value', '+' || p_thread)),
      'external_id', 'wa:' || p_thread), null, null);
    select * into cust from public.customers where id = (v_res ->> 'customer_id')::uuid;
    insert into public.conversations (org_id, channel_id, customer_id, thread_key, contact_name, owner_id, team_id)
    values (ch.org_id, ch.id, cust.id, p_thread, v_name, cust.owner_id, cust.team_id)
    returning * into conv;
    v_new := true;
    perform app.emit_event(ch.org_id, 'conversation.opened', 'conversation', conv.id,
                           jsonb_build_object('channel', 'whatsapp'), cust.id);
  else
    select * into cust from public.customers where id = conv.customer_id;
    if conv.status = 'closed' then
      v_reopened := true;
      perform app.emit_event(ch.org_id, 'conversation.reopened', 'conversation', conv.id,
                             jsonb_build_object('channel', 'whatsapp'), cust.id);
    end if;
  end if;

  insert into public.messages (org_id, channel_id, conversation_id, direction, kind, body, external_id, status, occurred_at, meta)
  values (ch.org_id, ch.id, conv.id, 'inbound', v_kind, v_body, p_external_id, 'received', v_at, coalesce(p_meta, '{}'::jsonb))
  returning id into v_msg;

  -- Baja pedida por el propio cliente (mensaje EXACTO: no se interpreta texto libre).
  v_norm := lower(btrim(translate(v_body, 'áéíóúÁÉÍÓÚñÑ¡!¿?.,;:', 'aeiouaeiounn')));
  if v_norm in ('stop', 'baja', 'parar', 'no molestar', 'no mas', 'cancelar suscripcion', 'darme de baja', 'unsubscribe') then
    v_optout := true;
    update public.messages set meta = meta || '{"opt_out": true}'::jsonb where id = v_msg;
    if not cust.do_not_contact then
      update public.customers set do_not_contact = true, dnc_reason = 'Pidió la baja por WhatsApp' where id = cust.id;
    end if;
  end if;

  -- «Atrasado» = llega con más de 2 minutos de diferencia respecto al último mensaje. La tolerancia existe
  -- porque Meta envía la hora redondeada a segundos y con su reloj: un cliente que responde segundos después
  -- de nosotros NO puede considerarse anterior.
  update public.conversations set
    status          = 'open',
    contact_name    = coalesce(contact_name, v_name),
    last_inbound_at = greatest(coalesce(last_inbound_at, v_at), v_at),
    unread          = true,
    last_message_at = greatest(coalesce(last_message_at, v_at), v_at),
    last_message_preview = case when v_at >= coalesce(last_message_at, '-infinity') - interval '2 minutes'
                                then left(regexp_replace(v_body, '\s+', ' ', 'g'), 140) else last_message_preview end,
    last_direction  = case when v_at >= coalesce(last_message_at, '-infinity') - interval '2 minutes' then 'inbound' else last_direction end,
    needs_reply     = case when v_at >= coalesce(last_message_at, '-infinity') - interval '2 minutes' then true else needs_reply end
   where id = conv.id;

  return jsonb_build_object('ok', true, 'deduplicated', false, 'conversation_id', conv.id, 'message_id', v_msg,
                            'customer_id', cust.id, 'new_conversation', v_new, 'reopened', v_reopened, 'opt_out', v_optout);
end $$;

-- ---------------------------------------------------------------------------
-- ENTRADA: estado de un mensaje enviado (enviado / entregado / leído / falló)
-- Los estados solo avanzan; uno atrasado o repetido se ignora.
-- ---------------------------------------------------------------------------
create or replace function public.apply_message_status(
  p_phone_number_id text, p_external_id text, p_status text, p_occurred_at timestamptz default null,
  p_error_code text default null, p_error text default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare m public.messages%rowtype; v_apply boolean;
begin
  if p_status not in ('sent', 'delivered', 'read', 'failed') then
    return jsonb_build_object('ok', true, 'applied', false, 'reason', 'ignored_status');
  end if;
  select m2.* into m from public.messages m2
    join public.channels c on c.id = m2.channel_id
   where c.kind = 'whatsapp' and c.external_id = p_phone_number_id and m2.external_id = p_external_id and m2.direction = 'outbound'
   for update of m2;
  if not found then return jsonb_build_object('ok', false, 'reason', 'unknown_message'); end if;

  v_apply := case
    when p_status = 'failed' then m.status in ('queued', 'sending', 'sent')
    else app.message_rank(p_status) > app.message_rank(m.status) and m.status <> 'failed'
  end;
  if v_apply then
    update public.messages set
      status     = p_status,
      error_code = case when p_status = 'failed' then left(p_error_code, 40) end,
      error      = case when p_status = 'failed' then left(p_error, 300) end
     where id = m.id;
  end if;
  return jsonb_build_object('ok', true, 'applied', v_apply);
end $$;

-- ---------------------------------------------------------------------------
-- SALIDA: encolar (lo llama la persona usuaria; valida permiso, ventana y «no contactar»)
-- ---------------------------------------------------------------------------
create or replace function app.queue_outbound(
  p_conversation uuid, p_template uuid, p_body text, p_params text[]
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  conv public.conversations%rowtype;
  ch   public.channels%rowtype;
  cust public.customers%rowtype;
  t    public.message_templates%rowtype;
  v_body text;
  v_params text[];
  v_window boolean;
  v_id uuid;
  v_kind text := case when p_template is null then 'text' else 'template' end;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into conv from public.conversations where id = p_conversation for update;
  if not found or not app.can_access_row(conv.org_id, 'conversations:update', conv.owner_id, conv.team_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into ch from public.channels where id = conv.channel_id;
  if ch.status <> 'active' then raise exception 'channel_paused' using errcode = '23514'; end if;
  select * into cust from public.customers where id = conv.customer_id;

  v_window := conv.last_inbound_at is not null and conv.last_inbound_at > clock_timestamp() - interval '24 hours';

  -- «No contactar»: solo se puede RESPONDER (texto libre, dentro de la ventana) a quien acaba de escribir.
  if cust.do_not_contact and (v_kind = 'template' or not v_window) then
    raise exception 'do_not_contact' using errcode = '23514';
  end if;

  if v_kind = 'text' then
    v_body := btrim(coalesce(p_body, ''));
    if v_body = '' then raise exception 'message_empty' using errcode = '22023'; end if;
    if char_length(v_body) > 4096 then raise exception 'message_too_long' using errcode = '22023'; end if;
    if not v_window then raise exception 'window_closed' using errcode = '23514'; end if;
  else
    select * into t from public.message_templates where id = p_template and org_id = conv.org_id;
    if not found or t.status <> 'approved' or t.channel_id <> conv.channel_id then
      raise exception 'template_unavailable' using errcode = '22023';
    end if;
    select coalesce(array_agg(nullif(btrim(regexp_replace(x, '[\r\n\t]+', ' ', 'g')), '') order by ord), '{}')
      into v_params from unnest(coalesce(p_params, '{}')) with ordinality as u(x, ord);
    if coalesce(array_length(v_params, 1), 0) <> t.param_count or exists (select 1 from unnest(v_params) z where z is null) then
      raise exception 'template_params' using errcode = '22023';
    end if;
    v_body := app.render_template(t.body, v_params);
  end if;

  insert into public.messages (org_id, channel_id, conversation_id, direction, kind, body, status, sent_by, occurred_at,
                               template_id, template_params)
  values (conv.org_id, conv.channel_id, conv.id, 'outbound', v_kind, v_body, 'queued', auth.uid(), clock_timestamp(),
          p_template, case when v_kind = 'template' then to_jsonb(v_params) end)
  returning id into v_id;

  update public.conversations set
    last_message_at = clock_timestamp(), last_direction = 'outbound', needs_reply = false, unread = false,
    last_message_preview = left(regexp_replace(v_body, '\s+', ' ', 'g'), 140)
   where id = conv.id;
  return v_id;
end $$;

create or replace function public.queue_message(p_conversation uuid, p_body text) returns uuid
language sql security definer set search_path = '' as $$ select app.queue_outbound(p_conversation, null, p_body, null) $$;
create or replace function public.queue_template_message(p_conversation uuid, p_template uuid, p_params text[] default '{}') returns uuid
language sql security definer set search_path = '' as $$ select app.queue_outbound(p_conversation, p_template, null, p_params) $$;

-- ---------------------------------------------------------------------------
-- Operaciones de la bandeja
-- ---------------------------------------------------------------------------
create or replace function public.mark_conversation_read(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare c public.conversations%rowtype;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into c from public.conversations where id = p_id;
  if not found or not app.can_access_row(c.org_id, 'conversations:update', c.owner_id, c.team_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update public.conversations set unread = false where id = p_id and unread;
end $$;

create or replace function public.set_conversation_status(p_id uuid, p_status text) returns void
language plpgsql security definer set search_path = '' as $$
declare c public.conversations%rowtype;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into c from public.conversations where id = p_id for update;
  if not found or not app.can_access_row(c.org_id, 'conversations:update', c.owner_id, c.team_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_status not in ('open', 'closed') then raise exception 'invalid status' using errcode = '22023'; end if;
  update public.conversations set status = p_status, needs_reply = case when p_status = 'closed' then false else needs_reply end,
         unread = case when p_status = 'closed' then false else unread end
   where id = p_id;
end $$;

-- ---------------------------------------------------------------------------
-- Envío (solo servidor): reclamo atómico, resultado, barrido de pendientes
-- ---------------------------------------------------------------------------
create or replace function public.claim_outbound(p_message uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare m public.messages%rowtype; conv public.conversations%rowtype; ch public.channels%rowtype; t public.message_templates%rowtype;
begin
  -- Solo UNA llamada gana: pasa de 'queued' a 'sending' (las demás no encuentran nada).
  update public.messages set status = 'sending', attempts = attempts + 1
   where id = p_message and direction = 'outbound' and status = 'queued'
  returning * into m;
  if not found then return null; end if;
  select * into conv from public.conversations where id = m.conversation_id;
  select * into ch from public.channels where id = m.channel_id;
  if m.template_id is not null then select * into t from public.message_templates where id = m.template_id; end if;
  return jsonb_build_object('message_id', m.id, 'kind', m.kind, 'body', m.body, 'to', conv.thread_key,
    'phone_number_id', ch.external_id, 'channel_id', ch.id,
    'template_name', t.name, 'template_language', t.language, 'template_params', m.template_params);
end $$;

create or replace function public.finish_outbound(
  p_message uuid, p_ok boolean, p_external_id text default null, p_error_code text default null, p_error text default null
) returns void language plpgsql security definer set search_path = '' as $$
begin
  -- Un estado posterior (entregado/leído) que llegó antes que este resultado no se pisa.
  if p_ok then
    update public.messages set status = case when app.message_rank(status) > app.message_rank('sent') then status else 'sent' end,
           external_id = coalesce(external_id, p_external_id), error = null, error_code = null
     where id = p_message and direction = 'outbound' and status in ('sending', 'sent', 'delivered', 'read');
  else
    update public.messages set status = 'failed', error_code = left(p_error_code, 40), error = left(p_error, 300)
     where id = p_message and direction = 'outbound' and status = 'sending';
  end if;
end $$;

create or replace function public.sweep_outbound(p_queued_after_seconds int default 30, p_sending_after_seconds int default 300)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_retry uuid[]; v_expired int;
begin
  -- Encolados que nadie reclamó (la petición original se cortó antes de enviar): se pueden enviar sin riesgo.
  select coalesce(array_agg(id), '{}') into v_retry from (
    select id from public.messages
     where direction = 'outbound' and status = 'queued' and created_at < clock_timestamp() - make_interval(secs => p_queued_after_seconds)
     order by created_at limit 50) q;
  -- «Enviando» por demasiado tiempo: NO sabemos si salió. No se reenvía (evita mensajes duplicados al cliente).
  with x as (
    update public.messages set status = 'failed', error_code = 'unknown_outcome',
           error = 'No se pudo confirmar el envío. Revisa en WhatsApp antes de reenviar.'
     where direction = 'outbound' and status = 'sending' and created_at < clock_timestamp() - make_interval(secs => p_sending_after_seconds)
    returning 1)
  select count(*) into v_expired from x;
  return jsonb_build_object('retry_ids', to_jsonb(v_retry), 'expired', v_expired);
end $$;

create or replace function public.channel_credentials(p_channel uuid) returns text
language sql security definer stable set search_path = '' as $$
  select access_token from public.channel_secrets where channel_id = p_channel
$$;

-- ---------------------------------------------------------------------------
-- Cola de webhooks (solo servidor)
-- ---------------------------------------------------------------------------
create or replace function public.record_raw_event(p_payload jsonb) returns bigint
language sql security definer set search_path = '' as $$
  insert into public.raw_events (payload, attempts, last_attempt_at) values (p_payload, 1, clock_timestamp()) returning id
$$;

create or replace function public.finish_raw_event(p_id bigint, p_ok boolean, p_error text default null) returns void
language sql security definer set search_path = '' as $$
  update public.raw_events set
    status = case when p_ok then 'processed' when attempts >= 8 then 'failed' else 'pending' end,
    processed_at = case when p_ok then clock_timestamp() end, last_error = left(p_error, 300)
   where id = p_id
$$;

create or replace function public.claim_raw_events(p_limit int default 20, p_min_age_seconds int default 30)
returns table (id bigint, payload jsonb) language sql security definer set search_path = '' as $$
  update public.raw_events e set attempts = e.attempts + 1, last_attempt_at = clock_timestamp()
   where e.id in (select r.id from public.raw_events r
                   where r.status = 'pending' and r.attempts < 8
                     and coalesce(r.last_attempt_at, r.received_at) < clock_timestamp() - make_interval(secs => p_min_age_seconds)
                   order by r.id limit p_limit for update skip locked)
  returning e.id, e.payload
$$;

create or replace function public.purge_raw_events(p_days int default 30) returns int
language sql security definer set search_path = '' as $$
  with d as (delete from public.raw_events where status = 'processed' and processed_at < now() - make_interval(days => p_days) returning 1)
  select count(*)::int from d
$$;

-- ---------------------------------------------------------------------------
-- Privilegios + RLS + auditoría
-- ---------------------------------------------------------------------------
revoke all on public.channels, public.channel_secrets, public.message_templates, public.conversations, public.messages, public.raw_events
  from anon, authenticated;
grant select on public.channels, public.message_templates, public.conversations, public.messages to authenticated;
grant insert (org_id, channel_id, name, language, body) on public.message_templates to authenticated;
grant update (body, status) on public.message_templates to authenticated;
grant all on public.channels, public.channel_secrets, public.message_templates, public.conversations, public.messages, public.raw_events to service_role;

alter table public.channels          enable row level security;
alter table public.channel_secrets   enable row level security;   -- sin políticas: nadie con sesión de usuario la lee
alter table public.message_templates enable row level security;
alter table public.conversations     enable row level security;
alter table public.messages          enable row level security;
alter table public.raw_events        enable row level security;   -- sin políticas: solo el servidor

create policy channels_select on public.channels for select to authenticated
  using ((select app.has_permission(org_id, 'conversations:read')) or (select app.has_permission(org_id, 'settings:manage')));
create policy templates_select on public.message_templates for select to authenticated
  using ((select app.has_permission(org_id, 'conversations:update')) or (select app.has_permission(org_id, 'settings:manage')));
create policy templates_insert on public.message_templates for insert to authenticated
  with check ((select app.has_permission(org_id, 'settings:manage')));
create policy templates_update on public.message_templates for update to authenticated
  using ((select app.has_permission(org_id, 'settings:manage')))
  with check ((select app.has_permission(org_id, 'settings:manage')));
create policy conversations_select on public.conversations for select to authenticated
  using ((select app.can_access_row(org_id, 'conversations:read', owner_id, team_id)));
create policy messages_select on public.messages for select to authenticated
  using (exists (select 1 from public.conversations c where c.id = conversation_id));

create trigger channels_audit  after insert or update or delete on public.channels          for each row execute function app.audit_row_change();
create trigger templates_audit after insert or update or delete on public.message_templates for each row execute function app.audit_row_change();

-- Funciones internas: nadie con sesión de usuario las ejecuta directamente.
revoke all on function app.message_templates_prepare(), app.messages_guard(), app.conversations_guard(),
  app.render_template(text, text[]), app.message_rank(text), app.customers_after_update(),
  app.queue_outbound(uuid, uuid, text, text[]) from public, anon, authenticated;

-- Funciones del servidor (llave de servicio): jamás desde el navegador.
revoke all on function public.ingest_whatsapp_message(text, text, text, text, text, text, timestamptz, jsonb),
  public.apply_message_status(text, text, text, timestamptz, text, text),
  public.claim_outbound(uuid), public.finish_outbound(uuid, boolean, text, text, text),
  public.sweep_outbound(int, int), public.channel_credentials(uuid),
  public.record_raw_event(jsonb), public.finish_raw_event(bigint, boolean, text),
  public.claim_raw_events(int, int), public.purge_raw_events(int) from public, anon, authenticated;
grant execute on function public.ingest_whatsapp_message(text, text, text, text, text, text, timestamptz, jsonb),
  public.apply_message_status(text, text, text, timestamptz, text, text),
  public.claim_outbound(uuid), public.finish_outbound(uuid, boolean, text, text, text),
  public.sweep_outbound(int, int), public.channel_credentials(uuid),
  public.record_raw_event(jsonb), public.finish_raw_event(bigint, boolean, text),
  public.claim_raw_events(int, int), public.purge_raw_events(int) to service_role;

-- Funciones de la persona usuaria.
revoke all on function public.create_channel(uuid, text, text, text, text), public.save_channel_token(uuid, text),
  public.set_channel_status(uuid, text), public.channel_token_status(uuid), public.queue_message(uuid, text), public.queue_template_message(uuid, uuid, text[]),
  public.mark_conversation_read(uuid), public.set_conversation_status(uuid, text) from public, anon;
grant execute on function public.create_channel(uuid, text, text, text, text), public.save_channel_token(uuid, text),
  public.set_channel_status(uuid, text), public.channel_token_status(uuid), public.queue_message(uuid, text), public.queue_template_message(uuid, uuid, text[]),
  public.mark_conversation_read(uuid), public.set_conversation_status(uuid, text) to authenticated, service_role;


-- ---------------- 20260919000014_inbox_context.sql ----------------
-- =============================================================================
-- 0014 INBOX: contexto del cliente (etiquetas), respuestas rápidas y contador de no leídos
-- =============================================================================
-- Reglas que viven en la base de datos:
--   * Una etiqueta es única por organización sin distinguir mayúsculas ni espacios extremos.
--   * Etiquetar/quitar etiqueta exige poder EDITAR a ese cliente (alcance por dueño/equipo).
--   * Agregar una etiqueta es idempotente y seguro con concurrencia (nunca duplica).
--   * Al fusionar clientes, las etiquetas se unen sin duplicarse.
--   * El contador de no leídos suma con cada mensaje entrante y vuelve a 0 al responder,
--     marcar como leída o cerrar; nunca es negativo.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Contador de no leídos
-- ---------------------------------------------------------------------------
alter table public.conversations add column unread_count int not null default 0 check (unread_count >= 0);
update public.conversations set unread_count = 1 where unread;

create or replace function app.messages_count_unread() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.conversations set unread_count = unread_count + 1, unread = true where id = new.conversation_id;
  return null;
end $$;
create trigger messages_count_unread_trg after insert on public.messages
  for each row when (new.direction = 'inbound') execute function app.messages_count_unread();

create or replace function app.conversations_unread_sync() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not new.unread then new.unread_count := 0; end if;
  if new.unread and new.unread_count = 0 then new.unread_count := 1; end if;
  return new;
end $$;
create trigger conversations_unread_sync_trg before update on public.conversations
  for each row execute function app.conversations_unread_sync();

-- ---------------------------------------------------------------------------
-- Etiquetas
-- ---------------------------------------------------------------------------
create table public.tags (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.organizations(id) on delete cascade,
  name       text not null check (char_length(btrim(name)) between 1 and 40),
  color      text not null default 'violet' check (color in ('violet', 'blue', 'teal', 'green', 'yellow', 'orange', 'red', 'pink', 'gray')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (id, org_id)
);
create unique index tags_name_uk on public.tags (org_id, (lower(btrim(name))));

create table public.customer_tags (
  org_id      uuid not null,
  customer_id uuid not null,
  tag_id      uuid not null,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  primary key (customer_id, tag_id),
  foreign key (customer_id, org_id) references public.customers (id, org_id) on delete cascade,
  foreign key (tag_id, org_id)      references public.tags (id, org_id) on delete cascade
);
create index customer_tags_tag_idx on public.customer_tags (tag_id);

-- Al fusionar clientes (UPDATE de customer_id), si el principal ya tiene la etiqueta se descarta la repetida.
create or replace function app.customer_tags_merge_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.customer_id <> old.customer_id
     and exists (select 1 from public.customer_tags x where x.customer_id = new.customer_id and x.tag_id = new.tag_id) then
    delete from public.customer_tags where customer_id = old.customer_id and tag_id = old.tag_id;
    return null;
  end if;
  return new;
end $$;
create trigger customer_tags_merge_guard_trg before update on public.customer_tags
  for each row execute function app.customer_tags_merge_guard();
insert into app.customer_merge_targets values ('customer_tags');

create or replace function public.add_customer_tag(p_customer uuid, p_name text, p_color text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  c public.customers%rowtype; v_name text := btrim(coalesce(p_name, '')); v_tag uuid; v_color text;
  v_palette text[] := array['violet', 'blue', 'teal', 'green', 'yellow', 'orange', 'red', 'pink'];
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into c from public.customers where id = p_customer and deleted_at is null;
  if not found or not app.can_access_row(c.org_id, 'customers:update', c.owner_id, c.team_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if char_length(v_name) < 1 or char_length(v_name) > 40 then raise exception 'tag_name' using errcode = '22023'; end if;
  v_color := coalesce(nullif(btrim(coalesce(p_color, '')), ''), v_palette[1 + abs(hashtext(lower(v_name))) % 8]);
  if v_color not in ('violet', 'blue', 'teal', 'green', 'yellow', 'orange', 'red', 'pink', 'gray') then
    raise exception 'tag_color' using errcode = '22023';
  end if;

  select id into v_tag from public.tags where org_id = c.org_id and lower(btrim(name)) = lower(v_name);
  if v_tag is null then
    insert into public.tags (org_id, name, color, created_by) values (c.org_id, v_name, v_color, auth.uid())
    on conflict (org_id, (lower(btrim(name)))) do nothing returning id into v_tag;
    if v_tag is null then   -- otra sesión la creó justo ahora
      select id into v_tag from public.tags where org_id = c.org_id and lower(btrim(name)) = lower(v_name);
    end if;
  end if;
  insert into public.customer_tags (org_id, customer_id, tag_id, created_by) values (c.org_id, c.id, v_tag, auth.uid())
  on conflict (customer_id, tag_id) do nothing;
  return v_tag;
end $$;

create or replace function public.remove_customer_tag(p_customer uuid, p_tag uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare c public.customers%rowtype;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into c from public.customers where id = p_customer;
  if not found or not app.can_access_row(c.org_id, 'customers:update', c.owner_id, c.team_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  delete from public.customer_tags where customer_id = p_customer and tag_id = p_tag and org_id = c.org_id;
end $$;

-- ---------------------------------------------------------------------------
-- Respuestas rápidas
-- ---------------------------------------------------------------------------
create table public.quick_replies (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.organizations(id) on delete cascade,
  title      text not null check (char_length(btrim(title)) between 1 and 60),
  body       text not null check (char_length(btrim(body)) between 1 and 1000),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (id, org_id)
);
create unique index quick_replies_title_uk on public.quick_replies (org_id, (lower(btrim(title))));

create or replace function public.create_quick_reply(p_org uuid, p_title text, p_body text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not app.has_permission(p_org, 'conversations:update') then raise exception 'not allowed' using errcode = '42501'; end if;
  insert into public.quick_replies (org_id, title, body, created_by) values (p_org, btrim(p_title), btrim(p_body), auth.uid())
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.delete_quick_reply(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare q public.quick_replies%rowtype;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into q from public.quick_replies where id = p_id;
  if not found then return; end if;
  if not (q.created_by = auth.uid() and app.has_permission(q.org_id, 'conversations:update'))
     and not app.has_permission(q.org_id, 'settings:manage') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  delete from public.quick_replies where id = p_id;
end $$;

-- ---------------------------------------------------------------------------
-- Privilegios + RLS + auditoría
-- ---------------------------------------------------------------------------
revoke all on public.tags, public.customer_tags, public.quick_replies from anon, authenticated;
grant select on public.tags, public.customer_tags, public.quick_replies to authenticated;
grant all on public.tags, public.customer_tags, public.quick_replies to service_role;

alter table public.tags          enable row level security;
alter table public.customer_tags enable row level security;
alter table public.quick_replies enable row level security;

create policy tags_select on public.tags for select to authenticated
  using ((select app.has_permission(org_id, 'customers:read')));
create policy customer_tags_select on public.customer_tags for select to authenticated
  using (exists (select 1 from public.customers c where c.id = customer_id));
create policy quick_replies_select on public.quick_replies for select to authenticated
  using ((select app.has_permission(org_id, 'conversations:update')) or (select app.has_permission(org_id, 'settings:manage')));

create trigger tags_audit          after insert or update or delete on public.tags          for each row execute function app.audit_row_change();
create trigger quick_replies_audit after insert or update or delete on public.quick_replies for each row execute function app.audit_row_change();

revoke all on function app.messages_count_unread(), app.conversations_unread_sync(), app.customer_tags_merge_guard() from public, anon, authenticated;
revoke all on function public.add_customer_tag(uuid, text, text), public.remove_customer_tag(uuid, uuid),
  public.create_quick_reply(uuid, text, text), public.delete_quick_reply(uuid) from public, anon;
grant execute on function public.add_customer_tag(uuid, text, text), public.remove_customer_tag(uuid, uuid),
  public.create_quick_reply(uuid, text, text), public.delete_quick_reply(uuid) to authenticated, service_role;


-- ---------------- 20260919000015_opportunities_kanban.sql ----------------
-- =============================================================================
-- 0015 OPORTUNIDADES (tablero Kanban): número, prioridad, temperatura, canal y vínculo con la conversación
-- =============================================================================
-- Reglas que viven en la base de datos:
--   * Cada oportunidad tiene un número correlativo por organización (OPP-0001…), sin repetidos ni huecos
--     aunque se creen muchas a la vez, y NADIE lo puede cambiar.
--   * Prioridad (alta/media/baja; por defecto media) y temperatura (fría/tibia/caliente; opcional) son
--     independientes de la etapa. Solo quien puede editar la oportunidad las cambia.
--   * Una oportunidad puede apuntar a la conversación original, pero SOLO a una conversación del MISMO cliente.
--     Al crearla se enlaza sola a la conversación más reciente del cliente (si existe).
--   * Etapas por defecto: Nueva · Contactado · Calificada · Cotización · Negociación · Ganada · Perdida.
--     Los pipelines existentes se actualizan SOLO si conservan exactamente las etapas originales sin tocar.
-- =============================================================================

alter table public.opportunities
  add column number         text,
  add column priority       text not null default 'medium' check (priority in ('low', 'medium', 'high')),
  add column temperature    text check (temperature in ('cold', 'warm', 'hot')),
  add column channel        text check (channel in ('whatsapp', 'instagram', 'facebook', 'email', 'phone', 'web', 'referral', 'other')),
  add column conversation_id uuid;

alter table public.opportunities
  add constraint opportunities_conversation_fk foreign key (conversation_id, org_id)
  references public.conversations (id, org_id) on delete set null (conversation_id);

-- Número correlativo: se reparte en orden de creación a las existentes (el contador avanza con cada una).
do $$
declare r record;
begin
  for r in select id, org_id from public.opportunities order by created_at, id loop
    update public.opportunities set number = 'OPP-' || lpad(app.next_number(r.org_id, 'opportunity')::text, 4, '0') where id = r.id;
  end loop;
end $$;
alter table public.opportunities alter column number set not null;
create unique index opportunities_number_uk on public.opportunities (org_id, number);
create index opportunities_conversation_idx on public.opportunities (conversation_id) where conversation_id is not null;

-- Canal de las que nacieron de un lead (solo valores que reconocemos) y conversación más reciente del cliente.
update public.opportunities o set channel = lower(btrim(l.channel))
  from public.leads l
 where l.converted_opportunity_id = o.id and o.channel is null
   and lower(btrim(l.channel)) in ('whatsapp', 'instagram', 'facebook', 'email', 'phone', 'web', 'referral', 'other');
with latest as (
  select distinct on (c.customer_id) c.customer_id, c.id as conversation_id, c.channel_id
    from public.conversations c order by c.customer_id, c.last_message_at desc nulls last, c.created_at desc
)
update public.opportunities o
   set conversation_id = l.conversation_id,
       channel = coalesce(o.channel, (select ch.kind from public.channels ch where ch.id = l.channel_id))
  from latest l where l.customer_id = o.customer_id and o.conversation_id is null;

-- Número, conversación por defecto y coherencia de la conversación con el cliente.
create or replace function app.opportunities_defaults() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_conv uuid; v_kind text;
begin
  if tg_op = 'INSERT' then
    if new.number is null then
      new.number := 'OPP-' || lpad(app.next_number(new.org_id, 'opportunity')::text, 4, '0');
    end if;
    if new.conversation_id is null then
      select c.id, ch.kind into v_conv, v_kind
        from public.conversations c join public.channels ch on ch.id = c.channel_id
       where c.customer_id = new.customer_id and c.org_id = new.org_id
       order by c.last_message_at desc nulls last, c.created_at desc limit 1;
      new.conversation_id := v_conv;
      if new.channel is null then new.channel := v_kind; end if;
    end if;
  elsif new.number is distinct from old.number then
    raise exception 'opportunity number is immutable' using errcode = '23514';
  end if;
  if new.conversation_id is not null
     and (tg_op = 'INSERT' or new.conversation_id is distinct from old.conversation_id)
     and current_setting('app.customer_merge', true) is distinct from 'on'
     and not exists (select 1 from public.conversations c where c.id = new.conversation_id and c.customer_id = new.customer_id and c.org_id = new.org_id) then
    raise exception 'conversation_customer_mismatch' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger opportunities_defaults_trg before insert or update on public.opportunities
  for each row execute function app.opportunities_defaults();

-- Vincular / desvincular la conversación original.
create or replace function public.link_opportunity_conversation(p_opportunity uuid, p_conversation uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare o public.opportunities%rowtype;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into o from public.opportunities where id = p_opportunity for update;
  if not found or not app.can_access_row(o.org_id, 'opportunities:update', o.owner_id, o.team_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update public.opportunities set conversation_id = p_conversation where id = o.id;
end $$;

grant update (priority, temperature, channel) on public.opportunities to authenticated;

-- ---------------------------------------------------------------------------
-- Etapas por defecto (pipelines nuevos) y actualización conservadora de los existentes
-- ---------------------------------------------------------------------------
create or replace function app.add_default_stages(p_org uuid, p_pipe uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.pipeline_stages (org_id, pipeline_id, name, kind, position, probability) values
    (p_org, p_pipe, 'Nueva',       'open', 10, 10),
    (p_org, p_pipe, 'Contactado',  'open', 20, 25),
    (p_org, p_pipe, 'Calificada',  'open', 30, 40),
    (p_org, p_pipe, 'Cotización',  'open', 40, 60),
    (p_org, p_pipe, 'Negociación', 'open', 50, 80),
    (p_org, p_pipe, 'Ganada',      'won',  10, 100),
    (p_org, p_pipe, 'Perdida',     'lost', 10, 0);
end $$;

-- Solo toca pipelines que tienen EXACTAMENTE las etapas originales (Nuevo, Contactado, Propuesta, Negociación,
-- Ganada, Perdida): si alguien ya las personalizó, no se cambia nada. Es idempotente.
create or replace function app.upgrade_legacy_default_stages() returns int
language plpgsql security definer set search_path = '' as $$
declare p record; v_n int := 0;
begin
  for p in
    select pl.id, pl.org_id from public.pipelines pl
     where pl.archived_at is null
       and (select array_agg(s.name order by s.position) from public.pipeline_stages s
             where s.pipeline_id = pl.id and s.kind = 'open' and s.archived_at is null) = array['Nuevo', 'Contactado', 'Propuesta', 'Negociación']
       and (select count(*) from public.pipeline_stages s where s.pipeline_id = pl.id and s.archived_at is null) = 6
       and exists (select 1 from public.pipeline_stages s where s.pipeline_id = pl.id and s.kind = 'won' and s.name = 'Ganada' and s.archived_at is null)
       and exists (select 1 from public.pipeline_stages s where s.pipeline_id = pl.id and s.kind = 'lost' and s.name = 'Perdida' and s.archived_at is null)
  loop
    update public.pipeline_stages set name = 'Nueva'      where pipeline_id = p.id and kind = 'open' and name = 'Nuevo';
    update public.pipeline_stages set name = 'Cotización' where pipeline_id = p.id and kind = 'open' and name = 'Propuesta';
    insert into public.pipeline_stages (org_id, pipeline_id, name, kind, position, probability) values (p.org_id, p.id, 'Calificada', 'open', 25, 40);
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;
select app.upgrade_legacy_default_stages();

revoke all on function app.opportunities_defaults(), app.upgrade_legacy_default_stages() from public, anon, authenticated;
revoke all on function public.link_opportunity_conversation(uuid, uuid) from public, anon;
grant execute on function public.link_opportunity_conversation(uuid, uuid) to authenticated, service_role;

commit;

-- Comprobación final: 'tablas' y 'tablas_con_rls' deben ser iguales.
select 'LISTO' as estado,
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r') as tablas,
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity) as tablas_con_rls,
  (select count(*) from public.permissions) as permisos,
  (select count(*) from public.roles where org_id is null) as roles_base;

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

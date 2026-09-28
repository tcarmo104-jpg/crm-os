-- =============================================================================
-- CRM OS · ACTUALIZACIÓN: migraciones 0027 en adelante (para un proyecto que YA tiene 0001 a 0026)
-- Pégalo entero en SQL Editor → New query → Run. Va en UNA transacción: si algo falla,
-- no queda nada a medias y puedes corregir y volver a ejecutarlo.
-- Al final debe mostrar una fila con estado = LISTO.
-- Generado con scripts/build-setup-sql.sh a partir de supabase/migrations/*.sql
-- =============================================================================
begin;
-- Comprobación previa (evita instalar sobre un estado que no corresponde).
do $$ begin
  if to_regclass('public.organizations') is null or to_regclass('public.audit_logs') is null then
    raise exception 'FALTAN las primeras migraciones (0001 a 0004). Este archivo es solo para proyectos que ya las tienen.';
  end if;
  if to_regclass('public.invitations') is null then
    raise exception 'FALTA la migración 0005 (invitaciones). Avísame para darte el archivo correcto.';
  end if;
  if to_regclass('public.tasks') is null and 27 > 10 then
    raise exception 'FALTAN las migraciones de la Fase 3 (0009 y 0010). Avísame para darte el archivo correcto.';
  end if;
  if to_regclass('public.tags') is null then
    raise exception 'FALTA la migración 0014 (Inbox de tres paneles). Instala primero setup-desde-0014.sql o avísame.';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'opportunities' and column_name = 'number') then
    raise exception 'FALTA la migración 0015 (Oportunidades). Instala primero setup-desde-0015.sql o avísame.';
  end if;
  if to_regclass('public.oauth_sessions') is null then
    raise exception 'FALTA la migración 0017 (Facebook, Instagram y Gmail). Instala primero setup-desde-0016.sql o avísame.';
  end if;
  if to_regclass('public.message_attachments') is null then
    raise exception 'FALTA la migración 0018 (Multimedia del Inbox). Instala primero setup-desde-0018.sql o avísame.';
  end if;
  if to_regclass('public.attachment_uploads') is null then
    raise exception 'FALTA la migración 0019 (Envío de archivos). Instala primero setup-desde-0019.sql o avísame.';
  end if;
  if to_regprocedure('public.start_task(uuid)') is null then
    raise exception 'FALTA la migración 0023 (Tareas y Actividades). Instala primero setup-desde-0023.sql o avísame.';
  end if;
  if to_regclass('public.sequences') is null then
    raise exception 'FALTA la migración 0025 (Secuencias). Instala primero setup-desde-0025.sql o avísame. (La acción «inscribir en una secuencia» de Automatizaciones la necesita.)';
  end if;
  if to_regprocedure('public.create_custom_role(uuid,text,text,text,jsonb)') is not null then
    raise exception 'Este proyecto YA tiene instalada la migración 0027 (existe la función create_custom_role). No ejecutes este archivo: avísame.';
  end if;
end $$;

-- ---------------- 20260919000027_custom_roles.sql ----------------
-- =============================================================================
-- 0027 ROLES PERSONALIZADOS
-- =============================================================================
-- El permiso `roles:manage` ya existía desde la Fase 1, otorgado a `super_admin` y `admin` (todo lo demás
-- lo tiene ya). La tabla `roles` ya soportaba roles por organización (`org_id` no nulo = rol personalizado;
-- nulo = rol de sistema) y `role_permissions` ya guarda el alcance de cada permiso. Solo faltaban las
-- funciones para crear y editar un rol propio — nunca se tocan los roles de sistema.
--
-- Asignar el rol resultante a una persona NO necesita nada nuevo: `changeRole` ya actualiza
-- `memberships.role_id` con cualquier id de rol válido de la organización, sea de sistema o personalizado.
-- =============================================================================

create or replace function app.assert_manages_roles(p_org uuid) returns void
language plpgsql set search_path = '' as $$ begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not app.has_permission(p_org, 'roles:manage') then raise exception 'not allowed' using errcode = '42501'; end if;
end $$;

create or replace function public.create_custom_role(p_org uuid, p_key text, p_name text, p_description text, p_permissions jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; perm jsonb;
begin
  perform app.assert_manages_roles(p_org);
  if p_key !~ '^[a-z_]+$' then raise exception 'invalid_key' using errcode = '22023'; end if;
  if btrim(coalesce(p_name, '')) = '' then raise exception 'name_required' using errcode = '22023'; end if;

  insert into public.roles (org_id, key, name, description) values (p_org, p_key, btrim(p_name), nullif(btrim(coalesce(p_description, '')), ''))
  returning id into v_id;

  for perm in select * from jsonb_array_elements(coalesce(p_permissions, '[]'::jsonb)) loop
    insert into public.role_permissions (role_id, permission_key, scope)
    values (v_id, perm ->> 'key', (perm ->> 'scope')::public.permission_scope);
  end loop;
  return v_id;
exception when unique_violation then
  raise exception 'role_key_taken' using errcode = '23505';
end $$;

create or replace function app.load_custom_role(p_role_id uuid, out r public.roles) returns public.roles
language plpgsql security definer set search_path = '' as $$
begin
  select * into r from public.roles where id = p_role_id;
  if not found or r.org_id is null then raise exception 'not_a_custom_role' using errcode = '22023'; end if;
  perform app.assert_manages_roles(r.org_id);
end $$;

create or replace function public.rename_custom_role(p_role_id uuid, p_name text, p_description text) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.roles;
begin
  r := app.load_custom_role(p_role_id);
  if btrim(coalesce(p_name, '')) = '' then raise exception 'name_required' using errcode = '22023'; end if;
  update public.roles set name = btrim(p_name), description = nullif(btrim(coalesce(p_description, '')), '') where id = p_role_id;
end $$;

create or replace function public.set_custom_role_permissions(p_role_id uuid, p_permissions jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.roles; perm jsonb;
begin
  r := app.load_custom_role(p_role_id);
  delete from public.role_permissions where role_id = p_role_id;
  for perm in select * from jsonb_array_elements(coalesce(p_permissions, '[]'::jsonb)) loop
    insert into public.role_permissions (role_id, permission_key, scope)
    values (p_role_id, perm ->> 'key', (perm ->> 'scope')::public.permission_scope);
  end loop;
end $$;

create or replace function public.delete_custom_role(p_role_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.roles; v_in_use int;
begin
  r := app.load_custom_role(p_role_id);
  select count(*) into v_in_use from public.memberships where role_id = p_role_id and status = 'active';
  if v_in_use > 0 then raise exception 'role_in_use' using errcode = '23514'; end if;
  delete from public.roles where id = p_role_id;
end $$;

revoke all on function public.create_custom_role(uuid, text, text, text, jsonb), public.rename_custom_role(uuid, text, text),
  public.set_custom_role_permissions(uuid, jsonb), public.delete_custom_role(uuid) from public, anon;
grant execute on function public.create_custom_role(uuid, text, text, text, jsonb), public.rename_custom_role(uuid, text, text),
  public.set_custom_role_permissions(uuid, jsonb), public.delete_custom_role(uuid) to authenticated, service_role;

commit;

-- Comprobación final: 'tablas' y 'tablas_con_rls' deben ser iguales.
select 'LISTO' as estado,
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r') as tablas,
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity) as tablas_con_rls,
  (select count(*) from public.permissions) as permisos,
  (select count(*) from public.roles where org_id is null) as roles_base;

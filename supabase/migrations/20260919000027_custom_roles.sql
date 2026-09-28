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

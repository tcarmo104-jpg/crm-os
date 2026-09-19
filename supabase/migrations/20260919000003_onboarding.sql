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

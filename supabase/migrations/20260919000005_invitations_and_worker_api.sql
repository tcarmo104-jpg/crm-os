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

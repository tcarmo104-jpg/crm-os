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

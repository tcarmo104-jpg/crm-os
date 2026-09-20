-- =============================================================================
-- CRM OS · ACTUALIZACIÓN: migraciones 0022 en adelante (para un proyecto que YA tiene 0001 a 0021)
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
  if to_regclass('public.tasks') is null and 22 > 10 then
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
  if to_regclass('public.provider_apps') is not null then
    raise exception 'Este proyecto YA tiene instalada la migración 0022 (existe la tabla provider_apps). No ejecutes este archivo: avísame.';
  end if;
end $$;

-- ---------------- 20260919000022_provider_apps.sql ----------------
-- =============================================================================
-- 0022 CREDENCIALES DE LA APLICACIÓN DE META / GOOGLE, DENTRO DEL CRM (sin variables de Vercel)
-- =============================================================================
-- La «clave secreta de la app» y el «token de verificación» NO son de cada número de WhatsApp: son de la APLICACIÓN de Meta (o del cliente
-- OAuth de Google). Antes se pedían como variables de Vercel, lo que obligaba a entrar allí y no escalaba (cada empresa con su propia app).
-- Ahora cada organización guarda las de SU aplicación aquí, cifradas por el servidor, y solo el servidor las lee. Las variables de entorno
-- siguen funcionando como respaldo (aplicación «de la plataforma») para no romper instalaciones existentes.
--   * Un identificador de app pertenece a UNA organización (no se puede registrar la misma app en dos).
--   * Los administradores ven el estado (identificador, fecha) pero NUNCA la clave.
-- =============================================================================
create table public.provider_apps (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations (id) on delete cascade,
  provider      text not null check (provider in ('meta', 'google')),
  client_id     text not null check (char_length(client_id) between 5 and 200 and client_id !~ '\s'),
  client_secret text not null check (char_length(client_secret) between 8 and 2000),
  verify_token  text check (verify_token is null or char_length(verify_token) between 16 and 300),
  created_by    uuid,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (org_id, provider),
  unique (provider, client_id),
  check (provider <> 'meta' or client_id ~ '^[0-9]{5,30}$'),
  check (provider <> 'meta' or verify_token is not null)
);
alter table public.provider_apps enable row level security;
revoke all on public.provider_apps from anon, authenticated;        -- solo el servidor la lee; las personas usan las funciones de abajo

create or replace function public.save_provider_app(p_org uuid, p_provider text, p_client_id text, p_secret text, p_verify text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_verify text;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not app.has_permission(p_org, 'settings:manage') then raise exception 'not allowed' using errcode = '42501'; end if;
  -- Al cambiar la clave sin enviar un token de verificación nuevo, se conserva el que ya se registró en Meta.
  select coalesce(nullif(btrim(coalesce(p_verify, '')), ''), a.verify_token) into v_verify from public.provider_apps a where a.org_id = p_org and a.provider = p_provider;
  if not found then v_verify := nullif(btrim(coalesce(p_verify, '')), ''); end if;
  insert into public.provider_apps (org_id, provider, client_id, client_secret, verify_token, created_by)
  values (p_org, p_provider, btrim(coalesce(p_client_id, '')), btrim(coalesce(p_secret, '')), v_verify, auth.uid())
  on conflict (org_id, provider) do update set
    client_id = excluded.client_id, client_secret = excluded.client_secret,
    verify_token = coalesce(excluded.verify_token, public.provider_apps.verify_token), updated_at = now()
  returning id into v_id;
  -- El evento NO lleva la clave.
  perform app.emit_event(p_org, 'provider_app.saved', 'provider_app', v_id, jsonb_build_object('provider', p_provider, 'client_id', btrim(p_client_id)), null);
exception when unique_violation then
  raise exception 'app_taken' using errcode = '23505';
end $$;

-- Estado para el administrador: identificador y fecha, nunca la clave.
create or replace function public.provider_app_status(p_org uuid, p_provider text) returns jsonb
language plpgsql security definer set search_path = '' stable as $$
declare r public.provider_apps%rowtype;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not app.has_permission(p_org, 'settings:manage') then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into r from public.provider_apps where org_id = p_org and provider = p_provider;
  if not found then return null; end if;
  return jsonb_build_object('client_id', r.client_id, 'updated_at', r.updated_at, 'has_verify_token', r.verify_token is not null);
end $$;

create or replace function public.delete_provider_app(p_org uuid, p_provider text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not app.has_permission(p_org, 'settings:manage') then raise exception 'not allowed' using errcode = '42501'; end if;
  delete from public.provider_apps where org_id = p_org and provider = p_provider returning id into v_id;
  if v_id is not null then perform app.emit_event(p_org, 'provider_app.removed', 'provider_app', v_id, jsonb_build_object('provider', p_provider), null); end if;
end $$;

-- SOLO el servidor: las credenciales de una organización.
create or replace function public.provider_app_secrets(p_org uuid, p_provider text) returns jsonb
language sql security definer set search_path = '' stable as $$
  select jsonb_build_object('client_id', client_id, 'secret', client_secret, 'verify_token', verify_token) from public.provider_apps where org_id = p_org and provider = p_provider
$$;

-- SOLO el servidor: todas las aplicaciones de Meta (el webhook averigua de cuál viene cada aviso por su firma).
create or replace function public.meta_apps_for_webhook() returns table (org_id uuid, client_id text, secret text, verify_token text)
language sql security definer set search_path = '' stable as $$
  select a.org_id, a.client_id, a.client_secret, a.verify_token from public.provider_apps a where a.provider = 'meta'
$$;

revoke all on function public.save_provider_app(uuid, text, text, text, text), public.provider_app_status(uuid, text), public.delete_provider_app(uuid, text),
  public.provider_app_secrets(uuid, text), public.meta_apps_for_webhook() from public, anon;
grant execute on function public.save_provider_app(uuid, text, text, text, text), public.provider_app_status(uuid, text), public.delete_provider_app(uuid, text) to authenticated, service_role;
revoke all on function public.provider_app_secrets(uuid, text), public.meta_apps_for_webhook() from authenticated;
grant execute on function public.provider_app_secrets(uuid, text), public.meta_apps_for_webhook() to service_role;

commit;

-- Comprobación final: 'tablas' y 'tablas_con_rls' deben ser iguales.
select 'LISTO' as estado,
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r') as tablas,
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity) as tablas_con_rls,
  (select count(*) from public.permissions) as permisos,
  (select count(*) from public.roles where org_id is null) as roles_base;

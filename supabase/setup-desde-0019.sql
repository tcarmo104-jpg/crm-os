-- =============================================================================
-- CRM OS · ACTUALIZACIÓN: migraciones 0019 en adelante (para un proyecto que YA tiene 0001 a 0018)
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
  if to_regclass('public.tasks') is null and 19 > 10 then
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
  if to_regclass('public.attachment_uploads') is not null then
    raise exception 'Este proyecto YA tiene instalada la migración 0019 (existe la tabla attachment_uploads). No ejecutes este archivo: avísame.';
  end if;
end $$;

-- ---------------- 20260919000019_outbound_attachments.sql ----------------
-- =============================================================================
-- 0019 ENVÍO DE ARCHIVOS desde el Inbox
-- =============================================================================
-- Flujo: (1) el agente elige un archivo → `create_attachment_upload` reserva un lugar (y la ruta) EN SU CONVERSACIÓN;
-- (2) el navegador sube el archivo DIRECTO al bucket privado con un enlace firmado (Vercel no admite cuerpos de más de 4,5 MB);
-- (3) el SERVIDOR lo verifica por su contenido y solo entonces lo marca `verified` (nadie más puede);
-- (4) `queue_media_message` crea el mensaje con sus adjuntos aplicando las MISMAS reglas que el texto (permiso, ventana de
-- respuesta, canal en pausa/desconectado, «no contactar»); (5) la entrega sube el archivo al canal y guarda el estado.
-- Reutiliza `message_attachments` (dirección `outbound`) y `messages` (kind = 'media'). Aditivo.
-- =============================================================================

create table public.attachment_uploads (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null,
  conversation_id uuid not null,
  user_id         uuid not null,
  file_name       text not null check (char_length(file_name) between 1 and 255),
  mime_type       text not null check (char_length(mime_type) <= 150),
  file_size       bigint not null check (file_size > 0 and file_size <= 104857600),
  kind            text check (kind is null or kind in ('image', 'video', 'audio', 'document', 'sticker', 'file')),
  width           integer check (width is null or width > 0),
  height          integer check (height is null or height > 0),
  storage_path    text not null unique,
  status          text not null default 'created' check (status in ('created', 'verified', 'used', 'cancelled')),
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null default now() + interval '2 hours',
  foreign key (conversation_id, org_id) references public.conversations (id, org_id) on delete cascade
);
create index attachment_uploads_user_idx on public.attachment_uploads (user_id, status);
create index attachment_uploads_expiry_idx on public.attachment_uploads (expires_at) where status <> 'used';
alter table public.attachment_uploads enable row level security;
revoke all on public.attachment_uploads from anon, authenticated;      -- solo se toca mediante las funciones de abajo

-- Reserva un lugar para subir un archivo a ESTA conversación (con el permiso de quien la puede responder).
create or replace function public.create_attachment_upload(p_conversation uuid, p_file_name text, p_mime text, p_size bigint) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare conv public.conversations%rowtype; v_id uuid := gen_random_uuid(); v_name text := btrim(coalesce(p_file_name, ''));
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into conv from public.conversations where id = p_conversation;
  if not found or not app.can_access_row(conv.org_id, 'conversations:update', conv.owner_id, conv.team_id) then raise exception 'not allowed' using errcode = '42501'; end if;
  if v_name = '' or char_length(v_name) > 255 then raise exception 'invalid file name' using errcode = '22023'; end if;
  if coalesce(p_size, 0) <= 0 or p_size > 104857600 then raise exception 'invalid file size' using errcode = '22023'; end if;
  -- freno: máximo 20 subidas sin usar por persona
  if (select count(*) from public.attachment_uploads where user_id = auth.uid() and status in ('created', 'verified') and expires_at > now()) >= 20 then
    raise exception 'too_many_uploads' using errcode = '23514';
  end if;
  insert into public.attachment_uploads (id, org_id, conversation_id, user_id, file_name, mime_type, file_size, storage_path)
  values (v_id, conv.org_id, conv.id, auth.uid(), v_name, left(btrim(coalesce(p_mime, '')), 150), p_size, conv.org_id || '/' || conv.id || '/' || v_id);
  return jsonb_build_object('id', v_id, 'path', conv.org_id || '/' || conv.id || '/' || v_id, 'channel_id', conv.channel_id);
end $$;

-- Cancelar una subida propia (devuelve la ruta para borrar el archivo).
create or replace function public.cancel_attachment_upload(p_id uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare v_path text;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  update public.attachment_uploads set status = 'cancelled' where id = p_id and user_id = auth.uid() and status in ('created', 'verified') returning storage_path into v_path;
  return v_path;
end $$;

-- SOLO el servidor: marca la subida como verificada tras comprobar su contenido (tipo real, tamaño, peligro, reglas del canal).
create or replace function public.verify_attachment_upload(p_id uuid, p_kind text, p_mime text, p_size bigint, p_width integer default null, p_height integer default null)
returns void language sql security definer set search_path = '' as $$
  update public.attachment_uploads set status = 'verified', kind = p_kind, mime_type = left(p_mime, 150), file_size = p_size, width = p_width, height = p_height
   where id = p_id and status = 'created' and expires_at > now()
$$;

-- Datos de una subida (solo servidor; comprueba dueño y conversación).
create or replace function public.get_attachment_upload(p_id uuid, p_user uuid, p_conversation uuid) returns jsonb
language sql security definer set search_path = '' stable as $$
  select to_jsonb(u) - 'org_id' from public.attachment_uploads u
   where u.id = p_id and u.user_id = p_user and u.conversation_id = p_conversation and u.status in ('created', 'verified') and u.expires_at > now()
$$;

-- Encola un mensaje con archivos. Mismas reglas que el texto; las subidas deben ser del que envía, de esta conversación y VERIFICADAS.
create or replace function public.queue_media_message(p_conversation uuid, p_uploads uuid[], p_caption text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  conv public.conversations%rowtype; ch public.channels%rowtype; cust public.customers%rowtype; u public.attachment_uploads%rowtype;
  v_window boolean; v_caption text := nullif(btrim(coalesce(p_caption, '')), ''); v_id uuid; v_n integer := coalesce(array_length(p_uploads, 1), 0);
  v_body text; v_pos smallint := 0; v_uid uuid; v_max integer; v_total bigint := 0;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into conv from public.conversations where id = p_conversation for update;
  if not found or not app.can_access_row(conv.org_id, 'conversations:update', conv.owner_id, conv.team_id) then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into ch from public.channels where id = conv.channel_id;
  if ch.status <> 'active' then raise exception 'channel_paused' using errcode = '23514'; end if;
  if ch.connection_status = 'disconnected' then raise exception 'connection_unavailable' using errcode = '23514'; end if;
  select * into cust from public.customers where id = conv.customer_id;
  v_window := conv.last_inbound_at is not null and conv.last_inbound_at > clock_timestamp() - case when ch.kind = 'gmail' then interval '30 days' else interval '24 hours' end;
  if not v_window then raise exception 'window_closed' using errcode = '23514'; end if;
  v_max := case when ch.kind = 'gmail' then 10 else 1 end;
  if v_n < 1 or v_n > v_max then raise exception 'attachment_count' using errcode = '22023'; end if;
  if v_caption is not null and char_length(v_caption) > 4096 then raise exception 'message_too_long' using errcode = '22023'; end if;

  -- las subidas: del que envía, de esta conversación, verificadas, sin usar y sin repetir
  if (select count(distinct x) from unnest(p_uploads) x) <> v_n then raise exception 'attachment_invalid' using errcode = '22023'; end if;
  foreach v_uid in array p_uploads loop
    select * into u from public.attachment_uploads where id = v_uid for update;
    if not found or u.user_id <> auth.uid() or u.conversation_id <> conv.id or u.status <> 'verified' or u.expires_at <= now() then
      raise exception 'attachment_invalid' using errcode = '22023';
    end if;
    v_total := v_total + u.file_size;
  end loop;
  if ch.kind = 'gmail' and v_total > 26214400 then raise exception 'attachments_too_large' using errcode = '22023'; end if;

  select * into u from public.attachment_uploads where id = p_uploads[1];
  v_body := coalesce(v_caption, case when v_n > 1 then '[' || v_n || ' adjuntos]'
                                      else '[' || case u.kind when 'image' then 'Imagen' when 'video' then 'Video' when 'audio' then 'Audio'
                                                     else 'Documento: ' || left(u.file_name, 120) end || ']' end);
  insert into public.messages (org_id, channel_id, conversation_id, direction, kind, body, status, sent_by, occurred_at)
  values (conv.org_id, conv.channel_id, conv.id, 'outbound', 'media', v_body, 'queued', auth.uid(), clock_timestamp()) returning id into v_id;

  foreach v_uid in array p_uploads loop
    select * into u from public.attachment_uploads where id = v_uid;
    insert into public.message_attachments (id, org_id, message_id, conversation_id, position, direction, kind, mime_type, file_name, file_size, width, height, storage_path, status)
    values (u.id, u.org_id, v_id, conv.id, v_pos, 'outbound', coalesce(u.kind, 'file'), u.mime_type, u.file_name, u.file_size, u.width, u.height, u.storage_path, 'stored');
    update public.attachment_uploads set status = 'used' where id = u.id;
    v_pos := v_pos + 1;
  end loop;

  update public.conversations set last_message_at = clock_timestamp(), last_direction = 'outbound', needs_reply = false, unread = false,
         last_message_preview = left(regexp_replace(v_body, '\s+', ' ', 'g'), 140) where id = conv.id;
  return v_id;
end $$;

-- La entrega necesita conocer los adjuntos del mensaje (ruta y tipo).
create or replace function public.claim_outbound(p_message uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare m public.messages%rowtype; conv public.conversations%rowtype; ch public.channels%rowtype; t public.message_templates%rowtype; v_reply jsonb; v_atts jsonb;
begin
  update public.messages set status = 'sending', attempts = attempts + 1
   where id = p_message and direction = 'outbound' and status = 'queued' returning * into m;
  if not found then return null; end if;
  select * into conv from public.conversations where id = m.conversation_id;
  select * into ch from public.channels where id = m.channel_id;
  if m.template_id is not null then select * into t from public.message_templates where id = m.template_id; end if;
  select x.meta into v_reply from public.messages x where x.conversation_id = conv.id and x.direction = 'inbound' order by x.occurred_at desc, x.created_at desc limit 1;
  select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'kind', a.kind, 'mime_type', a.mime_type, 'file_name', a.file_name, 'file_size', a.file_size, 'storage_path', a.storage_path) order by a.position), '[]'::jsonb)
    into v_atts from public.message_attachments a where a.message_id = m.id and a.status = 'stored' and a.storage_path is not null;
  return jsonb_build_object('message_id', m.id, 'kind', m.kind, 'body', m.body, 'to', conv.thread_key,
    'phone_number_id', ch.external_id, 'channel_id', ch.id, 'channel_kind', ch.kind, 'account_id', ch.external_id, 'channel_meta', ch.metadata,
    'reply_meta', coalesce(v_reply, '{}'::jsonb), 'template_name', t.name, 'template_language', t.language, 'template_params', m.template_params,
    'attachments', v_atts);
end $$;

-- Limpieza: subidas que nunca se usaron (abandonadas o canceladas). Devuelve las rutas para borrar los archivos.
create or replace function public.purge_stale_uploads(p_limit integer default 200) returns table (id uuid, storage_path text)
language plpgsql security definer set search_path = '' as $$
begin
  return query with d as (delete from public.attachment_uploads x where x.id in (select y.id from public.attachment_uploads y where y.status <> 'used' and (y.expires_at < now() or y.status = 'cancelled') order by y.expires_at limit p_limit) returning x.id, x.storage_path)
               select d.id, d.storage_path from d;
end $$;

revoke all on function public.create_attachment_upload(uuid, text, text, bigint), public.cancel_attachment_upload(uuid), public.queue_media_message(uuid, uuid[], text),
  public.verify_attachment_upload(uuid, text, text, bigint, integer, integer), public.get_attachment_upload(uuid, uuid, uuid), public.purge_stale_uploads(integer) from public, anon;
grant execute on function public.create_attachment_upload(uuid, text, text, bigint), public.cancel_attachment_upload(uuid), public.queue_media_message(uuid, uuid[], text) to authenticated, service_role;
revoke all on function public.verify_attachment_upload(uuid, text, text, bigint, integer, integer), public.get_attachment_upload(uuid, uuid, uuid), public.purge_stale_uploads(integer) from authenticated;
grant execute on function public.verify_attachment_upload(uuid, text, text, bigint, integer, integer), public.get_attachment_upload(uuid, uuid, uuid), public.purge_stale_uploads(integer) to service_role;


-- ---------------- 20260919000020_opportunity_channel_gmail.sql ----------------
-- =============================================================================
-- 0020 CORRECCIÓN: oportunidades de clientes que escribieron por Gmail
-- =============================================================================
-- Error: al crear una oportunidad, el disparador `app.opportunities_defaults` copia el TIPO DE CANAL de la última conversación del
-- cliente (`channels.kind`). Desde que existe Gmail ese tipo es «gmail», pero la restricción de `opportunities.channel` solo admite
-- «email» → crear la oportunidad de un cliente cuya última conversación fue por Gmail fallaba con un error de base de datos.
-- Arreglo: «gmail» se guarda como «email» (whatsapp, instagram y facebook ya coinciden). Mismo cuerpo que en 0015, con esa única diferencia.
-- =============================================================================
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
      -- El canal de la oportunidad usa el vocabulario comercial: un correo de Gmail es «email».
      if new.channel is null then new.channel := case when v_kind = 'gmail' then 'email' else v_kind end; end if;
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


-- ---------------- 20260919000021_webhook_stats.sql ----------------
-- =============================================================================
-- 0021 DIAGNÓSTICO DE RECEPCIÓN: qué pasa cuando Meta llama al CRM
-- =============================================================================
-- Hasta ahora, si Meta llamaba al webhook y algo fallaba (firma inválida por una clave equivocada, token de verificación distinto,
-- variable ausente), solo quedaba una línea en los registros internos de Vercel: desde el CRM era imposible saber si Meta NO llega,
-- si llega y se RECHAZA, o si llega y no se procesa. Esta tabla cuenta, por día y por resultado, cada llamada (sin guardar ningún
-- contenido, ninguna clave ni datos de clientes) para que el CRM pueda decirlo con claridad.
-- =============================================================================
create table public.webhook_stats (
  day     date        not null default current_date,
  outcome text        not null check (outcome in ('verify_ok', 'verify_rejected', 'accepted', 'bad_signature', 'no_secret', 'bad_payload')),
  hits    integer     not null default 0 check (hits >= 0),
  last_at timestamptz not null default now(),
  primary key (day, outcome)
);
alter table public.webhook_stats enable row level security;
revoke all on public.webhook_stats from anon, authenticated;       -- solo el servidor la toca, por las funciones de abajo

create or replace function public.bump_webhook_stat(p_outcome text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.webhook_stats (day, outcome, hits) values (current_date, p_outcome, 1)
  on conflict (day, outcome) do update set hits = public.webhook_stats.hits + 1, last_at = now();
  -- Limpieza barata y ocasional: solo se conservan 30 días.
  if random() < 0.02 then delete from public.webhook_stats where day < current_date - 30; end if;
end $$;

create or replace function public.webhook_stats_summary(p_days integer default 14) returns table (outcome text, hits bigint, last_at timestamptz)
language sql security definer set search_path = '' stable as $$
  select s.outcome, sum(s.hits)::bigint, max(s.last_at) from public.webhook_stats s where s.day >= current_date - greatest(p_days, 1) group by s.outcome
$$;

revoke all on function public.bump_webhook_stat(text), public.webhook_stats_summary(integer) from public, anon, authenticated;
grant execute on function public.bump_webhook_stat(text), public.webhook_stats_summary(integer) to service_role;


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

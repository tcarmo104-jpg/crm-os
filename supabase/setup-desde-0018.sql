-- =============================================================================
-- CRM OS · ACTUALIZACIÓN: migraciones 0018 en adelante (para un proyecto que YA tiene 0001 a 0017)
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
  if to_regclass('public.tasks') is null and 18 > 10 then
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
  if to_regclass('public.message_attachments') is not null then
    raise exception 'Este proyecto YA tiene instalada la migración 0018 (existe la tabla message_attachments). No ejecutes este archivo: avísame.';
  end if;
end $$;

-- ---------------- 20260919000018_message_attachments.sql ----------------
-- =============================================================================
-- 0018 ADJUNTOS DE MENSAJES (imágenes, video, audio, documentos…) + almacenamiento privado
-- =============================================================================
-- Hasta ahora un archivo recibido era solo una etiqueta de texto («[Imagen]») y datos sueltos en `messages.meta`; el archivo
-- nunca se guardaba (y el de WhatsApp caduca en Meta a los 7 días). Aquí se añade:
--   * `message_attachments`: 1 mensaje → N adjuntos, con tipo, MIME, nombre, tamaño, dimensiones, ruta en Storage, estado
--     de descarga y reintentos. Misma seguridad que `messages` (quien ve la conversación ve sus adjuntos).
--   * Bucket PRIVADO `inbox-media`: nadie lo lee ni escribe desde el navegador. Solo el servidor, que entrega enlaces
--     firmados de vida corta tras comprobar el acceso.
--   * Funciones que solo llama el servidor: registrar, reclamar (una sola vez), terminar, barrer y caducar.
--   * Recupera lo que aún se puede: los archivos de WhatsApp de los últimos 7 días quedan «pendientes» para bajarse.
-- Aditivo: nada se renombra ni se borra. `messages.meta` sigue igual (compatibilidad).
-- =============================================================================

create unique index if not exists messages_id_org_id_key on public.messages (id, org_id);

create table public.message_attachments (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null,
  message_id      uuid not null,
  conversation_id uuid not null,
  position        smallint not null default 0 check (position between 0 and 49),
  direction       text not null check (direction in ('inbound', 'outbound')),
  kind            text not null check (kind in ('image', 'video', 'audio', 'document', 'sticker', 'file', 'location', 'contact', 'unsupported')),
  mime_type       text check (mime_type is null or char_length(mime_type) <= 150),
  file_name       text check (file_name is null or char_length(file_name) <= 255),
  file_size       bigint check (file_size is null or file_size >= 0),
  width           integer check (width is null or width > 0),
  height          integer check (height is null or height > 0),
  duration_ms     integer check (duration_ms is null or duration_ms >= 0),
  is_voice        boolean not null default false,
  storage_path    text unique check (storage_path is null or char_length(storage_path) <= 400),
  sha256          text check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
  status          text not null default 'pending'
                  check (status in ('pending', 'downloading', 'stored', 'failed', 'expired', 'blocked', 'unsupported')),
  error_code      text check (error_code is null or char_length(error_code) <= 60),
  attempts        integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  source          jsonb not null default '{}'::jsonb check (jsonb_typeof(source) = 'object' and pg_column_size(source) <= 2048),
  meta            jsonb not null default '{}'::jsonb check (jsonb_typeof(meta) = 'object' and pg_column_size(meta) <= 2048),
  expires_at      timestamptz not null default now() + interval '12 months',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (message_id, position),
  foreign key (message_id, org_id) references public.messages (id, org_id) on delete cascade,
  foreign key (conversation_id, org_id) references public.conversations (id, org_id) on delete cascade
);
create index message_attachments_conv_idx on public.message_attachments (conversation_id, created_at);
create index message_attachments_due_idx on public.message_attachments (next_attempt_at) where status in ('pending', 'downloading');
create index message_attachments_expiry_idx on public.message_attachments (expires_at) where storage_path is not null;

alter table public.message_attachments enable row level security;
-- Igual que `messages_select`: se ve un adjunto si se ve su conversación (organización y alcance del usuario).
create policy message_attachments_select on public.message_attachments for select to authenticated
  using (exists (select 1 from public.conversations c where c.id = message_attachments.conversation_id));
revoke all on public.message_attachments from anon, authenticated;
grant select on public.message_attachments to authenticated;

-- ---------------------------------------------------------------------------
-- Registrar los adjuntos de un mensaje ya guardado (idempotente: se puede llamar de nuevo si el webhook se reintenta)
-- ---------------------------------------------------------------------------
create or replace function public.register_message_attachments(p_kind text, p_account text, p_external_id text, p_items jsonb)
returns integer language plpgsql security definer set search_path = '' as $$
declare m public.messages%rowtype; ch public.channels%rowtype; it jsonb; v_pos smallint := 0; v_n integer := 0; v_kind text; v_status text; v_rows integer;
begin
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) > 20 then raise exception 'invalid items' using errcode = '22023'; end if;
  select * into ch from public.channels where kind = p_kind and external_id = p_account;
  if not found then return 0; end if;
  select * into m from public.messages where channel_id = ch.id and external_id = p_external_id;
  if not found then return 0; end if;
  for it in select * from jsonb_array_elements(p_items) loop
    v_kind := case when it ->> 'kind' in ('image', 'video', 'audio', 'document', 'sticker', 'file', 'location', 'contact', 'unsupported') then it ->> 'kind' else 'unsupported' end;
    -- Ubicaciones y contactos no tienen archivo: quedan «guardados» (sus datos van en meta). Lo demás se descarga.
    v_status := case when v_kind in ('location', 'contact') then 'stored' when v_kind = 'unsupported' and not (coalesce(it -> 'source', '{}'::jsonb) ? 'url') then 'unsupported' else 'pending' end;
    insert into public.message_attachments (org_id, message_id, conversation_id, position, direction, kind, mime_type, file_name, file_size, is_voice, status, source, meta)
    values (m.org_id, m.id, m.conversation_id, v_pos, m.direction, v_kind, left(it ->> 'mime_type', 150), left(it ->> 'file_name', 255),
            nullif(it ->> 'file_size', '')::bigint, coalesce((it ->> 'is_voice')::boolean, false), v_status,
            coalesce(it -> 'source', '{}'::jsonb), coalesce(it -> 'meta', '{}'::jsonb))
    on conflict (message_id, position) do nothing;
    get diagnostics v_rows = row_count;
    v_n := v_n + v_rows; v_pos := v_pos + 1;
  end loop;
  return v_n;
end $$;

-- Reclamar un adjunto pendiente: solo UN proceso lo consigue (pasa de pending a downloading).
create or replace function public.claim_attachment(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare a public.message_attachments%rowtype; ch public.channels%rowtype; m public.messages%rowtype;
begin
  update public.message_attachments set status = 'downloading', attempts = attempts + 1, updated_at = now()
   where id = p_id and status = 'pending' and next_attempt_at <= now() returning * into a;
  if not found then return null; end if;
  select * into m from public.messages where id = a.message_id;
  select * into ch from public.channels where id = m.channel_id;
  return jsonb_build_object('id', a.id, 'org_id', a.org_id, 'conversation_id', a.conversation_id, 'kind', a.kind, 'mime_type', a.mime_type,
    'file_name', a.file_name, 'file_size', a.file_size, 'source', a.source, 'attempts', a.attempts, 'created_at', a.created_at,
    'message_at', m.occurred_at, 'channel_id', ch.id, 'channel_kind', ch.kind, 'account_id', ch.external_id, 'is_voice', a.is_voice);
end $$;

-- Terminar un intento. p_status: stored | failed | blocked | expired | retry (vuelve a la cola tras p_retry_seconds).
create or replace function public.finish_attachment(
  p_id uuid, p_status text, p_kind text default null, p_mime text default null, p_size bigint default null, p_sha text default null,
  p_path text default null, p_width integer default null, p_height integer default null, p_file_name text default null,
  p_error text default null, p_retry_seconds integer default 60
) returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_status not in ('stored', 'failed', 'blocked', 'expired', 'retry') then raise exception 'invalid status' using errcode = '22023'; end if;
  if p_status = 'stored' and (p_path is null or p_size is null) then raise exception 'stored needs path and size' using errcode = '22023'; end if;
  update public.message_attachments set
    status          = case when p_status = 'retry' then 'pending' else p_status end,
    next_attempt_at = case when p_status = 'retry' then now() + make_interval(secs => greatest(p_retry_seconds, 5)) else next_attempt_at end,
    kind            = case when p_status = 'stored' and p_kind in ('image', 'video', 'audio', 'document', 'sticker', 'file') then p_kind else kind end,
    mime_type       = case when p_status = 'stored' then coalesce(left(p_mime, 150), mime_type) else mime_type end,
    file_size       = case when p_status = 'stored' then p_size else file_size end,
    sha256          = case when p_status = 'stored' then p_sha else sha256 end,
    storage_path    = case when p_status = 'stored' then p_path else storage_path end,
    width           = case when p_status = 'stored' then p_width else width end,
    height          = case when p_status = 'stored' then p_height else height end,
    file_name       = coalesce(left(p_file_name, 255), file_name),
    error_code      = case when p_status = 'stored' then null else left(p_error, 60) end,
    updated_at      = now()
   where id = p_id and status = 'downloading';
end $$;

-- Cola: los adjuntos que toca intentar ahora. Un intento que quedó «descargando» más de 10 minutos (proceso caído) se reabre.
create or replace function public.due_attachments(p_limit integer default 5) returns setof uuid
language plpgsql security definer set search_path = '' as $$
begin
  update public.message_attachments set status = 'pending', next_attempt_at = now() where status = 'downloading' and updated_at < now() - interval '10 minutes';
  return query select a.id from public.message_attachments a where a.status = 'pending' and a.next_attempt_at <= now()
                order by a.next_attempt_at, a.created_at limit greatest(1, least(p_limit, 20));
end $$;

-- Conservación: pasado su plazo el adjunto se marca «expired» y se devuelven las rutas para borrar los archivos.
create or replace function public.expire_attachments(p_limit integer default 200) returns table (id uuid, storage_path text)
language plpgsql security definer set search_path = '' as $$
begin
  return query
    with due as (select a.id, a.storage_path from public.message_attachments a where a.expires_at < now() and a.storage_path is not null order by a.expires_at limit p_limit),
         upd as (update public.message_attachments x set status = 'expired', storage_path = null, error_code = 'retention', updated_at = now() from due where x.id = due.id returning x.id)
    select due.id, due.storage_path from due join upd on upd.id = due.id;
end $$;

revoke all on function public.register_message_attachments(text, text, text, jsonb), public.claim_attachment(uuid),
  public.finish_attachment(uuid, text, text, text, bigint, text, text, integer, integer, text, text, integer),
  public.due_attachments(integer), public.expire_attachments(integer) from public, anon, authenticated;
grant execute on function public.register_message_attachments(text, text, text, jsonb), public.claim_attachment(uuid),
  public.finish_attachment(uuid, text, text, text, bigint, text, text, integer, integer, text, text, integer),
  public.due_attachments(integer), public.expire_attachments(integer) to service_role;

-- ---------------------------------------------------------------------------
-- Recuperar lo que todavía se puede bajar de Meta
--   WhatsApp: el identificador del archivo en el webhook caduca a los 7 días → lo reciente queda «pendiente»; lo anterior, «expirado».
--   Facebook / Instagram: se guardó el enlace temporal → pendiente en los últimos 30 días; lo anterior, «expirado».
-- ---------------------------------------------------------------------------
insert into public.message_attachments (org_id, message_id, conversation_id, position, direction, kind, mime_type, file_name, status, error_code, source)
select m.org_id, m.id, m.conversation_id, 0, m.direction,
       case when m.meta ->> 'type' in ('image', 'video', 'audio', 'document', 'sticker') then m.meta ->> 'type' else 'file' end,
       left(m.meta ->> 'mime_type', 150), left(substring(m.body from '^\[Documento: (.+?)\]'), 255),
       case when m.occurred_at < now() - interval '7 days' then 'expired' else 'pending' end,
       case when m.occurred_at < now() - interval '7 days' then 'expired_at_channel' end,
       jsonb_build_object('media_id', m.meta ->> 'media_id')
  from public.messages m join public.channels ch on ch.id = m.channel_id
 where m.kind = 'media' and m.direction = 'inbound' and ch.kind = 'whatsapp' and coalesce(m.meta ->> 'media_id', '') <> ''
on conflict (message_id, position) do nothing;

insert into public.message_attachments (org_id, message_id, conversation_id, position, direction, kind, status, error_code, source)
select m.org_id, m.id, m.conversation_id, (a.ord - 1)::smallint, m.direction,
       case a.item ->> 'type' when 'image' then 'image' when 'video' then 'video' when 'audio' then 'audio' else 'file' end,
       case when m.occurred_at < now() - interval '30 days' then 'expired' else 'pending' end,
       case when m.occurred_at < now() - interval '30 days' then 'expired_at_channel' end,
       jsonb_build_object('url', a.item ->> 'url')
  from public.messages m join public.channels ch on ch.id = m.channel_id,
       lateral jsonb_array_elements(case when jsonb_typeof(m.meta -> 'attachments') = 'array' then m.meta -> 'attachments' else '[]'::jsonb end) with ordinality as a(item, ord)
 where m.kind = 'media' and m.direction = 'inbound' and ch.kind in ('facebook', 'instagram') and coalesce(a.item ->> 'url', '') like 'https://%' and a.ord <= 20
on conflict (message_id, position) do nothing;

-- ---------------------------------------------------------------------------
-- Almacenamiento privado (solo existe en Supabase; en una base sin Storage se omite sin error)
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('inbox-media', 'inbox-media', false, 104857600, array[
      'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic', 'image/heif',
      'video/mp4', 'video/quicktime', 'video/webm', 'video/3gpp', 'video/ogg', 'video/x-msvideo',
      'audio/aac', 'audio/mp4', 'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/webm', 'audio/amr', 'audio/x-m4a',
      'application/pdf', 'application/msword', 'application/vnd.ms-excel', 'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'text/plain', 'text/csv', 'application/zip', 'application/rtf', 'application/octet-stream'])
    on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
  end if;
exception when others then
  raise warning 'No se pudo crear el bucket inbox-media (%). Créalo a mano en Storage: privado, límite 100 MB.', sqlerrm;
end $$;

-- Cinturón y tirantes: aunque exista alguna política permisiva en Storage, NINGÚN usuario del navegador (ni anónimo) toca este bucket.
do $$
begin
  if to_regclass('storage.objects') is not null then
    drop policy if exists "inbox-media: solo el servidor" on storage.objects;
    create policy "inbox-media: solo el servidor" on storage.objects as restrictive for all to anon, authenticated
      using (bucket_id <> 'inbox-media') with check (bucket_id <> 'inbox-media');
  end if;
exception when others then
  raise warning 'No se pudo crear la política restrictiva de inbox-media (%). Revisa en Storage → Policies que ningún usuario pueda leer ese bucket.', sqlerrm;
end $$;

commit;

-- Comprobación final: 'tablas' y 'tablas_con_rls' deben ser iguales.
select 'LISTO' as estado,
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r') as tablas,
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity) as tablas_con_rls,
  (select count(*) from public.permissions) as permisos,
  (select count(*) from public.roles where org_id is null) as roles_base;

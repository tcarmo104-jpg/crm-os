-- =============================================================================
-- CRM OS · ACTUALIZACIÓN: migraciones 0032 en adelante (para un proyecto que YA tiene 0001 a 0031)
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
  if to_regclass('public.tasks') is null and 32 > 10 then
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
  if to_regclass('public.social_comments') is not null then
    raise exception 'Este proyecto YA tiene instalada la migración 0032 (existe la tabla social_comments). No ejecutes este archivo: avísame.';
  end if;
end $$;

-- ---------------- 20260919000032_social_comments.sql ----------------
-- =============================================================================
-- 0032 COMENTARIOS DE FACEBOOK E INSTAGRAM (módulo nuevo, separado del Inbox)
-- =============================================================================
-- Un comentario es público y vive debajo de una publicación — no es una conversación privada uno a uno,
-- así que no entra en las tablas del Inbox. Vive en sus propias tablas, con sus propios permisos.
--
-- Meta entrega los comentarios de Facebook dentro del webhook `feed` (item=comment) y los de Instagram en
-- el webhook `comments` — ninguno de los dos pasa por el webhook de mensajería que ya existe.
--
-- La respuesta PRIVADA a un comentario usa el mismo endpoint que ya se usa para enviar mensajes de
-- Messenger/Instagram (`/PAGE-ID/messages`, con `recipient.comment_id` en vez de `recipient.id`), así que
-- al enviarla también se registra como un mensaje saliente normal: cae en el Inbox de siempre.
-- =============================================================================

insert into public.permissions (key, description) values
  ('comments:read',   'Ver comentarios de Facebook e Instagram'),
  ('comments:manage', 'Responder, ocultar y eliminar comentarios');

insert into public.role_permissions (role_id, permission_key, scope)
select r.id, p.key, 'org' from public.roles r, (values ('comments:read'), ('comments:manage')) as p(key)
where r.org_id is null and r.key in ('super_admin', 'admin', 'manager', 'marketing', 'customer_service')
on conflict (role_id, permission_key) do update set scope = excluded.scope;

create table public.social_posts (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organizations(id) on delete cascade,
  channel_id      uuid not null references public.channels(id) on delete cascade,
  external_id     text not null check (external_id ~ '^[0-9_]{3,60}$'),
  permalink       text check (permalink is null or char_length(permalink) <= 500),
  caption         text check (caption is null or char_length(caption) <= 2000),
  posted_at       timestamptz,
  created_at      timestamptz not null default now(),
  unique (channel_id, external_id)
);
create index social_posts_org_idx on public.social_posts (org_id, created_at desc);

create table public.social_comments (
  id                    uuid primary key default gen_random_uuid(),
  org_id                uuid not null references public.organizations(id) on delete cascade,
  channel_id            uuid not null references public.channels(id) on delete cascade,
  post_id               uuid references public.social_posts(id) on delete set null,
  external_id           text not null check (external_id ~ '^[0-9_]{3,60}$'),
  parent_external_id    text,
  customer_id           uuid references public.customers(id) on delete set null,
  author_name           text not null default 'Alguien' check (char_length(author_name) <= 160),
  author_external_id    text not null check (author_external_id ~ '^[0-9]{3,40}$'),
  message               text check (message is null or char_length(message) <= 4000),
  status                text not null default 'visible' check (status in ('visible', 'hidden', 'deleted')),
  occurred_at           timestamptz not null,
  replied_publicly_at   timestamptz,
  replied_publicly_text text check (replied_publicly_text is null or char_length(replied_publicly_text) <= 2000),
  private_reply_at      timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (channel_id, external_id)
);
create index social_comments_org_idx on public.social_comments (org_id, occurred_at desc);
create index social_comments_post_idx on public.social_comments (post_id, occurred_at);
create trigger social_comments_touch before update on public.social_comments for each row execute function app.touch_updated_at();

insert into app.customer_merge_targets values ('social_comments');

revoke all on public.social_posts, public.social_comments from anon, authenticated;
grant select on public.social_posts, public.social_comments to authenticated;
grant all on public.social_posts, public.social_comments to service_role;

alter table public.social_posts enable row level security;
alter table public.social_comments enable row level security;

create policy social_posts_select on public.social_posts for select to authenticated
  using ((select app.has_permission(org_id, 'comments:read')));
create policy social_comments_select on public.social_comments for select to authenticated
  using ((select app.has_permission(org_id, 'comments:read')));

-- ---------------------------------------------------------------------------------------------- ingesta (webhook)
-- Guarda (o actualiza) un comentario que llegó por el webhook. `p_verb`: add | edit | remove. Crea la
-- publicación la primera vez que se ve (sin pedirle nada a Meta todavía; el permalink/caption se completan
-- después, bajo demanda, cuando alguien abre esa publicación en el CRM).
create or replace function public.ingest_social_comment(
  p_kind text, p_account_id text, p_post_external_id text, p_comment_external_id text, p_parent_external_id text,
  p_author_id text, p_author_name text, p_message text, p_verb text, p_occurred_at timestamptz
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  ch public.channels%rowtype; post public.social_posts%rowtype; cust_id uuid; v_status text;
begin
  if p_kind not in ('facebook', 'instagram') then raise exception 'invalid kind' using errcode = '22023'; end if;
  select * into ch from public.channels where kind = p_kind and external_id = p_account_id;
  if not found then return jsonb_build_object('ok', false, 'reason', 'unknown_channel'); end if;

  insert into public.social_posts (org_id, channel_id, external_id)
  values (ch.org_id, ch.id, p_post_external_id)
  on conflict (channel_id, external_id) do nothing;
  select * into post from public.social_posts where channel_id = ch.id and external_id = p_post_external_id;

  select c.id into cust_id from public.customers c
    join public.customer_identifiers ci on ci.customer_id = c.id
    where c.org_id = ch.org_id and ci.type = p_kind and ci.value = p_author_id limit 1;

  v_status := case when p_verb = 'remove' then 'deleted' else 'visible' end;

  insert into public.social_comments (org_id, channel_id, post_id, external_id, parent_external_id, customer_id,
    author_name, author_external_id, message, status, occurred_at)
  values (ch.org_id, ch.id, post.id, p_comment_external_id, nullif(p_parent_external_id, ''), cust_id,
    coalesce(nullif(btrim(p_author_name), ''), 'Alguien'), p_author_id, p_message, v_status, p_occurred_at)
  on conflict (channel_id, external_id) do update set
    message = case when p_verb = 'remove' then public.social_comments.message else excluded.message end,
    status = excluded.status;

  perform app.emit_event(ch.org_id, 'comment.received', 'social_comment',
    (select id from public.social_comments where channel_id = ch.id and external_id = p_comment_external_id),
    jsonb_build_object('kind', p_kind, 'verb', p_verb), cust_id);
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------------------------------------- acciones (app)
-- El servidor llama a Meta primero; solo si Meta confirma, llama a esto para guardar el resultado localmente.
create or replace function public.set_comment_status(p_comment_id uuid, p_status text) returns void
language plpgsql security definer set search_path = '' as $$
declare c public.social_comments%rowtype;
begin
  if p_status not in ('visible', 'hidden', 'deleted') then raise exception 'invalid status' using errcode = '22023'; end if;
  select * into c from public.social_comments where id = p_comment_id;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if not app.has_permission(c.org_id, 'comments:manage') then raise exception 'not allowed' using errcode = '42501'; end if;
  update public.social_comments set status = p_status where id = p_comment_id;
end $$;

create or replace function public.record_comment_reply(p_comment_id uuid, p_kind text, p_text text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare c public.social_comments%rowtype;
begin
  if p_kind not in ('public', 'private') then raise exception 'invalid kind' using errcode = '22023'; end if;
  select * into c from public.social_comments where id = p_comment_id;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if not app.has_permission(c.org_id, 'comments:manage') then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_kind = 'public' then
    update public.social_comments set replied_publicly_at = now(), replied_publicly_text = left(btrim(coalesce(p_text, '')), 2000) where id = p_comment_id;
  else
    update public.social_comments set private_reply_at = now() where id = p_comment_id;
  end if;
end $$;

revoke all on function public.ingest_social_comment(text, text, text, text, text, text, text, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.ingest_social_comment(text, text, text, text, text, text, text, text, text, timestamptz) to service_role;
revoke all on function public.set_comment_status(uuid, text), public.record_comment_reply(uuid, text, text) from public, anon;
grant execute on function public.set_comment_status(uuid, text), public.record_comment_reply(uuid, text, text) to authenticated, service_role;


-- ---------------- 20260919000033_comment_private_reply_inbox.sql ----------------
-- =============================================================================
-- 0033 LA RESPUESTA PRIVADA A UN COMENTARIO CAE EN EL INBOX
-- =============================================================================
-- Una respuesta privada usa el mismo buzón de mensajes que Messenger/Instagram Direct, así que debe
-- comportarse igual: si es la primera vez que esa persona aparece, se le crea su cliente y su conversación
-- (igual que `ingest_channel_message` para un mensaje entrante, pero este es el primer mensaje SALIENTE,
-- no uno entrante). Si ya tenía una conversación abierta, el mensaje se agrega ahí.
--
-- `record_comment_reply` cambia su tipo de retorno (antes `void`, ahora devuelve el id del mensaje para una
-- respuesta privada, o null para una pública): hay que borrarla y crearla de nuevo.
-- =============================================================================

drop function if exists public.record_comment_reply(uuid, text, text);

create function public.record_comment_reply(p_comment_id uuid, p_kind text, p_text text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  c public.social_comments%rowtype; ch public.channels%rowtype; conv public.conversations%rowtype; cust public.customers%rowtype;
  v_text text := left(btrim(coalesce(p_text, '')), 2000); v_res jsonb; v_ident jsonb; v_msg uuid;
  v_label text; v_thread text;
begin
  if p_kind not in ('public', 'private') then raise exception 'invalid kind' using errcode = '22023'; end if;
  select * into c from public.social_comments where id = p_comment_id;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if not app.has_permission(c.org_id, 'comments:manage') then raise exception 'not allowed' using errcode = '42501'; end if;

  if p_kind = 'public' then
    if v_text = '' then raise exception 'empty_message' using errcode = '22023'; end if;
    update public.social_comments set replied_publicly_at = now(), replied_publicly_text = v_text where id = p_comment_id;
    return null;
  end if;

  -- Privada: cae en el Inbox, como cualquier mensaje saliente de Messenger/Instagram Direct.
  if v_text = '' then raise exception 'empty_message' using errcode = '22023'; end if;
  select * into ch from public.channels where id = c.channel_id;
  v_thread := c.author_external_id;
  v_label := case when ch.kind = 'instagram' then 'Instagram' else 'Facebook' end;

  select * into conv from public.conversations where channel_id = ch.id and thread_key = v_thread for update;
  if not found then
    v_ident := jsonb_build_array(jsonb_build_object('type', ch.kind, 'value', v_thread));
    v_res := app.ingest_lead_core(ch.org_id, jsonb_build_object(
      'source', ch.kind, 'channel', ch.kind, 'name', c.author_name, 'identifiers', v_ident,
      'external_id', ch.kind || ':' || v_thread), null, auth.uid());
    select * into cust from public.customers where id = (v_res ->> 'customer_id')::uuid;
    insert into public.conversations (org_id, channel_id, customer_id, thread_key, contact_name, owner_id, team_id)
    values (ch.org_id, ch.id, cust.id, v_thread, c.author_name, cust.owner_id, cust.team_id) returning * into conv;
    perform app.emit_event(ch.org_id, 'conversation.opened', 'conversation', conv.id, jsonb_build_object('channel', ch.kind, 'via', 'comment_private_reply'), cust.id);
  end if;

  -- Se guarda ya como «enviado»: a esta función solo se llega DESPUÉS de que Meta confirmó el envío (la
  -- respuesta privada usa un endpoint distinto al de cualquier otro mensaje saliente, así que nunca debe
  -- pasar por el despachador genérico de envíos pendientes, que reintentaría con el método equivocado).
  insert into public.messages (org_id, channel_id, conversation_id, direction, kind, body, status, sent_by, occurred_at)
  values (ch.org_id, ch.id, conv.id, 'outbound', 'text', v_text, 'sent', auth.uid(), clock_timestamp()) returning id into v_msg;

  update public.conversations set status = 'open', last_message_at = clock_timestamp(), last_direction = 'outbound', needs_reply = false,
    last_message_preview = left(regexp_replace(v_text, '\s+', ' ', 'g'), 140) where id = conv.id;

  update public.social_comments set private_reply_at = now() where id = p_comment_id;
  return v_msg;
end $$;

revoke all on function public.record_comment_reply(uuid, text, text) from public, anon;
grant execute on function public.record_comment_reply(uuid, text, text) to authenticated, service_role;

commit;

-- Comprobación final: 'tablas' y 'tablas_con_rls' deben ser iguales.
select 'LISTO' as estado,
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r') as tablas,
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity) as tablas_con_rls,
  (select count(*) from public.permissions) as permisos,
  (select count(*) from public.roles where org_id is null) as roles_base;

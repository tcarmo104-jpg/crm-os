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

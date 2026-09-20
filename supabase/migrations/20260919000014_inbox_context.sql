-- =============================================================================
-- 0014 INBOX: contexto del cliente (etiquetas), respuestas rápidas y contador de no leídos
-- =============================================================================
-- Reglas que viven en la base de datos:
--   * Una etiqueta es única por organización sin distinguir mayúsculas ni espacios extremos.
--   * Etiquetar/quitar etiqueta exige poder EDITAR a ese cliente (alcance por dueño/equipo).
--   * Agregar una etiqueta es idempotente y seguro con concurrencia (nunca duplica).
--   * Al fusionar clientes, las etiquetas se unen sin duplicarse.
--   * El contador de no leídos suma con cada mensaje entrante y vuelve a 0 al responder,
--     marcar como leída o cerrar; nunca es negativo.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Contador de no leídos
-- ---------------------------------------------------------------------------
alter table public.conversations add column unread_count int not null default 0 check (unread_count >= 0);
update public.conversations set unread_count = 1 where unread;

create or replace function app.messages_count_unread() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.conversations set unread_count = unread_count + 1, unread = true where id = new.conversation_id;
  return null;
end $$;
create trigger messages_count_unread_trg after insert on public.messages
  for each row when (new.direction = 'inbound') execute function app.messages_count_unread();

create or replace function app.conversations_unread_sync() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not new.unread then new.unread_count := 0; end if;
  if new.unread and new.unread_count = 0 then new.unread_count := 1; end if;
  return new;
end $$;
create trigger conversations_unread_sync_trg before update on public.conversations
  for each row execute function app.conversations_unread_sync();

-- ---------------------------------------------------------------------------
-- Etiquetas
-- ---------------------------------------------------------------------------
create table public.tags (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.organizations(id) on delete cascade,
  name       text not null check (char_length(btrim(name)) between 1 and 40),
  color      text not null default 'violet' check (color in ('violet', 'blue', 'teal', 'green', 'yellow', 'orange', 'red', 'pink', 'gray')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (id, org_id)
);
create unique index tags_name_uk on public.tags (org_id, (lower(btrim(name))));

create table public.customer_tags (
  org_id      uuid not null,
  customer_id uuid not null,
  tag_id      uuid not null,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  primary key (customer_id, tag_id),
  foreign key (customer_id, org_id) references public.customers (id, org_id) on delete cascade,
  foreign key (tag_id, org_id)      references public.tags (id, org_id) on delete cascade
);
create index customer_tags_tag_idx on public.customer_tags (tag_id);

-- Al fusionar clientes (UPDATE de customer_id), si el principal ya tiene la etiqueta se descarta la repetida.
create or replace function app.customer_tags_merge_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.customer_id <> old.customer_id
     and exists (select 1 from public.customer_tags x where x.customer_id = new.customer_id and x.tag_id = new.tag_id) then
    delete from public.customer_tags where customer_id = old.customer_id and tag_id = old.tag_id;
    return null;
  end if;
  return new;
end $$;
create trigger customer_tags_merge_guard_trg before update on public.customer_tags
  for each row execute function app.customer_tags_merge_guard();
insert into app.customer_merge_targets values ('customer_tags');

create or replace function public.add_customer_tag(p_customer uuid, p_name text, p_color text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  c public.customers%rowtype; v_name text := btrim(coalesce(p_name, '')); v_tag uuid; v_color text;
  v_palette text[] := array['violet', 'blue', 'teal', 'green', 'yellow', 'orange', 'red', 'pink'];
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into c from public.customers where id = p_customer and deleted_at is null;
  if not found or not app.can_access_row(c.org_id, 'customers:update', c.owner_id, c.team_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if char_length(v_name) < 1 or char_length(v_name) > 40 then raise exception 'tag_name' using errcode = '22023'; end if;
  v_color := coalesce(nullif(btrim(coalesce(p_color, '')), ''), v_palette[1 + abs(hashtext(lower(v_name))) % 8]);
  if v_color not in ('violet', 'blue', 'teal', 'green', 'yellow', 'orange', 'red', 'pink', 'gray') then
    raise exception 'tag_color' using errcode = '22023';
  end if;

  select id into v_tag from public.tags where org_id = c.org_id and lower(btrim(name)) = lower(v_name);
  if v_tag is null then
    insert into public.tags (org_id, name, color, created_by) values (c.org_id, v_name, v_color, auth.uid())
    on conflict (org_id, (lower(btrim(name)))) do nothing returning id into v_tag;
    if v_tag is null then   -- otra sesión la creó justo ahora
      select id into v_tag from public.tags where org_id = c.org_id and lower(btrim(name)) = lower(v_name);
    end if;
  end if;
  insert into public.customer_tags (org_id, customer_id, tag_id, created_by) values (c.org_id, c.id, v_tag, auth.uid())
  on conflict (customer_id, tag_id) do nothing;
  return v_tag;
end $$;

create or replace function public.remove_customer_tag(p_customer uuid, p_tag uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare c public.customers%rowtype;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into c from public.customers where id = p_customer;
  if not found or not app.can_access_row(c.org_id, 'customers:update', c.owner_id, c.team_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  delete from public.customer_tags where customer_id = p_customer and tag_id = p_tag and org_id = c.org_id;
end $$;

-- ---------------------------------------------------------------------------
-- Respuestas rápidas
-- ---------------------------------------------------------------------------
create table public.quick_replies (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.organizations(id) on delete cascade,
  title      text not null check (char_length(btrim(title)) between 1 and 60),
  body       text not null check (char_length(btrim(body)) between 1 and 1000),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (id, org_id)
);
create unique index quick_replies_title_uk on public.quick_replies (org_id, (lower(btrim(title))));

create or replace function public.create_quick_reply(p_org uuid, p_title text, p_body text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not app.has_permission(p_org, 'conversations:update') then raise exception 'not allowed' using errcode = '42501'; end if;
  insert into public.quick_replies (org_id, title, body, created_by) values (p_org, btrim(p_title), btrim(p_body), auth.uid())
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.delete_quick_reply(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare q public.quick_replies%rowtype;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into q from public.quick_replies where id = p_id;
  if not found then return; end if;
  if not (q.created_by = auth.uid() and app.has_permission(q.org_id, 'conversations:update'))
     and not app.has_permission(q.org_id, 'settings:manage') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  delete from public.quick_replies where id = p_id;
end $$;

-- ---------------------------------------------------------------------------
-- Privilegios + RLS + auditoría
-- ---------------------------------------------------------------------------
revoke all on public.tags, public.customer_tags, public.quick_replies from anon, authenticated;
grant select on public.tags, public.customer_tags, public.quick_replies to authenticated;
grant all on public.tags, public.customer_tags, public.quick_replies to service_role;

alter table public.tags          enable row level security;
alter table public.customer_tags enable row level security;
alter table public.quick_replies enable row level security;

create policy tags_select on public.tags for select to authenticated
  using ((select app.has_permission(org_id, 'customers:read')));
create policy customer_tags_select on public.customer_tags for select to authenticated
  using (exists (select 1 from public.customers c where c.id = customer_id));
create policy quick_replies_select on public.quick_replies for select to authenticated
  using ((select app.has_permission(org_id, 'conversations:update')) or (select app.has_permission(org_id, 'settings:manage')));

create trigger tags_audit          after insert or update or delete on public.tags          for each row execute function app.audit_row_change();
create trigger quick_replies_audit after insert or update or delete on public.quick_replies for each row execute function app.audit_row_change();

revoke all on function app.messages_count_unread(), app.conversations_unread_sync(), app.customer_tags_merge_guard() from public, anon, authenticated;
revoke all on function public.add_customer_tag(uuid, text, text), public.remove_customer_tag(uuid, uuid),
  public.create_quick_reply(uuid, text, text), public.delete_quick_reply(uuid) from public, anon;
grant execute on function public.add_customer_tag(uuid, text, text), public.remove_customer_tag(uuid, uuid),
  public.create_quick_reply(uuid, text, text), public.delete_quick_reply(uuid) to authenticated, service_role;

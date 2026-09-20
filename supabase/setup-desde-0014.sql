-- =============================================================================
-- CRM OS · ACTUALIZACIÓN: migraciones 0014 en adelante (para un proyecto que YA tiene 0001 a 0013)
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
  if to_regclass('public.tasks') is null and 14 > 10 then
    raise exception 'FALTAN las migraciones de la Fase 3 (0009 y 0010). Avísame para darte el archivo correcto.';
  end if;
  if to_regclass('public.conversations') is null then
    raise exception 'FALTA la migración 0013 (Inbox de WhatsApp). Instala primero setup-desde-0013.sql o avísame.';
  end if;
  if to_regclass('public.tags') is not null then
    raise exception 'Este proyecto YA tiene instalada la migración 0014 (existe la tabla tags). No ejecutes este archivo: avísame.';
  end if;
end $$;

-- ---------------- 20260919000014_inbox_context.sql ----------------
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


-- ---------------- 20260919000015_opportunities_kanban.sql ----------------
-- =============================================================================
-- 0015 OPORTUNIDADES (tablero Kanban): número, prioridad, temperatura, canal y vínculo con la conversación
-- =============================================================================
-- Reglas que viven en la base de datos:
--   * Cada oportunidad tiene un número correlativo por organización (OPP-0001…), sin repetidos ni huecos
--     aunque se creen muchas a la vez, y NADIE lo puede cambiar.
--   * Prioridad (alta/media/baja; por defecto media) y temperatura (fría/tibia/caliente; opcional) son
--     independientes de la etapa. Solo quien puede editar la oportunidad las cambia.
--   * Una oportunidad puede apuntar a la conversación original, pero SOLO a una conversación del MISMO cliente.
--     Al crearla se enlaza sola a la conversación más reciente del cliente (si existe).
--   * Etapas por defecto: Nueva · Contactado · Calificada · Cotización · Negociación · Ganada · Perdida.
--     Los pipelines existentes se actualizan SOLO si conservan exactamente las etapas originales sin tocar.
-- =============================================================================

alter table public.opportunities
  add column number         text,
  add column priority       text not null default 'medium' check (priority in ('low', 'medium', 'high')),
  add column temperature    text check (temperature in ('cold', 'warm', 'hot')),
  add column channel        text check (channel in ('whatsapp', 'instagram', 'facebook', 'email', 'phone', 'web', 'referral', 'other')),
  add column conversation_id uuid;

alter table public.opportunities
  add constraint opportunities_conversation_fk foreign key (conversation_id, org_id)
  references public.conversations (id, org_id) on delete set null (conversation_id);

-- Número correlativo: se reparte en orden de creación a las existentes (el contador avanza con cada una).
do $$
declare r record;
begin
  for r in select id, org_id from public.opportunities order by created_at, id loop
    update public.opportunities set number = 'OPP-' || lpad(app.next_number(r.org_id, 'opportunity')::text, 4, '0') where id = r.id;
  end loop;
end $$;
alter table public.opportunities alter column number set not null;
create unique index opportunities_number_uk on public.opportunities (org_id, number);
create index opportunities_conversation_idx on public.opportunities (conversation_id) where conversation_id is not null;

-- Canal de las que nacieron de un lead (solo valores que reconocemos) y conversación más reciente del cliente.
update public.opportunities o set channel = lower(btrim(l.channel))
  from public.leads l
 where l.converted_opportunity_id = o.id and o.channel is null
   and lower(btrim(l.channel)) in ('whatsapp', 'instagram', 'facebook', 'email', 'phone', 'web', 'referral', 'other');
with latest as (
  select distinct on (c.customer_id) c.customer_id, c.id as conversation_id, c.channel_id
    from public.conversations c order by c.customer_id, c.last_message_at desc nulls last, c.created_at desc
)
update public.opportunities o
   set conversation_id = l.conversation_id,
       channel = coalesce(o.channel, (select ch.kind from public.channels ch where ch.id = l.channel_id))
  from latest l where l.customer_id = o.customer_id and o.conversation_id is null;

-- Número, conversación por defecto y coherencia de la conversación con el cliente.
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
      if new.channel is null then new.channel := v_kind; end if;
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
create trigger opportunities_defaults_trg before insert or update on public.opportunities
  for each row execute function app.opportunities_defaults();

-- Vincular / desvincular la conversación original.
create or replace function public.link_opportunity_conversation(p_opportunity uuid, p_conversation uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare o public.opportunities%rowtype;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into o from public.opportunities where id = p_opportunity for update;
  if not found or not app.can_access_row(o.org_id, 'opportunities:update', o.owner_id, o.team_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update public.opportunities set conversation_id = p_conversation where id = o.id;
end $$;

grant update (priority, temperature, channel) on public.opportunities to authenticated;

-- ---------------------------------------------------------------------------
-- Etapas por defecto (pipelines nuevos) y actualización conservadora de los existentes
-- ---------------------------------------------------------------------------
create or replace function app.add_default_stages(p_org uuid, p_pipe uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.pipeline_stages (org_id, pipeline_id, name, kind, position, probability) values
    (p_org, p_pipe, 'Nueva',       'open', 10, 10),
    (p_org, p_pipe, 'Contactado',  'open', 20, 25),
    (p_org, p_pipe, 'Calificada',  'open', 30, 40),
    (p_org, p_pipe, 'Cotización',  'open', 40, 60),
    (p_org, p_pipe, 'Negociación', 'open', 50, 80),
    (p_org, p_pipe, 'Ganada',      'won',  10, 100),
    (p_org, p_pipe, 'Perdida',     'lost', 10, 0);
end $$;

-- Solo toca pipelines que tienen EXACTAMENTE las etapas originales (Nuevo, Contactado, Propuesta, Negociación,
-- Ganada, Perdida): si alguien ya las personalizó, no se cambia nada. Es idempotente.
create or replace function app.upgrade_legacy_default_stages() returns int
language plpgsql security definer set search_path = '' as $$
declare p record; v_n int := 0;
begin
  for p in
    select pl.id, pl.org_id from public.pipelines pl
     where pl.archived_at is null
       and (select array_agg(s.name order by s.position) from public.pipeline_stages s
             where s.pipeline_id = pl.id and s.kind = 'open' and s.archived_at is null) = array['Nuevo', 'Contactado', 'Propuesta', 'Negociación']
       and (select count(*) from public.pipeline_stages s where s.pipeline_id = pl.id and s.archived_at is null) = 6
       and exists (select 1 from public.pipeline_stages s where s.pipeline_id = pl.id and s.kind = 'won' and s.name = 'Ganada' and s.archived_at is null)
       and exists (select 1 from public.pipeline_stages s where s.pipeline_id = pl.id and s.kind = 'lost' and s.name = 'Perdida' and s.archived_at is null)
  loop
    update public.pipeline_stages set name = 'Nueva'      where pipeline_id = p.id and kind = 'open' and name = 'Nuevo';
    update public.pipeline_stages set name = 'Cotización' where pipeline_id = p.id and kind = 'open' and name = 'Propuesta';
    insert into public.pipeline_stages (org_id, pipeline_id, name, kind, position, probability) values (p.org_id, p.id, 'Calificada', 'open', 25, 40);
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;
select app.upgrade_legacy_default_stages();

revoke all on function app.opportunities_defaults(), app.upgrade_legacy_default_stages() from public, anon, authenticated;
revoke all on function public.link_opportunity_conversation(uuid, uuid) from public, anon;
grant execute on function public.link_opportunity_conversation(uuid, uuid) to authenticated, service_role;

commit;

-- Comprobación final: 'tablas' y 'tablas_con_rls' deben ser iguales.
select 'LISTO' as estado,
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r') as tablas,
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity) as tablas_con_rls,
  (select count(*) from public.permissions) as permisos,
  (select count(*) from public.roles where org_id is null) as roles_base;

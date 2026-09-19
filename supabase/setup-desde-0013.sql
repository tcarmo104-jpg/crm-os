-- =============================================================================
-- CRM OS · ACTUALIZACIÓN: migraciones 0013 en adelante (para un proyecto que YA tiene 0001 a 0012)
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
  if to_regclass('public.tasks') is null and 13 > 10 then
    raise exception 'FALTAN las migraciones de la Fase 3 (0009 y 0010). Avísame para darte el archivo correcto.';
  end if;
  if to_regclass('public.sales') is null then
    raise exception 'FALTAN las migraciones de la Fase 4 (0011 y 0012). Instala primero setup-desde-0011.sql o avísame.';
  end if;
  if to_regclass('public.channels') is not null then
    raise exception 'Este proyecto YA tiene instalada la migración 0013 (existe la tabla channels). No ejecutes este archivo: avísame.';
  end if;
end $$;

-- ---------------- 20260919000013_inbox_whatsapp.sql ----------------
-- =============================================================================
-- 0013 INBOX OMNICANAL (WhatsApp Cloud API)
-- =============================================================================
-- Flujo: webhook firmado → raw_events (durable) → normalización → resolución de identidad
--        → conversación → mensaje. Envío: cola en BD → reclamo atómico → API de Meta.
-- Reglas que viven en la base de datos:
--   * Un mensaje entrante se registra UNA sola vez (dedupe por id externo), aunque Meta reintente
--     o lleguen en paralelo.
--   * Un contacto nuevo nace como cliente + lead (misma resolución de identidad de la Fase 2).
--   * Solo se envía texto libre dentro de las 24 h posteriores al último mensaje del cliente;
--     fuera de esa ventana, solo plantillas aprobadas.
--   * «No contactar»: bloquea plantillas y mensajes proactivos; solo se permite RESPONDER dentro
--     de la ventana a un cliente que acaba de escribir.
--   * Los mensajes son de solo-anexar; los estados solo avanzan (enviado → entregado → leído).
--   * Envío «como máximo una vez»: un mensaje con resultado desconocido NO se reenvía solo.
--   * Los tokens de acceso están en una tabla que ningún usuario (ni admin) puede leer.
--   * Solo lo que Meta firmó con el App Secret entra (verificado en el servidor, antes de esto).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Canales y credenciales
-- ---------------------------------------------------------------------------
create table public.channels (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id) on delete cascade,
  kind          text not null default 'whatsapp' check (kind in ('whatsapp')),
  name          text not null check (char_length(btrim(name)) between 1 and 80),
  external_id   text not null check (external_id ~ '^[0-9]{5,30}$'),          -- phone_number_id de Meta
  display_phone text check (char_length(display_phone) <= 30),
  status        text not null default 'active' check (status in ('active', 'paused')),
  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (id, org_id),
  unique (kind, external_id)          -- el webhook se enruta por este id: no puede repetirse entre organizaciones
);

create table public.channel_secrets (
  channel_id   uuid primary key references public.channels(id) on delete cascade,
  access_token text not null check (char_length(access_token) between 20 and 2000),
  updated_at   timestamptz not null default now(),
  updated_by   uuid references auth.users(id) on delete set null
);

create table public.message_templates (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  channel_id  uuid not null,
  name        text not null check (name ~ '^[a-z0-9_]{1,200}$'),                -- nombre en Meta
  language    text not null check (language ~ '^[a-z]{2,3}(_[A-Z]{2})?$'),      -- es, es_CO, en_US
  body        text not null check (char_length(btrim(body)) between 1 and 1024),
  param_count int  not null default 0,
  status      text not null default 'approved' check (status in ('approved', 'disabled')),
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (id, org_id),
  unique (channel_id, name, language),
  foreign key (channel_id, org_id) references public.channels (id, org_id) on delete cascade
);

-- Los marcadores deben ser {{1}}, {{2}}… sin saltos (así los exige Meta).
create or replace function app.message_templates_prepare() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_max int; v_cnt int;
begin
  select coalesce(max(n), 0), count(distinct n) into v_max, v_cnt
    from (select (m[1])::int as n from regexp_matches(new.body, '\{\{(\d{1,2})\}\}', 'g') m) x;
  if v_max > 10 or v_cnt <> v_max then
    raise exception 'template_placeholders' using errcode = '23514';
  end if;
  new.param_count := v_max;
  new.body := btrim(new.body);
  return new;
end $$;
create trigger message_templates_prepare_trg before insert or update on public.message_templates
  for each row execute function app.message_templates_prepare();
create trigger channels_touch before update on public.channels for each row execute function app.touch_updated_at();
create trigger message_templates_touch before update on public.message_templates for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Conversaciones y mensajes
-- ---------------------------------------------------------------------------
create table public.conversations (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null references public.organizations(id) on delete cascade,
  channel_id           uuid not null,
  customer_id          uuid not null,
  thread_key           text not null check (thread_key ~ '^[0-9]{6,20}$'),     -- wa_id del contacto
  contact_name         text check (char_length(contact_name) <= 160),
  status               text not null default 'open' check (status in ('open', 'closed')),
  owner_id             uuid references auth.users(id) on delete set null,       -- sigue al dueño del cliente
  team_id              uuid,
  last_message_at      timestamptz,
  last_inbound_at      timestamptz,
  last_message_preview text check (char_length(last_message_preview) <= 140),
  last_direction       text check (last_direction in ('inbound', 'outbound')),
  needs_reply          boolean not null default false,
  unread               boolean not null default false,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (id, org_id),
  unique (channel_id, thread_key),
  foreign key (channel_id, org_id)  references public.channels (id, org_id),
  foreign key (customer_id, org_id) references public.customers (id, org_id),
  foreign key (team_id, org_id)     references public.teams (id, org_id) on delete set null (team_id)
);
create index conversations_inbox_idx    on public.conversations (org_id, last_message_at desc nulls last, id desc);
create index conversations_customer_idx on public.conversations (customer_id);
create index conversations_reply_idx    on public.conversations (org_id, needs_reply) where needs_reply;

create table public.messages (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organizations(id) on delete cascade,
  channel_id      uuid not null,
  conversation_id uuid not null,
  direction       text not null check (direction in ('inbound', 'outbound')),
  kind            text not null default 'text' check (kind in ('text', 'template', 'media', 'other')),
  body            text not null check (char_length(body) between 1 and 4096),
  external_id     text check (char_length(external_id) <= 200),                 -- wamid
  status          text not null check (status in ('received', 'queued', 'sending', 'sent', 'delivered', 'read', 'failed')),
  error_code      text check (char_length(error_code) <= 40),
  error           text check (char_length(error) <= 300),
  attempts        int not null default 0,
  template_id     uuid,
  template_params jsonb,
  sent_by         uuid references auth.users(id) on delete set null,
  occurred_at     timestamptz not null,
  created_at      timestamptz not null default clock_timestamp(),
  meta            jsonb not null default '{}'::jsonb,
  foreign key (channel_id, org_id)      references public.channels (id, org_id),
  foreign key (conversation_id, org_id) references public.conversations (id, org_id) on delete cascade,
  foreign key (template_id, org_id)     references public.message_templates (id, org_id),
  check ((direction = 'inbound') = (status = 'received'))
);
-- Deduplicación: el mismo id externo no se registra dos veces en un canal.
create unique index messages_external_uk on public.messages (channel_id, external_id) where external_id is not null;
create index messages_conversation_idx on public.messages (conversation_id, occurred_at, created_at);
create index messages_queue_idx on public.messages (created_at) where status in ('queued', 'sending');

-- Solo-anexar: el contenido no cambia y nada se borra (salvo al eliminar la organización).
create or replace function app.messages_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'TRUNCATE' then raise exception 'messages are append-only' using errcode = '42501'; end if;
  if tg_op = 'DELETE' then
    if not exists (select 1 from public.organizations where id = old.org_id) then return old; end if;
    raise exception 'messages are append-only' using errcode = '42501';
  end if;
  if new.org_id <> old.org_id or new.channel_id <> old.channel_id or new.conversation_id <> old.conversation_id
     or new.direction <> old.direction or new.kind <> old.kind or new.body <> old.body
     or new.template_id is distinct from old.template_id or new.template_params is distinct from old.template_params
     or new.sent_by is distinct from old.sent_by or new.occurred_at <> old.occurred_at
     or (old.external_id is not null and new.external_id is distinct from old.external_id) then
    raise exception 'messages are immutable' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger messages_guard_trg before update or delete on public.messages
  for each row execute function app.messages_guard();
create trigger messages_no_truncate before truncate on public.messages
  for each statement execute function app.messages_guard();

create or replace function app.conversations_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.org_id <> old.org_id or new.channel_id <> old.channel_id or new.thread_key <> old.thread_key
     or (new.customer_id <> old.customer_id and current_setting('app.customer_merge', true) is distinct from 'on') then
    raise exception 'conversation identity is immutable' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger conversations_guard_trg before update on public.conversations
  for each row execute function app.conversations_guard();
create trigger conversations_touch before update on public.conversations
  for each row execute function app.touch_updated_at();

insert into app.customer_merge_targets values ('conversations');

-- Las conversaciones siguen al cliente (abiertas y cerradas: son su historial).
create or replace function app.customers_after_update() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.owner_id is distinct from old.owner_id then
    update public.leads
       set owner_id = new.owner_id, team_id = new.team_id
     where customer_id = new.id and org_id = new.org_id and status in ('new', 'contacted', 'qualified');
    update public.opportunities
       set owner_id = new.owner_id, team_id = new.team_id
     where customer_id = new.id and org_id = new.org_id and status = 'open';
    update public.quotes
       set owner_id = new.owner_id, team_id = new.team_id
     where customer_id = new.id and org_id = new.org_id and status in ('draft', 'sent');
    update public.conversations
       set owner_id = new.owner_id, team_id = new.team_id
     where customer_id = new.id and org_id = new.org_id;
    perform set_config('app.system_reassign', 'on', true);
    update public.tasks
       set assignee_id = new.owner_id
     where customer_id = new.id and org_id = new.org_id and status = 'open'
       and assignee_id is not distinct from old.owner_id;
    perform set_config('app.system_reassign', 'off', true);
    perform app.emit_event(new.org_id, 'customer.assigned', 'customer', new.id,
                           jsonb_build_object('owner_id', new.owner_id), new.id);
  end if;
  if new.do_not_contact is distinct from old.do_not_contact then
    perform app.emit_event(new.org_id,
      case when new.do_not_contact then 'customer.dnc_set' else 'customer.dnc_cleared' end,
      'customer', new.id, jsonb_build_object('reason', new.dnc_reason), new.id);
  end if;
  return null;
end $$;

-- ---------------------------------------------------------------------------
-- Cola de webhooks (durable) — solo el servidor la toca
-- ---------------------------------------------------------------------------
create table public.raw_events (
  id              bigint generated always as identity primary key,
  provider        text not null default 'meta',
  payload         jsonb not null,
  status          text not null default 'pending' check (status in ('pending', 'processed', 'failed')),
  attempts        int not null default 0,
  last_attempt_at timestamptz,
  last_error      text check (char_length(last_error) <= 300),
  received_at     timestamptz not null default now(),
  processed_at    timestamptz
);
create index raw_events_pending_idx on public.raw_events (received_at) where status = 'pending';

-- ---------------------------------------------------------------------------
-- Utilidades internas
-- ---------------------------------------------------------------------------
create or replace function app.render_template(p_body text, p_params text[]) returns text
language plpgsql immutable set search_path = '' as $$
declare v text := p_body; i int;
begin
  for i in 1 .. coalesce(array_length(p_params, 1), 0) loop
    v := replace(v, '{{' || i || '}}', p_params[i]);
  end loop;
  return v;
end $$;

create or replace function app.message_rank(p_status text) returns int
language sql immutable set search_path = '' as $$
  select case p_status when 'queued' then 0 when 'sending' then 1 when 'sent' then 2 when 'delivered' then 3 when 'read' then 4 else -1 end
$$;

-- ---------------------------------------------------------------------------
-- Gestión de canales (solo quien tiene settings:manage)
-- ---------------------------------------------------------------------------
create or replace function public.create_channel(
  p_org uuid, p_name text, p_external_id text, p_display_phone text default null, p_access_token text default null
) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not app.has_permission(p_org, 'settings:manage') then raise exception 'not allowed' using errcode = '42501'; end if;
  insert into public.channels (org_id, name, external_id, display_phone, created_by)
  values (p_org, btrim(p_name), btrim(p_external_id), nullif(btrim(coalesce(p_display_phone, '')), ''), auth.uid())
  returning id into v_id;
  if p_access_token is not null and btrim(p_access_token) <> '' then
    insert into public.channel_secrets (channel_id, access_token, updated_by) values (v_id, btrim(p_access_token), auth.uid());
  end if;
  perform app.emit_event(p_org, 'channel.created', 'channel', v_id, jsonb_build_object('name', btrim(p_name)), null);
  return v_id;
end $$;

create or replace function public.save_channel_token(p_channel uuid, p_token text) returns void
language plpgsql security definer set search_path = '' as $$
declare c public.channels%rowtype;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into c from public.channels where id = p_channel;
  if not found or not app.has_permission(c.org_id, 'settings:manage') then raise exception 'not allowed' using errcode = '42501'; end if;
  insert into public.channel_secrets (channel_id, access_token, updated_by) values (p_channel, btrim(p_token), auth.uid())
  on conflict (channel_id) do update set access_token = excluded.access_token, updated_at = now(), updated_by = auth.uid();
  -- El evento NO incluye el token.
  perform app.emit_event(c.org_id, 'channel.token_updated', 'channel', c.id, '{}'::jsonb, null);
end $$;

-- Solo responde SI hay token (nunca cuál): para mostrar «configurado / falta» sin exponer el secreto.
create or replace function public.channel_token_status(p_org uuid)
returns table (channel_id uuid, has_token boolean) language plpgsql security definer stable set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not app.has_permission(p_org, 'settings:manage') then raise exception 'not allowed' using errcode = '42501'; end if;
  return query select c.id, exists (select 1 from public.channel_secrets s where s.channel_id = c.id)
                 from public.channels c where c.org_id = p_org order by c.created_at;
end $$;

create or replace function public.set_channel_status(p_channel uuid, p_status text) returns void
language plpgsql security definer set search_path = '' as $$
declare c public.channels%rowtype;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into c from public.channels where id = p_channel;
  if not found or not app.has_permission(c.org_id, 'settings:manage') then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_status not in ('active', 'paused') then raise exception 'invalid status' using errcode = '22023'; end if;
  update public.channels set status = p_status where id = p_channel;
  perform app.emit_event(c.org_id, 'channel.' || p_status, 'channel', c.id, '{}'::jsonb, null);
end $$;

-- ---------------------------------------------------------------------------
-- ENTRADA: mensaje recibido (lo llama el servidor con la llave de servicio)
-- ---------------------------------------------------------------------------
create or replace function public.ingest_whatsapp_message(
  p_phone_number_id text, p_thread text, p_contact_name text, p_external_id text,
  p_kind text, p_body text, p_occurred_at timestamptz, p_meta jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  ch     public.channels%rowtype;
  conv   public.conversations%rowtype;
  cust   public.customers%rowtype;
  v_res  jsonb;
  v_msg  uuid;
  v_at   timestamptz;
  v_body text;
  v_norm text;
  v_name text := nullif(btrim(coalesce(p_contact_name, '')), '');
  v_new  boolean := false;
  v_reopened boolean := false;
  v_optout boolean := false;
  v_kind text := case when p_kind in ('text', 'media', 'other') then p_kind else 'other' end;
begin
  if p_thread !~ '^[0-9]{6,20}$' then raise exception 'invalid thread' using errcode = '22023'; end if;
  if coalesce(btrim(p_external_id), '') = '' or char_length(p_external_id) > 200 then
    raise exception 'invalid external id' using errcode = '22023';
  end if;

  select * into ch from public.channels where kind = 'whatsapp' and external_id = p_phone_number_id;
  if not found then return jsonb_build_object('ok', false, 'reason', 'unknown_channel'); end if;

  if exists (select 1 from public.messages where channel_id = ch.id and external_id = p_external_id) then
    return jsonb_build_object('ok', true, 'deduplicated', true);
  end if;

  -- Serializa por conversación: dos mensajes simultáneos del mismo contacto nuevo no duplican nada.
  perform pg_advisory_xact_lock(hashtextextended('wa|' || ch.id::text || '|' || p_thread, 0));
  if exists (select 1 from public.messages where channel_id = ch.id and external_id = p_external_id) then
    return jsonb_build_object('ok', true, 'deduplicated', true);
  end if;

  v_at   := least(coalesce(p_occurred_at, clock_timestamp()), clock_timestamp());    -- nunca en el futuro
  v_body := left(coalesce(nullif(btrim(coalesce(p_body, '')), ''), '[Mensaje vacío]'), 4096);

  select * into conv from public.conversations where channel_id = ch.id and thread_key = p_thread for update;
  if not found then
    v_res := app.ingest_lead_core(ch.org_id, jsonb_build_object(
      'source', 'whatsapp', 'channel', 'whatsapp', 'name', coalesce(v_name, '+' || p_thread),
      'identifiers', jsonb_build_array(jsonb_build_object('type', 'phone', 'value', '+' || p_thread)),
      'external_id', 'wa:' || p_thread), null, null);
    select * into cust from public.customers where id = (v_res ->> 'customer_id')::uuid;
    insert into public.conversations (org_id, channel_id, customer_id, thread_key, contact_name, owner_id, team_id)
    values (ch.org_id, ch.id, cust.id, p_thread, v_name, cust.owner_id, cust.team_id)
    returning * into conv;
    v_new := true;
    perform app.emit_event(ch.org_id, 'conversation.opened', 'conversation', conv.id,
                           jsonb_build_object('channel', 'whatsapp'), cust.id);
  else
    select * into cust from public.customers where id = conv.customer_id;
    if conv.status = 'closed' then
      v_reopened := true;
      perform app.emit_event(ch.org_id, 'conversation.reopened', 'conversation', conv.id,
                             jsonb_build_object('channel', 'whatsapp'), cust.id);
    end if;
  end if;

  insert into public.messages (org_id, channel_id, conversation_id, direction, kind, body, external_id, status, occurred_at, meta)
  values (ch.org_id, ch.id, conv.id, 'inbound', v_kind, v_body, p_external_id, 'received', v_at, coalesce(p_meta, '{}'::jsonb))
  returning id into v_msg;

  -- Baja pedida por el propio cliente (mensaje EXACTO: no se interpreta texto libre).
  v_norm := lower(btrim(translate(v_body, 'áéíóúÁÉÍÓÚñÑ¡!¿?.,;:', 'aeiouaeiounn')));
  if v_norm in ('stop', 'baja', 'parar', 'no molestar', 'no mas', 'cancelar suscripcion', 'darme de baja', 'unsubscribe') then
    v_optout := true;
    update public.messages set meta = meta || '{"opt_out": true}'::jsonb where id = v_msg;
    if not cust.do_not_contact then
      update public.customers set do_not_contact = true, dnc_reason = 'Pidió la baja por WhatsApp' where id = cust.id;
    end if;
  end if;

  -- «Atrasado» = llega con más de 2 minutos de diferencia respecto al último mensaje. La tolerancia existe
  -- porque Meta envía la hora redondeada a segundos y con su reloj: un cliente que responde segundos después
  -- de nosotros NO puede considerarse anterior.
  update public.conversations set
    status          = 'open',
    contact_name    = coalesce(contact_name, v_name),
    last_inbound_at = greatest(coalesce(last_inbound_at, v_at), v_at),
    unread          = true,
    last_message_at = greatest(coalesce(last_message_at, v_at), v_at),
    last_message_preview = case when v_at >= coalesce(last_message_at, '-infinity') - interval '2 minutes'
                                then left(regexp_replace(v_body, '\s+', ' ', 'g'), 140) else last_message_preview end,
    last_direction  = case when v_at >= coalesce(last_message_at, '-infinity') - interval '2 minutes' then 'inbound' else last_direction end,
    needs_reply     = case when v_at >= coalesce(last_message_at, '-infinity') - interval '2 minutes' then true else needs_reply end
   where id = conv.id;

  return jsonb_build_object('ok', true, 'deduplicated', false, 'conversation_id', conv.id, 'message_id', v_msg,
                            'customer_id', cust.id, 'new_conversation', v_new, 'reopened', v_reopened, 'opt_out', v_optout);
end $$;

-- ---------------------------------------------------------------------------
-- ENTRADA: estado de un mensaje enviado (enviado / entregado / leído / falló)
-- Los estados solo avanzan; uno atrasado o repetido se ignora.
-- ---------------------------------------------------------------------------
create or replace function public.apply_message_status(
  p_phone_number_id text, p_external_id text, p_status text, p_occurred_at timestamptz default null,
  p_error_code text default null, p_error text default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare m public.messages%rowtype; v_apply boolean;
begin
  if p_status not in ('sent', 'delivered', 'read', 'failed') then
    return jsonb_build_object('ok', true, 'applied', false, 'reason', 'ignored_status');
  end if;
  select m2.* into m from public.messages m2
    join public.channels c on c.id = m2.channel_id
   where c.kind = 'whatsapp' and c.external_id = p_phone_number_id and m2.external_id = p_external_id and m2.direction = 'outbound'
   for update of m2;
  if not found then return jsonb_build_object('ok', false, 'reason', 'unknown_message'); end if;

  v_apply := case
    when p_status = 'failed' then m.status in ('queued', 'sending', 'sent')
    else app.message_rank(p_status) > app.message_rank(m.status) and m.status <> 'failed'
  end;
  if v_apply then
    update public.messages set
      status     = p_status,
      error_code = case when p_status = 'failed' then left(p_error_code, 40) end,
      error      = case when p_status = 'failed' then left(p_error, 300) end
     where id = m.id;
  end if;
  return jsonb_build_object('ok', true, 'applied', v_apply);
end $$;

-- ---------------------------------------------------------------------------
-- SALIDA: encolar (lo llama la persona usuaria; valida permiso, ventana y «no contactar»)
-- ---------------------------------------------------------------------------
create or replace function app.queue_outbound(
  p_conversation uuid, p_template uuid, p_body text, p_params text[]
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  conv public.conversations%rowtype;
  ch   public.channels%rowtype;
  cust public.customers%rowtype;
  t    public.message_templates%rowtype;
  v_body text;
  v_params text[];
  v_window boolean;
  v_id uuid;
  v_kind text := case when p_template is null then 'text' else 'template' end;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into conv from public.conversations where id = p_conversation for update;
  if not found or not app.can_access_row(conv.org_id, 'conversations:update', conv.owner_id, conv.team_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into ch from public.channels where id = conv.channel_id;
  if ch.status <> 'active' then raise exception 'channel_paused' using errcode = '23514'; end if;
  select * into cust from public.customers where id = conv.customer_id;

  v_window := conv.last_inbound_at is not null and conv.last_inbound_at > clock_timestamp() - interval '24 hours';

  -- «No contactar»: solo se puede RESPONDER (texto libre, dentro de la ventana) a quien acaba de escribir.
  if cust.do_not_contact and (v_kind = 'template' or not v_window) then
    raise exception 'do_not_contact' using errcode = '23514';
  end if;

  if v_kind = 'text' then
    v_body := btrim(coalesce(p_body, ''));
    if v_body = '' then raise exception 'message_empty' using errcode = '22023'; end if;
    if char_length(v_body) > 4096 then raise exception 'message_too_long' using errcode = '22023'; end if;
    if not v_window then raise exception 'window_closed' using errcode = '23514'; end if;
  else
    select * into t from public.message_templates where id = p_template and org_id = conv.org_id;
    if not found or t.status <> 'approved' or t.channel_id <> conv.channel_id then
      raise exception 'template_unavailable' using errcode = '22023';
    end if;
    select coalesce(array_agg(nullif(btrim(regexp_replace(x, '[\r\n\t]+', ' ', 'g')), '') order by ord), '{}')
      into v_params from unnest(coalesce(p_params, '{}')) with ordinality as u(x, ord);
    if coalesce(array_length(v_params, 1), 0) <> t.param_count or exists (select 1 from unnest(v_params) z where z is null) then
      raise exception 'template_params' using errcode = '22023';
    end if;
    v_body := app.render_template(t.body, v_params);
  end if;

  insert into public.messages (org_id, channel_id, conversation_id, direction, kind, body, status, sent_by, occurred_at,
                               template_id, template_params)
  values (conv.org_id, conv.channel_id, conv.id, 'outbound', v_kind, v_body, 'queued', auth.uid(), clock_timestamp(),
          p_template, case when v_kind = 'template' then to_jsonb(v_params) end)
  returning id into v_id;

  update public.conversations set
    last_message_at = clock_timestamp(), last_direction = 'outbound', needs_reply = false, unread = false,
    last_message_preview = left(regexp_replace(v_body, '\s+', ' ', 'g'), 140)
   where id = conv.id;
  return v_id;
end $$;

create or replace function public.queue_message(p_conversation uuid, p_body text) returns uuid
language sql security definer set search_path = '' as $$ select app.queue_outbound(p_conversation, null, p_body, null) $$;
create or replace function public.queue_template_message(p_conversation uuid, p_template uuid, p_params text[] default '{}') returns uuid
language sql security definer set search_path = '' as $$ select app.queue_outbound(p_conversation, p_template, null, p_params) $$;

-- ---------------------------------------------------------------------------
-- Operaciones de la bandeja
-- ---------------------------------------------------------------------------
create or replace function public.mark_conversation_read(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare c public.conversations%rowtype;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into c from public.conversations where id = p_id;
  if not found or not app.can_access_row(c.org_id, 'conversations:update', c.owner_id, c.team_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update public.conversations set unread = false where id = p_id and unread;
end $$;

create or replace function public.set_conversation_status(p_id uuid, p_status text) returns void
language plpgsql security definer set search_path = '' as $$
declare c public.conversations%rowtype;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into c from public.conversations where id = p_id for update;
  if not found or not app.can_access_row(c.org_id, 'conversations:update', c.owner_id, c.team_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_status not in ('open', 'closed') then raise exception 'invalid status' using errcode = '22023'; end if;
  update public.conversations set status = p_status, needs_reply = case when p_status = 'closed' then false else needs_reply end,
         unread = case when p_status = 'closed' then false else unread end
   where id = p_id;
end $$;

-- ---------------------------------------------------------------------------
-- Envío (solo servidor): reclamo atómico, resultado, barrido de pendientes
-- ---------------------------------------------------------------------------
create or replace function public.claim_outbound(p_message uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare m public.messages%rowtype; conv public.conversations%rowtype; ch public.channels%rowtype; t public.message_templates%rowtype;
begin
  -- Solo UNA llamada gana: pasa de 'queued' a 'sending' (las demás no encuentran nada).
  update public.messages set status = 'sending', attempts = attempts + 1
   where id = p_message and direction = 'outbound' and status = 'queued'
  returning * into m;
  if not found then return null; end if;
  select * into conv from public.conversations where id = m.conversation_id;
  select * into ch from public.channels where id = m.channel_id;
  if m.template_id is not null then select * into t from public.message_templates where id = m.template_id; end if;
  return jsonb_build_object('message_id', m.id, 'kind', m.kind, 'body', m.body, 'to', conv.thread_key,
    'phone_number_id', ch.external_id, 'channel_id', ch.id,
    'template_name', t.name, 'template_language', t.language, 'template_params', m.template_params);
end $$;

create or replace function public.finish_outbound(
  p_message uuid, p_ok boolean, p_external_id text default null, p_error_code text default null, p_error text default null
) returns void language plpgsql security definer set search_path = '' as $$
begin
  -- Un estado posterior (entregado/leído) que llegó antes que este resultado no se pisa.
  if p_ok then
    update public.messages set status = case when app.message_rank(status) > app.message_rank('sent') then status else 'sent' end,
           external_id = coalesce(external_id, p_external_id), error = null, error_code = null
     where id = p_message and direction = 'outbound' and status in ('sending', 'sent', 'delivered', 'read');
  else
    update public.messages set status = 'failed', error_code = left(p_error_code, 40), error = left(p_error, 300)
     where id = p_message and direction = 'outbound' and status = 'sending';
  end if;
end $$;

create or replace function public.sweep_outbound(p_queued_after_seconds int default 30, p_sending_after_seconds int default 300)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_retry uuid[]; v_expired int;
begin
  -- Encolados que nadie reclamó (la petición original se cortó antes de enviar): se pueden enviar sin riesgo.
  select coalesce(array_agg(id), '{}') into v_retry from (
    select id from public.messages
     where direction = 'outbound' and status = 'queued' and created_at < clock_timestamp() - make_interval(secs => p_queued_after_seconds)
     order by created_at limit 50) q;
  -- «Enviando» por demasiado tiempo: NO sabemos si salió. No se reenvía (evita mensajes duplicados al cliente).
  with x as (
    update public.messages set status = 'failed', error_code = 'unknown_outcome',
           error = 'No se pudo confirmar el envío. Revisa en WhatsApp antes de reenviar.'
     where direction = 'outbound' and status = 'sending' and created_at < clock_timestamp() - make_interval(secs => p_sending_after_seconds)
    returning 1)
  select count(*) into v_expired from x;
  return jsonb_build_object('retry_ids', to_jsonb(v_retry), 'expired', v_expired);
end $$;

create or replace function public.channel_credentials(p_channel uuid) returns text
language sql security definer stable set search_path = '' as $$
  select access_token from public.channel_secrets where channel_id = p_channel
$$;

-- ---------------------------------------------------------------------------
-- Cola de webhooks (solo servidor)
-- ---------------------------------------------------------------------------
create or replace function public.record_raw_event(p_payload jsonb) returns bigint
language sql security definer set search_path = '' as $$
  insert into public.raw_events (payload, attempts, last_attempt_at) values (p_payload, 1, clock_timestamp()) returning id
$$;

create or replace function public.finish_raw_event(p_id bigint, p_ok boolean, p_error text default null) returns void
language sql security definer set search_path = '' as $$
  update public.raw_events set
    status = case when p_ok then 'processed' when attempts >= 8 then 'failed' else 'pending' end,
    processed_at = case when p_ok then clock_timestamp() end, last_error = left(p_error, 300)
   where id = p_id
$$;

create or replace function public.claim_raw_events(p_limit int default 20, p_min_age_seconds int default 30)
returns table (id bigint, payload jsonb) language sql security definer set search_path = '' as $$
  update public.raw_events e set attempts = e.attempts + 1, last_attempt_at = clock_timestamp()
   where e.id in (select r.id from public.raw_events r
                   where r.status = 'pending' and r.attempts < 8
                     and coalesce(r.last_attempt_at, r.received_at) < clock_timestamp() - make_interval(secs => p_min_age_seconds)
                   order by r.id limit p_limit for update skip locked)
  returning e.id, e.payload
$$;

create or replace function public.purge_raw_events(p_days int default 30) returns int
language sql security definer set search_path = '' as $$
  with d as (delete from public.raw_events where status = 'processed' and processed_at < now() - make_interval(days => p_days) returning 1)
  select count(*)::int from d
$$;

-- ---------------------------------------------------------------------------
-- Privilegios + RLS + auditoría
-- ---------------------------------------------------------------------------
revoke all on public.channels, public.channel_secrets, public.message_templates, public.conversations, public.messages, public.raw_events
  from anon, authenticated;
grant select on public.channels, public.message_templates, public.conversations, public.messages to authenticated;
grant insert (org_id, channel_id, name, language, body) on public.message_templates to authenticated;
grant update (body, status) on public.message_templates to authenticated;
grant all on public.channels, public.channel_secrets, public.message_templates, public.conversations, public.messages, public.raw_events to service_role;

alter table public.channels          enable row level security;
alter table public.channel_secrets   enable row level security;   -- sin políticas: nadie con sesión de usuario la lee
alter table public.message_templates enable row level security;
alter table public.conversations     enable row level security;
alter table public.messages          enable row level security;
alter table public.raw_events        enable row level security;   -- sin políticas: solo el servidor

create policy channels_select on public.channels for select to authenticated
  using ((select app.has_permission(org_id, 'conversations:read')) or (select app.has_permission(org_id, 'settings:manage')));
create policy templates_select on public.message_templates for select to authenticated
  using ((select app.has_permission(org_id, 'conversations:update')) or (select app.has_permission(org_id, 'settings:manage')));
create policy templates_insert on public.message_templates for insert to authenticated
  with check ((select app.has_permission(org_id, 'settings:manage')));
create policy templates_update on public.message_templates for update to authenticated
  using ((select app.has_permission(org_id, 'settings:manage')))
  with check ((select app.has_permission(org_id, 'settings:manage')));
create policy conversations_select on public.conversations for select to authenticated
  using ((select app.can_access_row(org_id, 'conversations:read', owner_id, team_id)));
create policy messages_select on public.messages for select to authenticated
  using (exists (select 1 from public.conversations c where c.id = conversation_id));

create trigger channels_audit  after insert or update or delete on public.channels          for each row execute function app.audit_row_change();
create trigger templates_audit after insert or update or delete on public.message_templates for each row execute function app.audit_row_change();

-- Funciones internas: nadie con sesión de usuario las ejecuta directamente.
revoke all on function app.message_templates_prepare(), app.messages_guard(), app.conversations_guard(),
  app.render_template(text, text[]), app.message_rank(text), app.customers_after_update(),
  app.queue_outbound(uuid, uuid, text, text[]) from public, anon, authenticated;

-- Funciones del servidor (llave de servicio): jamás desde el navegador.
revoke all on function public.ingest_whatsapp_message(text, text, text, text, text, text, timestamptz, jsonb),
  public.apply_message_status(text, text, text, timestamptz, text, text),
  public.claim_outbound(uuid), public.finish_outbound(uuid, boolean, text, text, text),
  public.sweep_outbound(int, int), public.channel_credentials(uuid),
  public.record_raw_event(jsonb), public.finish_raw_event(bigint, boolean, text),
  public.claim_raw_events(int, int), public.purge_raw_events(int) from public, anon, authenticated;
grant execute on function public.ingest_whatsapp_message(text, text, text, text, text, text, timestamptz, jsonb),
  public.apply_message_status(text, text, text, timestamptz, text, text),
  public.claim_outbound(uuid), public.finish_outbound(uuid, boolean, text, text, text),
  public.sweep_outbound(int, int), public.channel_credentials(uuid),
  public.record_raw_event(jsonb), public.finish_raw_event(bigint, boolean, text),
  public.claim_raw_events(int, int), public.purge_raw_events(int) to service_role;

-- Funciones de la persona usuaria.
revoke all on function public.create_channel(uuid, text, text, text, text), public.save_channel_token(uuid, text),
  public.set_channel_status(uuid, text), public.channel_token_status(uuid), public.queue_message(uuid, text), public.queue_template_message(uuid, uuid, text[]),
  public.mark_conversation_read(uuid), public.set_conversation_status(uuid, text) from public, anon;
grant execute on function public.create_channel(uuid, text, text, text, text), public.save_channel_token(uuid, text),
  public.set_channel_status(uuid, text), public.channel_token_status(uuid), public.queue_message(uuid, text), public.queue_template_message(uuid, uuid, text[]),
  public.mark_conversation_read(uuid), public.set_conversation_status(uuid, text) to authenticated, service_role;

commit;

-- Comprobación final: 'tablas' y 'tablas_con_rls' deben ser iguales.
select 'LISTO' as estado,
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r') as tablas,
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity) as tablas_con_rls,
  (select count(*) from public.permissions) as permisos,
  (select count(*) from public.roles where org_id is null) as roles_base;

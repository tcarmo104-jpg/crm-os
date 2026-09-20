-- =============================================================================
-- 0017 CONEXIONES MULTI-PROVEEDOR: Facebook Messenger, Instagram Direct y Gmail
-- =============================================================================
-- Sigue el mismo modelo que WhatsApp: cada cuenta conectada es una fila de `channels` (kind = proveedor,
-- external_id = identificador de la cuenta: ID de página, ID de Instagram o dirección de correo), su token vive
-- en `channel_secrets`, y sus conversaciones/mensajes usan las MISMAS tablas del Inbox. Nada de WhatsApp cambia.
--   * facebook  → external_id = ID de la página        ; conversación por contacto (PSID)
--   * instagram → external_id = ID de la cuenta de IG   ; conversación por contacto (IGSID)
--   * gmail     → external_id = correo conectado        ; conversación por remitente (correo)
-- Nuevo: `oauth_sessions` (guarda 15 min lo que devuelve Meta mientras el administrador elige páginas).
-- =============================================================================

alter table public.channels drop constraint channels_kind_check;
alter table public.channels drop constraint channels_external_id_check;
alter table public.channels add constraint channels_kind_check check (kind in ('whatsapp', 'facebook', 'instagram', 'gmail'));
alter table public.channels add constraint channels_external_id_check check (
  (kind = 'gmail' and external_id = lower(external_id) and char_length(external_id) <= 254 and external_id ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')
  or (kind <> 'gmail' and external_id ~ '^[0-9]{5,30}$'));

alter table public.conversations drop constraint conversations_thread_key_check;
alter table public.conversations add constraint conversations_thread_key_check check (
  thread_key ~ '^[0-9]{6,20}$'
  or (char_length(thread_key) <= 254 and thread_key = lower(thread_key) and thread_key ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'));

-- ---------------------------------------------------------------------------
-- Sesiones OAuth de corta vida (Meta devuelve varias páginas: el administrador elige cuáles conectar)
-- ---------------------------------------------------------------------------
create table public.oauth_sessions (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.organizations (id) on delete cascade,
  user_id    uuid not null,
  provider   text not null check (provider in ('meta')),
  payload    text not null check (char_length(payload) <= 200000),
  expires_at timestamptz not null default now() + interval '15 minutes'
);
alter table public.oauth_sessions enable row level security;
revoke all on public.oauth_sessions from anon, authenticated;

create or replace function public.save_oauth_session(p_org uuid, p_user uuid, p_provider text, p_payload text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  delete from public.oauth_sessions where expires_at < now() or (org_id = p_org and user_id = p_user and provider = p_provider);
  insert into public.oauth_sessions (org_id, user_id, provider, payload) values (p_org, p_user, p_provider, p_payload) returning id into v_id;
  return v_id;
end $$;

-- Ver la sesión sin consumirla (la pantalla de selección de páginas).
create or replace function public.peek_oauth_session(p_id uuid, p_org uuid, p_user uuid) returns text
language sql security definer set search_path = '' stable as $$
  select payload from public.oauth_sessions where id = p_id and org_id = p_org and user_id = p_user and expires_at > now()
$$;

-- Se entrega UNA sola vez y solo a quien la inició, en su organización y sin vencer.
create or replace function public.take_oauth_session(p_id uuid, p_org uuid, p_user uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare v_payload text;
begin
  delete from public.oauth_sessions where id = p_id and org_id = p_org and user_id = p_user and expires_at > now() returning payload into v_payload;
  return v_payload;
end $$;

-- ---------------------------------------------------------------------------
-- Conectar una cuenta de Facebook / Instagram / Gmail (el administrador, tras autorizar en Meta o Google)
-- ---------------------------------------------------------------------------
create or replace function public.connect_channel(
  p_org uuid, p_kind text, p_name text, p_external_id text, p_display_phone text, p_account_name text, p_token text, p_metadata jsonb default '{}'::jsonb
) returns uuid language plpgsql security definer set search_path = '' as $$
declare c public.channels%rowtype; v_id uuid; v_ext text := btrim(coalesce(p_external_id, ''));
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not app.has_permission(p_org, 'settings:manage') then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_kind not in ('facebook', 'instagram', 'gmail') then raise exception 'invalid kind' using errcode = '22023'; end if;
  if btrim(coalesce(p_token, '')) = '' then raise exception 'token required' using errcode = '22023'; end if;
  if p_kind = 'gmail' then v_ext := lower(v_ext); end if;

  select * into c from public.channels where kind = p_kind and external_id = v_ext for update;
  if found and c.org_id <> p_org then raise exception 'channel_taken' using errcode = '23505'; end if;
  if found then
    update public.channels set
      name = coalesce(nullif(btrim(coalesce(p_name, '')), ''), name),
      display_phone = coalesce(nullif(left(btrim(coalesce(p_display_phone, '')), 30), ''), display_phone),
      account_name = coalesce(nullif(left(btrim(coalesce(p_account_name, '')), 120), ''), account_name),
      metadata = metadata || coalesce(p_metadata, '{}'::jsonb),
      connection_status = 'pending', last_error_code = null, disconnected_at = null,
      connected_at = case when connection_status = 'disconnected' then null else connected_at end
     where id = c.id;
    v_id := c.id;
    perform app.connection_event(v_id, p_org, case when c.connection_status = 'disconnected' then 'reconnected' else 'token_saved' end, true, null, null, auth.uid());
  else
    insert into public.channels (org_id, kind, name, external_id, display_phone, account_name, metadata, created_by)
    values (p_org, p_kind, coalesce(nullif(btrim(coalesce(p_name, '')), ''), v_ext), v_ext, nullif(left(btrim(coalesce(p_display_phone, '')), 30), ''),
            nullif(left(btrim(coalesce(p_account_name, '')), 120), ''), coalesce(p_metadata, '{}'::jsonb), auth.uid())
    returning id into v_id;
    perform app.connection_event(v_id, p_org, 'connected', true, null, null, auth.uid());
    perform app.emit_event(p_org, 'channel.created', 'channel', v_id, jsonb_build_object('name', coalesce(p_name, v_ext), 'kind', p_kind), null);
  end if;
  insert into public.channel_secrets (channel_id, access_token, updated_by) values (v_id, btrim(p_token), auth.uid())
  on conflict (channel_id) do update set access_token = excluded.access_token, updated_at = now(), updated_by = auth.uid();
  perform app.emit_event(p_org, 'channel.token_updated', 'channel', v_id, '{}'::jsonb, null);
  return v_id;
end $$;

-- Datos que solo el servidor aprende (por ejemplo el historial de Gmail): se mezclan en `metadata`.
create or replace function public.merge_channel_metadata(p_channel uuid, p_metadata jsonb) returns void
language sql security definer set search_path = '' as $$
  update public.channels set metadata = metadata || coalesce(p_metadata, '{}'::jsonb) where id = p_channel and connection_status <> 'disconnected'
$$;

-- ---------------------------------------------------------------------------
-- Actividad real de cualquier proveedor (generaliza touch_channel, que sigue existiendo para WhatsApp)
-- ---------------------------------------------------------------------------
create or replace function public.touch_channel(p_kind text, p_external_id text, p_activity text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_kind not in ('whatsapp', 'facebook', 'instagram', 'gmail') then raise exception 'invalid kind' using errcode = '22023'; end if;
  if p_activity = 'webhook' then
    update public.channels set
      last_webhook_at = now(),
      last_error_code = case when connection_status = 'webhook_missing' then null else last_error_code end,
      connection_status = case when connection_status = 'webhook_missing' then 'connected' else connection_status end
     where kind = p_kind and external_id = p_external_id and connection_status <> 'disconnected'
       and (last_webhook_at is null or last_webhook_at < now() - interval '1 minute' or connection_status = 'webhook_missing');
  elsif p_activity in ('send_ok', 'sync') then
    update public.channels set
      last_sync_at = now(),
      last_error_code = case when connection_status in ('pending', 'error', 'token_expired', 'needs_auth') then null else last_error_code end,
      connection_status = case when connection_status in ('pending', 'error', 'token_expired', 'needs_auth') then 'connected' else connection_status end
     where kind = p_kind and external_id = p_external_id and connection_status <> 'disconnected'
       and (last_sync_at is null or last_sync_at < now() - interval '1 minute' or connection_status <> 'connected');
  else
    raise exception 'invalid kind' using errcode = '22023';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Recepción: un mensaje de Facebook / Instagram / Gmail (misma lógica que WhatsApp, sin duplicar clientes ni leads)
--   canal → identificador externo → contacto existente → continuar la conversación; si no existe, crearlo una vez.
-- ---------------------------------------------------------------------------
create or replace function public.ingest_channel_message(
  p_kind text, p_account_id text, p_thread text, p_contact_name text, p_external_id text, p_msg_kind text, p_body text,
  p_occurred_at timestamptz, p_meta jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  ch public.channels%rowtype; conv public.conversations%rowtype; cust public.customers%rowtype;
  v_res jsonb; v_msg uuid; v_at timestamptz; v_body text; v_norm text;
  v_thread text := case when p_kind = 'gmail' then lower(btrim(coalesce(p_thread, ''))) else btrim(coalesce(p_thread, '')) end;
  v_name text := nullif(btrim(coalesce(p_contact_name, '')), '');
  v_new boolean := false; v_reopened boolean := false; v_optout boolean := false;
  v_kind text := case when p_msg_kind in ('text', 'media', 'other') then p_msg_kind else 'other' end;
  v_label text := case p_kind when 'facebook' then 'Facebook' when 'instagram' then 'Instagram' else 'Gmail' end;
  v_ident jsonb;
begin
  if p_kind not in ('facebook', 'instagram', 'gmail') then raise exception 'invalid kind' using errcode = '22023'; end if;
  if p_kind = 'gmail' then
    if v_thread !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' or char_length(v_thread) > 254 then raise exception 'invalid thread' using errcode = '22023'; end if;
  elsif v_thread !~ '^[0-9]{6,20}$' then raise exception 'invalid thread' using errcode = '22023'; end if;
  if coalesce(btrim(p_external_id), '') = '' or char_length(p_external_id) > 200 then raise exception 'invalid external id' using errcode = '22023'; end if;

  select * into ch from public.channels where kind = p_kind and external_id = p_account_id;
  if not found then return jsonb_build_object('ok', false, 'reason', 'unknown_channel'); end if;
  if ch.connection_status = 'disconnected' then return jsonb_build_object('ok', false, 'reason', 'disconnected'); end if;

  if exists (select 1 from public.messages where channel_id = ch.id and external_id = p_external_id) then
    return jsonb_build_object('ok', true, 'deduplicated', true);
  end if;
  perform pg_advisory_xact_lock(hashtextextended('ch|' || ch.id::text || '|' || v_thread, 0));
  if exists (select 1 from public.messages where channel_id = ch.id and external_id = p_external_id) then
    return jsonb_build_object('ok', true, 'deduplicated', true);
  end if;

  v_at   := least(coalesce(p_occurred_at, clock_timestamp()), clock_timestamp());
  v_body := left(coalesce(nullif(btrim(coalesce(p_body, '')), ''), '[Mensaje vacío]'), 4096);

  select * into conv from public.conversations where channel_id = ch.id and thread_key = v_thread for update;
  if not found then
    v_ident := case p_kind
      when 'gmail' then jsonb_build_array(jsonb_build_object('type', 'email', 'value', v_thread))
      else jsonb_build_array(jsonb_build_object('type', p_kind, 'value', v_thread)) end;
    v_res := app.ingest_lead_core(ch.org_id, jsonb_build_object(
      'source', p_kind, 'channel', p_kind,
      'name', coalesce(v_name, case when p_kind = 'gmail' then v_thread else 'Contacto de ' || v_label || ' ' || right(v_thread, 4) end),
      'identifiers', v_ident, 'external_id', p_kind || ':' || v_thread), null, null);
    select * into cust from public.customers where id = (v_res ->> 'customer_id')::uuid;
    insert into public.conversations (org_id, channel_id, customer_id, thread_key, contact_name, owner_id, team_id)
    values (ch.org_id, ch.id, cust.id, v_thread, v_name, cust.owner_id, cust.team_id) returning * into conv;
    v_new := true;
    perform app.emit_event(ch.org_id, 'conversation.opened', 'conversation', conv.id, jsonb_build_object('channel', p_kind), cust.id);
  else
    select * into cust from public.customers where id = conv.customer_id;
    if conv.status = 'closed' then
      v_reopened := true;
      perform app.emit_event(ch.org_id, 'conversation.reopened', 'conversation', conv.id, jsonb_build_object('channel', p_kind), cust.id);
    end if;
  end if;

  insert into public.messages (org_id, channel_id, conversation_id, direction, kind, body, external_id, status, occurred_at, meta)
  values (ch.org_id, ch.id, conv.id, 'inbound', v_kind, v_body, p_external_id, 'received', v_at, coalesce(p_meta, '{}'::jsonb)) returning id into v_msg;

  v_norm := lower(btrim(translate(v_body, 'áéíóúÁÉÍÓÚñÑ¡!¿?.,;:', 'aeiouaeiounn')));
  if p_kind <> 'gmail' and v_norm in ('stop', 'baja', 'parar', 'no molestar', 'no mas', 'cancelar suscripcion', 'darme de baja', 'unsubscribe') then
    v_optout := true;
    update public.messages set meta = meta || '{"opt_out": true}'::jsonb where id = v_msg;
    if not cust.do_not_contact then
      update public.customers set do_not_contact = true, dnc_reason = 'Pidió la baja por ' || v_label where id = cust.id;
    end if;
  end if;

  update public.conversations set
    status = 'open', contact_name = coalesce(contact_name, v_name),
    last_inbound_at = greatest(coalesce(last_inbound_at, v_at), v_at), unread = true,
    last_message_at = greatest(coalesce(last_message_at, v_at), v_at),
    last_message_preview = case when v_at >= coalesce(last_message_at, '-infinity') - interval '2 minutes' then left(regexp_replace(v_body, '\s+', ' ', 'g'), 140) else last_message_preview end,
    last_direction = case when v_at >= coalesce(last_message_at, '-infinity') - interval '2 minutes' then 'inbound' else last_direction end,
    needs_reply = case when v_at >= coalesce(last_message_at, '-infinity') - interval '2 minutes' then true else needs_reply end
   where id = conv.id;

  return jsonb_build_object('ok', true, 'deduplicated', false, 'conversation_id', conv.id, 'message_id', v_msg, 'customer_id', cust.id,
                            'new_conversation', v_new, 'reopened', v_reopened, 'opt_out', v_optout);
end $$;

-- El perfil (nombre) de un contacto nuevo de Facebook/Instagram llega después: solo reemplaza el nombre provisional.
create or replace function public.set_contact_profile(p_conversation uuid, p_name text) returns void
language plpgsql security definer set search_path = '' as $$
declare conv public.conversations%rowtype; v_name text := nullif(left(btrim(coalesce(p_name, '')), 160), '');
begin
  if v_name is null then return; end if;
  select * into conv from public.conversations where id = p_conversation;
  if not found then return; end if;
  update public.conversations set contact_name = v_name where id = conv.id and contact_name is null;
  update public.customers set full_name = v_name where id = conv.customer_id and full_name ~ '^Contacto de (Facebook|Instagram) [0-9]{4}$';
end $$;

-- Estado de un mensaje enviado (entregado / leído / falló) para cualquier proveedor.
create or replace function public.apply_channel_status(
  p_kind text, p_account_id text, p_external_id text, p_status text, p_occurred_at timestamptz default null, p_error_code text default null, p_error text default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare m public.messages%rowtype; v_apply boolean;
begin
  if p_status not in ('sent', 'delivered', 'read', 'failed') then return jsonb_build_object('ok', true, 'applied', false, 'reason', 'ignored_status'); end if;
  select m2.* into m from public.messages m2 join public.channels c on c.id = m2.channel_id
   where c.kind = p_kind and c.external_id = p_account_id and m2.external_id = p_external_id and m2.direction = 'outbound' for update of m2;
  if not found then return jsonb_build_object('ok', false, 'reason', 'unknown_message'); end if;
  v_apply := case when p_status = 'failed' then m.status in ('queued', 'sending', 'sent')
                  else app.message_rank(p_status) > app.message_rank(m.status) and m.status <> 'failed' end;
  if v_apply then
    update public.messages set status = p_status, error_code = case when p_status = 'failed' then left(p_error_code, 40) end,
           error = case when p_status = 'failed' then left(p_error, 300) end where id = m.id;
  end if;
  return jsonb_build_object('ok', true, 'applied', v_apply);
end $$;

-- El envío necesita saber de qué proveedor es la conversación y, para Gmail, a qué correo se responde.
create or replace function public.claim_outbound(p_message uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare m public.messages%rowtype; conv public.conversations%rowtype; ch public.channels%rowtype; t public.message_templates%rowtype; v_reply jsonb;
begin
  update public.messages set status = 'sending', attempts = attempts + 1
   where id = p_message and direction = 'outbound' and status = 'queued' returning * into m;
  if not found then return null; end if;
  select * into conv from public.conversations where id = m.conversation_id;
  select * into ch from public.channels where id = m.channel_id;
  if m.template_id is not null then select * into t from public.message_templates where id = m.template_id; end if;
  select x.meta into v_reply from public.messages x where x.conversation_id = conv.id and x.direction = 'inbound' order by x.occurred_at desc, x.created_at desc limit 1;
  return jsonb_build_object('message_id', m.id, 'kind', m.kind, 'body', m.body, 'to', conv.thread_key,
    'phone_number_id', ch.external_id, 'channel_id', ch.id, 'channel_kind', ch.kind, 'account_id', ch.external_id, 'channel_meta', ch.metadata,
    'reply_meta', coalesce(v_reply, '{}'::jsonb), 'template_name', t.name, 'template_language', t.language, 'template_params', m.template_params);
end $$;

-- Ventana de respuesta y plantillas según el proveedor.
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
  if ch.connection_status = 'disconnected' then raise exception 'connection_unavailable' using errcode = '23514'; end if;
  select * into cust from public.customers where id = conv.customer_id;

  -- WhatsApp, Facebook e Instagram solo permiten texto libre dentro de 24 h desde el último mensaje del cliente; el correo no tiene esa regla (se deja 30 días).
  v_window := conv.last_inbound_at is not null and conv.last_inbound_at > clock_timestamp() - case when ch.kind = 'gmail' then interval '30 days' else interval '24 hours' end;

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
    if not found or t.status <> 'approved' or t.channel_id <> conv.channel_id or ch.kind <> 'whatsapp' then
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

revoke all on function public.save_oauth_session(uuid, uuid, text, text), public.take_oauth_session(uuid, uuid, uuid), public.peek_oauth_session(uuid, uuid, uuid),
  public.merge_channel_metadata(uuid, jsonb), public.touch_channel(text, text, text), public.ingest_channel_message(text, text, text, text, text, text, text, timestamptz, jsonb),
  public.set_contact_profile(uuid, text), public.apply_channel_status(text, text, text, text, timestamptz, text, text) from public, anon, authenticated;
grant execute on function public.save_oauth_session(uuid, uuid, text, text), public.take_oauth_session(uuid, uuid, uuid), public.peek_oauth_session(uuid, uuid, uuid),
  public.merge_channel_metadata(uuid, jsonb), public.touch_channel(text, text, text), public.ingest_channel_message(text, text, text, text, text, text, text, timestamptz, jsonb),
  public.set_contact_profile(uuid, text), public.apply_channel_status(text, text, text, text, timestamptz, text, text) to service_role;
revoke all on function public.connect_channel(uuid, text, text, text, text, text, text, jsonb) from public, anon;
grant execute on function public.connect_channel(uuid, text, text, text, text, text, text, jsonb) to authenticated, service_role;

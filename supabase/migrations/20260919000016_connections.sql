-- =============================================================================
-- 0016 CONEXIONES (WhatsApp): la tabla `channels` pasa a ser el modelo de conexiones
-- =============================================================================
-- No se crea ninguna tabla equivalente: `channels` ya es «una cuenta conectada de un canal» (organización,
-- canal, identificador externo, estado) y `channel_secrets` guarda su token sin exponerlo al navegador.
-- Aquí se le añade lo que faltaba:
--   * Estado de la CONEXIÓN (siete estados) separado de «activo/en pausa» (que sigue siendo una pausa operativa).
--   * Cuenta de WhatsApp Business (WABA), nombre verificado, fechas de conexión / última sincronización / último webhook.
--   * `connection_events`: registro técnico por conexión, visible SOLO para administradores. El usuario final
--     ve mensajes comprensibles; el detalle técnico vive aquí (y nunca contiene tokens).
--   * Desconectar: borra el token y bloquea el envío, pero CONSERVA conversaciones y mensajes.
-- Todo es aditivo: nada se renombra ni se borra.
-- =============================================================================

alter table public.channels
  add column business_account_id text check (business_account_id is null or business_account_id ~ '^[0-9]{5,30}$'),
  add column account_name       text check (account_name is null or char_length(account_name) <= 120),
  add column connection_status  text not null default 'pending'
    check (connection_status in ('pending', 'connected', 'needs_auth', 'token_expired', 'error', 'webhook_missing', 'disconnected')),
  add column connected_at       timestamptz,
  add column disconnected_at    timestamptz,
  add column last_sync_at       timestamptz,
  add column last_webhook_at    timestamptz,
  add column last_checked_at    timestamptz,
  add column last_error_code    text check (last_error_code is null or char_length(last_error_code) <= 40),
  add column metadata           jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object' and pg_column_size(metadata) <= 4096);

-- Lo que ya existía: la última actividad conocida sale de sus propios mensajes; el estado queda «pendiente»
-- hasta que alguien pulse «Verificar» (no se afirma «conectado» sin haberlo comprobado con Meta).
update public.channels c set
  connected_at = c.created_at,
  last_sync_at = (select max(m.occurred_at) from public.messages m where m.channel_id = c.id);

create index channels_check_idx on public.channels (last_checked_at nulls first) where connection_status <> 'disconnected';

-- ---------------------------------------------------------------------------
-- Registro técnico de cada conexión
-- ---------------------------------------------------------------------------
create table public.connection_events (
  id          bigint generated always as identity primary key,
  org_id      uuid not null,
  channel_id  uuid not null,
  kind        text not null check (kind in ('connected', 'token_saved', 'health_check', 'webhook_check', 'error', 'disconnected', 'reconnected')),
  ok          boolean not null,
  code        text check (code is null or char_length(code) <= 40),
  detail      text check (detail is null or char_length(detail) <= 500),
  actor_id    uuid,
  created_at  timestamptz not null default now(),
  foreign key (channel_id, org_id) references public.channels (id, org_id) on delete cascade
);
create index connection_events_channel_idx on public.connection_events (channel_id, created_at desc);
alter table public.connection_events enable row level security;
create policy connection_events_select on public.connection_events for select to authenticated
  using ((select app.has_permission(org_id, 'settings:manage')));
revoke all on public.connection_events from anon, authenticated;
grant select on public.connection_events to authenticated;

-- Inserta un evento técnico: elimina cualquier token que se haya colado en el texto y conserva los últimos 100.
create or replace function app.connection_event(p_channel uuid, p_org uuid, p_kind text, p_ok boolean, p_code text, p_detail text, p_actor uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_detail text;
begin
  v_detail := left(regexp_replace(regexp_replace(coalesce(p_detail, ''), 'EAA[A-Za-z0-9_-]{16,}', '[token]', 'g'), 'Bearer\s+\S+', 'Bearer [token]', 'gi'), 500);
  insert into public.connection_events (org_id, channel_id, kind, ok, code, detail, actor_id)
  values (p_org, p_channel, p_kind, p_ok, left(p_code, 40), nullif(v_detail, ''), p_actor);
  delete from public.connection_events e
   where e.channel_id = p_channel
     and e.id <= (select x.id from public.connection_events x where x.channel_id = p_channel order by x.id desc offset 100 limit 1);
end $$;

-- ---------------------------------------------------------------------------
-- Resultado de una verificación (lo llama SOLO el servidor, tras hablar con Meta)
-- ---------------------------------------------------------------------------
create or replace function public.record_channel_health(
  p_channel uuid, p_state text, p_code text default null, p_detail text default null,
  p_account_name text default null, p_display_phone text default null, p_business_account_id text default null, p_metadata jsonb default '{}'::jsonb
) returns void language plpgsql security definer set search_path = '' as $$
declare c public.channels%rowtype; v_changed boolean;
begin
  if p_state not in ('pending', 'connected', 'needs_auth', 'token_expired', 'error', 'webhook_missing') then
    raise exception 'invalid state' using errcode = '22023';
  end if;
  select * into c from public.channels where id = p_channel for update;
  if not found then return; end if;
  -- Una verificación en vuelo no puede «reconectar» un número que alguien acaba de desconectar.
  if c.connection_status = 'disconnected' then return; end if;
  v_changed := c.connection_status is distinct from p_state;
  update public.channels set
    connection_status = p_state,
    last_checked_at   = now(),
    connected_at      = case when p_state = 'connected' then coalesce(connected_at, now()) else connected_at end,
    last_sync_at      = case when p_state = 'connected' then now() else last_sync_at end,
    last_error_code   = case when p_state = 'connected' then null else left(coalesce(p_code, last_error_code), 40) end,
    account_name      = coalesce(nullif(left(btrim(coalesce(p_account_name, '')), 120), ''), account_name),
    display_phone     = coalesce(nullif(left(btrim(coalesce(p_display_phone, '')), 30), ''), display_phone),
    business_account_id = coalesce(nullif(btrim(coalesce(p_business_account_id, '')), ''), business_account_id),
    metadata          = case when p_metadata is null or p_metadata = '{}'::jsonb then metadata else (metadata || p_metadata) end
   where id = p_channel;
  perform app.connection_event(p_channel, c.org_id, 'health_check', p_state = 'connected', p_code, p_detail, null);
  if v_changed then
    perform app.emit_event(c.org_id, 'channel.connection_changed', 'channel', c.id, jsonb_build_object('from', c.connection_status, 'to', p_state), null);
  end if;
end $$;

-- Actividad real: un mensaje recibido prueba que el webhook llega; un envío aceptado por Meta prueba que el token sirve.
-- Se escribe como máximo una vez por minuto por número para no generar bloqueos en la fila del canal.
create or replace function public.touch_channel(p_phone_number_id text, p_kind text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_kind = 'webhook' then
    update public.channels set
      last_webhook_at = now(),
      last_error_code = case when connection_status = 'webhook_missing' then null else last_error_code end,
      connection_status = case when connection_status = 'webhook_missing' then 'connected' else connection_status end
     where kind = 'whatsapp' and external_id = p_phone_number_id and connection_status <> 'disconnected'
       and (last_webhook_at is null or last_webhook_at < now() - interval '1 minute' or connection_status = 'webhook_missing');
  elsif p_kind = 'send_ok' then
    update public.channels set
      last_sync_at = now(),
      last_error_code = case when connection_status in ('pending', 'error', 'token_expired', 'needs_auth') then null else last_error_code end,
      connection_status = case when connection_status in ('pending', 'error', 'token_expired', 'needs_auth') then 'connected' else connection_status end
     where kind = 'whatsapp' and external_id = p_phone_number_id and connection_status <> 'disconnected'
       and (last_sync_at is null or last_sync_at < now() - interval '1 minute' or connection_status <> 'connected');
  else
    raise exception 'invalid kind' using errcode = '22023';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Acciones del administrador
-- ---------------------------------------------------------------------------
-- Guardar un token nuevo deja la conexión «pendiente» (hay que verificarla) y reabre una desconectada.
create or replace function public.save_channel_token(p_channel uuid, p_token text) returns void
language plpgsql security definer set search_path = '' as $$
declare c public.channels%rowtype;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into c from public.channels where id = p_channel;
  if not found or not app.has_permission(c.org_id, 'settings:manage') then raise exception 'not allowed' using errcode = '42501'; end if;
  insert into public.channel_secrets (channel_id, access_token, updated_by) values (p_channel, btrim(p_token), auth.uid())
  on conflict (channel_id) do update set access_token = excluded.access_token, updated_at = now(), updated_by = auth.uid();
  update public.channels set
    connection_status = 'pending', last_error_code = null,
    disconnected_at = null, connected_at = case when connection_status = 'disconnected' then null else connected_at end
   where id = p_channel;
  perform app.connection_event(p_channel, c.org_id, case when c.connection_status = 'disconnected' then 'reconnected' else 'token_saved' end, true, null, null, auth.uid());
  -- El evento NO incluye el token.
  perform app.emit_event(c.org_id, 'channel.token_updated', 'channel', c.id, '{}'::jsonb, null);
end $$;

create or replace function public.set_channel_business_account(p_channel uuid, p_waba text) returns void
language plpgsql security definer set search_path = '' as $$
declare c public.channels%rowtype;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into c from public.channels where id = p_channel;
  if not found or not app.has_permission(c.org_id, 'settings:manage') then raise exception 'not allowed' using errcode = '42501'; end if;
  update public.channels set business_account_id = nullif(btrim(coalesce(p_waba, '')), '') where id = p_channel;
end $$;

-- Desconectar: borra el token (ya no se puede enviar), conserva TODO el historial.
create or replace function public.disconnect_channel(p_channel uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare c public.channels%rowtype;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into c from public.channels where id = p_channel for update;
  if not found or not app.has_permission(c.org_id, 'settings:manage') then raise exception 'not allowed' using errcode = '42501'; end if;
  if c.connection_status = 'disconnected' then return; end if;
  delete from public.channel_secrets where channel_id = p_channel;
  update public.channels set connection_status = 'disconnected', disconnected_at = now(), last_error_code = null where id = p_channel;
  perform app.connection_event(p_channel, c.org_id, 'disconnected', true, null, null, auth.uid());
  perform app.emit_event(c.org_id, 'channel.disconnected', 'channel', c.id, '{}'::jsonb, null);
end $$;

-- Bloqueo de envío: un número desconectado no envía (lo recibido antes sigue visible en el Inbox).
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

revoke all on function app.connection_event(uuid, uuid, text, boolean, text, text, uuid) from public, anon, authenticated;
revoke all on function public.record_channel_health(uuid, text, text, text, text, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.touch_channel(text, text) from public, anon, authenticated;
grant execute on function public.record_channel_health(uuid, text, text, text, text, text, text, jsonb) to service_role;
grant execute on function public.touch_channel(text, text) to service_role;
revoke all on function public.set_channel_business_account(uuid, text), public.disconnect_channel(uuid) from public, anon;
grant execute on function public.set_channel_business_account(uuid, text), public.disconnect_channel(uuid) to authenticated, service_role;

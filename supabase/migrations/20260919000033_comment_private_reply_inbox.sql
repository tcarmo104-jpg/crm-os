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

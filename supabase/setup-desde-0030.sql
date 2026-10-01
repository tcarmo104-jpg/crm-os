-- =============================================================================
-- CRM OS · ACTUALIZACIÓN: migraciones 0030 en adelante (para un proyecto que YA tiene 0001 a 0029)
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
  if to_regclass('public.tasks') is null and 30 > 10 then
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
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'ingest_channel_message' and pg_get_functiondef(p.oid) like '%needs_avatar%') then
    raise exception 'Este proyecto YA tiene instalada la migración 0030 (ingest_channel_message ya devuelve needs_avatar). No ejecutes este archivo: avísame.';
  end if;
end $$;

-- ---------------- 20260919000030_avatar_backfill.sql ----------------
-- =============================================================================
-- 0030 FOTO DE PERFIL: TAMBIÉN PARA CONVERSACIONES QUE YA EXISTÍAN
-- =============================================================================
-- La Fase anterior solo pedía la foto (junto con el nombre) la PRIMERA vez que se abría una conversación
-- nueva. Un cliente real lo notó: las conversaciones que ya existían ANTES de esa fase nunca volvían a
-- pedirla, así que se quedaban sin foto para siempre. Aditivo: `ingest_channel_message` ahora también avisa
-- si al cliente le falta la foto (además de si la conversación es nueva), sin ninguna consulta extra —ya
-- tenía el cliente cargado en memoria—, y el código del webhook pide el perfil en cualquiera de los dos
-- casos. Una vez que la foto queda guardada, no se vuelve a pedir (se sigue respetando lo que ya hacía
-- `set_contact_profile`: nunca pisa una foto que ya existe).
-- =============================================================================

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
                            'new_conversation', v_new, 'reopened', v_reopened, 'opt_out', v_optout, 'needs_avatar', cust.avatar_url is null);
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

-- =============================================================================
-- CRM OS · ACTUALIZACIÓN: migraciones 0031 en adelante (para un proyecto que YA tiene 0001 a 0030)
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
  if to_regclass('public.tasks') is null and 31 > 10 then
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
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'customers' and column_name = 'avatar_checked_at') then
    raise exception 'Este proyecto YA tiene instalada la migración 0031 (existe customers.avatar_checked_at). No ejecutes este archivo: avísame.';
  end if;
end $$;

-- ---------------- 20260919000031_avatar_refresh.sql ----------------
-- =============================================================================
-- 0031 FOTO DE PERFIL: SE REVISA DE NUEVO CADA 30 DÍAS
-- =============================================================================
-- Hasta ahora la foto se guardaba una sola vez y nunca se volvía a tocar: si la persona cambiaba su foto de
-- perfil en Facebook o Instagram, el CRM se quedaba con la vieja para siempre. Ahora se guarda cuándo fue la
-- última vez que se revisó (`avatar_checked_at`), y pasados 30 días se vuelve a pedir — sin que nadie tenga
-- que hacer nada. Si Meta no devuelve foto esa vez (o la persona no tiene ninguna pública), igual se marca
-- como revisado, para no insistir en cada mensaje.
-- =============================================================================

alter table public.customers add column if not exists avatar_checked_at timestamptz;
-- A quien ya tenía una foto guardada se le marca como «recién revisada» (no como pendiente desde hace
-- tiempo): evita que, al instalar esto, todos los clientes con foto se vuelvan a consultar de inmediato.
update public.customers set avatar_checked_at = now() where avatar_url is not null and avatar_checked_at is null;

create or replace function public.set_contact_profile(p_conversation uuid, p_name text, p_avatar_url text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
  conv public.conversations%rowtype;
  v_name text := nullif(left(btrim(coalesce(p_name, '')), 160), '');
  v_avatar text := nullif(left(btrim(coalesce(p_avatar_url, '')), 500), '');
begin
  select * into conv from public.conversations where id = p_conversation;
  if not found then return; end if;
  if v_name is not null then
    update public.conversations set contact_name = v_name where id = conv.id and contact_name is null;
    update public.customers set full_name = v_name where id = conv.customer_id and full_name ~ '^Contacto de (Facebook|Instagram) [0-9]{4}$';
  end if;
  -- Solo si empieza con https:// hacia Meta: nunca se guarda una URL arbitraria que venga de un campo de texto.
  if v_avatar is not null and v_avatar !~ '^https://[a-zA-Z0-9.-]*\.(fbcdn\.net|cdninstagram\.com|fbsbx\.com)(/|$)' then
    v_avatar := null;
  end if;
  -- Que esta función se haya llamado ya significa que Meta respondió algo: se marca como revisado ahora
  -- mismo (así no se vuelve a pedir en cada mensaje si, por ejemplo, la persona no tiene foto pública).
  -- La URL guardada solo cambia si es la primera vez, o si ya pasaron 30 días desde la última revisión.
  update public.customers set
    avatar_checked_at = now(),
    avatar_url = case
      when v_avatar is null then avatar_url
      when avatar_url is null or avatar_checked_at is null or avatar_checked_at < now() - interval '30 days' then v_avatar
      else avatar_url
    end
  where id = conv.customer_id;
end $$;

revoke all on function public.set_contact_profile(uuid, text, text) from public, anon, authenticated;
grant execute on function public.set_contact_profile(uuid, text, text) to service_role;

-- `needs_avatar` ahora también se enciende cuando toca revisar de nuevo (no solo cuando nunca hubo foto).
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
    'new_conversation', v_new, 'reopened', v_reopened, 'opt_out', v_optout,
    'needs_avatar', cust.avatar_url is null or cust.avatar_checked_at is null or cust.avatar_checked_at < v_at - interval '30 days');
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

-- =============================================================================
-- CRM OS · ACTUALIZACIÓN: migraciones 0029 en adelante (para un proyecto que YA tiene 0001 a 0028)
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
  if to_regclass('public.tasks') is null and 29 > 10 then
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
end $$;

-- ---------------- 20260919000029_outbound_voice.sql ----------------
-- =============================================================================
-- 0029 NOTAS DE VOZ ENVIADAS (grabadas desde el CRM)
-- =============================================================================
-- `message_attachments.is_voice` ya existía desde la Fase de multimedia, pero solo se rellenaba para lo que
-- LLEGA (WhatsApp marca sus notas de voz). Lo enviado nunca lo marcaba: siempre quedaba en `false`, así que
-- el propio agente veía su nota de voz como un audio cualquiera. Aditivo: no cambia nada de lo que ya envía
-- un archivo normal (is_voice sigue en `false` por defecto).
-- =============================================================================

alter table public.attachment_uploads add column if not exists is_voice boolean not null default false;

drop function if exists public.create_attachment_upload(uuid, text, text, bigint);

create function public.create_attachment_upload(p_conversation uuid, p_file_name text, p_mime text, p_size bigint, p_is_voice boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare conv public.conversations%rowtype; v_id uuid := gen_random_uuid(); v_name text := btrim(coalesce(p_file_name, ''));
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into conv from public.conversations where id = p_conversation;
  if not found or not app.can_access_row(conv.org_id, 'conversations:update', conv.owner_id, conv.team_id) then raise exception 'not allowed' using errcode = '42501'; end if;
  if v_name = '' or char_length(v_name) > 255 then raise exception 'invalid file name' using errcode = '22023'; end if;
  if coalesce(p_size, 0) <= 0 or p_size > 104857600 then raise exception 'invalid file size' using errcode = '22023'; end if;
  if (select count(*) from public.attachment_uploads where user_id = auth.uid() and status in ('created', 'verified') and expires_at > now()) >= 20 then
    raise exception 'too_many_uploads' using errcode = '23514';
  end if;
  insert into public.attachment_uploads (id, org_id, conversation_id, user_id, file_name, mime_type, file_size, storage_path, is_voice)
  values (v_id, conv.org_id, conv.id, auth.uid(), v_name, left(btrim(coalesce(p_mime, '')), 150), p_size, conv.org_id || '/' || conv.id || '/' || v_id, coalesce(p_is_voice, false));
  return jsonb_build_object('id', v_id, 'path', conv.org_id || '/' || conv.id || '/' || v_id, 'channel_id', conv.channel_id);
end $$;

-- Igual que antes, solo se agrega `is_voice` a lo que ya insertaba (viene del propio adjunto, no de lo que
-- diga quien llama: nadie puede marcar como voz algo que no se creó como voz).
create or replace function public.queue_media_message(p_conversation uuid, p_uploads uuid[], p_caption text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  conv public.conversations%rowtype; ch public.channels%rowtype; cust public.customers%rowtype; u public.attachment_uploads%rowtype;
  v_window boolean; v_caption text := nullif(btrim(coalesce(p_caption, '')), ''); v_id uuid; v_n integer := coalesce(array_length(p_uploads, 1), 0);
  v_body text; v_pos smallint := 0; v_uid uuid; v_max integer; v_total bigint := 0;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into conv from public.conversations where id = p_conversation for update;
  if not found or not app.can_access_row(conv.org_id, 'conversations:update', conv.owner_id, conv.team_id) then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into ch from public.channels where id = conv.channel_id;
  if ch.status <> 'active' then raise exception 'channel_paused' using errcode = '23514'; end if;
  if ch.connection_status = 'disconnected' then raise exception 'connection_unavailable' using errcode = '23514'; end if;
  select * into cust from public.customers where id = conv.customer_id;
  v_window := conv.last_inbound_at is not null and conv.last_inbound_at > clock_timestamp() - case when ch.kind = 'gmail' then interval '30 days' else interval '24 hours' end;
  if not v_window then raise exception 'window_closed' using errcode = '23514'; end if;
  v_max := case when ch.kind = 'gmail' then 10 else 1 end;
  if v_n < 1 or v_n > v_max then raise exception 'attachment_count' using errcode = '22023'; end if;
  if v_caption is not null and char_length(v_caption) > 4096 then raise exception 'message_too_long' using errcode = '22023'; end if;

  if (select count(distinct x) from unnest(p_uploads) x) <> v_n then raise exception 'attachment_invalid' using errcode = '22023'; end if;
  foreach v_uid in array p_uploads loop
    select * into u from public.attachment_uploads where id = v_uid for update;
    if not found or u.user_id <> auth.uid() or u.conversation_id <> conv.id or u.status <> 'verified' or u.expires_at <= now() then
      raise exception 'attachment_invalid' using errcode = '22023';
    end if;
    v_total := v_total + u.file_size;
  end loop;
  if ch.kind = 'gmail' and v_total > 26214400 then raise exception 'attachments_too_large' using errcode = '22023'; end if;

  select * into u from public.attachment_uploads where id = p_uploads[1];
  v_body := coalesce(v_caption, case when v_n > 1 then '[' || v_n || ' adjuntos]'
                                      else '[' || case when u.is_voice then 'Nota de voz' when u.kind = 'image' then 'Imagen' when u.kind = 'video' then 'Video' when u.kind = 'audio' then 'Audio'
                                                     else 'Documento: ' || left(u.file_name, 120) end || ']' end);
  insert into public.messages (org_id, channel_id, conversation_id, direction, kind, body, status, sent_by, occurred_at)
  values (conv.org_id, conv.channel_id, conv.id, 'outbound', 'media', v_body, 'queued', auth.uid(), clock_timestamp()) returning id into v_id;

  foreach v_uid in array p_uploads loop
    select * into u from public.attachment_uploads where id = v_uid;
    insert into public.message_attachments (id, org_id, message_id, conversation_id, position, direction, kind, mime_type, file_name, file_size, width, height, storage_path, status, is_voice)
    values (u.id, u.org_id, v_id, conv.id, v_pos, 'outbound', coalesce(u.kind, 'file'), u.mime_type, u.file_name, u.file_size, u.width, u.height, u.storage_path, 'stored', u.is_voice);
    update public.attachment_uploads set status = 'used' where id = u.id;
    v_pos := v_pos + 1;
  end loop;

  update public.conversations set last_message_at = clock_timestamp(), last_direction = 'outbound', needs_reply = false, unread = false,
         last_message_preview = left(regexp_replace(v_body, '\s+', ' ', 'g'), 140) where id = conv.id;
  return v_id;
end $$;

revoke all on function public.create_attachment_upload(uuid, text, text, bigint, boolean) from public, anon;
grant execute on function public.create_attachment_upload(uuid, text, text, bigint, boolean) to authenticated, service_role;

commit;

-- Comprobación final: 'tablas' y 'tablas_con_rls' deben ser iguales.
select 'LISTO' as estado,
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r') as tablas,
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity) as tablas_con_rls,
  (select count(*) from public.permissions) as permisos,
  (select count(*) from public.roles where org_id is null) as roles_base;

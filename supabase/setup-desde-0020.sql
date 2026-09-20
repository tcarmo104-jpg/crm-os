-- =============================================================================
-- CRM OS · ACTUALIZACIÓN: migraciones 0020 en adelante (para un proyecto que YA tiene 0001 a 0019)
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
  if to_regclass('public.tasks') is null and 20 > 10 then
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
end $$;

-- ---------------- 20260919000020_opportunity_channel_gmail.sql ----------------
-- =============================================================================
-- 0020 CORRECCIÓN: oportunidades de clientes que escribieron por Gmail
-- =============================================================================
-- Error: al crear una oportunidad, el disparador `app.opportunities_defaults` copia el TIPO DE CANAL de la última conversación del
-- cliente (`channels.kind`). Desde que existe Gmail ese tipo es «gmail», pero la restricción de `opportunities.channel` solo admite
-- «email» → crear la oportunidad de un cliente cuya última conversación fue por Gmail fallaba con un error de base de datos.
-- Arreglo: «gmail» se guarda como «email» (whatsapp, instagram y facebook ya coinciden). Mismo cuerpo que en 0015, con esa única diferencia.
-- =============================================================================
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
      -- El canal de la oportunidad usa el vocabulario comercial: un correo de Gmail es «email».
      if new.channel is null then new.channel := case when v_kind = 'gmail' then 'email' else v_kind end; end if;
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

commit;

-- Comprobación final: 'tablas' y 'tablas_con_rls' deben ser iguales.
select 'LISTO' as estado,
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r') as tablas,
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity) as tablas_con_rls,
  (select count(*) from public.permissions) as permisos,
  (select count(*) from public.roles where org_id is null) as roles_base;

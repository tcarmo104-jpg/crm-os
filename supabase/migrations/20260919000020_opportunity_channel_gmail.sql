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

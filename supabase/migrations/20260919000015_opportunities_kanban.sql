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

-- =============================================================================
-- 0036 MÉTRICAS DEL WIDGET DE WHATSAPP (Fase 4 del widget)
-- =============================================================================
-- La atribución (widget, página, producto, UTMs, región) ya está en `leads.raw_payload` desde 0034, y la cadena
-- lead → conversación → oportunidad → venta ya existe. Esta migración agrega SOLO lo que faltaba para medir:
--
-- 1. `conversation_closures`: cuándo se cerró cada conversación. Hoy cerrar una conversación no deja fecha en
--    ningún lado (no hay `closed_at` ni evento), y una conversación de WhatsApp es una sola por contacto que se
--    reabre con cada mensaje nuevo: una columna `closed_at` perdería el historial al reabrir. Un registro de
--    solo-anexar, alimentado por trigger, cubre todos los caminos (botón del Inbox, reapertura automática…).
--    No hay forma honesta de reconstruir cierres pasados: el tiempo de resolución cuenta desde esta migración.
--
-- 2. `widget_lead_facts`: una fila por lead del widget con lo que le pasó después. Toda la agregación (filtros,
--    desgloses, tasas) se hace en `lib/analytics.ts`, como el resto del Dashboard.
-- =============================================================================

-- ---------------------------------------------------------------------------------------- 1. cierres
create table public.conversation_closures (
  id               bigint generated always as identity primary key,
  org_id           uuid not null references public.organizations(id) on delete cascade,
  conversation_id  uuid not null,
  closed_at        timestamptz not null default clock_timestamp(),
  closed_by        uuid references auth.users(id) on delete set null,   -- null = sistema / service_role
  foreign key (conversation_id, org_id) references public.conversations (id, org_id) on delete cascade
);
create index conversation_closures_conv_idx on public.conversation_closures (conversation_id, closed_at);

-- Sin políticas: nadie la lee directo; solo `widget_lead_facts` (que aplica sus propios permisos).
alter table public.conversation_closures enable row level security;
revoke all on public.conversation_closures from anon, authenticated;
grant all on public.conversation_closures to service_role;

create or replace function app.conversations_log_closure() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'closed' and old.status is distinct from 'closed' then
    insert into public.conversation_closures (org_id, conversation_id, closed_by) values (new.org_id, new.id, auth.uid());
  end if;
  return null;
end $$;
create trigger conversations_log_closure_trg after update of status on public.conversations
  for each row execute function app.conversations_log_closure();

-- ------------------------------------------------------------------------------ 2. hechos por lead
-- Cómo se atribuye cada cosa a un lead del widget (L, recibido en t, del cliente C):
--   * «Escribió por WhatsApp»: el primer mensaje ENTRANTE de C en el número del widget desde t (−1 min de
--     tolerancia: la hora del mensaje la pone WhatsApp, redondeada al segundo) y dentro de las 24 h siguientes.
--     El visitante es redirigido a WhatsApp en el acto; si no escribió en 24 h, abandonó en ese paso.
--   * «Primera respuesta»: el primer mensaje SALIENTE enviado por una persona (`sent_by` no nulo; las
--     automatizaciones y secuencias van sin `sent_by`) en esa conversación, después de ese primer mensaje.
--   * «Resolución»: el primer cierre de esa conversación después de ese primer mensaje.
--   * «Oportunidad»: la que se convirtió desde el lead (`converted_opportunity_id`) o, si no, la primera
--     oportunidad de C creada desde t. El botón del Inbox (Fase 2) crea la oportunidad para el cliente, no
--     para el lead: por eso hace falta esta regla.
--   * «Venta»: la primera venta no anulada de esa oportunidad.
-- Todo lo anterior se corta en el SIGUIENTE lead de widget de C: si volvió a escribir por el widget, lo que
-- pasó desde ahí se le atribuye al lead nuevo (no se cuenta dos veces).
create or replace function public.widget_lead_facts(p_org uuid, p_from timestamptz, p_to timestamptz, p_limit int default 5000)
returns table (
  lead_id uuid, received_at timestamptz, customer_id uuid, is_new boolean,
  widget_id uuid, widget_name text, page_url text, product_url text,
  utm_source text, utm_medium text, utm_campaign text, region text,
  owner_id uuid, team_id uuid,
  first_inbound_at timestamptz, first_response_at timestamptz, closed_at timestamptz,
  opportunity_id uuid, opportunity_created_at timestamptz, opportunity_status text,
  sale_id uuid, sale_total numeric, sold_at timestamptz
)
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  -- `security definer` porque los widgets (para saber su número de WhatsApp) solo los lee settings:manage.
  -- Por eso se aplican aquí, a mano, el mismo permiso de las pantallas de Analítica y el MISMO predicado de
  -- la política `leads_select`: cada rol ve exactamente los leads que ya veía.
  if not app.has_permission(p_org, 'reports:read') then raise exception 'not allowed' using errcode = '42501'; end if;

  return query
  with base as (
    select l.id, l.received_at, l.customer_id, l.resolution, l.owner_id, l.team_id, l.converted_opportunity_id, l.raw_payload as raw,
           case when (l.raw_payload ->> 'widget_id') ~ '^[0-9a-fA-F-]{36}$' then (l.raw_payload ->> 'widget_id')::uuid end as w_id
      from public.leads l
     where l.org_id = p_org and l.source = 'widget_web'
       and l.received_at >= p_from and l.received_at <= p_to
       and app.can_access_row(l.org_id, 'leads:read', l.owner_id, l.team_id)
     order by l.received_at desc
     limit greatest(1, least(coalesce(p_limit, 5000), 20000))
  )
  select b.id, b.received_at, b.customer_id, b.resolution in ('created', 'review'),
         b.w_id, nullif(b.raw ->> 'widget_name', ''), nullif(b.raw ->> 'page_url', ''), nullif(b.raw ->> 'product_url', ''),
         nullif(b.raw ->> 'utm_source', ''), nullif(b.raw ->> 'utm_medium', ''), nullif(b.raw ->> 'utm_campaign', ''), nullif(b.raw ->> 'region', ''),
         b.owner_id, b.team_id,
         fi.at, fr.at, fc.at,
         op.id, op.created_at, op.status,
         sa.id, sa.total, sa.sold_at
    from base b
    -- Hasta dónde llega este lead: el siguiente lead de widget del mismo cliente (sin importar el rango ni quién lo vea).
    cross join lateral (
      select min(n.received_at) as at from public.leads n
       where n.customer_id = b.customer_id and n.org_id = p_org and n.source = 'widget_web' and n.received_at > b.received_at
    ) nx
    left join public.whatsapp_widgets w on w.id = b.w_id and w.org_id = p_org
    left join lateral (
      select m.conversation_id as conv, m.occurred_at as at
        from public.conversations c
        join public.channels ch on ch.id = c.channel_id and ch.kind = 'whatsapp'
        join public.messages m on m.conversation_id = c.id and m.direction = 'inbound'
       where c.customer_id = b.customer_id and c.org_id = p_org
         and (w.channel_id is null or c.channel_id = w.channel_id)   -- widget borrado: cualquier número de WhatsApp
         and m.occurred_at >= b.received_at - interval '1 minute'
         and m.occurred_at <  least(b.received_at + interval '24 hours', coalesce(nx.at, 'infinity'))
       order by m.occurred_at, m.created_at limit 1
    ) fi on true
    left join lateral (
      select min(m.occurred_at) as at from public.messages m
       where fi.conv is not null and m.conversation_id = fi.conv and m.direction = 'outbound'
         and m.sent_by is not null and m.status <> 'failed' and m.occurred_at >= fi.at
    ) fr on true
    left join lateral (
      select min(k.closed_at) as at from public.conversation_closures k
       where fi.conv is not null and k.conversation_id = fi.conv and k.closed_at >= fi.at
    ) fc on true
    left join lateral (
      select o.id, o.created_at, o.status from public.opportunities o
       where o.org_id = p_org
         and (o.id = b.converted_opportunity_id
              or (b.converted_opportunity_id is null and o.customer_id = b.customer_id
                  and o.created_at >= b.received_at - interval '1 minute' and o.created_at < coalesce(nx.at, 'infinity')))
       order by o.created_at limit 1
    ) op on true
    left join lateral (
      select s.id, s.total, s.sold_at from public.sales s
       where op.id is not null and s.opportunity_id = op.id and s.status <> 'cancelled'
       order by s.sold_at limit 1
    ) sa on true
   order by b.received_at desc;
end $$;

revoke all on function app.conversations_log_closure() from public, anon, authenticated;
revoke all on function public.widget_lead_facts(uuid, timestamptz, timestamptz, int) from public, anon;
grant execute on function public.widget_lead_facts(uuid, timestamptz, timestamptz, int) to authenticated, service_role;

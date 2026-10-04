-- =============================================================================
-- 0034 WIDGET DE WHATSAPP PARA SITIOS WEB (Fase 1: lo esencial de punta a punta)
-- =============================================================================
-- El botón NO abre un chat en vivo dentro de la página (eso no es posible de forma legítima con la API
-- oficial de WhatsApp Business para un visitante anónimo). En vez de eso: captura nombre/teléfono/mensaje
-- con toda su atribución, crea o encuentra el contacto (reutilizando `app.ingest_lead_core`, el mismo motor
-- que ya usa la API pública de leads), y devuelve el número de WhatsApp para que el navegador del visitante
-- lo redirija a WhatsApp con el mensaje ya escrito. Esa conversación, cuando el visitante la envía de
-- verdad, llega por el webhook de siempre — nada nuevo que tocar ahí.
--
-- El «Widget ID» es público a propósito (va en el HTML del sitio del cliente, cualquiera puede verlo). La
-- seguridad no depende de que sea secreto: depende de validar el dominio desde el que llega cada solicitud,
-- y de un límite de velocidad por widget — igual que ya se hace con las llaves de API, pero sin llave.
-- =============================================================================

create table public.whatsapp_widgets (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references public.organizations(id) on delete cascade,
  channel_id        uuid not null references public.channels(id) on delete cascade,
  name              text not null check (char_length(btrim(name)) between 1 and 80),
  button_text       text not null default 'Escríbenos' check (char_length(button_text) <= 40),
  initial_message   text check (initial_message is null or char_length(initial_message) <= 300),
  position          text not null default 'bottom-right' check (position in ('bottom-right', 'bottom-left')),
  show_text         boolean not null default true,
  color             text not null default '#25D366' check (color ~ '^#[0-9a-fA-F]{6}$'),
  size              text not null default 'medium' check (size in ('small', 'medium', 'large')),
  active            boolean not null default true,
  allowed_domains   text[] not null default '{}',
  created_by        uuid references auth.users(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  conversations_count integer not null default 0
);
create index whatsapp_widgets_org_idx on public.whatsapp_widgets (org_id, created_at desc);
create trigger whatsapp_widgets_touch before update on public.whatsapp_widgets for each row execute function app.touch_updated_at();

create table public.widget_rate_limits (
  widget_id    uuid not null references public.whatsapp_widgets(id) on delete cascade,
  window_start timestamptz not null,
  hits         int not null default 0,
  primary key (widget_id, window_start)
);

revoke all on public.whatsapp_widgets, public.widget_rate_limits from anon, authenticated;
grant select, insert, update, delete on public.whatsapp_widgets to authenticated;
grant all on public.whatsapp_widgets, public.widget_rate_limits to service_role;

alter table public.whatsapp_widgets enable row level security;
alter table public.widget_rate_limits enable row level security;

create policy whatsapp_widgets_select on public.whatsapp_widgets for select to authenticated
  using ((select app.has_permission(org_id, 'settings:manage')));
create policy whatsapp_widgets_insert on public.whatsapp_widgets for insert to authenticated
  with check ((select app.has_permission(org_id, 'settings:manage'))
    and exists (select 1 from public.channels c where c.id = channel_id and c.org_id = whatsapp_widgets.org_id and c.kind = 'whatsapp'));
create policy whatsapp_widgets_update on public.whatsapp_widgets for update to authenticated
  using ((select app.has_permission(org_id, 'settings:manage')))
  with check ((select app.has_permission(org_id, 'settings:manage'))
    and exists (select 1 from public.channels c where c.id = channel_id and c.org_id = whatsapp_widgets.org_id and c.kind = 'whatsapp'));
create policy whatsapp_widgets_delete on public.whatsapp_widgets for delete to authenticated
  using ((select app.has_permission(org_id, 'settings:manage')));

-- ---------------------------------------------------------------------------------------------- uso público
-- Configuración pública del widget (lo que el script embebido necesita para dibujar el botón). Nunca expone
-- el org_id, el canal, ni nada que no sea puramente visual.
create or replace function public.get_widget_config(p_widget_id uuid) returns jsonb
language sql security definer set search_path = '' as $$
  select case when w.id is null then jsonb_build_object('active', false) else
    jsonb_build_object('active', w.active, 'buttonText', w.button_text, 'initialMessage', w.initial_message,
      'position', w.position, 'showText', w.show_text, 'color', w.color, 'size', w.size)
  end
  from (select 1) x
  left join public.whatsapp_widgets w on w.id = p_widget_id
$$;

create or replace function public.start_widget_conversation(
  p_widget_id uuid, p_origin_host text, p_name text, p_phone text, p_company text, p_message text,
  p_page_url text, p_referrer text, p_product_url text,
  p_utm_source text, p_utm_medium text, p_utm_campaign text, p_utm_content text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  w public.whatsapp_widgets%rowtype; ch public.channels%rowtype;
  v_win timestamptz := date_trunc('minute', now()); v_hits int; v_host text := lower(btrim(coalesce(p_origin_host, '')));
  v_name text := nullif(btrim(coalesce(p_name, '')), ''); v_phone text := regexp_replace(coalesce(p_phone, ''), '[^0-9+]', '', 'g');
  v_payload jsonb; v_res jsonb;
begin
  select * into w from public.whatsapp_widgets where id = p_widget_id;
  if not found or not w.active then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;

  if v_host = '' or not (v_host = any(w.allowed_domains) or v_host like any(array(select '%.' || d from unnest(w.allowed_domains) d))) then
    return jsonb_build_object('ok', false, 'reason', 'domain_not_allowed');
  end if;

  insert into public.widget_rate_limits (widget_id, window_start, hits) values (p_widget_id, v_win, 1)
  on conflict (widget_id, window_start) do update set hits = public.widget_rate_limits.hits + 1
  returning hits into v_hits;
  if v_hits > 20 then return jsonb_build_object('ok', false, 'reason', 'rate_limited'); end if;
  delete from public.widget_rate_limits where widget_id = p_widget_id and window_start < now() - interval '1 hour';

  if v_name is null or char_length(v_name) > 160 then return jsonb_build_object('ok', false, 'reason', 'invalid_name'); end if;
  if char_length(v_phone) < 7 or char_length(v_phone) > 20 then return jsonb_build_object('ok', false, 'reason', 'invalid_phone'); end if;

  select * into ch from public.channels where id = w.channel_id;
  if ch.kind <> 'whatsapp' or ch.connection_status = 'disconnected' then return jsonb_build_object('ok', false, 'reason', 'channel_unavailable'); end if;

  v_payload := jsonb_build_object(
    'name', v_name, 'type', 'person', 'source', 'widget_web', 'channel', 'whatsapp', 'phone', v_phone,
    'identifiers', jsonb_build_array(jsonb_build_object('type', 'phone', 'value', v_phone)),
    'attrs', jsonb_strip_nulls(jsonb_build_object('company', nullif(btrim(coalesce(p_company, '')), ''))),
    'notes', nullif(btrim(coalesce(p_message, '')), ''),
    'raw', jsonb_strip_nulls(jsonb_build_object(
      'widget_id', p_widget_id, 'widget_name', w.name, 'domain', v_host,
      'page_url', nullif(btrim(coalesce(p_page_url, '')), ''), 'referrer', nullif(btrim(coalesce(p_referrer, '')), ''),
      'product_url', nullif(btrim(coalesce(p_product_url, '')), ''),
      'utm_source', nullif(btrim(coalesce(p_utm_source, '')), ''), 'utm_medium', nullif(btrim(coalesce(p_utm_medium, '')), ''),
      'utm_campaign', nullif(btrim(coalesce(p_utm_campaign, '')), ''), 'utm_content', nullif(btrim(coalesce(p_utm_content, '')), '')))
  );
  v_res := app.ingest_lead_core(w.org_id, v_payload, null, null);

  update public.whatsapp_widgets set conversations_count = conversations_count + 1 where id = p_widget_id;

  return jsonb_build_object('ok', true, 'phone', ch.display_phone, 'customerId', v_res ->> 'customer_id');
exception when others then
  return jsonb_build_object('ok', false, 'reason', 'internal_error');
end $$;

revoke all on function public.get_widget_config(uuid), public.start_widget_conversation(uuid, text, text, text, text, text, text, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.get_widget_config(uuid), public.start_widget_conversation(uuid, text, text, text, text, text, text, text, text, text, text, text, text) to service_role;

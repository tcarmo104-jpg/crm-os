-- =============================================================================
-- 0038 PANEL DEL WIDGET RENOVADO (Entrega 2 del refactor)
-- =============================================================================
-- Hasta aquí (0037) el motor de configuración existe pero el botón público del sitio web no lo usa todavía:
-- sigue mostrando el formulario único de siempre. Esta migración le da a `get_widget_config` todo lo que el
-- panel renovado necesita — el menú de intenciones (si el widget tiene opciones), horario de atención y el
-- asesor a mostrar — y a `start_widget_conversation` la capacidad de recibir qué intención se eligió y las
-- respuestas de sus campos, para guardarlas en la atribución del contacto. Ningún widget sin opciones ni
-- horario configurado cambia de comportamiento: sigue exactamente igual que hoy (REGLA DE NO REGRESIÓN).
-- =============================================================================

alter table public.whatsapp_widgets
  add column business_hours jsonb not null default '[]'::jsonb,
  add column timezone text not null default 'America/Bogota' check (char_length(timezone) between 1 and 60),
  add column out_of_hours_message text check (out_of_hours_message is null or char_length(out_of_hours_message) <= 300),
  add column show_advisor boolean not null default false,
  add column advisor_user_id uuid references auth.users(id) on delete set null;

-- `business_hours`: arreglo de franjas `[{"day": 0..6, "from": "HH:MM", "to": "HH:MM"}]` (0 = domingo, igual
-- que `extract(dow from …)`). Arreglo vacío (el valor por defecto) = sin horario configurado = siempre abierto,
-- que es el comportamiento de todos los widgets de antes de esta migración. Un CHECK no admite subconsultas,
-- así que la validación de cada franja vive en esta función (immutable: siempre el mismo resultado para la
-- misma entrada, como debe ser un CHECK).
create or replace function app.valid_business_hours(p jsonb) returns boolean
language sql immutable as $$
  select jsonb_typeof(p) = 'array' and coalesce((
    select bool_and(
      jsonb_typeof(e) = 'object'
      and (e ->> 'day') ~ '^[0-6]$'
      and (e ->> 'from') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
      and (e ->> 'to') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    ) from jsonb_array_elements(p) e
  ), true)
$$;
alter table public.whatsapp_widgets add constraint whatsapp_widgets_business_hours_shape check (app.valid_business_hours(business_hours));

-- El asesor que se muestra en el panel debe ser alguien de la MISMA organización del widget (si no, la FK
-- compuesta no existe para auth.users, así que se exige con una comprobación explícita en las políticas).
drop policy if exists whatsapp_widgets_insert on public.whatsapp_widgets;
drop policy if exists whatsapp_widgets_update on public.whatsapp_widgets;
create policy whatsapp_widgets_insert on public.whatsapp_widgets for insert to authenticated
  with check ((select app.has_permission(org_id, 'settings:manage'))
    and exists (select 1 from public.channels c where c.id = channel_id and c.org_id = whatsapp_widgets.org_id and c.kind = 'whatsapp')
    and (advisor_user_id is null or exists (select 1 from public.memberships m where m.user_id = advisor_user_id and m.org_id = whatsapp_widgets.org_id)));
create policy whatsapp_widgets_update on public.whatsapp_widgets for update to authenticated
  using ((select app.has_permission(org_id, 'settings:manage')))
  with check ((select app.has_permission(org_id, 'settings:manage'))
    and exists (select 1 from public.channels c where c.id = channel_id and c.org_id = whatsapp_widgets.org_id and c.kind = 'whatsapp')
    and (advisor_user_id is null or exists (select 1 from public.memberships m where m.user_id = advisor_user_id and m.org_id = whatsapp_widgets.org_id)));

-- ---------------------------------------------------------------------------------------------- uso público
-- `get_widget_config` (0034): misma firma (un solo uuid), se reemplaza en su lugar con `create or replace`.
-- Ahora también devuelve: el menú de intenciones con sus campos (si el widget tiene alguna activa), si está
-- dentro de horario de atención (y el mensaje a mostrar si no lo está), y el asesor a mostrar (si corresponde).
create or replace function public.get_widget_config(p_widget_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  w public.whatsapp_widgets%rowtype;
  v_options jsonb;
  v_is_open boolean := true;
  v_local_time time; v_local_day int;
  v_advisor jsonb := null;
begin
  select * into w from public.whatsapp_widgets where id = p_widget_id;
  if not found then return jsonb_build_object('active', false); end if;
  if not w.active then return jsonb_build_object('active', false); end if;

  -- Horario de atención: arreglo vacío = siempre abierto (comportamiento de siempre).
  if jsonb_array_length(w.business_hours) > 0 then
    begin
      v_local_time := (now() at time zone w.timezone)::time;
      v_local_day := extract(dow from (now() at time zone w.timezone))::int;
    exception when others then
      -- Un `timezone` inválido nunca debe tumbar el widget: se trata como siempre abierto.
      v_local_time := null;
    end;
    if v_local_time is not null then
      v_is_open := exists (
        select 1 from jsonb_array_elements(w.business_hours) e
        where (e ->> 'day')::int = v_local_day and v_local_time >= (e ->> 'from')::time and v_local_time <= (e ->> 'to')::time
      );
    end if;
  end if;

  -- Menú de intenciones (0037), cada una con sus campos propios en orden, listos para dibujar el formulario.
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', o.id, 'icon', o.icon, 'label', o.label, 'messageTemplate', o.message_template,
    'fields', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'fieldId', of.field_id, 'key', f.key, 'type', f.field_type,
        'label', coalesce(of.label_override, f.label), 'placeholder', coalesce(of.placeholder_override, f.placeholder),
        'options', f.options, 'required', of.required, 'defaultValue', of.default_value
      ) order by of.position), '[]'::jsonb)
      from public.widget_option_fields of join public.widget_fields f on f.id = of.field_id
      where of.option_id = o.id
    )
  ) order by o.position), '[]'::jsonb) into v_options
  from public.widget_options o where o.widget_id = w.id and o.active;

  if w.show_advisor and w.advisor_user_id is not null then
    select jsonb_build_object('name', p.full_name, 'avatarUrl', p.avatar_url) into v_advisor
    from public.profiles p where p.id = w.advisor_user_id;
  end if;

  return jsonb_build_object(
    'active', true, 'buttonText', w.button_text, 'initialMessage', w.initial_message,
    'position', w.position, 'showText', w.show_text, 'color', w.color, 'size', w.size,
    'messageTemplate', w.message_template, 'options', v_options,
    'isOpen', v_is_open, 'outOfHoursMessage', w.out_of_hours_message, 'advisor', v_advisor
  );
end $$;

-- `start_widget_conversation` (0034/0035): cambia de firma (se agregan `p_option_id` y `p_field_values` al
-- final) — hay que quitar la versión anterior explícitamente antes de crear la nueva, si no queda duplicada.
drop function if exists public.start_widget_conversation(uuid, text, text, text, text, text, text, text, text, text, text, text, text);

create function public.start_widget_conversation(
  p_widget_id uuid, p_origin_host text, p_name text, p_phone text, p_company text, p_message text,
  p_page_url text, p_referrer text, p_product_url text,
  p_utm_source text, p_utm_medium text, p_utm_campaign text, p_utm_content text,
  p_option_id uuid default null, p_field_values jsonb default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  w public.whatsapp_widgets%rowtype; ch public.channels%rowtype; opt public.widget_options%rowtype;
  v_win timestamptz := date_trunc('minute', now()); v_hits int; v_host text := lower(btrim(coalesce(p_origin_host, '')));
  v_name text := nullif(btrim(coalesce(p_name, '')), ''); v_phone text := regexp_replace(coalesce(p_phone, ''), '[^0-9+]', '', 'g');
  v_payload jsonb; v_res jsonb; v_owner uuid; v_field_values jsonb;
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

  -- La intención elegida (si viene) debe ser una opción activa de ESTE widget; si no, se ignora en vez de fallar
  -- (un formulario desactualizado en caché del visitante no debe bloquear el contacto).
  if p_option_id is not null then
    select * into opt from public.widget_options where id = p_option_id and widget_id = w.id and active;
  end if;
  -- Solo se guardan como máximo 20 respuestas de hasta 500 caracteres cada una: nunca un objeto arbitrariamente grande.
  if p_field_values is not null and jsonb_typeof(p_field_values) = 'object' then
    select jsonb_object_agg(key, left(value, 500)) into v_field_values
    from (select key, value from jsonb_each_text(p_field_values) limit 20) s;
  end if;

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
      'utm_campaign', nullif(btrim(coalesce(p_utm_campaign, '')), ''), 'utm_content', nullif(btrim(coalesce(p_utm_content, '')), ''),
      'region', w.region, 'option_id', opt.id, 'option_label', opt.label, 'field_values', v_field_values))
  );
  v_res := app.ingest_lead_core(w.org_id, v_payload, null, null);

  if v_res ->> 'outcome' in ('created', 'review') and not coalesce((v_res ->> 'deduplicated')::boolean, false) then
    begin
      v_owner := app.pick_assignee(w.org_id, 'whatsapp', p_widget_id, w.region);
      if v_owner is not null then
        update public.customers set owner_id = v_owner
         where id = (v_res ->> 'customer_id')::uuid and org_id = w.org_id and owner_id is null;
      end if;
    exception when others then
      null;
    end;
  end if;

  update public.whatsapp_widgets set conversations_count = conversations_count + 1 where id = p_widget_id;

  return jsonb_build_object('ok', true, 'phone', ch.display_phone, 'customerId', v_res ->> 'customer_id');
exception when others then
  return jsonb_build_object('ok', false, 'reason', 'internal_error');
end $$;

revoke all on function public.get_widget_config(uuid) from public, anon, authenticated;
grant execute on function public.get_widget_config(uuid) to service_role;
revoke all on function public.start_widget_conversation(uuid, text, text, text, text, text, text, text, text, text, text, text, text, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.start_widget_conversation(uuid, text, text, text, text, text, text, text, text, text, text, text, text, uuid, jsonb) to service_role;

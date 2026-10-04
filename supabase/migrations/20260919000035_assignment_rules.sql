-- =============================================================================
-- 0035 DISTRIBUCIÓN AUTOMÁTICA DE CONVERSACIONES (Fase 3 del widget de WhatsApp)
-- =============================================================================
-- Reglas ordenadas por prioridad: la primera que coincida (canal, widget, región, horario) decide a qué
-- EQUIPO va el contacto nuevo. Dentro de ese equipo, se reparte por turnos (round robin) entre sus
-- integrantes activos — así «por equipo», «por región» y «round robin» quedan unificados en un solo motor:
-- una regla por equipo YA reparte por turnos dentro de ese equipo; «por región» es una regla cuyo único
-- filtro es la región. Si ninguna regla coincide, el contacto queda sin asignar, como siempre.
--
-- Por ahora se conecta solo al Widget de WhatsApp (Fase 1): es el punto de entrada que la propia
-- especificación pedía resolver primero («Widget Web → WhatsApp → Bogotá → Equipo Bogotá»). El motor queda
-- escrito de forma general para conectarlo después a otros canales sin rehacer nada.
--
-- La REGIÓN la define cada widget en su configuración (un widget instalado en la web de la sede de Medellín
-- se configura con región «Medellín»); el visitante no escribe nada extra ni se geolocaliza por IP.
--
-- Solo un contacto NUEVO consume turno: primero se crea/encuentra el contacto, y únicamente si se creó en
-- esta llamada se elige a quién asignarlo. Un contacto que ya existía no avanza el reparto.
-- =============================================================================

insert into public.permissions (key, description) values
  ('assignment_rules:manage', 'Configurar las reglas de distribución automática de conversaciones');

insert into public.role_permissions (role_id, permission_key, scope)
select r.id, 'assignment_rules:manage', 'org' from public.roles r
where r.org_id is null and r.key in ('super_admin', 'admin', 'manager')
on conflict (role_id, permission_key) do update set scope = excluded.scope;

-- FK compuesta (id, org_id) para que una regla no pueda apuntar al widget de otra organización.
alter table public.whatsapp_widgets add constraint whatsapp_widgets_id_org_key unique (id, org_id);

-- Región del widget: la misma regla que `assignment_rules.region` (texto libre, máx. 80, sin espacios
-- sobrantes, vacía = null). Es la que se compara con las reglas al distribuir sus contactos.
alter table public.whatsapp_widgets add column region text check (region is null or char_length(region) <= 80);
create or replace function app.whatsapp_widgets_prepare() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.region := nullif(btrim(new.region), '');
  return new;
end $$;
create trigger whatsapp_widgets_prepare before insert or update on public.whatsapp_widgets for each row execute function app.whatsapp_widgets_prepare();

create table public.assignment_rules (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations(id) on delete cascade,
  name         text not null check (char_length(btrim(name)) between 1 and 80),
  active       boolean not null default true,
  priority     integer not null default 100,     -- menor número = se evalúa primero
  channel_kind text check (channel_kind in ('whatsapp', 'facebook', 'instagram', 'gmail')),  -- null = cualquier canal
  widget_id    uuid,                                                                          -- null = cualquier widget
  region       text check (region is null or char_length(region) <= 80),                     -- null = cualquier región
  team_id      uuid not null,
  hours_start  time,          -- null junto con hours_end = sin restricción de horario (atiende siempre)
  hours_end    time,
  hours_days   int[] not null default '{1,2,3,4,5,6,7}' check (hours_days <@ array[1,2,3,4,5,6,7]),  -- ISO: 1=lunes
  timezone     text not null default 'America/Bogota' check (char_length(timezone) <= 60),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  foreign key (team_id, org_id) references public.teams (id, org_id) on delete cascade,
  -- Borrar el widget borra sus reglas: con «set null» una regla de UN widget pasaba a aplicar a TODOS.
  foreign key (widget_id, org_id) references public.whatsapp_widgets (id, org_id) on delete cascade,
  -- Horario: las dos horas o ninguna, e inicio antes que fin (lo mismo que ya valida el formulario).
  check ((hours_start is null) = (hours_end is null)),
  check (hours_start is null or hours_start < hours_end)
);
create index assignment_rules_org_idx on public.assignment_rules (org_id, priority);
-- Zona horaria inválida = error al guardar (antes: error en tiempo de ejecución, tragado por el motor, y NINGUNA
-- regla de la organización asignaba). Región: sin espacios sobrantes, vacía = null.
create or replace function app.assignment_rules_prepare() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.region := nullif(btrim(new.region), '');
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = new.timezone) then
    raise exception 'Zona horaria no válida: %', new.timezone using errcode = '22023';
  end if;
  return new;
end $$;
create trigger assignment_rules_prepare before insert or update on public.assignment_rules for each row execute function app.assignment_rules_prepare();
create trigger assignment_rules_touch before update on public.assignment_rules for each row execute function app.touch_updated_at();

-- Guarda a quién le tocó el turno por última vez en cada regla, para repartir parejo entre el equipo.
create table public.assignment_rule_state (
  rule_id           uuid primary key references public.assignment_rules(id) on delete cascade,
  last_assigned_to  uuid references auth.users(id) on delete set null,
  updated_at        timestamptz not null default now()
);

revoke all on public.assignment_rules, public.assignment_rule_state from anon, authenticated;
grant select, insert, update, delete on public.assignment_rules to authenticated;
grant all on public.assignment_rules, public.assignment_rule_state to service_role;

alter table public.assignment_rules enable row level security;
alter table public.assignment_rule_state enable row level security;

create policy assignment_rules_select on public.assignment_rules for select to authenticated
  using ((select app.has_permission(org_id, 'assignment_rules:manage')));
create policy assignment_rules_insert on public.assignment_rules for insert to authenticated
  with check ((select app.has_permission(org_id, 'assignment_rules:manage')));
create policy assignment_rules_update on public.assignment_rules for update to authenticated
  using ((select app.has_permission(org_id, 'assignment_rules:manage')))
  with check ((select app.has_permission(org_id, 'assignment_rules:manage')));
create policy assignment_rules_delete on public.assignment_rules for delete to authenticated
  using ((select app.has_permission(org_id, 'assignment_rules:manage')));

-- ---------------------------------------------------------------------------------------------- el motor
-- Elige a quién asignar un contacto nuevo: la primera regla activa que coincida, repartiendo por turnos
-- dentro del equipo de esa regla. Nunca falla (mejor esfuerzo): si algo no encaja, no asigna a nadie, y el
-- contacto queda «sin asignar» como ya pasaba antes de que existiera esta función.
create or replace function app.pick_assignee(
  p_org uuid, p_channel_kind text, p_widget_id uuid, p_region text, p_at timestamptz default clock_timestamp()
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  rule record; member_ids uuid[]; last_id uuid; next_id uuid; idx int; local_ts timestamptz; dow int; tod time;
begin
  for rule in
    select * from public.assignment_rules
    where org_id = p_org and active
      and (channel_kind is null or channel_kind = p_channel_kind)
      and (widget_id is null or widget_id = p_widget_id)
      and (region is null or lower(region) = lower(btrim(coalesce(p_region, ''))))
    order by priority, created_at
  loop
    -- ¿Coincide el horario de esta regla? (sin hours_start/hours_end: siempre coincide)
    if rule.hours_start is not null and rule.hours_end is not null then
      local_ts := p_at at time zone rule.timezone;
      dow := extract(isodow from local_ts)::int;
      tod := local_ts::time;
      if not (dow = any(rule.hours_days) and tod >= rule.hours_start and tod < rule.hours_end) then
        continue;   -- fuera de horario: se prueba la siguiente regla por prioridad
      end if;
    end if;

    select array_agg(m.user_id order by m.user_id) into member_ids
      from public.memberships m where m.org_id = p_org and m.team_id = rule.team_id and m.status = 'active';
    if member_ids is null or array_length(member_ids, 1) = 0 then continue; end if;   -- equipo sin nadie activo: siguiente regla

    -- Bloqueo de la fila de estado: dos contactos simultáneos no pueden leer el mismo «último» y caerle al
    -- mismo agente. Se crea la fila si no existe y luego se toma con FOR UPDATE.
    insert into public.assignment_rule_state (rule_id) values (rule.id) on conflict (rule_id) do nothing;
    select last_assigned_to into last_id from public.assignment_rule_state where rule_id = rule.id for update;
    idx := coalesce(array_position(member_ids, last_id), 0) + 1;
    if idx > array_length(member_ids, 1) then idx := 1; end if;
    next_id := member_ids[idx];

    update public.assignment_rule_state set last_assigned_to = next_id, updated_at = now() where rule_id = rule.id;
    return next_id;
  end loop;
  return null;   -- ninguna regla coincidió: queda sin asignar, como antes
exception when others then
  return null;   -- nunca debe hacer fallar la creación del contacto por un problema en las reglas
end $$;
-- Como toda función de `app`: no la puede llamar un usuario directo (avanzaría turnos y vería IDs de otra org).
revoke all on function app.pick_assignee(uuid, text, uuid, text, timestamptz), app.assignment_rules_prepare(), app.whatsapp_widgets_prepare()
  from public, anon, authenticated;

-- `start_widget_conversation` (0034): mismo cuerpo y MISMA firma de 13 parámetros (por eso `create or replace`
-- la reemplaza en su lugar y conserva sus permisos). Dos cambios:
--   1. La región para las reglas sale del propio widget (`w.region`) y queda guardada en la atribución del lead.
--   2. El contacto se crea SIN dueño y, solo si `ingest_lead_core` confirma que es nuevo, se pide el turno y se
--      asigna. «Nuevo» = el cliente se creó en esta llamada: outcome 'created', o 'review' (también se creó;
--      solo quedó marcado porque OTRO cliente tiene el mismo nombre). 'matched' / 'conflict' = ya existía, y
--      'deduplicated' = lead repetido: ninguno consume turno ni cambia dueño.
--      Asignar después de crear dispara `customers_after_update`, que ya arrastra el dueño y el equipo al lead
--      y a la conversación, y deja «asignado a …» en la línea de tiempo del cliente.
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
  v_payload jsonb; v_res jsonb; v_owner uuid;
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
      'utm_campaign', nullif(btrim(coalesce(p_utm_campaign, '')), ''), 'utm_content', nullif(btrim(coalesce(p_utm_content, '')), ''),
      'region', w.region))
  );
  v_res := app.ingest_lead_core(w.org_id, v_payload, null, null);

  if v_res ->> 'outcome' in ('created', 'review') and not coalesce((v_res ->> 'deduplicated')::boolean, false) then
    -- Bloque propio: si la asignación falla, se deshace SOLO ella (incluido el turno) y el contacto queda creado
    -- sin asignar, como antes de que existieran las reglas.
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

-- `create or replace` conserva los permisos de 0034; se repiten aquí para que la migración sea explícita.
revoke all on function public.start_widget_conversation(uuid, text, text, text, text, text, text, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.start_widget_conversation(uuid, text, text, text, text, text, text, text, text, text, text, text, text) to service_role;

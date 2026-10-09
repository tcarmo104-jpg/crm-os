-- =============================================================================
-- 0039 FORMULARIO BASE DEL WIDGET (Entrega 4 del refactor: arquitectura profesional)
-- =============================================================================
-- Hasta aquí, los campos de un widget solo eran administrables DENTRO de una intención (0037/0038): si el
-- widget no tenía ningún menú de intenciones configurado, no había ninguna pantalla donde activar, pedir u
-- ordenar un campo — el formulario simple (nombre + teléfono + mensaje libre) era fijo. Eso es justo al
-- revés de cómo lo resuelven las plataformas de chat/formularios serias (Chatwoot, SocialIntents, etc.): el
-- formulario SIEMPRE es configurable, y el menú de intenciones es una capa de ENRUTAMIENTO aparte, no el
-- lugar donde viven los campos.
--
-- Esta migración agrega `widget_default_fields`: el mismo molde exacto de `widget_option_fields` (catálogo +
-- overrides + obligatorio + orden), pero asociado directo al WIDGET. Es el formulario que el visitante
-- siempre ve. Si además elige una intención, sus campos propios (si tiene) se SUMAN a estos — nunca los
-- reemplazan. Un widget que no configura nada aquí sigue mostrando el formulario de siempre (sin regresión).
-- =============================================================================

create table public.widget_default_fields (
  org_id                uuid not null references public.organizations(id) on delete cascade,
  widget_id             uuid not null,
  field_id              uuid not null,
  position              int not null default 0,
  required              boolean not null default false,
  label_override        text check (label_override is null or char_length(label_override) between 1 and 80),
  placeholder_override  text check (placeholder_override is null or char_length(placeholder_override) between 1 and 160),
  default_value         text check (default_value is null or char_length(default_value) <= 200),
  created_at            timestamptz not null default now(),
  primary key (widget_id, field_id),
  foreign key (widget_id, org_id) references public.whatsapp_widgets (id, org_id) on delete cascade,
  foreign key (field_id, org_id) references public.widget_fields (id, org_id) on delete cascade
);
create index widget_default_fields_widget_idx on public.widget_default_fields (widget_id, position);

revoke all on public.widget_default_fields from anon, authenticated;
grant select, insert, update, delete on public.widget_default_fields to authenticated;
grant all on public.widget_default_fields to service_role;
alter table public.widget_default_fields enable row level security;

create policy widget_default_fields_select on public.widget_default_fields for select to authenticated
  using ((select app.has_permission(org_id, 'settings:manage')));
-- El cruce widget↔org ya lo exige la FK compuesta (widget_id, org_id) → 23503 si no corresponde, igual que
-- en `widget_options`. Solo se agrega la comprobación explícita para el campo (como en `widget_option_fields`),
-- porque un `field_id` de otra organización con el `org_id` correcto NO viola ninguna FK por sí solo.
create policy widget_default_fields_insert on public.widget_default_fields for insert to authenticated
  with check ((select app.has_permission(org_id, 'settings:manage'))
    and exists (select 1 from public.widget_fields f where f.id = field_id and f.org_id = widget_default_fields.org_id));
create policy widget_default_fields_update on public.widget_default_fields for update to authenticated
  using ((select app.has_permission(org_id, 'settings:manage')))
  with check ((select app.has_permission(org_id, 'settings:manage')));
create policy widget_default_fields_delete on public.widget_default_fields for delete to authenticated
  using ((select app.has_permission(org_id, 'settings:manage')));

-- `get_widget_config` (0034/0038): misma firma, se reemplaza en su lugar. Se agrega la llave `fields`: el
-- formulario base del widget, en el mismo formato que ya usan los campos de cada intención (para que el
-- script público pueda combinarlos con una sola función de merge).
create or replace function public.get_widget_config(p_widget_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  w public.whatsapp_widgets%rowtype;
  v_options jsonb; v_default_fields jsonb;
  v_is_open boolean := true;
  v_local_time time; v_local_day int;
  v_advisor jsonb := null;
begin
  select * into w from public.whatsapp_widgets where id = p_widget_id;
  if not found then return jsonb_build_object('active', false); end if;
  if not w.active then return jsonb_build_object('active', false); end if;

  if jsonb_array_length(w.business_hours) > 0 then
    begin
      v_local_time := (now() at time zone w.timezone)::time;
      v_local_day := extract(dow from (now() at time zone w.timezone))::int;
    exception when others then
      v_local_time := null;
    end;
    if v_local_time is not null then
      v_is_open := exists (
        select 1 from jsonb_array_elements(w.business_hours) e
        where (e ->> 'day')::int = v_local_day and v_local_time >= (e ->> 'from')::time and v_local_time <= (e ->> 'to')::time
      );
    end if;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'fieldId', df.field_id, 'key', f.key, 'type', f.field_type,
    'label', coalesce(df.label_override, f.label), 'placeholder', coalesce(df.placeholder_override, f.placeholder),
    'options', f.options, 'required', df.required, 'defaultValue', df.default_value
  ) order by df.position), '[]'::jsonb) into v_default_fields
  from public.widget_default_fields df join public.widget_fields f on f.id = df.field_id
  where df.widget_id = w.id;

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
    'messageTemplate', w.message_template, 'fields', v_default_fields, 'options', v_options,
    'isOpen', v_is_open, 'outOfHoursMessage', w.out_of_hours_message, 'advisor', v_advisor
  );
end $$;

revoke all on function public.get_widget_config(uuid) from public, anon, authenticated;
grant execute on function public.get_widget_config(uuid) to service_role;

-- =============================================================================
-- 0037 MOTOR DE FORMULARIOS CONFIGURABLES DEL WIDGET (Entrega 1 del refactor)
-- =============================================================================
-- Hoy el widget tiene un único formulario fijo (nombre/teléfono/empresa/mensaje). Esta migración agrega el
-- motor para que cada organización defina SUS propios campos (estándar y personalizados) y SUS propias
-- «intenciones» (Comprar, Cotizar, Soporte…) por widget, cada una con su propio subconjunto de campos y su
-- propia plantilla de mensaje. Nada de esto se usa todavía desde el botón público (eso es la Entrega 2):
-- esta migración es solo el catálogo y su administración, así que no cambia el comportamiento actual.
--
-- 1. `widget_fields`: catálogo de campos de la organización (se reutiliza entre widgets), mismo patrón que
--    `custom_field_definitions` (0006) pero con su propio catálogo de tipos (los del formulario del widget:
--    texto, teléfono, correo, número, lista, párrafo, fecha — no los de Clientes/Leads/Oportunidades).
-- 2. `widget_options`: las intenciones de un widget (icono, etiqueta, plantilla de mensaje propia, orden).
-- 3. `widget_option_fields`: qué campos del catálogo aparecen en cada intención, en qué orden, y sus
--    variaciones por intención (obligatorio, etiqueta/placeholder propios, valor por defecto).
-- 4. `whatsapp_widgets.message_template`: la plantilla por defecto del widget (si una intención no define
--    la suya). `null` = se sigue comportando exactamente como hoy (`buildPrefilledMessage`).
-- =============================================================================

-- ---------------------------------------------------------------------------------------- 1. catálogo de campos
create table public.widget_fields (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organizations(id) on delete cascade,
  key            text not null check (key ~ '^[a-z][a-z0-9_]{1,39}$'),
  label          text not null check (char_length(btrim(label)) between 1 and 80),
  field_type     text not null default 'text'
                   check (field_type in ('text', 'phone', 'email', 'number', 'select', 'textarea', 'date')),
  placeholder    text check (placeholder is null or char_length(placeholder) <= 160),
  options        jsonb not null default '[]'::jsonb,  -- ['Opción 1', 'Opción 2'...] — solo para field_type = 'select'
  active         boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (org_id, key),
  unique (id, org_id)
);
create index widget_fields_org_idx on public.widget_fields (org_id, active);
create trigger widget_fields_touch before update on public.widget_fields for each row execute function app.touch_updated_at();

revoke all on public.widget_fields from anon, authenticated;
grant select, insert, update, delete on public.widget_fields to authenticated;
grant all on public.widget_fields to service_role;
alter table public.widget_fields enable row level security;

create policy widget_fields_select on public.widget_fields for select to authenticated
  using ((select app.has_permission(org_id, 'settings:manage')));
create policy widget_fields_insert on public.widget_fields for insert to authenticated
  with check ((select app.has_permission(org_id, 'settings:manage')));
create policy widget_fields_update on public.widget_fields for update to authenticated
  using ((select app.has_permission(org_id, 'settings:manage')))
  with check ((select app.has_permission(org_id, 'settings:manage')));
create policy widget_fields_delete on public.widget_fields for delete to authenticated
  using ((select app.has_permission(org_id, 'settings:manage')));

-- ------------------------------------------------------------------------------------- 2. intenciones del widget
create table public.widget_options (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.organizations(id) on delete cascade,
  widget_id        uuid not null,
  icon             text check (icon is null or char_length(icon) <= 16),
  label            text not null check (char_length(btrim(label)) between 1 and 60),
  message_template text check (message_template is null or char_length(message_template) <= 1000),
  position         int not null default 0,
  active           boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  foreign key (widget_id, org_id) references public.whatsapp_widgets (id, org_id) on delete cascade,
  unique (id, org_id)
);
create index widget_options_widget_idx on public.widget_options (widget_id, position);
create trigger widget_options_touch before update on public.widget_options for each row execute function app.touch_updated_at();

revoke all on public.widget_options from anon, authenticated;
grant select, insert, update, delete on public.widget_options to authenticated;
grant all on public.widget_options to service_role;
alter table public.widget_options enable row level security;

create policy widget_options_select on public.widget_options for select to authenticated
  using ((select app.has_permission(org_id, 'settings:manage')));
create policy widget_options_insert on public.widget_options for insert to authenticated
  with check ((select app.has_permission(org_id, 'settings:manage')));
create policy widget_options_update on public.widget_options for update to authenticated
  using ((select app.has_permission(org_id, 'settings:manage')))
  with check ((select app.has_permission(org_id, 'settings:manage')));
create policy widget_options_delete on public.widget_options for delete to authenticated
  using ((select app.has_permission(org_id, 'settings:manage')));

-- --------------------------------------------------------------------------- 3. campos de cada intención
create table public.widget_option_fields (
  org_id                uuid not null references public.organizations(id) on delete cascade,
  option_id             uuid not null,
  field_id              uuid not null,
  position              int not null default 0,
  required              boolean not null default false,
  label_override        text check (label_override is null or char_length(label_override) <= 80),
  placeholder_override  text check (placeholder_override is null or char_length(placeholder_override) <= 160),
  default_value         text check (default_value is null or char_length(default_value) <= 200),
  created_at            timestamptz not null default now(),
  primary key (option_id, field_id),
  foreign key (option_id, org_id) references public.widget_options (id, org_id) on delete cascade,
  foreign key (field_id, org_id) references public.widget_fields (id, org_id) on delete cascade
);
create index widget_option_fields_option_idx on public.widget_option_fields (option_id, position);

revoke all on public.widget_option_fields from anon, authenticated;
grant select, insert, update, delete on public.widget_option_fields to authenticated;
grant all on public.widget_option_fields to service_role;
alter table public.widget_option_fields enable row level security;

create policy widget_option_fields_select on public.widget_option_fields for select to authenticated
  using ((select app.has_permission(org_id, 'settings:manage')));
create policy widget_option_fields_insert on public.widget_option_fields for insert to authenticated
  with check (
    (select app.has_permission(org_id, 'settings:manage'))
    and exists (select 1 from public.widget_options o where o.id = option_id and o.org_id = widget_option_fields.org_id)
    and exists (select 1 from public.widget_fields f where f.id = field_id and f.org_id = widget_option_fields.org_id)
  );
create policy widget_option_fields_update on public.widget_option_fields for update to authenticated
  using ((select app.has_permission(org_id, 'settings:manage')))
  with check ((select app.has_permission(org_id, 'settings:manage')));
create policy widget_option_fields_delete on public.widget_option_fields for delete to authenticated
  using ((select app.has_permission(org_id, 'settings:manage')));

-- ------------------------------------------------------------------- 4. plantilla de mensaje por defecto
alter table public.whatsapp_widgets
  add column message_template text check (message_template is null or char_length(message_template) <= 1000);
comment on column public.whatsapp_widgets.message_template is
  'Plantilla con variables {{nombre}}, {{telefono}}, {{empresa}}, {{mensaje}}, {{origen}}... null = comportamiento actual (buildPrefilledMessage).';

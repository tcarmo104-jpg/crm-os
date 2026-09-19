-- =============================================================================
-- 0006 CAMPOS PERSONALIZADOS
-- =============================================================================
-- Cada organización define sus campos (por entidad). Los valores viven en una
-- columna jsonb `custom_fields` de la entidad y SE VALIDAN en la base de datos
-- contra las definiciones: no se puede guardar un valor de tipo incorrecto ni una
-- clave que no exista, venga de la UI, del CSV o de la API.
-- =============================================================================

create table public.custom_field_definitions (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  entity      text not null check (entity in ('customer', 'lead')),
  key         text not null check (key ~ '^[a-z][a-z0-9_]{1,39}$'),
  label       text not null check (char_length(btrim(label)) between 1 and 80),
  type        text not null check (type in ('text','number','date','select','multi_select','boolean','currency','url','phone','email')),
  options     jsonb not null default '[]'::jsonb,
  position    int  not null default 0,
  archived_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (org_id, entity, key),
  check (case when jsonb_typeof(options) = 'array'
              then (type in ('select', 'multi_select')) = (jsonb_array_length(options) > 0)
              else false end)
);
create index custom_field_defs_org_idx on public.custom_field_definitions (org_id, entity, position);

create trigger custom_field_defs_touch before update on public.custom_field_definitions
  for each row execute function app.touch_updated_at();

-- La clave y el tipo no cambian: invalidarían los datos ya guardados.
create or replace function app.custom_field_defs_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.org_id <> old.org_id or new.entity <> old.entity or new.key <> old.key or new.type <> old.type then
    raise exception 'custom field key, type and entity are immutable' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger custom_field_defs_guard_trg before update on public.custom_field_definitions
  for each row execute function app.custom_field_defs_guard();

-- ---------------------------------------------------------------------------
-- Validación de valores
-- ---------------------------------------------------------------------------
create or replace function app.validate_custom_fields(p_org uuid, p_entity text, p_values jsonb)
returns void language plpgsql stable security definer set search_path = '' as $$
declare
  k text; v jsonb; d public.custom_field_definitions%rowtype; s text; e text;
begin
  if p_values is null or p_values = '{}'::jsonb then return; end if;
  if jsonb_typeof(p_values) <> 'object' then
    raise exception 'custom_field: value must be an object' using errcode = '22023';
  end if;
  if octet_length(p_values::text) > 8192 then
    raise exception 'custom_field: too large' using errcode = '22023';
  end if;

  for k, v in select key, value from jsonb_each(p_values) loop
    select * into d from public.custom_field_definitions
     where org_id = p_org and entity = p_entity and key = k;   -- archivados siguen siendo claves conocidas
    if not found then
      raise exception 'custom_field: unknown field %', k using errcode = '22023';
    end if;
    if jsonb_typeof(v) = 'null' then continue; end if;   -- null limpia el valor

    if d.type in ('text', 'url', 'phone', 'email') then
      if jsonb_typeof(v) <> 'string' then
        raise exception 'custom_field: % must be text', k using errcode = '22023';
      end if;
      s := v #>> '{}';
      if char_length(s) > 500 then
        raise exception 'custom_field: % is too long', k using errcode = '22023';
      end if;
      if d.type = 'email' and s !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
        raise exception 'custom_field: % must be an email', k using errcode = '22023';
      elsif d.type = 'url' and s !~* '^https?://[^[:space:]]+$' then
        raise exception 'custom_field: % must be a http(s) url', k using errcode = '22023';
      elsif d.type = 'phone' and s !~ '^[+0-9 ()-]{6,20}$' then
        raise exception 'custom_field: % must be a phone number', k using errcode = '22023';
      end if;
    elsif d.type in ('number', 'currency') then
      if jsonb_typeof(v) <> 'number' then
        raise exception 'custom_field: % must be a number', k using errcode = '22023';
      end if;
    elsif d.type = 'boolean' then
      if jsonb_typeof(v) <> 'boolean' then
        raise exception 'custom_field: % must be true or false', k using errcode = '22023';
      end if;
    elsif d.type = 'date' then
      s := v #>> '{}';
      if jsonb_typeof(v) <> 'string' or s !~ '^\d{4}-\d{2}-\d{2}$' then
        raise exception 'custom_field: % must be a date (YYYY-MM-DD)', k using errcode = '22023';
      end if;
      begin
        perform s::date;
      exception when others then
        raise exception 'custom_field: % is not a valid date', k using errcode = '22023';
      end;
    elsif d.type = 'select' then
      if jsonb_typeof(v) <> 'string' or not (d.options @> jsonb_build_array(v #>> '{}')) then
        raise exception 'custom_field: % must be one of the allowed options', k using errcode = '22023';
      end if;
    elsif d.type = 'multi_select' then
      if jsonb_typeof(v) <> 'array' or jsonb_array_length(v) > 50 then
        raise exception 'custom_field: % must be a list of options', k using errcode = '22023';
      end if;
      for e in select jsonb_array_elements_text(v) loop
        if not (d.options @> jsonb_build_array(e)) then
          raise exception 'custom_field: % has an option that is not allowed', k using errcode = '22023';
        end if;
      end loop;
    end if;
  end loop;
end $$;

-- Trigger genérico para las tablas con columna custom_fields.
create or replace function app.custom_fields_trigger() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_entity text := case tg_table_name when 'customers' then 'customer' when 'leads' then 'lead' end;
begin
  if tg_op = 'INSERT' or new.custom_fields is distinct from old.custom_fields then
    perform app.validate_custom_fields(new.org_id, v_entity, new.custom_fields);
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Privilegios + RLS + auditoría
-- ---------------------------------------------------------------------------
revoke all on public.custom_field_definitions from anon, authenticated;
grant select on public.custom_field_definitions to authenticated;
grant insert (org_id, entity, key, label, type, options, position) on public.custom_field_definitions to authenticated;
grant update (label, options, position, archived_at) on public.custom_field_definitions to authenticated;
grant all on public.custom_field_definitions to service_role;

alter table public.custom_field_definitions enable row level security;
create policy custom_field_defs_select on public.custom_field_definitions
  for select to authenticated using ((select app.is_member(org_id)));
create policy custom_field_defs_insert on public.custom_field_definitions
  for insert to authenticated with check ((select app.has_permission(org_id, 'fields:manage')));
create policy custom_field_defs_update on public.custom_field_definitions
  for update to authenticated
  using ((select app.has_permission(org_id, 'fields:manage')))
  with check ((select app.has_permission(org_id, 'fields:manage')));

create trigger custom_field_defs_audit after insert or update or delete on public.custom_field_definitions
  for each row execute function app.audit_row_change();

revoke all on function app.custom_field_defs_guard(), app.validate_custom_fields(uuid, text, jsonb),
  app.custom_fields_trigger() from public, anon, authenticated;

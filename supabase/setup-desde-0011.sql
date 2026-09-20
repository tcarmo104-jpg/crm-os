-- =============================================================================
-- CRM OS · ACTUALIZACIÓN: migraciones 0011 en adelante (para un proyecto que YA tiene 0001 a 0010)
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
  if to_regclass('public.tasks') is null and 11 > 10 then
    raise exception 'FALTAN las migraciones de la Fase 3 (0009 y 0010). Avísame para darte el archivo correcto.';
  end if;
  if to_regclass('public.products') is not null then
    raise exception 'Este proyecto YA tiene instalada la migración 0011 (existe la tabla products). No ejecutes este archivo: avísame.';
  end if;
end $$;

-- ---------------- 20260919000011_products_quotes.sql ----------------
-- =============================================================================
-- 0011 CATÁLOGO DE PRODUCTOS Y COTIZACIONES
-- =============================================================================
-- Reglas que viven en la base de datos (no en la interfaz):
--   * El DINERO se calcula en la BD (numeric, redondeo por línea) y nadie escribe totales.
--   * Una cotización enviada es INMUTABLE: cambiarla = nueva versión (la anterior queda «reemplazada»).
--   * Cada línea guarda una FOTO del producto (nombre, precio, IVA): cambiar el catálogo después
--     no altera cotizaciones ya hechas.
--   * Descuentos por encima del límite de la organización exigen manager/admin para enviarse.
--   * Numeración correlativa por organización (COT-0001…), sin repetidos aunque haya concurrencia.
--   * Solo puede haber UNA cotización aceptada por oportunidad.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Contadores (numeración correlativa)
-- ---------------------------------------------------------------------------
create table app.org_counters (
  org_id uuid not null references public.organizations(id) on delete cascade,
  key    text not null,
  value  int  not null default 0,
  primary key (org_id, key)
);
revoke all on app.org_counters from public, anon, authenticated;

-- Atómico: el UPSERT bloquea la fila del contador, así dos transacciones nunca reciben el mismo número.
-- Si la transacción se revierte, el contador también: no quedan huecos.
create or replace function app.next_number(p_org uuid, p_key text) returns int
language sql security definer set search_path = '' as $$
  insert into app.org_counters (org_id, key, value) values (p_org, p_key, 1)
  on conflict (org_id, key) do update set value = app.org_counters.value + 1
  returning value
$$;

-- Límite de descuento sin aprobación (por organización; 10 % por defecto).
create or replace function app.quote_discount_limit(p_org uuid) returns numeric
language sql stable security definer set search_path = '' as $$
  select coalesce((select nullif(o.settings ->> 'quote_discount_limit_pct', '')::numeric
                     from public.organizations o where o.id = p_org), 10)
$$;

-- ---------------------------------------------------------------------------
-- Ampliar el log de transiciones a cotizaciones, ventas y casos
-- ---------------------------------------------------------------------------
alter table public.state_transitions drop constraint state_transitions_entity_type_check;
alter table public.state_transitions
  add constraint state_transitions_entity_type_check check (entity_type in ('lead', 'opportunity', 'quote', 'sale', 'case'));

-- ---------------------------------------------------------------------------
-- products (catálogo: productos y servicios)
-- ---------------------------------------------------------------------------
create table public.products (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  kind        text not null default 'product' check (kind in ('product', 'service')),
  sku         text check (char_length(sku) between 1 and 60),
  name        text not null check (char_length(btrim(name)) between 1 and 160),
  description text check (char_length(description) <= 1000),
  unit        text not null default 'unidad' check (char_length(btrim(unit)) between 1 and 30),
  unit_price  numeric(14, 2) not null default 0 check (unit_price >= 0 and unit_price <= 1000000000),
  tax_rate    numeric(5, 2)  not null default 0 check (tax_rate between 0 and 100),
  active      boolean not null default true,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (id, org_id)
);
create unique index products_sku_uk on public.products (org_id, lower(sku)) where sku is not null;
create index products_org_idx on public.products (org_id, active, kind, name);

create or replace function app.products_prepare() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.name := btrim(new.name);
  new.sku  := nullif(btrim(coalesce(new.sku, '')), '');
  if tg_op = 'UPDATE' and (new.kind <> old.kind or new.org_id <> old.org_id) then
    raise exception 'product kind is immutable' using errcode = '23514';
  end if;
  if tg_op = 'INSERT' then new.created_by := coalesce(new.created_by, auth.uid()); end if;
  return new;
end $$;
create trigger products_prepare_trg before insert or update on public.products
  for each row execute function app.products_prepare();
create trigger products_touch before update on public.products
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- quotes
-- ---------------------------------------------------------------------------
create table public.quotes (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organizations(id) on delete cascade,
  number          text not null,
  version         int  not null default 1 check (version >= 1),
  opportunity_id  uuid not null,
  customer_id     uuid not null,
  status          text not null default 'draft' check (status in ('draft', 'sent', 'accepted', 'rejected', 'superseded')),
  currency        text check (currency ~ '^[A-Z]{3}$'),
  valid_until     date,
  notes           text check (char_length(notes) <= 2000),
  subtotal        numeric(14, 2) not null default 0,     -- suma de líneas brutas (cantidad × precio)
  discount_total  numeric(14, 2) not null default 0,
  tax_total       numeric(14, 2) not null default 0,
  total           numeric(14, 2) not null default 0,
  max_discount_pct numeric(5, 2) not null default 0,
  owner_id        uuid references auth.users(id) on delete set null,
  team_id         uuid,
  parent_quote_id uuid references public.quotes(id),
  sent_at         timestamptz,
  decided_at      timestamptz,
  decided_by      uuid references auth.users(id) on delete set null,
  created_by      uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (id, org_id),
  unique (org_id, number, version),
  foreign key (opportunity_id, org_id) references public.opportunities (id, org_id),
  foreign key (customer_id, org_id)    references public.customers (id, org_id),
  foreign key (team_id, org_id)        references public.teams (id, org_id) on delete set null (team_id),
  -- aceptada/rechazada siempre tienen fecha de decisión (una rechazada puede pasar luego a «reemplazada»)
  check (status not in ('accepted', 'rejected') or decided_at is not null)
);
-- Una sola cotización aceptada por oportunidad.
create unique index quotes_one_accepted_uk on public.quotes (opportunity_id) where status = 'accepted';
create index quotes_customer_idx    on public.quotes (customer_id);
create index quotes_opportunity_idx on public.quotes (opportunity_id, version desc);
create index quotes_org_created_idx on public.quotes (org_id, created_at desc, id desc);

-- ---------------------------------------------------------------------------
-- quote_items (foto del producto en el momento de cotizar)
-- ---------------------------------------------------------------------------
create table public.quote_items (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id) on delete cascade,
  quote_id      uuid not null,
  position      int  not null default 1,
  product_id    uuid,
  description   text not null check (char_length(btrim(description)) between 1 and 300),
  unit          text not null default 'unidad' check (char_length(btrim(unit)) between 1 and 30),
  quantity      numeric(12, 3) not null check (quantity > 0 and quantity <= 1000000),
  unit_price    numeric(14, 2) not null check (unit_price >= 0 and unit_price <= 1000000000),
  discount_pct  numeric(5, 2)  not null default 0 check (discount_pct between 0 and 100),
  tax_rate      numeric(5, 2)  not null default 0 check (tax_rate between 0 and 100),
  line_gross    numeric(14, 2) not null default 0,
  line_discount numeric(14, 2) not null default 0,
  line_tax      numeric(14, 2) not null default 0,
  line_total    numeric(14, 2) not null default 0,
  created_at    timestamptz not null default now(),
  foreign key (quote_id, org_id)   references public.quotes (id, org_id) on delete cascade,
  foreign key (product_id, org_id) references public.products (id, org_id)
);
create index quote_items_quote_idx on public.quote_items (quote_id, position);

-- Cálculo de la línea (SIEMPRE en la BD; redondeo a 2 decimales por línea).
create or replace function app.quote_items_prepare() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_status text;
begin
  select q.status into v_status from public.quotes q where q.id = new.quote_id and q.org_id = new.org_id for share;
  if v_status is null then raise exception 'quote not found' using errcode = '22023'; end if;
  if v_status <> 'draft' then raise exception 'quote_locked' using errcode = '23514'; end if;

  new.description := btrim(new.description);
  new.line_gross    := round(new.quantity * new.unit_price, 2);
  new.line_discount := round(new.line_gross * new.discount_pct / 100, 2);
  new.line_tax      := round((new.line_gross - new.line_discount) * new.tax_rate / 100, 2);
  new.line_total    := new.line_gross - new.line_discount + new.line_tax;
  return new;
end $$;
create trigger quote_items_prepare_trg before insert or update on public.quote_items
  for each row execute function app.quote_items_prepare();

-- Bloquea borrar líneas de una cotización que ya no es borrador.
create or replace function app.quote_items_guard_delete() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_status text;
begin
  -- Se permite la cascada al eliminar la organización completa.
  if not exists (select 1 from public.organizations where id = old.org_id) then return old; end if;
  select q.status into v_status from public.quotes q where q.id = old.quote_id;
  if v_status is not null and v_status <> 'draft' then raise exception 'quote_locked' using errcode = '23514'; end if;
  return old;
end $$;
create trigger quote_items_guard_delete_trg before delete on public.quote_items
  for each row execute function app.quote_items_guard_delete();

-- Totales de la cotización: se recalculan desde las líneas.
create or replace function app.recalc_quote(p_quote uuid) returns void
language sql security definer set search_path = '' as $$
  update public.quotes q set
    subtotal = s.g, discount_total = s.d, tax_total = s.t, total = s.tot, max_discount_pct = s.m
  from (select coalesce(sum(line_gross), 0) g, coalesce(sum(line_discount), 0) d, coalesce(sum(line_tax), 0) t,
               coalesce(sum(line_total), 0) tot, coalesce(max(discount_pct), 0) m
          from public.quote_items where quote_id = p_quote) s
  where q.id = p_quote
$$;

create or replace function app.quote_items_after() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform app.recalc_quote(case when tg_op = 'DELETE' then old.quote_id else new.quote_id end);
  return null;
end $$;
create trigger quote_items_after_trg after insert or update or delete on public.quote_items
  for each row execute function app.quote_items_after();

-- ---------------------------------------------------------------------------
-- Guardas de la cotización
-- ---------------------------------------------------------------------------
create or replace function app.quotes_prepare() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    if new.org_id <> old.org_id or new.opportunity_id <> old.opportunity_id or new.number <> old.number
       or new.version <> old.version
       or (new.customer_id <> old.customer_id and current_setting('app.customer_merge', true) is distinct from 'on') then
      raise exception 'quote identity is immutable' using errcode = '23514';
    end if;
    -- Una cotización ya enviada no se edita (se revisa: nueva versión).
    if old.status <> 'draft' and current_setting('app.quote_transition', true) is distinct from 'on'
       and (new.valid_until is distinct from old.valid_until or new.notes is distinct from old.notes) then
      raise exception 'quote_locked' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
create trigger quotes_prepare_trg before insert or update on public.quotes
  for each row execute function app.quotes_prepare();
create trigger quotes_touch before update on public.quotes
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Registro genérico de cambios de estado (cotizaciones, ventas, casos)
-- ---------------------------------------------------------------------------
create or replace function app.log_status_change() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_type   text := case tg_table_name when 'quotes' then 'quote' when 'sales' then 'sale' when 'cases' then 'case' end;
  v_reason text := nullif(btrim(coalesce(current_setting('app.transition_reason', true), '')), '');
  v_src    text := coalesce(nullif(current_setting('app.transition_source', true), ''),
                            case when auth.uid() is null then 'system' else 'user' end);
begin
  if tg_op = 'INSERT' or new.status is distinct from old.status then
    insert into public.state_transitions (org_id, entity_type, entity_id, from_state, to_state, actor_id, source, reason)
    values (new.org_id, v_type, new.id, case when tg_op = 'UPDATE' then old.status end, new.status, auth.uid(), v_src, v_reason);
  end if;
  return null;
end $$;
create trigger quotes_log_status_trg after insert or update of status on public.quotes
  for each row execute function app.log_status_change();

-- El historial se ve con el mismo alcance que el registro al que pertenece.
drop policy state_transitions_select on public.state_transitions;
create policy state_transitions_select on public.state_transitions for select to authenticated
  using ((entity_type = 'opportunity' and exists (select 1 from public.opportunities o where o.id = entity_id))
      or (entity_type = 'lead'        and exists (select 1 from public.leads l where l.id = entity_id))
      or (entity_type = 'quote'       and exists (select 1 from public.quotes q where q.id = entity_id)));

-- ---------------------------------------------------------------------------
-- Las cotizaciones abiertas siguen al cliente (además de leads, oportunidades y tareas)
-- ---------------------------------------------------------------------------
create or replace function app.customers_after_update() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.owner_id is distinct from old.owner_id then
    update public.leads
       set owner_id = new.owner_id, team_id = new.team_id
     where customer_id = new.id and org_id = new.org_id and status in ('new', 'contacted', 'qualified');
    update public.opportunities
       set owner_id = new.owner_id, team_id = new.team_id
     where customer_id = new.id and org_id = new.org_id and status = 'open';
    update public.quotes
       set owner_id = new.owner_id, team_id = new.team_id
     where customer_id = new.id and org_id = new.org_id and status in ('draft', 'sent');
    perform set_config('app.system_reassign', 'on', true);
    update public.tasks
       set assignee_id = new.owner_id
     where customer_id = new.id and org_id = new.org_id and status = 'open'
       and assignee_id is not distinct from old.owner_id;
    perform set_config('app.system_reassign', 'off', true);
    perform app.emit_event(new.org_id, 'customer.assigned', 'customer', new.id,
                           jsonb_build_object('owner_id', new.owner_id), new.id);
  end if;
  if new.do_not_contact is distinct from old.do_not_contact then
    perform app.emit_event(new.org_id,
      case when new.do_not_contact then 'customer.dnc_set' else 'customer.dnc_cleared' end,
      'customer', new.id, jsonb_build_object('reason', new.dnc_reason), new.id);
  end if;
  return null;
end $$;

insert into app.customer_merge_targets values ('quotes');

-- ---------------------------------------------------------------------------
-- RPC de cotizaciones
-- ---------------------------------------------------------------------------
create or replace function public.create_quote(p_opportunity uuid, p_valid_until date default null, p_notes text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  o public.opportunities%rowtype;
  v_id uuid;
  v_n int;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into o from public.opportunities where id = p_opportunity;
  if not found or not app.can_access_row(o.org_id, 'opportunities:read', o.owner_id, o.team_id)
     or not app.has_permission(o.org_id, 'quotes:create') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if o.status <> 'open' then raise exception 'opportunity_closed' using errcode = '23514'; end if;
  if p_valid_until is not null and (p_valid_until < current_date or p_valid_until > current_date + 730) then
    raise exception 'date out of range' using errcode = '22023';
  end if;

  v_n := app.next_number(o.org_id, 'quote');
  insert into public.quotes (org_id, number, opportunity_id, customer_id, currency, valid_until, notes, owner_id, team_id, created_by)
  values (o.org_id, 'COT-' || lpad(v_n::text, 4, '0'), o.id, o.customer_id, o.currency,
          coalesce(p_valid_until, current_date + 15), nullif(btrim(coalesce(p_notes, '')), ''), o.owner_id, o.team_id, auth.uid())
  returning id into v_id;

  perform app.emit_event(o.org_id, 'quote.created', 'quote', v_id,
    jsonb_build_object('number', 'COT-' || lpad(v_n::text, 4, '0'), 'opportunity_id', o.id), o.customer_id);
  return v_id;
end $$;

-- Acceso de edición a una cotización (borrador + permiso + alcance).
create or replace function app.quote_for_edit(p_id uuid) returns public.quotes
language plpgsql security definer set search_path = '' as $$
declare q public.quotes%rowtype;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into q from public.quotes where id = p_id for update;
  if not found or not app.can_access_row(q.org_id, 'quotes:update', q.owner_id, q.team_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return q;
end $$;

create or replace function public.add_quote_item(
  p_quote uuid, p_product uuid default null, p_description text default null, p_quantity numeric default 1,
  p_unit_price numeric default null, p_discount_pct numeric default 0, p_tax_rate numeric default null
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  q public.quotes%rowtype;
  p public.products%rowtype;
  v_id uuid;
begin
  q := app.quote_for_edit(p_quote);
  if q.status <> 'draft' then raise exception 'quote_locked' using errcode = '23514'; end if;
  if (select count(*) from public.quote_items where quote_id = q.id) >= 100 then
    raise exception 'item limit reached' using errcode = '53400';
  end if;

  if p_product is not null then
    select * into p from public.products where id = p_product and org_id = q.org_id and active;
    if not found then raise exception 'product not found' using errcode = '22023'; end if;
  end if;
  if p_product is null and (btrim(coalesce(p_description, '')) = '' or p_unit_price is null) then
    raise exception 'name_required' using errcode = '22023';
  end if;

  insert into public.quote_items (org_id, quote_id, position, product_id, description, unit, quantity, unit_price, discount_pct, tax_rate)
  values (q.org_id, q.id,
          coalesce((select max(position) from public.quote_items where quote_id = q.id), 0) + 1,
          p_product,
          coalesce(nullif(btrim(coalesce(p_description, '')), ''), p.name),
          coalesce(p.unit, 'unidad'),
          coalesce(p_quantity, 1),
          coalesce(p_unit_price, p.unit_price),
          coalesce(p_discount_pct, 0),
          coalesce(p_tax_rate, p.tax_rate, 0))
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.update_quote_item(
  p_item uuid, p_quantity numeric, p_unit_price numeric, p_discount_pct numeric, p_description text default null
) returns void language plpgsql security definer set search_path = '' as $$
declare v_quote uuid; q public.quotes%rowtype;
begin
  select quote_id into v_quote from public.quote_items where id = p_item;
  if v_quote is null then raise exception 'not allowed' using errcode = '42501'; end if;
  q := app.quote_for_edit(v_quote);
  update public.quote_items set
    quantity = p_quantity, unit_price = p_unit_price, discount_pct = p_discount_pct,
    description = coalesce(nullif(btrim(coalesce(p_description, '')), ''), description)
  where id = p_item;
end $$;

create or replace function public.remove_quote_item(p_item uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_quote uuid; q public.quotes%rowtype;
begin
  select quote_id into v_quote from public.quote_items where id = p_item;
  if v_quote is null then raise exception 'not allowed' using errcode = '42501'; end if;
  q := app.quote_for_edit(v_quote);
  delete from public.quote_items where id = p_item;
end $$;

-- Transiciones de estado de la cotización.
create or replace function app.quote_transition(p_id uuid, p_to text, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare q public.quotes%rowtype;
begin
  q := app.quote_for_edit(p_id);

  if p_to = 'sent' then
    if q.status <> 'draft' then raise exception 'quote_not_sendable' using errcode = '23514'; end if;
    if not exists (select 1 from public.quote_items where quote_id = q.id) then
      raise exception 'quote_empty' using errcode = '23514';
    end if;
    if q.valid_until is null or q.valid_until < current_date then
      raise exception 'quote_expired' using errcode = '23514';
    end if;
    -- Descuentos altos: solo un manager/admin puede enviar (aprobación humana).
    if q.max_discount_pct > app.quote_discount_limit(q.org_id)
       and app.permission_scope(q.org_id, 'quotes:update') is distinct from 'org' then
      raise exception 'discount_requires_approval' using errcode = '42501';
    end if;
  elsif p_to = 'accepted' then
    if q.status <> 'sent' then raise exception 'quote_not_sent' using errcode = '23514'; end if;
    if q.valid_until < current_date then raise exception 'quote_expired' using errcode = '23514'; end if;
  elsif p_to = 'rejected' then
    if q.status <> 'sent' then raise exception 'quote_not_sent' using errcode = '23514'; end if;
  else
    raise exception 'invalid quote status' using errcode = '22023';
  end if;

  perform set_config('app.quote_transition', 'on', true);
  perform set_config('app.transition_reason', coalesce(p_reason, ''), true);
  update public.quotes set
    status     = p_to,
    sent_at    = case when p_to = 'sent' then now() else sent_at end,
    decided_at = case when p_to in ('accepted', 'rejected') then now() end,
    decided_by = case when p_to in ('accepted', 'rejected') then auth.uid() end
   where id = q.id;
  perform set_config('app.transition_reason', '', true);
  perform set_config('app.quote_transition', 'off', true);

  perform app.emit_event(q.org_id, 'quote.' || p_to, 'quote', q.id,
    jsonb_build_object('number', q.number, 'version', q.version, 'total', q.total, 'currency', q.currency,
                       'reason', left(nullif(btrim(coalesce(p_reason, '')), ''), 200)), q.customer_id);
end $$;

create or replace function public.send_quote(p_id uuid) returns void
language sql security definer set search_path = '' as $$ select app.quote_transition(p_id, 'sent', null) $$;
create or replace function public.accept_quote(p_id uuid) returns void
language sql security definer set search_path = '' as $$ select app.quote_transition(p_id, 'accepted', null) $$;
create or replace function public.reject_quote(p_id uuid, p_reason text default null) returns void
language sql security definer set search_path = '' as $$ select app.quote_transition(p_id, 'rejected', p_reason) $$;

-- Nueva versión: copia las líneas a un borrador v+1 y marca la anterior como «reemplazada».
create or replace function public.revise_quote(p_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare q public.quotes%rowtype; v_new uuid;
begin
  q := app.quote_for_edit(p_id);
  if q.status not in ('sent', 'rejected') then raise exception 'quote_not_revisable' using errcode = '23514'; end if;
  if not app.has_permission(q.org_id, 'quotes:create') then raise exception 'not allowed' using errcode = '42501'; end if;
  if exists (select 1 from public.opportunities o where o.id = q.opportunity_id and o.status <> 'open') then
    raise exception 'opportunity_closed' using errcode = '23514';
  end if;

  perform set_config('app.quote_transition', 'on', true);
  perform set_config('app.transition_reason', 'Nueva versión', true);
  update public.quotes set status = 'superseded' where id = q.id;
  perform set_config('app.transition_reason', '', true);
  perform set_config('app.quote_transition', 'off', true);

  insert into public.quotes (org_id, number, version, opportunity_id, customer_id, currency, valid_until, notes,
                             owner_id, team_id, parent_quote_id, created_by)
  values (q.org_id, q.number, q.version + 1, q.opportunity_id, q.customer_id, q.currency,
          greatest(coalesce(q.valid_until, current_date), current_date + 15), q.notes, q.owner_id, q.team_id, q.id, auth.uid())
  returning id into v_new;

  insert into public.quote_items (org_id, quote_id, position, product_id, description, unit, quantity, unit_price, discount_pct, tax_rate)
  select org_id, v_new, position, product_id, description, unit, quantity, unit_price, discount_pct, tax_rate
    from public.quote_items where quote_id = q.id order by position;

  perform app.emit_event(q.org_id, 'quote.created', 'quote', v_new,
    jsonb_build_object('number', q.number, 'version', q.version + 1, 'opportunity_id', q.opportunity_id), q.customer_id);
  return v_new;
end $$;

-- ---------------------------------------------------------------------------
-- Privilegios + RLS + auditoría
-- ---------------------------------------------------------------------------
revoke all on public.products, public.quotes, public.quote_items from anon, authenticated;
grant select on public.products, public.quotes, public.quote_items to authenticated;
grant insert (org_id, kind, sku, name, description, unit, unit_price, tax_rate, active) on public.products to authenticated;
grant update (sku, name, description, unit, unit_price, tax_rate, active) on public.products to authenticated;
grant update (valid_until, notes) on public.quotes to authenticated;
grant all on public.products, public.quotes, public.quote_items to service_role;

alter table public.products    enable row level security;
alter table public.quotes      enable row level security;
alter table public.quote_items enable row level security;

create policy products_select on public.products for select to authenticated
  using ((select app.has_permission(org_id, 'products:read')));
create policy products_insert on public.products for insert to authenticated
  with check ((select app.has_permission(org_id, 'products:create')));
create policy products_update on public.products for update to authenticated
  using ((select app.has_permission(org_id, 'products:update')))
  with check ((select app.has_permission(org_id, 'products:update')));

create policy quotes_select on public.quotes for select to authenticated
  using ((select app.can_access_row(org_id, 'quotes:read', owner_id, team_id)));
create policy quotes_update on public.quotes for update to authenticated
  using ((select app.can_access_row(org_id, 'quotes:update', owner_id, team_id)))
  with check ((select app.can_access_row(org_id, 'quotes:update', owner_id, team_id)));

-- Las líneas se ven con el mismo alcance que su cotización (RLS de quotes aplica en el subquery).
create policy quote_items_select on public.quote_items for select to authenticated
  using (exists (select 1 from public.quotes q where q.id = quote_id));

create trigger products_audit    after insert or update or delete on public.products    for each row execute function app.audit_row_change();
create trigger quotes_audit      after insert or update or delete on public.quotes      for each row execute function app.audit_row_change();
create trigger quote_items_audit after insert or update or delete on public.quote_items for each row execute function app.audit_row_change();

revoke all on function app.next_number(uuid, text), app.quote_discount_limit(uuid), app.products_prepare(),
  app.quote_items_prepare(), app.quote_items_guard_delete(), app.recalc_quote(uuid), app.quote_items_after(),
  app.quotes_prepare(), app.log_status_change(), app.customers_after_update(), app.quote_for_edit(uuid),
  app.quote_transition(uuid, text, text) from public, anon, authenticated;

revoke all on function public.create_quote(uuid, date, text),
  public.add_quote_item(uuid, uuid, text, numeric, numeric, numeric, numeric),
  public.update_quote_item(uuid, numeric, numeric, numeric, text), public.remove_quote_item(uuid),
  public.send_quote(uuid), public.accept_quote(uuid), public.reject_quote(uuid, text), public.revise_quote(uuid)
  from public, anon;
grant execute on function public.create_quote(uuid, date, text),
  public.add_quote_item(uuid, uuid, text, numeric, numeric, numeric, numeric),
  public.update_quote_item(uuid, numeric, numeric, numeric, text), public.remove_quote_item(uuid),
  public.send_quote(uuid), public.accept_quote(uuid), public.reject_quote(uuid, text), public.revise_quote(uuid)
  to authenticated, service_role;


-- ---------------- 20260919000012_sales_postsale.sql ----------------
-- =============================================================================
-- 0012 VENTAS Y POSTVENTA
-- =============================================================================
--   * Una venta nace SOLO de una cotización ACEPTADA y guarda una FOTO inmutable de ella
--     (líneas, precios, IVA, totales): nada posterior (catálogo, nuevas versiones) la altera.
--   * Registrar la venta cierra la oportunidad como ganada y abre el seguimiento postventa
--     (confirmar entrega, satisfacción, recompra) como tareas del responsable.
--   * Una cotización no puede tener dos ventas activas (ni con llamadas simultáneas).
--   * Anular una venta es cosa de manager/admin y exige motivo.
--   * Casos de soporte/reclamo/garantía con estados y su historial.
--   * Todo pasa por RPC: ningún estado ni monto es escribible directamente.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- sales + sale_items
-- ---------------------------------------------------------------------------
create table public.sales (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organizations(id) on delete cascade,
  number         text not null,
  customer_id    uuid not null,
  opportunity_id uuid not null,
  quote_id       uuid not null,
  status         text not null default 'confirmed' check (status in ('confirmed', 'delivered', 'cancelled')),
  currency       text check (currency ~ '^[A-Z]{3}$'),
  subtotal       numeric(14, 2) not null,
  discount_total numeric(14, 2) not null,
  tax_total      numeric(14, 2) not null,
  total          numeric(14, 2) not null,
  sold_at        timestamptz not null default now(),
  delivered_at   timestamptz,
  cancelled_at   timestamptz,
  cancel_reason  text check (char_length(cancel_reason) <= 500),
  owner_id       uuid references auth.users(id) on delete set null,
  team_id        uuid,
  sold_by        uuid references auth.users(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (id, org_id),
  unique (org_id, number),
  foreign key (customer_id, org_id)    references public.customers (id, org_id),
  foreign key (opportunity_id, org_id) references public.opportunities (id, org_id),
  foreign key (quote_id, org_id)       references public.quotes (id, org_id),
  foreign key (team_id, org_id)        references public.teams (id, org_id) on delete set null (team_id),
  check ((status = 'cancelled') = (cancelled_at is not null)),
  check ((status = 'delivered') = (delivered_at is not null) or status = 'cancelled')
);
-- Una sola venta ACTIVA por cotización.
create unique index sales_one_active_per_quote_uk on public.sales (quote_id) where status <> 'cancelled';
create index sales_customer_idx    on public.sales (customer_id);
create index sales_opportunity_idx on public.sales (opportunity_id);
create index sales_org_sold_idx    on public.sales (org_id, sold_at desc, id desc);

create table public.sale_items (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id) on delete cascade,
  sale_id       uuid not null,
  position      int  not null,
  product_id    uuid,
  description   text not null,
  unit          text not null,
  quantity      numeric(12, 3) not null,
  unit_price    numeric(14, 2) not null,
  discount_pct  numeric(5, 2)  not null,
  tax_rate      numeric(5, 2)  not null,
  line_gross    numeric(14, 2) not null,
  line_discount numeric(14, 2) not null,
  line_tax      numeric(14, 2) not null,
  line_total    numeric(14, 2) not null,
  created_at    timestamptz not null default now(),
  foreign key (sale_id, org_id)    references public.sales (id, org_id) on delete cascade,
  foreign key (product_id, org_id) references public.products (id, org_id)
);
create index sale_items_sale_idx on public.sale_items (sale_id, position);

-- La foto de la venta es inmutable (solo se admite la cascada al eliminar la organización).
create or replace function app.sale_items_immutable() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'TRUNCATE' then raise exception 'sale items are immutable' using errcode = '42501'; end if;
  if tg_op = 'DELETE' and not exists (select 1 from public.organizations where id = old.org_id) then return old; end if;
  raise exception 'sale items are immutable' using errcode = '42501';
end $$;
create trigger sale_items_no_mutation before update or delete on public.sale_items
  for each row execute function app.sale_items_immutable();
create trigger sale_items_no_truncate before truncate on public.sale_items
  for each statement execute function app.sale_items_immutable();

create or replace function app.sales_prepare() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.org_id <> old.org_id or new.number <> old.number or new.opportunity_id <> old.opportunity_id
     or new.quote_id <> old.quote_id or new.currency is distinct from old.currency
     or new.subtotal <> old.subtotal or new.discount_total <> old.discount_total
     or new.tax_total <> old.tax_total or new.total <> old.total or new.sold_at <> old.sold_at
     or (new.customer_id <> old.customer_id and current_setting('app.customer_merge', true) is distinct from 'on') then
    raise exception 'a sale is immutable' using errcode = '23514';
  end if;
  if new.status <> old.status and current_setting('app.sale_transition', true) is distinct from 'on' then
    raise exception 'sale status changes only through its functions' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger sales_prepare_trg before update on public.sales
  for each row execute function app.sales_prepare();
create trigger sales_touch before update on public.sales
  for each row execute function app.touch_updated_at();
create trigger sales_log_status_trg after insert or update of status on public.sales
  for each row execute function app.log_status_change();

-- ---------------------------------------------------------------------------
-- Casos de postventa (soporte, reclamos, garantías, devoluciones)
-- ---------------------------------------------------------------------------
create table public.cases (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  number      text not null,
  customer_id uuid not null,
  sale_id     uuid,
  kind        text not null default 'support' check (kind in ('support', 'complaint', 'warranty', 'return', 'question')),
  priority    text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  status      text not null default 'open' check (status in ('open', 'in_progress', 'resolved', 'closed')),
  title       text not null check (char_length(btrim(title)) between 1 and 160),
  description text check (char_length(description) <= 2000),
  resolution  text check (char_length(resolution) <= 2000),
  assignee_id uuid references auth.users(id) on delete set null,
  team_id     uuid,
  created_by  uuid references auth.users(id) on delete set null,
  resolved_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (id, org_id),
  unique (org_id, number),
  foreign key (customer_id, org_id) references public.customers (id, org_id),
  foreign key (sale_id, org_id)     references public.sales (id, org_id),
  foreign key (team_id, org_id)     references public.teams (id, org_id) on delete set null (team_id),
  check ((status in ('resolved', 'closed')) = (resolution is not null))
);
create index cases_customer_idx on public.cases (customer_id);
create index cases_assignee_idx on public.cases (org_id, assignee_id, status);

create or replace function app.cases_prepare() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); v_team uuid; v_scope public.permission_scope;
begin
  new.title := btrim(new.title);
  if tg_op = 'UPDATE' and (new.org_id <> old.org_id or new.number <> old.number or new.sale_id is distinct from old.sale_id
      or (new.customer_id <> old.customer_id and current_setting('app.customer_merge', true) is distinct from 'on')) then
    raise exception 'case links are immutable' using errcode = '23514';
  end if;
  if tg_op = 'INSERT' or new.assignee_id is distinct from old.assignee_id then
    if new.assignee_id is null then
      new.team_id := null;
    else
      select m.team_id into v_team from public.memberships m
       where m.org_id = new.org_id and m.user_id = new.assignee_id and m.status = 'active';
      if not found then raise exception 'assignee must be an active member of the organization' using errcode = '23514'; end if;
      new.team_id := v_team;
    end if;
    if tg_op = 'UPDATE' and v_uid is not null then
      v_scope := app.permission_scope(new.org_id, 'cases:update');
      if v_scope is distinct from 'org'
         and not (v_scope = 'team' and new.team_id is not null and new.team_id = app.my_team_id(new.org_id)) then
        raise exception 'only managers can reassign cases' using errcode = '42501';
      end if;
    end if;
  end if;
  if tg_op = 'UPDATE' and new.status <> old.status and current_setting('app.case_transition', true) is distinct from 'on' then
    raise exception 'case status changes only through its functions' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger cases_prepare_trg before insert or update on public.cases
  for each row execute function app.cases_prepare();
create trigger cases_touch before update on public.cases
  for each row execute function app.touch_updated_at();
create trigger cases_log_status_trg after insert or update of status on public.cases
  for each row execute function app.log_status_change();

insert into app.customer_merge_targets values ('sales'), ('cases');

-- El historial de ventas y casos se ve con el alcance del registro.
drop policy state_transitions_select on public.state_transitions;
create policy state_transitions_select on public.state_transitions for select to authenticated
  using ((entity_type = 'opportunity' and exists (select 1 from public.opportunities o where o.id = entity_id))
      or (entity_type = 'lead'        and exists (select 1 from public.leads l where l.id = entity_id))
      or (entity_type = 'quote'       and exists (select 1 from public.quotes q where q.id = entity_id))
      or (entity_type = 'sale'        and exists (select 1 from public.sales s where s.id = entity_id))
      or (entity_type = 'case'        and exists (select 1 from public.cases c where c.id = entity_id)));

-- ---------------------------------------------------------------------------
-- create_sale: de una cotización ACEPTADA (atómico: venta + foto + oportunidad ganada + postventa)
-- ---------------------------------------------------------------------------
create or replace function public.create_sale(p_quote uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  q public.quotes%rowtype;
  o public.opportunities%rowtype;
  c public.customers%rowtype;
  v_won uuid;
  v_id uuid;
  v_number text;
  v_note text;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;

  select * into q from public.quotes where id = p_quote for update;
  if not found or not app.can_access_row(q.org_id, 'sales:create', q.owner_id, q.team_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if q.status <> 'accepted' then raise exception 'quote_not_accepted' using errcode = '23514'; end if;
  if exists (select 1 from public.sales s where s.quote_id = q.id and s.status <> 'cancelled') then
    raise exception 'sale_already_exists' using errcode = '23505';
  end if;

  select * into o from public.opportunities where id = q.opportunity_id for update;
  if o.status = 'lost' then raise exception 'opportunity_closed' using errcode = '23514'; end if;
  select * into c from public.customers where id = q.customer_id;

  v_number := 'VTA-' || lpad(app.next_number(q.org_id, 'sale')::text, 4, '0');
  insert into public.sales (org_id, number, customer_id, opportunity_id, quote_id, currency,
                            subtotal, discount_total, tax_total, total, owner_id, team_id, sold_by)
  values (q.org_id, v_number, q.customer_id, q.opportunity_id, q.id, q.currency,
          q.subtotal, q.discount_total, q.tax_total, q.total, q.owner_id, q.team_id, auth.uid())
  returning id into v_id;

  insert into public.sale_items (org_id, sale_id, position, product_id, description, unit, quantity, unit_price,
                                 discount_pct, tax_rate, line_gross, line_discount, line_tax, line_total)
  select org_id, v_id, position, product_id, description, unit, quantity, unit_price,
         discount_pct, tax_rate, line_gross, line_discount, line_tax, line_total
    from public.quote_items where quote_id = q.id order by position;

  -- La oportunidad se cierra como ganada por el valor neto (sin impuestos) de lo vendido.
  if o.status = 'open' then
    select s.id into v_won from public.pipeline_stages s
     where s.pipeline_id = o.pipeline_id and s.kind = 'won' and s.archived_at is null order by s.position limit 1;
    if v_won is null then raise exception 'pipeline has no won stage' using errcode = '22023'; end if;
    perform set_config('app.transition_reason', 'Venta ' || v_number, true);
    perform set_config('app.transition_source', 'system', true);
    update public.opportunities set stage_id = v_won, amount = q.subtotal - q.discount_total where id = o.id;
    perform set_config('app.transition_reason', '', true);
    perform set_config('app.transition_source', '', true);
  end if;

  -- Seguimiento postventa: tareas del responsable (o sin asignar si el cliente no tiene dueño).
  v_note := 'Seguimiento postventa de ' || v_number
            || case when c.do_not_contact then E'\nATENCIÓN: el cliente pidió no ser contactado.' else '' end;
  insert into public.tasks (org_id, title, description, type, due_at, assignee_id, opportunity_id, created_by) values
    (q.org_id, 'Confirmar la entrega con ' || c.full_name,           v_note, 'call',      now() + interval '3 days',  q.owner_id, o.id, auth.uid()),
    (q.org_id, 'Encuesta de satisfacción a ' || c.full_name,         v_note, 'follow_up', now() + interval '10 days', q.owner_id, o.id, auth.uid()),
    (q.org_id, 'Ofrecer recompra o renovación a ' || c.full_name,    v_note, 'follow_up', now() + interval '60 days', q.owner_id, o.id, auth.uid());

  perform app.emit_event(q.org_id, 'sale.created', 'sale', v_id,
    jsonb_build_object('number', v_number, 'total', q.total, 'currency', q.currency, 'quote_number', q.number), q.customer_id);
  return v_id;
end $$;

create or replace function app.sale_transition(p_id uuid, p_to text, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare s public.sales%rowtype;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into s from public.sales where id = p_id for update;
  if not found or not app.can_access_row(s.org_id, 'sales:update', s.owner_id, s.team_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  if p_to = 'delivered' then
    if s.status <> 'confirmed' then raise exception 'sale_not_confirmed' using errcode = '23514'; end if;
  elsif p_to = 'cancelled' then
    if s.status = 'cancelled' then raise exception 'sale_already_cancelled' using errcode = '23514'; end if;
    -- Anular dinero ya registrado: solo manager/admin, y con motivo.
    if app.permission_scope(s.org_id, 'sales:update') is distinct from 'org' then
      raise exception 'only managers can cancel sales' using errcode = '42501';
    end if;
    if char_length(btrim(coalesce(p_reason, ''))) < 3 then raise exception 'reason_required' using errcode = '23514'; end if;
  else
    raise exception 'invalid sale status' using errcode = '22023';
  end if;

  perform set_config('app.sale_transition', 'on', true);
  perform set_config('app.transition_reason', coalesce(p_reason, ''), true);
  update public.sales set
    status        = p_to,
    delivered_at  = case when p_to = 'delivered' then now() else delivered_at end,
    cancelled_at  = case when p_to = 'cancelled' then now() end,
    cancel_reason = case when p_to = 'cancelled' then left(btrim(p_reason), 500) end
   where id = s.id;
  perform set_config('app.transition_reason', '', true);
  perform set_config('app.sale_transition', 'off', true);

  if p_to = 'cancelled' then
    -- El seguimiento pendiente de una venta anulada deja de tener sentido.
    update public.tasks set status = 'cancelled', outcome = 'Venta anulada'
     where org_id = s.org_id and opportunity_id = s.opportunity_id and status = 'open'
       and description like 'Seguimiento postventa de ' || s.number || '%';
  end if;

  perform app.emit_event(s.org_id, 'sale.' || p_to, 'sale', s.id,
    jsonb_build_object('number', s.number, 'total', s.total, 'reason', left(nullif(btrim(coalesce(p_reason, '')), ''), 200)), s.customer_id);
end $$;

create or replace function public.mark_sale_delivered(p_id uuid) returns void
language sql security definer set search_path = '' as $$ select app.sale_transition(p_id, 'delivered', null) $$;
create or replace function public.cancel_sale(p_id uuid, p_reason text) returns void
language sql security definer set search_path = '' as $$ select app.sale_transition(p_id, 'cancelled', p_reason) $$;

-- ---------------------------------------------------------------------------
-- Casos
-- ---------------------------------------------------------------------------
create or replace function public.open_case(
  p_org uuid, p_customer uuid, p_title text, p_kind text default 'support', p_description text default null,
  p_priority text default 'normal', p_sale uuid default null, p_assignee uuid default null
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  c public.customers%rowtype;
  s public.sales%rowtype;
  v_asg uuid;
  v_team uuid;
  v_scope public.permission_scope;
  v_id uuid;
  v_n int;
begin
  if v_uid is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not app.has_permission(p_org, 'cases:create') then raise exception 'not allowed' using errcode = '42501'; end if;
  if btrim(coalesce(p_title, '')) = '' then raise exception 'name_required' using errcode = '22023'; end if;

  select * into c from public.customers where id = p_customer and org_id = p_org and deleted_at is null;
  if not found or not app.can_access_row(c.org_id, 'customers:read', c.owner_id, c.team_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_sale is not null then
    select * into s from public.sales where id = p_sale and org_id = p_org;
    if not found or not app.can_access_row(s.org_id, 'sales:read', s.owner_id, s.team_id) then
      raise exception 'not allowed' using errcode = '42501';
    end if;
    if s.customer_id <> p_customer then raise exception 'sale belongs to another customer' using errcode = '22023'; end if;
  end if;

  v_asg := coalesce(p_assignee, v_uid);
  if v_asg <> v_uid then
    v_scope := app.permission_scope(p_org, 'cases:create');
    select m.team_id into v_team from public.memberships m where m.org_id = p_org and m.user_id = v_asg and m.status = 'active';
    if v_scope is distinct from 'org' and not (v_scope = 'team' and v_team is not null and v_team = app.my_team_id(p_org)) then
      raise exception 'only managers can assign cases to others' using errcode = '42501';
    end if;
  end if;

  v_n := app.next_number(p_org, 'case');
  insert into public.cases (org_id, number, customer_id, sale_id, kind, priority, title, description, assignee_id, created_by)
  values (p_org, 'CAS-' || lpad(v_n::text, 4, '0'), p_customer, p_sale, coalesce(p_kind, 'support'), coalesce(p_priority, 'normal'),
          p_title, nullif(btrim(coalesce(p_description, '')), ''), v_asg, v_uid)
  returning id into v_id;

  perform app.emit_event(p_org, 'case.opened', 'case', v_id,
    jsonb_build_object('number', 'CAS-' || lpad(v_n::text, 4, '0'), 'title', left(btrim(p_title), 160), 'kind', coalesce(p_kind, 'support')), p_customer);
  return v_id;
end $$;

create or replace function public.set_case_status(p_id uuid, p_to text, p_note text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare c public.cases%rowtype; v_ok boolean;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into c from public.cases where id = p_id for update;
  if not found or not app.can_access_row(c.org_id, 'cases:update', c.assignee_id, c.team_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  v_ok := (c.status = 'open'        and p_to in ('in_progress', 'resolved'))
       or (c.status = 'in_progress' and p_to in ('resolved', 'open'))
       or (c.status = 'resolved'    and p_to in ('closed', 'open'))
       or (c.status = 'closed'      and p_to = 'open');
  if not v_ok then raise exception 'invalid_transition: % -> %', c.status, p_to using errcode = '23514'; end if;
  if c.status = 'closed' and app.permission_scope(c.org_id, 'cases:update') is distinct from 'org' then
    raise exception 'only managers can reopen a closed case' using errcode = '42501';
  end if;
  if p_to = 'resolved' and char_length(btrim(coalesce(p_note, ''))) < 3 then
    raise exception 'reason_required' using errcode = '23514';    -- la solución es obligatoria
  end if;

  perform set_config('app.case_transition', 'on', true);
  perform set_config('app.transition_reason', coalesce(p_note, ''), true);
  update public.cases set
    status      = p_to,
    resolution  = case when p_to = 'resolved' then left(btrim(p_note), 2000)
                       when p_to = 'closed' then resolution else null end,
    resolved_at = case when p_to = 'resolved' then now() when p_to = 'closed' then resolved_at else null end
   where id = c.id;
  perform set_config('app.transition_reason', '', true);
  perform set_config('app.case_transition', 'off', true);

  perform app.emit_event(c.org_id, 'case.status_changed', 'case', c.id,
    jsonb_build_object('number', c.number, 'from', c.status, 'to', p_to), c.customer_id);
end $$;

-- ---------------------------------------------------------------------------
-- Privilegios + RLS + auditoría
-- ---------------------------------------------------------------------------
revoke all on public.sales, public.sale_items, public.cases from anon, authenticated;
grant select on public.sales, public.sale_items, public.cases to authenticated;
grant update (title, description, priority, assignee_id) on public.cases to authenticated;
grant all on public.sales, public.sale_items, public.cases to service_role;

alter table public.sales      enable row level security;
alter table public.sale_items enable row level security;
alter table public.cases      enable row level security;

create policy sales_select on public.sales for select to authenticated
  using ((select app.can_access_row(org_id, 'sales:read', owner_id, team_id)));
create policy sale_items_select on public.sale_items for select to authenticated
  using (exists (select 1 from public.sales s where s.id = sale_id));
create policy cases_select on public.cases for select to authenticated
  using ((select app.can_access_row(org_id, 'cases:read', assignee_id, team_id)));
create policy cases_update on public.cases for update to authenticated
  using ((select app.can_access_row(org_id, 'cases:update', assignee_id, team_id)))
  with check ((select app.permission_scope(org_id, 'cases:update')) is not null);

create trigger sales_audit      after insert or update or delete on public.sales      for each row execute function app.audit_row_change();
create trigger sale_items_audit after insert on public.sale_items                     for each row execute function app.audit_row_change();
create trigger cases_audit      after insert or update or delete on public.cases      for each row execute function app.audit_row_change();

revoke all on function app.sale_items_immutable(), app.sales_prepare(), app.cases_prepare(),
  app.sale_transition(uuid, text, text) from public, anon, authenticated;

revoke all on function public.create_sale(uuid), public.mark_sale_delivered(uuid), public.cancel_sale(uuid, text),
  public.open_case(uuid, uuid, text, text, text, text, uuid, uuid), public.set_case_status(uuid, text, text)
  from public, anon;
grant execute on function public.create_sale(uuid), public.mark_sale_delivered(uuid), public.cancel_sale(uuid, text),
  public.open_case(uuid, uuid, text, text, text, text, uuid, uuid), public.set_case_status(uuid, text, text)
  to authenticated, service_role;


-- ---------------- 20260919000013_inbox_whatsapp.sql ----------------
-- =============================================================================
-- 0013 INBOX OMNICANAL (WhatsApp Cloud API)
-- =============================================================================
-- Flujo: webhook firmado → raw_events (durable) → normalización → resolución de identidad
--        → conversación → mensaje. Envío: cola en BD → reclamo atómico → API de Meta.
-- Reglas que viven en la base de datos:
--   * Un mensaje entrante se registra UNA sola vez (dedupe por id externo), aunque Meta reintente
--     o lleguen en paralelo.
--   * Un contacto nuevo nace como cliente + lead (misma resolución de identidad de la Fase 2).
--   * Solo se envía texto libre dentro de las 24 h posteriores al último mensaje del cliente;
--     fuera de esa ventana, solo plantillas aprobadas.
--   * «No contactar»: bloquea plantillas y mensajes proactivos; solo se permite RESPONDER dentro
--     de la ventana a un cliente que acaba de escribir.
--   * Los mensajes son de solo-anexar; los estados solo avanzan (enviado → entregado → leído).
--   * Envío «como máximo una vez»: un mensaje con resultado desconocido NO se reenvía solo.
--   * Los tokens de acceso están en una tabla que ningún usuario (ni admin) puede leer.
--   * Solo lo que Meta firmó con el App Secret entra (verificado en el servidor, antes de esto).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Canales y credenciales
-- ---------------------------------------------------------------------------
create table public.channels (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id) on delete cascade,
  kind          text not null default 'whatsapp' check (kind in ('whatsapp')),
  name          text not null check (char_length(btrim(name)) between 1 and 80),
  external_id   text not null check (external_id ~ '^[0-9]{5,30}$'),          -- phone_number_id de Meta
  display_phone text check (char_length(display_phone) <= 30),
  status        text not null default 'active' check (status in ('active', 'paused')),
  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (id, org_id),
  unique (kind, external_id)          -- el webhook se enruta por este id: no puede repetirse entre organizaciones
);

create table public.channel_secrets (
  channel_id   uuid primary key references public.channels(id) on delete cascade,
  access_token text not null check (char_length(access_token) between 20 and 2000),
  updated_at   timestamptz not null default now(),
  updated_by   uuid references auth.users(id) on delete set null
);

create table public.message_templates (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  channel_id  uuid not null,
  name        text not null check (name ~ '^[a-z0-9_]{1,200}$'),                -- nombre en Meta
  language    text not null check (language ~ '^[a-z]{2,3}(_[A-Z]{2})?$'),      -- es, es_CO, en_US
  body        text not null check (char_length(btrim(body)) between 1 and 1024),
  param_count int  not null default 0,
  status      text not null default 'approved' check (status in ('approved', 'disabled')),
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (id, org_id),
  unique (channel_id, name, language),
  foreign key (channel_id, org_id) references public.channels (id, org_id) on delete cascade
);

-- Los marcadores deben ser {{1}}, {{2}}… sin saltos (así los exige Meta).
create or replace function app.message_templates_prepare() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_max int; v_cnt int;
begin
  select coalesce(max(n), 0), count(distinct n) into v_max, v_cnt
    from (select (m[1])::int as n from regexp_matches(new.body, '\{\{(\d{1,2})\}\}', 'g') m) x;
  if v_max > 10 or v_cnt <> v_max then
    raise exception 'template_placeholders' using errcode = '23514';
  end if;
  new.param_count := v_max;
  new.body := btrim(new.body);
  return new;
end $$;
create trigger message_templates_prepare_trg before insert or update on public.message_templates
  for each row execute function app.message_templates_prepare();
create trigger channels_touch before update on public.channels for each row execute function app.touch_updated_at();
create trigger message_templates_touch before update on public.message_templates for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Conversaciones y mensajes
-- ---------------------------------------------------------------------------
create table public.conversations (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null references public.organizations(id) on delete cascade,
  channel_id           uuid not null,
  customer_id          uuid not null,
  thread_key           text not null check (thread_key ~ '^[0-9]{6,20}$'),     -- wa_id del contacto
  contact_name         text check (char_length(contact_name) <= 160),
  status               text not null default 'open' check (status in ('open', 'closed')),
  owner_id             uuid references auth.users(id) on delete set null,       -- sigue al dueño del cliente
  team_id              uuid,
  last_message_at      timestamptz,
  last_inbound_at      timestamptz,
  last_message_preview text check (char_length(last_message_preview) <= 140),
  last_direction       text check (last_direction in ('inbound', 'outbound')),
  needs_reply          boolean not null default false,
  unread               boolean not null default false,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (id, org_id),
  unique (channel_id, thread_key),
  foreign key (channel_id, org_id)  references public.channels (id, org_id),
  foreign key (customer_id, org_id) references public.customers (id, org_id),
  foreign key (team_id, org_id)     references public.teams (id, org_id) on delete set null (team_id)
);
create index conversations_inbox_idx    on public.conversations (org_id, last_message_at desc nulls last, id desc);
create index conversations_customer_idx on public.conversations (customer_id);
create index conversations_reply_idx    on public.conversations (org_id, needs_reply) where needs_reply;

create table public.messages (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organizations(id) on delete cascade,
  channel_id      uuid not null,
  conversation_id uuid not null,
  direction       text not null check (direction in ('inbound', 'outbound')),
  kind            text not null default 'text' check (kind in ('text', 'template', 'media', 'other')),
  body            text not null check (char_length(body) between 1 and 4096),
  external_id     text check (char_length(external_id) <= 200),                 -- wamid
  status          text not null check (status in ('received', 'queued', 'sending', 'sent', 'delivered', 'read', 'failed')),
  error_code      text check (char_length(error_code) <= 40),
  error           text check (char_length(error) <= 300),
  attempts        int not null default 0,
  template_id     uuid,
  template_params jsonb,
  sent_by         uuid references auth.users(id) on delete set null,
  occurred_at     timestamptz not null,
  created_at      timestamptz not null default clock_timestamp(),
  meta            jsonb not null default '{}'::jsonb,
  foreign key (channel_id, org_id)      references public.channels (id, org_id),
  foreign key (conversation_id, org_id) references public.conversations (id, org_id) on delete cascade,
  foreign key (template_id, org_id)     references public.message_templates (id, org_id),
  check ((direction = 'inbound') = (status = 'received'))
);
-- Deduplicación: el mismo id externo no se registra dos veces en un canal.
create unique index messages_external_uk on public.messages (channel_id, external_id) where external_id is not null;
create index messages_conversation_idx on public.messages (conversation_id, occurred_at, created_at);
create index messages_queue_idx on public.messages (created_at) where status in ('queued', 'sending');

-- Solo-anexar: el contenido no cambia y nada se borra (salvo al eliminar la organización).
create or replace function app.messages_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'TRUNCATE' then raise exception 'messages are append-only' using errcode = '42501'; end if;
  if tg_op = 'DELETE' then
    if not exists (select 1 from public.organizations where id = old.org_id) then return old; end if;
    raise exception 'messages are append-only' using errcode = '42501';
  end if;
  if new.org_id <> old.org_id or new.channel_id <> old.channel_id or new.conversation_id <> old.conversation_id
     or new.direction <> old.direction or new.kind <> old.kind or new.body <> old.body
     or new.template_id is distinct from old.template_id or new.template_params is distinct from old.template_params
     or new.sent_by is distinct from old.sent_by or new.occurred_at <> old.occurred_at
     or (old.external_id is not null and new.external_id is distinct from old.external_id) then
    raise exception 'messages are immutable' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger messages_guard_trg before update or delete on public.messages
  for each row execute function app.messages_guard();
create trigger messages_no_truncate before truncate on public.messages
  for each statement execute function app.messages_guard();

create or replace function app.conversations_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.org_id <> old.org_id or new.channel_id <> old.channel_id or new.thread_key <> old.thread_key
     or (new.customer_id <> old.customer_id and current_setting('app.customer_merge', true) is distinct from 'on') then
    raise exception 'conversation identity is immutable' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger conversations_guard_trg before update on public.conversations
  for each row execute function app.conversations_guard();
create trigger conversations_touch before update on public.conversations
  for each row execute function app.touch_updated_at();

insert into app.customer_merge_targets values ('conversations');

-- Las conversaciones siguen al cliente (abiertas y cerradas: son su historial).
create or replace function app.customers_after_update() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.owner_id is distinct from old.owner_id then
    update public.leads
       set owner_id = new.owner_id, team_id = new.team_id
     where customer_id = new.id and org_id = new.org_id and status in ('new', 'contacted', 'qualified');
    update public.opportunities
       set owner_id = new.owner_id, team_id = new.team_id
     where customer_id = new.id and org_id = new.org_id and status = 'open';
    update public.quotes
       set owner_id = new.owner_id, team_id = new.team_id
     where customer_id = new.id and org_id = new.org_id and status in ('draft', 'sent');
    update public.conversations
       set owner_id = new.owner_id, team_id = new.team_id
     where customer_id = new.id and org_id = new.org_id;
    perform set_config('app.system_reassign', 'on', true);
    update public.tasks
       set assignee_id = new.owner_id
     where customer_id = new.id and org_id = new.org_id and status = 'open'
       and assignee_id is not distinct from old.owner_id;
    perform set_config('app.system_reassign', 'off', true);
    perform app.emit_event(new.org_id, 'customer.assigned', 'customer', new.id,
                           jsonb_build_object('owner_id', new.owner_id), new.id);
  end if;
  if new.do_not_contact is distinct from old.do_not_contact then
    perform app.emit_event(new.org_id,
      case when new.do_not_contact then 'customer.dnc_set' else 'customer.dnc_cleared' end,
      'customer', new.id, jsonb_build_object('reason', new.dnc_reason), new.id);
  end if;
  return null;
end $$;

-- ---------------------------------------------------------------------------
-- Cola de webhooks (durable) — solo el servidor la toca
-- ---------------------------------------------------------------------------
create table public.raw_events (
  id              bigint generated always as identity primary key,
  provider        text not null default 'meta',
  payload         jsonb not null,
  status          text not null default 'pending' check (status in ('pending', 'processed', 'failed')),
  attempts        int not null default 0,
  last_attempt_at timestamptz,
  last_error      text check (char_length(last_error) <= 300),
  received_at     timestamptz not null default now(),
  processed_at    timestamptz
);
create index raw_events_pending_idx on public.raw_events (received_at) where status = 'pending';

-- ---------------------------------------------------------------------------
-- Utilidades internas
-- ---------------------------------------------------------------------------
create or replace function app.render_template(p_body text, p_params text[]) returns text
language plpgsql immutable set search_path = '' as $$
declare v text := p_body; i int;
begin
  for i in 1 .. coalesce(array_length(p_params, 1), 0) loop
    v := replace(v, '{{' || i || '}}', p_params[i]);
  end loop;
  return v;
end $$;

create or replace function app.message_rank(p_status text) returns int
language sql immutable set search_path = '' as $$
  select case p_status when 'queued' then 0 when 'sending' then 1 when 'sent' then 2 when 'delivered' then 3 when 'read' then 4 else -1 end
$$;

-- ---------------------------------------------------------------------------
-- Gestión de canales (solo quien tiene settings:manage)
-- ---------------------------------------------------------------------------
create or replace function public.create_channel(
  p_org uuid, p_name text, p_external_id text, p_display_phone text default null, p_access_token text default null
) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not app.has_permission(p_org, 'settings:manage') then raise exception 'not allowed' using errcode = '42501'; end if;
  insert into public.channels (org_id, name, external_id, display_phone, created_by)
  values (p_org, btrim(p_name), btrim(p_external_id), nullif(btrim(coalesce(p_display_phone, '')), ''), auth.uid())
  returning id into v_id;
  if p_access_token is not null and btrim(p_access_token) <> '' then
    insert into public.channel_secrets (channel_id, access_token, updated_by) values (v_id, btrim(p_access_token), auth.uid());
  end if;
  perform app.emit_event(p_org, 'channel.created', 'channel', v_id, jsonb_build_object('name', btrim(p_name)), null);
  return v_id;
end $$;

create or replace function public.save_channel_token(p_channel uuid, p_token text) returns void
language plpgsql security definer set search_path = '' as $$
declare c public.channels%rowtype;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into c from public.channels where id = p_channel;
  if not found or not app.has_permission(c.org_id, 'settings:manage') then raise exception 'not allowed' using errcode = '42501'; end if;
  insert into public.channel_secrets (channel_id, access_token, updated_by) values (p_channel, btrim(p_token), auth.uid())
  on conflict (channel_id) do update set access_token = excluded.access_token, updated_at = now(), updated_by = auth.uid();
  -- El evento NO incluye el token.
  perform app.emit_event(c.org_id, 'channel.token_updated', 'channel', c.id, '{}'::jsonb, null);
end $$;

-- Solo responde SI hay token (nunca cuál): para mostrar «configurado / falta» sin exponer el secreto.
create or replace function public.channel_token_status(p_org uuid)
returns table (channel_id uuid, has_token boolean) language plpgsql security definer stable set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not app.has_permission(p_org, 'settings:manage') then raise exception 'not allowed' using errcode = '42501'; end if;
  return query select c.id, exists (select 1 from public.channel_secrets s where s.channel_id = c.id)
                 from public.channels c where c.org_id = p_org order by c.created_at;
end $$;

create or replace function public.set_channel_status(p_channel uuid, p_status text) returns void
language plpgsql security definer set search_path = '' as $$
declare c public.channels%rowtype;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into c from public.channels where id = p_channel;
  if not found or not app.has_permission(c.org_id, 'settings:manage') then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_status not in ('active', 'paused') then raise exception 'invalid status' using errcode = '22023'; end if;
  update public.channels set status = p_status where id = p_channel;
  perform app.emit_event(c.org_id, 'channel.' || p_status, 'channel', c.id, '{}'::jsonb, null);
end $$;

-- ---------------------------------------------------------------------------
-- ENTRADA: mensaje recibido (lo llama el servidor con la llave de servicio)
-- ---------------------------------------------------------------------------
create or replace function public.ingest_whatsapp_message(
  p_phone_number_id text, p_thread text, p_contact_name text, p_external_id text,
  p_kind text, p_body text, p_occurred_at timestamptz, p_meta jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  ch     public.channels%rowtype;
  conv   public.conversations%rowtype;
  cust   public.customers%rowtype;
  v_res  jsonb;
  v_msg  uuid;
  v_at   timestamptz;
  v_body text;
  v_norm text;
  v_name text := nullif(btrim(coalesce(p_contact_name, '')), '');
  v_new  boolean := false;
  v_reopened boolean := false;
  v_optout boolean := false;
  v_kind text := case when p_kind in ('text', 'media', 'other') then p_kind else 'other' end;
begin
  if p_thread !~ '^[0-9]{6,20}$' then raise exception 'invalid thread' using errcode = '22023'; end if;
  if coalesce(btrim(p_external_id), '') = '' or char_length(p_external_id) > 200 then
    raise exception 'invalid external id' using errcode = '22023';
  end if;

  select * into ch from public.channels where kind = 'whatsapp' and external_id = p_phone_number_id;
  if not found then return jsonb_build_object('ok', false, 'reason', 'unknown_channel'); end if;

  if exists (select 1 from public.messages where channel_id = ch.id and external_id = p_external_id) then
    return jsonb_build_object('ok', true, 'deduplicated', true);
  end if;

  -- Serializa por conversación: dos mensajes simultáneos del mismo contacto nuevo no duplican nada.
  perform pg_advisory_xact_lock(hashtextextended('wa|' || ch.id::text || '|' || p_thread, 0));
  if exists (select 1 from public.messages where channel_id = ch.id and external_id = p_external_id) then
    return jsonb_build_object('ok', true, 'deduplicated', true);
  end if;

  v_at   := least(coalesce(p_occurred_at, clock_timestamp()), clock_timestamp());    -- nunca en el futuro
  v_body := left(coalesce(nullif(btrim(coalesce(p_body, '')), ''), '[Mensaje vacío]'), 4096);

  select * into conv from public.conversations where channel_id = ch.id and thread_key = p_thread for update;
  if not found then
    v_res := app.ingest_lead_core(ch.org_id, jsonb_build_object(
      'source', 'whatsapp', 'channel', 'whatsapp', 'name', coalesce(v_name, '+' || p_thread),
      'identifiers', jsonb_build_array(jsonb_build_object('type', 'phone', 'value', '+' || p_thread)),
      'external_id', 'wa:' || p_thread), null, null);
    select * into cust from public.customers where id = (v_res ->> 'customer_id')::uuid;
    insert into public.conversations (org_id, channel_id, customer_id, thread_key, contact_name, owner_id, team_id)
    values (ch.org_id, ch.id, cust.id, p_thread, v_name, cust.owner_id, cust.team_id)
    returning * into conv;
    v_new := true;
    perform app.emit_event(ch.org_id, 'conversation.opened', 'conversation', conv.id,
                           jsonb_build_object('channel', 'whatsapp'), cust.id);
  else
    select * into cust from public.customers where id = conv.customer_id;
    if conv.status = 'closed' then
      v_reopened := true;
      perform app.emit_event(ch.org_id, 'conversation.reopened', 'conversation', conv.id,
                             jsonb_build_object('channel', 'whatsapp'), cust.id);
    end if;
  end if;

  insert into public.messages (org_id, channel_id, conversation_id, direction, kind, body, external_id, status, occurred_at, meta)
  values (ch.org_id, ch.id, conv.id, 'inbound', v_kind, v_body, p_external_id, 'received', v_at, coalesce(p_meta, '{}'::jsonb))
  returning id into v_msg;

  -- Baja pedida por el propio cliente (mensaje EXACTO: no se interpreta texto libre).
  v_norm := lower(btrim(translate(v_body, 'áéíóúÁÉÍÓÚñÑ¡!¿?.,;:', 'aeiouaeiounn')));
  if v_norm in ('stop', 'baja', 'parar', 'no molestar', 'no mas', 'cancelar suscripcion', 'darme de baja', 'unsubscribe') then
    v_optout := true;
    update public.messages set meta = meta || '{"opt_out": true}'::jsonb where id = v_msg;
    if not cust.do_not_contact then
      update public.customers set do_not_contact = true, dnc_reason = 'Pidió la baja por WhatsApp' where id = cust.id;
    end if;
  end if;

  -- «Atrasado» = llega con más de 2 minutos de diferencia respecto al último mensaje. La tolerancia existe
  -- porque Meta envía la hora redondeada a segundos y con su reloj: un cliente que responde segundos después
  -- de nosotros NO puede considerarse anterior.
  update public.conversations set
    status          = 'open',
    contact_name    = coalesce(contact_name, v_name),
    last_inbound_at = greatest(coalesce(last_inbound_at, v_at), v_at),
    unread          = true,
    last_message_at = greatest(coalesce(last_message_at, v_at), v_at),
    last_message_preview = case when v_at >= coalesce(last_message_at, '-infinity') - interval '2 minutes'
                                then left(regexp_replace(v_body, '\s+', ' ', 'g'), 140) else last_message_preview end,
    last_direction  = case when v_at >= coalesce(last_message_at, '-infinity') - interval '2 minutes' then 'inbound' else last_direction end,
    needs_reply     = case when v_at >= coalesce(last_message_at, '-infinity') - interval '2 minutes' then true else needs_reply end
   where id = conv.id;

  return jsonb_build_object('ok', true, 'deduplicated', false, 'conversation_id', conv.id, 'message_id', v_msg,
                            'customer_id', cust.id, 'new_conversation', v_new, 'reopened', v_reopened, 'opt_out', v_optout);
end $$;

-- ---------------------------------------------------------------------------
-- ENTRADA: estado de un mensaje enviado (enviado / entregado / leído / falló)
-- Los estados solo avanzan; uno atrasado o repetido se ignora.
-- ---------------------------------------------------------------------------
create or replace function public.apply_message_status(
  p_phone_number_id text, p_external_id text, p_status text, p_occurred_at timestamptz default null,
  p_error_code text default null, p_error text default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare m public.messages%rowtype; v_apply boolean;
begin
  if p_status not in ('sent', 'delivered', 'read', 'failed') then
    return jsonb_build_object('ok', true, 'applied', false, 'reason', 'ignored_status');
  end if;
  select m2.* into m from public.messages m2
    join public.channels c on c.id = m2.channel_id
   where c.kind = 'whatsapp' and c.external_id = p_phone_number_id and m2.external_id = p_external_id and m2.direction = 'outbound'
   for update of m2;
  if not found then return jsonb_build_object('ok', false, 'reason', 'unknown_message'); end if;

  v_apply := case
    when p_status = 'failed' then m.status in ('queued', 'sending', 'sent')
    else app.message_rank(p_status) > app.message_rank(m.status) and m.status <> 'failed'
  end;
  if v_apply then
    update public.messages set
      status     = p_status,
      error_code = case when p_status = 'failed' then left(p_error_code, 40) end,
      error      = case when p_status = 'failed' then left(p_error, 300) end
     where id = m.id;
  end if;
  return jsonb_build_object('ok', true, 'applied', v_apply);
end $$;

-- ---------------------------------------------------------------------------
-- SALIDA: encolar (lo llama la persona usuaria; valida permiso, ventana y «no contactar»)
-- ---------------------------------------------------------------------------
create or replace function app.queue_outbound(
  p_conversation uuid, p_template uuid, p_body text, p_params text[]
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  conv public.conversations%rowtype;
  ch   public.channels%rowtype;
  cust public.customers%rowtype;
  t    public.message_templates%rowtype;
  v_body text;
  v_params text[];
  v_window boolean;
  v_id uuid;
  v_kind text := case when p_template is null then 'text' else 'template' end;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into conv from public.conversations where id = p_conversation for update;
  if not found or not app.can_access_row(conv.org_id, 'conversations:update', conv.owner_id, conv.team_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into ch from public.channels where id = conv.channel_id;
  if ch.status <> 'active' then raise exception 'channel_paused' using errcode = '23514'; end if;
  select * into cust from public.customers where id = conv.customer_id;

  v_window := conv.last_inbound_at is not null and conv.last_inbound_at > clock_timestamp() - interval '24 hours';

  -- «No contactar»: solo se puede RESPONDER (texto libre, dentro de la ventana) a quien acaba de escribir.
  if cust.do_not_contact and (v_kind = 'template' or not v_window) then
    raise exception 'do_not_contact' using errcode = '23514';
  end if;

  if v_kind = 'text' then
    v_body := btrim(coalesce(p_body, ''));
    if v_body = '' then raise exception 'message_empty' using errcode = '22023'; end if;
    if char_length(v_body) > 4096 then raise exception 'message_too_long' using errcode = '22023'; end if;
    if not v_window then raise exception 'window_closed' using errcode = '23514'; end if;
  else
    select * into t from public.message_templates where id = p_template and org_id = conv.org_id;
    if not found or t.status <> 'approved' or t.channel_id <> conv.channel_id then
      raise exception 'template_unavailable' using errcode = '22023';
    end if;
    select coalesce(array_agg(nullif(btrim(regexp_replace(x, '[\r\n\t]+', ' ', 'g')), '') order by ord), '{}')
      into v_params from unnest(coalesce(p_params, '{}')) with ordinality as u(x, ord);
    if coalesce(array_length(v_params, 1), 0) <> t.param_count or exists (select 1 from unnest(v_params) z where z is null) then
      raise exception 'template_params' using errcode = '22023';
    end if;
    v_body := app.render_template(t.body, v_params);
  end if;

  insert into public.messages (org_id, channel_id, conversation_id, direction, kind, body, status, sent_by, occurred_at,
                               template_id, template_params)
  values (conv.org_id, conv.channel_id, conv.id, 'outbound', v_kind, v_body, 'queued', auth.uid(), clock_timestamp(),
          p_template, case when v_kind = 'template' then to_jsonb(v_params) end)
  returning id into v_id;

  update public.conversations set
    last_message_at = clock_timestamp(), last_direction = 'outbound', needs_reply = false, unread = false,
    last_message_preview = left(regexp_replace(v_body, '\s+', ' ', 'g'), 140)
   where id = conv.id;
  return v_id;
end $$;

create or replace function public.queue_message(p_conversation uuid, p_body text) returns uuid
language sql security definer set search_path = '' as $$ select app.queue_outbound(p_conversation, null, p_body, null) $$;
create or replace function public.queue_template_message(p_conversation uuid, p_template uuid, p_params text[] default '{}') returns uuid
language sql security definer set search_path = '' as $$ select app.queue_outbound(p_conversation, p_template, null, p_params) $$;

-- ---------------------------------------------------------------------------
-- Operaciones de la bandeja
-- ---------------------------------------------------------------------------
create or replace function public.mark_conversation_read(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare c public.conversations%rowtype;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into c from public.conversations where id = p_id;
  if not found or not app.can_access_row(c.org_id, 'conversations:update', c.owner_id, c.team_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update public.conversations set unread = false where id = p_id and unread;
end $$;

create or replace function public.set_conversation_status(p_id uuid, p_status text) returns void
language plpgsql security definer set search_path = '' as $$
declare c public.conversations%rowtype;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into c from public.conversations where id = p_id for update;
  if not found or not app.can_access_row(c.org_id, 'conversations:update', c.owner_id, c.team_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_status not in ('open', 'closed') then raise exception 'invalid status' using errcode = '22023'; end if;
  update public.conversations set status = p_status, needs_reply = case when p_status = 'closed' then false else needs_reply end,
         unread = case when p_status = 'closed' then false else unread end
   where id = p_id;
end $$;

-- ---------------------------------------------------------------------------
-- Envío (solo servidor): reclamo atómico, resultado, barrido de pendientes
-- ---------------------------------------------------------------------------
create or replace function public.claim_outbound(p_message uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare m public.messages%rowtype; conv public.conversations%rowtype; ch public.channels%rowtype; t public.message_templates%rowtype;
begin
  -- Solo UNA llamada gana: pasa de 'queued' a 'sending' (las demás no encuentran nada).
  update public.messages set status = 'sending', attempts = attempts + 1
   where id = p_message and direction = 'outbound' and status = 'queued'
  returning * into m;
  if not found then return null; end if;
  select * into conv from public.conversations where id = m.conversation_id;
  select * into ch from public.channels where id = m.channel_id;
  if m.template_id is not null then select * into t from public.message_templates where id = m.template_id; end if;
  return jsonb_build_object('message_id', m.id, 'kind', m.kind, 'body', m.body, 'to', conv.thread_key,
    'phone_number_id', ch.external_id, 'channel_id', ch.id,
    'template_name', t.name, 'template_language', t.language, 'template_params', m.template_params);
end $$;

create or replace function public.finish_outbound(
  p_message uuid, p_ok boolean, p_external_id text default null, p_error_code text default null, p_error text default null
) returns void language plpgsql security definer set search_path = '' as $$
begin
  -- Un estado posterior (entregado/leído) que llegó antes que este resultado no se pisa.
  if p_ok then
    update public.messages set status = case when app.message_rank(status) > app.message_rank('sent') then status else 'sent' end,
           external_id = coalesce(external_id, p_external_id), error = null, error_code = null
     where id = p_message and direction = 'outbound' and status in ('sending', 'sent', 'delivered', 'read');
  else
    update public.messages set status = 'failed', error_code = left(p_error_code, 40), error = left(p_error, 300)
     where id = p_message and direction = 'outbound' and status = 'sending';
  end if;
end $$;

create or replace function public.sweep_outbound(p_queued_after_seconds int default 30, p_sending_after_seconds int default 300)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_retry uuid[]; v_expired int;
begin
  -- Encolados que nadie reclamó (la petición original se cortó antes de enviar): se pueden enviar sin riesgo.
  select coalesce(array_agg(id), '{}') into v_retry from (
    select id from public.messages
     where direction = 'outbound' and status = 'queued' and created_at < clock_timestamp() - make_interval(secs => p_queued_after_seconds)
     order by created_at limit 50) q;
  -- «Enviando» por demasiado tiempo: NO sabemos si salió. No se reenvía (evita mensajes duplicados al cliente).
  with x as (
    update public.messages set status = 'failed', error_code = 'unknown_outcome',
           error = 'No se pudo confirmar el envío. Revisa en WhatsApp antes de reenviar.'
     where direction = 'outbound' and status = 'sending' and created_at < clock_timestamp() - make_interval(secs => p_sending_after_seconds)
    returning 1)
  select count(*) into v_expired from x;
  return jsonb_build_object('retry_ids', to_jsonb(v_retry), 'expired', v_expired);
end $$;

create or replace function public.channel_credentials(p_channel uuid) returns text
language sql security definer stable set search_path = '' as $$
  select access_token from public.channel_secrets where channel_id = p_channel
$$;

-- ---------------------------------------------------------------------------
-- Cola de webhooks (solo servidor)
-- ---------------------------------------------------------------------------
create or replace function public.record_raw_event(p_payload jsonb) returns bigint
language sql security definer set search_path = '' as $$
  insert into public.raw_events (payload, attempts, last_attempt_at) values (p_payload, 1, clock_timestamp()) returning id
$$;

create or replace function public.finish_raw_event(p_id bigint, p_ok boolean, p_error text default null) returns void
language sql security definer set search_path = '' as $$
  update public.raw_events set
    status = case when p_ok then 'processed' when attempts >= 8 then 'failed' else 'pending' end,
    processed_at = case when p_ok then clock_timestamp() end, last_error = left(p_error, 300)
   where id = p_id
$$;

create or replace function public.claim_raw_events(p_limit int default 20, p_min_age_seconds int default 30)
returns table (id bigint, payload jsonb) language sql security definer set search_path = '' as $$
  update public.raw_events e set attempts = e.attempts + 1, last_attempt_at = clock_timestamp()
   where e.id in (select r.id from public.raw_events r
                   where r.status = 'pending' and r.attempts < 8
                     and coalesce(r.last_attempt_at, r.received_at) < clock_timestamp() - make_interval(secs => p_min_age_seconds)
                   order by r.id limit p_limit for update skip locked)
  returning e.id, e.payload
$$;

create or replace function public.purge_raw_events(p_days int default 30) returns int
language sql security definer set search_path = '' as $$
  with d as (delete from public.raw_events where status = 'processed' and processed_at < now() - make_interval(days => p_days) returning 1)
  select count(*)::int from d
$$;

-- ---------------------------------------------------------------------------
-- Privilegios + RLS + auditoría
-- ---------------------------------------------------------------------------
revoke all on public.channels, public.channel_secrets, public.message_templates, public.conversations, public.messages, public.raw_events
  from anon, authenticated;
grant select on public.channels, public.message_templates, public.conversations, public.messages to authenticated;
grant insert (org_id, channel_id, name, language, body) on public.message_templates to authenticated;
grant update (body, status) on public.message_templates to authenticated;
grant all on public.channels, public.channel_secrets, public.message_templates, public.conversations, public.messages, public.raw_events to service_role;

alter table public.channels          enable row level security;
alter table public.channel_secrets   enable row level security;   -- sin políticas: nadie con sesión de usuario la lee
alter table public.message_templates enable row level security;
alter table public.conversations     enable row level security;
alter table public.messages          enable row level security;
alter table public.raw_events        enable row level security;   -- sin políticas: solo el servidor

create policy channels_select on public.channels for select to authenticated
  using ((select app.has_permission(org_id, 'conversations:read')) or (select app.has_permission(org_id, 'settings:manage')));
create policy templates_select on public.message_templates for select to authenticated
  using ((select app.has_permission(org_id, 'conversations:update')) or (select app.has_permission(org_id, 'settings:manage')));
create policy templates_insert on public.message_templates for insert to authenticated
  with check ((select app.has_permission(org_id, 'settings:manage')));
create policy templates_update on public.message_templates for update to authenticated
  using ((select app.has_permission(org_id, 'settings:manage')))
  with check ((select app.has_permission(org_id, 'settings:manage')));
create policy conversations_select on public.conversations for select to authenticated
  using ((select app.can_access_row(org_id, 'conversations:read', owner_id, team_id)));
create policy messages_select on public.messages for select to authenticated
  using (exists (select 1 from public.conversations c where c.id = conversation_id));

create trigger channels_audit  after insert or update or delete on public.channels          for each row execute function app.audit_row_change();
create trigger templates_audit after insert or update or delete on public.message_templates for each row execute function app.audit_row_change();

-- Funciones internas: nadie con sesión de usuario las ejecuta directamente.
revoke all on function app.message_templates_prepare(), app.messages_guard(), app.conversations_guard(),
  app.render_template(text, text[]), app.message_rank(text), app.customers_after_update(),
  app.queue_outbound(uuid, uuid, text, text[]) from public, anon, authenticated;

-- Funciones del servidor (llave de servicio): jamás desde el navegador.
revoke all on function public.ingest_whatsapp_message(text, text, text, text, text, text, timestamptz, jsonb),
  public.apply_message_status(text, text, text, timestamptz, text, text),
  public.claim_outbound(uuid), public.finish_outbound(uuid, boolean, text, text, text),
  public.sweep_outbound(int, int), public.channel_credentials(uuid),
  public.record_raw_event(jsonb), public.finish_raw_event(bigint, boolean, text),
  public.claim_raw_events(int, int), public.purge_raw_events(int) from public, anon, authenticated;
grant execute on function public.ingest_whatsapp_message(text, text, text, text, text, text, timestamptz, jsonb),
  public.apply_message_status(text, text, text, timestamptz, text, text),
  public.claim_outbound(uuid), public.finish_outbound(uuid, boolean, text, text, text),
  public.sweep_outbound(int, int), public.channel_credentials(uuid),
  public.record_raw_event(jsonb), public.finish_raw_event(bigint, boolean, text),
  public.claim_raw_events(int, int), public.purge_raw_events(int) to service_role;

-- Funciones de la persona usuaria.
revoke all on function public.create_channel(uuid, text, text, text, text), public.save_channel_token(uuid, text),
  public.set_channel_status(uuid, text), public.channel_token_status(uuid), public.queue_message(uuid, text), public.queue_template_message(uuid, uuid, text[]),
  public.mark_conversation_read(uuid), public.set_conversation_status(uuid, text) from public, anon;
grant execute on function public.create_channel(uuid, text, text, text, text), public.save_channel_token(uuid, text),
  public.set_channel_status(uuid, text), public.channel_token_status(uuid), public.queue_message(uuid, text), public.queue_template_message(uuid, uuid, text[]),
  public.mark_conversation_read(uuid), public.set_conversation_status(uuid, text) to authenticated, service_role;


-- ---------------- 20260919000014_inbox_context.sql ----------------
-- =============================================================================
-- 0014 INBOX: contexto del cliente (etiquetas), respuestas rápidas y contador de no leídos
-- =============================================================================
-- Reglas que viven en la base de datos:
--   * Una etiqueta es única por organización sin distinguir mayúsculas ni espacios extremos.
--   * Etiquetar/quitar etiqueta exige poder EDITAR a ese cliente (alcance por dueño/equipo).
--   * Agregar una etiqueta es idempotente y seguro con concurrencia (nunca duplica).
--   * Al fusionar clientes, las etiquetas se unen sin duplicarse.
--   * El contador de no leídos suma con cada mensaje entrante y vuelve a 0 al responder,
--     marcar como leída o cerrar; nunca es negativo.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Contador de no leídos
-- ---------------------------------------------------------------------------
alter table public.conversations add column unread_count int not null default 0 check (unread_count >= 0);
update public.conversations set unread_count = 1 where unread;

create or replace function app.messages_count_unread() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.conversations set unread_count = unread_count + 1, unread = true where id = new.conversation_id;
  return null;
end $$;
create trigger messages_count_unread_trg after insert on public.messages
  for each row when (new.direction = 'inbound') execute function app.messages_count_unread();

create or replace function app.conversations_unread_sync() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not new.unread then new.unread_count := 0; end if;
  if new.unread and new.unread_count = 0 then new.unread_count := 1; end if;
  return new;
end $$;
create trigger conversations_unread_sync_trg before update on public.conversations
  for each row execute function app.conversations_unread_sync();

-- ---------------------------------------------------------------------------
-- Etiquetas
-- ---------------------------------------------------------------------------
create table public.tags (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.organizations(id) on delete cascade,
  name       text not null check (char_length(btrim(name)) between 1 and 40),
  color      text not null default 'violet' check (color in ('violet', 'blue', 'teal', 'green', 'yellow', 'orange', 'red', 'pink', 'gray')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (id, org_id)
);
create unique index tags_name_uk on public.tags (org_id, (lower(btrim(name))));

create table public.customer_tags (
  org_id      uuid not null,
  customer_id uuid not null,
  tag_id      uuid not null,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  primary key (customer_id, tag_id),
  foreign key (customer_id, org_id) references public.customers (id, org_id) on delete cascade,
  foreign key (tag_id, org_id)      references public.tags (id, org_id) on delete cascade
);
create index customer_tags_tag_idx on public.customer_tags (tag_id);

-- Al fusionar clientes (UPDATE de customer_id), si el principal ya tiene la etiqueta se descarta la repetida.
create or replace function app.customer_tags_merge_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.customer_id <> old.customer_id
     and exists (select 1 from public.customer_tags x where x.customer_id = new.customer_id and x.tag_id = new.tag_id) then
    delete from public.customer_tags where customer_id = old.customer_id and tag_id = old.tag_id;
    return null;
  end if;
  return new;
end $$;
create trigger customer_tags_merge_guard_trg before update on public.customer_tags
  for each row execute function app.customer_tags_merge_guard();
insert into app.customer_merge_targets values ('customer_tags');

create or replace function public.add_customer_tag(p_customer uuid, p_name text, p_color text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  c public.customers%rowtype; v_name text := btrim(coalesce(p_name, '')); v_tag uuid; v_color text;
  v_palette text[] := array['violet', 'blue', 'teal', 'green', 'yellow', 'orange', 'red', 'pink'];
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into c from public.customers where id = p_customer and deleted_at is null;
  if not found or not app.can_access_row(c.org_id, 'customers:update', c.owner_id, c.team_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if char_length(v_name) < 1 or char_length(v_name) > 40 then raise exception 'tag_name' using errcode = '22023'; end if;
  v_color := coalesce(nullif(btrim(coalesce(p_color, '')), ''), v_palette[1 + abs(hashtext(lower(v_name))) % 8]);
  if v_color not in ('violet', 'blue', 'teal', 'green', 'yellow', 'orange', 'red', 'pink', 'gray') then
    raise exception 'tag_color' using errcode = '22023';
  end if;

  select id into v_tag from public.tags where org_id = c.org_id and lower(btrim(name)) = lower(v_name);
  if v_tag is null then
    insert into public.tags (org_id, name, color, created_by) values (c.org_id, v_name, v_color, auth.uid())
    on conflict (org_id, (lower(btrim(name)))) do nothing returning id into v_tag;
    if v_tag is null then   -- otra sesión la creó justo ahora
      select id into v_tag from public.tags where org_id = c.org_id and lower(btrim(name)) = lower(v_name);
    end if;
  end if;
  insert into public.customer_tags (org_id, customer_id, tag_id, created_by) values (c.org_id, c.id, v_tag, auth.uid())
  on conflict (customer_id, tag_id) do nothing;
  return v_tag;
end $$;

create or replace function public.remove_customer_tag(p_customer uuid, p_tag uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare c public.customers%rowtype;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into c from public.customers where id = p_customer;
  if not found or not app.can_access_row(c.org_id, 'customers:update', c.owner_id, c.team_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  delete from public.customer_tags where customer_id = p_customer and tag_id = p_tag and org_id = c.org_id;
end $$;

-- ---------------------------------------------------------------------------
-- Respuestas rápidas
-- ---------------------------------------------------------------------------
create table public.quick_replies (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.organizations(id) on delete cascade,
  title      text not null check (char_length(btrim(title)) between 1 and 60),
  body       text not null check (char_length(btrim(body)) between 1 and 1000),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (id, org_id)
);
create unique index quick_replies_title_uk on public.quick_replies (org_id, (lower(btrim(title))));

create or replace function public.create_quick_reply(p_org uuid, p_title text, p_body text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not app.has_permission(p_org, 'conversations:update') then raise exception 'not allowed' using errcode = '42501'; end if;
  insert into public.quick_replies (org_id, title, body, created_by) values (p_org, btrim(p_title), btrim(p_body), auth.uid())
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.delete_quick_reply(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare q public.quick_replies%rowtype;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into q from public.quick_replies where id = p_id;
  if not found then return; end if;
  if not (q.created_by = auth.uid() and app.has_permission(q.org_id, 'conversations:update'))
     and not app.has_permission(q.org_id, 'settings:manage') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  delete from public.quick_replies where id = p_id;
end $$;

-- ---------------------------------------------------------------------------
-- Privilegios + RLS + auditoría
-- ---------------------------------------------------------------------------
revoke all on public.tags, public.customer_tags, public.quick_replies from anon, authenticated;
grant select on public.tags, public.customer_tags, public.quick_replies to authenticated;
grant all on public.tags, public.customer_tags, public.quick_replies to service_role;

alter table public.tags          enable row level security;
alter table public.customer_tags enable row level security;
alter table public.quick_replies enable row level security;

create policy tags_select on public.tags for select to authenticated
  using ((select app.has_permission(org_id, 'customers:read')));
create policy customer_tags_select on public.customer_tags for select to authenticated
  using (exists (select 1 from public.customers c where c.id = customer_id));
create policy quick_replies_select on public.quick_replies for select to authenticated
  using ((select app.has_permission(org_id, 'conversations:update')) or (select app.has_permission(org_id, 'settings:manage')));

create trigger tags_audit          after insert or update or delete on public.tags          for each row execute function app.audit_row_change();
create trigger quick_replies_audit after insert or update or delete on public.quick_replies for each row execute function app.audit_row_change();

revoke all on function app.messages_count_unread(), app.conversations_unread_sync(), app.customer_tags_merge_guard() from public, anon, authenticated;
revoke all on function public.add_customer_tag(uuid, text, text), public.remove_customer_tag(uuid, uuid),
  public.create_quick_reply(uuid, text, text), public.delete_quick_reply(uuid) from public, anon;
grant execute on function public.add_customer_tag(uuid, text, text), public.remove_customer_tag(uuid, uuid),
  public.create_quick_reply(uuid, text, text), public.delete_quick_reply(uuid) to authenticated, service_role;


-- ---------------- 20260919000015_opportunities_kanban.sql ----------------
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

commit;

-- Comprobación final: 'tablas' y 'tablas_con_rls' deben ser iguales.
select 'LISTO' as estado,
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r') as tablas,
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity) as tablas_con_rls,
  (select count(*) from public.permissions) as permisos,
  (select count(*) from public.roles where org_id is null) as roles_base;

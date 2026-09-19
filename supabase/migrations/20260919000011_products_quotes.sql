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

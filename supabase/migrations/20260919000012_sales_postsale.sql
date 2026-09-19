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

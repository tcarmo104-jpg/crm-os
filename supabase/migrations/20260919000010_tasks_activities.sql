-- =============================================================================
-- 0010 TAREAS Y ACTIVIDADES
-- =============================================================================
--   * Tarea = algo POR HACER (asignada, con vencimiento). Actividad = algo que YA pasó (llamada,
--     reunión, nota) y no se edita: un error se corrige con una nota nueva.
--   * Una tarea vinculada a una oportunidad hereda su cliente (nunca hay inconsistencia).
--   * Crear una tarea o actividad exige tener acceso al cliente/oportunidad al que se vincula.
--   * Cambiar de responsable una tarea: vendedor no; sales manager, dentro de su equipo; manager/admin, a cualquiera.
--   * Las tareas abiertas siguen al cliente cuando se reasigna o se fusiona.
--   * Todo pasa por RPC: los estados (abierta/hecha/cancelada) no son escribibles directamente.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- tasks
-- ---------------------------------------------------------------------------
create table public.tasks (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organizations(id) on delete cascade,
  title          text not null check (char_length(btrim(title)) between 1 and 160),
  description    text check (char_length(description) <= 2000),
  type           text not null default 'follow_up' check (type in ('call', 'whatsapp', 'email', 'meeting', 'follow_up', 'other')),
  priority       text not null default 'normal' check (priority in ('low', 'normal', 'high')),
  due_at         timestamptz,
  status         text not null default 'open' check (status in ('open', 'done', 'cancelled')),
  assignee_id    uuid references auth.users(id) on delete set null,
  team_id        uuid,
  customer_id    uuid,
  opportunity_id uuid,
  outcome        text check (char_length(outcome) <= 500),
  completed_at   timestamptz,
  completed_by   uuid references auth.users(id) on delete set null,
  created_by     uuid references auth.users(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (id, org_id),
  foreign key (customer_id, org_id)    references public.customers (id, org_id),
  foreign key (opportunity_id, org_id) references public.opportunities (id, org_id),
  foreign key (team_id, org_id)        references public.teams (id, org_id) on delete set null (team_id),
  check ((status = 'done') = (completed_at is not null))
);
create index tasks_assignee_idx    on public.tasks (org_id, assignee_id, status, due_at);
create index tasks_customer_idx    on public.tasks (customer_id);
create index tasks_opportunity_idx on public.tasks (opportunity_id);

-- ---------------------------------------------------------------------------
-- activities (inmutables)
-- ---------------------------------------------------------------------------
create table public.activities (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organizations(id) on delete cascade,
  customer_id    uuid not null,
  opportunity_id uuid,
  type           text not null check (type in ('call', 'whatsapp', 'email', 'meeting', 'note')),
  direction      text check (direction in ('inbound', 'outbound')),
  summary        text not null check (char_length(btrim(summary)) between 1 and 2000),
  occurred_at    timestamptz not null default now(),
  created_by     uuid references auth.users(id) on delete set null,
  created_at     timestamptz not null default now(),
  foreign key (customer_id, org_id)    references public.customers (id, org_id),
  foreign key (opportunity_id, org_id) references public.opportunities (id, org_id),
  -- llamadas, WhatsApp y correos requieren dirección (entrante/saliente); notas y reuniones no
  check (type in ('note', 'meeting') or direction is not null)
);
create index activities_customer_idx on public.activities (customer_id, occurred_at desc);

create or replace function app.activities_immutable() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'activities are immutable' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' and not exists (select 1 from public.organizations where id = old.org_id) then
    return old;   -- cascada al eliminar la organización
  end if;
  -- El cliente absorbido en una fusión mueve sus actividades: única modificación permitida.
  if tg_op = 'UPDATE' and current_setting('app.customer_merge', true) = 'on'
     and new.customer_id is distinct from old.customer_id
     and (new.id, new.org_id, new.type, new.direction, new.summary, new.occurred_at, new.opportunity_id, new.created_by, new.created_at)
         is not distinct from (old.id, old.org_id, old.type, old.direction, old.summary, old.occurred_at, old.opportunity_id, old.created_by, old.created_at) then
    return new;
  end if;
  raise exception 'activities are immutable' using errcode = '42501';
end $$;
create trigger activities_no_mutation before update or delete on public.activities
  for each row execute function app.activities_immutable();
create trigger activities_no_truncate before truncate on public.activities
  for each statement execute function app.activities_immutable();

-- ---------------------------------------------------------------------------
-- Guardas de tasks
-- ---------------------------------------------------------------------------
create or replace function app.tasks_prepare() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_uid   uuid := auth.uid();
  v_team  uuid;
  v_scope public.permission_scope;
  v_opp_customer uuid;
begin
  new.title := btrim(new.title);

  -- Vinculada a una oportunidad: el cliente es el de la oportunidad.
  if new.opportunity_id is not null then
    select o.customer_id into v_opp_customer from public.opportunities o
     where o.id = new.opportunity_id and o.org_id = new.org_id;
    new.customer_id := v_opp_customer;
  end if;

  if tg_op = 'UPDATE' then
    if new.org_id <> old.org_id or new.opportunity_id is distinct from old.opportunity_id
       or (new.customer_id is distinct from old.customer_id and current_setting('app.customer_merge', true) is distinct from 'on') then
      raise exception 'task links are immutable' using errcode = '23514';
    end if;
    -- Una tarea cerrada es de solo lectura (se reabre con reopen_task).
    if old.status <> 'open' and current_setting('app.task_transition', true) is distinct from 'on'
       and (new.title <> old.title or new.due_at is distinct from old.due_at or new.assignee_id is distinct from old.assignee_id
            or new.priority <> old.priority or new.type <> old.type or new.description is distinct from old.description) then
      raise exception 'task_closed' using errcode = '23514';
    end if;
  end if;

  if tg_op = 'INSERT' or new.assignee_id is distinct from old.assignee_id then
    if new.assignee_id is null then
      new.team_id := null;
    else
      select m.team_id into v_team from public.memberships m
       where m.org_id = new.org_id and m.user_id = new.assignee_id and m.status = 'active';
      if not found then
        raise exception 'assignee must be an active member of the organization' using errcode = '23514';
      end if;
      new.team_id := v_team;
    end if;
    -- Reasignar una tarea existente: solo manager/admin (a cualquiera) o sales manager (dentro de su equipo).
    if tg_op = 'UPDATE' and v_uid is not null and current_setting('app.system_reassign', true) is distinct from 'on' then
      v_scope := app.permission_scope(new.org_id, 'tasks:update');
      if v_scope is distinct from 'org'
         and not (v_scope = 'team' and new.team_id is not null and new.team_id = app.my_team_id(new.org_id)) then
        raise exception 'only managers can reassign tasks' using errcode = '42501';
      end if;
    end if;
  end if;
  return new;
end $$;
create trigger tasks_prepare_trg before insert or update on public.tasks
  for each row execute function app.tasks_prepare();
create trigger tasks_touch before update on public.tasks
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Las tareas abiertas siguen al cliente al reasignarlo (solo las que tenía el responsable anterior:
-- lo asignado a mano a otra persona no se toca).
-- ---------------------------------------------------------------------------
create or replace function app.customers_after_update() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.owner_id is distinct from old.owner_id then
    update public.leads
       set owner_id = new.owner_id, team_id = new.team_id
     where customer_id = new.id and org_id = new.org_id
       and status in ('new', 'contacted', 'qualified');
    update public.opportunities
       set owner_id = new.owner_id, team_id = new.team_id
     where customer_id = new.id and org_id = new.org_id and status = 'open';
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
-- Registro de fusión + fusión ampliada (tareas y actividades)
-- ---------------------------------------------------------------------------
insert into app.customer_merge_targets values ('tasks'), ('activities');

create or replace function public.merge_customers(p_keep uuid, p_drop uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  k public.customers%rowtype;
  d public.customers%rowtype;
  v_locked int;
  t text;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if p_keep = p_drop then
    raise exception 'cannot merge a customer with itself' using errcode = '22023';
  end if;

  select count(*) into v_locked from (
    select 1 from public.customers where id in (p_keep, p_drop) and deleted_at is null order by id for update) s;
  if v_locked <> 2 then
    raise exception 'customer not found' using errcode = '22023';
  end if;
  select * into k from public.customers where id = p_keep;
  select * into d from public.customers where id = p_drop;

  if k.org_id <> d.org_id then
    raise exception 'customers belong to different organizations' using errcode = '42501';
  end if;
  if app.permission_scope(k.org_id, 'customers:update') is distinct from 'org' then
    raise exception 'only managers can merge customers' using errcode = '42501';
  end if;
  if k.type <> d.type then
    raise exception 'cannot merge a person with a company' using errcode = '22023';
  end if;

  perform set_config('app.customer_merge', 'on', true);
  -- Toda tabla con customer_id está en el registro (una prueba estructural lo exige).
  -- El orden (alfabético) importa: 'opportunities' va antes que 'tasks', y las tareas heredan el cliente de su oportunidad.
  for t in select table_name from app.customer_merge_targets order by table_name loop
    execute format('update public.%I set customer_id = $1 where customer_id = $2 and org_id = $3', t)
      using k.id, d.id, k.org_id;
  end loop;
  update public.customers set company_id = k.id where company_id = d.id and org_id = k.org_id and id <> k.id;

  update public.identity_reviews
     set status = case when (customer_id = k.id and candidate_id = d.id) or (customer_id = d.id and candidate_id = k.id)
                       then 'merged' else 'dismissed' end,
         resolved_by = auth.uid(), resolved_at = now()
   where org_id = k.org_id and status = 'pending'
     and (customer_id = d.id or candidate_id = d.id);

  update public.customers set
    city              = coalesce(k.city, d.city),
    country           = coalesce(k.country, d.country),
    address           = coalesce(k.address, d.address),
    preferred_channel = coalesce(k.preferred_channel, d.preferred_channel),
    company_id        = coalesce(k.company_id, d.company_id),
    custom_fields     = d.custom_fields || k.custom_fields,
    owner_id          = coalesce(k.owner_id, d.owner_id),
    first_contact_at  = least(k.first_contact_at, d.first_contact_at),
    -- Seguridad: si cualquiera pidió no ser contactado, el cliente fusionado tampoco.
    do_not_contact    = k.do_not_contact or d.do_not_contact,
    dnc_reason        = case when k.do_not_contact then k.dnc_reason when d.do_not_contact then d.dnc_reason end
  where id = k.id;

  update public.customers set deleted_at = now(), merged_into_id = k.id where id = d.id;

  -- Lo abierto que venía del cliente absorbido pasa al responsable del cliente resultante.
  select * into k from public.customers where id = k.id;
  update public.leads set owner_id = k.owner_id, team_id = k.team_id
   where customer_id = k.id and org_id = k.org_id and status in ('new', 'contacted', 'qualified');
  update public.opportunities set owner_id = k.owner_id, team_id = k.team_id
   where customer_id = k.id and org_id = k.org_id and status = 'open';
  perform set_config('app.system_reassign', 'on', true);
  update public.tasks set assignee_id = k.owner_id
   where customer_id = k.id and org_id = k.org_id and status = 'open'
     and assignee_id is not distinct from d.owner_id and d.owner_id is distinct from k.owner_id;
  perform set_config('app.system_reassign', 'off', true);
  perform set_config('app.customer_merge', 'off', true);

  perform app.emit_event(k.org_id, 'customer.merged', 'customer', k.id,
                         jsonb_build_object('dropped_id', d.id, 'dropped_name', d.full_name), k.id);
end $$;

-- ---------------------------------------------------------------------------
-- RPC de tareas
-- ---------------------------------------------------------------------------
create or replace function public.create_task(
  p_org uuid, p_title text, p_type text default 'follow_up', p_due timestamptz default null,
  p_priority text default 'normal', p_description text default null,
  p_customer uuid default null, p_opportunity uuid default null, p_assignee uuid default null
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_uid   uuid := auth.uid();
  v_asg   uuid;
  v_scope public.permission_scope;
  v_team  uuid;
  c public.customers%rowtype;
  o public.opportunities%rowtype;
  v_id uuid;
begin
  if v_uid is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not app.has_permission(p_org, 'tasks:create') then raise exception 'not allowed' using errcode = '42501'; end if;
  if btrim(coalesce(p_title, '')) = '' then raise exception 'name_required' using errcode = '22023'; end if;
  if p_due is not null and (p_due < now() - interval '1 year' or p_due > now() + interval '5 years') then
    raise exception 'due date out of range' using errcode = '22023';
  end if;

  -- Solo se vincula a lo que la persona puede ver.
  if p_opportunity is not null then
    select * into o from public.opportunities where id = p_opportunity and org_id = p_org;
    if not found or not app.can_access_row(o.org_id, 'opportunities:read', o.owner_id, o.team_id) then
      raise exception 'not allowed' using errcode = '42501';
    end if;
  end if;
  if p_customer is not null then
    select * into c from public.customers where id = p_customer and org_id = p_org and deleted_at is null;
    if not found or not app.can_access_row(c.org_id, 'customers:read', c.owner_id, c.team_id) then
      raise exception 'not allowed' using errcode = '42501';
    end if;
    if p_opportunity is not null and o.customer_id <> p_customer then
      raise exception 'opportunity belongs to another customer' using errcode = '22023';
    end if;
  end if;

  -- Responsable: por defecto quien la crea; asignar a otra persona depende del alcance.
  v_asg := coalesce(p_assignee, v_uid);
  if v_asg <> v_uid then
    v_scope := app.permission_scope(p_org, 'tasks:create');
    select m.team_id into v_team from public.memberships m
     where m.org_id = p_org and m.user_id = v_asg and m.status = 'active';
    if v_scope is distinct from 'org'
       and not (v_scope = 'team' and v_team is not null and v_team = app.my_team_id(p_org)) then
      raise exception 'only managers can assign tasks to others' using errcode = '42501';
    end if;
  end if;

  insert into public.tasks (org_id, title, description, type, priority, due_at, assignee_id, customer_id, opportunity_id, created_by)
  values (p_org, p_title, nullif(btrim(coalesce(p_description, '')), ''), coalesce(p_type, 'follow_up'),
          coalesce(p_priority, 'normal'), p_due, v_asg, p_customer, p_opportunity, v_uid)
  returning id into v_id;

  perform app.emit_event(p_org, 'task.created', 'task', v_id,
    jsonb_build_object('title', left(btrim(p_title), 160), 'type', coalesce(p_type, 'follow_up'),
                       'due_at', p_due, 'assignee_id', v_asg),
    (select t.customer_id from public.tasks t where t.id = v_id));
  return v_id;
end $$;

create or replace function app.task_transition(p_id uuid, p_to text, p_text text) returns void
language plpgsql security definer set search_path = '' as $$
declare t public.tasks%rowtype;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into t from public.tasks where id = p_id for update;
  if not found or not app.can_access_row(t.org_id, 'tasks:update', t.assignee_id, t.team_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_to in ('done', 'cancelled') and t.status <> 'open' then
    raise exception 'task_not_open' using errcode = '23514';
  end if;
  if p_to = 'open' and t.status = 'open' then
    raise exception 'task_not_closed' using errcode = '23514';
  end if;

  perform set_config('app.task_transition', 'on', true);
  update public.tasks set
    status       = p_to,
    completed_at = case when p_to = 'done' then now() end,
    completed_by = case when p_to = 'done' then auth.uid() end,
    outcome      = case when p_to = 'open' then null else left(nullif(btrim(coalesce(p_text, '')), ''), 500) end
   where id = t.id;
  perform set_config('app.task_transition', 'off', true);

  perform app.emit_event(t.org_id, 'task.' || case p_to when 'done' then 'completed' when 'cancelled' then 'cancelled' else 'reopened' end,
    'task', t.id, jsonb_build_object('title', t.title, 'outcome', left(nullif(btrim(coalesce(p_text, '')), ''), 200)),
    t.customer_id);
end $$;

create or replace function public.complete_task(p_id uuid, p_outcome text default null) returns void
language sql security definer set search_path = '' as $$ select app.task_transition(p_id, 'done', p_outcome) $$;
create or replace function public.cancel_task(p_id uuid, p_reason text default null) returns void
language sql security definer set search_path = '' as $$ select app.task_transition(p_id, 'cancelled', p_reason) $$;
create or replace function public.reopen_task(p_id uuid) returns void
language sql security definer set search_path = '' as $$ select app.task_transition(p_id, 'open', null) $$;

-- ---------------------------------------------------------------------------
-- RPC de actividades
-- ---------------------------------------------------------------------------
create or replace function public.log_activity(
  p_customer uuid, p_type text, p_summary text, p_direction text default null,
  p_opportunity uuid default null, p_occurred_at timestamptz default null
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  c public.customers%rowtype;
  o public.opportunities%rowtype;
  v_id uuid;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into c from public.customers where id = p_customer and deleted_at is null;
  -- Registrar una interacción es escribir en el historial del cliente: exige poder actualizarlo.
  if not found or not app.can_access_row(c.org_id, 'customers:update', c.owner_id, c.team_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if btrim(coalesce(p_summary, '')) = '' then raise exception 'name_required' using errcode = '22023'; end if;
  if p_occurred_at is not null and (p_occurred_at > now() + interval '5 minutes' or p_occurred_at < now() - interval '1 year') then
    raise exception 'date out of range' using errcode = '22023';
  end if;
  if p_opportunity is not null then
    select * into o from public.opportunities where id = p_opportunity and org_id = c.org_id and customer_id = c.id;
    if not found or not app.can_access_row(o.org_id, 'opportunities:read', o.owner_id, o.team_id) then
      raise exception 'not allowed' using errcode = '42501';
    end if;
  end if;

  insert into public.activities (org_id, customer_id, opportunity_id, type, direction, summary, occurred_at, created_by)
  values (c.org_id, c.id, p_opportunity, p_type, p_direction, btrim(p_summary), coalesce(p_occurred_at, now()), auth.uid())
  returning id into v_id;

  perform app.emit_event(c.org_id, 'activity.logged', 'activity', v_id,
    jsonb_build_object('type', p_type, 'direction', p_direction, 'summary', left(btrim(p_summary), 140),
                       'opportunity_id', p_opportunity), c.id);
  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- Privilegios + RLS + auditoría
-- ---------------------------------------------------------------------------
revoke all on public.tasks, public.activities from anon, authenticated;
grant select on public.tasks, public.activities to authenticated;
grant update (title, description, type, priority, due_at, assignee_id) on public.tasks to authenticated;
grant all on public.tasks, public.activities to service_role;

alter table public.tasks      enable row level security;
alter table public.activities enable row level security;

create policy tasks_select on public.tasks for select to authenticated
  using ((select app.can_access_row(org_id, 'tasks:read', assignee_id, team_id)));
create policy tasks_update on public.tasks for update to authenticated
  using ((select app.can_access_row(org_id, 'tasks:update', assignee_id, team_id)))
  with check ((select app.permission_scope(org_id, 'tasks:update')) is not null);

-- Las actividades se ven con el mismo alcance que el cliente (RLS de customers aplica en el subquery).
create policy activities_select on public.activities for select to authenticated
  using (exists (select 1 from public.customers c where c.id = customer_id));

create trigger tasks_audit after insert or update or delete on public.tasks
  for each row execute function app.audit_row_change();
create trigger activities_audit after insert on public.activities
  for each row execute function app.audit_row_change();

revoke all on function app.activities_immutable(), app.tasks_prepare(), app.customers_after_update(),
  app.task_transition(uuid, text, text) from public, anon, authenticated;

revoke all on function public.create_task(uuid, text, text, timestamptz, text, text, uuid, uuid, uuid),
  public.complete_task(uuid, text), public.cancel_task(uuid, text), public.reopen_task(uuid),
  public.log_activity(uuid, text, text, text, uuid, timestamptz), public.merge_customers(uuid, uuid)
  from public, anon;
grant execute on function public.create_task(uuid, text, text, timestamptz, text, text, uuid, uuid, uuid),
  public.complete_task(uuid, text), public.cancel_task(uuid, text), public.reopen_task(uuid),
  public.log_activity(uuid, text, text, text, uuid, timestamptz), public.merge_customers(uuid, uuid)
  to authenticated, service_role;

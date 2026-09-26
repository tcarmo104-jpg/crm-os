-- =============================================================================
-- 0025 SECUENCIAS DE SEGUIMIENTO
-- =============================================================================
-- Los permisos `sequences:read` / `sequences:manage` ya existían desde la Fase 1 (0001), asignados a los
-- roles correctos (manager y marketing pueden crear secuencias; sales_manager y sales_agent solo verlas).
-- Esta migración solo agrega la funcionalidad que faltaba, respetando ese diseño ya decidido.
--
-- Una secuencia es una plantilla de pasos («Día 0: llamar», «Día 2: WhatsApp»…). Inscribir a un cliente
-- crea la tarea del primer paso. Este CRM no tiene tareas en segundo plano (nada de cron): en vez de un
-- programador, cada paso se dispara solo cuando se completa el paso anterior, reutilizando el mismo
-- mecanismo que ya completa cualquier tarea (`app.task_transition`). Cero infraestructura nueva.
-- =============================================================================

create table public.sequences (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  name        text not null check (char_length(btrim(name)) between 1 and 120),
  description text check (char_length(description) <= 2000),
  is_active   boolean not null default true,
  created_by  uuid not null references auth.users(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table public.sequence_steps (
  id           uuid primary key default gen_random_uuid(),
  sequence_id  uuid not null references public.sequences(id) on delete cascade,
  position     int not null check (position >= 1),
  offset_days  int not null default 0 check (offset_days between 0 and 365),
  type         text not null check (type in ('call', 'whatsapp', 'email', 'meeting', 'visit', 'follow_up', 'other')),
  title        text not null check (char_length(btrim(title)) between 1 and 160),
  description  text check (char_length(description) <= 2000),
  priority     text not null default 'normal' check (priority in ('low', 'normal', 'high')),
  unique (sequence_id, position)
);

create table public.sequence_enrollments (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.organizations(id) on delete cascade,
  sequence_id      uuid not null references public.sequences(id),
  customer_id      uuid not null references public.customers(id) on delete cascade,
  opportunity_id   uuid references public.opportunities(id) on delete set null,
  status           text not null default 'active' check (status in ('active', 'paused', 'completed', 'cancelled')),
  current_step     int not null default 1,
  current_task_id  uuid references public.tasks(id) on delete set null,
  assignee_id      uuid references auth.users(id),
  enrolled_by      uuid not null references auth.users(id),
  enrolled_at      timestamptz not null default now(),
  finished_at      timestamptz
);
-- Un mismo cliente no puede tener dos veces la misma secuencia activa a la vez (evita tareas duplicadas).
create unique index sequence_enrollments_active_uniq on public.sequence_enrollments (customer_id, sequence_id) where (status = 'active');
create index sequence_enrollments_customer_idx on public.sequence_enrollments (customer_id);
create index sequence_enrollments_task_idx on public.sequence_enrollments (current_task_id) where current_task_id is not null;

-- Si dos clientes se fusionan, sus inscripciones de secuencia deben seguir al cliente que sobrevive.
insert into app.customer_merge_targets values ('sequence_enrollments');

alter table public.sequences enable row level security;
alter table public.sequence_steps enable row level security;
alter table public.sequence_enrollments enable row level security;

-- Como con cualquier tabla nueva: Supabase otorga privilegios amplios a `anon`/`authenticated` por defecto;
-- aquí se retiran y solo queda la LECTURA para `authenticated` (filtrada por RLS). Toda escritura pasa por
-- las funciones de abajo (security definer), nunca por INSERT/UPDATE directo desde el cliente.
revoke all on public.sequences, public.sequence_steps, public.sequence_enrollments from anon, authenticated;
grant select on public.sequences, public.sequence_steps, public.sequence_enrollments to authenticated;
grant all on public.sequences, public.sequence_steps, public.sequence_enrollments to service_role;

-- Plantillas: catálogo de organización, igual que «productos» (una sola regla, sin distinguir propietario).
create policy sequences_select on public.sequences for select to authenticated
  using ((select app.has_permission(org_id, 'sequences:read')));
create policy sequences_insert on public.sequences for insert to authenticated
  with check ((select app.has_permission(org_id, 'sequences:manage')));
create policy sequences_update on public.sequences for update to authenticated
  using ((select app.has_permission(org_id, 'sequences:manage')))
  with check ((select app.has_permission(org_id, 'sequences:manage')));

create policy sequence_steps_select on public.sequence_steps for select to authenticated
  using (exists (select 1 from public.sequences s where s.id = sequence_id and app.has_permission(s.org_id, 'sequences:read')));
create policy sequence_steps_write on public.sequence_steps for all to authenticated
  using (exists (select 1 from public.sequences s where s.id = sequence_id and app.has_permission(s.org_id, 'sequences:manage')))
  with check (exists (select 1 from public.sequences s where s.id = sequence_id and app.has_permission(s.org_id, 'sequences:manage')));

-- Inscripciones: atadas a un cliente. Quien puede ver ese cliente (las reglas de «customers» ya lo filtran
-- por propietario/equipo/organización) puede ver su inscripción — igual que ya hacen las actividades.
create policy sequence_enrollments_select on public.sequence_enrollments for select to authenticated
  using (exists (select 1 from public.customers c where c.id = customer_id));

create or replace function app.sequences_touch() returns trigger
language plpgsql set search_path = '' as $$ begin new.updated_at := now(); return new; end $$;
create trigger sequences_touch before update on public.sequences for each row execute function app.sequences_touch();

-- =============================================================================
-- Plantillas: crear / archivar / pasos
-- =============================================================================
create or replace function public.create_sequence(p_org uuid, p_name text, p_description text, p_steps jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); v_id uuid; v_step jsonb; v_pos int := 0;
begin
  if v_uid is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not app.has_permission(p_org, 'sequences:manage') then raise exception 'not allowed' using errcode = '42501'; end if;
  if btrim(coalesce(p_name, '')) = '' then raise exception 'name_required' using errcode = '22023'; end if;
  if jsonb_array_length(coalesce(p_steps, '[]'::jsonb)) = 0 then raise exception 'at_least_one_step_required' using errcode = '22023'; end if;

  insert into public.sequences (org_id, name, description, created_by) values (p_org, btrim(p_name), nullif(btrim(coalesce(p_description, '')), ''), v_uid)
  returning id into v_id;

  for v_step in select * from jsonb_array_elements(p_steps) loop
    v_pos := v_pos + 1;
    insert into public.sequence_steps (sequence_id, position, offset_days, type, title, description, priority)
    values (v_id, v_pos, coalesce((v_step ->> 'offsetDays')::int, 0), coalesce(v_step ->> 'type', 'follow_up'),
            v_step ->> 'title', nullif(btrim(coalesce(v_step ->> 'description', '')), ''), coalesce(v_step ->> 'priority', 'normal'));
  end loop;
  return v_id;
end $$;

create or replace function public.archive_sequence(p_id uuid, p_active boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare s public.sequences%rowtype;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into s from public.sequences where id = p_id;
  if not found or not app.has_permission(s.org_id, 'sequences:manage') then raise exception 'not allowed' using errcode = '42501'; end if;
  update public.sequences set is_active = p_active where id = p_id;
end $$;

-- =============================================================================
-- Inscripciones: inscribir / pausar / reanudar / cancelar
-- =============================================================================
create or replace function public.enroll_in_sequence(p_sequence uuid, p_customer uuid, p_opportunity uuid, p_assignee uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); s public.sequences%rowtype; c public.customers%rowtype; first_step public.sequence_steps%rowtype; v_enroll uuid; v_task uuid;
begin
  if v_uid is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into s from public.sequences where id = p_sequence;
  if not found or not app.has_permission(s.org_id, 'sequences:read') or not s.is_active then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into c from public.customers where id = p_customer and org_id = s.org_id;
  if not found or not app.can_access_row(c.org_id, 'customers:update', c.owner_id, c.team_id) then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into first_step from public.sequence_steps where sequence_id = p_sequence order by position limit 1;
  if not found then raise exception 'sequence_has_no_steps' using errcode = '22023'; end if;

  v_task := public.create_task(s.org_id, first_step.title, first_step.type, now() + make_interval(days => first_step.offset_days),
    first_step.priority, first_step.description, p_customer, p_opportunity, coalesce(p_assignee, c.owner_id));

  insert into public.sequence_enrollments (org_id, sequence_id, customer_id, opportunity_id, current_step, current_task_id, assignee_id, enrolled_by)
  values (s.org_id, p_sequence, p_customer, p_opportunity, 1, v_task, coalesce(p_assignee, c.owner_id), v_uid)
  returning id into v_enroll;

  perform app.emit_event(s.org_id, 'sequence.enrolled', 'sequence_enrollment', v_enroll, jsonb_build_object('sequence', s.name), p_customer);
  return v_enroll;
exception when unique_violation then
  raise exception 'already_enrolled' using errcode = '23505';
end $$;

create or replace function app.sequence_enrollment_actor_ok(p_id uuid, out e public.sequence_enrollments) returns public.sequence_enrollments
language plpgsql security definer set search_path = '' as $$
declare c public.customers%rowtype;
begin
  select * into e from public.sequence_enrollments where id = p_id for update;
  if not found then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into c from public.customers where id = e.customer_id;
  if not found or not app.can_access_row(c.org_id, 'customers:update', c.owner_id, c.team_id) then raise exception 'not allowed' using errcode = '42501'; end if;
end $$;

create or replace function public.pause_enrollment(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare e public.sequence_enrollments; begin
  e := app.sequence_enrollment_actor_ok(p_id);
  if e.status <> 'active' then raise exception 'enrollment_not_active' using errcode = '23514'; end if;
  update public.sequence_enrollments set status = 'paused' where id = p_id;
end $$;

create or replace function public.resume_enrollment(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare e public.sequence_enrollments; begin
  e := app.sequence_enrollment_actor_ok(p_id);
  if e.status <> 'paused' then raise exception 'enrollment_not_paused' using errcode = '23514'; end if;
  update public.sequence_enrollments set status = 'active' where id = p_id;
end $$;

create or replace function public.cancel_enrollment(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare e public.sequence_enrollments; begin
  e := app.sequence_enrollment_actor_ok(p_id);
  if e.status in ('completed', 'cancelled') then raise exception 'enrollment_already_finished' using errcode = '23514'; end if;
  update public.sequence_enrollments set status = 'cancelled', finished_at = now() where id = p_id;
end $$;

-- =============================================================================
-- El corazón sin cron: completar (o cancelar) la tarea del paso actual avanza la inscripción sola.
-- =============================================================================
create or replace function app.advance_sequence_on_task(p_task_id uuid, p_outcome text) returns void
language plpgsql security definer set search_path = '' as $$
declare e public.sequence_enrollments%rowtype; nxt public.sequence_steps%rowtype; v_task uuid; c public.customers%rowtype;
begin
  select * into e from public.sequence_enrollments where current_task_id = p_task_id and status = 'active' for update;
  if not found then return; end if;

  if p_outcome = 'cancelled' then
    update public.sequence_enrollments set status = 'cancelled', finished_at = now() where id = e.id;
    return;
  end if;

  select * into nxt from public.sequence_steps where sequence_id = e.sequence_id and position = e.current_step + 1;
  if not found then
    update public.sequence_enrollments set status = 'completed', finished_at = now(), current_task_id = null where id = e.id;
    perform app.emit_event(e.org_id, 'sequence.completed', 'sequence_enrollment', e.id, '{}'::jsonb, e.customer_id);
    return;
  end if;

  select * into c from public.customers where id = e.customer_id;
  v_task := public.create_task(e.org_id, nxt.title, nxt.type, now() + make_interval(days => nxt.offset_days),
    nxt.priority, nxt.description, e.customer_id, e.opportunity_id, coalesce(e.assignee_id, c.owner_id));
  update public.sequence_enrollments set current_step = nxt.position, current_task_id = v_task where id = e.id;
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
  if p_to = 'in_progress' and t.status <> 'open' then
    raise exception 'task_not_open' using errcode = '23514';
  end if;
  if p_to in ('done', 'cancelled') and t.status not in ('open', 'in_progress') then
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
    outcome      = case when p_to = 'in_progress' then t.outcome when p_to = 'open' then null else left(nullif(btrim(coalesce(p_text, '')), ''), 500) end
   where id = t.id;
  perform set_config('app.task_transition', 'off', true);

  if p_to in ('done', 'cancelled') then perform app.advance_sequence_on_task(t.id, p_to); end if;

  perform app.emit_event(t.org_id,
    'task.' || case p_to when 'done' then 'completed' when 'cancelled' then 'cancelled' when 'in_progress' then 'started' else 'reopened' end,
    'task', t.id, jsonb_build_object('title', t.title, 'outcome', left(nullif(btrim(coalesce(p_text, '')), ''), 200)),
    t.customer_id);
end $$;

-- =============================================================================
-- Fusión de clientes: si los dos clientes tienen la MISMA secuencia activa a la vez, no pueden seguir
-- compitiendo por una sola. Se redefine `merge_customers` completa (igual que el resto del código ya
-- hace con funciones de migraciones anteriores) solo para sumar ese paso, antes del bucle genérico.
-- =============================================================================
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
  -- Nuevo: la secuencia activa del cliente absorbido se cancela si el que sobrevive ya tiene esa MISMA
  -- secuencia activa (su tarea queda igual, ya no atada a la secuencia). Antes del bucle genérico, para
  -- que no choque con el índice único al mover customer_id.
  update public.sequence_enrollments e set status = 'cancelled', finished_at = now()
   where e.customer_id = d.id and e.status = 'active'
     and exists (select 1 from public.sequence_enrollments k2 where k2.customer_id = k.id and k2.sequence_id = e.sequence_id and k2.status = 'active');
  -- Toda tabla con customer_id está en el registro (una prueba estructural lo exige).
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

revoke all on function public.create_sequence(uuid, text, text, jsonb) from public, anon;
revoke all on function public.archive_sequence(uuid, boolean) from public, anon;
revoke all on function public.enroll_in_sequence(uuid, uuid, uuid, uuid) from public, anon;
revoke all on function public.pause_enrollment(uuid) from public, anon;
revoke all on function public.resume_enrollment(uuid) from public, anon;
revoke all on function public.cancel_enrollment(uuid) from public, anon;
grant execute on function public.create_sequence(uuid, text, text, jsonb) to authenticated, service_role;
grant execute on function public.archive_sequence(uuid, boolean) to authenticated, service_role;
grant execute on function public.enroll_in_sequence(uuid, uuid, uuid, uuid) to authenticated, service_role;
grant execute on function public.pause_enrollment(uuid) to authenticated, service_role;
grant execute on function public.resume_enrollment(uuid) to authenticated, service_role;
grant execute on function public.cancel_enrollment(uuid) to authenticated, service_role;

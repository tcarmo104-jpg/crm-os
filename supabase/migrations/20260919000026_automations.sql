-- =============================================================================
-- 0026 AUTOMATIZACIONES
-- =============================================================================
-- Los permisos `automations:read` / `automations:manage` ya existían desde la Fase 1 (0001), sin usar.
--
-- Diseño: NO es el «grafo con esperas» que describía la arquitectura original — este CRM no tiene tareas
-- en segundo plano propias (sin pg_cron). En cambio, ya existe un despachador de eventos construido para
-- entornos serverless (`app.claim_events` / `/api/cron/dispatch-events`), pensado para que un programador
-- EXTERNO (Vercel Cron) lo llame cada pocos minutos. Hoy nadie lo llama en producción: esta migración lo
-- aprovecha en vez de inventar algo nuevo.
--
-- Una regla es «cuando ocurre X (un evento que el sistema YA emite) y se cumplen unas condiciones simples,
-- entonces ejecuta estas acciones». Las acciones se ejecutan CON LA IDENTIDAD DE QUIEN CREÓ LA REGLA (se
-- simula su sesión por la duración de la llamada), así se reutilizan tal cual las funciones que ya existen
-- y ya están probadas (crear tarea, etiquetar, reasignar responsable, inscribir en una secuencia) — nada
-- de lógica de negocio duplicada, y los mismos límites de permisos de esa persona aplican.
-- =============================================================================

create table public.automation_rules (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  name        text not null check (char_length(btrim(name)) between 1 and 120),
  trigger     text not null check (trigger in ('lead.created', 'opportunity.won', 'opportunity.lost', 'opportunity.stage_changed', 'activity.logged', 'task.completed')),
  conditions  jsonb not null default '[]'::jsonb,
  actions     jsonb not null,
  is_active   boolean not null default true,
  created_by  uuid not null references auth.users(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint automation_rules_actions_not_empty check (jsonb_array_length(actions) >= 1)
);

create table public.automation_runs (
  id        uuid primary key default gen_random_uuid(),
  rule_id   uuid not null references public.automation_rules(id) on delete cascade,
  event_id  uuid not null references public.domain_events(id) on delete cascade,
  status    text not null check (status in ('ok', 'skipped', 'failed')),
  detail    text,
  ran_at    timestamptz not null default now(),
  -- Un mismo evento nunca dispara la misma regla dos veces: si el despachador reintenta, esto lo detiene.
  unique (rule_id, event_id)
);
create index automation_rules_trigger_idx on public.automation_rules (org_id, trigger) where is_active;
create index automation_runs_rule_idx on public.automation_runs (rule_id, ran_at desc);

alter table public.automation_rules enable row level security;
alter table public.automation_runs enable row level security;

revoke all on public.automation_rules, public.automation_runs from anon, authenticated;
grant select on public.automation_rules, public.automation_runs to authenticated;
grant all on public.automation_rules, public.automation_runs to service_role;

-- Igual que «secuencias»: catálogo de organización con una sola regla, sin distinguir propietario.
create policy automation_rules_select on public.automation_rules for select to authenticated
  using ((select app.has_permission(org_id, 'automations:read')));
create policy automation_runs_select on public.automation_runs for select to authenticated
  using (exists (select 1 from public.automation_rules r where r.id = rule_id and app.has_permission(r.org_id, 'automations:read')));

create or replace function app.automation_rules_touch() returns trigger
language plpgsql set search_path = '' as $$ begin new.updated_at := now(); return new; end $$;
create trigger automation_rules_touch before update on public.automation_rules for each row execute function app.automation_rules_touch();

-- =============================================================================
-- CRUD de reglas (para la pantalla de Automatizaciones)
-- =============================================================================
create or replace function public.create_automation_rule(p_org uuid, p_name text, p_trigger text, p_conditions jsonb, p_actions jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); v_id uuid;
begin
  if v_uid is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not app.has_permission(p_org, 'automations:manage') then raise exception 'not allowed' using errcode = '42501'; end if;
  if btrim(coalesce(p_name, '')) = '' then raise exception 'name_required' using errcode = '22023'; end if;
  if jsonb_array_length(coalesce(p_actions, '[]'::jsonb)) = 0 then raise exception 'at_least_one_action_required' using errcode = '22023'; end if;

  insert into public.automation_rules (org_id, name, trigger, conditions, actions, created_by)
  values (p_org, btrim(p_name), p_trigger, coalesce(p_conditions, '[]'::jsonb), p_actions, v_uid)
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.set_automation_active(p_id uuid, p_active boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.automation_rules%rowtype;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into r from public.automation_rules where id = p_id;
  if not found or not app.has_permission(r.org_id, 'automations:manage') then raise exception 'not allowed' using errcode = '42501'; end if;
  update public.automation_rules set is_active = p_active where id = p_id;
end $$;

-- =============================================================================
-- Ejecución: la llama el despachador (service_role), nunca una persona.
-- =============================================================================
create or replace function app.evaluate_condition(p_event jsonb, p_field text, p_op text, p_value text) returns boolean
language plpgsql immutable set search_path = '' as $$
declare v_actual text := p_event ->> p_field; v_num_actual numeric; v_num_value numeric;
begin
  if p_op = 'eq' then return v_actual = p_value;
  elsif p_op = 'ne' then return v_actual is distinct from p_value;
  elsif p_op in ('gt', 'gte', 'lt', 'lte') then
    begin v_num_actual := v_actual::numeric; v_num_value := p_value::numeric; exception when others then return false; end;
    if v_num_actual is null then return false; end if;
    return case p_op when 'gt' then v_num_actual > v_num_value when 'gte' then v_num_actual >= v_num_value
                      when 'lt' then v_num_actual < v_num_value else v_num_actual <= v_num_value end;
  else return false;
  end if;
end $$;

create or replace function app.run_automation_rule(p_rule_id uuid, p_event_id uuid, p_event jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  r public.automation_rules%rowtype; cond jsonb; act jsonb; v_matches boolean := true;
  v_status text; v_detail text; v_run_id uuid; v_customer uuid := nullif(p_event ->> 'customer_id', '')::uuid;
  v_entity uuid := nullif(p_event ->> 'entity_id', '')::uuid; v_entity_type text := p_event ->> 'entity_type';
  v_task uuid; v_prev_claims text;
begin
  select * into r from public.automation_rules where id = p_rule_id;
  if not found then return jsonb_build_object('status', 'skipped', 'detail', 'rule_not_found'); end if;

  if not r.is_active then
    insert into public.automation_runs (rule_id, event_id, status, detail) values (r.id, p_event_id, 'skipped', 'regla inactiva')
      on conflict (rule_id, event_id) do nothing;
    return jsonb_build_object('status', 'skipped', 'detail', 'inactive');
  end if;

  for cond in select * from jsonb_array_elements(coalesce(r.conditions, '[]'::jsonb)) loop
    if not app.evaluate_condition(p_event -> 'payload', cond ->> 'field', cond ->> 'op', cond ->> 'value') then
      v_matches := false; exit;
    end if;
  end loop;

  if not v_matches then
    insert into public.automation_runs (rule_id, event_id, status, detail) values (r.id, p_event_id, 'skipped', 'condiciones no cumplidas')
      on conflict (rule_id, event_id) do nothing;
    return jsonb_build_object('status', 'skipped', 'detail', 'conditions_not_met');
  end if;

  -- Reserva el turno YA (antes de actuar): si el despachador reintenta este evento, la siguiente
  -- llamada choca con la restricción única y no vuelve a ejecutar las acciones.
  insert into public.automation_runs (rule_id, event_id, status, detail) values (r.id, p_event_id, 'ok', null)
    on conflict (rule_id, event_id) do nothing returning id into v_run_id;
  if v_run_id is null then return jsonb_build_object('status', 'skipped', 'detail', 'already_ran'); end if;

  -- Actuar «como» quien creó la regla: así se reutilizan las funciones ya existentes, con SUS permisos.
  v_prev_claims := current_setting('request.jwt.claims', true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', r.created_by, 'role', 'authenticated')::text, true);
  begin
    for act in select * from jsonb_array_elements(r.actions) loop
      if act ->> 'type' = 'create_task' and v_customer is not null then
        perform public.create_task(r.org_id, act ->> 'title', coalesce(act ->> 'taskType', 'follow_up'),
          now() + make_interval(days => coalesce((act ->> 'offsetDays')::int, 0)), coalesce(act ->> 'priority', 'normal'),
          null, v_customer, case when v_entity_type = 'opportunity' then v_entity end, nullif(act ->> 'assigneeId', '')::uuid);
      elsif act ->> 'type' = 'add_tag' and v_customer is not null then
        perform public.add_customer_tag(v_customer, act ->> 'name', nullif(act ->> 'color', ''));
      elsif act ->> 'type' = 'assign_owner' and v_customer is not null and (act ->> 'ownerId') is not null then
        update public.customers set owner_id = (act ->> 'ownerId')::uuid where id = v_customer and org_id = r.org_id;
      elsif act ->> 'type' = 'enroll_sequence' and v_customer is not null then
        perform public.enroll_in_sequence((act ->> 'sequenceId')::uuid, v_customer,
          case when v_entity_type = 'opportunity' then v_entity end, nullif(act ->> 'assigneeId', '')::uuid);
      end if;
    end loop;
    v_status := 'ok'; v_detail := null;
  exception when others then
    v_status := 'failed'; v_detail := left(sqlerrm, 500);
  end;
  if v_prev_claims is null then perform set_config('request.jwt.claims', '', true); else perform set_config('request.jwt.claims', v_prev_claims, true); end if;

  update public.automation_runs set status = v_status, detail = v_detail where id = v_run_id;
  return jsonb_build_object('status', v_status, 'detail', v_detail);
end $$;

revoke all on function public.create_automation_rule(uuid, text, text, jsonb, jsonb), public.set_automation_active(uuid, boolean)
  from public, anon;
grant execute on function public.create_automation_rule(uuid, text, text, jsonb, jsonb), public.set_automation_active(uuid, boolean)
  to authenticated, service_role;
revoke all on function app.run_automation_rule(uuid, uuid, jsonb), app.evaluate_condition(jsonb, text, text, text) from public, anon, authenticated;

-- Envoltorio en «public», como worker_claim_events: es lo que el despachador puede llamar por la API REST
-- (supabase-js solo expone funciones del esquema public). La lógica real vive en `app`.
create or replace function public.run_automation_rule(p_rule_id uuid, p_event_id uuid, p_event jsonb) returns jsonb
language sql security definer set search_path = '' as $$ select app.run_automation_rule(p_rule_id, p_event_id, p_event) $$;
revoke all on function public.run_automation_rule(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.run_automation_rule(uuid, uuid, jsonb) to service_role;

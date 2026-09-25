-- =============================================================================
-- 0023 MEJORA DE TAREAS Y ACTIVIDADES
-- =============================================================================
--   * Tareas: nuevo estado intermedio «en progreso» (open → in_progress → done/cancelled), y nuevo
--     tipo «visit» (visita). «Vencida» sigue siendo una condición visual (fecha pasada + abierta),
--     no un estado guardado: así una tarea vencida que se retoma no necesita "desvencerse" a mano.
--   * Actividades: mismo tipo «visit», para que un tipo de interacción se llame igual en los dos módulos.
--   * Todo aditivo: ninguna fila existente cambia de estado ni de tipo.
-- =============================================================================

alter table public.tasks drop constraint tasks_status_check;
alter table public.tasks add constraint tasks_status_check check (status in ('open', 'in_progress', 'done', 'cancelled'));
alter table public.tasks drop constraint tasks_type_check;
alter table public.tasks add constraint tasks_type_check check (type in ('call', 'whatsapp', 'email', 'meeting', 'visit', 'follow_up', 'other'));
alter table public.activities drop constraint activities_type_check;
alter table public.activities add constraint activities_type_check check (type in ('call', 'whatsapp', 'email', 'meeting', 'visit', 'note'));

-- Una visita, como una reunión o una nota, no tiene «entrante/saliente» claro: no exige dirección.
alter table public.activities drop constraint activities_check;
alter table public.activities add constraint activities_check check (type in ('note', 'meeting', 'visit') or direction is not null);

-- «en progreso» y «done/cancelled» ahora aceptan también partir de «en progreso».
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

  perform app.emit_event(t.org_id,
    'task.' || case p_to when 'done' then 'completed' when 'cancelled' then 'cancelled' when 'in_progress' then 'started' else 'reopened' end,
    'task', t.id, jsonb_build_object('title', t.title, 'outcome', left(nullif(btrim(coalesce(p_text, '')), ''), 200)),
    t.customer_id);
end $$;

create or replace function public.start_task(p_id uuid) returns void
language sql security definer set search_path = '' as $$ select app.task_transition(p_id, 'in_progress', null) $$;

revoke all on function public.start_task(uuid) from public, anon;
grant execute on function public.start_task(uuid) to authenticated, service_role;

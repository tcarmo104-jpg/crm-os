-- =============================================================================
-- CRM OS · ACTUALIZACIÓN: migraciones 0023 en adelante (para un proyecto que YA tiene 0001 a 0022)
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
  if to_regclass('public.tasks') is null and 23 > 10 then
    raise exception 'FALTAN las migraciones de la Fase 3 (0009 y 0010). Avísame para darte el archivo correcto.';
  end if;
  if to_regclass('public.tags') is null then
    raise exception 'FALTA la migración 0014 (Inbox de tres paneles). Instala primero setup-desde-0014.sql o avísame.';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'opportunities' and column_name = 'number') then
    raise exception 'FALTA la migración 0015 (Oportunidades). Instala primero setup-desde-0015.sql o avísame.';
  end if;
  if to_regclass('public.oauth_sessions') is null then
    raise exception 'FALTA la migración 0017 (Facebook, Instagram y Gmail). Instala primero setup-desde-0016.sql o avísame.';
  end if;
  if to_regclass('public.message_attachments') is null then
    raise exception 'FALTA la migración 0018 (Multimedia del Inbox). Instala primero setup-desde-0018.sql o avísame.';
  end if;
  if to_regclass('public.attachment_uploads') is null then
    raise exception 'FALTA la migración 0019 (Envío de archivos). Instala primero setup-desde-0019.sql o avísame.';
  end if;
  if to_regprocedure('public.start_task(uuid)') is not null then
    raise exception 'Este proyecto YA tiene instalada la migración 0023 (existe la función start_task). No ejecutes este archivo: avísame.';
  end if;
end $$;

-- ---------------- 20260919000023_tasks_activities_upgrade.sql ----------------
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


-- ---------------- 20260919000024_leads_manual_create.sql ----------------
-- =============================================================================
-- 0024 CREAR UN LEAD A MANO
-- =============================================================================
-- Hoy un lead solo se crea por importación CSV o por la API pública, ambas apoyadas en
-- `app.ingest_lead_core` (resolución de identidad + inserción). Esta migración solo agrega
-- una puerta de entrada individual a esa MISMA función: nada de lógica nueva de identidad,
-- deduplicación o creación. `import_leads` seguía sirviendo para el CSV; para uno solo hacía
-- falta lo mismo pero devolviendo el id del lead y del cliente (para poder abrir la ficha),
-- cosa que `import_leads` no hace porque procesa en lote y descarta esos ids.
-- =============================================================================
create or replace function public.create_lead(p_org uuid, p_row jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); v_owner uuid;
begin
  if v_uid is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not app.has_permission(p_org, 'leads:create') then raise exception 'not allowed' using errcode = '42501'; end if;
  if btrim(coalesce(p_row ->> 'name', '')) = '' then raise exception 'name_required' using errcode = '22023'; end if;
  if btrim(coalesce(p_row ->> 'source', '')) = '' then raise exception 'source_required' using errcode = '22023'; end if;
  -- Igual que al importar: quien no ve toda la cartera queda como propietario (para poder ver lo que crea).
  if app.permission_scope(p_org, 'customers:read') is distinct from 'org' then v_owner := v_uid; end if;
  return app.ingest_lead_core(p_org, p_row, v_owner, v_uid);
end $$;

revoke all on function public.create_lead(uuid, jsonb) from public, anon;
grant execute on function public.create_lead(uuid, jsonb) to authenticated, service_role;

commit;

-- Comprobación final: 'tablas' y 'tablas_con_rls' deben ser iguales.
select 'LISTO' as estado,
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r') as tablas,
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity) as tablas_con_rls,
  (select count(*) from public.permissions) as permisos,
  (select count(*) from public.roles where org_id is null) as roles_base;

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

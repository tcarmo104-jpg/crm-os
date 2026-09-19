-- =============================================================================
-- 0004 VISIBILIDAD DE CLIENTES
-- =============================================================================
-- Regla de negocio:
--   * super_admin, admin y manager  -> ven TODOS los clientes (alcance org)
--   * sales_manager                 -> los clientes de su equipo (alcance team)
--   * sales_agent                   -> solo SUS clientes (alcance own)
--   * marketing, customer_service, analyst, viewer -> alcance own: solo los
--     clientes que se les asignen explícitamente (no ven la base completa).
-- Cambia únicamente datos de la matriz de permisos; es reversible.
-- =============================================================================
update public.role_permissions rp
   set scope = 'own'
  from public.roles r
 where r.id = rp.role_id
   and r.org_id is null
   and r.key in ('marketing', 'customer_service', 'analyst', 'viewer')
   and rp.permission_key like 'customers:%'
   and rp.scope = 'org';

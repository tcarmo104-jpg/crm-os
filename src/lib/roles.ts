/** Catálogo de permisos del CRM: 9 módulos con lectura/creación/edición/eliminación, más un puñado de
 * permisos especiales de configuración. Coincide exactamente con lo sembrado en la base de datos desde
 * la Fase 1 — no se inventa ni se omite ninguno. */
export const CRUD_MODULES = ['customers', 'leads', 'opportunities', 'quotes', 'sales', 'conversations', 'tasks', 'cases', 'products'] as const;
export const CRUD_ACTIONS = ['read', 'create', 'update', 'delete'] as const;
export const MODULE_LABEL: Record<(typeof CRUD_MODULES)[number], string> = {
  customers: 'Clientes', leads: 'Leads', opportunities: 'Oportunidades', quotes: 'Cotizaciones', sales: 'Ventas',
  conversations: 'Conversaciones', tasks: 'Tareas', cases: 'Casos de postventa', products: 'Productos y servicios',
};
export const ACTION_LABEL: Record<(typeof CRUD_ACTIONS)[number], string> = { read: 'Ver', create: 'Crear', update: 'Editar', delete: 'Eliminar' };

export const SPECIAL_PERMISSIONS = [
  'users:manage', 'teams:manage', 'roles:manage', 'settings:manage', 'integrations:manage', 'pipelines:manage',
  'fields:manage', 'sequences:read', 'sequences:manage', 'automations:read', 'automations:manage',
  'reports:read', 'reports:export', 'audit:read',
] as const;
export const SPECIAL_PERMISSION_LABEL: Record<(typeof SPECIAL_PERMISSIONS)[number], string> = {
  'users:manage': 'Gestionar miembros y sus roles', 'teams:manage': 'Gestionar equipos', 'roles:manage': 'Gestionar roles personalizados',
  'settings:manage': 'Configuración de la organización', 'integrations:manage': 'Gestionar integraciones y llaves API',
  'pipelines:manage': 'Configurar pipelines y etapas', 'fields:manage': 'Gestionar campos personalizados',
  'sequences:read': 'Ver secuencias', 'sequences:manage': 'Crear y editar secuencias',
  'automations:read': 'Ver automatizaciones', 'automations:manage': 'Crear y editar automatizaciones',
  'reports:read': 'Ver reportes y dashboards', 'reports:export': 'Exportar reportes', 'audit:read': 'Consultar la auditoría',
};

export const PERMISSION_SCOPES = ['own', 'team', 'org'] as const;
export type PermissionScope = (typeof PERMISSION_SCOPES)[number];
export const SCOPE_LABEL: Record<PermissionScope, string> = { own: 'Lo propio', team: 'Su equipo', org: 'Toda la organización' };

export interface RolePermission { key: string; scope: PermissionScope }

/** ¿Este texto sirve como clave técnica de un rol? Solo minúsculas y guiones bajos, como los roles de sistema. */
export function isValidRoleKey(key: string): boolean {
  return /^[a-z_]+$/.test(key) && key.length >= 2 && key.length <= 40;
}
/** Sugiere una clave a partir del nombre escrito («Vendedor Junior» → «vendedor_junior»). */
export function slugifyRoleKey(name: string): string {
  return name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
}

import type { ServerSupabase } from '@/lib/supabase/server';
import { unwrap } from '@/lib/errors';
import type { PermissionScope, RolePermission } from '@/lib/roles';

export interface RoleWithPermissions { id: string; key: string; name: string; description: string | null; isSystem: boolean; permissions: RolePermission[] }

/** Todos los roles visibles para la organización: los de sistema (siempre iguales) y los propios. */
export async function listAllRoles(db: ServerSupabase, orgId: string): Promise<RoleWithPermissions[]> {
  const rows = unwrap(
    await db.from('roles').select('id, key, name, description, org_id, role_permissions(permission_key, scope)').or(`org_id.is.null,org_id.eq.${orgId}`).order('org_id', { ascending: true }).order('name'),
  ) as unknown as { id: string; key: string; name: string; description: string | null; org_id: string | null; role_permissions: { permission_key: string; scope: PermissionScope }[] }[];
  return rows.map((r) => ({
    id: r.id, key: r.key, name: r.name, description: r.description, isSystem: r.org_id === null,
    permissions: r.role_permissions.map((p) => ({ key: p.permission_key, scope: p.scope })),
  }));
}
export async function getCustomRole(db: ServerSupabase, id: string): Promise<RoleWithPermissions | null> {
  const rows = unwrap(
    await db.from('roles').select('id, key, name, description, org_id, role_permissions(permission_key, scope)').eq('id', id).limit(1),
  ) as unknown as { id: string; key: string; name: string; description: string | null; org_id: string | null; role_permissions: { permission_key: string; scope: PermissionScope }[] }[];
  const r = rows[0];
  if (!r) return null;
  return { id: r.id, key: r.key, name: r.name, description: r.description, isSystem: r.org_id === null, permissions: r.role_permissions.map((p) => ({ key: p.permission_key, scope: p.scope })) };
}

export const createCustomRole = async (db: ServerSupabase, orgId: string, key: string, name: string, description: string | undefined, permissions: RolePermission[]) =>
  unwrap(await db.rpc('create_custom_role', { p_org: orgId, p_key: key, p_name: name, p_description: description ?? null, p_permissions: permissions })) as unknown as string;
export const renameCustomRole = async (db: ServerSupabase, id: string, name: string, description: string | undefined) => { unwrap(await db.rpc('rename_custom_role', { p_role_id: id, p_name: name, p_description: description ?? null })); };
export const setCustomRolePermissions = async (db: ServerSupabase, id: string, permissions: RolePermission[]) => { unwrap(await db.rpc('set_custom_role_permissions', { p_role_id: id, p_permissions: permissions })); };
export const deleteCustomRole = async (db: ServerSupabase, id: string) => { unwrap(await db.rpc('delete_custom_role', { p_role_id: id })); };

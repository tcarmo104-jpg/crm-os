import { z } from 'zod';
import type { ServerSupabase } from '@/lib/supabase/server';
import { UserFacingError } from '@/lib/errors';
import { CRUD_ACTIONS, CRUD_MODULES, isValidRoleKey, PERMISSION_SCOPES, SPECIAL_PERMISSIONS } from '@/lib/roles';
import * as roles from '@/repositories/roles';
import { firstIssue } from './schemas';

const ALL_PERMISSION_KEYS = new Set<string>([...CRUD_MODULES.flatMap((m) => CRUD_ACTIONS.map((a) => `${m}:${a}`)), ...SPECIAL_PERMISSIONS]);

const permissionSchema = z.object({ key: z.string().refine((k) => ALL_PERMISSION_KEYS.has(k), 'Uno de los permisos no es válido.'), scope: z.enum(PERMISSION_SCOPES) });
const nameSchema = z.string().trim().min(1, 'Escribe el nombre del rol.').max(80);
const descriptionSchema = z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().trim().max(300).optional());
const permissionsSchema = z.array(permissionSchema).max(ALL_PERMISSION_KEYS.size);

const newRoleSchema = z.object({ key: z.string().refine(isValidRoleKey, 'La clave debe tener solo minúsculas y guion bajo, sin espacios ni tildes.'), name: nameSchema, description: descriptionSchema, permissions: permissionsSchema });

/** Crea un rol personalizado. Valida la clave, el nombre y que cada permiso sea uno real del sistema. */
export async function createCustomRole(db: ServerSupabase, orgId: string, input: unknown): Promise<string> {
  const r = newRoleSchema.safeParse(input);
  if (!r.success) throw new UserFacingError(firstIssue(r.error));
  return roles.createCustomRole(db, orgId, r.data.key, r.data.name, r.data.description, r.data.permissions);
}

const editRoleSchema = z.object({ name: nameSchema, description: descriptionSchema });
export async function renameCustomRole(db: ServerSupabase, id: string, input: unknown): Promise<void> {
  const r = editRoleSchema.safeParse(input);
  if (!r.success) throw new UserFacingError(firstIssue(r.error));
  await roles.renameCustomRole(db, id, r.data.name, r.data.description);
}

export async function setCustomRolePermissions(db: ServerSupabase, id: string, permissions: unknown): Promise<void> {
  const r = permissionsSchema.safeParse(permissions);
  if (!r.success) throw new UserFacingError(firstIssue(r.error));
  await roles.setCustomRolePermissions(db, id, r.data);
}

'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { actionContext, str } from '@/lib/action-context';
import { toUserMessage } from '@/lib/errors';
import type { ActionState } from '@/lib/action-state';
import * as rolesService from '@/services/roles';
import * as roles from '@/repositories/roles';
import { setFlash } from '@/lib/flash';
import type { RolePermission } from '@/lib/roles';

function readPermissions(fd: FormData): RolePermission[] {
  const keys = fd.getAll('permKey').map(String);
  const scopes = fd.getAll('permScope').map(String);
  return keys.map((key, i) => ({ key, scope: scopes[i] ?? 'none' })).filter((p): p is RolePermission => p.scope === 'own' || p.scope === 'team' || p.scope === 'org');
}

export async function createRoleAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  let target: string;
  try {
    const { org, db } = await actionContext();
    const id = await rolesService.createCustomRole(db, org.orgId, { key: str(fd.get('key')), name: str(fd.get('name')), description: str(fd.get('description')), permissions: readPermissions(fd) });
    revalidatePath('/settings/roles');
    await setFlash({ kind: 'ok', message: 'Rol creado.' });
    target = `/settings/roles/${id}`;
  } catch (e) {
    return { ok: false, error: toUserMessage(e) };
  }
  redirect(target);
}

export async function updateRoleAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const id = str(fd.get('roleId'));
  try {
    const { db } = await actionContext();
    await rolesService.renameCustomRole(db, id, { name: str(fd.get('name')), description: str(fd.get('description')) });
    await rolesService.setCustomRolePermissions(db, id, readPermissions(fd));
  } catch (e) {
    return { ok: false, error: toUserMessage(e) };
  }
  revalidatePath('/settings/roles'); revalidatePath(`/settings/roles/${id}`);
  return { ok: true, message: 'Rol actualizado.' };
}

export async function deleteRoleAction(fd: FormData): Promise<void> {
  const { db } = await actionContext();
  const id = str(fd.get('roleId'));
  try {
    await roles.deleteCustomRole(db, id);
    await setFlash({ kind: 'ok', message: 'Rol eliminado.' });
  } catch (e) {
    await setFlash({ kind: 'error', message: toUserMessage(e) });
  }
  revalidatePath('/settings/roles');
  redirect('/settings/roles');
}

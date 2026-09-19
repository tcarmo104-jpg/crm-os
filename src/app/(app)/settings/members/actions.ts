'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { getSession } from '@/lib/session';
import { toUserMessage, UserFacingError } from '@/lib/errors';
import { setFlash } from '@/lib/flash';
import type { ActionState } from '@/lib/action-state';
import * as invitations from '@/services/invitations';
import * as members from '@/services/members';

/**
 * La organización SIEMPRE sale de la sesión validada en servidor, nunca de un campo del formulario.
 * (Aun así, RLS impediría operar sobre otra organización.)
 */
async function activeOrgId() {
  const s = await getSession();
  if (!s?.active) throw new UserFacingError('Tu sesión venció. Inicia sesión de nuevo.');
  return s.active.orgId;
}

const str = (v: FormDataEntryValue | null) => (typeof v === 'string' ? v : '');

export async function inviteMember(_prev: ActionState, formData: FormData): Promise<ActionState> {
  try {
    const orgId = await activeOrgId();
    const r = await invitations.invite(await createClient(), orgId, {
      email: str(formData.get('email')),
      roleKey: str(formData.get('roleKey')),
      teamId: str(formData.get('teamId')) || undefined,
    });
    revalidatePath('/settings/members');
    return { ok: true, message: `Invitación creada para ${r.email}.`, data: { link: r.link } };
  } catch (e) {
    return { ok: false, error: toUserMessage(e) };
  }
}

async function run(fn: (orgId: string) => Promise<void>, okMessage: string) {
  try {
    await fn(await activeOrgId());
    await setFlash({ kind: 'ok', message: okMessage });
  } catch (e) {
    await setFlash({ kind: 'error', message: toUserMessage(e) });
  }
  revalidatePath('/settings/members');
  redirect('/settings/members');
}

export async function revokeInvite(formData: FormData) {
  await run(async () => invitations.revoke(await createClient(), str(formData.get('id'))), 'Invitación cancelada.');
}

export async function changeRole(formData: FormData) {
  await run(
    async (orgId) => members.changeRole(await createClient(), orgId, str(formData.get('membershipId')), str(formData.get('roleId'))),
    'Rol actualizado.',
  );
}

export async function changeTeam(formData: FormData) {
  await run(
    async (orgId) => members.changeTeam(await createClient(), orgId, str(formData.get('membershipId')), str(formData.get('teamId')) || null),
    'Equipo actualizado.',
  );
}

export async function removeMember(formData: FormData) {
  await run(
    async (orgId) => members.removeMember(await createClient(), orgId, str(formData.get('membershipId'))),
    'Miembro eliminado de la organización.',
  );
}

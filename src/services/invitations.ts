import type { ServerSupabase } from '@/lib/supabase/server';
import * as repo from '@/repositories/invitations';
import { invitationSchema, firstIssue, uuidSchema } from './schemas';
import { UserFacingError } from '@/lib/errors';
import { siteUrl } from '@/lib/env';

export function buildInviteLink(token: string): string {
  return `${siteUrl()}/invite/${token}`;
}

/** Crea la invitación y devuelve el enlace (el token se muestra una sola vez). */
export async function invite(
  db: ServerSupabase,
  orgId: string,
  input: { email: string; roleKey: string; teamId?: string },
) {
  const parsed = invitationSchema.safeParse(input);
  if (!parsed.success) throw new UserFacingError(firstIssue(parsed.error));
  const token = await repo.createInvitation(db, orgId, parsed.data.email, parsed.data.roleKey, parsed.data.teamId ?? null);
  return { email: parsed.data.email, link: buildInviteLink(token) };
}

export async function revoke(db: ServerSupabase, invitationId: string) {
  if (!uuidSchema.safeParse(invitationId).success) throw new UserFacingError('Invitación no válida.');
  await repo.revokeInvitation(db, invitationId);
}

export async function accept(db: ServerSupabase, token: string) {
  if (!/^[a-f0-9]{64}$/.test(token)) throw new UserFacingError('El enlace de invitación no es válido.');
  return repo.acceptInvitation(db, token);
}

export async function preview(db: ServerSupabase, token: string) {
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  return repo.previewInvitation(db, token);
}

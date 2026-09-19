import type { ServerSupabase } from '@/lib/supabase/server';
import * as repo from '@/repositories/members';
import { uuidSchema } from './schemas';
import { UserFacingError } from '@/lib/errors';

function assertUuid(v: string, label: string) {
  if (!uuidSchema.safeParse(v).success) throw new UserFacingError(`${label} no válido.`);
}

export async function changeRole(db: ServerSupabase, orgId: string, membershipId: string, roleId: string) {
  assertUuid(membershipId, 'Miembro');
  assertUuid(roleId, 'Rol');
  await repo.updateMemberRole(db, orgId, membershipId, roleId);
}

export async function changeTeam(db: ServerSupabase, orgId: string, membershipId: string, teamId: string | null) {
  assertUuid(membershipId, 'Miembro');
  if (teamId) assertUuid(teamId, 'Equipo');
  await repo.updateMemberTeam(db, orgId, membershipId, teamId);
}

export async function removeMember(db: ServerSupabase, orgId: string, membershipId: string) {
  assertUuid(membershipId, 'Miembro');
  await repo.deleteMember(db, orgId, membershipId);
}

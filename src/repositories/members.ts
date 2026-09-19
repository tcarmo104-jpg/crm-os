import type { ServerSupabase } from '@/lib/supabase/server';
import { unwrap } from '@/lib/errors';
import type { MemberRow, MembershipStatus, RoleRow } from '@/lib/types';

interface MembershipRaw {
  id: string;
  user_id: string;
  role_id: string;
  team_id: string | null;
  status: MembershipStatus;
  role: { key: string; name: string } | null;
}
interface ProfileRaw { id: string; full_name: string | null; email: string | null }

export async function listMembers(db: ServerSupabase, orgId: string): Promise<MemberRow[]> {
  const memberships = unwrap(
    await db
      .from('memberships')
      .select('id, user_id, role_id, team_id, status, role:roles(key, name)')
      .eq('org_id', orgId)
      .order('created_at'),
  ) as unknown as MembershipRaw[];

  const ids = memberships.map((m) => m.user_id);
  const profiles = ids.length
    ? (unwrap(await db.from('profiles').select('id, full_name, email').in('id', ids)) as ProfileRaw[])
    : [];
  const byId = new Map(profiles.map((p) => [p.id, p]));

  return memberships.map((m) => ({
    membershipId: m.id,
    userId: m.user_id,
    fullName: byId.get(m.user_id)?.full_name ?? null,
    email: byId.get(m.user_id)?.email ?? null,
    roleId: m.role_id,
    roleKey: m.role?.key ?? '',
    roleName: m.role?.name ?? '',
    teamId: m.team_id,
    status: m.status,
  }));
}

export async function listSystemRoles(db: ServerSupabase): Promise<RoleRow[]> {
  return unwrap(
    await db.from('roles').select('id, key, name').is('org_id', null).order('name'),
  ) as RoleRow[];
}

export async function updateMemberRole(db: ServerSupabase, orgId: string, membershipId: string, roleId: string) {
  unwrap(
    await db.from('memberships').update({ role_id: roleId }).eq('id', membershipId).eq('org_id', orgId).select('id').single(),
  );
}

export async function updateMemberTeam(db: ServerSupabase, orgId: string, membershipId: string, teamId: string | null) {
  unwrap(
    await db.from('memberships').update({ team_id: teamId }).eq('id', membershipId).eq('org_id', orgId).select('id').single(),
  );
}

export async function deleteMember(db: ServerSupabase, orgId: string, membershipId: string) {
  unwrap(await db.from('memberships').delete().eq('id', membershipId).eq('org_id', orgId).select('id').single());
}

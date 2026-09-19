import type { ServerSupabase } from '@/lib/supabase/server';
import { unwrap } from '@/lib/errors';
import type { InvitationPreview, PendingInvitationRow } from '@/lib/types';

interface InvitationRaw {
  id: string;
  email: string;
  team_id: string | null;
  expires_at: string;
  created_at: string;
  role: { name: string } | null;
}

export async function createInvitation(
  db: ServerSupabase, orgId: string, email: string, roleKey: string, teamId: string | null,
): Promise<string> {
  return unwrap(
    await db.rpc('create_invitation', { p_org: orgId, p_email: email, p_role_key: roleKey, p_team_id: teamId }),
  ) as string;
}

export async function revokeInvitation(db: ServerSupabase, id: string) {
  unwrap(await db.rpc('revoke_invitation', { p_id: id }));
}

export async function listPending(db: ServerSupabase, orgId: string): Promise<PendingInvitationRow[]> {
  const rows = unwrap(
    await db
      .from('invitations')
      .select('id, email, team_id, expires_at, created_at, role:roles(name)')
      .eq('org_id', orgId)
      .is('accepted_at', null)
      .is('revoked_at', null)
      .order('created_at', { ascending: false }),
  ) as unknown as InvitationRaw[];
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    roleName: r.role?.name ?? '',
    teamId: r.team_id,
    expiresAt: r.expires_at,
    createdAt: r.created_at,
  }));
}

export async function previewInvitation(db: ServerSupabase, token: string): Promise<InvitationPreview | null> {
  const rows = unwrap(await db.rpc('get_invitation', { p_token: token })) as
    | { org_name: string; role_name: string; email: string; status: InvitationPreview['status'] }[]
    | null;
  const r = rows?.[0];
  return r ? { orgName: r.org_name, roleName: r.role_name, email: r.email, status: r.status } : null;
}

export async function acceptInvitation(db: ServerSupabase, token: string): Promise<string> {
  return unwrap(await db.rpc('accept_invitation', { p_token: token })) as string;
}

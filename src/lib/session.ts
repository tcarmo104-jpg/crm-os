import 'server-only';
import { cache } from 'react';
import { cookies } from 'next/headers';
import { createClient } from '@/lib/supabase/server';
import { unwrap } from '@/lib/errors';
import type { OrgMembership, Scope, SessionContext } from '@/lib/types';

export const ACTIVE_ORG_COOKIE = 'crm_active_org';

interface MembershipRaw {
  role_id: string;
  team_id: string | null;
  org: { id: string; name: string; slug: string; timezone: string; locale: string } | null;
  role: { key: string; name: string } | null;
}

/**
 * Contexto de la sesión: usuario, organizaciones, organización activa y permisos.
 * Se calcula una vez por request. Devuelve null si no hay sesión.
 * La organización activa se valida contra las membresías reales (RLS): la cookie solo es una preferencia.
 */
export const getSession = cache(async (): Promise<SessionContext | null> => {
  const db = await createClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) return null;

  const rows = unwrap(
    await db
      .from('memberships')
      .select('role_id, team_id, org:organizations(id, name, slug, timezone, locale), role:roles(key, name)')
      .eq('user_id', user.id)
      .eq('status', 'active')
      .order('created_at'),
  ) as unknown as MembershipRaw[];

  const memberships: OrgMembership[] = rows
    .filter((r) => r.org && r.role)
    .map((r) => ({
      orgId: r.org!.id,
      orgName: r.org!.name,
      orgSlug: r.org!.slug,
      orgTimezone: r.org!.timezone,
      orgLocale: r.org!.locale,
      roleId: r.role_id,
      roleKey: r.role!.key,
      roleName: r.role!.name,
      teamId: r.team_id,
    }));

  const preferred = (await cookies()).get(ACTIVE_ORG_COOKIE)?.value;
  const active = memberships.find((m) => m.orgId === preferred) ?? memberships[0] ?? null;

  let permissions: Record<string, Scope> = {};
  if (active) {
    const perms = unwrap(
      await db.from('role_permissions').select('permission_key, scope').eq('role_id', active.roleId),
    ) as { permission_key: string; scope: Scope }[];
    permissions = Object.fromEntries(perms.map((p) => [p.permission_key, p.scope]));
  }

  const meta = user.user_metadata as { full_name?: string } | undefined;
  return {
    user: { id: user.id, email: user.email ?? '', fullName: meta?.full_name ?? null },
    memberships,
    active,
    permissions,
  };
});

export function can(session: SessionContext, permission: string): boolean {
  return permission in session.permissions;
}

'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getSession, ACTIVE_ORG_COOKIE } from '@/lib/session';

export async function setActiveOrgCookie(orgId: string) {
  (await cookies()).set(ACTIVE_ORG_COOKIE, orgId, {
    httpOnly: true, sameSite: 'lax', path: '/', maxAge: 60 * 60 * 24 * 365,
    secure: process.env.NODE_ENV === 'production',
  });
}

export async function switchOrg(formData: FormData) {
  const orgId = String(formData.get('orgId') ?? '');
  const session = await getSession();
  // Solo se puede activar una organización de la que realmente se es miembro.
  if (session?.memberships.some((m) => m.orgId === orgId)) await setActiveOrgCookie(orgId);
  redirect('/');
}

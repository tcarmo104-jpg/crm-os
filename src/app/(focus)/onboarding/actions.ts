'use server';

import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { toUserMessage } from '@/lib/errors';
import type { ActionState } from '@/lib/action-state';
import { createOrganization } from '@/services/organizations';
import { setActiveOrgCookie } from '@/app/(app)/actions';

export async function createOrg(_prev: ActionState, formData: FormData): Promise<ActionState> {
  let orgId: string;
  try {
    const db = await createClient();
    orgId = await createOrganization(db, {
      name: String(formData.get('name') ?? ''),
      slug: String(formData.get('slug') ?? ''),
    });
  } catch (e) {
    return { ok: false, error: toUserMessage(e) };
  }
  await setActiveOrgCookie(orgId);
  redirect('/');
}

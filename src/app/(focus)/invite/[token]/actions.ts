'use server';

import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { toUserMessage } from '@/lib/errors';
import { setFlash } from '@/lib/flash';
import * as invitations from '@/services/invitations';
import { setActiveOrgCookie } from '@/app/(app)/actions';

export async function acceptInvite(formData: FormData) {
  const token = String(formData.get('token') ?? '');
  let orgId: string;
  try {
    orgId = await invitations.accept(await createClient(), token);
  } catch (e) {
    await setFlash({ kind: 'error', message: toUserMessage(e) });
    redirect(/^[a-f0-9]{64}$/.test(token) ? `/invite/${token}` : '/');
  }
  await setActiveOrgCookie(orgId);
  redirect('/');
}

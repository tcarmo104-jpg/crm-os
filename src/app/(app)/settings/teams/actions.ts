'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { getSession } from '@/lib/session';
import { toUserMessage } from '@/lib/errors';
import type { ActionState } from '@/lib/action-state';
import * as teams from '@/services/teams';

export async function createTeam(_prev: ActionState, formData: FormData): Promise<ActionState> {
  try {
    const s = await getSession();
    if (!s?.active) return { ok: false, error: 'Tu sesión venció. Inicia sesión de nuevo.' };
    await teams.createTeam(await createClient(), s.active.orgId, {
      name: String(formData.get('name') ?? ''),
      region: String(formData.get('region') ?? ''),
    });
    revalidatePath('/settings/teams');
    revalidatePath('/settings/members');
    revalidatePath('/');
    return { ok: true, message: 'Equipo creado.' };
  } catch (e) {
    return { ok: false, error: toUserMessage(e) };
  }
}

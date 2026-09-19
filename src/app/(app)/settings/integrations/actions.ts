'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { getSession } from '@/lib/session';
import { toUserMessage, UserFacingError } from '@/lib/errors';
import { setFlash } from '@/lib/flash';
import type { ActionState } from '@/lib/action-state';
import { createApiKey, revokeApiKey } from '@/repositories/api-keys';
import { uuidSchema } from '@/services/schemas';

const str = (v: FormDataEntryValue | null) => (typeof v === 'string' ? v : '');

export async function createApiKeyAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const s = await getSession();
    if (!s?.active) throw new UserFacingError('Tu sesión venció. Inicia sesión de nuevo.');
    const name = str(fd.get('name')).trim();
    if (name.length < 1 || name.length > 80) throw new UserFacingError('Escribe un nombre de 1 a 80 caracteres.');
    const key = await createApiKey(await createClient(), s.active.orgId, name);
    revalidatePath('/settings/integrations');
    return { ok: true, message: 'Llave creada.', data: { key } };
  } catch (e) {
    return { ok: false, error: toUserMessage(e) };
  }
}

export async function revokeApiKeyAction(fd: FormData): Promise<void> {
  try {
    await revokeApiKey(await createClient(), uuidSchema.parse(str(fd.get('keyId'))));
    await setFlash({ kind: 'ok', message: 'Llave revocada. Deja de funcionar de inmediato.' });
  } catch (e) {
    await setFlash({ kind: 'error', message: toUserMessage(e) });
  }
  revalidatePath('/settings/integrations');
  redirect('/settings/integrations');
}

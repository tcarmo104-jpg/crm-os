'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { getSession } from '@/lib/session';
import { toUserMessage, UserFacingError } from '@/lib/errors';
import { setFlash } from '@/lib/flash';
import type { ActionState } from '@/lib/action-state';
import { setFieldArchived } from '@/repositories/custom-fields';
import { createField } from '@/services/fields';
import { uuidSchema } from '@/services/schemas';

const str = (v: FormDataEntryValue | null) => (typeof v === 'string' ? v : '');

export async function createFieldAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const s = await getSession();
    if (!s?.active) throw new UserFacingError('Tu sesión venció. Inicia sesión de nuevo.');
    await createField(await createClient(), s.active.orgId, {
      entity: str(fd.get('entity')), label: str(fd.get('label')), type: str(fd.get('type')), options: str(fd.get('options')),
    });
    revalidatePath('/settings/fields');
    return { ok: true, message: 'Campo creado. Ya aparece en los formularios.' };
  } catch (e) {
    const msg = toUserMessage(e);
    // La clave se genera del nombre: si choca con otra, se explica en términos de la persona.
    return { ok: false, error: msg === 'Ya existe un registro con esos datos.' ? 'Ya existe un campo con ese nombre para esa sección.' : msg };
  }
}

export async function archiveFieldAction(fd: FormData): Promise<void> {
  try {
    const archive = str(fd.get('archive')) === 'true';
    await setFieldArchived(await createClient(), uuidSchema.parse(str(fd.get('fieldId'))), archive);
    await setFlash({ kind: 'ok', message: archive ? 'Campo archivado. Los datos ya guardados se conservan.' : 'Campo restaurado.' });
  } catch (e) {
    await setFlash({ kind: 'error', message: toUserMessage(e) });
  }
  revalidatePath('/settings/fields');
  redirect('/settings/fields');
}

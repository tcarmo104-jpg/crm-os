'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { actionContext, str } from '@/lib/action-context';
import { toUserMessage } from '@/lib/errors';
import { setFlash } from '@/lib/flash';
import type { ActionState } from '@/lib/action-state';
import * as repo from '@/repositories/widget-default-fields';
import * as service from '@/services/widget-default-fields';
import { uuidSchema } from '@/services/schemas';

const path = (widgetId: string) => `/settings/whatsapp-widgets/${widgetId}`;

function fieldInput(fd: FormData) {
  return { fieldId: str(fd.get('fieldId')), required: fd.get('required') === 'on', labelOverride: str(fd.get('labelOverride')), placeholderOverride: str(fd.get('placeholderOverride')), defaultValue: str(fd.get('defaultValue')) };
}

export async function addDefaultFieldAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const { org, db } = await actionContext();
    const widgetId = uuidSchema.parse(str(fd.get('widgetId')));
    await service.addDefaultField(db, org.orgId, widgetId, fieldInput(fd));
    revalidatePath(path(widgetId));
    return { ok: true, message: 'Campo agregado al formulario.' };
  } catch (e) { return { ok: false, error: toUserMessage(e) }; }
}
export async function updateDefaultFieldAction(fd: FormData): Promise<void> {
  const { db } = await actionContext();
  const widgetId = str(fd.get('widgetId'));
  try {
    await service.updateDefaultField(db, widgetId, fieldInput(fd));
    await setFlash({ kind: 'ok', message: 'Campo actualizado.' });
  } catch (e) { await setFlash({ kind: 'error', message: toUserMessage(e) }); }
  revalidatePath(path(widgetId));
  redirect(path(widgetId));
}
export async function moveDefaultFieldAction(fd: FormData): Promise<void> {
  const { db } = await actionContext();
  const widgetId = str(fd.get('widgetId'));
  try {
    await service.moveDefaultField(db, widgetId, str(fd.get('fieldId')), str(fd.get('dir')) === 'up' ? 'up' : 'down');
  } catch (e) { await setFlash({ kind: 'error', message: toUserMessage(e) }); }
  revalidatePath(path(widgetId));
  redirect(path(widgetId));
}
export async function removeDefaultFieldAction(fd: FormData): Promise<void> {
  const { db } = await actionContext();
  const widgetId = str(fd.get('widgetId'));
  try {
    await repo.removeDefaultField(db, widgetId, str(fd.get('fieldId')));
    await setFlash({ kind: 'ok', message: 'Campo quitado del formulario.' });
  } catch (e) { await setFlash({ kind: 'error', message: toUserMessage(e) }); }
  revalidatePath(path(widgetId));
  redirect(path(widgetId));
}

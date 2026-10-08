'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { actionContext, str } from '@/lib/action-context';
import { toUserMessage } from '@/lib/errors';
import { setFlash } from '@/lib/flash';
import type { ActionState } from '@/lib/action-state';
import * as repo from '@/repositories/widget-option-fields';
import * as service from '@/services/widget-option-fields';
import { uuidSchema } from '@/services/schemas';

const path = (widgetId: string, optionId: string) => `/settings/whatsapp-widgets/${widgetId}/options/${optionId}`;

function fieldInput(fd: FormData) {
  return { fieldId: str(fd.get('fieldId')), required: fd.get('required') === 'on', labelOverride: str(fd.get('labelOverride')), placeholderOverride: str(fd.get('placeholderOverride')), defaultValue: str(fd.get('defaultValue')) };
}

export async function addFieldToOptionAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const { org, db } = await actionContext();
    const optionId = uuidSchema.parse(str(fd.get('optionId')));
    await service.addFieldToOption(db, org.orgId, optionId, fieldInput(fd));
    revalidatePath(path(str(fd.get('widgetId')), optionId));
    return { ok: true, message: 'Campo agregado.' };
  } catch (e) { return { ok: false, error: toUserMessage(e) }; }
}
export async function updateOptionFieldAction(fd: FormData): Promise<void> {
  const { db } = await actionContext();
  const widgetId = str(fd.get('widgetId')), optionId = str(fd.get('optionId'));
  try {
    await service.updateOptionField(db, optionId, fieldInput(fd));
    await setFlash({ kind: 'ok', message: 'Campo actualizado.' });
  } catch (e) { await setFlash({ kind: 'error', message: toUserMessage(e) }); }
  revalidatePath(path(widgetId, optionId));
  redirect(path(widgetId, optionId));
}
export async function moveOptionFieldAction(fd: FormData): Promise<void> {
  const { db } = await actionContext();
  const widgetId = str(fd.get('widgetId')), optionId = str(fd.get('optionId'));
  try {
    await service.moveOptionField(db, optionId, str(fd.get('fieldId')), str(fd.get('dir')) === 'up' ? 'up' : 'down');
  } catch (e) { await setFlash({ kind: 'error', message: toUserMessage(e) }); }
  revalidatePath(path(widgetId, optionId));
  redirect(path(widgetId, optionId));
}
export async function removeFieldFromOptionAction(fd: FormData): Promise<void> {
  const { db } = await actionContext();
  const widgetId = str(fd.get('widgetId')), optionId = str(fd.get('optionId'));
  try {
    await repo.removeFieldFromOption(db, optionId, str(fd.get('fieldId')));
    await setFlash({ kind: 'ok', message: 'Campo quitado de esta opción.' });
  } catch (e) { await setFlash({ kind: 'error', message: toUserMessage(e) }); }
  revalidatePath(path(widgetId, optionId));
  redirect(path(widgetId, optionId));
}

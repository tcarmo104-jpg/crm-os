'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { actionContext, str } from '@/lib/action-context';
import { toUserMessage } from '@/lib/errors';
import { setFlash } from '@/lib/flash';
import type { ActionState } from '@/lib/action-state';
import * as repo from '@/repositories/widget-options';
import * as service from '@/services/widget-options';
import { uuidSchema } from '@/services/schemas';

function optionInput(fd: FormData) {
  return { icon: str(fd.get('icon')), label: str(fd.get('label')), messageTemplate: str(fd.get('messageTemplate')) };
}

export async function createWidgetOptionAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const { org, db } = await actionContext();
    const widgetId = uuidSchema.parse(str(fd.get('widgetId')));
    await service.createWidgetOption(db, org.orgId, widgetId, optionInput(fd));
    revalidatePath(`/settings/whatsapp-widgets/${widgetId}`);
    return { ok: true, message: 'Opción creada.' };
  } catch (e) { return { ok: false, error: toUserMessage(e) }; }
}
export async function updateWidgetOptionAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const { db } = await actionContext();
    const id = uuidSchema.parse(str(fd.get('optionId')));
    await service.updateWidgetOption(db, id, optionInput(fd));
    revalidatePath(`/settings/whatsapp-widgets/${str(fd.get('widgetId'))}`);
    return { ok: true, message: 'Opción actualizada.' };
  } catch (e) { return { ok: false, error: toUserMessage(e) }; }
}
export async function moveWidgetOptionAction(fd: FormData): Promise<void> {
  const { db } = await actionContext();
  const widgetId = str(fd.get('widgetId'));
  try {
    await service.moveWidgetOption(db, widgetId, str(fd.get('optionId')), str(fd.get('dir')) === 'up' ? 'up' : 'down');
  } catch (e) { await setFlash({ kind: 'error', message: toUserMessage(e) }); }
  revalidatePath(`/settings/whatsapp-widgets/${widgetId}`);
  redirect(`/settings/whatsapp-widgets/${widgetId}`);
}
export async function setWidgetOptionActiveAction(fd: FormData): Promise<void> {
  const { db } = await actionContext();
  const widgetId = str(fd.get('widgetId'));
  try {
    await repo.setWidgetOptionActive(db, str(fd.get('optionId')), str(fd.get('active')) === '1');
    await setFlash({ kind: 'ok', message: 'Opción actualizada.' });
  } catch (e) { await setFlash({ kind: 'error', message: toUserMessage(e) }); }
  revalidatePath(`/settings/whatsapp-widgets/${widgetId}`);
  redirect(`/settings/whatsapp-widgets/${widgetId}`);
}
export async function deleteWidgetOptionAction(fd: FormData): Promise<void> {
  const { db } = await actionContext();
  const widgetId = str(fd.get('widgetId'));
  try {
    await repo.deleteWidgetOption(db, str(fd.get('optionId')));
    await setFlash({ kind: 'ok', message: 'Opción eliminada.' });
  } catch (e) { await setFlash({ kind: 'error', message: toUserMessage(e) }); }
  revalidatePath(`/settings/whatsapp-widgets/${widgetId}`);
  redirect(`/settings/whatsapp-widgets/${widgetId}`);
}

'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { actionContext, str } from '@/lib/action-context';
import { toUserMessage } from '@/lib/errors';
import type { ActionState } from '@/lib/action-state';
import * as service from '@/services/widgets';
import * as repo from '@/repositories/widgets';
import { setFlash } from '@/lib/flash';

function readInput(fd: FormData) {
  return { channelId: str(fd.get('channelId')), name: str(fd.get('name')), buttonText: str(fd.get('buttonText')), initialMessage: str(fd.get('initialMessage')),
    position: str(fd.get('position')), showText: fd.get('showText') === 'on', color: str(fd.get('color')), size: str(fd.get('size')), domains: str(fd.get('domains')) };
}

export async function createWidgetAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  let target: string;
  try {
    const { org, db } = await actionContext();
    const id = await service.createWidget(db, org.orgId, readInput(fd));
    revalidatePath('/settings/whatsapp-widgets');
    await setFlash({ kind: 'ok', message: 'Widget creado. Copia el código de instalación de abajo.' });
    target = `/settings/whatsapp-widgets/${id}`;
  } catch (e) { return { ok: false, error: toUserMessage(e) }; }
  redirect(target);
}

export async function updateWidgetAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const id = str(fd.get('widgetId'));
  try {
    const { db } = await actionContext();
    await service.updateWidget(db, id, readInput(fd));
  } catch (e) { return { ok: false, error: toUserMessage(e) }; }
  revalidatePath('/settings/whatsapp-widgets'); revalidatePath(`/settings/whatsapp-widgets/${id}`);
  return { ok: true, message: 'Widget actualizado.' };
}

export async function toggleWidgetActiveAction(fd: FormData): Promise<void> {
  const { db } = await actionContext();
  const id = str(fd.get('widgetId'));
  try {
    await repo.setWidgetActive(db, id, str(fd.get('active')) === '1');
    await setFlash({ kind: 'ok', message: 'Widget actualizado.' });
  } catch (e) { await setFlash({ kind: 'error', message: toUserMessage(e) }); }
  revalidatePath('/settings/whatsapp-widgets');
  redirect('/settings/whatsapp-widgets');
}

export async function deleteWidgetAction(fd: FormData): Promise<void> {
  const { db } = await actionContext();
  const id = str(fd.get('widgetId'));
  try {
    await repo.deleteWidget(db, id);
    await setFlash({ kind: 'ok', message: 'Widget eliminado.' });
  } catch (e) { await setFlash({ kind: 'error', message: toUserMessage(e) }); }
  revalidatePath('/settings/whatsapp-widgets');
  redirect('/settings/whatsapp-widgets');
}

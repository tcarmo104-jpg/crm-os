'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { actionContext, str } from '@/lib/action-context';
import { toUserMessage } from '@/lib/errors';
import { setFlash } from '@/lib/flash';
import type { ActionState } from '@/lib/action-state';
import { getWidgetField, setWidgetFieldActive, deleteWidgetField } from '@/repositories/widget-fields';
import * as service from '@/services/widget-fields';
import { uuidSchema } from '@/services/schemas';

export async function createWidgetFieldAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const { org, db } = await actionContext();
    await service.createWidgetField(db, org.orgId, { label: str(fd.get('label')), fieldType: str(fd.get('fieldType')), placeholder: str(fd.get('placeholder')), options: str(fd.get('options')) });
    revalidatePath('/settings/whatsapp-widgets/fields');
    return { ok: true, message: 'Campo creado. Ya puedes agregarlo a las intenciones de tus widgets.' };
  } catch (e) {
    const msg = toUserMessage(e);
    return { ok: false, error: msg === 'Ya existe un registro con esos datos.' ? 'Ya existe un campo con ese nombre.' : msg };
  }
}
export async function updateWidgetFieldAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const { db } = await actionContext();
    const id = uuidSchema.parse(str(fd.get('fieldId')));
    const field = await getWidgetField(db, id);
    if (!field) throw new Error('not found');
    await service.updateWidgetField(db, id, field.fieldType, { label: str(fd.get('label')), placeholder: str(fd.get('placeholder')), options: str(fd.get('options')) });
    revalidatePath('/settings/whatsapp-widgets/fields');
    return { ok: true, message: 'Campo actualizado.' };
  } catch (e) {
    return { ok: false, error: toUserMessage(e) };
  }
}
export async function setWidgetFieldActiveAction(fd: FormData): Promise<void> {
  const { db } = await actionContext();
  const id = str(fd.get('fieldId'));
  try {
    await setWidgetFieldActive(db, id, str(fd.get('active')) === '1');
    await setFlash({ kind: 'ok', message: 'Campo actualizado.' });
  } catch (e) { await setFlash({ kind: 'error', message: toUserMessage(e) }); }
  revalidatePath('/settings/whatsapp-widgets/fields');
  redirect('/settings/whatsapp-widgets/fields');
}
export async function deleteWidgetFieldAction(fd: FormData): Promise<void> {
  const { db } = await actionContext();
  const id = str(fd.get('fieldId'));
  try {
    // Si el campo está asignado a alguna intención, se quita de ahí también (así lo definimos: el catálogo
    // es la fuente de verdad). La confirmación en pantalla ya avisa de esto antes de llegar aquí.
    await deleteWidgetField(db, id);
    await setFlash({ kind: 'ok', message: 'Campo eliminado.' });
  } catch (e) {
    await setFlash({ kind: 'error', message: toUserMessage(e) });
  }
  revalidatePath('/settings/whatsapp-widgets/fields');
  redirect('/settings/whatsapp-widgets/fields');
}

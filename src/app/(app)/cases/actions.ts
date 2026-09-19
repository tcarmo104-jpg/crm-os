'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { actionContext, returnTo, str } from '@/lib/action-context';
import { toUserMessage } from '@/lib/errors';
import { setFlash } from '@/lib/flash';
import type { ActionState } from '@/lib/action-state';
import * as commerce from '@/services/commerce';
import { uuidSchema } from '@/services/schemas';

export async function openCaseAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const { org, db } = await actionContext();
    const customerId = str(fd.get('customerId'));
    await commerce.openCase(db, org.orgId, {
      customerId, title: str(fd.get('title')), kind: str(fd.get('kind')) || undefined, priority: str(fd.get('priority')) || undefined,
      description: str(fd.get('description')), saleId: str(fd.get('saleId')),
    });
    revalidatePath('/cases');
    revalidatePath(`/customers/${customerId}`);
    return { ok: true, message: 'Caso abierto.' };
  } catch (e) {
    return { ok: false, error: toUserMessage(e) };
  }
}

export async function changeCaseStatusAction(fd: FormData): Promise<void> {
  const back = returnTo(fd, '/cases');
  try {
    const { db } = await actionContext();
    await commerce.changeCaseStatus(db, uuidSchema.parse(str(fd.get('caseId'))), str(fd.get('to')), str(fd.get('note')));
    await setFlash({ kind: 'ok', message: 'Caso actualizado.' });
  } catch (e) {
    await setFlash({ kind: 'error', message: toUserMessage(e) });
  }
  revalidatePath('/cases');
  revalidatePath(back);
  redirect(back);
}

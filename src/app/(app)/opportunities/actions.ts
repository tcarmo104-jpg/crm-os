'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { actionContext, returnTo, str } from '@/lib/action-context';
import { toUserMessage } from '@/lib/errors';
import { setFlash } from '@/lib/flash';
import { mergeCustomFields, readCustomFields } from '@/lib/custom-fields';
import type { ActionState } from '@/lib/action-state';
import { getOpportunity } from '@/repositories/opportunities';
import { listFieldDefinitions } from '@/repositories/custom-fields';
import * as sales from '@/services/sales';
import { uuidSchema } from '@/services/schemas';

export async function createOpportunityAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  let target: string;
  try {
    const { db } = await actionContext();
    const id = await sales.createOpportunity(db, {
      customerId: str(fd.get('customerId')), title: str(fd.get('title')), amount: str(fd.get('amount')),
      expectedClose: str(fd.get('expectedClose')), pipelineId: str(fd.get('pipelineId')), productInterest: str(fd.get('productInterest')),
    });
    await setFlash({ kind: 'ok', message: 'Oportunidad creada.' });
    revalidatePath('/opportunities');
    target = `/opportunities/${id}`;
  } catch (e) {
    return { ok: false, error: toUserMessage(e) };
  }
  redirect(target);
}

/** Mover de etapa (incluye ganar y perder). Vuelve a la página de origen con un aviso. */
export async function moveOpportunityAction(fd: FormData): Promise<void> {
  const back = returnTo(fd, '/opportunities');
  try {
    const { db } = await actionContext();
    await sales.moveOpportunity(db, uuidSchema.parse(str(fd.get('opportunityId'))), { stageId: str(fd.get('stageId')), reason: str(fd.get('reason')) });
    await setFlash({ kind: 'ok', message: 'Oportunidad actualizada.' });
  } catch (e) {
    await setFlash({ kind: 'error', message: toUserMessage(e) });
  }
  revalidatePath('/opportunities');
  revalidatePath(back);
  redirect(back);
}

export async function updateOpportunityAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const { org, db } = await actionContext();
    const id = uuidSchema.parse(str(fd.get('opportunityId')));
    const [current, defs] = await Promise.all([getOpportunity(db, id), listFieldDefinitions(db, org.orgId, 'opportunity')]);
    if (!current) return { ok: false, error: 'No encontramos esta oportunidad.' };
    await sales.updateOpportunity(db, id, {
      title: str(fd.get('title')), amount: str(fd.get('amount')), expectedClose: str(fd.get('expectedClose')), productInterest: str(fd.get('productInterest')),
    }, mergeCustomFields(current.customFields, readCustomFields(fd, defs)));
    revalidatePath(`/opportunities/${id}`);
    revalidatePath('/opportunities');
    return { ok: true, message: 'Cambios guardados.' };
  } catch (e) {
    return { ok: false, error: toUserMessage(e) };
  }
}

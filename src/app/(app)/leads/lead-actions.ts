'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { actionContext, returnTo, str } from '@/lib/action-context';
import { toUserMessage } from '@/lib/errors';
import { setFlash } from '@/lib/flash';
import { convertLead } from '@/repositories/leads';
import { changeLeadStatus } from '@/services/sales';
import { uuidSchema } from '@/services/schemas';

export async function changeLeadStatusAction(fd: FormData): Promise<void> {
  const back = returnTo(fd, '/leads');
  try {
    const { db } = await actionContext();
    await changeLeadStatus(db, uuidSchema.parse(str(fd.get('leadId'))), str(fd.get('to')), str(fd.get('reason')));
    await setFlash({ kind: 'ok', message: 'Estado del lead actualizado.' });
  } catch (e) {
    await setFlash({ kind: 'error', message: toUserMessage(e) });
  }
  revalidatePath('/leads');
  redirect(back);
}

export async function convertLeadAction(fd: FormData): Promise<void> {
  let target = returnTo(fd, '/leads');
  try {
    const { db } = await actionContext();
    const oppId = await convertLead(db, uuidSchema.parse(str(fd.get('leadId'))));
    await setFlash({ kind: 'ok', message: 'Lead convertido en oportunidad.' });
    revalidatePath('/leads');
    revalidatePath('/opportunities');
    target = `/opportunities/${oppId}`;
  } catch (e) {
    await setFlash({ kind: 'error', message: toUserMessage(e) });
  }
  redirect(target);
}

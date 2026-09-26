'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { actionContext, str } from '@/lib/action-context';
import { toUserMessage } from '@/lib/errors';
import type { ActionState } from '@/lib/action-state';
import * as sequencesService from '@/services/sequences';
import * as sequences from '@/repositories/sequences';
import { setFlash } from '@/lib/flash';

export async function createSequenceAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  let target: string;
  try {
    const { org, db } = await actionContext();
    const titles = fd.getAll('stepTitle').map(String);
    const steps = titles.map((title, i) => ({
      title, type: String(fd.getAll('stepType')[i] ?? 'follow_up'), offsetDays: Number(fd.getAll('stepOffset')[i] ?? 0),
      priority: String(fd.getAll('stepPriority')[i] ?? 'normal'),
    })).filter((s) => s.title.trim());
    const id = await sequencesService.createSequence(db, org.orgId, { name: str(fd.get('name')), description: str(fd.get('description')), steps });
    revalidatePath('/sequences');
    await setFlash({ kind: 'ok', message: 'Secuencia creada.' });
    target = `/sequences/${id}`;
  } catch (e) {
    return { ok: false, error: toUserMessage(e) };
  }
  redirect(target);
}

export async function archiveSequenceAction(fd: FormData): Promise<void> {
  const { db } = await actionContext();
  const id = str(fd.get('sequenceId'));
  try {
    await sequences.archiveSequence(db, id, str(fd.get('active')) === '1');
    await setFlash({ kind: 'ok', message: str(fd.get('active')) === '1' ? 'Secuencia reactivada.' : 'Secuencia archivada.' });
  } catch (e) {
    await setFlash({ kind: 'error', message: toUserMessage(e) });
  }
  revalidatePath('/sequences'); revalidatePath(`/sequences/${id}`);
  redirect(str(fd.get('returnTo')) || `/sequences/${id}`);
}

export async function enrollAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const { db } = await actionContext();
    const customerId = str(fd.get('customerId'));
    await sequences.enrollInSequence(db, str(fd.get('sequenceId')), customerId, str(fd.get('opportunityId')) || null, str(fd.get('assigneeId')) || null);
    revalidatePath(`/customers/${customerId}`);
    return { ok: true, message: 'Cliente inscrito en la secuencia.' };
  } catch (e) {
    return { ok: false, error: toUserMessage(e) };
  }
}

async function enrollmentTransition(fd: FormData, run: (db: Awaited<ReturnType<typeof actionContext>>['db'], id: string) => Promise<void>, ok: string): Promise<void> {
  const { db } = await actionContext();
  const id = str(fd.get('enrollmentId'));
  const back = str(fd.get('returnTo')) || '/sequences';
  try { await run(db, id); await setFlash({ kind: 'ok', message: ok }); }
  catch (e) { await setFlash({ kind: 'error', message: toUserMessage(e) }); }
  revalidatePath(back);
  redirect(back);
}
export async function pauseEnrollmentAction(fd: FormData): Promise<void> {
  await enrollmentTransition(fd, sequences.pauseEnrollment, 'Secuencia pausada.');
}
export async function resumeEnrollmentAction(fd: FormData): Promise<void> {
  await enrollmentTransition(fd, sequences.resumeEnrollment, 'Secuencia reanudada.');
}
export async function cancelEnrollmentAction(fd: FormData): Promise<void> {
  await enrollmentTransition(fd, sequences.cancelEnrollment, 'Secuencia cancelada.');
}

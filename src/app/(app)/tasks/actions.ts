'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { actionContext, returnTo, str } from '@/lib/action-context';
import { toUserMessage } from '@/lib/errors';
import { setFlash } from '@/lib/flash';
import type { ActionState } from '@/lib/action-state';
import * as tasks from '@/repositories/tasks';
import * as sales from '@/services/sales';
import { uuidSchema } from '@/services/schemas';

function refresh(back?: string) {
  revalidatePath('/tasks');
  revalidatePath('/');
  if (back) revalidatePath(back);
}

export async function createTaskAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const { org, db } = await actionContext();
    await sales.createTask(db, org.orgId, org.orgTimezone, {
      title: str(fd.get('title')), type: str(fd.get('type')) || undefined, priority: str(fd.get('priority')) || undefined,
      due: str(fd.get('due')), description: str(fd.get('description')),
      customerId: str(fd.get('customerId')), opportunityId: str(fd.get('opportunityId')), assigneeId: str(fd.get('assigneeId')),
    });
    const back = returnTo(fd, '/tasks');
    refresh(back);
    return { ok: true, message: 'Tarea creada.' };
  } catch (e) {
    return { ok: false, error: toUserMessage(e) };
  }
}

async function transition(fd: FormData, run: (db: Awaited<ReturnType<typeof actionContext>>['db'], id: string) => Promise<void>, ok: string) {
  const back = returnTo(fd, '/tasks');
  try {
    const { db } = await actionContext();
    await run(db, uuidSchema.parse(str(fd.get('taskId'))));
    await setFlash({ kind: 'ok', message: ok });
  } catch (e) {
    await setFlash({ kind: 'error', message: toUserMessage(e) });
  }
  refresh(back);
  redirect(back);
}

export async function startTaskAction(fd: FormData): Promise<void> {
  await transition(fd, (db, id) => tasks.startTask(db, id), 'Tarea en progreso.');
}

export async function completeTaskAction(fd: FormData): Promise<void> {
  await transition(fd, (db, id) => tasks.completeTask(db, id, str(fd.get('outcome')).trim() || undefined), 'Tarea completada.');
}
export async function cancelTaskAction(fd: FormData): Promise<void> {
  await transition(fd, (db, id) => tasks.cancelTask(db, id), 'Tarea cancelada.');
}
export async function reopenTaskAction(fd: FormData): Promise<void> {
  await transition(fd, (db, id) => tasks.reopenTask(db, id), 'Tarea reabierta.');
}

export async function logActivityAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const { db, org } = await actionContext();
    const customerId = str(fd.get('customerId'));
    await sales.logActivity(db, {
      customerId, type: str(fd.get('type')), direction: str(fd.get('direction')), summary: str(fd.get('summary')),
      opportunityId: str(fd.get('opportunityId')), occurredAt: str(fd.get('occurredAt')),
    }, org.orgTimezone);
    revalidatePath(`/customers/${customerId}`);
    revalidatePath('/activities');
    const opp = str(fd.get('opportunityId'));
    if (opp) revalidatePath(`/opportunities/${opp}`);
    return { ok: true, message: 'Actividad registrada.' };
  } catch (e) {
    return { ok: false, error: toUserMessage(e) };
  }
}

export async function editTaskAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const { db, org } = await actionContext();
    const id = uuidSchema.parse(str(fd.get('taskId')));
    await sales.editTask(db, id, org.orgTimezone, {
      title: str(fd.get('title')), type: str(fd.get('type')) || undefined, priority: str(fd.get('priority')) || undefined,
      due: str(fd.get('due')), description: str(fd.get('description')), assigneeId: str(fd.get('assigneeId')),
    });
    refresh(str(fd.get('returnTo')) || undefined);
    return { ok: true, message: 'Tarea actualizada.' };
  } catch (e) {
    return { ok: false, error: toUserMessage(e) };
  }
}

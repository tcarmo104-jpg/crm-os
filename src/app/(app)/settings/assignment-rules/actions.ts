'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { actionContext, str } from '@/lib/action-context';
import { toUserMessage } from '@/lib/errors';
import type { ActionState } from '@/lib/action-state';
import { setFlash } from '@/lib/flash';
import * as service from '@/services/assignment-rules';
import * as repo from '@/repositories/assignment-rules';

function readInput(fd: FormData) {
  return {
    name: str(fd.get('name')), active: fd.get('active') === 'on', priority: str(fd.get('priority')) || '100',
    channelKind: str(fd.get('channelKind')), widgetId: str(fd.get('widgetId')), region: str(fd.get('region')),
    teamId: str(fd.get('teamId')), hoursStart: str(fd.get('hoursStart')), hoursEnd: str(fd.get('hoursEnd')),
    hoursDays: fd.getAll('hoursDays').map((v) => Number(v)), timezone: str(fd.get('timezone')) || 'America/Bogota',
  };
}

export async function createAssignmentRuleAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const { org, db } = await actionContext();
    await service.createAssignmentRule(db, org.orgId, readInput(fd));
  } catch (e) { return { ok: false, error: toUserMessage(e) }; }
  revalidatePath('/settings/assignment-rules');
  redirect('/settings/assignment-rules');
}

export async function updateAssignmentRuleAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const id = str(fd.get('ruleId'));
  try {
    const { db } = await actionContext();
    await service.updateAssignmentRule(db, id, readInput(fd));
  } catch (e) { return { ok: false, error: toUserMessage(e) }; }
  revalidatePath('/settings/assignment-rules'); revalidatePath(`/settings/assignment-rules/${id}`);
  return { ok: true, message: 'Regla actualizada.' };
}

export async function toggleAssignmentRuleActiveAction(fd: FormData): Promise<void> {
  const { db } = await actionContext();
  const id = str(fd.get('ruleId'));
  try {
    await repo.setAssignmentRuleActive(db, id, str(fd.get('active')) === '1');
    await setFlash({ kind: 'ok', message: 'Regla actualizada.' });
  } catch (e) { await setFlash({ kind: 'error', message: toUserMessage(e) }); }
  revalidatePath('/settings/assignment-rules');
  redirect('/settings/assignment-rules');
}

export async function deleteAssignmentRuleAction(fd: FormData): Promise<void> {
  const { db } = await actionContext();
  const id = str(fd.get('ruleId'));
  try {
    await repo.deleteAssignmentRule(db, id);
    await setFlash({ kind: 'ok', message: 'Regla eliminada.' });
  } catch (e) { await setFlash({ kind: 'error', message: toUserMessage(e) }); }
  revalidatePath('/settings/assignment-rules');
  redirect('/settings/assignment-rules');
}

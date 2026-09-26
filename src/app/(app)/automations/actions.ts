'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { actionContext, str } from '@/lib/action-context';
import { toUserMessage } from '@/lib/errors';
import type { ActionState } from '@/lib/action-state';
import * as automationsService from '@/services/automations';
import * as automations from '@/repositories/automations';
import { setFlash } from '@/lib/flash';

export async function createRuleAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  let target: string;
  try {
    const { org, db } = await actionContext();
    const fields = fd.getAll('condField').map(String);
    const conditions = fields.map((field, i) => ({
      field, op: String(fd.getAll('condOp')[i] ?? 'eq'), value: String(fd.getAll('condValue')[i] ?? ''),
    })).filter((c) => c.field.trim() && c.value.trim());

    const types = fd.getAll('actType').map(String);
    const actions = types.map((type, i) => {
      const base = { type };
      if (type === 'create_task') return { ...base, title: String(fd.getAll('actTaskTitle')[i] ?? ''), taskType: String(fd.getAll('actTaskType')[i] ?? 'follow_up'), priority: String(fd.getAll('actTaskPriority')[i] ?? 'normal'), offsetDays: Number(fd.getAll('actTaskOffset')[i] ?? 0) };
      if (type === 'add_tag') return { ...base, name: String(fd.getAll('actTagName')[i] ?? '') };
      if (type === 'assign_owner') return { ...base, ownerId: String(fd.getAll('actOwnerId')[i] ?? '') || undefined };
      if (type === 'enroll_sequence') return { ...base, sequenceId: String(fd.getAll('actSequenceId')[i] ?? '') || undefined };
      return base;
    });

    const id = await automationsService.createRule(db, org.orgId, { name: str(fd.get('name')), trigger: str(fd.get('trigger')), conditions, actions });
    revalidatePath('/automations');
    await setFlash({ kind: 'ok', message: 'Automatización creada.' });
    target = `/automations/${id}`;
  } catch (e) {
    return { ok: false, error: toUserMessage(e) };
  }
  redirect(target);
}

export async function setRuleActiveAction(fd: FormData): Promise<void> {
  const { db } = await actionContext();
  const id = str(fd.get('ruleId'));
  const back = str(fd.get('returnTo')) || `/automations/${id}`;
  try {
    const active = str(fd.get('active')) === '1';
    await automations.setRuleActive(db, id, active);
    await setFlash({ kind: 'ok', message: active ? 'Automatización activada.' : 'Automatización pausada.' });
  } catch (e) {
    await setFlash({ kind: 'error', message: toUserMessage(e) });
  }
  revalidatePath('/automations'); revalidatePath(`/automations/${id}`);
  redirect(back);
}

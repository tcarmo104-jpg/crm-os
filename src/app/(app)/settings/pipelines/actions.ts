'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { actionContext, str } from '@/lib/action-context';
import { toUserMessage } from '@/lib/errors';
import { setFlash } from '@/lib/flash';
import type { ActionState } from '@/lib/action-state';
import * as pipes from '@/repositories/pipelines';
import * as sales from '@/services/sales';
import { uuidSchema } from '@/services/schemas';

async function run(fd: FormData, ok: string, fn: (ctx: Awaited<ReturnType<typeof actionContext>>) => Promise<void>) {
  try {
    await fn(await actionContext());
    await setFlash({ kind: 'ok', message: ok });
  } catch (e) {
    await setFlash({ kind: 'error', message: toUserMessage(e) });
  }
  revalidatePath('/settings/pipelines');
  revalidatePath('/opportunities');
  redirect('/settings/pipelines');
}

export async function createPipelineAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const { org, db } = await actionContext();
    await sales.createPipeline(db, org.orgId, str(fd.get('name')));
    revalidatePath('/settings/pipelines');
    return { ok: true, message: 'Pipeline creado con etapas iniciales. Ajústalas abajo.' };
  } catch (e) {
    return { ok: false, error: toUserMessage(e) };
  }
}

export async function addStageAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const { org, db } = await actionContext();
    await sales.addStage(db, org.orgId, {
      pipelineId: str(fd.get('pipelineId')), name: str(fd.get('name')), kind: str(fd.get('kind')), probability: str(fd.get('probability')) || '0',
    });
    revalidatePath('/settings/pipelines');
    return { ok: true, message: 'Etapa agregada.' };
  } catch (e) {
    return { ok: false, error: toUserMessage(e) };
  }
}

export async function renameStageAction(fd: FormData) {
  await run(fd, 'Etapa actualizada.', async ({ db }) => {
    await sales.renameStage(db, uuidSchema.parse(str(fd.get('stageId'))), str(fd.get('name')), str(fd.get('probability')), str(fd.get('kind')));
  });
}
export async function archiveStageAction(fd: FormData) {
  await run(fd, 'Etapa archivada.', async ({ db }) => pipes.archiveStage(db, uuidSchema.parse(str(fd.get('stageId')))));
}
export async function moveStageAction(fd: FormData) {
  await run(fd, 'Orden actualizado.', async ({ db, org }) => {
    const id = uuidSchema.parse(str(fd.get('stageId')));
    const dir = str(fd.get('dir')) === 'up' ? -1 : 1;
    const all = (await pipes.listPipelines(db, org.orgId, true)).flatMap((p) => p.stages);
    const me = all.find((s) => s.id === id);
    if (!me) return;
    const sibs = all.filter((s) => s.pipelineId === me.pipelineId && s.kind === me.kind && !s.archivedAt).sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
    const i = sibs.findIndex((s) => s.id === id);
    const other = sibs[i + dir];
    if (!other) return;
    // Renumera el grupo completo (10, 20, 30…) para no depender de posiciones repetidas.
    const reordered = sibs.slice(); reordered[i] = other; reordered[i + dir] = me;
    for (const [idx, s] of reordered.entries()) if (s.position !== (idx + 1) * 10) await pipes.updateStage(db, s.id, { position: (idx + 1) * 10 });
  });
}
export async function setDefaultPipelineAction(fd: FormData) {
  await run(fd, 'Pipeline predeterminado actualizado.', async ({ db }) => pipes.setDefaultPipeline(db, uuidSchema.parse(str(fd.get('pipelineId')))));
}
export async function archivePipelineAction(fd: FormData) {
  await run(fd, 'Pipeline archivado.', async ({ db }) => pipes.archivePipeline(db, uuidSchema.parse(str(fd.get('pipelineId')))));
}

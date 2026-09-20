'use server';

import { revalidatePath } from 'next/cache';
import { actionContext, str } from '@/lib/action-context';
import { toUserMessage } from '@/lib/errors';
import { setFlash } from '@/lib/flash';
import * as kanban from '@/services/kanban';

export type MoveResult = { ok: true } | { ok: false; error: string };

/**
 * Mueve una tarjeta (arrastrar y soltar). Lo llama el navegador directamente y responde SIN redirigir:
 * si falla, el tablero devuelve la tarjeta a su columna y muestra el motivo.
 * El historial (quién, cuándo, de qué etapa a cuál y por qué) lo registra la base de datos.
 */
export async function moveCardAction(input: { id: string; stageId: string; reason?: string }): Promise<MoveResult> {
  try {
    const { db } = await actionContext();
    await kanban.moveCard(db, input);
    revalidatePath('/opportunities');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: toUserMessage(e) };
  }
}

async function run(ok: string | null, fn: (db: Awaited<ReturnType<typeof actionContext>>['db']) => Promise<void>) {
  try {
    await fn((await actionContext()).db);
    if (ok) await setFlash({ kind: 'ok', message: ok });
  } catch (e) {
    await setFlash({ kind: 'error', message: toUserMessage(e) });
  }
  revalidatePath('/opportunities');
}

/** Cambiar la etapa desde el panel de detalle (alternativa accesible al arrastre). */
export async function changeStageAction(fd: FormData): Promise<void> {
  await run('Etapa actualizada.', (db) => kanban.moveCard(db, { id: str(fd.get('id')), stageId: str(fd.get('stageId')), reason: str(fd.get('reason')) }));
}
export async function setFieldsAction(fd: FormData): Promise<void> {
  await run('Cambios guardados.', (db) => kanban.setFields(db, {
    id: str(fd.get('id')), ...(fd.has('priority') ? { priority: str(fd.get('priority')) } : {}),
    ...(fd.has('temperature') ? { temperature: str(fd.get('temperature')) } : {}), ...(fd.has('channel') ? { channel: str(fd.get('channel')) } : {}),
  }));
}
export async function logActivityAction(fd: FormData): Promise<void> {
  await run('Actividad registrada.', async (db) => {
    await kanban.logActivity(db, { opportunityId: str(fd.get('id')), customerId: str(fd.get('customerId')), type: str(fd.get('type')), summary: str(fd.get('summary')), direction: str(fd.get('direction')) });
  });
}
export async function linkConversationAction(fd: FormData): Promise<void> {
  await run('Conversación vinculada.', (db) => kanban.linkConversation(db, { id: str(fd.get('id')), conversationId: str(fd.get('conversationId')) }));
}

'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { actionContext, str } from '@/lib/action-context';
import { toUserMessage } from '@/lib/errors';
import { setFlash } from '@/lib/flash';
import * as repo from '@/repositories/inbox';
import * as inbox from '@/services/inbox';
import { uuidSchema } from '@/services/schemas';
import { createAdminClient } from '@/server/supabase-admin';
import { deliverMessage } from '@/server/outbound';

/**
 * El mensaje lo encola la propia persona (la base de datos valida permiso, ventana de 24 h y «no contactar»).
 * Solo la ENTREGA usa la llave de servicio, porque el token de Meta no es legible por ningún usuario.
 * Se entrega únicamente el id que esa persona acaba de crear.
 */
async function deliverAndReport(db: Awaited<ReturnType<typeof actionContext>>['db'], messageId: string) {
  let outcome: Awaited<ReturnType<typeof deliverMessage>> = 'unknown';
  try { outcome = await deliverMessage(createAdminClient(), messageId); } catch { outcome = 'unknown'; }
  if (outcome === 'failed') {
    const m = await repo.getMessageOutcome(db, messageId).catch(() => null);
    await setFlash({ kind: 'error', message: m?.error ?? 'WhatsApp no aceptó el mensaje.' });
  } else if (outcome === 'unknown') {
    await setFlash({ kind: 'error', message: 'No pudimos confirmar el envío. Espera un momento y revisa el estado del mensaje antes de reenviarlo.' });
  }
}

export async function sendMessageAction(fd: FormData): Promise<void> {
  const id = str(fd.get('conversationId'));
  const back = `/inbox/${uuidSchema.safeParse(id).success ? id : ''}`;
  try {
    const { db } = await actionContext();
    const messageId = await inbox.sendMessage(db, { conversationId: id, body: str(fd.get('body')) });
    await deliverAndReport(db, messageId);
  } catch (e) {
    await setFlash({ kind: 'error', message: toUserMessage(e) });
  }
  revalidatePath(back);
  redirect(back);
}

export async function sendTemplateAction(fd: FormData): Promise<void> {
  const id = str(fd.get('conversationId'));
  const back = `/inbox/${uuidSchema.safeParse(id).success ? id : ''}`;
  try {
    const { db } = await actionContext();
    const params = Array.from({ length: 10 }, (_, i) => str(fd.get(`p${i + 1}`))).filter((_, i) => fd.has(`p${i + 1}`));
    const messageId = await inbox.sendTemplate(db, { conversationId: id, templateId: str(fd.get('templateId')), params });
    await deliverAndReport(db, messageId);
  } catch (e) {
    await setFlash({ kind: 'error', message: toUserMessage(e) });
  }
  revalidatePath(back);
  redirect(back);
}

export async function setConversationStatusAction(fd: FormData): Promise<void> {
  const id = str(fd.get('conversationId'));
  const status = str(fd.get('status')) === 'closed' ? 'closed' : 'open';
  try {
    const { db } = await actionContext();
    await repo.setConversationStatus(db, uuidSchema.parse(id), status);
    await setFlash({ kind: 'ok', message: status === 'closed' ? 'Conversación cerrada. Si el cliente vuelve a escribir, se reabre sola.' : 'Conversación reabierta.' });
  } catch (e) {
    await setFlash({ kind: 'error', message: toUserMessage(e) });
  }
  revalidatePath('/inbox');
  redirect(`/inbox/${uuidSchema.safeParse(id).success ? id : ''}`);
}

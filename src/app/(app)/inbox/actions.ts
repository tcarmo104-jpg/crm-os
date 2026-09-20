'use server';

import { revalidatePath } from 'next/cache';
import { actionContext, str } from '@/lib/action-context';
import { toUserMessage } from '@/lib/errors';
import { setFlash } from '@/lib/flash';
import * as repo from '@/repositories/inbox';
import * as inbox from '@/services/inbox';
import * as customers from '@/services/customers';
import { uuidSchema } from '@/services/schemas';
import { createAdminClient } from '@/server/supabase-admin';
import { deliverMessage } from '@/server/outbound';

/**
 * Al terminar, los datos de la pantalla se refrescan EN SU SITIO (sin redirección): el formulario ya está en la
 * misma vista, así que no hay recarga ni parpadeo, y filtros, scroll y borradores se conservan.
 */
async function finish(ok?: string): Promise<void> {
  if (ok) await setFlash({ kind: 'ok', message: ok });
  revalidatePath('/inbox');
}
async function fail(e: unknown): Promise<void> {
  await setFlash({ kind: 'error', message: toUserMessage(e) });
  revalidatePath('/inbox');
}

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
  try {
    const { db } = await actionContext();
    const id = await inbox.sendMessage(db, { conversationId: str(fd.get('conversationId')), body: str(fd.get('body')) });
    await deliverAndReport(db, id);
  } catch (e) { return fail(e); }
  return finish();
}

export async function sendTemplateAction(fd: FormData): Promise<void> {
  try {
    const { db } = await actionContext();
    const params = Array.from({ length: 10 }, (_, i) => str(fd.get(`p${i + 1}`))).filter((_, i) => fd.has(`p${i + 1}`));
    const id = await inbox.sendTemplate(db, { conversationId: str(fd.get('conversationId')), templateId: str(fd.get('templateId')), params });
    await deliverAndReport(db, id);
  } catch (e) { return fail(e); }
  return finish();
}

/** Nota interna: queda en la ficha del cliente y en el hilo; NO sale hacia WhatsApp. */
export async function sendNoteAction(fd: FormData): Promise<void> {
  try {
    const { db } = await actionContext();
    await inbox.sendNote(db, { customerId: str(fd.get('customerId')), body: str(fd.get('body')) });
  } catch (e) { return fail(e); }
  return finish();
}

export async function setConversationStatusAction(fd: FormData): Promise<void> {
  const status = str(fd.get('status')) === 'closed' ? 'closed' : 'open';
  try {
    const { db } = await actionContext();
    await repo.setConversationStatus(db, uuidSchema.parse(str(fd.get('conversationId'))), status);
    return finish(status === 'closed' ? 'Conversación cerrada. Si el cliente vuelve a escribir, se reabre sola.' : 'Conversación reabierta.');
  } catch (e) { return fail(e); }
}

export async function assignOwnerAction(fd: FormData): Promise<void> {
  const owner = str(fd.get('ownerId'));
  try {
    const { db } = await actionContext();
    await customers.assignOwner(db, uuidSchema.parse(str(fd.get('customerId'))), owner === '' ? null : owner);
    return finish(owner === '' ? 'Conversación sin asesor asignado.' : 'Asesor asignado.');
  } catch (e) { return fail(e); }
}

export async function addTagAction(fd: FormData): Promise<void> {
  try {
    const { db } = await actionContext();
    await inbox.addTag(db, { customerId: str(fd.get('customerId')), name: str(fd.get('name')), color: str(fd.get('color')) });
  } catch (e) { return fail(e); }
  return finish();
}

export async function removeTagAction(fd: FormData): Promise<void> {
  try {
    const { db } = await actionContext();
    await inbox.removeTag(db, { customerId: str(fd.get('customerId')), tagId: str(fd.get('tagId')) });
  } catch (e) { return fail(e); }
  return finish();
}

export async function createQuickReplyAction(fd: FormData): Promise<void> {
  try {
    const { db, org } = await actionContext();
    await inbox.createQuickReply(db, org.orgId, { title: str(fd.get('title')), body: str(fd.get('body')) });
  } catch (e) { return fail(e); }
  return finish('Respuesta rápida guardada.');
}

export async function deleteQuickReplyAction(fd: FormData): Promise<void> {
  try {
    const { db } = await actionContext();
    await inbox.deleteQuickReply(db, str(fd.get('id')));
  } catch (e) { return fail(e); }
  return finish('Respuesta rápida eliminada.');
}

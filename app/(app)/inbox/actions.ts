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
import { after } from 'next/server';
import { cancelUpload, createSupabaseMediaStore, prepareUpload, sendAttachments, type PrepareResult } from '@/server/media';

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


// ---------------------------------------------------------------------------------------------- archivos
// Estas acciones devuelven un resultado (no redirigen): las llama el redactor desde el navegador mientras el agente escribe.
type Fail = { ok: false; message: string };
const failure = (e: unknown): Fail => ({ ok: false, message: toUserMessage(e) });

/** Paso 1: valida el archivo con las reglas del canal y entrega el enlace firmado para subirlo directo al almacén privado. */
export async function prepareAttachmentAction(input: { conversationId: string; fileName: string; mime: string; size: number }): Promise<PrepareResult | Fail> {
  try {
    const { db } = await actionContext();
    return await prepareUpload(db, createSupabaseMediaStore(createAdminClient()), {
      conversationId: String(input.conversationId), fileName: String(input.fileName ?? ''), mime: String(input.mime ?? ''), size: Number(input.size),
    });
  } catch (e) { return failure(e); }
}

/** El agente quitó el archivo antes de enviarlo: se borra lo subido. */
export async function cancelAttachmentAction(uploadId: string): Promise<void> {
  try { const { db } = await actionContext(); await cancelUpload(db, createSupabaseMediaStore(createAdminClient()), String(uploadId)); } catch { /* la limpieza periódica lo cubre */ }
}

/** Un mensaje que quedó en cola y ya no debe salir (por ejemplo, el texto que acompañaba a un archivo que falló). */
async function abandonQueued(admin: ReturnType<typeof createAdminClient>, id: string, why: string) {
  const c = await admin.rpc('claim_outbound', { p_message: id });
  if (c.data) await admin.rpc('finish_outbound', { p_message: id, p_ok: false, p_error_code: 'media_failed', p_error: why });
}

/**
 * Paso 2 («Enviar»): el servidor verifica los archivos por su contenido, encola el mensaje y lo entrega. Si la entrega tarda (archivos
 * grandes) se sigue en segundo plano y el mensaje queda «Enviando» hasta que Meta o Google respondan.
 */
export async function sendAttachmentsAction(input: { conversationId: string; uploadIds: string[]; caption?: string }): Promise<{ ok: true; note?: string } | Fail> {
  try {
    const { db, session } = await actionContext();
    const admin = createAdminClient(); const store = createSupabaseMediaStore(admin);
    const ids = await sendAttachments(db, admin, store, { userId: session.user.id, conversationId: String(input.conversationId), uploadIds: (input.uploadIds ?? []).map(String), caption: input.caption ?? null });
    let note: string | undefined;
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]!;
      const run = deliverMessage(admin, id, undefined, { store });
      const outcome = await Promise.race([run.catch(() => 'unknown' as const), new Promise<'pending'>((r) => setTimeout(() => r('pending'), 25_000))]);
      if (outcome === 'pending') {                     // sigue en segundo plano; lo que venga después lo recoge el barrido
        after(async () => { await run.catch(() => undefined); });
        note = 'El archivo se está enviando; verás el estado en unos segundos.';
        break;
      }
      if (outcome !== 'sent') {
        // El mensaje YA existe (queda en la conversación como «no se envió»): el motivo se muestra como aviso y el texto que lo acompañaba NO sale.
        for (const rest of ids.slice(i + 1)) await abandonQueued(admin, rest, 'No se envió porque el archivo anterior falló.').catch(() => undefined);
        const m = await repo.getMessageOutcome(db, id).catch(() => null);
        await setFlash({ kind: 'error', message: outcome === 'failed' ? (m?.error ?? 'El canal no aceptó el archivo.') : 'No pudimos confirmar el envío. Revisa el estado del mensaje antes de reenviarlo.' });
        break;
      }
    }
    revalidatePath('/inbox');
    return { ok: true, note };
  } catch (e) { return failure(e); }
}

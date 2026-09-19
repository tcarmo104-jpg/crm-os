'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { actionContext, str } from '@/lib/action-context';
import { toUserMessage } from '@/lib/errors';
import { setFlash } from '@/lib/flash';
import * as repo from '@/repositories/inbox';
import * as inbox from '@/services/inbox';
import { uuidSchema } from '@/services/schemas';

async function run(ok: string, fn: (ctx: Awaited<ReturnType<typeof actionContext>>) => Promise<void>) {
  try {
    await fn(await actionContext());
    await setFlash({ kind: 'ok', message: ok });
  } catch (e) {
    await setFlash({ kind: 'error', message: toUserMessage(e) });
  }
  revalidatePath('/settings/channels');
  redirect('/settings/channels');
}

export async function createChannelAction(fd: FormData) {
  await run('Canal creado. Ahora configura el webhook en Meta con los datos de esta pantalla.', async ({ org, db }) => {
    await inbox.createChannel(db, org.orgId, { name: str(fd.get('name')), phoneNumberId: str(fd.get('phoneNumberId')), displayPhone: str(fd.get('displayPhone')), token: str(fd.get('token')) });
  });
}
export async function saveTokenAction(fd: FormData) {
  await run('Token actualizado.', async ({ db }) => { await inbox.saveToken(db, uuidSchema.parse(str(fd.get('channelId'))), { token: str(fd.get('token')) }); });
}
export async function setChannelStatusAction(fd: FormData) {
  const status = str(fd.get('status')) === 'paused' ? 'paused' : 'active';
  await run(status === 'paused' ? 'Canal en pausa: no se enviarán mensajes (los que lleguen se siguen guardando).' : 'Canal activo.',
    async ({ db }) => { await repo.setChannelStatus(db, uuidSchema.parse(str(fd.get('channelId'))), status); });
}
export async function createTemplateAction(fd: FormData) {
  await run('Plantilla guardada.', async ({ org, db }) => {
    await inbox.createTemplate(db, org.orgId, { channelId: str(fd.get('channelId')), name: str(fd.get('name')), language: str(fd.get('language')) || 'es', body: str(fd.get('body')) });
  });
}
export async function setTemplateStatusAction(fd: FormData) {
  const status = str(fd.get('status')) === 'disabled' ? 'disabled' : 'approved';
  await run(status === 'disabled' ? 'Plantilla desactivada.' : 'Plantilla activada.', async ({ db }) => { await repo.setTemplateStatus(db, uuidSchema.parse(str(fd.get('templateId'))), status); });
}

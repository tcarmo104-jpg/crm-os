'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { actionContext, returnTo, str } from '@/lib/action-context';
import { PROVIDER_NAME, outcomeNotice } from '@/lib/connections';
import { UserFacingError, toUserMessage } from '@/lib/errors';
import { setFlash } from '@/lib/flash';
import { can } from '@/lib/session';
import * as repo from '@/repositories/inbox';
import { connectMetaSelection, connectWhatsApp, resolveManagedChannel, syncGmail, verifyChannel } from '@/server/connections';
import { verifyGoogleClient } from '@/server/gmail';
import { configureReceptionWebhook, connectMetaApp, describeConfigured } from '@/server/meta-webhook';
import { serverOrigin } from '@/server/origin';
import { removeProviderApp, saveProviderApp } from '@/server/provider-apps';
import { createAdminClient } from '@/server/supabase-admin';
import * as inbox from '@/services/inbox';

type Ctx = Awaited<ReturnType<typeof actionContext>>;

/**
 * Toda acción de este módulo exige permiso de administración Y que la conexión sea de la organización activa.
 * Se comprueba AQUÍ antes de usar el cliente de servidor (que se salta la seguridad por filas).
 */
const guard = (ctx: Ctx, channelId: string) => resolveManagedChannel(ctx.db, ctx.org.orgId, can(ctx.session, 'settings:manage'), channelId);

async function run(back: string, fn: (ctx: Ctx) => Promise<{ kind: 'ok' | 'error'; message: string } | string>) {
  try {
    const r = await fn(await actionContext());
    await setFlash(typeof r === 'string' ? { kind: 'ok', message: r } : r);
  } catch (e) {
    await setFlash({ kind: 'error', message: toUserMessage(e) });
  }
  revalidatePath('/settings/connections', 'layout');
  revalidatePath('/inbox');
  redirect(back);
}

const LIST = '/settings/connections';

export async function connectWhatsAppAction(fd: FormData) {
  await run(LIST, async ({ org, db, session }) => {
    if (!can(session, 'settings:manage')) throw new UserFacingError('Solo un administrador puede gestionar las conexiones.');
    const r = await connectWhatsApp(db, createAdminClient(), org.orgId, {
      name: str(fd.get('name')), phoneNumberId: str(fd.get('phoneNumberId')), businessAccountId: str(fd.get('businessAccountId')), token: str(fd.get('token')),
    });
    const n = outcomeNotice(r.outcome.state, 'WhatsApp', r.outcome.accountName);
    return r.outcome.state === 'connected' ? { kind: 'ok', message: `${r.reconnected ? 'Número reconectado' : 'Número conectado'}. ${n.message}` } : n;
  });
}

export async function verifyConnectionAction(fd: FormData) {
  const back = returnTo(fd, LIST);
  await run(back, async (ctx) => {
    const id = await guard(ctx, str(fd.get('channelId')));
    const r = await verifyChannel(createAdminClient(), id);
    return outcomeNotice(r.state, PROVIDER_NAME[r.kind ?? 'whatsapp'], r.accountName);
  });
}

export async function saveConnectionTokenAction(fd: FormData) {
  const back = returnTo(fd, LIST);
  await run(back, async (ctx) => {
    const id = await guard(ctx, str(fd.get('channelId')));
    await inbox.saveToken(ctx.db, id, { token: str(fd.get('token')) });
    const r = await verifyChannel(createAdminClient(), id);        // guardar y comprobar, en un solo paso
    const n = outcomeNotice(r.state, 'WhatsApp', r.accountName);
    return r.state === 'connected' ? { kind: 'ok', message: `Token guardado. ${n.message}` } : n;
  });
}

export async function setBusinessAccountAction(fd: FormData) {
  const back = returnTo(fd, LIST);
  await run(back, async (ctx) => {
    const id = await guard(ctx, str(fd.get('channelId')));
    const waba = str(fd.get('businessAccountId')).trim();
    if (!/^\d{5,30}$/.test(waba)) throw new UserFacingError('El ID de la cuenta de WhatsApp Business son solo dígitos.');
    await repo.setBusinessAccount(ctx.db, id, waba);
    const r = await verifyChannel(createAdminClient(), id);
    return outcomeNotice(r.state, 'WhatsApp', r.accountName);
  });
}

export async function disconnectConnectionAction(fd: FormData) {
  await run(LIST, async (ctx) => {
    const id = await guard(ctx, str(fd.get('channelId')));
    await repo.disconnectChannel(ctx.db, id);
    return 'Número desconectado. Ya no recibe ni envía mensajes; tu historial se conserva.';
  });
}

export async function toggleConnectionStatusAction(fd: FormData) {
  const back = returnTo(fd, LIST);
  const status = str(fd.get('status')) === 'paused' ? 'paused' : 'active';
  await run(back, async (ctx) => {
    const id = await guard(ctx, str(fd.get('channelId')));
    await repo.setChannelStatus(ctx.db, id, status);
    return status === 'paused' ? 'Número en pausa: no se enviarán mensajes (los que lleguen se siguen guardando).' : 'Número reactivado.';
  });
}

/** Conecta las páginas de Facebook (y cuentas de Instagram) que el administrador marcó tras autorizar en Meta. */
export async function connectMetaSelectionAction(fd: FormData) {
  await run(LIST, async ({ org, db, session }) => {
    if (!can(session, 'settings:manage')) throw new UserFacingError('Solo un administrador puede gestionar las conexiones.');
    const sid = str(fd.get('sid'));
    if (!/^[0-9a-f-]{36}$/i.test(sid)) throw new UserFacingError('La autorización venció. Empieza de nuevo desde «Conectar».');
    const ids = [...new Set([...fd.keys()].filter((k) => /^(fb|ig):\d{5,30}$/.test(k)).map((k) => k.slice(3)))];
    const selection = ids.map((pageId) => ({ pageId, facebook: fd.get(`fb:${pageId}`) === 'on', instagram: fd.get(`ig:${pageId}`) === 'on' }));
    const done = await connectMetaSelection(db, createAdminClient(), { orgId: org.orgId, userId: session.user.id, sid, selection });
    const bad = done.filter((d) => d.state !== 'connected');
    const names = done.map((d) => `${d.kind === 'facebook' ? 'Facebook' : 'Instagram'} ${d.name}`).join(', ');
    return bad.length === 0
      ? { kind: 'ok' as const, message: `Conectado: ${names}. Sus mensajes llegan al Inbox.` }
      : { kind: 'error' as const, message: `Se guardó ${names}, pero ${bad.length === 1 ? 'una cuenta necesita atención' : `${bad.length} cuentas necesitan atención`}. Entra a «Configurar» para ver el estado.` };
  });
}

/** Trae ahora los correos nuevos de una cuenta de Gmail (además de la revisión automática). */
export async function syncGmailAction(fd: FormData) {
  const back = returnTo(fd, LIST);
  await run(back, async (ctx) => {
    const id = await guard(ctx, str(fd.get('channelId')));
    const r = await syncGmail(createAdminClient(), id);
    if (r.note === 'transient') return { kind: 'error' as const, message: 'No pudimos comunicarnos con Google. Inténtalo de nuevo en unos minutos.' };
    if (r.note && r.note !== 'partial') return outcomeNotice('needs_auth', 'Gmail');
    return r.ingested > 0 ? `Listo: ${r.ingested} ${r.ingested === 1 ? 'correo nuevo' : 'correos nuevos'} en tu Inbox.` : 'Sin correos nuevos. Solo se traen mensajes directos de personas (no promociones ni notificaciones).';
  });
}

/** Deja configurado el webhook en la app de Meta (dirección + token + campo «messages») sin que la persona copie nada. */
export async function configureWebhookAction(fd: FormData) {
  const back = returnTo(fd, LIST);
  await run(back, async (ctx) => {
    const id = await guard(ctx, str(fd.get('channelId')));
    const admin = createAdminClient();
    const r = await configureReceptionWebhook(admin, { channelId: id, orgId: ctx.org.orgId, origin: await serverOrigin() });
    if (!r.ok) return { kind: 'error' as const, message: r.message };
    await verifyChannel(admin, id);                       // de paso, vuelve a suscribir la cuenta de WhatsApp Business
    return `Listo: ${describeConfigured(r)} Ahora responde el mensaje de prueba desde tu celular: debe aparecer en el Inbox.`;
  });
}

/** «Tu aplicación de Meta»: comprueba el Identificador y la Clave secreta con Meta, los guarda cifrados y configura el webhook. Nada de Vercel. */
export async function saveMetaAppAction(fd: FormData) {
  await run(returnTo(fd, LIST), async ({ org, db, session }) => {
    if (!can(session, 'settings:manage')) throw new UserFacingError('Solo un administrador puede conectar la aplicación de Meta.');
    const r = await connectMetaApp(db, { orgId: org.orgId, appId: str(fd.get('appId')), secret: str(fd.get('appSecret')), origin: await serverOrigin() });
    if (!r.ok) return { kind: 'error' as const, message: r.message };
    const name = r.appName ? `«${r.appName}»` : 'de Meta';
    return r.webhook.ok
      ? `Tu aplicación ${name} quedó conectada: ${describeConfigured(r.webhook)} Ahora conecta tus canales, o responde el mensaje de prueba desde tu celular.`
      : { kind: 'error' as const, message: `Guardamos tu aplicación ${name}, pero no pudimos configurar el webhook: ${r.webhook.message}` };
  });
}
export async function removeMetaAppAction(fd: FormData) {
  await run(returnTo(fd, LIST), async ({ org, db, session }) => {
    if (!can(session, 'settings:manage')) throw new UserFacingError('Solo un administrador puede quitar la aplicación de Meta.');
    await removeProviderApp(db, org.orgId, 'meta');
    return 'Quitamos tu aplicación de Meta del CRM. Tus mensajes dejarán de llegar hasta que la vuelvas a conectar.';
  });
}

/** «Tu aplicación de Google»: comprueba el ID de cliente y el secreto con Google y los guarda cifrados. */
export async function saveGoogleAppAction(fd: FormData) {
  await run(returnTo(fd, LIST), async ({ org, db, session }) => {
    if (!can(session, 'settings:manage')) throw new UserFacingError('Solo un administrador puede conectar la aplicación de Google.');
    const clientId = str(fd.get('clientId')).trim(), secret = str(fd.get('clientSecret')).trim();
    if (clientId.length < 10 || /\s/.test(clientId)) throw new UserFacingError('El ID de cliente de Google termina en «.apps.googleusercontent.com». Cópialo de Google Cloud → Credenciales.');
    if (secret.length < 8 || /\s/.test(secret)) throw new UserFacingError('El secreto de cliente de Google empieza con «GOCSPX-». Cópialo de Google Cloud → Credenciales.');
    if ((await verifyGoogleClient({ clientId, clientSecret: secret })) === 'bad') throw new UserFacingError('Google no reconoce esa combinación: el ID de cliente y el secreto deben ser del MISMO cliente OAuth. Vuelve a copiarlos.');
    await saveProviderApp(db, org.orgId, 'google', { clientId, secret });
    return 'Tu aplicación de Google quedó conectada. Ahora puedes conectar tu cuenta de Gmail.';
  });
}
export async function removeGoogleAppAction(fd: FormData) {
  await run(returnTo(fd, LIST), async ({ org, db, session }) => {
    if (!can(session, 'settings:manage')) throw new UserFacingError('Solo un administrador puede quitar la aplicación de Google.');
    await removeProviderApp(db, org.orgId, 'google');
    return 'Quitamos tu aplicación de Google del CRM.';
  });
}

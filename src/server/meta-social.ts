import 'server-only';
import { describeSocialError } from '@/lib/connections';
import type { SocialKind } from '@/lib/social';
import type { SendResult } from './whatsapp';
import { graphCall, type GraphOpts, type GraphResult } from './whatsapp-graph';

const ID = /^\d{5,30}$/;
const badId = (): GraphResult<never> => ({ ok: false, kind: 'rejected', state: 'needs_auth', code: 'bad_id', detail: 'El identificador no tiene un formato válido.' });
export const SUBSCRIBED_FIELDS = 'messages,messaging_postbacks,message_deliveries,message_reads';

export interface MetaApp { appId: string; appSecret: string }

/** Cambia el código que devuelve Meta tras el inicio de sesión por un token de usuario (el secreto va en el cuerpo, nunca en la URL). */
export function exchangeMetaCode(code: string, redirectUri: string, app: MetaApp, o: GraphOpts = {}) {
  return graphCall<{ access_token?: string }>('POST', 'oauth/access_token', null, { ...o, form: { client_id: app.appId, client_secret: app.appSecret, redirect_uri: redirectUri, code } });
}
/** Token de larga duración: los tokens de página que se obtienen de él no caducan. */
export function extendMetaToken(shortToken: string, app: MetaApp, o: GraphOpts = {}) {
  return graphCall<{ access_token?: string }>('POST', 'oauth/access_token', null, { ...o, form: { grant_type: 'fb_exchange_token', client_id: app.appId, client_secret: app.appSecret, fb_exchange_token: shortToken } });
}

export interface MetaPage { id: string; name: string; token: string; ig: { id: string; username: string | null; name: string | null } | null }
/** Páginas que administra la persona, con el token de cada una y la cuenta de Instagram profesional asociada (si la hay). */
export async function listPages(userToken: string, o: GraphOpts = {}): Promise<GraphResult<MetaPage[]>> {
  const r = await graphCall<{ data?: { id?: string; name?: string; access_token?: string; instagram_business_account?: { id?: string; username?: string; name?: string } }[] }>(
    'GET', 'me/accounts', userToken, { ...o, params: { fields: 'id,name,access_token,instagram_business_account{id,username,name}', limit: '100' } });
  if (!r.ok) return r;
  const pages: MetaPage[] = [];
  for (const p of r.data.data ?? []) {
    if (!p.id || !ID.test(p.id) || !p.access_token) continue;
    const ig = p.instagram_business_account;
    pages.push({ id: p.id, name: (p.name ?? p.id).slice(0, 120), token: p.access_token,
      ig: ig?.id && ID.test(ig.id) ? { id: ig.id, username: ig.username ?? null, name: ig.name ?? null } : null });
  }
  return { ok: true, data: pages };
}

export async function fetchPage(pageId: string, token: string, o: GraphOpts = {}): Promise<GraphResult<{ id?: string; name?: string }>> {
  if (!ID.test(pageId)) return badId();
  return graphCall('GET', pageId, token, { ...o, params: { fields: 'id,name' } });
}
export async function fetchIgAccount(igId: string, token: string, o: GraphOpts = {}): Promise<GraphResult<{ id?: string; username?: string; name?: string }>> {
  if (!ID.test(igId)) return badId();
  return graphCall('GET', igId, token, { ...o, params: { fields: 'id,username,name' } });
}

/** ¿Nuestra app está suscrita a los mensajes de la página? (se suscribe con `subscribePage`). */
export async function pageSubscription(pageId: string, token: string, appId: string, o: GraphOpts = {}): Promise<GraphResult<boolean>> {
  if (!ID.test(pageId)) return badId();
  const r = await graphCall<{ data?: { id?: string; subscribed_fields?: string[] }[] }>('GET', `${pageId}/subscribed_apps`, token, o);
  if (!r.ok) return r;
  const apps = r.data.data ?? [];
  const mine = appId ? apps.filter((a) => a.id === appId) : apps;
  return { ok: true, data: mine.some((a) => (a.subscribed_fields ?? []).includes('messages')) };
}
export async function subscribePage(pageId: string, token: string, o: GraphOpts = {}): Promise<GraphResult<true>> {
  if (!ID.test(pageId)) return badId();
  const r = await graphCall<{ success?: boolean }>('POST', `${pageId}/subscribed_apps`, token, { ...o, form: { subscribed_fields: SUBSCRIBED_FIELDS } });
  if (!r.ok) return r;
  return r.data.success === false ? { ok: false, kind: 'rejected', state: null, code: 'subscribe_failed', detail: 'Meta no confirmó la suscripción de la página.' } : { ok: true, data: true };
}

/** Nombre del contacto (Meta no lo incluye en el webhook). Mejor esfuerzo: si falla, se queda el nombre provisional. */
export async function fetchContactName(kind: SocialKind, contactId: string, token: string, o: GraphOpts = {}): Promise<string | null> {
  const p = await fetchContactProfile(kind, contactId, token, o);
  return p?.name ?? null;
}

export interface ContactProfile { name: string | null; avatarUrl: string | null }
/** Nombre y foto del contacto en una sola llamada a Meta (Meta no incluye ninguno de los dos en el webhook).
 * Mejor esfuerzo: si falla, ambos quedan en null y no se toca lo que ya había. */
export async function fetchContactProfile(kind: SocialKind, contactId: string, token: string, o: GraphOpts = {}): Promise<ContactProfile | null> {
  if (!ID.test(contactId)) return null;
  const r = await graphCall<{ name?: string; username?: string; profile_pic?: string }>('GET', contactId, token, { ...o, params: { fields: kind === 'instagram' ? 'name,username,profile_pic' : 'name,profile_pic' } });
  if (!r.ok) return null;
  const name = (r.data.name ?? r.data.username ?? null)?.trim().slice(0, 160) || null;
  const avatarUrl = typeof r.data.profile_pic === 'string' && r.data.profile_pic.startsWith('https://') ? r.data.profile_pic : null;
  return { name, avatarUrl };
}

export interface SocialSend { token: string; to: string; body: string; fetchImpl?: typeof fetch; timeoutMs?: number }
/**
 * Responde a un contacto de Messenger/Instagram (dentro de la ventana de 24 h). Distingue rechazo definitivo (no salió)
 * de resultado desconocido (red, 5xx): este último NO se reintenta solo, para no enviar dos veces.
 */
export async function sendSocial(i: SocialSend): Promise<SendResult> {
  if (!ID.test(i.to)) return { ok: false, definitive: true, code: 'bad_recipient', message: 'El contacto no tiene un identificador válido.' };
  const r = await graphCall<{ message_id?: string }>('POST', 'me/messages', i.token, { fetchImpl: i.fetchImpl, timeoutMs: i.timeoutMs, json: { recipient: { id: i.to }, messaging_type: 'RESPONSE', message: { text: i.body } } });
  if (r.ok) return typeof r.data.message_id === 'string' && r.data.message_id ? { ok: true, externalId: r.data.message_id } : { ok: false, definitive: false, message: 'Respuesta inesperada de Meta.' };
  if (r.kind === 'transient') return { ok: false, definitive: false, message: 'No se pudo confirmar el envío (sin respuesta de Meta).' };
  return { ok: false, definitive: true, code: r.code, subcode: r.subcode ?? null, message: describeSocialError(r.code, r.subcode, r.detail) };
}

export interface SocialAttachmentSend { token: string; to: string; type: 'image' | 'video' | 'audio' | 'file'; bytes: Uint8Array; mime: string; fileName: string; fetchImpl?: typeof fetch; timeoutMs?: number }
/**
 * Envía un archivo a un contacto de Messenger/Instagram subiéndolo en la misma petición (multipart, «filedata»). Meta no admite
 * texto y archivo en un mismo mensaje: el texto se envía aparte. Un rechazo definitivo NO salió; red/5xx = desconocido (no se reenvía).
 */
export async function sendSocialAttachment(i: SocialAttachmentSend): Promise<SendResult> {
  if (!ID.test(i.to)) return { ok: false, definitive: true, code: 'bad_recipient', message: 'El contacto no tiene un identificador válido.' };
  const form = new FormData();
  form.append('recipient', JSON.stringify({ id: i.to }));
  form.append('messaging_type', 'RESPONSE');
  form.append('message', JSON.stringify({ attachment: { type: i.type, payload: { is_reusable: false } } }));
  form.append('filedata', new Blob([i.bytes as BlobPart], { type: i.mime }), i.fileName);
  const r = await graphCall<{ message_id?: string }>('POST', 'me/messages', i.token, { fetchImpl: i.fetchImpl, timeoutMs: i.timeoutMs ?? 60_000, multipart: form });
  if (r.ok) return typeof r.data.message_id === 'string' && r.data.message_id ? { ok: true, externalId: r.data.message_id } : { ok: false, definitive: false, message: 'Respuesta inesperada de Meta.' };
  if (r.kind === 'transient') return { ok: false, definitive: false, message: 'No se pudo confirmar el envío (sin respuesta de Meta).' };
  return { ok: false, definitive: true, code: r.code, subcode: r.subcode ?? null, message: describeSocialError(r.code, r.subcode, r.detail) };
}

// ---------------------------------------------------------------------------------------------- comentarios
const COMMENT_ID = /^[0-9_]{3,60}$/;

export interface PostSummary { externalId: string; permalink: string | null; caption: string | null; createdAt: string | null }
/** Publicaciones recientes de la Página (Facebook) o la cuenta (Instagram), más nuevas primero. */
export async function fetchRecentPosts(kind: SocialKind, accountId: string, token: string, limit = 10, o: GraphOpts = {}): Promise<PostSummary[] | null> {
  if (!ID.test(accountId)) return null;
  const fields = kind === 'instagram' ? 'id,permalink,caption,timestamp' : 'id,permalink_url,message,created_time';
  const r = await graphCall<{ data?: Record<string, unknown>[] }>('GET', `${accountId}/${kind === 'instagram' ? 'media' : 'posts'}`, token, { ...o, params: { fields, limit: String(Math.min(limit, 25)) } });
  if (!r.ok || !Array.isArray(r.data.data)) return null;
  return r.data.data.map((p) => ({
    externalId: String(p.id ?? ''),
    permalink: typeof p.permalink_url === 'string' ? p.permalink_url : typeof p.permalink === 'string' ? p.permalink : null,
    caption: typeof p.message === 'string' ? p.message : typeof p.caption === 'string' ? p.caption : null,
    createdAt: typeof p.created_time === 'string' ? p.created_time : typeof p.timestamp === 'string' ? p.timestamp : null,
  })).filter((p) => p.externalId);
}

/** Datos de UNA publicación (para completar una que ya guardamos solo con su id, la primera vez que se vio por el webhook). */
export async function fetchPostMeta(kind: SocialKind, postId: string, token: string, o: GraphOpts = {}): Promise<PostSummary | null> {
  if (!COMMENT_ID.test(postId)) return null;
  const fields = kind === 'instagram' ? 'id,permalink,caption,timestamp' : 'id,permalink_url,message,created_time';
  const r = await graphCall<Record<string, unknown>>('GET', postId, token, { ...o, params: { fields } });
  if (!r.ok) return null;
  return {
    externalId: postId,
    permalink: typeof r.data.permalink_url === 'string' ? r.data.permalink_url : typeof r.data.permalink === 'string' ? r.data.permalink : null,
    caption: typeof r.data.message === 'string' ? r.data.message : typeof r.data.caption === 'string' ? r.data.caption : null,
    createdAt: typeof r.data.created_time === 'string' ? r.data.created_time : typeof r.data.timestamp === 'string' ? r.data.timestamp : null,
  };
}

export type CommentActionResult = { ok: true } | { ok: false; message: string };
const describeCommentError = (r: GraphResult<unknown> & { ok: false }) =>
  r.kind === 'transient' ? 'No se pudo confirmar la acción (sin respuesta de Meta). Vuelve a intentarlo.' : describeSocialError(r.code, r.subcode, r.detail);

/** Responde en público a un comentario (queda visible para cualquiera, debajo del comentario original). */
export async function replyToCommentPublic(commentId: string, message: string, token: string, o: GraphOpts = {}): Promise<CommentActionResult> {
  if (!COMMENT_ID.test(commentId)) return { ok: false, message: 'El comentario no tiene un identificador válido.' };
  const r = await graphCall<{ id?: string }>('POST', `${commentId}/comments`, token, { ...o, form: { message } });
  if (r.ok) return { ok: true };
  return { ok: false, message: describeCommentError(r) };
}

/** Oculta (o muestra de nuevo) un comentario. No lo borra: la persona que lo escribió lo sigue viendo. */
export async function setCommentHidden(commentId: string, hidden: boolean, token: string, o: GraphOpts = {}): Promise<CommentActionResult> {
  if (!COMMENT_ID.test(commentId)) return { ok: false, message: 'El comentario no tiene un identificador válido.' };
  const r = await graphCall<{ success?: boolean }>('POST', commentId, token, { ...o, form: { is_hidden: String(hidden) } });
  if (r.ok) return { ok: true };
  return { ok: false, message: describeCommentError(r) };
}

/** Elimina un comentario de verdad (no se puede deshacer). */
export async function deleteComment(commentId: string, token: string, o: GraphOpts = {}): Promise<CommentActionResult> {
  if (!COMMENT_ID.test(commentId)) return { ok: false, message: 'El comentario no tiene un identificador válido.' };
  const r = await graphCall<{ success?: boolean }>('POST', commentId, token, { ...o, form: { method: 'delete' } });
  if (r.ok) return { ok: true };
  return { ok: false, message: describeCommentError(r) };
}

/** Respuesta PRIVADA a quien comentó: usa el mismo buzón de mensajes que ya se usa para Messenger/Instagram
 * Direct (`recipient.comment_id` en vez de `recipient.id`). Solo funciona dentro de los 7 días del comentario
 * — pasado ese plazo Meta la rechaza, y se lo decimos a la persona en vez de un error críptico. */
export async function sendPrivateReplyToComment(commentId: string, message: string, token: string, o: GraphOpts = {}): Promise<CommentActionResult> {
  if (!COMMENT_ID.test(commentId)) return { ok: false, message: 'El comentario no tiene un identificador válido.' };
  const r = await graphCall<{ message_id?: string }>('POST', 'me/messages', token, { ...o, json: { recipient: { comment_id: commentId }, message: { text: message } } });
  if (r.ok) return { ok: true };
  if (r.kind === 'rejected' && (r.code === '10' || r.code === '100')) return { ok: false, message: 'Ya pasaron más de 7 días desde el comentario: Meta ya no permite responder en privado. Prueba con una respuesta pública, o escríbele directo si ya es un contacto.' };
  return { ok: false, message: describeCommentError(r) };
}

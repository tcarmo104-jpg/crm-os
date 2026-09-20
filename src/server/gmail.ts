import 'server-only';
import { classifyGoogleError, redact, type Failure } from '@/lib/connections';
import { buildRawEmail, replySubject, type GmailMessage } from '@/lib/gmail';
import type { SendResult } from './whatsapp';

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export type GoogleFailure = { ok: false; kind: 'transient' | 'rejected'; state: Failure['state'] | null; code: string; status: number; detail: string };
export type GoogleResult<T> = { ok: true; data: T } | GoogleFailure;
export interface GoogleOpts { fetchImpl?: typeof fetch; timeoutMs?: number }
export interface GoogleApp { clientId: string; clientSecret: string }

async function gcall<T>(method: 'GET' | 'POST', url: string, o: GoogleOpts & { token?: string; form?: Record<string, string>; json?: unknown; params?: Record<string, string> } = {}): Promise<GoogleResult<T>> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), o.timeoutMs ?? 15_000);
  const headers: Record<string, string> = {};
  if (o.token) headers.Authorization = `Bearer ${o.token}`;
  let body: string | undefined;
  if (o.form) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(o.form).toString(); }
  else if (o.json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(o.json); }
  try {
    const res = await (o.fetchImpl ?? fetch)(`${url}${o.params ? `?${new URLSearchParams(o.params).toString()}` : ''}`, { method, headers, body, signal: ctrl.signal });
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (res.ok) return { ok: true, data: (data ?? {}) as T };
    if (res.status >= 500 || res.status === 429) return { ok: false, kind: 'transient', state: null, code: String(res.status), status: res.status, detail: `Google respondió ${res.status}.` };
    // OAuth: { error: 'invalid_grant', error_description } · API: { error: { code, message, status, errors: [{ reason }] } }
    const e = data?.error;
    const oauthErr = typeof e === 'string' ? e : null;
    const apiErr = e && typeof e === 'object' ? (e as { message?: string; status?: string; errors?: { reason?: string }[] }) : null;
    const f = classifyGoogleError({ status: res.status, error: oauthErr ?? apiErr?.status ?? null, reason: apiErr?.errors?.[0]?.reason ?? null });
    const msg = String(data?.error_description ?? apiErr?.message ?? `Google respondió ${res.status}.`);
    return { ok: false, kind: 'rejected', state: f?.state ?? null, code: f?.code ?? oauthErr ?? String(res.status), status: res.status, detail: redact(msg) };
  } catch {
    return { ok: false, kind: 'transient', state: null, code: 'network', status: 0, detail: 'Sin respuesta de Google (red o tiempo agotado).' };
  } finally {
    clearTimeout(timer);
  }
}

export interface GoogleTokens { access_token?: string; refresh_token?: string; scope?: string; expires_in?: number }
export const exchangeGoogleCode = (code: string, redirectUri: string, app: GoogleApp, o: GoogleOpts = {}) =>
  gcall<GoogleTokens>('POST', TOKEN_URL, { ...o, form: { code, client_id: app.clientId, client_secret: app.clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' } });
export const refreshGoogleToken = (refreshToken: string, app: GoogleApp, o: GoogleOpts = {}) =>
  gcall<GoogleTokens>('POST', TOKEN_URL, { ...o, form: { refresh_token: refreshToken, client_id: app.clientId, client_secret: app.clientSecret, grant_type: 'refresh_token' } });

export const gmailProfile = (access: string, o: GoogleOpts = {}) => gcall<{ emailAddress?: string; historyId?: string }>('GET', `${API}/profile`, { ...o, token: access });
export const listInbox = (access: string, o: GoogleOpts & { q: string; max: number }) =>
  gcall<{ messages?: { id: string; threadId?: string }[] }>('GET', `${API}/messages`, { ...o, token: access, params: { q: o.q, maxResults: String(o.max) } });
export const listHistory = (access: string, startHistoryId: string, o: GoogleOpts & { pageToken?: string } = {}) =>
  gcall<{ history?: { messagesAdded?: { message?: { id?: string; labelIds?: string[] } }[] }[]; historyId?: string; nextPageToken?: string }>('GET', `${API}/history`, {
    ...o, token: access, params: { startHistoryId, historyTypes: 'messageAdded', labelId: 'INBOX', maxResults: '100', ...(o.pageToken ? { pageToken: o.pageToken } : {}) } });
export const getGmailMessage = (access: string, id: string, o: GoogleOpts = {}): Promise<GoogleResult<GmailMessage>> =>
  /^[0-9a-f]{6,32}$/i.test(id)                               // los identificadores de Gmail son hexadecimales: cualquier otra cosa ni sale a la red
    ? gcall<GmailMessage>('GET', `${API}/messages/${id}`, { ...o, token: access, params: { format: 'full' } })
    : Promise.resolve({ ok: false, kind: 'rejected', state: null, code: 'bad_id', status: 400, detail: 'Identificador de correo no válido.' });

export interface EmailSend {
  refreshToken: string; app: GoogleApp; from: string; fromName?: string | null; to: string; body: string;
  replyMeta: { message_id?: string | null; subject?: string | null; references?: string | null; gmail_thread_id?: string | null };
  fetchImpl?: typeof fetch;
}
/**
 * Responde un correo: renueva el acceso, arma el mensaje con las cabeceras de hilo y lo envía por Gmail API.
 * Un rechazo definitivo devuelve el código; red o 5xx = «resultado desconocido» (no se reintenta solo, para no enviar dos veces).
 */
export async function sendGmailReply(i: EmailSend): Promise<SendResult> {
  const tok = await refreshGoogleToken(i.refreshToken, i.app, { fetchImpl: i.fetchImpl });
  if (!tok.ok) return tok.kind === 'transient' ? { ok: false, definitive: false, message: 'No se pudo confirmar el envío (sin respuesta de Google).' } : { ok: false, definitive: true, code: tok.code, message: 'La conexión con Gmail requiere autorización nuevamente. Vuelve a autorizarla en Configuración → Conexiones.' };
  const access = tok.data.access_token;
  if (!access) return { ok: false, definitive: true, code: 'no_access_token', message: 'Google no entregó un acceso válido.' };
  let raw: string;
  try {
    raw = buildRawEmail({ from: i.from, fromName: i.fromName, to: i.to, subject: replySubject(i.replyMeta.subject), body: i.body, inReplyTo: i.replyMeta.message_id ?? null, references: i.replyMeta.references ?? null });
  } catch { return { ok: false, definitive: true, code: 'bad_recipient', message: 'La dirección del destinatario no es válida.' }; }
  const r = await gcall<{ id?: string }>('POST', `${API}/messages/send`, { fetchImpl: i.fetchImpl, token: access, json: { raw, ...(i.replyMeta.gmail_thread_id ? { threadId: i.replyMeta.gmail_thread_id } : {}) } });
  if (r.ok) return r.data.id ? { ok: true, externalId: r.data.id } : { ok: false, definitive: false, message: 'Respuesta inesperada de Google.' };
  if (r.kind === 'transient') return { ok: false, definitive: false, message: 'No se pudo confirmar el envío (sin respuesta de Google).' };
  return { ok: false, definitive: true, code: r.code, message: r.state === 'needs_auth' ? 'La conexión con Gmail no tiene permiso para enviar. Vuelve a autorizarla en Configuración → Conexiones.' : r.state === 'token_expired' ? 'La conexión con Gmail requiere autorización nuevamente. Vuelve a autorizarla en Configuración → Conexiones.' : `Gmail rechazó el envío: ${r.detail}` };
}

/** Contenido de un adjunto (users.messages.attachments.get). Los identificadores de Gmail son hexadecimales / alfanuméricos: se validan antes de salir a la red. */
export function getGmailAttachment(access: string, messageId: string, attachmentId: string, o: GoogleOpts = {}): Promise<GoogleResult<{ data?: string; size?: number }>> {
  if (!/^[0-9a-f]{6,32}$/i.test(messageId) || !/^[A-Za-z0-9_-]{5,2000}$/.test(attachmentId)) {
    return Promise.resolve({ ok: false, kind: 'rejected', state: null, code: 'bad_id', status: 400, detail: 'Identificador de adjunto no válido.' });
  }
  return gcall('GET', `${API}/messages/${messageId}/attachments/${encodeURIComponent(attachmentId)}`, { ...o, token: access });
}

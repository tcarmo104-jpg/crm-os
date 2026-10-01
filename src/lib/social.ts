/**
 * Lógica pura de Facebook Messenger e Instagram Direct (Meta): lectura del webhook y URL de autorización.
 * Sin red ni base de datos. Cualquier parte malformada se descarta sin fallar (un payload raro no debe tumbar el webhook).
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import type { AttachmentInput } from './media';

export type SocialKind = 'facebook' | 'instagram';
export interface SocialMessage {
  kind: SocialKind; accountId: string; thread: string; externalId: string; msgKind: 'text' | 'media' | 'other';
  body: string; occurredAt: string; meta: Record<string, unknown>; attachments?: AttachmentInput[];
}
export interface SocialStatus { kind: SocialKind; accountId: string; externalId: string; status: 'delivered' | 'read'; occurredAt: string }

const MAX_ITEMS = 500;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max = 4096): string | null => (typeof v === 'string' && v.trim() !== '' ? v.slice(0, max) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v.slice(0, MAX_ITEMS) : []);
const clean = (s: string) => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
const digits = (v: unknown, min = 5) => { const s = typeof v === 'string' || typeof v === 'number' ? String(v) : ''; return new RegExp(`^\\d{${min},30}$`).test(s) ? s : null; };

function toIso(ts: unknown): string {
  const n = typeof ts === 'number' ? ts : typeof ts === 'string' ? Number(ts) : NaN;
  if (!Number.isFinite(n) || n <= 0) return new Date().toISOString();
  const d = new Date(n > 1e11 ? n : n * 1000);                          // Meta manda milisegundos
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

const ATTACH_LABEL: Record<string, string> = {
  image: 'Imagen', video: 'Video', audio: 'Audio', file: 'Archivo', location: 'Ubicación', share: 'Enlace compartido',
  story_mention: 'Mención en una historia', ig_reel: 'Reel', reel: 'Reel', template: 'Mensaje', fallback: 'Adjunto',
};


const ATTACH_KIND: Record<string, AttachmentInput['kind']> = { image: 'image', video: 'video', audio: 'audio', file: 'document', location: 'location' };
/** Adjuntos de Messenger/Instagram en el formato común. El tipo definitivo se confirma al descargar (por el contenido). */
function toInputs(list: Record<string, unknown>[]): AttachmentInput[] {
  const out: AttachmentInput[] = [];
  for (const a of list) {
    const type = str(a.type, 40) ?? 'fallback';
    const payload = isObj(a.payload) ? a.payload : {};
    if (type === 'location') {
      const c = isObj(payload.coordinates) ? payload.coordinates : {};
      const lat = Number(c.lat), lng = Number(c.long ?? c.lng);
      if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) out.push({ kind: 'location', meta: { lat, lng, ...(str(a.title, 120) ? { name: clean(str(a.title, 120)!) } : {}) } });
      continue;
    }
    const url = str(payload.url, 2000);
    const https = url && /^https:\/\//i.test(url) ? url : null;
    const kind = ATTACH_KIND[type] ?? (https ? 'file' : 'unsupported');     // historias, reels, enlaces…: se intenta bajar y se decide por el contenido
    out.push({ kind, source: https ? { url: https } : {}, meta: { channel_type: type, ...(str(a.title, 200) ? { title: clean(str(a.title, 200)!) } : {}) } });
  }
  return out;
}

function normalizeEvent(kind: SocialKind, accountId: string, ev: Record<string, unknown>, out: { messages: SocialMessage[]; statuses: SocialStatus[] }) {
  const sender = isObj(ev.sender) ? digits(ev.sender.id, 6) : null;
  if (!sender || sender === accountId) return;                          // eventos de la propia cuenta (eco): no son del cliente
  const at = toIso(ev.timestamp);

  if (isObj(ev.delivery)) {
    for (const mid of arr(ev.delivery.mids)) { const m = str(mid, 200); if (m) out.statuses.push({ kind, accountId, externalId: m, status: 'delivered', occurredAt: at }); }
    return;
  }
  if (isObj(ev.read)) {                                                  // Instagram indica el mensaje; Facebook solo una marca de hora
    const m = str(ev.read.mid, 200);
    if (m) out.statuses.push({ kind, accountId, externalId: m, status: 'read', occurredAt: at });
    return;
  }
  if (isObj(ev.postback)) {
    const title = str(ev.postback.title) ?? str(ev.postback.payload);
    const mid = str(ev.postback.mid, 200) ?? `postback:${sender}:${String(ev.timestamp ?? '')}`;
    if (title) out.messages.push({ kind, accountId, thread: sender, externalId: mid, msgKind: 'text', body: clean(title), occurredAt: at, meta: { type: 'postback' } });
    return;
  }
  if (!isObj(ev.message)) return;                                        // reacciones, «escribiendo…», etc.
  const m = ev.message;
  if (m.is_echo === true || m.is_deleted === true) return;
  const mid = str(m.mid, 200);
  if (!mid) return;
  const text = str(m.text);
  const atts = arr(m.attachments).filter(isObj).slice(0, 5).map((a) => {
    const type = str(a.type, 40) ?? 'fallback';
    const url = isObj(a.payload) ? str(a.payload.url, 2000) : null;
    return { type, url: url && /^https:\/\//i.test(url) ? url : null };
  });
  if (atts.length > 0) {
    const label = atts.length === 1 ? `[${ATTACH_LABEL[atts[0]!.type] ?? 'Adjunto'}]` : `[${atts.length} adjuntos]`;
    out.messages.push({ kind, accountId, thread: sender, externalId: mid, msgKind: 'media', body: text ? `${label} ${clean(text)}` : label, occurredAt: at, meta: { attachments: atts },
      attachments: toInputs(arr(m.attachments).filter(isObj).slice(0, 5)) });
    return;
  }
  if (text) {
    const reply = isObj(m.reply_to) && isObj(m.reply_to.story) ? { reply_to_story: true } : {};
    out.messages.push({ kind, accountId, thread: sender, externalId: mid, msgKind: 'text', body: clean(text), occurredAt: at, meta: reply });
  }
}

/** Convierte el JSON de Meta de Messenger (`object: page`) o Instagram (`object: instagram`) en mensajes y estados. */
export function parseSocialWebhook(payload: unknown): { kind: SocialKind | null; messages: SocialMessage[]; statuses: SocialStatus[] } {
  const out = { messages: [] as SocialMessage[], statuses: [] as SocialStatus[] };
  if (!isObj(payload)) return { kind: null, ...out };
  const kind: SocialKind | null = payload.object === 'page' ? 'facebook' : payload.object === 'instagram' ? 'instagram' : null;
  if (!kind) return { kind: null, ...out };
  for (const e of arr(payload.entry)) {
    if (!isObj(e)) continue;
    const accountId = digits(e.id);
    if (!accountId) continue;
    for (const ev of arr(e.messaging)) if (isObj(ev)) normalizeEvent(kind, accountId, ev, out);
  }
  return { kind, ...out };
}

/** ¿El payload es de Messenger o Instagram (y no de WhatsApp)? */
export const isSocialPayload = (p: unknown) => isObj(p) && (p.object === 'page' || p.object === 'instagram');

// ---------------------------------------------------------------------------------------------- comentarios
// Meta entrega los comentarios DENTRO de otro campo del webhook, no el de mensajería: Facebook los manda en
// `feed` (junto con publicaciones, me gusta, etc. — se filtra por item="comment"), e Instagram en su propio
// campo `comments`. Ninguno de los dos pasa por `e.messaging`, que es lo único que lee parseSocialWebhook.
export interface SocialComment {
  kind: SocialKind; accountId: string; postExternalId: string; commentExternalId: string; parentExternalId: string | null;
  authorId: string; authorName: string; message: string | null; verb: 'add' | 'edit' | 'remove'; occurredAt: string;
}
/** ¿Trae comentarios este payload (además de, o en vez de, mensajes)? */
export function parseCommentWebhook(payload: unknown): SocialComment[] {
  const out: SocialComment[] = [];
  if (!isObj(payload)) return out;
  const kind: SocialKind | null = payload.object === 'page' ? 'facebook' : payload.object === 'instagram' ? 'instagram' : null;
  if (!kind) return out;
  for (const e of arr(payload.entry)) {
    if (!isObj(e)) continue;
    const accountId = digits(e.id, 3);
    if (!accountId) continue;
    const time = e.time;
    for (const ch of arr(e.changes)) {
      if (!isObj(ch)) continue;
      if (kind === 'facebook' && ch.field === 'feed') addFacebookComment(accountId, ch.value, time, out);
      else if (kind === 'instagram' && ch.field === 'comments') addInstagramComment(accountId, ch.value, time, out);
    }
  }
  return out;
}

function addFacebookComment(accountId: string, value: unknown, entryTime: unknown, out: SocialComment[]): void {
  if (!isObj(value) || value.item !== 'comment') return;
  const commentId = digits(value.comment_id, 3);
  const postId = digits(value.post_id, 3);
  const from = isObj(value.from) ? value.from : null;
  const authorId = from ? digits(from.id, 3) : null;
  if (!commentId || !postId || !authorId) return;
  const verb = value.verb === 'remove' ? 'remove' : value.verb === 'edited' || value.verb === 'edit' ? 'edit' : 'add';
  const parentId = digits(value.parent_id, 3);
  out.push({
    kind: 'facebook', accountId, postExternalId: postId, commentExternalId: commentId,
    parentExternalId: parentId && parentId !== postId ? parentId : null,
    authorId, authorName: (str(isObj(from) ? from.name : null, 160) ?? 'Alguien'), message: str(value.message, 4000),
    verb, occurredAt: toIso(value.created_time ?? entryTime),
  });
}

function addInstagramComment(accountId: string, value: unknown, entryTime: unknown, out: SocialComment[]): void {
  if (!isObj(value)) return;
  const commentId = digits(value.id, 3);
  const media = isObj(value.media) ? value.media : null;
  const postId = media ? digits(media.id, 3) : null;
  const from = isObj(value.from) ? value.from : null;
  const authorId = from ? digits(from.id, 3) : null;
  if (!commentId || !postId || !authorId) return;
  // Instagram no manda "verb": si llega de nuevo el mismo id de comentario, es una edición (no una creación).
  out.push({
    kind: 'instagram', accountId, postExternalId: postId, commentExternalId: commentId,
    parentExternalId: digits(value.parent_id, 3),
    authorId, authorName: (str(isObj(from) ? from.username : null, 160) ?? 'Alguien'), message: str(value.text, 4000),
    verb: 'add', occurredAt: toIso(entryTime),
  });
}

// ---------------------------------------------------------------------------------------------- autorización (OAuth)
export const META_SCOPES = [
  'pages_show_list', 'pages_messaging', 'pages_manage_metadata', 'pages_read_engagement', 'instagram_basic', 'instagram_manage_messages', 'business_management',
  // Para el módulo de Comentarios: leer/crear/ocultar/eliminar comentarios de la Página y de Instagram.
  'pages_manage_engagement', 'instagram_manage_comments',
];
export const GOOGLE_SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send'];
export const GOOGLE_REQUIRED_SCOPES = ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send'];

export type OAuthProvider = 'meta' | 'google';
export const redirectUri = (site: string, provider: OAuthProvider) => `${site.replace(/\/+$/, '')}/api/connections/${provider}/callback`;

export function metaAuthUrl(o: { appId: string; redirectUri: string; state: string; version?: string }): string {
  const q = new URLSearchParams({ client_id: o.appId, redirect_uri: o.redirectUri, state: o.state, response_type: 'code', scope: META_SCOPES.join(',') });
  return `https://www.facebook.com/${o.version ?? 'v24.0'}/dialog/oauth?${q.toString()}`;
}
export function googleAuthUrl(o: { clientId: string; redirectUri: string; state: string; loginHint?: string }): string {
  const q = new URLSearchParams({
    client_id: o.clientId, redirect_uri: o.redirectUri, state: o.state, response_type: 'code', scope: GOOGLE_SCOPES.join(' '),
    access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true',
  });
  if (o.loginHint) q.set('login_hint', o.loginHint);
  return `https://accounts.google.com/o/oauth2/v2/auth?${q.toString()}`;
}

/**
 * «state» firmado: liga el regreso de Meta/Google al administrador, la organización y el navegador que empezaron el flujo
 * (evita que alguien haga conectar una cuenta ajena). Caduca a los 10 minutos.
 */
export interface OAuthState { org: string; user: string; provider: OAuthProvider; nonce: string; ts: number }
const b64 = (s: string) => Buffer.from(s).toString('base64url');
const sign = (body: string, secret: string) => createHmac('sha256', secret).update(body).digest('base64url');
export const newNonce = () => randomBytes(16).toString('base64url');

export function signState(s: OAuthState, secret: string): string {
  const body = b64(JSON.stringify(s));
  return `${body}.${sign(body, secret)}`;
}
export function verifyState(token: string | null | undefined, secret: string | undefined, now = Date.now(), maxAgeMs = 10 * 60_000): OAuthState | null {
  if (!token || !secret) return null;
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const good = Buffer.from(sign(body, secret)); const got = Buffer.from(mac);
  if (good.length !== got.length || !timingSafeEqual(good, got)) return null;
  try {
    const s = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as OAuthState;
    if (!s || typeof s.ts !== 'number' || now - s.ts > maxAgeMs || s.ts > now + 60_000) return null;
    if (typeof s.org !== 'string' || typeof s.user !== 'string' || typeof s.nonce !== 'string' || (s.provider !== 'meta' && s.provider !== 'google')) return null;
    return s;
  } catch { return null; }
}

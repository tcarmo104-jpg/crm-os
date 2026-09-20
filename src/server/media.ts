import 'server-only';
import { createHash } from 'node:crypto';
import { SecretError, openSecret } from '@/lib/secrets';
import { redact } from '@/lib/connections';
import { MAX_STORE_BYTES, extOf, imageSize, isAllowedMetaUrl, resolveMime, sanitizeFileName, type AttachmentInput, type MediaKind } from '@/lib/media';
import type { ServerSupabase } from '@/lib/supabase/server';
import { getGmailAttachment, refreshGoogleToken } from './gmail';
import type { createAdminClient } from './supabase-admin';
import { graphCall } from './whatsapp-graph';

type Admin = ReturnType<typeof createAdminClient>;
export const MEDIA_BUCKET = 'inbox-media';

// ---------------------------------------------------------------------------------------------- almacén privado
export interface MediaStore {
  put(path: string, bytes: Uint8Array, mime: string): Promise<void>;
  signedUrl(path: string, ttlSeconds: number, downloadName?: string): Promise<string | null>;
  remove(paths: string[]): Promise<void>;
}
/** Supabase Storage con la llave del SERVIDOR: el bucket es privado y el navegador nunca lo toca directamente. */
export function createSupabaseMediaStore(admin: Admin, bucket = MEDIA_BUCKET): MediaStore {
  return {
    async put(path, bytes, mime) {
      const r = await admin.storage.from(bucket).upload(path, bytes, { contentType: mime, upsert: true, cacheControl: '3600' });
      if (r.error) throw new Error(`storage_put:${r.error.message.slice(0, 80)}`);
    },
    async signedUrl(path, ttl, downloadName) {
      const r = await admin.storage.from(bucket).createSignedUrl(path, ttl, downloadName ? { download: downloadName } : undefined);
      return r.data?.signedUrl ?? null;
    },
    async remove(paths) { if (paths.length > 0) await admin.storage.from(bucket).remove(paths); },
  };
}

// ---------------------------------------------------------------------------------------------- registrar
/** Guarda los adjuntos de un mensaje YA guardado. Se puede llamar de nuevo sin duplicar (si el webhook se reintenta se recupera lo que faltó). */
export async function registerAttachments(admin: Admin, kind: string, account: string, externalId: string, items: AttachmentInput[]): Promise<boolean> {
  if (items.length === 0) return true;
  const r = await admin.rpc('register_message_attachments', { p_kind: kind, p_account: account, p_external_id: externalId, p_items: items });
  return !r.error;
}

// ---------------------------------------------------------------------------------------------- descargar
export interface MediaDeps { fetchImpl?: typeof fetch; store: MediaStore; env?: NodeJS.ProcessEnv; now?: Date; timeoutMs?: number }
export type AttachOutcome = 'stored' | 'retry' | 'failed' | 'expired' | 'blocked' | 'skipped';
const MAX_ATTEMPTS = 6;
const WA_MEDIA_DAYS = 7;                               // Meta conserva el archivo del webhook 7 días

interface Claimed {
  id: string; org_id: string; conversation_id: string; kind: MediaKind; mime_type: string | null; file_name: string | null; file_size: number | null;
  source: { media_id?: string; url?: string; gmail_id?: string; attachment_id?: string }; attempts: number; created_at: string; message_at: string;
  channel_id: string; channel_kind: 'whatsapp' | 'facebook' | 'instagram' | 'gmail'; account_id: string; is_voice: boolean;
}
type Got = { ok: true; bytes: Uint8Array; mime: string | null; name?: string | null }
  | { ok: false; why: 'gone' | 'transient' | 'auth' | 'too_large' | 'bad_source' | 'no_credentials'; detail?: string };

/** Lee el cuerpo respetando un tope (sin cargar en memoria un archivo gigante). */
async function readCapped(res: Response, cap: number): Promise<Uint8Array | 'too_large'> {
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > cap) return 'too_large';
  const reader = res.body?.getReader();
  if (!reader) { const b = new Uint8Array(await res.arrayBuffer()); return b.length > cap ? 'too_large' : b; }
  const chunks: Uint8Array[] = []; let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > cap) { await reader.cancel().catch(() => undefined); return 'too_large'; }
    chunks.push(value);
  }
  const out = new Uint8Array(total); let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

const classifyStatus = (status: number): 'gone' | 'auth' | 'transient' => (status === 404 || status === 410 ? 'gone' : status === 401 || status === 403 ? 'auth' : 'transient');

/** Descarga de los servidores de Meta: solo https a sus dominios, y cada redirección también se valida. */
async function fetchMetaBinary(url: string, deps: MediaDeps, headers: Record<string, string> = {}): Promise<Got> {
  let cur = url;
  for (let hop = 0; hop < 4; hop++) {
    if (!isAllowedMetaUrl(cur)) return { ok: false, why: 'bad_source' };
    const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), deps.timeoutMs ?? 25_000);
    try {
      const res = await (deps.fetchImpl ?? fetch)(cur, { headers, redirect: 'manual', signal: ctrl.signal });
      if (res.status >= 300 && res.status < 400) { const loc = res.headers.get('location'); if (!loc) return { ok: false, why: 'transient' }; cur = new URL(loc, cur).toString(); continue; }
      // Sin credenciales (CDN con enlace firmado), un 401/403 significa que el enlace VENCIÓ, no un problema de autorización.
      if (!res.ok) return { ok: false, why: !headers.Authorization && (res.status === 401 || res.status === 403) ? 'gone' : classifyStatus(res.status) };
      const body = await readCapped(res, MAX_STORE_BYTES);
      return body === 'too_large' ? { ok: false, why: 'too_large' } : { ok: true, bytes: body, mime: res.headers.get('content-type') };
    } catch { return { ok: false, why: 'transient' }; } finally { clearTimeout(timer); }
  }
  return { ok: false, why: 'transient' };
}

async function tokenFor(admin: Admin, channelId: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  const cred = await admin.rpc('channel_credentials', { p_channel: channelId });
  if (cred.error || typeof cred.data !== 'string' || !cred.data) return null;
  try { return openSecret(cred.data, env); } catch (e) { if (e instanceof SecretError) return null; throw e; }
}

async function getWhatsApp(admin: Admin, c: Claimed, deps: MediaDeps, env: NodeJS.ProcessEnv): Promise<Got> {
  const mediaId = c.source.media_id;
  if (!mediaId || !/^\d{5,40}$/.test(mediaId)) return { ok: false, why: 'bad_source' };
  const token = await tokenFor(admin, c.channel_id, env);
  if (!token) return { ok: false, why: 'no_credentials' };
  const info = await graphCall<{ url?: string; mime_type?: string; file_size?: number }>('GET', mediaId, token, { fetchImpl: deps.fetchImpl, timeoutMs: deps.timeoutMs });
  if (!info.ok) {
    if (info.kind === 'transient') return { ok: false, why: 'transient' };
    // «el objeto no existe»: el identificador caducó (7 días) o ya no es accesible
    if (info.code === '100' || info.code === '404' || info.code === '131052') return { ok: false, why: 'gone' };
    return { ok: false, why: info.state ? 'auth' : 'transient', detail: info.code };
  }
  if ((info.data.file_size ?? 0) > MAX_STORE_BYTES) return { ok: false, why: 'too_large' };
  if (!info.data.url) return { ok: false, why: 'gone' };
  const got = await fetchMetaBinary(info.data.url, deps, { Authorization: `Bearer ${token}` });
  return got.ok ? { ...got, mime: info.data.mime_type ?? got.mime } : got;
}

async function getGmail(admin: Admin, c: Claimed, deps: MediaDeps, env: NodeJS.ProcessEnv): Promise<Got> {
  const { gmail_id: gid, attachment_id: aid } = c.source;
  if (!gid || !aid) return { ok: false, why: 'bad_source' };
  const clientId = (env.GOOGLE_CLIENT_ID ?? '').trim(), clientSecret = (env.GOOGLE_CLIENT_SECRET ?? '').trim();
  const refresh = await tokenFor(admin, c.channel_id, env);
  if (!clientId || !clientSecret || !refresh) return { ok: false, why: 'no_credentials' };
  const tok = await refreshGoogleToken(refresh, { clientId, clientSecret }, { fetchImpl: deps.fetchImpl });
  if (!tok.ok) return { ok: false, why: tok.kind === 'transient' ? 'transient' : 'auth' };
  const r = await getGmailAttachment(tok.data.access_token ?? '', gid, aid, { fetchImpl: deps.fetchImpl, timeoutMs: deps.timeoutMs ?? 30_000 });
  if (!r.ok) return { ok: false, why: r.kind === 'transient' ? 'transient' : r.status === 404 ? 'gone' : r.state ? 'auth' : 'transient' };
  if (!r.data.data) return { ok: false, why: 'gone' };
  const bytes = new Uint8Array(Buffer.from(r.data.data, 'base64url'));
  return bytes.length > MAX_STORE_BYTES ? { ok: false, why: 'too_large' } : { ok: true, bytes, mime: null };
}

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/heic': 'heic', 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm',
  'video/3gpp': '3gp', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/amr': 'amr', 'audio/wav': 'wav', 'application/pdf': 'pdf', 'application/zip': 'zip', 'text/plain': 'txt', 'text/csv': 'csv' };
const KIND_FILE: Record<string, string> = { image: 'imagen', video: 'video', audio: 'audio', document: 'documento', sticker: 'sticker', file: 'archivo' };

/**
 * Descarga UN adjunto pendiente, lo verifica por su contenido (tipo real, ejecutables, tamaño) y lo guarda en el bucket privado.
 * Reclamo atómico: si dos procesos lo intentan, solo uno lo consigue. Los fallos temporales se reintentan con espera creciente.
 */
export async function processAttachment(admin: Admin, id: string, deps: MediaDeps): Promise<AttachOutcome> {
  const env = deps.env ?? process.env;
  const claim = await admin.rpc('claim_attachment', { p_id: id });
  if (claim.error) throw new Error(`claim_attachment: ${claim.error.code ?? claim.error.message}`);
  const c = claim.data as Claimed | null;
  if (!c) return 'skipped';

  const finish = async (status: 'failed' | 'blocked' | 'expired' | 'retry', error: string, retrySeconds = 60): Promise<AttachOutcome> => {
    await admin.rpc('finish_attachment', { p_id: id, p_status: status, p_error: error, p_retry_seconds: retrySeconds });
    return status;
  };
  const transient = (code: string): Promise<AttachOutcome> => {
    const now = (deps.now ?? new Date()).getTime();
    const tooOld = c.channel_kind === 'whatsapp' && now - new Date(c.message_at).getTime() > WA_MEDIA_DAYS * 86_400_000;
    if (tooOld) return finish('expired', 'expired_at_channel');
    if (c.attempts >= MAX_ATTEMPTS) return finish('failed', code);
    return finish('retry', code, Math.min(3600, 30 * 2 ** (c.attempts - 1)));
  };

  try {
    const got = c.channel_kind === 'whatsapp' ? await getWhatsApp(admin, c, deps, env)
      : c.channel_kind === 'gmail' ? await getGmail(admin, c, deps, env)
      : c.source.url ? await fetchMetaBinary(c.source.url, deps) : ({ ok: false, why: 'bad_source' } as Got);
    if (!got.ok) {
      if (got.why === 'gone') return finish('expired', 'expired_at_channel');
      if (got.why === 'too_large') return finish('failed', 'too_large');
      if (got.why === 'bad_source') return finish('failed', 'bad_source');
      if (got.why === 'no_credentials') return finish('failed', 'no_credentials');
      return transient(got.why === 'auth' ? 'auth' : 'transient');
    }

    const bytes = got.bytes;
    if (bytes.length === 0) return finish('failed', 'empty');
    const name = c.file_name ?? got.name ?? null;
    const r = resolveMime(c.mime_type ?? got.mime, bytes, name);
    if (!r.ok) return finish('blocked', r.reason);
    const kind: MediaKind = c.kind === 'sticker' && r.kind === 'image' ? 'sticker' : r.kind;
    const fileName = sanitizeFileName(name, `${KIND_FILE[kind] ?? 'archivo'}${EXT[r.mime] ? `.${EXT[r.mime]}` : ''}`);
    const dims = kind === 'image' || kind === 'sticker' ? imageSize(bytes) : null;
    const path = `${c.org_id}/${c.conversation_id}/${c.id}`;
    await deps.store.put(path, bytes, r.mime);
    await admin.rpc('finish_attachment', {
      p_id: id, p_status: 'stored', p_kind: kind, p_mime: r.mime, p_size: bytes.length, p_sha: createHash('sha256').update(bytes).digest('hex'),
      p_path: path, p_width: dims?.width ?? null, p_height: dims?.height ?? null, p_file_name: fileName,
    });
    return 'stored';
  } catch (e) {
    return transient(redact(e instanceof Error ? e.message : 'error', 60));
  }
}

/** Barrido: procesa los adjuntos que tocan (los recién llegados y los reintentos). Cada uno es independiente. */
export async function sweepAttachments(admin: Admin, deps: MediaDeps, limit = 3): Promise<{ tried: number; stored: number }> {
  const due = await admin.rpc('due_attachments', { p_limit: limit });
  if (due.error) throw new Error(`due_attachments: ${due.error.code ?? due.error.message}`);
  let tried = 0, stored = 0;
  for (const id of (due.data ?? []) as string[]) {
    try { const o = await processAttachment(admin, id, deps); if (o !== 'skipped') tried++; if (o === 'stored') stored++; } catch { /* el siguiente barrido lo reintenta */ }
  }
  return { tried, stored };
}

/** Conservación de 12 meses: se marcan vencidos y se borran los archivos. */
export async function expireStoredAttachments(admin: Admin, store: MediaStore, limit = 200): Promise<number> {
  const r = await admin.rpc('expire_attachments', { p_limit: limit });
  if (r.error) throw new Error(`expire_attachments: ${r.error.code ?? r.error.message}`);
  const rows = (r.data ?? []) as { id: string; storage_path: string }[];
  await store.remove(rows.map((x) => x.storage_path)).catch(() => undefined);
  return rows.length;
}

// ---------------------------------------------------------------------------------------------- leer (con la seguridad del usuario)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type MediaAccess = { ok: true; url: string } | { ok: false; reason: 'not_found' | 'unavailable' };

/**
 * Entrega un enlace firmado de vida corta SOLO si el usuario puede ver la conversación del adjunto (la base de datos lo decide
 * con su seguridad por filas: otra organización o un vendedor sin acceso reciben «no encontrado», sin pistas).
 */
export async function mediaAccessUrl(db: ServerSupabase, store: MediaStore, id: string, o: { download?: boolean; ttlSeconds?: number } = {}): Promise<MediaAccess> {
  if (!UUID.test(id)) return { ok: false, reason: 'not_found' };
  const r = await db.from('message_attachments').select('id, status, storage_path, file_name, mime_type').eq('id', id).maybeSingle();
  const a = r.data as { status: string; storage_path: string | null; file_name: string | null } | null;
  if (r.error || !a) return { ok: false, reason: 'not_found' };
  if (a.status !== 'stored' || !a.storage_path) return { ok: false, reason: 'unavailable' };
  const url = await store.signedUrl(a.storage_path, o.ttlSeconds ?? 120, o.download ? sanitizeFileName(a.file_name, `archivo${extOf(a.file_name) ? `.${extOf(a.file_name)}` : ''}`) : undefined);
  return url ? { ok: true, url } : { ok: false, reason: 'unavailable' };
}

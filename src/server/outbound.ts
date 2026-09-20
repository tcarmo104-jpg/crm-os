import { googleAppFor } from './provider-apps';
import 'server-only';
import type { createAdminClient } from './supabase-admin';
import { classifyGoogleError, classifyMetaError, redact } from '@/lib/connections';
import { SecretError, openSecret } from '@/lib/secrets';
import { isAutoLabel } from '@/lib/media';
import { sendGmailReply } from './gmail';
import { createSupabaseMediaStore, type MediaStore } from './media';
import { sendSocial, sendSocialAttachment } from './meta-social';
import { sendWhatsApp, sendWhatsAppMedia, type SendResult } from './whatsapp';

type Admin = ReturnType<typeof createAdminClient>;
export type DeliverOutcome = 'sent' | 'failed' | 'unknown' | 'skipped';

interface Claimed {
  channel_kind?: 'whatsapp' | 'facebook' | 'instagram' | 'gmail'; account_id?: string; channel_meta?: Record<string, unknown> | null;
  reply_meta?: { message_id?: string | null; subject?: string | null; references?: string | null; gmail_thread_id?: string | null } | null;
  attachments?: { id: string; kind: string; mime_type: string | null; file_name: string | null; storage_path: string }[];
  message_id: string; kind: 'text' | 'template' | 'media'; body: string; to: string; phone_number_id: string; channel_id: string;
  template_name: string | null; template_language: string | null; template_params: string[] | null;
}

/**
 * Entrega un mensaje ya encolado. «Como máximo una vez»: el reclamo en la base de datos es atómico, y si el
 * resultado es desconocido NO se reintenta (el barrido lo marcará «falló: verifica en WhatsApp»).
 */
export interface DeliverDeps { social?: typeof sendSocial; email?: typeof sendGmailReply; env?: NodeJS.ProcessEnv; store?: MediaStore; fetchImpl?: typeof fetch }

export async function deliverMessage(admin: Admin, messageId: string, send: (i: Parameters<typeof sendWhatsApp>[0]) => Promise<SendResult> = sendWhatsApp, deps: DeliverDeps = {}): Promise<DeliverOutcome> {
  const claim = await admin.rpc('claim_outbound', { p_message: messageId });
  if (claim.error) throw new Error(`claim_outbound: ${claim.error.code ?? claim.error.message}`);
  const c = claim.data as Claimed | null;
  if (!c) return 'skipped';                                   // otro proceso lo reclamó, o ya no está en cola

  const finishFail = async (code: string, message: string): Promise<DeliverOutcome> => {
    await admin.rpc('finish_outbound', { p_message: messageId, p_ok: false, p_error_code: code, p_error: message });
    return 'failed';
  };

  const cred = await admin.rpc('channel_credentials', { p_channel: c.channel_id });
  const stored = typeof cred.data === 'string' && cred.data ? cred.data : null;
  if (cred.error || !stored) return finishFail('no_token', 'La conexión no tiene un token de acceso configurado (Configuración → Conexiones).');
  let token: string;
  try { token = openSecret(stored); } catch (e) {
    return finishFail(e instanceof SecretError ? e.reason : 'secret_error', 'No se pudo abrir el token guardado. Vuelve a guardarlo en Configuración → Conexiones.');
  }

  const kind = c.channel_kind ?? 'whatsapp';
  const env = deps.env ?? process.env;
  let r: SendResult;
  if (c.kind === 'media') {
    // ---- mensaje con archivo(s): se leen del almacén privado y se envían por la API de cada canal ----
    const store = deps.store ?? createSupabaseMediaStore(admin);
    const files: { fileName: string; mime: string; bytes: Uint8Array; kind: string }[] = [];
    for (const a of c.attachments ?? []) {
      const bytes = await store.get(a.storage_path);
      if (!bytes) return finishFail('attachment_missing', 'El archivo ya no está disponible en el servidor. Vuelve a adjuntarlo.');
      files.push({ fileName: a.file_name ?? 'archivo', mime: a.mime_type ?? 'application/octet-stream', bytes, kind: a.kind });
    }
    if (files.length === 0) return finishFail('attachment_missing', 'El mensaje no tiene archivos para enviar.');
    const caption = isAutoLabel(c.body) ? null : c.body;
    if (kind === 'whatsapp') {
      const f = files[0]!;
      r = await sendWhatsAppMedia({ phoneNumberId: c.phone_number_id, token, to: c.to, type: f.kind === 'image' || f.kind === 'video' || f.kind === 'audio' ? f.kind : 'document', bytes: f.bytes, mime: f.mime, fileName: f.fileName, caption, fetchImpl: deps.fetchImpl });
    } else if (kind === 'facebook' || kind === 'instagram') {
      const f = files[0]!;
      r = await sendSocialAttachment({ token, to: c.to, type: f.kind === 'image' || f.kind === 'video' || f.kind === 'audio' ? f.kind : 'file', bytes: f.bytes, mime: f.mime, fileName: f.fileName, fetchImpl: deps.fetchImpl });
    } else {
      const { clientId, clientSecret } = await googleOfChannel(admin, c.channel_id, env);
      if (!clientId || !clientSecret) return finishFail('not_configured', 'Falta conectar tu aplicación de Google en Conexiones. Avisa a un administrador.');
      r = await (deps.email ?? sendGmailReply)({ refreshToken: token, app: { clientId, clientSecret }, from: c.account_id ?? '', to: c.to, body: caption ?? '(archivo adjunto)', replyMeta: c.reply_meta ?? {}, attachments: files.map((f) => ({ fileName: f.fileName, mime: f.mime, bytes: f.bytes })), fetchImpl: deps.fetchImpl });
    }
  } else if (kind === 'facebook' || kind === 'instagram') {
    r = await (deps.social ?? sendSocial)({ token, to: c.to, body: c.body, fetchImpl: deps.fetchImpl });
  } else if (kind === 'gmail') {
    const { clientId, clientSecret } = await googleOfChannel(admin, c.channel_id, env);
    if (!clientId || !clientSecret) return finishFail('not_configured', 'Falta conectar tu aplicación de Google en Conexiones. Avisa a un administrador.');
    r = await (deps.email ?? sendGmailReply)({ refreshToken: token, app: { clientId, clientSecret }, from: c.account_id ?? '', to: c.to, body: c.body, replyMeta: c.reply_meta ?? {}, fetchImpl: deps.fetchImpl });
  } else {
    r = await send({
      phoneNumberId: c.phone_number_id, token, to: c.to, kind: c.kind, body: c.body,
      templateName: c.template_name ?? undefined, templateLanguage: c.template_language ?? undefined, templateParams: c.template_params ?? [], fetchImpl: deps.fetchImpl,
    });
  }
  const accountId = c.account_id ?? c.phone_number_id;
  if (r.ok) {
    await admin.rpc('finish_outbound', { p_message: messageId, p_ok: true, p_external_id: r.externalId });
    await (kind === 'whatsapp' ? admin.rpc('touch_channel', { p_phone_number_id: c.phone_number_id, p_kind: 'send_ok' }) : admin.rpc('touch_channel', { p_kind: kind, p_external_id: accountId, p_activity: 'send_ok' }))
      .then(() => undefined, () => undefined);   // mejor esfuerzo
    return 'sent';
  }
  if (r.definitive) {
    // Si el proveedor dice que el acceso venció o no tiene permiso, la CONEXIÓN debe verse así (y no solo el mensaje fallar).
    const f = kind === 'gmail' ? classifyGoogleError({ error: r.code, status: Number(r.code) || null }) : classifyMetaError({ code: r.code, subcode: r.subcode });
    if (f && f.state !== 'error') await admin.rpc('record_channel_health', { p_channel: c.channel_id, p_state: f.state, p_code: f.code, p_detail: redact(r.message) }).then(() => undefined, () => undefined);
    return finishFail(r.code, r.message);
  }
  return 'unknown';                                           // se queda «enviando»: el barrido lo cierra sin reenviar
}

/** Barrido: envía lo que quedó encolado sin reclamar y cierra lo que se quedó «enviando» demasiado tiempo. */
export async function sweepOutbound(admin: Admin): Promise<{ retried: number; expired: number }> {
  const s = await admin.rpc('sweep_outbound');
  if (s.error) throw new Error(`sweep_outbound: ${s.error.code ?? s.error.message}`);
  const d = s.data as { retry_ids: string[]; expired: number };
  let retried = 0;
  for (const id of d.retry_ids ?? []) {
    try { if ((await deliverMessage(admin, id)) !== 'skipped') retried++; } catch { /* se reintenta en el siguiente barrido */ }
  }
  return { retried, expired: d.expired ?? 0 };
}

/** Credenciales de Google de la organización dueña del canal (la suya o la de la plataforma). */
async function googleOfChannel(admin: Admin, channelId: string, env: NodeJS.ProcessEnv): Promise<{ clientId: string; clientSecret: string }> {
  const q = await admin.from('channels').select('org_id').eq('id', channelId).maybeSingle();
  const org = (q.data as { org_id: string } | null)?.org_id;
  const g = org ? await googleAppFor(admin, org, env) : null;
  return { clientId: g?.clientId ?? '', clientSecret: g?.clientSecret ?? '' };
}

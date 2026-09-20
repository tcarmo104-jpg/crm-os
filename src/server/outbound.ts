import 'server-only';
import type { createAdminClient } from './supabase-admin';
import { classifyGoogleError, classifyMetaError, redact } from '@/lib/connections';
import { SecretError, openSecret } from '@/lib/secrets';
import { sendGmailReply } from './gmail';
import { sendSocial } from './meta-social';
import { sendWhatsApp, type SendResult } from './whatsapp';

type Admin = ReturnType<typeof createAdminClient>;
export type DeliverOutcome = 'sent' | 'failed' | 'unknown' | 'skipped';

interface Claimed {
  channel_kind?: 'whatsapp' | 'facebook' | 'instagram' | 'gmail'; account_id?: string; channel_meta?: Record<string, unknown> | null;
  reply_meta?: { message_id?: string | null; subject?: string | null; references?: string | null; gmail_thread_id?: string | null } | null;
  message_id: string; kind: 'text' | 'template'; body: string; to: string; phone_number_id: string; channel_id: string;
  template_name: string | null; template_language: string | null; template_params: string[] | null;
}

/**
 * Entrega un mensaje ya encolado. «Como máximo una vez»: el reclamo en la base de datos es atómico, y si el
 * resultado es desconocido NO se reintenta (el barrido lo marcará «falló: verifica en WhatsApp»).
 */
export interface DeliverDeps { social?: typeof sendSocial; email?: typeof sendGmailReply; env?: NodeJS.ProcessEnv }

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
  if (kind === 'facebook' || kind === 'instagram') {
    r = await (deps.social ?? sendSocial)({ token, to: c.to, body: c.body });
  } else if (kind === 'gmail') {
    const clientId = (env.GOOGLE_CLIENT_ID ?? '').trim(), clientSecret = (env.GOOGLE_CLIENT_SECRET ?? '').trim();
    if (!clientId || !clientSecret) return finishFail('not_configured', 'Faltan las credenciales de Google en el servidor. Avisa a un administrador.');
    r = await (deps.email ?? sendGmailReply)({ refreshToken: token, app: { clientId, clientSecret }, from: c.account_id ?? '', to: c.to, body: c.body, replyMeta: c.reply_meta ?? {} });
  } else {
    r = await send({
      phoneNumberId: c.phone_number_id, token, to: c.to, kind: c.kind, body: c.body,
      templateName: c.template_name ?? undefined, templateLanguage: c.template_language ?? undefined, templateParams: c.template_params ?? [],
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

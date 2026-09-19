import 'server-only';
import type { createAdminClient } from './supabase-admin';
import { sendWhatsApp, type SendResult } from './whatsapp';

type Admin = ReturnType<typeof createAdminClient>;
export type DeliverOutcome = 'sent' | 'failed' | 'unknown' | 'skipped';

interface Claimed {
  message_id: string; kind: 'text' | 'template'; body: string; to: string; phone_number_id: string; channel_id: string;
  template_name: string | null; template_language: string | null; template_params: string[] | null;
}

/**
 * Entrega un mensaje ya encolado. «Como máximo una vez»: el reclamo en la base de datos es atómico, y si el
 * resultado es desconocido NO se reintenta (el barrido lo marcará «falló: verifica en WhatsApp»).
 */
export async function deliverMessage(admin: Admin, messageId: string, send: (i: Parameters<typeof sendWhatsApp>[0]) => Promise<SendResult> = sendWhatsApp): Promise<DeliverOutcome> {
  const claim = await admin.rpc('claim_outbound', { p_message: messageId });
  if (claim.error) throw new Error(`claim_outbound: ${claim.error.code ?? claim.error.message}`);
  const c = claim.data as Claimed | null;
  if (!c) return 'skipped';                                   // otro proceso lo reclamó, o ya no está en cola

  const finishFail = async (code: string, message: string): Promise<DeliverOutcome> => {
    await admin.rpc('finish_outbound', { p_message: messageId, p_ok: false, p_error_code: code, p_error: message });
    return 'failed';
  };

  const cred = await admin.rpc('channel_credentials', { p_channel: c.channel_id });
  const token = typeof cred.data === 'string' ? cred.data : null;
  if (cred.error || !token) return finishFail('no_token', 'El canal no tiene un token de acceso configurado (Configuración → Canales).');

  const r = await send({
    phoneNumberId: c.phone_number_id, token, to: c.to, kind: c.kind, body: c.body,
    templateName: c.template_name ?? undefined, templateLanguage: c.template_language ?? undefined, templateParams: c.template_params ?? [],
  });
  if (r.ok) {
    await admin.rpc('finish_outbound', { p_message: messageId, p_ok: true, p_external_id: r.externalId });
    return 'sent';
  }
  if (r.definitive) return finishFail(r.code, r.message);
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

import 'server-only';
import { buildMediaPayload, buildTemplatePayload, buildTextPayload, describeSendError } from '@/lib/meta';

export type SendResult =
  | { ok: true; externalId: string }
  | { ok: false; definitive: true; code: string; subcode?: string | null; message: string }
  | { ok: false; definitive: false; message: string };   // resultado DESCONOCIDO (red, tiempo agotado, 5xx)

export interface SendInput {
  phoneNumberId: string;
  token: string;
  to: string;
  kind: 'text' | 'template';
  body?: string;
  templateName?: string;
  templateLanguage?: string;
  templateParams?: string[];
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export function graphBase(): string {
  const base = (process.env.META_GRAPH_BASE ?? 'https://graph.facebook.com').replace(/\/+$/, '');
  return `${base}/${process.env.META_GRAPH_VERSION ?? 'v24.0'}`;
}

/**
 * Envía UN mensaje por la API de Meta. Distingue:
 *  · rechazo definitivo (4xx con error de Meta) → se sabe que NO salió;
 *  · resultado desconocido (red, tiempo agotado, 5xx) → puede haber salido: NO se reintenta solo.
 * El token nunca se registra ni se devuelve.
 */
export async function sendWhatsApp(i: SendInput): Promise<SendResult> {
  const payload = i.kind === 'template'
    ? buildTemplatePayload(i.to, i.templateName ?? '', i.templateLanguage ?? 'es', i.templateParams ?? [])
    : buildTextPayload(i.to, i.body ?? '');
  return postWhatsApp(i.phoneNumberId, i.token, payload, i.fetchImpl, i.timeoutMs);
}

/** POST /messages con el «como máximo una vez»: distingue rechazo definitivo de resultado desconocido. El token nunca se registra. */
async function postWhatsApp(phoneNumberId: string, token: string, payload: unknown, fetchImpl?: typeof fetch, timeoutMs?: number): Promise<SendResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs ?? 10_000);
  try {
    const res = await (fetchImpl ?? fetch)(`${graphBase()}/${encodeURIComponent(phoneNumberId)}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    const data = (await res.json().catch(() => null)) as
      { messages?: { id?: string }[]; error?: { code?: number | string; error_subcode?: number | string; message?: string; error_data?: { details?: string } } } | null;

    const id = data?.messages?.[0]?.id;
    if (res.ok && typeof id === 'string' && id) return { ok: true, externalId: id };
    if (res.status >= 500 || (res.ok && !id)) return { ok: false, definitive: false, message: `Respuesta inesperada de WhatsApp (${res.status}).` };

    const code = String(data?.error?.code ?? res.status);
    return { ok: false, definitive: true, code, subcode: data?.error?.error_subcode !== undefined ? String(data.error.error_subcode) : null, message: describeSendError(data?.error?.code, data?.error?.error_data?.details ?? data?.error?.message) };
  } catch {
    return { ok: false, definitive: false, message: 'No se pudo confirmar el envío (sin respuesta de WhatsApp).' };
  } finally {
    clearTimeout(timer);
  }
}

export interface WhatsAppMediaInput {
  phoneNumberId: string; token: string; to: string; type: 'image' | 'video' | 'audio' | 'document'; bytes: Uint8Array; mime: string; fileName: string;
  caption?: string | null; fetchImpl?: typeof fetch; timeoutMs?: number;
}
/**
 * Envía un archivo por WhatsApp en dos pasos oficiales: (1) sube el archivo a Meta (POST /media → id) y (2) envía el mensaje con ese id.
 * Si falla el paso 1 NADA salió: el rechazo es definitivo y la persona puede reintentar sin riesgo de duplicar.
 */
export async function sendWhatsAppMedia(i: WhatsAppMediaInput): Promise<SendResult> {
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', i.mime);
  form.append('file', new Blob([i.bytes as BlobPart], { type: i.mime }), i.fileName);
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), i.timeoutMs ?? 60_000);
  let mediaId: string | null = null;
  try {
    const res = await (i.fetchImpl ?? fetch)(`${graphBase()}/${encodeURIComponent(i.phoneNumberId)}/media`, { method: 'POST', headers: { Authorization: `Bearer ${i.token}` }, body: form, signal: ctrl.signal });
    const data = (await res.json().catch(() => null)) as { id?: string; error?: { code?: number | string; error_subcode?: number | string; message?: string; error_data?: { details?: string } } } | null;
    if (res.ok && typeof data?.id === 'string' && data.id) mediaId = data.id;
    else if (res.status >= 500 || res.ok) return { ok: false, definitive: true, code: 'upload_failed', message: 'WhatsApp no pudo recibir el archivo en este momento. Inténtalo de nuevo en unos minutos.' };
    else return { ok: false, definitive: true, code: String(data?.error?.code ?? res.status), subcode: data?.error?.error_subcode !== undefined ? String(data.error.error_subcode) : null, message: describeSendError(data?.error?.code, data?.error?.error_data?.details ?? data?.error?.message) };
  } catch {
    return { ok: false, definitive: true, code: 'upload_failed', message: 'No se pudo subir el archivo a WhatsApp (sin respuesta). Inténtalo de nuevo.' };
  } finally { clearTimeout(timer); }
  return postWhatsApp(i.phoneNumberId, i.token, buildMediaPayload(i.to, i.type, mediaId, { caption: i.caption, fileName: i.fileName }), i.fetchImpl, i.timeoutMs);
}

import 'server-only';
import { buildTemplatePayload, buildTextPayload, describeSendError } from '@/lib/meta';

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
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), i.timeoutMs ?? 10_000);
  try {
    const res = await (i.fetchImpl ?? fetch)(`${graphBase()}/${encodeURIComponent(i.phoneNumberId)}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${i.token}`, 'Content-Type': 'application/json' },
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

import 'server-only';
import { classifyMetaError, redact, type Failure } from '@/lib/connections';
import { graphBase } from './whatsapp';

/** Resultado de hablar con Meta. Los fallos ya vienen clasificados y SIN secretos. */
export type GraphFailure = { ok: false; kind: 'transient' | 'rejected'; state: Failure['state'] | null; code: string; subcode?: string | null; detail: string };
export type GraphResult<T> = { ok: true; data: T } | GraphFailure;
export interface GraphOpts { fetchImpl?: typeof fetch; timeoutMs?: number }

interface MetaErrorBody { error?: { message?: string; code?: number | string; error_subcode?: number | string; type?: string } }

export interface CallOpts extends GraphOpts { params?: Record<string, string>; json?: unknown; form?: Record<string, string> }

/** Llamada a la Graph API de Meta. `token` null = sin Authorization (intercambio de códigos OAuth). Nunca devuelve secretos. */
export async function graphCall<T>(method: 'GET' | 'POST', path: string, token: string | null, o: CallOpts = {}): Promise<GraphResult<T>> {
  const qs = o.params ? `?${new URLSearchParams(o.params).toString()}` : '';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), o.timeoutMs ?? 10_000);
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let body: string | undefined;
  if (o.form) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(o.form).toString(); }
  else if (o.json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(o.json); }
  try {
    const res = await (o.fetchImpl ?? fetch)(`${graphBase()}/${path}${qs}`, { method, headers, body, signal: ctrl.signal });
    const data = (await res.json().catch(() => null)) as (MetaErrorBody & Record<string, unknown>) | null;
    if (res.ok) return { ok: true, data: (data ?? {}) as T };
    if (res.status >= 500) return { ok: false, kind: 'transient', state: null, code: String(res.status), detail: `Meta respondió ${res.status}.` };
    const e = data?.error;
    const f = classifyMetaError({ httpStatus: res.status, code: e?.code, subcode: e?.error_subcode });
    return { ok: false, kind: 'rejected', state: f?.state ?? null, code: f?.code ?? String(e?.code ?? res.status), subcode: e?.error_subcode !== undefined ? String(e.error_subcode) : null, detail: redact(e?.message ?? `Meta respondió ${res.status}.`) };
  } catch {
    return { ok: false, kind: 'transient', state: null, code: 'network', detail: 'Sin respuesta de Meta (red o tiempo agotado).' };
  } finally {
    clearTimeout(timer);
  }
}
const call = <T>(method: 'GET' | 'POST', path: string, token: string, o: CallOpts = {}) => graphCall<T>(method, path, token, o);

export interface PhoneInfo {
  verified_name?: string; display_phone_number?: string; quality_rating?: string; name_status?: string;
  code_verification_status?: string; platform_type?: string;
}
const ID = /^\d{5,30}$/;
const badId = (): GraphFailure => ({ ok: false, kind: 'rejected', state: 'needs_auth', code: 'bad_id', detail: 'El identificador no tiene un formato válido.' });

/** Datos públicos del número (nombre verificado, teléfono visible, calidad). Sirve también para comprobar que el token funciona. */
export function fetchPhoneNumber(phoneNumberId: string, token: string, o: GraphOpts = {}): Promise<GraphResult<PhoneInfo>> {
  if (!ID.test(phoneNumberId)) return Promise.resolve(badId());
  return call<PhoneInfo>('GET', phoneNumberId, token, {
    ...o, params: { fields: 'verified_name,display_phone_number,quality_rating,name_status,code_verification_status,platform_type' },
  });
}

/** IDs de las aplicaciones suscritas a los webhooks de la cuenta de WhatsApp Business. */
export async function listSubscribedApps(wabaId: string, token: string, o: GraphOpts = {}): Promise<GraphResult<string[]>> {
  if (!ID.test(wabaId)) return badId();
  const r = await call<{ data?: { id?: string; whatsapp_business_api_data?: { id?: string } }[] }>('GET', `${wabaId}/subscribed_apps`, token, o);
  if (!r.ok) return r;
  return { ok: true, data: (r.data.data ?? []).map((a) => a.whatsapp_business_api_data?.id ?? a.id).filter((x): x is string => typeof x === 'string') };
}

/** Suscribe NUESTRA app a los webhooks de la cuenta (equivale a «activar» los mensajes entrantes). */
export async function subscribeApp(wabaId: string, token: string, o: GraphOpts = {}): Promise<GraphResult<true>> {
  if (!ID.test(wabaId)) return badId();
  const r = await call<{ success?: boolean }>('POST', `${wabaId}/subscribed_apps`, token, o);
  if (!r.ok) return r;
  return r.data.success === false ? { ok: false, kind: 'rejected', state: null, code: 'subscribe_failed', detail: 'Meta no confirmó la suscripción.' } : { ok: true, data: true };
}

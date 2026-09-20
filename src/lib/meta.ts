/**
 * WhatsApp Cloud API (Meta): verificación de firma, handshake del webhook, lectura de eventos y errores.
 * Módulo PURO (sin red ni base de datos): todo lo que llega de fuera se trata como no confiable.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

// ---------------------------------------------------------------- firma
/**
 * Meta firma el CUERPO CRUDO con HMAC-SHA256 y el App Secret, en `X-Hub-Signature-256: sha256=<hex>`.
 * Comparación en tiempo constante. Sin secreto configurado NADA es válido (nunca se acepta sin firma).
 */
export function verifySignature(rawBody: string, header: string | null | undefined, rawSecret: string | undefined): boolean {
  const secret = rawSecret?.trim();                       // un espacio o salto de línea invisible al pegar en Vercel no debe romper la firma
  if (!secret || secret.length < 8 || !header) return false;
  const m = /^sha256=([0-9a-fA-F]{64})$/.exec(header.trim());
  if (!m) return false;
  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest();
  const received = Buffer.from(m[1]!, 'hex');
  return received.length === expected.length && timingSafeEqual(received, expected);
}

/** Firma un cuerpo (solo para pruebas y para simular a Meta). */
export function signBody(rawBody: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')}`;
}

/** GET de verificación: Meta envía hub.mode=subscribe, hub.verify_token y hub.challenge. */
export function verifyChallenge(params: URLSearchParams, rawVerifyToken: string | undefined): string | null {
  const mode = params.get('hub.mode');
  const token = params.get('hub.verify_token')?.trim();
  const challenge = params.get('hub.challenge');
  const verifyToken = rawVerifyToken?.trim();              // mismo motivo: espacios/saltos invisibles al pegar en Vercel
  if (mode !== 'subscribe' || !challenge || !token || !verifyToken || verifyToken.length < 8) return null;
  const a = Buffer.from(token);
  const b = Buffer.from(verifyToken);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return /^[\w.-]{1,200}$/.test(challenge) ? challenge : null;   // solo se devuelve un valor inofensivo
}

// ---------------------------------------------------------------- lectura de eventos
import type { AttachmentInput } from './media';

export interface InboundMessage {
  phoneNumberId: string;
  thread: string;               // wa_id del contacto (solo dígitos)
  contactName: string | null;
  externalId: string;           // wamid
  kind: 'text' | 'media' | 'other';
  body: string;
  occurredAt: string;           // ISO
  meta: Record<string, unknown>;
  attachments?: AttachmentInput[];   // archivos / ubicación / contactos del mensaje (formato común)
}
export interface StatusUpdate {
  phoneNumberId: string;
  externalId: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  occurredAt: string;
  errorCode: string | null;
  error: string | null;
}

const MAX_ITEMS = 500;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max = 4096): string | null => (typeof v === 'string' && v.trim() !== '' ? v.slice(0, max) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v.slice(0, MAX_ITEMS) : []);
const clean = (s: string) => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

function toIso(ts: unknown): string {
  const n = typeof ts === 'string' ? Number(ts) : typeof ts === 'number' ? ts : NaN;
  const d = Number.isFinite(n) && n > 0 ? new Date(n * 1000) : new Date();
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

const MEDIA_LABEL: Record<string, string> = { image: 'Imagen', video: 'Video', audio: 'Audio', sticker: 'Sticker', document: 'Documento' };

function normalizeMessage(m: Record<string, unknown>, phoneNumberId: string, names: Map<string, string>): InboundMessage | null {
  const externalId = str(m.id, 200);
  const from = typeof m.from === 'string' ? m.from.replace(/\D/g, '') : '';
  const type = str(m.type, 40) ?? 'unsupported';
  if (!externalId || !/^\d{6,20}$/.test(from) || type === 'reaction') return null;   // las reacciones no son mensajes

  const base = { phoneNumberId, thread: from, contactName: names.get(from) ?? null, externalId, occurredAt: toIso(m.timestamp) };
  const text = (v: unknown) => (isObj(v) ? str(v.body) : null);

  if (type === 'text') {
    const body = text(m.text);
    return body ? { ...base, kind: 'text', body: clean(body), meta: {} } : null;
  }
  if (type === 'button' && isObj(m.button)) {
    const body = str(m.button.text);
    return body ? { ...base, kind: 'text', body: clean(body), meta: { type: 'button' } } : null;
  }
  if (type === 'interactive' && isObj(m.interactive)) {
    const r = isObj(m.interactive.button_reply) ? m.interactive.button_reply : isObj(m.interactive.list_reply) ? m.interactive.list_reply : null;
    const body = r ? str(r.title) : null;
    return body ? { ...base, kind: 'text', body: clean(body), meta: { type: 'interactive' } } : null;
  }
  if (type in MEDIA_LABEL) {
    const obj = isObj(m[type]) ? (m[type] as Record<string, unknown>) : {};
    const caption = str(obj.caption, 1000);
    const file = type === 'document' ? str(obj.filename, 120) : null;
    const label = `[${MEDIA_LABEL[type]}${file ? `: ${clean(file)}` : ''}]`;
    const mediaId = str(obj.id, 200);
    return {
      ...base, kind: 'media', body: caption ? `${label} ${clean(caption)}` : label,
      meta: { type, media_id: mediaId, mime_type: str(obj.mime_type, 100) },
      attachments: mediaId ? [{
        kind: type as 'image' | 'video' | 'audio' | 'document' | 'sticker', mime_type: str(obj.mime_type, 100), file_name: file ? clean(file) : null,
        is_voice: type === 'audio' && obj.voice === true, source: { media_id: mediaId, ...(str(obj.sha256, 64) ? { sha256: str(obj.sha256, 64) } : {}) },
        meta: type === 'sticker' && obj.animated === true ? { animated: true } : {},
      }] : [],
    };
  }
  if (type === 'location' && isObj(m.location)) {
    const place = str(m.location.name, 120) ?? str(m.location.address, 200);
    const lat = Number(m.location.latitude), lng = Number(m.location.longitude);
    return {
      ...base, kind: 'other', body: place ? `[Ubicación: ${clean(place)}]` : '[Ubicación]', meta: { type },
      attachments: Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180
        ? [{ kind: 'location', meta: { lat, lng, ...(place ? { name: clean(place) } : {}), ...(str(m.location.address, 200) ? { address: clean(str(m.location.address, 200)!) } : {}) } }] : [],
    };
  }
  if (type === 'contacts') {
    const people = arr(m.contacts).filter(isObj).slice(0, 5).map((c) => {
      const nm = isObj(c.name) ? str(c.name.formatted_name, 120) : null;
      const ph = arr(c.phones).filter(isObj).map((x) => str(x.phone, 40)).find(Boolean) ?? null;
      return { kind: 'contact' as const, meta: { ...(nm ? { name: clean(nm) } : {}), ...(ph ? { phone: clean(ph) } : {}) } };
    });
    return { ...base, kind: 'other', body: '[Contacto compartido]', meta: { type }, attachments: people };
  }
  return { ...base, kind: 'other', body: '[Mensaje no compatible]', meta: { type } };
}

/**
 * Convierte el JSON de Meta (entry → changes → value) en mensajes y estados. Cualquier parte malformada
 * se descarta sin fallar: un payload raro jamás debe tumbar el webhook (Meta reintentaría sin fin).
 */
export function parseWebhook(payload: unknown): { messages: InboundMessage[]; statuses: StatusUpdate[] } {
  const out = { messages: [] as InboundMessage[], statuses: [] as StatusUpdate[] };
  if (!isObj(payload) || payload.object !== 'whatsapp_business_account') return out;

  for (const entry of arr(payload.entry)) {
    if (!isObj(entry)) continue;
    for (const change of arr(entry.changes)) {
      if (!isObj(change) || change.field !== 'messages' || !isObj(change.value)) continue;
      const value = change.value;
      const phoneNumberId = isObj(value.metadata) ? str(value.metadata.phone_number_id, 40) : null;
      if (!phoneNumberId || !/^\d{5,30}$/.test(phoneNumberId)) continue;

      const names = new Map<string, string>();
      for (const c of arr(value.contacts)) {
        if (!isObj(c)) continue;
        const id = typeof c.wa_id === 'string' ? c.wa_id.replace(/\D/g, '') : '';
        const name = isObj(c.profile) ? str(c.profile.name, 160) : null;
        if (id && name) names.set(id, clean(name).trim());
      }
      for (const m of arr(value.messages)) {
        if (!isObj(m)) continue;
        const n = normalizeMessage(m, phoneNumberId, names);
        if (n) out.messages.push(n);
      }
      for (const s of arr(value.statuses)) {
        if (!isObj(s)) continue;
        const externalId = str(s.id, 200);
        const status = s.status;
        if (!externalId || (status !== 'sent' && status !== 'delivered' && status !== 'read' && status !== 'failed')) continue;
        const e = arr(s.errors)[0];
        const err = isObj(e) ? e : null;
        out.statuses.push({
          phoneNumberId, externalId, status, occurredAt: toIso(s.timestamp),
          errorCode: err ? (typeof err.code === 'number' || typeof err.code === 'string' ? String(err.code).slice(0, 40) : null) : null,
          error: err ? describeSendError(err.code, str(err.title, 200) ?? str(err.message, 200)) : null,
        });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- errores de envío (en español)
const SEND_ERRORS: Record<string, string> = {
  '131047': 'Pasaron más de 24 horas desde el último mensaje del cliente: solo se puede enviar una plantilla aprobada.',
  '131049': 'WhatsApp decidió no entregar este mensaje para cuidar la calidad de la plataforma. Espera al menos 24 horas antes de reintentar.',
  '131026': 'No se pudo entregar: el número no tiene WhatsApp o no aceptó los términos.',
  '131048': 'WhatsApp limitó los envíos por marcarlos como spam. Reduce el volumen y mejora el contenido.',
  '131051': 'Tipo de mensaje no admitido por WhatsApp.',
  '131037': 'El número de WhatsApp Business necesita que aprueben su nombre visible antes de enviar.',
  '131042': 'Hay un problema con el método de pago de WhatsApp Business.',
  '132000': 'La plantilla necesita exactamente la cantidad de datos que define su texto.',
  '130429': 'Se alcanzó el límite de mensajes por segundo. Inténtalo de nuevo en un momento.',
  '190': 'El token de acceso del canal venció o no es válido. Genera uno nuevo en Meta y actualízalo en Configuración → Conexiones.',
};
/** Oculta cualquier cosa con forma de token de Meta (EAA…): un texto de error jamás debe filtrarlo. */
const redact = (s: string) => s.replace(/EAA[A-Za-z0-9_-]{15,}/g, '[oculto]');
export function describeSendError(code: unknown, fallback?: string | null): string {
  const key = typeof code === 'number' || typeof code === 'string' ? String(code) : '';
  return SEND_ERRORS[key] ?? (fallback ? `WhatsApp rechazó el mensaje: ${redact(clean(fallback)).slice(0, 200)}` : 'WhatsApp rechazó el mensaje.');
}

// ---------------------------------------------------------------- cuerpo de envío
export function buildTextPayload(to: string, body: string) {
  return { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { preview_url: false, body } };
}
export function buildTemplatePayload(to: string, name: string, language: string, params: string[]) {
  return {
    messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'template',
    template: {
      name, language: { code: language },
      ...(params.length > 0 ? { components: [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text })) }] } : {}),
    },
  };
}

/**
 * Lógica pura del módulo Conexiones: estados con mensajes comprensibles, clasificación de errores de Meta,
 * redacción de secretos y textos de tiempo. Sin red ni base de datos.
 */

export const CONNECTION_STATES = ['pending', 'connected', 'needs_auth', 'token_expired', 'error', 'webhook_missing', 'disconnected'] as const;
export type ConnectionState = (typeof CONNECTION_STATES)[number];
export type Tone = 'ok' | 'warn' | 'danger' | 'muted';

export interface StateInfo { label: string; tone: Tone; needsAction: boolean; message: (provider: string) => string }

/** Lo que ve el usuario. Nunca detalles técnicos: eso queda en el registro de la conexión. */
export const STATE_INFO: Record<ConnectionState, StateInfo> = {
  connected: { label: 'Conectado', tone: 'ok', needsAction: false, message: (p) => `Conectado: los mensajes de esta cuenta de ${p} llegan al Inbox.` },
  pending: { label: 'Pendiente', tone: 'warn', needsAction: true, message: () => 'Falta verificar la conexión. Pulsa «Verificar» para confirmarla con Meta.' },
  needs_auth: { label: 'Requiere autorización', tone: 'danger', needsAction: true, message: (p) => `La conexión con ${p} requiere autorización nuevamente. Revisa los permisos y guarda un token válido en «Configurar».` },
  token_expired: { label: 'Token expirado', tone: 'danger', needsAction: true, message: (p) => `La conexión con ${p} requiere autorización nuevamente: el token venció. Genera uno nuevo en Meta y guárdalo en «Configurar».` },
  error: { label: 'Error de conexión', tone: 'danger', needsAction: true, message: (p) => `No pudimos comunicarnos con ${p}. Lo reintentaremos automáticamente; si sigue así, pulsa «Verificar».` },
  webhook_missing: { label: 'Webhook no configurado', tone: 'warn', needsAction: true, message: () => 'Meta todavía no está enviando los mensajes a tu CRM. Revisa que el webhook esté configurado y suscrito.' },
  disconnected: { label: 'Desconectado', tone: 'muted', needsAction: false, message: () => 'Este número está desconectado: no recibe ni envía mensajes. Tu historial se conserva.' },
};

export function stateInfo(state: string | null | undefined): StateInfo {
  return STATE_INFO[(state as ConnectionState)] ?? STATE_INFO.error;
}

export type ProviderKey = 'whatsapp' | 'instagram' | 'facebook' | 'gmail';
export interface ProviderInfo { key: ProviderKey; name: string; available: boolean; accountLabel: string; blurb: string; color: string }
export const PROVIDERS: ProviderInfo[] = [
  { key: 'whatsapp', name: 'WhatsApp', available: true, accountLabel: 'Número', blurb: 'API oficial de WhatsApp Business Platform (Meta). Recibe y responde mensajes desde el Inbox.', color: '#25d366' },
  { key: 'instagram', name: 'Instagram', available: true, accountLabel: 'Usuario de Instagram', blurb: 'Mensajes directos de tu cuenta Business/Professional, mediante Meta Graph API.', color: '#e1306c' },
  { key: 'facebook', name: 'Facebook', available: true, accountLabel: 'Página', blurb: 'Mensajes de Messenger de tus páginas, mediante Meta Graph API.', color: '#0084ff' },
  { key: 'gmail', name: 'Gmail', available: true, accountLabel: 'Cuenta de correo', blurb: 'Correos de tu cuenta Google, mediante OAuth 2.0 y Gmail API.', color: '#ea4335' },
];

// ---------------------------------------------------------------------------------------------- errores de Meta
export type Failure = { state: 'token_expired' | 'needs_auth' | 'error'; code: string };

/**
 * Traduce un error de la API de Meta al estado de la conexión. Devuelve null cuando el error NO dice nada sobre la
 * salud de la conexión (límite de velocidad, un mensaje concreto rechazado…): esos no deben marcarla como caída.
 */
export function classifyMetaError(e: { httpStatus?: number | null; code?: number | string | null; subcode?: number | string | null }): Failure | null {
  const code = e.code === null || e.code === undefined || e.code === '' ? null : Number(e.code);
  const sub = e.subcode === null || e.subcode === undefined || e.subcode === '' ? null : Number(e.subcode);
  const label = code === null || Number.isNaN(code) ? String(e.httpStatus ?? 'desconocido') : String(code);
  if (code === 190 || code === 102) return { state: 'token_expired', code: label };
  // «Mensaje fuera de la ventana permitida» (Facebook/Instagram) llega como código 10, pero habla del MENSAJE, no de la conexión.
  if (code === 10 && (sub === 2018278 || sub === 2534022)) return null;
  if (code === 3 || code === 10 || (code !== null && code >= 200 && code <= 299)) return { state: 'needs_auth', code: label };
  if (code === 100 && sub === 33) return { state: 'needs_auth', code: '100' };        // el número no existe o el token no tiene acceso a él
  if (code === 368 || code === 130497) return { state: 'error', code: label };        // cuenta restringida o bloqueada
  if (code !== null && !Number.isNaN(code)) return null;                                // límite de velocidad, error de un mensaje concreto…
  if (e.httpStatus === 401 || e.httpStatus === 403) return { state: 'needs_auth', code: label };
  return null;
}

// ---------------------------------------------------------------------------------------------- secretos
/** Quita de un texto cualquier cosa que parezca un token o una credencial. Se aplica a TODO lo que se guarda o se registra. */
export function redact(text: string | null | undefined, max = 500): string {
  return String(text ?? '')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [token]')
    .replace(/EAA[A-Za-z0-9_-]{16,}/g, '[token]')
    .replace(/(access_token|client_secret|refresh_token|app_secret|token)=([^&\s"']+)/gi, '$1=[token]')
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '[token]')
    .slice(0, max);
}

export function webhookUrl(siteUrl: string | undefined | null): string | null {
  const s = (siteUrl ?? '').trim().replace(/\/+$/, '');
  return /^https?:\/\//i.test(s) ? `${s}/api/webhooks/meta` : null;
}

/** «hace 5 min». Determinista (no depende del idioma del navegador). */
export function timeAgo(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return 'Nunca';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 'Nunca';
  const s = Math.max(0, Math.floor((now.getTime() - t) / 1000));
  if (s < 60) return 'hace un momento';
  if (s < 3600) return `hace ${Math.floor(s / 60)} min`;
  if (s < 86400) return `hace ${Math.floor(s / 3600)} h`;
  if (s < 30 * 86400) { const d = Math.floor(s / 86400); return `hace ${d} ${d === 1 ? 'día' : 'días'}`; }
  const d = new Date(t);
  return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
}

/** Un canal necesita verificación si nunca se verificó o si pasó el plazo (más corto cuando hay un problema). */
export function isCheckDue(c: { connectionStatus: string; lastCheckedAt: string | null }, now: Date = new Date()): boolean {
  if (c.connectionStatus === 'disconnected') return false;
  if (!c.lastCheckedAt) return true;
  const age = now.getTime() - new Date(c.lastCheckedAt).getTime();
  return age > (c.connectionStatus === 'connected' ? 6 * 3600_000 : 30 * 60_000);
}

/** Aviso al terminar una verificación/conexión: qué le decimos al administrador (comprensible, sin jerga). */
export const PROVIDER_NAME: Record<string, string> = { whatsapp: 'WhatsApp', facebook: 'Facebook', instagram: 'Instagram', gmail: 'Gmail' };
export function outcomeNotice(state: ConnectionState, provider = 'WhatsApp', accountName?: string | null): { kind: 'ok' | 'error'; message: string } {
  if (state === 'connected') return { kind: 'ok', message: `${accountName ? `${accountName}: ` : ''}conexión verificada. Los mensajes de esta cuenta llegan al Inbox.` };
  return { kind: 'error', message: stateInfo(state).message(provider) };
}

/** Errores de Google (OAuth y Gmail API) → estado de la conexión. Un límite de velocidad o una caída no marcan nada. */
export function classifyGoogleError(e: { status?: number | null; error?: string | null; reason?: string | null }): Failure | null {
  const err = (e.error ?? '').toLowerCase(); const reason = (e.reason ?? '').toLowerCase();
  if (err === 'invalid_grant' || err === 'invalid_client' || err === 'unauthorized_client') return { state: 'token_expired', code: err };
  if (e.status === 401) return { state: 'token_expired', code: '401' };
  if (e.status === 403 && /insufficient|scope|permission/.test(`${err} ${reason}`)) return { state: 'needs_auth', code: '403' };
  if (e.status === 403 && /ratelimit|quota|userratelimit/.test(`${err} ${reason}`)) return null;
  if (e.status === 403) return { state: 'needs_auth', code: '403' };
  return null;
}

/** Mensaje comprensible cuando Facebook/Instagram rechazan un envío. */
export function describeSocialError(code: unknown, subcode?: unknown, fallback?: string | null): string {
  const c = String(code ?? ''); const sc = String(subcode ?? '');
  if (c === '10' && (sc === '2018278' || sc === '2534022')) return 'Pasaron más de 24 horas desde el último mensaje de este cliente: ya no puedes escribirle por aquí hasta que él escriba de nuevo.';
  if (c === '190' || c === '102') return 'La conexión venció. Vuelve a autorizarla en Configuración → Conexiones.';
  if (c === '10' || (Number(c) >= 200 && Number(c) <= 299)) return 'La conexión no tiene permiso para enviar mensajes. Vuelve a autorizarla en Configuración → Conexiones.';
  if (c === '551') return 'Esta persona no está disponible para recibir mensajes ahora.';
  if (c === '613' || c === '4' || c === '17' || c === '32') return 'Se están enviando demasiados mensajes. Espera unos minutos e inténtalo de nuevo.';
  if (c === '100') return 'Meta no pudo entregar el mensaje a esta persona (puede haber bloqueado la cuenta o borrado la conversación).';
  return redact(fallback ?? '', 200) || 'No se pudo enviar el mensaje.';
}

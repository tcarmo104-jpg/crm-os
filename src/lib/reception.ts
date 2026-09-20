/**
 * Diagnóstico de recepción de WhatsApp: con lo que el CRM sabe, dice EN UNA FRASE qué falla y qué hacer.
 * Lógica pura (sin red ni base de datos). Distingue los tres casos que antes eran imposibles de separar:
 *   1) Meta NO llega al CRM  ·  2) Meta llega y el CRM lo RECHAZA  ·  3) Meta llega y no se ve nada.
 */
export type Outcome = 'verify_ok' | 'verify_rejected' | 'accepted' | 'bad_signature' | 'no_secret' | 'bad_payload';
export interface Stat { hits: number; lastAt: string | null }
export type Stats = Record<Outcome, Stat>;
export const emptyStats = (): Stats => ({ verify_ok: { hits: 0, lastAt: null }, verify_rejected: { hits: 0, lastAt: null }, accepted: { hits: 0, lastAt: null }, bad_signature: { hits: 0, lastAt: null }, no_secret: { hits: 0, lastAt: null }, bad_payload: { hits: 0, lastAt: null } });

export function statsFromRows(rows: { outcome: string; hits: number | string; last_at: string | null }[]): Stats {
  const s = emptyStats();
  for (const r of rows) if (r.outcome in s) s[r.outcome as Outcome] = { hits: Number(r.hits) || 0, lastAt: r.last_at };
  return s;
}

export type Subscription = 'ok' | 'missing' | 'wrong_url' | 'no_messages' | 'error';
export interface MetaCheck { appId: string | null; tokenValid: boolean | null; tokenExpiresAt: string | null; subscription: Subscription; callbackUrl: string | null; expectedUrl: string | null; error?: string }
export interface ReceptionFacts {
  secretSet: boolean; verifyTokenSet: boolean; siteUrlOk: boolean;
  stats: Stats; wabaSubscribed: boolean | null; channelLastWebhookAt: string | null;
  /** Solo si se ejecutó el diagnóstico completo (llama a Meta). */
  meta: MetaCheck | null;
}
export type StepStatus = 'ok' | 'fail' | 'warn' | 'todo';
export interface Step { key: string; title: string; status: StepStatus; detail: string }
export interface Verdict { kind: 'ok' | 'action' | 'unknown'; title: string; action: string; canAutoConfigure: boolean }

const t = (iso: string | null) => (iso ? new Date(iso).getTime() : 0);
const ago = (iso: string | null, now: Date): string => {
  if (!iso) return 'nunca';
  const s = Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 1000));
  if (s < 90) return 'hace un momento';
  if (s < 3600) return `hace ${Math.floor(s / 60)} min`;
  if (s < 86400) return `hace ${Math.floor(s / 3600)} h`;
  return `hace ${Math.floor(s / 86400)} días`;
};
const HOUR = 3600_000;

export function diagnoseReception(f: ReceptionFacts, now: Date = new Date()): { steps: Step[]; verdict: Verdict } {
  const s = f.stats;
  const noApp = !f.secretSet || !f.verifyTokenSet;
  const signatureBroken = s.bad_signature.hits > 0 && (s.accepted.hits === 0 || t(s.bad_signature.lastAt) > t(s.accepted.lastAt));
  const verifyBroken = s.verify_rejected.hits > 0 && s.verify_ok.hits === 0;
  const neverContacted = s.verify_ok.hits === 0 && s.verify_rejected.hits === 0 && s.accepted.hits === 0 && s.bad_signature.hits === 0;
  const m = f.meta;
  const expiresMs = m?.tokenExpiresAt ? new Date(m.tokenExpiresAt).getTime() - now.getTime() : null;

  const steps: Step[] = [];
  steps.push({ key: 'vars', title: 'Tu aplicación de Meta está conectada al CRM', status: noApp || !f.siteUrlOk ? 'fail' : 'ok',
    detail: noApp ? 'Todavía no: pega el Identificador y la Clave secreta de tu app en «Tu aplicación de Meta» (en la página de Conexiones).' : !f.siteUrlOk ? 'Sí, pero el CRM se abrió desde una dirección local o sin https: ábrelo desde su dirección pública.' : 'Sí: el CRM tiene la clave y el token de verificación de tu app.' });
  steps.push({ key: 'verify', title: 'Meta verificó la dirección de tu CRM',
    status: s.verify_ok.hits > 0 ? 'ok' : verifyBroken ? 'fail' : 'todo',
    detail: s.verify_ok.hits > 0 ? `Sí (última vez ${ago(s.verify_ok.lastAt, now)}).` : verifyBroken ? `Meta lo intentó ${s.verify_rejected.hits} ${s.verify_rejected.hits === 1 ? 'vez' : 'veces'} pero el token de verificación no coincide.` : 'Meta todavía no ha intentado conectarse a tu CRM.' });
  if (m) {
    const label: Record<Subscription, string> = {
      ok: 'Meta tiene tu webhook configurado con el campo «messages».', missing: 'Meta no tiene ningún webhook configurado para WhatsApp en tu app.',
      wrong_url: `Meta envía los mensajes a otra dirección${m.callbackUrl ? ` (${m.callbackUrl})` : ''}.`, no_messages: 'El webhook existe pero no está suscrito al campo «messages».',
      error: `No se pudo consultar a Meta${m.error ? `: ${m.error}` : ''}.`,
    };
    steps.push({ key: 'meta', title: 'Configuración del webhook en Meta', status: m.subscription === 'ok' ? 'ok' : m.subscription === 'error' ? 'warn' : 'fail', detail: label[m.subscription] });
  } else {
    steps.push({ key: 'meta', title: 'Configuración del webhook en Meta', status: 'todo', detail: 'Pulsa «Ejecutar diagnóstico completo» para consultarlo directamente a Meta.' });
  }
  steps.push({ key: 'waba', title: 'Tu cuenta de WhatsApp Business está suscrita a tu app', status: f.wabaSubscribed === true ? 'ok' : f.wabaSubscribed === false ? 'fail' : 'todo',
    detail: f.wabaSubscribed === true ? 'Sí.' : f.wabaSubscribed === false ? 'No: pulsa «Verificar ahora» y el CRM la suscribe.' : 'Aún sin verificar: pulsa «Verificar ahora».' });
  steps.push({ key: 'signature', title: 'Los mensajes de Meta se aceptan (firma correcta)',
    status: signatureBroken ? 'fail' : s.accepted.hits > 0 ? 'ok' : 'todo',
    detail: signatureBroken ? `Meta SÍ está llegando (${s.bad_signature.hits} ${s.bad_signature.hits === 1 ? 'aviso' : 'avisos'}, último ${ago(s.bad_signature.lastAt, now)}) pero se rechazan: la clave secreta no coincide con la de la app de Meta.`
      : s.accepted.hits > 0 ? `Sí: ${s.accepted.hits} ${s.accepted.hits === 1 ? 'aviso aceptado' : 'avisos aceptados'} (último ${ago(s.accepted.lastAt, now)}).` : 'Todavía no ha llegado ningún aviso de Meta.' });
  steps.push({ key: 'messages', title: 'Se ven mensajes en el Inbox', status: f.channelLastWebhookAt ? 'ok' : s.accepted.hits > 0 ? 'warn' : 'todo',
    detail: f.channelLastWebhookAt ? `Último mensaje recibido ${ago(f.channelLastWebhookAt, now)}.` : s.accepted.hits > 0 ? 'Llegan avisos, pero ninguno era un mensaje de este número.' : 'Aún ninguno.' });
  if (m && m.tokenValid !== null) {
    const soon = expiresMs !== null && expiresMs < 48 * HOUR;
    steps.push({ key: 'token', title: 'El token de acceso está vigente', status: m.tokenValid === false || (expiresMs !== null && expiresMs <= 0) ? 'fail' : soon ? 'warn' : 'ok',
      detail: m.tokenValid === false ? 'El token ya no es válido.' : expiresMs === null ? 'No vence.' : expiresMs <= 0 ? 'Ya venció.' : `Vence en ${Math.max(1, Math.round(expiresMs / HOUR))} h${soon ? ': es un token TEMPORAL, genera uno permanente.' : '.'}` });
  }

  // ------------------------------------------------------------------ una sola frase: lo primero que falla
  let verdict: Verdict;
  if (noApp) {
    verdict = { kind: 'action', canAutoConfigure: false, title: 'Falta conectar tu aplicación de Meta al CRM.',
      action: 'En la página de Conexiones (arriba), en «Tu aplicación de Meta», pega el Identificador y la Clave secreta de tu app (Meta → tu app → Configuración de la app → Básica) y pulsa «Guardar y conectar». El CRM hace el resto, incluido el webhook.' };
  } else if (!f.siteUrlOk) {
    verdict = { kind: 'action', canAutoConfigure: false, title: 'El CRM se abrió desde una dirección local o sin https.',
      action: 'Abre el CRM desde su dirección pública (la que empieza con https://) y vuelve a esta pantalla: Meta solo acepta direcciones públicas con https.' };
  } else if (signatureBroken) {
    verdict = { kind: 'action', canAutoConfigure: false, title: 'Meta SÍ está enviando mensajes, pero el CRM los rechaza: la clave secreta no coincide.',
      action: 'En Meta → tu app → Configuración de la app → Básica, muestra la «Clave secreta de la app» y cópiala de nuevo (de LA MISMA app cuyo webhook configuraste). En Conexiones → «Tu aplicación de Meta» pégala sin espacios y pulsa «Guardar y conectar».' };
  } else if (verifyBroken || m?.subscription === 'wrong_url') {
    verdict = { kind: 'action', canAutoConfigure: true, title: verifyBroken ? 'Meta intentó conectarse, pero el token de verificación no coincide.' : 'Meta está enviando los mensajes a otra dirección.',
      action: 'Pulsa «Configurar el webhook en Meta automáticamente»: el CRM lo deja con la dirección y el token correctos, sin que tengas que copiar nada.' };
  } else if (m && (m.subscription === 'missing' || m.subscription === 'no_messages') || (!m && neverContacted)) {
    verdict = { kind: 'action', canAutoConfigure: true, title: m?.subscription === 'no_messages' ? 'El webhook de Meta no está suscrito a «messages».' : 'Meta todavía no sabe a dónde enviar tus mensajes: el webhook no está configurado.',
      action: 'Pulsa «Configurar el webhook en Meta automáticamente». Si te pide algo, sigue lo que diga el aviso.' };
  } else if (f.wabaSubscribed === false) {
    verdict = { kind: 'action', canAutoConfigure: false, title: 'Tu cuenta de WhatsApp Business no está suscrita a tu app.', action: 'Pulsa «Verificar ahora»: el CRM la suscribe solo. Si no se corrige, revisa que el token tenga el permiso whatsapp_business_management.' };
  } else if (m && (m.tokenValid === false || (expiresMs !== null && expiresMs <= 0))) {
    verdict = { kind: 'action', canAutoConfigure: false, title: 'El token de acceso venció o no es válido.', action: 'En Meta genera un token PERMANENTE (usuario del sistema) y guárdalo en «Credenciales → Reemplazar el token».' };
  } else if (f.channelLastWebhookAt) {
    verdict = { kind: 'ok', canAutoConfigure: false, title: 'Todo funciona: ya están llegando mensajes.', action: expiresMs !== null && expiresMs < 48 * HOUR ? 'Atención: tu token es temporal y vence pronto. Genera uno permanente para que no se corte.' : 'No necesitas hacer nada.' };
  } else if (s.accepted.hits > 0) {
    verdict = { kind: 'unknown', canAutoConfigure: false, title: 'Meta ya está conectado y firmando bien, pero aún no llega un mensaje de este número.',
      action: 'Haz la prueba: en Meta → Configuración de la API agrega tu celular en «Para», envía el mensaje de prueba y RESPÓNDELO desde tu celular. Esa respuesta debe aparecer en el Inbox.' };
  } else {
    verdict = { kind: 'unknown', canAutoConfigure: true, title: 'La configuración parece completa, pero todavía no llega ningún aviso de Meta.',
      action: 'Pulsa «Ejecutar diagnóstico completo» para que el CRM consulte a Meta, o haz la prueba respondiendo al mensaje de prueba desde tu celular.' };
  }
  return { steps, verdict };
}

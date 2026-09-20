import 'server-only';
import { redact, webhookUrl } from '@/lib/connections';
import { statsFromRows, type MetaCheck, type ReceptionFacts, type Subscription } from '@/lib/reception';
import { SecretError, openSecret } from '@/lib/secrets';
import { isPublicHttps } from '@/lib/origin';
import type { ServerSupabase } from '@/lib/supabase/server';
import { metaAppFor, newVerifyToken, saveProviderApp } from './provider-apps';
import type { createAdminClient } from './supabase-admin';
import { graphCall, type GraphOpts } from './whatsapp-graph';

type Admin = ReturnType<typeof createAdminClient>;
const appToken = (appId: string, secret: string) => `${appId}|${secret}`;
const normUrl = (u: string | null | undefined) => (u ?? '').trim().toLowerCase().replace(/\/+$/, '');

/** Datos del token de acceso (a qué app pertenece y cuándo vence). Meta permite consultar el propio token. */
export async function tokenInfo(token: string, o: GraphOpts = {}): Promise<{ appId: string | null; valid: boolean | null; expiresAt: string | null }> {
  const r = await graphCall<{ data?: { app_id?: string; is_valid?: boolean; expires_at?: number } }>('GET', 'debug_token', token, { ...o, params: { input_token: token } });
  if (!r.ok) return { appId: null, valid: r.kind === 'rejected' && r.state === 'token_expired' ? false : null, expiresAt: null };
  const d = r.data.data ?? {};
  const exp = typeof d.expires_at === 'number' && d.expires_at > 0 ? new Date(d.expires_at * 1000).toISOString() : null;   // 0 = no vence
  return { appId: d.app_id && /^\d{5,30}$/.test(d.app_id) ? d.app_id : null, valid: typeof d.is_valid === 'boolean' ? d.is_valid : null, expiresAt: exp };
}

interface AppSub { object?: string; callback_url?: string; active?: boolean; fields?: { name?: string }[] }
/** ¿Qué webhooks tiene Meta configurados para esta app? (se consulta con la app, no con el token del cliente). */
export async function appSubscriptions(appId: string, secret: string, o: GraphOpts = {}) {
  return graphCall<{ data?: AppSub[] }>('GET', `${encodeURIComponent(appId)}/subscriptions`, appToken(appId, secret), o);
}

/** Compara lo que Meta tiene con lo que el CRM espera. */
export function judgeSubscription(list: AppSub[], expectedUrl: string | null): { subscription: Subscription; callbackUrl: string | null } {
  const wa = list.find((s) => s.object === 'whatsapp_business_account');
  if (!wa) return { subscription: 'missing', callbackUrl: null };
  const url = wa.callback_url ?? null;
  if (expectedUrl && normUrl(url) !== normUrl(expectedUrl)) return { subscription: 'wrong_url', callbackUrl: url };
  if (!(wa.fields ?? []).some((f) => f.name === 'messages')) return { subscription: 'no_messages', callbackUrl: url };
  return { subscription: 'ok', callbackUrl: url };
}

export type ConfigureResult = { ok: true } | { ok: false; message: string };
/**
 * Deja configurado el webhook de WhatsApp en la app de Meta (URL + token de verificación + campo «messages»): es lo que antes se hacía a mano
 * en el panel de Meta. Meta verifica la dirección en el momento, así que si el token o el sitio están mal, lo dice aquí.
 */
export async function configureWebhook(appId: string, secret: string, callbackUrl: string, verifyToken: string, o: GraphOpts = {}): Promise<ConfigureResult> {
  const r = await graphCall<{ success?: boolean }>('POST', `${encodeURIComponent(appId)}/subscriptions`, appToken(appId, secret), {
    ...o, form: { object: 'whatsapp_business_account', callback_url: callbackUrl, verify_token: verifyToken, fields: 'messages' },
  });
  if (r.ok) return r.data.success === false ? { ok: false, message: 'Meta no confirmó el cambio. Inténtalo de nuevo.' } : { ok: true };
  if (r.kind === 'transient') return { ok: false, message: 'No pudimos comunicarnos con Meta. Inténtalo de nuevo en unos minutos.' };
  const d = `${r.code} ${r.detail}`.toLowerCase();
  if (/verif|challenge|callback/.test(d) || r.code === '2200') return { ok: false, message: 'Meta no pudo verificar la dirección de tu CRM. Comprueba que META_VERIFY_TOKEN esté guardado en Vercel y que ya hiciste Redeploy después de guardarlo (el sitio debe estar en línea).' };
  if (r.state === 'token_expired' || r.code === '190' || r.code === '100' || /app secret|signature|invalid app|oauth/.test(d)) return { ok: false, message: 'Meta no aceptó las credenciales de la app: META_APP_SECRET debe ser la «Clave secreta de la app» de esa misma app (Configuración de la app → Básica).' };
  if (r.state === 'needs_auth') return { ok: false, message: 'Meta indica que falta un permiso para configurar el webhook. Revisa los permisos de tu app.' };
  return { ok: false, message: `Meta rechazó el cambio (${redact(r.detail, 120)}).` };
}

// ---------------------------------------------------------------------------------------------- reunir lo que se sabe
export interface ChannelInfo { id: string; orgId: string; metadata: Record<string, unknown>; lastWebhookAt: string | null }
export interface ReceptionDeps extends GraphOpts { env?: NodeJS.ProcessEnv }

async function channelToken(admin: Admin, channelId: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  const r = await admin.rpc('channel_credentials', { p_channel: channelId });
  if (r.error || typeof r.data !== 'string' || !r.data) return null;
  try { return openSecret(r.data, env); } catch (e) { if (e instanceof SecretError) return null; throw e; }
}

/** Todo lo que el diagnóstico necesita. Con `full` también consulta a Meta (más lento: solo cuando la persona lo pide). */
export async function gatherReceptionFacts(admin: Admin, ch: ChannelInfo, o: { full: boolean; origin: string | null }, deps: ReceptionDeps = {}): Promise<ReceptionFacts> {
  const env = deps.env ?? process.env;
  const app = await metaAppFor(admin, ch.orgId, env);
  const rows = await admin.rpc('webhook_stats_summary', { p_days: 14 });
  const facts: ReceptionFacts = {
    secretSet: Boolean(app), verifyTokenSet: Boolean(app?.verifyToken), siteUrlOk: isPublicHttps(o.origin),
    stats: statsFromRows(rows.error ? [] : ((rows.data ?? []) as { outcome: string; hits: number; last_at: string | null }[])),
    wabaSubscribed: typeof ch.metadata.webhook_subscribed === 'boolean' ? ch.metadata.webhook_subscribed : null, channelLastWebhookAt: ch.lastWebhookAt, meta: null,
  };
  if (!o.full) return facts;
  const expected = webhookUrl(o.origin);
  const token = await channelToken(admin, ch.id, env);
  const check: MetaCheck = { appId: null, tokenValid: null, tokenExpiresAt: null, subscription: 'error', callbackUrl: null, expectedUrl: expected };
  if (!token) { check.error = 'no hay un token guardado'; facts.meta = check; return facts; }
  const info = await tokenInfo(token, deps);
  check.tokenValid = info.valid; check.tokenExpiresAt = info.expiresAt;
  check.appId = app?.appId || info.appId;
  if (!app) check.error = 'primero conecta tu aplicación de Meta';
  else if (!check.appId) check.error = 'no se pudo saber a qué app de Meta pertenece el token';
  else {
    const subs = await appSubscriptions(check.appId, app.secret, deps);
    if (!subs.ok) check.error = subs.kind === 'transient' ? 'Meta no respondió' : subs.detail;
    else Object.assign(check, judgeSubscription(subs.data.data ?? [], expected));
  }
  facts.meta = check;
  return facts;
}

/** El botón «Configurar el webhook en Meta automáticamente» (para una conexión ya creada). */
export async function configureReceptionWebhook(admin: Admin, o: { channelId: string; orgId: string; origin: string | null }, deps: ReceptionDeps = {}): Promise<ConfigureResult> {
  const env = deps.env ?? process.env;
  const app = await metaAppFor(admin, o.orgId, env);
  if (!app) return { ok: false, message: 'Primero conecta tu aplicación de Meta: en Conexiones, «Tu aplicación de Meta», pega el Identificador y la Clave secreta.' };
  if (!app.verifyToken) return { ok: false, message: 'Tu aplicación no tiene un token de verificación. Vuelve a guardarla en «Tu aplicación de Meta» y se crea uno solo.' };
  if (!isPublicHttps(o.origin)) return { ok: false, message: 'Abre el CRM desde su dirección pública con https:// (no desde localhost) para poder configurar el webhook.' };
  let appId = app.appId;
  if (!appId) {
    const token = await channelToken(admin, o.channelId, env);
    if (!token) return { ok: false, message: 'Esta conexión no tiene un token guardado. Guarda uno válido en «Credenciales» y vuelve a intentarlo.' };
    appId = (await tokenInfo(token, deps)).appId ?? '';
  }
  if (!appId) return { ok: false, message: 'No pudimos saber a qué app de Meta pertenece tu conexión. Conéctala en «Tu aplicación de Meta» con su Identificador.' };
  return configureWebhook(appId, app.secret, webhookUrl(o.origin)!, app.verifyToken, deps);
}

// ---------------------------------------------------------------------------------------------- conectar la aplicación de Meta
const APP_ID = /^\d{5,30}$/;
export type ConnectAppResult = { ok: true; appName: string | null; webhook: ConfigureResult } | { ok: false; message: string };
/**
 * «Tu aplicación de Meta»: con solo el Identificador y la Clave secreta, (1) comprueba con Meta que son de verdad, (2) los guarda cifrados en el CRM,
 * (3) crea un token de verificación y (4) configura el webhook en Meta. Nada de Vercel.
 */
export async function connectMetaApp(db: ServerSupabase, o: { orgId: string; appId: string; secret: string; origin: string | null }, deps: ReceptionDeps = {}): Promise<ConnectAppResult> {
  const appId = o.appId.trim(), secret = o.secret.trim();
  if (!APP_ID.test(appId)) return { ok: false, message: 'El Identificador de la app son solo números (por ejemplo 3431407853702583). Cópialo de Meta → tu app → Configuración de la app → Básica.' };
  if (secret.length < 16 || secret.length > 128 || /\s/.test(secret)) return { ok: false, message: 'La Clave secreta de la app son unas 32 letras y números, sin espacios. Cópiala de Meta → Configuración de la app → Básica → «Mostrar».' };
  const check = await graphCall<{ id?: string; name?: string }>('GET', encodeURIComponent(appId), appToken(appId, secret), { ...deps, params: { fields: 'id,name' } });
  if (!check.ok) {
    if (check.kind === 'transient') return { ok: false, message: 'No pudimos comunicarnos con Meta para comprobar tus datos. Inténtalo de nuevo en unos minutos.' };
    return { ok: false, message: 'Meta no reconoce esa combinación: el Identificador y la Clave secreta deben ser de la MISMA app. Vuelve a copiarlos de Configuración de la app → Básica (sin espacios).' };
  }
  if (check.data.id && check.data.id !== appId) return { ok: false, message: 'Meta respondió por otra app. Revisa el Identificador.' };
  const verifyToken = newVerifyToken();
  await saveProviderApp(db, o.orgId, 'meta', { clientId: appId, secret, verifyToken }, deps.env ?? process.env);
  const webhook: ConfigureResult = isPublicHttps(o.origin)
    ? await configureWebhook(appId, secret, webhookUrl(o.origin)!, verifyToken, deps)
    : { ok: false, message: 'Abre el CRM desde su dirección pública con https:// para configurar el webhook (ahora estás en una dirección local).' };
  return { ok: true, appName: check.data.name ?? null, webhook };
}

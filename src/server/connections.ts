import 'server-only';
import { z } from 'zod';
import { isCheckDue, redact, type ConnectionState } from '@/lib/connections';
import { GOOGLE_REQUIRED_SCOPES } from '@/lib/social';
import { inboxBody, parseGmailMessage, shouldSync } from '@/lib/gmail';
import { SecretError, openSecret, sealSecret } from '@/lib/secrets';
import type { ServerSupabase } from '@/lib/supabase/server';
import { UserFacingError } from '@/lib/errors';
import * as inbox from '@/repositories/inbox';
import type { createAdminClient } from './supabase-admin';
import { fetchPhoneNumber, listSubscribedApps, subscribeApp, type GraphFailure, type GraphOpts } from './whatsapp-graph';
import { exchangeMetaCode, extendMetaToken, fetchIgAccount, fetchPage, listPages, pageSubscription, subscribePage, type MetaPage } from './meta-social';
import { exchangeGoogleCode, getGmailMessage, gmailProfile, listHistory, listInbox, refreshGoogleToken, type GoogleFailure } from './gmail';

type Admin = ReturnType<typeof createAdminClient>;
export interface Deps extends GraphOpts { env?: NodeJS.ProcessEnv; now?: Date }
export type ProviderKind = 'whatsapp' | 'facebook' | 'instagram' | 'gmail';
export interface VerifyOutcome { state: ConnectionState; accountName: string | null; detail: string | null; kind?: ProviderKind }

interface ChannelRow {
  id: string; org_id: string; kind?: 'whatsapp' | 'facebook' | 'instagram' | 'gmail'; metadata?: Record<string, unknown> | null; external_id: string; business_account_id: string | null; connection_status: ConnectionState;
  last_webhook_at: string | null; connected_at: string | null; created_at: string;
}
const NO_WEBHOOK_GRACE_MS = 30 * 60_000;

async function record(admin: Admin, id: string, state: ConnectionState, code: string | null, detail: string, extra: { name?: string | null; phone?: string | null; waba?: string | null; meta?: Record<string, unknown> } = {}) {
  await admin.rpc('record_channel_health', {
    p_channel: id, p_state: state, p_code: code, p_detail: redact(detail), p_account_name: extra.name ?? null,
    p_display_phone: extra.phone ?? null, p_business_account_id: extra.waba ?? null, p_metadata: extra.meta ?? {},
  });
}

/**
 * Verifica una conexión con Meta: el token funciona, el número existe y la app está suscrita a sus webhooks
 * (si no lo está, intenta suscribirla). Registra el resultado. NUNCA devuelve ni registra el token.
 */
export async function verifyChannel(admin: Admin, channelId: string, deps: Deps = {}): Promise<VerifyOutcome> {
  const env = deps.env ?? process.env;
  const q = await admin.from('channels').select('id, org_id, kind, metadata, external_id, business_account_id, connection_status, last_webhook_at, connected_at, created_at').eq('id', channelId).maybeSingle();
  const ch = q.data as ChannelRow | null;
  if (q.error || !ch) throw new Error('channel_not_found');
  if (ch.connection_status === 'disconnected') return { state: 'disconnected', accountName: null, detail: null, kind: ch.kind ?? 'whatsapp' };
  const done = async (state: ConnectionState, code: string | null, detail: string, extra: Parameters<typeof record>[5] = {}): Promise<VerifyOutcome> => {
    await record(admin, channelId, state, code, detail, extra);
    return { state, accountName: extra.name ?? null, detail: state === 'connected' ? null : redact(detail), kind: ch.kind ?? 'whatsapp' };
  };
  const failed = (f: GraphFailure) => done(f.state ?? 'error', f.code, f.detail);

  // 1) Token
  const cred = await admin.rpc('channel_credentials', { p_channel: channelId });
  const stored = typeof cred.data === 'string' && cred.data ? cred.data : null;
  if (cred.error || !stored) return done('needs_auth', 'no_token', 'No hay un token guardado para esta conexión.');
  let token: string;
  try { token = openSecret(stored, env); } catch (e) {
    return done('needs_auth', e instanceof SecretError ? e.reason : 'secret_error', 'No se pudo abrir el token guardado (revisa CONNECTIONS_ENCRYPTION_KEY).');
  }

  const kind = ch.kind ?? 'whatsapp';
  if (kind === 'facebook' || kind === 'instagram') return verifyMetaPage(ch, kind, token, done, failed, deps, env);
  if (kind === 'gmail') return verifyGmail(ch, token, done, env, deps);

  // 2) El número existe y el token tiene acceso a él
  const phone = await fetchPhoneNumber(ch.external_id, token, deps);
  if (!phone.ok) return failed(phone);
  const info = phone.data;
  const extra = {
    name: info.verified_name ?? null, phone: info.display_phone_number ?? null,
    meta: { quality_rating: info.quality_rating ?? null, name_status: info.name_status ?? null, verification: info.code_verification_status ?? null, platform: info.platform_type ?? null },
  };

  // 3) Webhook
  const waba = ch.business_account_id;
  if (waba) {
    const subs = await listSubscribedApps(waba, token, deps);
    if (!subs.ok) return failed(subs);
    const appId = (env.META_APP_ID ?? '').trim();
    const subscribed = appId ? subs.data.includes(appId) : subs.data.length > 0;
    if (!subscribed) {
      const sub = await subscribeApp(waba, token, deps);
      if (!sub.ok) return done('webhook_missing', sub.code, `No se pudo suscribir la app a los webhooks: ${sub.detail}`, extra);
    }
    return done('connected', null, subscribed ? 'Número verificado; webhook suscrito.' : 'Número verificado; se suscribió la app al webhook.', { ...extra, meta: { ...extra.meta, webhook_subscribed: true } });
  }
  // Sin la cuenta de WhatsApp Business no se puede comprobar la suscripción: solo cuenta lo que realmente llegó.
  const since = new Date(ch.connected_at ?? ch.created_at).getTime();
  const grace = (deps.now ?? new Date()).getTime() - since < NO_WEBHOOK_GRACE_MS;
  if (!ch.last_webhook_at && !grace) return done('webhook_missing', 'no_webhook', 'Nunca ha llegado un mensaje de este número y falta la cuenta de WhatsApp Business para comprobar la suscripción.', extra);
  return done('connected', null, 'Número verificado (sin cuenta de WhatsApp Business no se pudo comprobar el webhook).', { ...extra, meta: { ...extra.meta, webhook_subscribed: null } });
}

// ---------------------------------------------------------------------------------------------- conectar
const connectSchema = z.object({
  name: z.string().trim().max(80, 'El nombre es demasiado largo (máximo 80 caracteres).').optional(),
  phoneNumberId: z.string().trim().regex(/^\d{5,30}$/, 'El ID del número de teléfono son solo dígitos (lo ves en Meta → WhatsApp → Configuración de la API).'),
  businessAccountId: z.string().trim().regex(/^\d{5,30}$/, 'El ID de la cuenta de WhatsApp Business son solo dígitos (lo ves junto al ID del número en Meta).'),
  token: z.string().trim().min(20, 'El token de acceso parece incompleto.').max(1000, 'El token de acceso es demasiado largo.').regex(/^\S+$/, 'El token no puede contener espacios.'),
});

function friendly(f: GraphFailure): string {
  if (f.state === 'token_expired') return 'El token no es válido o ya venció. Genera uno nuevo en Meta (usuario del sistema → token permanente) e inténtalo de nuevo.';
  if (f.state === 'needs_auth') return 'El token no tiene acceso a ese número. Revisa que incluya los permisos whatsapp_business_messaging y whatsapp_business_management, y que el ID del número sea el correcto.';
  if (f.kind === 'transient') return 'No pudimos comunicarnos con Meta. Inténtalo de nuevo en unos minutos.';
  return 'Meta rechazó los datos. Revisa el ID del número, el ID de la cuenta y el token.';
}

/**
 * Conecta (o reconecta) un número de WhatsApp. Primero comprueba con Meta que el token y el número son válidos:
 * si no lo son, NO se guarda nada. Después crea o actualiza la conexión y la verifica (suscribiendo el webhook).
 */
export async function connectWhatsApp(db: ServerSupabase, admin: Admin, orgId: string, input: unknown, deps: Deps = {}): Promise<{ channelId: string; outcome: VerifyOutcome; reconnected: boolean }> {
  const parsed = connectSchema.safeParse(input);
  if (!parsed.success) throw new UserFacingError(parsed.error.issues[0]?.message ?? 'Datos no válidos.');
  const d = parsed.data;

  const probe = await fetchPhoneNumber(d.phoneNumberId, d.token, deps);
  if (!probe.ok) throw new UserFacingError(friendly(probe));

  const existing = (await inbox.listChannels(db, orgId)).find((c) => c.externalId === d.phoneNumberId);
  let channelId: string;
  if (existing) {
    channelId = existing.id;
    await inbox.saveChannelToken(db, channelId, d.token);
  } else {
    channelId = await inbox.createChannel(db, orgId, {
      name: d.name || probe.data.verified_name || `WhatsApp ${d.phoneNumberId.slice(-4)}`, phoneNumberId: d.phoneNumberId,
      displayPhone: probe.data.display_phone_number, token: d.token,
    });
  }
  await inbox.setBusinessAccount(db, channelId, d.businessAccountId);
  const outcome = await verifyChannel(admin, channelId, deps);
  return { channelId, outcome, reconnected: !!existing };
}

// ---------------------------------------------------------------------------------------------- barrido periódico
export async function sweepConnections(admin: Admin, o: { limit?: number } & Deps = {}): Promise<{ checked: number; problems: number }> {
  const now = o.now ?? new Date();
  const q = await admin.from('channels').select('id, connection_status, last_checked_at').eq('status', 'active').neq('connection_status', 'disconnected')
    .order('last_checked_at', { ascending: true, nullsFirst: true }).limit(50);
  if (q.error) throw new Error(`sweep_connections: ${q.error.code ?? q.error.message}`);
  const due = ((q.data ?? []) as { id: string; connection_status: string; last_checked_at: string | null }[])
    .filter((c) => isCheckDue({ connectionStatus: c.connection_status, lastCheckedAt: c.last_checked_at }, now)).slice(0, o.limit ?? 5);
  let problems = 0;
  for (const c of due) {
    try { if ((await verifyChannel(admin, c.id, o)).state !== 'connected') problems++; } catch { problems++; }
  }
  return { checked: due.length, problems };
}

// ---------------------------------------------------------------------------------------------- autorización
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Antes de usar el cliente de servidor (que se salta la seguridad por filas) hay que comprobar dos cosas:
 * que quien pide sea administrador Y que la conexión sea de SU organización. Devuelve el id ya validado.
 */
export async function resolveManagedChannel(db: ServerSupabase, orgId: string, canManage: boolean, channelId: string): Promise<string> {
  if (!canManage) throw new UserFacingError('Solo un administrador puede gestionar las conexiones.');
  if (!UUID.test(channelId)) throw new UserFacingError('No encontramos esa conexión.');
  const mine = await inbox.listChannels(db, orgId);
  if (!mine.some((c) => c.id === channelId)) throw new UserFacingError('No encontramos esa conexión.');
  return channelId;
}

// ---------------------------------------------------------------------------------------------- Facebook / Instagram
type Done = (state: ConnectionState, code: string | null, detail: string, extra?: { name?: string | null; phone?: string | null; waba?: string | null; meta?: Record<string, unknown> }) => Promise<VerifyOutcome>;
const metaApp = (env: NodeJS.ProcessEnv) => ({ appId: (env.META_APP_ID ?? '').trim(), appSecret: (env.META_APP_SECRET ?? '').trim() });
const googleApp = (env: NodeJS.ProcessEnv) => ({ clientId: (env.GOOGLE_CLIENT_ID ?? '').trim(), clientSecret: (env.GOOGLE_CLIENT_SECRET ?? '').trim() });

async function verifyMetaPage(ch: ChannelRow, kind: 'facebook' | 'instagram', token: string, done: Done, failed: (f: GraphFailure) => Promise<VerifyOutcome>, deps: Deps, env: NodeJS.ProcessEnv): Promise<VerifyOutcome> {
  const pageId = kind === 'facebook' ? ch.external_id : String(ch.metadata?.page_id ?? '');
  let name: string | null = null; let phone: string | null = null;
  if (kind === 'facebook') {
    const p = await fetchPage(ch.external_id, token, deps);
    if (!p.ok) return failed(p);
    name = p.data.name ?? null;
  } else {
    const ig = await fetchIgAccount(ch.external_id, token, deps);
    if (!ig.ok) return failed(ig);
    name = ig.data.username ? `@${ig.data.username}` : ig.data.name ?? null; phone = ig.data.username ? `@${ig.data.username}` : null;
  }
  const extra = { name, phone, meta: kind === 'instagram' ? { username: (name ?? '').replace(/^@/, '') } : {} };
  if (!/^\d{5,30}$/.test(pageId)) return done('needs_auth', 'no_page', 'La cuenta de Instagram no tiene una página de Facebook asociada. Vuelve a autorizar la conexión.', extra);
  const sub = await pageSubscription(pageId, token, metaApp(env).appId, deps);
  if (!sub.ok) return failed(sub);
  if (!sub.data) {
    const r = await subscribePage(pageId, token, deps);
    if (!r.ok) return done('webhook_missing', r.code, `No se pudo suscribir la app a los mensajes de la página: ${r.detail}`, extra);
    return done('connected', null, 'Cuenta verificada; se suscribió la app a los mensajes.', { ...extra, meta: { ...extra.meta, webhook_subscribed: true } });
  }
  return done('connected', null, 'Cuenta verificada; mensajes suscritos.', { ...extra, meta: { ...extra.meta, webhook_subscribed: true } });
}

const googleFail = (f: GoogleFailure, done: Done) => done(f.state ?? 'error', f.code, f.detail);
async function verifyGmail(ch: ChannelRow, refreshToken: string, done: Done, env: NodeJS.ProcessEnv, deps: Deps): Promise<VerifyOutcome> {
  const app = googleApp(env);
  if (!app.clientId || !app.clientSecret) return done('error', 'not_configured', 'Faltan GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET en el servidor.');
  const tok = await refreshGoogleToken(refreshToken, app, deps);
  if (!tok.ok) return googleFail(tok, done);
  const profile = await gmailProfile(tok.data.access_token ?? '', deps);
  if (!profile.ok) return googleFail(profile, done);
  if ((profile.data.emailAddress ?? '').toLowerCase() !== ch.external_id) return done('error', 'account_mismatch', 'La cuenta autorizada no coincide con la conexión guardada.');
  return done('connected', null, 'Cuenta de Gmail verificada.', { name: profile.data.emailAddress ?? null });
}

// ---------------------------------------------------------------------------------------------- inicio de sesión con Meta / Google
export interface MetaSession { pages: { id: string; name: string; token: string; ig: { id: string; username: string | null; name: string | null } | null }[] }

/** Tras el regreso de Meta: cambia el código por tokens, lista las páginas y las guarda 15 min mientras se elige. */
export async function completeMetaLogin(admin: Admin, o: { code: string; redirectUri: string; orgId: string; userId: string }, deps: Deps = {}): Promise<string> {
  const env = deps.env ?? process.env; const app = metaApp(env);
  if (!app.appId || !app.appSecret) throw new UserFacingError('Falta configurar META_APP_ID y META_APP_SECRET en el servidor.');
  const short = await exchangeMetaCode(o.code, o.redirectUri, app, deps);
  if (!short.ok || !short.data.access_token) throw new UserFacingError('Meta no aceptó la autorización. Vuelve a intentarlo.');
  const long = await extendMetaToken(short.data.access_token, app, deps);
  const userToken = long.ok && long.data.access_token ? long.data.access_token : short.data.access_token;
  const pages = await listPages(userToken, deps);
  if (!pages.ok) throw new UserFacingError('No pudimos leer tus páginas de Facebook. Revisa que hayas aceptado los permisos.');
  if (pages.data.length === 0) throw new UserFacingError('No encontramos páginas de Facebook que administres. Necesitas ser administrador de al menos una página.');
  const payload: MetaSession = { pages: pages.data };
  const r = await admin.rpc('save_oauth_session', { p_org: o.orgId, p_user: o.userId, p_provider: 'meta', p_payload: sealSecret(JSON.stringify(payload), env) });
  if (r.error || typeof r.data !== 'string') throw new Error('save_oauth_session');
  return r.data;
}

/** Datos de la sesión SIN los tokens (para mostrar la lista de páginas al administrador). */
export async function peekMetaSession(admin: Admin, sid: string, orgId: string, userId: string, env: NodeJS.ProcessEnv = process.env): Promise<MetaSession | null> {
  const r = await admin.rpc('peek_oauth_session', { p_id: sid, p_org: orgId, p_user: userId });
  if (r.error || typeof r.data !== 'string') return null;
  try { return JSON.parse(openSecret(r.data, env)) as MetaSession; } catch { return null; }
}

export interface MetaSelection { pageId: string; facebook: boolean; instagram: boolean }
export interface ConnectedAccount { kind: 'facebook' | 'instagram'; name: string; state: ConnectionState }

/** Conecta las páginas (y cuentas de Instagram) elegidas y las verifica. La sesión se consume: no se puede repetir. */
export async function connectMetaSelection(db: ServerSupabase, admin: Admin, o: { orgId: string; userId: string; sid: string; selection: MetaSelection[] }, deps: Deps = {}): Promise<ConnectedAccount[]> {
  const env = deps.env ?? process.env;
  if (o.selection.length === 0 || o.selection.length > 20) throw new UserFacingError('Elige al menos una página.');
  const t = await admin.rpc('take_oauth_session', { p_id: o.sid, p_org: o.orgId, p_user: o.userId });
  if (t.error || typeof t.data !== 'string') throw new UserFacingError('La autorización venció. Empieza de nuevo desde «Conectar».');
  let sess: MetaSession;
  try { sess = JSON.parse(openSecret(t.data, env)) as MetaSession; } catch { throw new UserFacingError('La autorización venció. Empieza de nuevo desde «Conectar».'); }
  const out: ConnectedAccount[] = [];
  for (const sel of o.selection) {
    const page = sess.pages.find((p) => p.id === sel.pageId);
    if (!page) continue;
    if (sel.facebook) {
      const id = await inbox.connectChannel(db, o.orgId, { kind: 'facebook', name: page.name, externalId: page.id, token: page.token, accountName: page.name, metadata: { page_id: page.id } });
      out.push({ kind: 'facebook', name: page.name, state: (await verifyChannel(admin, id, deps)).state });
    }
    if (sel.instagram && page.ig) {
      const uname = page.ig.username ? `@${page.ig.username}` : page.ig.name ?? page.ig.id;
      const id = await inbox.connectChannel(db, o.orgId, { kind: 'instagram', name: uname, externalId: page.ig.id, token: page.token, displayPhone: page.ig.username ? `@${page.ig.username}` : undefined, accountName: uname, metadata: { page_id: page.id, username: page.ig.username ?? null } });
      out.push({ kind: 'instagram', name: uname, state: (await verifyChannel(admin, id, deps)).state });
    }
  }
  if (out.length === 0) throw new UserFacingError('No se conectó ninguna cuenta. Marca al menos una casilla.');
  return out;
}

/** Tras el regreso de Google: valida permisos, obtiene el correo y guarda el acceso permanente (refresh token). */
export async function completeGoogleLogin(db: ServerSupabase, admin: Admin, o: { code: string; redirectUri: string; orgId: string }, deps: Deps = {}): Promise<{ channelId: string; email: string; outcome: VerifyOutcome; synced: number }> {
  const env = deps.env ?? process.env; const app = googleApp(env);
  if (!app.clientId || !app.clientSecret) throw new UserFacingError('Falta configurar GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET en el servidor.');
  const tok = await exchangeGoogleCode(o.code, o.redirectUri, app, deps);
  if (!tok.ok || !tok.data.access_token) throw new UserFacingError('Google no aceptó la autorización. Vuelve a intentarlo.');
  const granted = (tok.data.scope ?? '').split(' ');
  if (!GOOGLE_REQUIRED_SCOPES.every((sc) => granted.includes(sc))) throw new UserFacingError('Faltan permisos: para leer y responder correos, marca todas las casillas de permisos en la pantalla de Google.');
  if (!tok.data.refresh_token) throw new UserFacingError('Google no entregó acceso permanente. Quita el acceso de esta app en myaccount.google.com/permissions y conecta de nuevo.');
  const profile = await gmailProfile(tok.data.access_token, deps);
  const email = profile.ok ? (profile.data.emailAddress ?? '').toLowerCase() : '';
  if (!profile.ok || !email) throw new UserFacingError('No pudimos leer tu cuenta de Gmail. Revisa que la API de Gmail esté habilitada en tu proyecto de Google.');
  const channelId = await inbox.connectChannel(db, o.orgId, { kind: 'gmail', name: email, externalId: email, token: tok.data.refresh_token, accountName: email, metadata: {} });
  const outcome = await verifyChannel(admin, channelId, deps);
  let synced = 0;
  if (outcome.state === 'connected') { try { synced = (await syncGmail(admin, channelId, deps)).ingested; } catch { /* la primera sincronización se reintenta en el barrido */ } }
  return { channelId, email, outcome, synced };
}

// ---------------------------------------------------------------------------------------------- sincronizar Gmail
export interface SyncResult { ingested: number; skipped: number; note: string | null }
const FIRST_QUERY = 'in:inbox newer_than:7d -category:promotions -category:social -category:updates -category:forums';
const MAX_PER_RUN = 40;

/**
 * Trae los correos nuevos de la bandeja (historial de Gmail desde la última vez; la primera vez, los últimos 7 días),
 * descarta promociones/notificaciones/propios y los une al cliente por su correo. Es repetible: un correo ya guardado se reconoce.
 */
export async function syncGmail(admin: Admin, channelId: string, deps: Deps = {}): Promise<SyncResult> {
  const env = deps.env ?? process.env; const app = googleApp(env);
  const q = await admin.from('channels').select('id, org_id, kind, metadata, external_id, business_account_id, connection_status, last_webhook_at, connected_at, created_at').eq('id', channelId).maybeSingle();
  const ch = q.data as ChannelRow | null;
  if (q.error || !ch || ch.kind !== 'gmail') throw new Error('channel_not_found');
  if (ch.connection_status === 'disconnected') return { ingested: 0, skipped: 0, note: 'disconnected' };
  const fail = async (state: ConnectionState, code: string, detail: string) => { await record(admin, channelId, state, code, detail); return { ingested: 0, skipped: 0, note: code } as SyncResult; };
  if (!app.clientId || !app.clientSecret) return fail('error', 'not_configured', 'Faltan GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET en el servidor.');

  const cred = await admin.rpc('channel_credentials', { p_channel: channelId });
  const stored = typeof cred.data === 'string' && cred.data ? cred.data : null;
  if (!stored) return fail('needs_auth', 'no_token', 'No hay un acceso guardado para esta cuenta de Gmail.');
  let refresh: string;
  try { refresh = openSecret(stored, env); } catch (e) { return fail('needs_auth', e instanceof SecretError ? e.reason : 'secret_error', 'No se pudo abrir el acceso guardado (revisa CONNECTIONS_ENCRYPTION_KEY).'); }

  const tok = await refreshGoogleToken(refresh, app, deps);
  if (!tok.ok) return tok.kind === 'transient' ? { ingested: 0, skipped: 0, note: 'transient' } : fail(tok.state ?? 'error', tok.code, tok.detail);
  const access = tok.data.access_token ?? '';
  const profile = await gmailProfile(access, deps);
  if (!profile.ok) return profile.kind === 'transient' ? { ingested: 0, skipped: 0, note: 'transient' } : fail(profile.state ?? 'error', profile.code, profile.detail);
  const newHistory = profile.data.historyId ?? null;

  // 1) ¿Qué correos hay que mirar?
  let ids: string[] = []; const from = typeof ch.metadata?.history_id === 'string' ? ch.metadata.history_id : null;
  let usedList = !from;
  if (from) {
    let pageToken: string | undefined;
    for (let i = 0; i < 5; i++) {
      const h = await listHistory(access, from, { ...deps, pageToken });
      if (!h.ok) { if (h.status === 404) usedList = true; else if (h.kind === 'transient') return { ingested: 0, skipped: 0, note: 'transient' }; else return fail(h.state ?? 'error', h.code, h.detail); break; }
      for (const item of h.data.history ?? []) for (const a of item.messagesAdded ?? []) if (a.message?.id && (a.message.labelIds ?? []).includes('INBOX')) ids.push(a.message.id);
      pageToken = h.data.nextPageToken; if (!pageToken) break;
    }
  }
  if (usedList) {
    const l = await listInbox(access, { ...deps, q: FIRST_QUERY, max: 25 });
    if (!l.ok) return l.kind === 'transient' ? { ingested: 0, skipped: 0, note: 'transient' } : fail(l.state ?? 'error', l.code, l.detail);
    ids = (l.data.messages ?? []).map((m) => m.id);
  }
  ids = [...new Set(ids)].slice(0, MAX_PER_RUN);

  // 2) Guardarlos (del más antiguo al más nuevo)
  let ingested = 0, skipped = 0, failed = false;
  for (const id of ids.reverse()) {
    const m = await getGmailMessage(access, id, deps);
    if (!m.ok) { if (m.kind === 'transient') failed = true; else skipped++; continue; }
    const e = parseGmailMessage(m.data);
    if (!e) { skipped++; continue; }
    const verdict = shouldSync(e, ch.external_id);
    if (!verdict.sync) { skipped++; continue; }
    const r = await admin.rpc('ingest_channel_message', {
      p_kind: 'gmail', p_account_id: ch.external_id, p_thread: e.fromEmail, p_contact_name: e.fromName, p_external_id: e.id, p_msg_kind: 'text',
      p_body: inboxBody(e), p_occurred_at: e.occurredAt,
      p_meta: { message_id: e.messageId, subject: e.subject, gmail_thread_id: e.threadId, references: e.references, attachments: e.attachments },
    });
    if (r.error) { failed = true; continue; }
    const d = r.data as { ok: boolean; deduplicated?: boolean };
    if (d.ok && !d.deduplicated) ingested++; else if (!d.ok) skipped++;
  }

  // 3) Avanzar el punto de lectura SOLO si todo salió bien (si no, el próximo barrido lo reintenta sin duplicar nada)
  if (!failed && newHistory) await admin.rpc('merge_channel_metadata', { p_channel: channelId, p_metadata: { history_id: newHistory } });
  await admin.rpc('touch_channel', { p_kind: 'gmail', p_external_id: ch.external_id, p_activity: 'sync' }).then(() => undefined, () => undefined);
  if (ingested > 0) await admin.rpc('touch_channel', { p_kind: 'gmail', p_external_id: ch.external_id, p_activity: 'webhook' }).then(() => undefined, () => undefined);
  return { ingested, skipped, note: failed ? 'partial' : null };
}

export async function sweepGmail(admin: Admin, o: { limit?: number } & Deps = {}): Promise<{ synced: number; ingested: number }> {
  const q = await admin.from('channels').select('id').eq('kind', 'gmail').eq('status', 'active').in('connection_status', ['connected', 'pending', 'error', 'webhook_missing'])
    .order('last_sync_at', { ascending: true, nullsFirst: true }).limit(o.limit ?? 3);
  if (q.error) throw new Error(`sweep_gmail: ${q.error.code ?? q.error.message}`);
  let ingested = 0, synced = 0;
  for (const c of (q.data ?? []) as { id: string }[]) {
    try { ingested += (await syncGmail(admin, c.id, o)).ingested; synced++; } catch { /* la siguiente pasada lo reintenta */ }
  }
  return { synced, ingested };
}
void [fetchIgAccount, fetchPage] as unknown;
export type { MetaPage };

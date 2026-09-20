import 'server-only';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { toUserMessage } from '@/lib/errors';
import { setFlash } from '@/lib/flash';
import { can, getSession } from '@/lib/session';
import { createClient, type ServerSupabase } from '@/lib/supabase/server';
import { googleAuthUrl, metaAuthUrl, newNonce, redirectUri, signState, verifyState, type OAuthProvider } from '@/lib/social';
import { serverOrigin } from './origin';
import { googleAppFor, metaAppFor } from './provider-apps';
import { createAdminClient } from './supabase-admin';

const COOKIE = 'cx_oauth_nonce';
const LIST = '/settings/connections';
/** La aplicación (de Meta o Google) que corresponde a una organización: la SUYA guardada en el CRM o, si no, la de la plataforma. */
async function appFor(provider: OAuthProvider, orgId: string): Promise<{ id: string; secret: string } | null> {
  const admin = createAdminClient();
  if (provider === 'meta') { const a = await metaAppFor(admin, orgId); return a && a.appId ? { id: a.appId, secret: a.secret } : null; }
  const g = await googleAppFor(admin, orgId); return g ? { id: g.clientId, secret: g.clientSecret } : null;
}
const go = async (path: string) => NextResponse.redirect(new URL(path, await serverOrigin()), { status: 303 });
async function fail(message: string) { await setFlash({ kind: 'error', message }); return go(LIST); }

/** Paso 1: el administrador pulsa «Conectar». Se firma un `state` ligado a él y a su navegador y se le envía a Meta/Google. */
export async function beginOAuth(provider: OAuthProvider): Promise<Response> {
  const session = await getSession();
  if (!session?.active) return await go('/login');
  if (!can(session, 'settings:manage')) return await go('/inbox');
  const app = await appFor(provider, session.active.orgId);
  if (!app) return fail(provider === 'meta' ? 'Primero conecta tu aplicación de Meta: en Conexiones, «Tu aplicación de Meta», pega el Identificador y la Clave secreta.' : 'Primero conecta tu aplicación de Google: en Conexiones, «Tu aplicación de Google», pega el ID de cliente y el secreto.');
  const { id, secret } = app;
  const origin = await serverOrigin();
  const nonce = newNonce();
  const state = signState({ org: session.active.orgId, user: session.user.id, provider, nonce, ts: Date.now() }, secret);
  (await cookies()).set(COOKIE, nonce, { httpOnly: true, sameSite: 'lax', secure: origin.startsWith('https://'), path: '/api/connections', maxAge: 600 });
  const ru = redirectUri(origin, provider);
  return NextResponse.redirect(provider === 'meta' ? metaAuthUrl({ appId: id, redirectUri: ru, state, version: process.env.META_GRAPH_VERSION }) : googleAuthUrl({ clientId: id, redirectUri: ru, state, loginHint: undefined }), { status: 303 });
}

export interface OAuthCtx { code: string; orgId: string; userId: string; redirectUri: string; db: ServerSupabase; admin: ReturnType<typeof createAdminClient> }
/**
 * Paso 2: regreso de Meta/Google. Solo continúa si el `state` es válido, no venció, es de ESTE administrador, de ESTA
 * organización y de ESTE navegador (cookie). Cualquier error se muestra en español y jamás incluye credenciales.
 */
export async function finishOAuth(req: Request, provider: OAuthProvider, run: (c: OAuthCtx) => Promise<{ flash?: { kind: 'ok' | 'error'; message: string }; to: string }>): Promise<Response> {
  const url = new URL(req.url);
  const jar = await cookies();
  const nonce = jar.get(COOKIE)?.value;
  jar.set(COOKIE, '', { path: '/api/connections', maxAge: 0 });
  if (url.searchParams.get('error')) return fail('Cancelaste la autorización, así que no se conectó nada. Puedes intentarlo de nuevo cuando quieras.');
  const session = await getSession();
  if (!session?.active) return await go('/login');
  if (!can(session, 'settings:manage')) return await go('/inbox');
  const app = await appFor(provider, session.active.orgId);
  const st = app ? verifyState(url.searchParams.get('state'), app.secret) : null;
  const code = url.searchParams.get('code');
  if (!st || !nonce || st.nonce !== nonce || st.provider !== provider || st.user !== session.user.id || st.org !== session.active.orgId || !code) {
    return fail('La autorización no es válida o venció. Vuelve a pulsar «Conectar» para empezar de nuevo.');
  }
  try {
    const r = await run({ code, orgId: st.org, userId: st.user, redirectUri: redirectUri(await serverOrigin(), provider), db: await createClient(), admin: createAdminClient() });
    if (r.flash) await setFlash(r.flash);
    return await go(r.to);
  } catch (e) {
    return fail(toUserMessage(e));
  }
}

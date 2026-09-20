import 'server-only';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { toUserMessage } from '@/lib/errors';
import { siteUrl } from '@/lib/env';
import { setFlash } from '@/lib/flash';
import { can, getSession } from '@/lib/session';
import { createClient, type ServerSupabase } from '@/lib/supabase/server';
import { googleAuthUrl, metaAuthUrl, newNonce, redirectUri, signState, verifyState, type OAuthProvider } from '@/lib/social';
import { createAdminClient } from './supabase-admin';

const COOKIE = 'cx_oauth_nonce';
const LIST = '/settings/connections';
const secretFor = (p: OAuthProvider) => (p === 'meta' ? process.env.META_APP_SECRET : process.env.GOOGLE_CLIENT_SECRET)?.trim();
const go = (path: string) => NextResponse.redirect(new URL(path, siteUrl()), { status: 303 });
async function fail(message: string) { await setFlash({ kind: 'error', message }); return go(LIST); }

/** Paso 1: el administrador pulsa «Conectar». Se firma un `state` ligado a él y a su navegador y se le envía a Meta/Google. */
export async function beginOAuth(provider: OAuthProvider): Promise<Response> {
  const session = await getSession();
  if (!session?.active) return go('/login');
  if (!can(session, 'settings:manage')) return go('/inbox');
  const secret = secretFor(provider);
  const id = (provider === 'meta' ? process.env.META_APP_ID : process.env.GOOGLE_CLIENT_ID)?.trim();
  if (!secret || !id) return fail(provider === 'meta' ? 'Falta configurar META_APP_ID y META_APP_SECRET en el servidor.' : 'Falta configurar GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET en el servidor.');
  const nonce = newNonce();
  const state = signState({ org: session.active.orgId, user: session.user.id, provider, nonce, ts: Date.now() }, secret);
  (await cookies()).set(COOKIE, nonce, { httpOnly: true, sameSite: 'lax', secure: siteUrl().startsWith('https://'), path: '/api/connections', maxAge: 600 });
  const ru = redirectUri(siteUrl(), provider);
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
  if (!session?.active) return go('/login');
  if (!can(session, 'settings:manage')) return go('/inbox');
  const st = verifyState(url.searchParams.get('state'), secretFor(provider));
  const code = url.searchParams.get('code');
  if (!st || !nonce || st.nonce !== nonce || st.provider !== provider || st.user !== session.user.id || st.org !== session.active.orgId || !code) {
    return fail('La autorización no es válida o venció. Vuelve a pulsar «Conectar» para empezar de nuevo.');
  }
  try {
    const r = await run({ code, orgId: st.org, userId: st.user, redirectUri: redirectUri(siteUrl(), provider), db: await createClient(), admin: createAdminClient() });
    if (r.flash) await setFlash(r.flash);
    return go(r.to);
  } catch (e) {
    return fail(toUserMessage(e));
  }
}

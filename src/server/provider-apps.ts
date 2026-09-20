import 'server-only';
import { randomBytes } from 'node:crypto';
import { SecretError, openSecret, sealSecret } from '@/lib/secrets';
import type { ServerSupabase } from '@/lib/supabase/server';
import { unwrap } from '@/lib/errors';
import type { createAdminClient } from './supabase-admin';

type Admin = ReturnType<typeof createAdminClient>;
export interface MetaAppCreds { appId: string; secret: string; verifyToken: string | null; source: 'app' | 'env'; orgId: string | null }
export interface GoogleAppCreds { clientId: string; clientSecret: string; source: 'app' | 'env' }

const open = (v: unknown, env: NodeJS.ProcessEnv): string | null => {
  if (typeof v !== 'string' || !v) return null;
  try { return openSecret(v, env); } catch (e) { if (e instanceof SecretError) return null; throw e; }
};
const envMeta = (env: NodeJS.ProcessEnv): MetaAppCreds | null => {
  const secret = (env.META_APP_SECRET ?? '').trim();
  return secret ? { appId: (env.META_APP_ID ?? '').trim(), secret, verifyToken: (env.META_VERIFY_TOKEN ?? '').trim() || null, source: 'env', orgId: null } : null;
};

/** Credenciales guardadas por una organización (o null). Nunca lanza: si algo falla, se comporta como «no hay». */
async function orgSecrets(admin: Admin, orgId: string, provider: 'meta' | 'google', env: NodeJS.ProcessEnv) {
  try {
    const r = await admin.rpc('provider_app_secrets', { p_org: orgId, p_provider: provider });
    const d = r.error ? null : (r.data as { client_id?: string; secret?: string; verify_token?: string | null } | null);
    if (!d?.client_id) return null;
    const secret = open(d.secret, env);
    return secret ? { clientId: d.client_id, secret, verify: open(d.verify_token, env) } : null;
  } catch { return null; }
}

/** La aplicación de Meta que corresponde a una organización: primero la SUYA (guardada en el CRM); si no, la de la plataforma (variables de Vercel). */
export async function metaAppFor(admin: Admin, orgId: string | null, env: NodeJS.ProcessEnv = process.env): Promise<MetaAppCreds | null> {
  if (orgId) { const a = await orgSecrets(admin, orgId, 'meta', env); if (a) return { appId: a.clientId, secret: a.secret, verifyToken: a.verify, source: 'app', orgId }; }
  return envMeta(env);
}
export async function googleAppFor(admin: Admin, orgId: string, env: NodeJS.ProcessEnv = process.env): Promise<GoogleAppCreds | null> {
  const a = await orgSecrets(admin, orgId, 'google', env);
  if (a) return { clientId: a.clientId, clientSecret: a.secret, source: 'app' };
  const clientId = (env.GOOGLE_CLIENT_ID ?? '').trim(), clientSecret = (env.GOOGLE_CLIENT_SECRET ?? '').trim();
  return clientId && clientSecret ? { clientId, clientSecret, source: 'env' } : null;
}

/**
 * TODAS las aplicaciones de Meta que pueden firmar un aviso: las de las organizaciones y la de la plataforma. El webhook prueba cada una
 * (son pocas) y así sabe de cuál viene el aviso. Sin caché a propósito: al guardar una app nueva, Meta verifica al instante y debe encontrarla.
 */
export async function metaAppsForWebhook(admin: Admin, env: NodeJS.ProcessEnv = process.env): Promise<MetaAppCreds[]> {
  const out: MetaAppCreds[] = [];
  try {
    const r = await admin.rpc('meta_apps_for_webhook');
    for (const row of ((r.error ? [] : r.data) ?? []) as { org_id: string; client_id: string; secret: string; verify_token: string | null }[]) {
      const secret = open(row.secret, env);
      if (secret) out.push({ appId: row.client_id, secret, verifyToken: open(row.verify_token, env), source: 'app', orgId: row.org_id });
    }
  } catch { /* si la base de datos falla, al menos la de la plataforma sigue funcionando */ }
  const p = envMeta(env);
  if (p) out.push(p);
  return out;
}

export const newVerifyToken = () => randomBytes(30).toString('base64url');   // 40 caracteres, imposibles de adivinar

/** Guarda (cifradas) las credenciales de la aplicación de una organización. Solo un administrador (lo decide la base de datos). */
export async function saveProviderApp(db: ServerSupabase, orgId: string, provider: 'meta' | 'google', a: { clientId: string; secret: string; verifyToken?: string | null }, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  unwrap(await db.rpc('save_provider_app', { p_org: orgId, p_provider: provider, p_client_id: a.clientId, p_secret: sealSecret(a.secret, env), p_verify: a.verifyToken ? sealSecret(a.verifyToken, env) : null }));
}
export async function providerAppStatus(db: ServerSupabase, orgId: string, provider: 'meta' | 'google'): Promise<{ clientId: string; updatedAt: string } | null> {
  const d = unwrap(await db.rpc('provider_app_status', { p_org: orgId, p_provider: provider })) as unknown as { client_id: string; updated_at: string } | null;
  return d ? { clientId: d.client_id, updatedAt: d.updated_at } : null;
}
export async function removeProviderApp(db: ServerSupabase, orgId: string, provider: 'meta' | 'google'): Promise<void> {
  unwrap(await db.rpc('delete_provider_app', { p_org: orgId, p_provider: provider }));
}

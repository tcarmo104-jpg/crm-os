import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { sealSecret } from '@/lib/secrets';
import { googleAppFor, metaAppFor, metaAppsForWebhook, newVerifyToken, saveProviderApp } from './provider-apps';

const KEY = 'una-llave-larga-de-al-menos-32-caracteres-123';
const env = (o: Record<string, string> = {}) => o as unknown as NodeJS.ProcessEnv;
function admin(o: { org?: Record<string, { client_id: string; secret: string; verify_token?: string | null }>; all?: { org_id: string; client_id: string; secret: string; verify_token: string | null }[]; fail?: boolean } = {}) {
  return { rpc: async (fn: string, args: Record<string, string>) => {
    if (o.fail) throw new Error('db caída');
    if (fn === 'provider_app_secrets') { const key = `${args.p_org}:${args.p_provider}`; return { data: o.org?.[key] ?? null, error: null }; }
    if (fn === 'meta_apps_for_webhook') return { data: o.all ?? [], error: null };
    return { data: null, error: { message: 'x' } };
  } } as never;
}

describe('de dónde salen las credenciales de Meta', () => {
  it('la aplicación de la ORGANIZACIÓN gana a la de la plataforma (variables de Vercel)', async () => {
    const a = admin({ org: { 'o1:meta': { client_id: '111111111111111', secret: 'clave-de-la-org-larga', verify_token: 'token-org-de-verificacion-1' } } });
    const app = await metaAppFor(a, 'o1', env({ META_APP_SECRET: 'clave-de-la-plataforma', META_APP_ID: '999999999999999', META_VERIFY_TOKEN: 'token-plataforma-de-verificacion' }));
    expect(app).toEqual({ appId: '111111111111111', secret: 'clave-de-la-org-larga', verifyToken: 'token-org-de-verificacion-1', source: 'app', orgId: 'o1' });
  });
  it('sin aplicación propia usa la de la plataforma; sin ninguna, null', async () => {
    const e = env({ META_APP_SECRET: '  clave-de-la-plataforma  ', META_VERIFY_TOKEN: 'token-plataforma-de-verificacion' });
    expect(await metaAppFor(admin(), 'o2', e)).toEqual({ appId: '', secret: 'clave-de-la-plataforma', verifyToken: 'token-plataforma-de-verificacion', source: 'env', orgId: null });
    expect(await metaAppFor(admin(), 'o2', env())).toBeNull(); expect(await metaAppFor(admin(), null, env({ META_APP_SECRET: '   ' }))).toBeNull();
  });
  it('si la base de datos falla, no se cae: usa lo que haya en variables', async () => {
    expect((await metaAppFor(admin({ fail: true }), 'o1', env({ META_APP_SECRET: 'clave-de-la-plataforma' })))?.source).toBe('env');
    expect(await metaAppFor(admin({ fail: true }), 'o1', env())).toBeNull();
  });
  it('las credenciales cifradas se abren con la llave; con otra llave esa aplicación se ignora (nunca basura)', async () => {
    const sealed = sealSecret('clave-secreta-real-de-la-app', env({ CONNECTIONS_ENCRYPTION_KEY: KEY }));
    const a = admin({ org: { 'o1:meta': { client_id: '111111111111111', secret: sealed, verify_token: sealSecret('token-de-verificacion-largo-1', env({ CONNECTIONS_ENCRYPTION_KEY: KEY })) } } });
    expect((await metaAppFor(a, 'o1', env({ CONNECTIONS_ENCRYPTION_KEY: KEY })))).toMatchObject({ secret: 'clave-secreta-real-de-la-app', verifyToken: 'token-de-verificacion-largo-1' });
    expect(await metaAppFor(a, 'o1', env({ CONNECTIONS_ENCRYPTION_KEY: 'otra-llave-larga-de-al-menos-32-caracteres-9' }))).toBeNull();
    expect(await metaAppFor(a, 'o1', env())).toBeNull();
  });
});

describe('aplicación de Google', () => {
  it('la de la organización gana; si no, las variables; si no, null', async () => {
    const a = admin({ org: { 'o1:google': { client_id: 'cid.apps.googleusercontent.com', secret: 'GOCSPX-secreto-google-1' } } });
    expect(await googleAppFor(a, 'o1', env({ GOOGLE_CLIENT_ID: 'x', GOOGLE_CLIENT_SECRET: 'y' }))).toEqual({ clientId: 'cid.apps.googleusercontent.com', clientSecret: 'GOCSPX-secreto-google-1', source: 'app' });
    expect(await googleAppFor(admin(), 'o2', env({ GOOGLE_CLIENT_ID: 'x', GOOGLE_CLIENT_SECRET: 'y' }))).toEqual({ clientId: 'x', clientSecret: 'y', source: 'env' });
    expect(await googleAppFor(admin(), 'o2', env({ GOOGLE_CLIENT_ID: 'x' }))).toBeNull();
  });
});

describe('todas las aplicaciones que pueden firmar un aviso (webhook)', () => {
  it('reúne las de las organizaciones y la de la plataforma; ignora las ilegibles', async () => {
    const e = env({ META_APP_SECRET: 'clave-de-la-plataforma', META_VERIFY_TOKEN: 'token-plataforma-de-verificacion', CONNECTIONS_ENCRYPTION_KEY: KEY });
    const a = admin({ all: [
      { org_id: 'o1', client_id: '111111111111111', secret: sealSecret('clave-org-uno-secreta-1', e), verify_token: sealSecret('token-org-uno-de-verificacion', e) },
      { org_id: 'o2', client_id: '222222222222222', secret: 'enc:v1:roto:roto:roto', verify_token: null },
    ] });
    const apps = await metaAppsForWebhook(a, e);
    expect(apps.map((x) => [x.orgId, x.appId, x.source])).toEqual([['o1', '111111111111111', 'app'], [null, '', 'env']]);
  });
  it('sin caché: una aplicación recién guardada se ve al instante (Meta verifica en el momento)', async () => {
    const list: { org_id: string; client_id: string; secret: string; verify_token: string | null }[] = [];
    const a = admin({ all: list });
    expect(await metaAppsForWebhook(a, env())).toEqual([]);
    list.push({ org_id: 'o1', client_id: '111111111111111', secret: 'clave-org-uno-secreta-1', verify_token: 'token-org-uno-de-verificacion' });
    expect((await metaAppsForWebhook(a, env())).length).toBe(1);
  });
});

describe('guardar las credenciales', () => {
  it('con llave de cifrado, la clave y el token viajan CIFRADOS (nunca en claro) a la base de datos', async () => {
    const calls: Record<string, unknown>[] = [];
    const db = { rpc: async (_: string, args: Record<string, unknown>) => { calls.push(args); return { data: null, error: null }; } } as never;
    await saveProviderApp(db, 'o1', 'meta', { clientId: '111111111111111', secret: 'clave-secreta-real-de-la-app', verifyToken: 'token-de-verificacion-largo-1' }, env({ CONNECTIONS_ENCRYPTION_KEY: KEY }));
    expect(String(calls[0]!.p_secret).startsWith('enc:v1:')).toBe(true); expect(String(calls[0]!.p_verify).startsWith('enc:v1:')).toBe(true);
    expect(JSON.stringify(calls[0])).not.toContain('clave-secreta-real'); expect(calls[0]!.p_client_id).toBe('111111111111111');
  });
  it('sin llave, se guarda tal cual (protegida por el acceso a la base de datos); sin token de verificación envía nulo', async () => {
    const calls: Record<string, unknown>[] = [];
    const db = { rpc: async (_: string, args: Record<string, unknown>) => { calls.push(args); return { data: null, error: null }; } } as never;
    await saveProviderApp(db, 'o1', 'google', { clientId: 'cid', secret: 'GOCSPX-secreto-google-1' }, env());
    expect(calls[0]).toMatchObject({ p_secret: 'GOCSPX-secreto-google-1', p_verify: null });
  });
  it('el token de verificación generado es largo y distinto cada vez', () => {
    const a = newVerifyToken(), b = newVerifyToken();
    expect(a.length).toBe(40); expect(a).toMatch(/^[A-Za-z0-9_-]+$/); expect(a).not.toBe(b);
  });
});

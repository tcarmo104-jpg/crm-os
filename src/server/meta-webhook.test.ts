import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { appSubscriptions, configureReceptionWebhook, configureWebhook, connectMetaApp, describeConfigured, gatherReceptionFacts, judgeSubscription, tokenInfo } from './meta-webhook';

interface Call { url: string; method: string; auth: string | null; body: string }
function fake(handler: (c: Call) => { status?: number; body: unknown } | 'network') {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const c: Call = { url, method: init?.method ?? 'GET', auth: ((init?.headers ?? {}) as Record<string, string>).Authorization ?? null, body: String(init?.body ?? '') };
    calls.push(c);
    const r = handler(c);
    if (r === 'network') throw new Error('ECONNRESET');
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, json: async () => r.body };
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}
const path = (c: Call) => new URL(c.url).pathname.split('/').slice(2).join('/');
const SECRET = 'a1b2c3d4e5f60718293a4b5c6d7e8f90', VERIFY = 'mi-token-de-verificacion', APP = '3431407853702583', TOKEN = 'EAAGm0PX4ZCpsBOabcdefghijklmnopqrstuvwxyz1234';
const ENV = (o: Record<string, string> = {}) => ({ META_APP_SECRET: SECRET, META_VERIFY_TOKEN: VERIFY, NEXT_PUBLIC_SITE_URL: 'https://crm.test', ...o }) as unknown as NodeJS.ProcessEnv;
const URL_OK = 'https://crm.test/api/webhooks/meta';

describe('token de acceso: ¿de qué app es y cuándo vence?', () => {
  it('lee la app y la fecha de vencimiento; 0 significa que no vence', async () => {
    const f = fake(() => ({ body: { data: { app_id: APP, is_valid: true, expires_at: 1758400000 } } }));
    expect(await tokenInfo(TOKEN, { fetchImpl: f.fetchImpl })).toEqual({ appId: APP, valid: true, expiresAt: new Date(1758400000 * 1000).toISOString() });
    expect(f.calls[0]!.auth).toBe(`Bearer ${TOKEN}`); expect(f.calls[0]!.url).toContain('input_token='); 
    const never = fake(() => ({ body: { data: { app_id: APP, is_valid: true, expires_at: 0 } } }));
    expect((await tokenInfo(TOKEN, { fetchImpl: never.fetchImpl })).expiresAt).toBeNull();
  });
  it('un token vencido se reconoce como inválido; una caída no dice nada', async () => {
    expect(await tokenInfo(TOKEN, { fetchImpl: fake(() => ({ status: 400, body: { error: { code: 190, message: 'expired' } } })).fetchImpl })).toMatchObject({ valid: false, appId: null });
    expect(await tokenInfo(TOKEN, { fetchImpl: fake(() => 'network').fetchImpl })).toEqual({ appId: null, valid: null, expiresAt: null });
  });
});

describe('qué webhooks tiene Meta configurados', () => {
  it('se consulta con la credencial de la app y el secreto NUNCA va en la dirección', async () => {
    const f = fake(() => ({ body: { data: [] } }));
    await appSubscriptions(APP, SECRET, { fetchImpl: f.fetchImpl });
    expect(path(f.calls[0]!)).toBe(`${APP}/subscriptions`); expect(f.calls[0]!.auth).toBe(`Bearer ${APP}|${SECRET}`); expect(f.calls[0]!.url).not.toContain(SECRET);
  });
  it('lo compara con lo esperado: bien, sin webhook, otra dirección o sin «messages»', () => {
    const ok = { object: 'whatsapp_business_account', callback_url: URL_OK, fields: [{ name: 'messages' }] };
    expect(judgeSubscription([ok], URL_OK)).toEqual({ subscription: 'ok', callbackUrl: URL_OK });
    expect(judgeSubscription([{ object: 'page', callback_url: URL_OK }], URL_OK)).toEqual({ subscription: 'missing', callbackUrl: null });
    expect(judgeSubscription([], URL_OK).subscription).toBe('missing');
    expect(judgeSubscription([{ ...ok, callback_url: 'https://otro.com/x' }], URL_OK)).toEqual({ subscription: 'wrong_url', callbackUrl: 'https://otro.com/x' });
    expect(judgeSubscription([{ ...ok, fields: [{ name: 'message_template_status_update' }] }], URL_OK).subscription).toBe('no_messages');
    expect(judgeSubscription([{ ...ok, callback_url: 'HTTPS://CRM.TEST/api/webhooks/meta/' }], URL_OK).subscription).toBe('ok');   // mayúsculas y «/» final no cuentan
  });
});

describe('configurar el webhook en Meta automáticamente', () => {
  const objectOf = (c: Call) => new URLSearchParams(c.body).get('object');
  it('registra WhatsApp, Facebook Messenger e Instagram con la MISMA dirección y el MISMO token, en el cuerpo (nunca en la dirección)', async () => {
    const f = fake(() => ({ body: { success: true } }));
    expect(await configureWebhook(APP, SECRET, URL_OK, VERIFY, { fetchImpl: f.fetchImpl })).toEqual({ ok: true, registered: ['WhatsApp', 'Facebook Messenger', 'Instagram'], failed: [] });
    expect(f.calls.map(objectOf)).toEqual(['whatsapp_business_account', 'page', 'instagram']);
    for (const c of f.calls) {
      const b = new URLSearchParams(c.body);
      expect(c.method).toBe('POST'); expect(path(c)).toBe(`${APP}/subscriptions`); expect(c.auth).toBe(`Bearer ${APP}|${SECRET}`);
      expect(b.get('callback_url')).toBe(URL_OK); expect(b.get('verify_token')).toBe(VERIFY); expect(b.get('fields')).toBe('messages');
      expect(c.url).not.toContain(VERIFY); expect(c.url).not.toContain(SECRET);
    }
  });
  it('un canal que la app no tiene NO impide los demás: se informa aparte', async () => {
    const f = fake((c) => objectOf(c) === 'instagram' ? { status: 400, body: { error: { code: 100, message: 'Instagram product not added' } } } : { body: { success: true } });
    const r = await configureWebhook(APP, SECRET, URL_OK, VERIFY, { fetchImpl: f.fetchImpl });
    expect(r).toMatchObject({ ok: true, registered: ['WhatsApp', 'Facebook Messenger'] });
    expect((r as { failed: { label: string }[] }).failed.map((x) => x.label)).toEqual(['Instagram']);
    expect(f.calls).toHaveLength(3);
    expect(describeConfigured(r as never)).toMatch(/configurado en Meta para WhatsApp e? ?Facebook Messenger\. No se pudo para Instagram/);
  });
  it('si TODOS fallan por un motivo propio del canal, es un error con el primer motivo', async () => {
    const f = fake(() => ({ status: 400, body: { error: { code: 100, message: 'not available' } } }));
    expect(await configureWebhook(APP, SECRET, URL_OK, VERIFY, { fetchImpl: f.fetchImpl })).toMatchObject({ ok: false, message: expect.stringMatching(/Meta lo rechazó/) });
  });
  it('un problema de dirección/token o de credenciales se informa UNA vez y no se insiste con los demás canales', async () => {
    const ver = fake(() => ({ status: 400, body: { error: { code: 2200, message: 'Callback verification failed with the following errors: HTTP Status Code = 403' } } }));
    const r1 = await configureWebhook(APP, SECRET, URL_OK, VERIFY, { fetchImpl: ver.fetchImpl });
    expect(r1).toMatchObject({ ok: false }); expect((r1 as { message: string }).message).toMatch(/Meta no pudo verificar la dirección de tu CRM/); expect(ver.calls).toHaveLength(1);
    const sig = fake(() => ({ status: 400, body: { error: { code: 190, message: 'Invalid OAuth access token signature.' } } }));
    const r2 = await configureWebhook(APP, SECRET, URL_OK, VERIFY, { fetchImpl: sig.fetchImpl });
    expect((r2 as { message: string }).message).toMatch(/Clave secreta debe ser la «Clave secreta de la app»/); expect(sig.calls).toHaveLength(1);
    const net = fake(() => 'network');
    expect(await configureWebhook(APP, SECRET, URL_OK, VERIFY, { fetchImpl: net.fetchImpl })).toMatchObject({ ok: false, message: expect.stringMatching(/No pudimos comunicarnos con Meta/) });
  });
  it('los mensajes de error no dejan ver el token ni le hablan de Vercel o de variables', async () => {
    const r = await configureWebhook(APP, SECRET, URL_OK, VERIFY, { fetchImpl: fake(() => ({ status: 400, body: { error: { code: 1, message: `raro ${TOKEN}` } } })).fetchImpl });
    expect((r as { message: string }).message).not.toContain(TOKEN);
    const ver = await configureWebhook(APP, SECRET, URL_OK, VERIFY, { fetchImpl: fake(() => ({ status: 400, body: { error: { code: 2200, message: 'verification' } } })).fetchImpl });
    expect((ver as { message: string }).message).not.toMatch(/Vercel|Redeploy|META_[A-Z_]+/);
  });
  it('describe el resultado en español', () => {
    expect(describeConfigured({ ok: true, registered: ['WhatsApp'], failed: [] })).toBe('el webhook quedó configurado en Meta para WhatsApp.');
    expect(describeConfigured({ ok: true, registered: ['WhatsApp', 'Facebook Messenger', 'Instagram'], failed: [] })).toBe('el webhook quedó configurado en Meta para WhatsApp, Facebook Messenger e Instagram.');
  });
});

function fakeAdmin(o: { token?: string | null; stats?: { outcome: string; hits: number; last_at: string | null }[] } = {}) {
  return { rpc: async (fn: string) => fn === 'channel_credentials' ? { data: o.token === undefined ? TOKEN : o.token, error: null } : fn === 'webhook_stats_summary' ? { data: o.stats ?? [], error: null } : { data: null, error: null } } as never;
}
const routes = (o: { info?: unknown; subs?: unknown; configure?: unknown } = {}) => fake((c) => {
  const p = path(c);
  if (p === 'debug_token') return { body: o.info ?? { data: { app_id: APP, is_valid: true, expires_at: 0 } } };
  if (p === `${APP}/subscriptions` && c.method === 'GET') return { body: o.subs ?? { data: [{ object: 'whatsapp_business_account', callback_url: URL_OK, fields: [{ name: 'messages' }] }] } };
  if (p === `${APP}/subscriptions` && c.method === 'POST') return { body: o.configure ?? { success: true } };
  return { status: 404, body: { error: { code: 100, message: 'nope' } } };
});

describe('reunir lo que el diagnóstico necesita', () => {
  const ch = { id: 'c1', orgId: 'o1', metadata: { webhook_subscribed: true }, lastWebhookAt: null };
  it('sin consultar a Meta: variables, contadores y estado de la cuenta; no sale a la red', async () => {
    const f = routes();
    const r = await gatherReceptionFacts(fakeAdmin({ stats: [{ outcome: 'bad_signature', hits: 3, last_at: '2026-09-20T10:00:00Z' }] }), ch, { full: false, origin: 'https://crm.test' }, { env: ENV(), fetchImpl: f.fetchImpl });
    expect(r).toMatchObject({ secretSet: true, verifyTokenSet: true, siteUrlOk: true, wabaSubscribed: true, meta: null }); expect(r.stats.bad_signature.hits).toBe(3); expect(f.calls).toHaveLength(0);
    expect((await gatherReceptionFacts(fakeAdmin(), { ...ch, metadata: {} }, { full: false, origin: 'https://crm.test' }, { env: ENV({ META_APP_SECRET: '  ' }) })).secretSet).toBe(false);
    expect((await gatherReceptionFacts(fakeAdmin(), ch, { full: false, origin: 'http://localhost:3000' }, { env: ENV() })).siteUrlOk).toBe(false);
  });
  it('consulta completa: averigua la app por el token y compara el webhook de Meta con el esperado', async () => {
    const f = routes();
    const r = await gatherReceptionFacts(fakeAdmin(), ch, { full: true, origin: 'https://crm.test' }, { env: ENV(), fetchImpl: f.fetchImpl });
    expect(r.meta).toMatchObject({ appId: APP, tokenValid: true, subscription: 'ok', expectedUrl: URL_OK });
    const bad = await gatherReceptionFacts(fakeAdmin(), ch, { full: true, origin: 'https://crm.test' }, { env: ENV(), fetchImpl: routes({ subs: { data: [] } }).fetchImpl });
    expect(bad.meta!.subscription).toBe('missing');
  });
  it('sin token guardado, sin la app o sin el secreto: lo dice claro en vez de fallar', async () => {
    expect((await gatherReceptionFacts(fakeAdmin({ token: null }), ch, { full: true, origin: 'https://crm.test' }, { env: ENV(), fetchImpl: routes().fetchImpl })).meta!.error).toMatch(/no hay un token guardado/);
    expect((await gatherReceptionFacts(fakeAdmin(), ch, { full: true, origin: 'https://crm.test' }, { env: ENV(), fetchImpl: routes({ info: { data: { is_valid: true } } }).fetchImpl })).meta!.error).toMatch(/a qué app de Meta pertenece/);
    expect((await gatherReceptionFacts(fakeAdmin(), ch, { full: true, origin: 'https://crm.test' }, { env: ENV({ META_APP_SECRET: '' }), fetchImpl: routes().fetchImpl })).meta!.error).toMatch(/primero conecta tu aplicación de Meta/);
  });
  it('un token temporal muestra su vencimiento', async () => {
    const soon = Math.floor(Date.now() / 1000) + 5 * 3600;
    const r = await gatherReceptionFacts(fakeAdmin(), ch, { full: true, origin: 'https://crm.test' }, { env: ENV(), fetchImpl: routes({ info: { data: { app_id: APP, is_valid: true, expires_at: soon } } }).fetchImpl });
    expect(new Date(r.meta!.tokenExpiresAt!).getTime()).toBeCloseTo(soon * 1000, -3);
  });
});

const A = { channelId: 'c1', orgId: 'o1', origin: 'https://crm.test' };
describe('el botón «Configurar el webhook automáticamente»', () => {
  it('con todo en orden: averigua la app por el token y deja el webhook configurado', async () => {
    const f = routes();
    expect(await configureReceptionWebhook(fakeAdmin(), A, { env: ENV(), fetchImpl: f.fetchImpl })).toMatchObject({ ok: true, registered: ['WhatsApp', 'Facebook Messenger', 'Instagram'] });
    const post = f.calls.find((c) => c.method === 'POST')!;
    expect(new URLSearchParams(post.body).get('callback_url')).toBe(URL_OK); expect(new URLSearchParams(post.body).get('verify_token')).toBe(VERIFY);
  });
  it('usa el Identificador de la app si ya se conoce (sin preguntarle a Meta por el token)', async () => {
    const f = routes();
    await configureReceptionWebhook(fakeAdmin(), A, { env: ENV({ META_APP_ID: APP }), fetchImpl: f.fetchImpl });
    expect(f.calls.some((c) => path(c) === 'debug_token')).toBe(false);
  });
  it('la dirección sale de donde se abrió el CRM (no de una variable)', async () => {
    const f = routes();
    await configureReceptionWebhook(fakeAdmin(), { ...A, origin: 'https://otra-empresa.com' }, { env: ENV({ NEXT_PUBLIC_SITE_URL: '' }), fetchImpl: f.fetchImpl });
    expect(new URLSearchParams(f.calls.find((c) => c.method === 'POST')!.body).get('callback_url')).toBe('https://otra-empresa.com/api/webhooks/meta');
  });
  it('si falta algo, dice QUÉ y dónde arreglarlo (sin llamar a Meta ni mencionar Vercel)', async () => {
    const f = routes();
    const msg = async (env: NodeJS.ProcessEnv, o = A, admin = fakeAdmin()) => ((await configureReceptionWebhook(admin, o, { env, fetchImpl: f.fetchImpl })) as { message: string }).message;
    expect(await msg(ENV({ META_APP_SECRET: '' }))).toMatch(/Primero conecta tu aplicación de Meta/);
    expect(await msg(ENV({ META_VERIFY_TOKEN: '' }))).toMatch(/no tiene un token de verificación/);
    expect(await msg(ENV(), { ...A, origin: 'http://localhost:3000' })).toMatch(/dirección pública con https/);
    expect(await msg(ENV(), A, fakeAdmin({ token: null }))).toMatch(/no tiene un token guardado/);
    expect(f.calls).toHaveLength(0);
    for (const m of [await msg(ENV({ META_APP_SECRET: '' })), await msg(ENV({ META_VERIFY_TOKEN: '' }))]) expect(m).not.toMatch(/Vercel|Redeploy|META_[A-Z_]+/);
  });
});

describe('conectar «Tu aplicación de Meta» (solo Identificador y Clave secreta)', () => {
  const saves: Record<string, unknown>[] = [];
  const db = { rpc: async (fn: string, args: Record<string, unknown>) => { saves.push({ fn, ...args }); return { data: null, error: null }; } } as never;
  const appCheck = (o: { status?: number; body?: unknown } = {}) => fake((c) => {
    const p = path(c);
    if (p === APP && c.method === 'GET') return { status: o.status ?? 200, body: o.body ?? { id: APP, name: 'Mi App de Arkos' } };
    if (p === `${APP}/subscriptions` && c.method === 'POST') return { body: { success: true } };
    return { status: 404, body: { error: { code: 100, message: 'nope' } } };
  });
  const run = (over: Partial<{ appId: string; secret: string; origin: string | null }> = {}, f = appCheck()) => connectMetaApp(db, { orgId: 'o1', appId: APP, secret: SECRET, origin: 'https://crm.test', ...over }, { env: ENV(), fetchImpl: f.fetchImpl });
  it('comprueba con Meta, guarda (con un token de verificación NUEVO) y configura el webhook con ese mismo token', async () => {
    saves.length = 0; const f = appCheck();
    const r = await run({}, f);
    expect(r).toMatchObject({ ok: true, appName: 'Mi App de Arkos', webhook: { ok: true } });
    expect(path(f.calls[0]!)).toBe(APP); expect(f.calls[0]!.auth).toBe(`Bearer ${APP}|${SECRET}`); expect(f.calls[0]!.url).not.toContain(SECRET);
    const save = saves.find((x) => x.fn === 'save_provider_app')!;
    expect(save).toMatchObject({ p_org: 'o1', p_provider: 'meta', p_client_id: APP, p_secret: SECRET });
    const hook = new URLSearchParams(f.calls.find((c) => c.method === 'POST')!.body);
    expect(hook.get('verify_token')).toBe(save.p_verify); expect(String(save.p_verify).length).toBe(40); expect(hook.get('callback_url')).toBe(URL_OK);
  });
  it('datos mal copiados se explican SIN llamar a Meta ni guardar nada', async () => {
    saves.length = 0; const f = appCheck();
    const bad = async (o: Parameters<typeof run>[0]) => ((await run(o, f)) as { message: string }).message;
    expect(await bad({ appId: 'abc' })).toMatch(/solo números/);
    expect(await bad({ appId: '12 34' })).toMatch(/solo números/);
    expect(await bad({ secret: 'corta' })).toMatch(/Clave secreta.*32 letras y números/);
    expect(await bad({ secret: 'con espacios en medio de la clave secreta' })).toMatch(/sin espacios/);
    expect(f.calls).toHaveLength(0); expect(saves).toHaveLength(0);
  });
  it('si Meta no reconoce la combinación, lo dice claro y NO guarda nada', async () => {
    saves.length = 0;
    const r = await run({}, appCheck({ status: 400, body: { error: { code: 190, message: 'Invalid OAuth access token signature.' } } }));
    expect(r).toMatchObject({ ok: false }); expect((r as { message: string }).message).toMatch(/deben ser de la MISMA app/); expect(saves).toHaveLength(0);
    expect(await run({}, appCheck({ status: 500, body: {} }))).toMatchObject({ ok: false, message: expect.stringMatching(/No pudimos comunicarnos con Meta/) });
    expect(await run({}, appCheck({ body: { id: '999999999999' } }))).toMatchObject({ ok: false, message: expect.stringMatching(/otra app/) });
  });
  it('si se abre desde una dirección local, guarda pero explica que falta configurar el webhook', async () => {
    saves.length = 0;
    const r = await run({ origin: 'http://localhost:3000' });
    expect(r).toMatchObject({ ok: true, webhook: { ok: false } }); expect(saves.some((x) => x.fn === 'save_provider_app')).toBe(true);
    expect(((r as { webhook: { message: string } }).webhook).message).toMatch(/dirección pública con https/);
  });
  it('si Meta rechaza registrar el webhook, la app queda guardada y el motivo se dice en español', async () => {
    const f = fake((c) => path(c) === APP ? { body: { id: APP, name: 'X' } } : { status: 400, body: { error: { code: 2200, message: 'Callback verification failed' } } });
    const r = await run({}, f);
    expect(r).toMatchObject({ ok: true, webhook: { ok: false } }); expect(((r as { webhook: { message: string } }).webhook).message).toMatch(/no pudo verificar la dirección de tu CRM/);
  });
});

import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { sealSecret } from '@/lib/secrets';
import { UserFacingError } from '@/lib/errors';
import { resolveManagedChannel, verifyChannel, sweepConnections } from './connections';
import { fetchPhoneNumber, listSubscribedApps, subscribeApp } from './whatsapp-graph';

const TOKEN = 'EAAGm0PX4ZCpsBOabcdefghijklmnopqrstuvwxyz1234';
const KEY = 'una-llave-larga-de-al-menos-32-caracteres-123';
type Row = Record<string, unknown>;

/** Meta falsa: responde según la ruta; guarda cada llamada (método, ruta, encabezado). */
function fakeMeta(routes: Record<string, { status?: number; body: unknown } | 'network'>) {
  const calls: { method: string; url: string; auth: string | null }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    calls.push({ method: init?.method ?? 'GET', url: u.pathname + u.search, auth: (init?.headers as Record<string, string>)?.Authorization ?? null });
    const key = `${init?.method ?? 'GET'} ${u.pathname.split('/').slice(2).join('/')}`;
    const r = routes[key];
    if (!r) return { ok: false, status: 404, json: async () => ({ error: { code: 100, message: `sin ruta ${key}` } }) };
    if (r === 'network') throw new Error('ECONNRESET');
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, json: async () => r.body };
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/** Base de datos falsa mínima: un canal, sus credenciales y el registro de cada llamada RPC. */
function fakeAdmin(channels: Row[], cred: string | null) {
  const rpc: { fn: string; args: Record<string, unknown> }[] = [];
  const from = () => {
    let rows = channels;
    const b: Record<string, unknown> = {
      select: () => b, eq: (k: string, v: unknown) => { rows = rows.filter((r) => r[k] === v); return b; }, neq: (k: string, v: unknown) => { rows = rows.filter((r) => r[k] !== v); return b; },
      order: () => b, limit: () => b, maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      then: (res: (v: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(res),
    };
    return b;
  };
  const admin = {
    from, rpc: async (fn: string, args: Record<string, unknown>) => {
      rpc.push({ fn, args });
      return fn === 'channel_credentials' ? { data: cred, error: null } : { data: null, error: null };
    },
  } as never;
  return { admin, rpc, health: () => rpc.filter((c) => c.fn === 'record_channel_health').map((c) => c.args) };
}
const NOW = new Date('2026-09-20T12:00:00Z');
const ch = (o: Row = {}): Row => ({ id: 'c1', org_id: 'o1', status: 'active', external_id: '109876543210', business_account_id: '123456789012345', connection_status: 'pending', last_webhook_at: null, connected_at: '2026-09-01T00:00:00Z', created_at: '2026-09-01T00:00:00Z', ...o });
const PHONE_OK = { status: 200, body: { verified_name: 'Arkos Ventas', display_phone_number: '+57 300 111 2233', quality_rating: 'GREEN', name_status: 'APPROVED', code_verification_status: 'VERIFIED', platform_type: 'CLOUD_API' } };
const env = (o: Record<string, string> = {}) => ({ META_APP_ID: '5550001', ...o }) as unknown as NodeJS.ProcessEnv;

describe('cliente de Meta', () => {
  it('pide el número con los campos justos y el token SOLO en el encabezado', async () => {
    const m = fakeMeta({ 'GET 109876543210': PHONE_OK });
    const r = await fetchPhoneNumber('109876543210', TOKEN, { fetchImpl: m.fetchImpl });
    expect(r).toMatchObject({ ok: true, data: { verified_name: 'Arkos Ventas' } });
    expect(m.calls[0]!.auth).toBe(`Bearer ${TOKEN}`);
    expect(m.calls[0]!.url).toContain('fields=verified_name');
    expect(m.calls[0]!.url).not.toContain(TOKEN);
    expect(m.calls[0]!.url).not.toMatch(/access_token/);
  });
  it('un identificador con formato raro NI SIQUIERA sale a la red', async () => {
    const m = fakeMeta({});
    for (const bad of ['', 'abc', '../me', '123 456', '1234']) {
      expect((await fetchPhoneNumber(bad, TOKEN, { fetchImpl: m.fetchImpl })).ok).toBe(false);
      expect((await listSubscribedApps(bad, TOKEN, { fetchImpl: m.fetchImpl })).ok).toBe(false);
      expect((await subscribeApp(bad, TOKEN, { fetchImpl: m.fetchImpl })).ok).toBe(false);
    }
    expect(m.calls).toHaveLength(0);
  });
  it('los errores llegan clasificados y sin secretos', async () => {
    const m = fakeMeta({ 'GET 109876543210': { status: 400, body: { error: { code: 190, error_subcode: 463, message: `Error validating access token ${TOKEN}` } } } });
    const r = await fetchPhoneNumber('109876543210', TOKEN, { fetchImpl: m.fetchImpl });
    expect(r).toMatchObject({ ok: false, kind: 'rejected', state: 'token_expired', code: '190' });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });
  it('caída de Meta o de red = transitorio (no se culpa al token)', async () => {
    const a = await fetchPhoneNumber('109876543210', TOKEN, { fetchImpl: fakeMeta({ 'GET 109876543210': { status: 503, body: {} } }).fetchImpl });
    const b = await fetchPhoneNumber('109876543210', TOKEN, { fetchImpl: fakeMeta({ 'GET 109876543210': 'network' }).fetchImpl });
    expect(a).toMatchObject({ ok: false, kind: 'transient', state: null });
    expect(b).toMatchObject({ ok: false, kind: 'transient', state: null, code: 'network' });
  });
  it('lista las apps suscritas (formato de Meta) y suscribe la nuestra', async () => {
    const m = fakeMeta({
      'GET 123456789012345/subscribed_apps': { body: { data: [{ whatsapp_business_api_data: { id: '5550001', name: 'CRM' } }, { id: '777' }] } },
      'POST 123456789012345/subscribed_apps': { body: { success: true } },
    });
    expect(await listSubscribedApps('123456789012345', TOKEN, { fetchImpl: m.fetchImpl })).toEqual({ ok: true, data: ['5550001', '777'] });
    expect(await subscribeApp('123456789012345', TOKEN, { fetchImpl: m.fetchImpl })).toEqual({ ok: true, data: true });
    const no = fakeMeta({ 'POST 123456789012345/subscribed_apps': { body: { success: false } } });
    expect(await subscribeApp('123456789012345', TOKEN, { fetchImpl: no.fetchImpl })).toMatchObject({ ok: false, code: 'subscribe_failed' });
  });
});

describe('verificar una conexión', () => {
  it('todo bien: conectado, con nombre, teléfono, calidad y webhook suscrito; el token NUNCA se registra', async () => {
    const m = fakeMeta({ 'GET 109876543210': PHONE_OK, 'GET 123456789012345/subscribed_apps': { body: { data: [{ whatsapp_business_api_data: { id: '5550001' } }] } } });
    const a = fakeAdmin([ch()], TOKEN);
    const r = await verifyChannel(a.admin, 'c1', { fetchImpl: m.fetchImpl, env: env(), now: NOW });
    expect(r).toMatchObject({ state: 'connected', accountName: 'Arkos Ventas', detail: null });
    expect(a.health()[0]).toMatchObject({ p_state: 'connected', p_account_name: 'Arkos Ventas', p_display_phone: '+57 300 111 2233', p_metadata: { quality_rating: 'GREEN', webhook_subscribed: true } });
    expect(JSON.stringify(a.rpc)).not.toContain(TOKEN.slice(5, 30));
    expect(m.calls.every((c) => c.method === 'GET')).toBe(true);        // ya estaba suscrita: no se toca
  });
  it('si la app NO está suscrita, la suscribe; si no puede, «webhook no configurado»', async () => {
    const base = { 'GET 109876543210': PHONE_OK, 'GET 123456789012345/subscribed_apps': { body: { data: [{ id: '999' }] } } };
    const ok = fakeMeta({ ...base, 'POST 123456789012345/subscribed_apps': { body: { success: true } } });
    const a1 = fakeAdmin([ch()], TOKEN);
    expect((await verifyChannel(a1.admin, 'c1', { fetchImpl: ok.fetchImpl, env: env(), now: NOW })).state).toBe('connected');
    expect(ok.calls.some((c) => c.method === 'POST')).toBe(true);
    const bad = fakeMeta({ ...base, 'POST 123456789012345/subscribed_apps': { status: 400, body: { error: { code: 100, message: 'nope' } } } });
    const a2 = fakeAdmin([ch()], TOKEN);
    const r = await verifyChannel(a2.admin, 'c1', { fetchImpl: bad.fetchImpl, env: env(), now: NOW });
    expect(r.state).toBe('webhook_missing');
    expect(a2.health()[0]).toMatchObject({ p_state: 'webhook_missing', p_account_name: 'Arkos Ventas' });   // lo aprendido del número se conserva
  });
  it('sin META_APP_ID basta con que haya alguna app suscrita', async () => {
    const m = fakeMeta({ 'GET 109876543210': PHONE_OK, 'GET 123456789012345/subscribed_apps': { body: { data: [{ id: '999' }] } } });
    const a = fakeAdmin([ch()], TOKEN);
    expect((await verifyChannel(a.admin, 'c1', { fetchImpl: m.fetchImpl, env: env({ META_APP_ID: '' }), now: NOW })).state).toBe('connected');
  });
  it('token vencido → «token expirado»; permisos → «requiere autorización»; el detalle sale sin secretos', async () => {
    const exp = fakeMeta({ 'GET 109876543210': { status: 400, body: { error: { code: 190, message: `Token ${TOKEN} expired` } } } });
    const a1 = fakeAdmin([ch()], TOKEN);
    const r = await verifyChannel(a1.admin, 'c1', { fetchImpl: exp.fetchImpl, env: env(), now: NOW });
    expect(r.state).toBe('token_expired');
    expect(JSON.stringify([r, a1.rpc])).not.toContain(TOKEN.slice(5, 30));
    const perm = fakeMeta({ 'GET 109876543210': { status: 403, body: { error: { code: 200, message: 'permission' } } } });
    expect((await verifyChannel(fakeAdmin([ch()], TOKEN).admin, 'c1', { fetchImpl: perm.fetchImpl, env: env(), now: NOW })).state).toBe('needs_auth');
  });
  it('caída de Meta → «error de conexión» (transitorio), con el código «network»', async () => {
    const a = fakeAdmin([ch()], TOKEN);
    const r = await verifyChannel(a.admin, 'c1', { fetchImpl: fakeMeta({ 'GET 109876543210': 'network' }).fetchImpl, env: env(), now: NOW });
    expect(r.state).toBe('error');
    expect(a.health()[0]).toMatchObject({ p_state: 'error', p_code: 'network' });
  });
  it('sin token guardado → requiere autorización, sin llamar a Meta', async () => {
    const m = fakeMeta({});
    const a = fakeAdmin([ch()], null);
    expect((await verifyChannel(a.admin, 'c1', { fetchImpl: m.fetchImpl, env: env(), now: NOW })).state).toBe('needs_auth');
    expect(a.health()[0]).toMatchObject({ p_code: 'no_token' });
    expect(m.calls).toHaveLength(0);
  });
  it('token cifrado: se abre con la llave; sin ella o con otra, «requiere autorización» (jamás se envía basura a Meta)', async () => {
    const sealed = sealSecret(TOKEN, { CONNECTIONS_ENCRYPTION_KEY: KEY } as never);
    const m = fakeMeta({ 'GET 109876543210': PHONE_OK, 'GET 123456789012345/subscribed_apps': { body: { data: [{ id: '5550001' }] } } });
    expect((await verifyChannel(fakeAdmin([ch()], sealed).admin, 'c1', { fetchImpl: m.fetchImpl, env: env({ CONNECTIONS_ENCRYPTION_KEY: KEY }), now: NOW })).state).toBe('connected');
    expect(m.calls[0]!.auth).toBe(`Bearer ${TOKEN}`);
    const m2 = fakeMeta({});
    const a = fakeAdmin([ch()], sealed);
    expect((await verifyChannel(a.admin, 'c1', { fetchImpl: m2.fetchImpl, env: env(), now: NOW })).state).toBe('needs_auth');
    expect(a.health()[0]).toMatchObject({ p_code: 'key_missing' });
    expect(m2.calls).toHaveLength(0);
  });
  it('un número desconectado no se verifica ni se reconecta solo', async () => {
    const m = fakeMeta({});
    const a = fakeAdmin([ch({ connection_status: 'disconnected' })], TOKEN);
    expect((await verifyChannel(a.admin, 'c1', { fetchImpl: m.fetchImpl, env: env(), now: NOW })).state).toBe('disconnected');
    expect(m.calls).toHaveLength(0);
    expect(a.health()).toHaveLength(0);
  });
  it('un canal que no existe lanza', async () => {
    await expect(verifyChannel(fakeAdmin([], TOKEN).admin, 'zzz', { env: env(), now: NOW })).rejects.toThrow('channel_not_found');
  });
  it('sin cuenta de WhatsApp Business: solo cuenta lo que realmente llegó (con 30 min de gracia)', async () => {
    const run = async (o: Row) => (await verifyChannel(fakeAdmin([ch({ business_account_id: null, ...o })], TOKEN).admin, 'c1', { fetchImpl: fakeMeta({ 'GET 109876543210': PHONE_OK }).fetchImpl, env: env(), now: NOW })).state;
    expect(await run({ connected_at: '2026-09-20T11:50:00Z' })).toBe('connected');                       // recién conectado
    expect(await run({ connected_at: '2026-09-20T09:00:00Z' })).toBe('webhook_missing');                  // hace horas y nunca llegó nada
    expect(await run({ connected_at: '2026-09-20T09:00:00Z', last_webhook_at: '2026-09-20T11:00:00Z' })).toBe('connected');
  });
});

describe('barrido periódico', () => {
  it('verifica solo las que tocan, con un máximo por pasada, y cuenta los problemas', async () => {
    const meta = fakeMeta({ 'GET 1000001': PHONE_OK, 'GET 1000002': { status: 400, body: { error: { code: 190, message: 'x' } } } });
    const rows = [
      ch({ id: 'a', external_id: '1000001', business_account_id: null, connection_status: 'connected', last_checked_at: '2026-09-20T11:00:00Z', last_webhook_at: '2026-09-20T11:00:00Z' }),   // reciente: no toca
      ch({ id: 'b', external_id: '1000002', business_account_id: null, connection_status: 'error', last_checked_at: '2026-09-20T10:00:00Z' }),     // problema: toca
      ch({ id: 'c', external_id: '1000001', business_account_id: null, connection_status: 'pending', last_checked_at: null, last_webhook_at: '2026-09-20T11:00:00Z' }),
    ];
    const a = fakeAdmin(rows, TOKEN);
    const r = await sweepConnections(a.admin, { fetchImpl: meta.fetchImpl, env: env(), now: NOW });
    expect(r).toEqual({ checked: 2, problems: 1 });
    expect(a.health().map((h) => h.p_channel).sort()).toEqual(['b', 'c']);
    const a2 = fakeAdmin(rows, TOKEN);
    expect((await sweepConnections(a2.admin, { limit: 1, fetchImpl: meta.fetchImpl, env: env(), now: NOW })).checked).toBe(1);
  });
  it('un fallo en una conexión no detiene las demás', async () => {
    const rows = [ch({ id: 'a', connection_status: 'pending', last_checked_at: null }), ch({ id: 'b', connection_status: 'pending', last_checked_at: null, business_account_id: null, last_webhook_at: '2026-09-20T11:00:00Z' })];
    const a = fakeAdmin(rows, TOKEN);
    const meta = fakeMeta({ 'GET 109876543210': 'network' });
    const r = await sweepConnections(a.admin, { fetchImpl: meta.fetchImpl, env: env(), now: NOW });
    expect(r.checked).toBe(2);
  });
});

describe('autorización antes de usar el cliente de servidor', () => {
  const ID = '11111111-1111-4111-8111-111111111111', OTHER = '22222222-2222-4222-8222-222222222222';
  const dbWith = (ids: string[]) => ({ from: () => { const b: Record<string, unknown> = { select: () => b, eq: () => b, order: () => b, then: (r: (v: unknown) => unknown) => Promise.resolve({ data: ids.map((id) => ({ id, kind: 'whatsapp', name: 'x', external_id: '1', display_phone: null, status: 'active', metadata: {} })), error: null }).then(r) }; return b; } }) as never;
  it('un administrador sobre una conexión de SU organización: se permite', async () => {
    expect(await resolveManagedChannel(dbWith([ID]), 'org', true, ID)).toBe(ID);
  });
  it('quien no es administrador NO pasa, aunque la conexión exista', async () => {
    await expect(resolveManagedChannel(dbWith([ID]), 'org', false, ID)).rejects.toBeInstanceOf(UserFacingError);
  });
  it('una conexión de otra organización (o inexistente, o con un id raro) NO pasa', async () => {
    await expect(resolveManagedChannel(dbWith([ID]), 'org', true, OTHER)).rejects.toBeInstanceOf(UserFacingError);
    for (const bad of ['', 'no-es-uuid', "1'; drop table channels; --", '../etc']) await expect(resolveManagedChannel(dbWith([ID]), 'org', true, bad)).rejects.toBeInstanceOf(UserFacingError);
  });
});

/**
 * Integración del módulo Conexiones contra PostgREST + Postgres reales (usuarios con JWT firmado) y una Meta FALSA
 * inyectada: conectar, verificar, estados, desconectar, recuperación por actividad real, cifrado y permisos.
 */
import { createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';

vi.mock('server-only', () => ({}));

import type { ServerSupabase } from '@/lib/supabase/server';
import { toUserMessage, UserFacingError } from '@/lib/errors';
import { createOrganization } from '@/repositories/organizations';
import { parseInboxQuery } from '@/lib/inbox-view';
import * as repo from '@/repositories/inbox';
import { connectWhatsApp, sweepConnections, verifyChannel } from '@/server/connections';
import { processMetaPayload } from '@/server/inbound';
import { deliverMessage } from '@/server/outbound';
import { createAdminClient } from '@/server/supabase-admin';

const REST_URL = process.env.REST_URL!;
const SECRET = process.env.JWT_SECRET!;
const DB = process.env.INT_DB!;
const A = 'aaaaaaaa-9999-0000-0000-00000000000a';
const B = 'bbbbbbbb-9999-0000-0000-00000000000b';
const S1 = '51000000-9999-0000-0000-000000000001';
const PID = '709876543210';
const WABA = '123456789012345';
const TOKEN = 'EAAGm0PX4ZCpsBOabcdefghijklmnopqrstuvwxyz1234';
const TOKEN2 = 'EAAGm0PX4ZCpsBOzzzzzzzzzzzzzzzzzzzzzzzzzzzz5678';
const KEY = 'una-llave-larga-de-al-menos-32-caracteres-123';

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
function jwt(claims: Record<string, unknown>) {
  const h = b64({ alg: 'HS256', typ: 'JWT' });
  const p = b64({ ...claims, exp: Math.floor(Date.now() / 1000) + 3600 });
  return `${h}.${p}.${createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url')}`;
}
const client = (token: string) =>
  createClient(REST_URL, token, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${token}` } } }) as unknown as ServerSupabase;
const asUser = (uid: string) => client(jwt({ role: 'authenticated', sub: uid }));
const sql = (q: string) => execFileSync('psql', ['-X', '-tA', '-d', DB, '-c', q], { encoding: 'utf8' }).trim();
const rejects = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as Error & { code?: string }; } throw new Error('se esperaba un error y no ocurrió'); };

const a = asUser(A), b = asUser(B), s1 = asUser(S1);
let org = '', orgB = '';
const admin = () => createAdminClient();

/** Meta falsa configurable: cada prueba cambia cómo responde. */
const meta = { phone: 'ok' as 'ok' | '190' | '200' | '503' | 'network', subscribed: true, subscribeOk: true, calls: [] as string[] };
const fakeFetch = (async (url: string, init?: RequestInit) => {
  const u = new URL(url); const route = `${init?.method ?? 'GET'} ${u.pathname.split('/').slice(2).join('/')}`;
  meta.calls.push(route + ' ' + ((init?.headers as Record<string, string>)?.Authorization ?? '').slice(0, 12));
  const res = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
  if (route === `GET ${PID}` || route === 'GET 709876543299') {
    if (meta.phone === 'network') throw new Error('ECONNRESET');
    if (meta.phone === '503') return res(503, {});
    if (meta.phone === '190') return res(400, { error: { code: 190, message: `Token ${TOKEN} expired` } });
    if (meta.phone === '200') return res(403, { error: { code: 200, message: 'permission missing' } });
    return res(200, { verified_name: 'Arkos Ventas', display_phone_number: '+57 300 111 2233', quality_rating: 'GREEN' });
  }
  if (route === `GET ${WABA}/subscribed_apps`) return res(200, { data: meta.subscribed ? [{ whatsapp_business_api_data: { id: '5550001' } }] : [] });
  if (route === `POST ${WABA}/subscribed_apps`) return meta.subscribeOk ? res(200, { success: true }) : res(400, { error: { code: 100, message: 'nope' } });
  return res(404, { error: { code: 100, message: 'ruta desconocida' } });
}) as unknown as typeof fetch;
const deps = { fetchImpl: fakeFetch, env: { META_APP_ID: '5550001' } as unknown as NodeJS.ProcessEnv };
const good = { name: '', phoneNumberId: PID, businessAccountId: WABA, token: TOKEN };
const reset = () => { meta.phone = 'ok'; meta.subscribed = true; meta.subscribeOk = true; meta.calls.length = 0; };
const chan = async () => (await repo.listChannels(a, org)).find((c) => c.externalId === PID)!;

beforeAll(async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = REST_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY = jwt({ role: 'service_role' });
  for (const [id, email] of [[A, 'a@cx.test'], [B, 'b@cx.test'], [S1, 's1@cx.test']]) sql(`insert into auth.users (id, email) values ('${id}', '${email}')`);
  org = await createOrganization(a, 'Conexiones Int', 'conexiones-int');
  orgB = await createOrganization(b, 'Otra Org', 'otra-org');
  sql(`insert into memberships (org_id, user_id, role_id) select '${org}', '${S1}', id from roles where key = 'sales_agent' and org_id is null`);
}, 60_000);
afterAll(() => { delete process.env.CONNECTIONS_ENCRYPTION_KEY; });

describe('conectar un número', () => {
  it('con datos válidos: comprueba con Meta, guarda cuenta y nombre, suscribe y queda CONECTADO', async () => {
    reset();
    const r = await connectWhatsApp(a, admin(), org, good, deps);
    expect(r).toMatchObject({ reconnected: false, outcome: { state: 'connected', accountName: 'Arkos Ventas' } });
    const c = await chan();
    expect(c).toMatchObject({ name: 'Arkos Ventas', accountName: 'Arkos Ventas', displayPhone: '+57 300 111 2233', businessAccountId: WABA, connectionStatus: 'connected', status: 'active' });
    expect(c.connectedAt).not.toBeNull(); expect(c.lastSyncAt).not.toBeNull(); expect(c.lastCheckedAt).not.toBeNull();
    expect(c.metadata).toMatchObject({ quality_rating: 'GREEN', webhook_subscribed: true });
    expect(meta.calls[0]).toMatch(/^GET 709876543210 Bearer EAAG/);       // el token viaja SOLO en el encabezado hacia Meta
  });
  it('el token NUNCA sale: ni en la fila del canal ni por la API para el administrador', async () => {
    const c = await chan();
    expect(JSON.stringify(c)).not.toContain('EAAG');
    const direct = await a.from('channel_secrets').select('*');
    expect(JSON.stringify(direct.data ?? [])).not.toContain('EAAG');
    expect((direct.data ?? []).length).toBe(0);
    const raw = await a.from('channels').select('*').eq('external_id', PID);
    expect(JSON.stringify(raw.data)).not.toMatch(/EAAG|access_token/);
    expect(sql(`select count(*) from channel_secrets where channel_id = '${c.id}'`)).toBe('1');    // sí está guardado (solo el servidor lo lee)
    expect(await verifyStored(c.id)).toBe(TOKEN);
  });
  it('un token vencido, sin permisos o con Meta caída NO guarda nada y explica en español', async () => {
    const before = (await repo.listChannels(a, org)).length;
    for (const [mode, expected] of [['190', /no es válido o ya venció/], ['200', /no tiene acceso a ese número/], ['503', /No pudimos comunicarnos con Meta/], ['network', /No pudimos comunicarnos con Meta/]] as const) {
      reset(); meta.phone = mode;
      const e = await rejects(connectWhatsApp(a, admin(), org, { ...good, phoneNumberId: PID, token: TOKEN2 }, deps));
      expect(e).toBeInstanceOf(UserFacingError);
      expect(toUserMessage(e)).toMatch(expected);
      expect(toUserMessage(e)).not.toMatch(/EAAG|190|OAuth|Graph/);
    }
    expect((await repo.listChannels(a, org)).length).toBe(before);
    expect(await verifyStored((await chan()).id)).toBe(TOKEN);                              // el token bueno sigue intacto
  });
  it('los datos mal escritos se rechazan antes de llamar a Meta', async () => {
    reset();
    for (const bad of [{ ...good, phoneNumberId: 'abc' }, { ...good, businessAccountId: '' }, { ...good, token: 'corto' }, { ...good, token: 'con espacios en el token de acceso' }]) {
      expect(await rejects(connectWhatsApp(a, admin(), org, bad, deps))).toBeInstanceOf(UserFacingError);
    }
    expect(meta.calls).toHaveLength(0);
  });
  it('un vendedor no puede conectar: la base de datos lo impide y no queda nada', async () => {
    reset();
    const e = await rejects(connectWhatsApp(s1, admin(), org, { ...good, phoneNumberId: '709876543299' }, deps));
    expect(e.code).toBe('42501');
    expect((await repo.listChannels(a, org)).map((c) => c.externalId)).toEqual([PID]);
  });
  it('reconectar el mismo número con otro token no duplica: reutiliza la conexión', async () => {
    reset();
    const r = await connectWhatsApp(a, admin(), org, { ...good, token: TOKEN2 }, deps);
    expect(r.reconnected).toBe(true);
    expect(r.outcome.state).toBe('connected');
    expect((await repo.listChannels(a, org)).filter((c) => c.externalId === PID)).toHaveLength(1);
    expect(await verifyStored((await chan()).id)).toBe(TOKEN2);
  });
  it('otra organización no ve la conexión ni su registro; y no puede conectar el mismo número', async () => {
    expect(await repo.listChannels(b, orgB)).toEqual([]);
    expect((await repo.listConnectionEvents(b, (await chan()).id)).length).toBe(0);
    reset();
    const e = await rejects(connectWhatsApp(b, admin(), orgB, good, deps));
    expect(toUserMessage(e)).toBeTruthy();
    expect(await repo.listChannels(b, orgB)).toEqual([]);
  });
});

/** Deja «recién verificados» los canales de las demás pruebas (el barrido es global) para aislar el que se prueba. */
const quiet = (id: string) => sql(`update channels set last_checked_at = now() where id <> '${id}'`);

async function verifyStored(channelId: string): Promise<string | null> {
  const r = await admin().rpc('channel_credentials', { p_channel: channelId });
  return typeof r.data === 'string' ? r.data : null;
}

describe('verificar: estados según lo que responde Meta', () => {
  it('token vencido → «Token expirado»; permisos → «Requiere autorización»; caída → «Error»; y se recupera', async () => {
    const id = (await chan()).id;
    for (const [mode, state, code] of [['190', 'token_expired', '190'], ['200', 'needs_auth', '200'], ['503', 'error', '503'], ['network', 'error', 'network']] as const) {
      reset(); meta.phone = mode;
      expect((await verifyChannel(admin(), id, deps)).state).toBe(state);
      expect(await chan()).toMatchObject({ connectionStatus: state, lastErrorCode: code });
    }
    reset();
    expect((await verifyChannel(admin(), id, deps)).state).toBe('connected');
    expect(await chan()).toMatchObject({ connectionStatus: 'connected', lastErrorCode: null });
  });
  it('webhook sin suscribir: la app se suscribe sola; si Meta no deja, «Webhook no configurado»', async () => {
    const id = (await chan()).id;
    reset(); meta.subscribed = false;
    expect((await verifyChannel(admin(), id, deps)).state).toBe('connected');
    expect(meta.calls.some((c) => c.startsWith('POST'))).toBe(true);
    reset(); meta.subscribed = false; meta.subscribeOk = false;
    expect((await verifyChannel(admin(), id, deps)).state).toBe('webhook_missing');
  });
  it('el administrador ve el registro técnico (sin token); un vendedor no ve nada', async () => {
    const id = (await chan()).id;
    const ev = await repo.listConnectionEvents(a, id, 50);
    expect(ev.length).toBeGreaterThan(5);
    expect(ev.some((e) => e.code === '190' && !e.ok)).toBe(true);
    expect(JSON.stringify(ev)).not.toMatch(/EAAG|Bearer [A-Za-z0-9]/);
    expect(await repo.listConnectionEvents(s1, id)).toEqual([]);
  });
  it('el estado se resume para la pantalla: el vendedor SÍ ve el estado del canal (sin credenciales) para el Inbox', async () => {
    const seen = await repo.listChannels(s1, org);
    expect(seen).toHaveLength(1);
    expect(JSON.stringify(seen)).not.toMatch(/EAAG/);
  });
});

describe('actividad real actualiza la conexión', () => {
  let customer = '', conv = '';
  const payload = (id: string, text: string) => ({ object: 'whatsapp_business_account', entry: [{ id: WABA, changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp', metadata: { display_phone_number: '573001110000', phone_number_id: PID },
    contacts: [{ wa_id: '573001110077', profile: { name: 'Laura Conexión' } }],
    messages: [{ from: '573001110077', id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }] } }] }] });

  it('un mensaje recibido prueba que el webhook llega: «Webhook no configurado» pasa a «Conectado»', async () => {
    const id = (await chan()).id;
    reset(); meta.subscribed = false; meta.subscribeOk = false;
    await verifyChannel(admin(), id, deps);
    expect((await chan()).connectionStatus).toBe('webhook_missing');
    const r = await processMetaPayload(admin(), payload('wamid.cx1', 'hola'));
    expect(r.messages).toBe(1);
    const c = await chan();
    expect(c.connectionStatus).toBe('connected');
    expect(c.lastWebhookAt).not.toBeNull();
    const conv0 = (await repo.searchConversations(a, { orgId: org, userId: A, query: emptyQ })).items[0]!;
    conv = conv0.id; customer = conv0.customerId;
    expect(customer).toBeTruthy();
  });
  it('un envío rechazado por token vencido deja la CONEXIÓN en «Token expirado»; uno aceptado la recupera', async () => {
    const id = (await chan()).id;
    const m1 = await repo.queueMessage(a, conv, 'Hola desde el CRM');
    expect(await deliverMessage(admin(), m1, async () => ({ ok: false, definitive: true, code: '190', message: `Token ${TOKEN} inválido` }))).toBe('failed');
    expect(await chan()).toMatchObject({ connectionStatus: 'token_expired', lastErrorCode: '190' });
    expect(JSON.stringify(await repo.listConnectionEvents(a, id, 5))).not.toContain('EAAG');
    const m2 = await repo.queueMessage(a, conv, 'Segundo intento');
    expect(await deliverMessage(admin(), m2, async () => ({ ok: true, externalId: 'wamid.out1' }))).toBe('sent');
    expect(await chan()).toMatchObject({ connectionStatus: 'connected', lastErrorCode: null });
  });
  it('un rechazo que no habla de la salud de la conexión (p. ej. fuera de ventana) NO la marca como caída', async () => {
    const m = await repo.queueMessage(a, conv, 'Otro mensaje');
    await deliverMessage(admin(), m, async () => ({ ok: false, definitive: true, code: '131047', message: 'Re-engagement message' }));
    expect((await chan()).connectionStatus).toBe('connected');
  });
});

describe('cifrado de tokens (opcional)', () => {
  it('con llave: se guarda cifrado, se verifica y se usa para enviar; sin llave falla con «requiere autorización»', async () => {
    const id = (await chan()).id;
    process.env.CONNECTIONS_ENCRYPTION_KEY = KEY;
    reset();
    await connectWhatsApp(a, admin(), org, { ...good, token: TOKEN }, { ...deps, env: { META_APP_ID: '5550001', CONNECTIONS_ENCRYPTION_KEY: KEY } as never });
    const stored = sql(`select access_token from channel_secrets where channel_id = '${id}'`);
    expect(stored.startsWith('enc:v1:')).toBe(true);
    expect(stored).not.toContain('EAAG');
    expect((await verifyChannel(admin(), id, { ...deps, env: { META_APP_ID: '5550001', CONNECTIONS_ENCRYPTION_KEY: KEY } as never })).state).toBe('connected');
    const conv = (await repo.searchConversations(a, { orgId: org, userId: A, query: emptyQ })).items[0]!.id;
    const sent = await repo.queueMessage(a, conv, 'Con token cifrado');
    let usedToken = '';
    expect(await deliverMessage(admin(), sent, async (i) => { usedToken = i.token; return { ok: true, externalId: 'wamid.enc1' }; })).toBe('sent');
    expect(usedToken).toBe(TOKEN);                                                     // se descifró bien
    delete process.env.CONNECTIONS_ENCRYPTION_KEY;
    const lost = await repo.queueMessage(a, conv, 'Sin llave');
    expect(await deliverMessage(admin(), lost, async () => ({ ok: true, externalId: 'x' }))).toBe('failed');
    const failed = sql(`select error from messages where id = '${lost}'`);
    expect(failed).toMatch(/No se pudo abrir el token/);
    expect((await verifyChannel(admin(), id, deps)).state).toBe('needs_auth');
  });
});

describe('desconectar', () => {
  it('borra el token, bloquea el envío con un mensaje claro y CONSERVA el historial', async () => {
    const id = (await chan()).id;
    reset(); await connectWhatsApp(a, admin(), org, good, deps);
    const conv = (await repo.searchConversations(a, { orgId: org, userId: A, query: emptyQ })).items[0]!.id;
    const before = sql(`select count(*) from messages where conversation_id = '${conv}'`);
    await repo.disconnectChannel(a, id);
    expect(await chan()).toMatchObject({ connectionStatus: 'disconnected' });
    expect((await chan()).disconnectedAt).not.toBeNull();
    expect(await verifyStored(id)).toBeNull();
    expect(sql(`select count(*) from messages where conversation_id = '${conv}'`)).toBe(before);
    expect(toUserMessage(await rejects(repo.queueMessage(a, conv, 'No debería salir')))).toMatch(/desconectado/);
    expect(sql(`select count(*) from messages where conversation_id = '${conv}'`)).toBe(before);   // no se encoló nada
  });
  it('una verificación o la actividad NO reconectan un número desconectado; el barrido lo ignora', async () => {
    const id = (await chan()).id;
    reset();
    expect((await verifyChannel(admin(), id, deps)).state).toBe('disconnected');
    expect(meta.calls).toHaveLength(0);
    quiet(id);
    sql(`update channels set last_checked_at = null where id = '${id}'`);
    await sweepConnections(admin(), deps);
    expect(sql(`select last_checked_at is null from channels where id = '${id}'`)).toBe('t');       // el barrido ni la tocó
    await processMetaPayload(admin(), { object: 'whatsapp_business_account', entry: [] });
    expect((await chan()).connectionStatus).toBe('disconnected');
  });
  it('un vendedor no puede desconectar; reconectar con token válido lo reabre', async () => {
    const id = (await chan()).id;
    expect((await rejects(repo.disconnectChannel(s1, id))).code).toBe('42501');
    reset();
    const r = await connectWhatsApp(a, admin(), org, good, deps);
    expect(r.reconnected).toBe(true);
    expect(await chan()).toMatchObject({ connectionStatus: 'connected', disconnectedAt: null });
    const conv = (await repo.searchConversations(a, { orgId: org, userId: A, query: emptyQ })).items[0]!.id;
    await expect(repo.queueMessage(a, conv, 'Ya estamos de vuelta')).resolves.toBeTruthy();
  });
});

describe('barrido periódico', () => {
  it('verifica las conexiones que tocan y deja constancia', async () => {
    const id = (await chan()).id;
    quiet(id);
    sql(`update channels set last_checked_at = now() - interval '10 hours' where id = '${id}'`);
    reset(); meta.phone = '190';
    const r = await sweepConnections(admin(), deps);
    expect(r).toEqual({ checked: 1, problems: 1 });
    expect((await chan()).connectionStatus).toBe('token_expired');
    reset();
    sql(`update channels set last_checked_at = now() - interval '2 hours' where id = '${id}'`);
    expect((await sweepConnections(admin(), deps)).checked).toBe(1);
    expect((await chan()).connectionStatus).toBe('connected');
    expect((await sweepConnections(admin(), deps)).checked).toBe(0);           // recién verificada: no toca
  });
});

// consulta vacía del Inbox (todas las conversaciones)
const emptyQ = parseInboxQuery({});

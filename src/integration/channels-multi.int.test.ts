/**
 * Integración de Facebook Messenger, Instagram Direct y Gmail contra PostgREST + Postgres reales, con un Meta y un Google
 * SIMULADOS (buzón en memoria con historial): inicio de sesión, elección de páginas, recepción, respuesta, cliente único,
 * revocación de acceso y permisos.
 */
import { createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';

vi.mock('server-only', () => ({}));

import type { ServerSupabase } from '@/lib/supabase/server';
import { UserFacingError, toUserMessage } from '@/lib/errors';
import { parseInboxQuery } from '@/lib/inbox-view';
import { createOrganization } from '@/repositories/organizations';
import * as customers from '@/repositories/customers';
import * as repo from '@/repositories/inbox';
import { completeGoogleLogin, completeMetaLogin, connectMetaSelection, peekMetaSession, sweepGmail, syncGmail, verifyChannel } from '@/server/connections';
import { sendGmailReply } from '@/server/gmail';
import { processMetaPayload } from '@/server/inbound';
import { deliverMessage } from '@/server/outbound';
import { createAdminClient } from '@/server/supabase-admin';

const REST_URL = process.env.REST_URL!, SECRET = process.env.JWT_SECRET!, DB = process.env.INT_DB!;
const A = 'aaaaaaaa-b222-0000-0000-00000000000a', S1 = '51000000-b222-0000-0000-000000000001';
const PAGE = '100000000000777', PAGE2 = '100000000000888', IG = '17841400000000777', PSID = '5500000000000777', IGSID = '5500000000000778';
const PAGE_TOKEN = 'EAAPAGEtokenPAGEtokenPAGEtoken0001';
const REFRESH = '1//refresh-token-abcdefghijklmnopqrstuvwxyz';

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (claims: Record<string, unknown>) => { const h = b64({ alg: 'HS256', typ: 'JWT' }), p = b64({ ...claims, exp: Math.floor(Date.now() / 1000) + 3600 }); return `${h}.${p}.${createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url')}`; };
const client = (t: string) => createClient(REST_URL, t, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${t}` } } }) as unknown as ServerSupabase;
const asUser = (uid: string) => client(jwt({ role: 'authenticated', sub: uid }));
const sql = (q: string) => execFileSync('psql', ['-X', '-tA', '-d', DB, '-c', q], { encoding: 'utf8' }).trim();
const rejects = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as Error & { code?: string }; } throw new Error('se esperaba un error'); };
const a = asUser(A), s1 = asUser(S1);
const admin = () => createAdminClient();
let org = '';
const emptyQ = parseInboxQuery({});

// ------------------------------------------------------------------------------------------------ Meta simulada
const meta = { subscribed: false, posts: [] as string[], lastForm: '' as string, lastUrl: '' as string };
// ------------------------------------------------------------------------------------------------ Google simulado
const gm = { revoked: false, refresh: REFRESH as string | undefined, scope: 'openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send', email: 'ventas@arkos.co',
  historyGone: false, failIds: new Set<string>(), sent: [] as { raw: string; threadId?: string }[], auth: [] as string[] };
let historyId = 100;
const mailbox = new Map<string, unknown>(); const inboxIds: string[] = []; const historyLog: { id: string; at: number }[] = [];
const enc = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
function mail(id: string, o: { from: string; subject: string; body: string; labels?: string[]; headers?: Record<string, string> }) {
  return { id, threadId: `t-${id}`, labelIds: o.labels ?? ['INBOX', 'UNREAD'], internalDate: String(Date.now() - 60_000), payload: { mimeType: 'multipart/alternative',
    headers: Object.entries({ From: o.from, Subject: o.subject, 'Message-ID': `<mid-${id}@mail.gmail.com>`, ...(o.headers ?? {}) }).map(([name, value]) => ({ name, value })),
    parts: [{ mimeType: 'text/plain', body: { data: enc(o.body) } }] } };
}
function deliver(m: ReturnType<typeof mail>) { mailbox.set(m.id, m); inboxIds.push(m.id); historyId++; historyLog.push({ id: m.id, at: historyId }); }

const res = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
const fetchImpl = (async (url: string, init?: RequestInit) => {
  const u = new URL(url); const method = init?.method ?? 'GET';
  const headers = (init?.headers ?? {}) as Record<string, string>;
  if (u.host === 'oauth2.googleapis.com') {
    const f = new URLSearchParams(String(init?.body ?? ''));
    if (f.get('grant_type') === 'authorization_code') return res(200, { access_token: 'ya29.first', ...(gm.refresh ? { refresh_token: gm.refresh } : {}), scope: gm.scope, expires_in: 3600 });
    return gm.revoked ? res(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }) : res(200, { access_token: 'ya29.fresh', expires_in: 3600 });
  }
  if (u.host === 'gmail.googleapis.com') {
    gm.auth.push(headers.Authorization ?? '');
    const p = u.pathname.replace('/gmail/v1/users/me', '');
    if (p === '/profile') return res(200, { emailAddress: gm.email, historyId: String(historyId) });
    if (p === '/messages' && method === 'GET') return res(200, { messages: inboxIds.map((id) => ({ id, threadId: `t-${id}` })) });
    if (p === '/messages/send') { const j = JSON.parse(String(init?.body)); gm.sent.push(j); return res(200, { id: `sent-${gm.sent.length}`, threadId: j.threadId }); }
    if (p.startsWith('/messages/')) { const id = decodeURIComponent(p.slice(10)); if (gm.failIds.has(id)) return res(503, {}); return mailbox.has(id) ? res(200, mailbox.get(id)) : res(404, { error: { code: 404, message: 'nope', status: 'NOT_FOUND' } }); }
    if (p === '/history') {
      if (gm.historyGone) return res(404, { error: { code: 404, message: 'Requested entity was not found.', status: 'NOT_FOUND' } });
      const from = Number(u.searchParams.get('startHistoryId'));
      const items = historyLog.filter((h) => h.at > from).map((h) => ({ messagesAdded: [{ message: { id: h.id, labelIds: ['INBOX'] } }] }));
      return res(200, { history: items, historyId: String(historyId) });
    }
    return res(404, { error: { code: 404, message: 'ruta desconocida', status: 'NOT_FOUND' } });
  }
  // Graph API de Meta
  const route = `${method} ${u.pathname.split('/').slice(2).join('/')}`;
  meta.lastUrl = url; meta.lastForm = String(init?.body ?? '');
  if (route === 'POST oauth/access_token') return res(200, { access_token: new URLSearchParams(meta.lastForm).get('grant_type') === 'fb_exchange_token' ? 'LONGuserTOKENlonguserTOKENlonguser01' : 'SHORTuserTOKENshortuserTOKENshort01' });
  if (route === 'GET me/accounts') return res(200, { data: [
    { id: PAGE, name: 'Arkos Página', access_token: PAGE_TOKEN, instagram_business_account: { id: IG, username: 'arkos_co' } },
    { id: PAGE2, name: 'Arkos Outlet', access_token: PAGE_TOKEN.replace('0001', '0002') }] });
  if (route === `GET ${PAGE}` || route === `GET ${PAGE2}`) return res(200, { id: PAGE, name: 'Arkos Página' });
  if (route === `GET ${IG}`) return res(200, { id: IG, username: 'arkos_co' });
  if (route === `GET ${PAGE}/subscribed_apps` || route === `GET ${PAGE2}/subscribed_apps`) return res(200, { data: meta.subscribed ? [{ id: '5550001', subscribed_fields: ['messages'] }] : [] });
  if (route === `POST ${PAGE}/subscribed_apps` || route === `POST ${PAGE2}/subscribed_apps`) { meta.posts.push(route); meta.subscribed = true; return res(200, { success: true }); }
  if (route === `GET ${PSID}`) return res(200, { name: 'Ana Gómez' });
  if (route === `GET ${IGSID}`) return res(200, { name: 'Ana G', username: 'ana_gomez' });
  return res(404, { error: { code: 100, message: `sin ruta ${route}` } });
}) as unknown as typeof fetch;
const ENV = { META_APP_ID: '5550001', META_APP_SECRET: 'meta-secret-xyz-secret-xyz', GOOGLE_CLIENT_ID: 'gid.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'GOCSPX-google-secret-value' } as unknown as NodeJS.ProcessEnv;
const deps = { fetchImpl, env: ENV };

const fbPayload = (mid: string, text: string, sender = PSID, page = PAGE, object = 'page') => ({ object, entry: [{ id: page, time: 1, messaging: [{ sender: { id: sender }, recipient: { id: page }, timestamp: Date.now(), message: { mid, text } }] }] });
const chanId = (kind: string, ext: string) => sql(`select id from channels where kind='${kind}' and external_id='${ext}'`);
const convId = (channel: string, thread: string) => sql(`select id from conversations where channel_id='${channel}' and thread_key='${thread}'`);
const count = (q: string) => Number(sql(q));

beforeAll(async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = REST_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY = jwt({ role: 'service_role' });
  for (const [id, email] of [[A, 'a@mx.test'], [S1, 's1@mx.test']]) sql(`insert into auth.users (id, email) values ('${id}', '${email}')`);
  org = await createOrganization(a, 'Multi Int', 'multi-int');
  sql(`insert into memberships (org_id, user_id, role_id) select '${org}', '${S1}', id from roles where key = 'sales_agent' and org_id is null`);
}, 60_000);
afterAll(() => undefined);

describe('conectar Facebook e Instagram con Meta', () => {
  let sid = '';
  it('el código se cambia por tokens SIN poner el secreto en la dirección; se listan páginas y se guardan 15 min', async () => {
    sid = await completeMetaLogin(admin(), { code: 'CODE123', redirectUri: 'https://crm.test/api/connections/meta/callback', orgId: org, userId: A }, deps);
    expect(sid).toMatch(/^[0-9a-f-]{36}$/);
    expect(meta.lastUrl).not.toContain('meta-secret');
    const sess = await peekMetaSession(admin(), sid, org, A, ENV);
    expect(sess!.pages.map((p) => p.id)).toEqual([PAGE, PAGE2]);
    expect(sess!.pages[0]!.ig).toMatchObject({ id: IG, username: 'arkos_co' });
    expect(await peekMetaSession(admin(), sid, org, S1, ENV)).toBeNull();                      // otra persona no la ve
    const direct = await a.from('oauth_sessions').select('*');
    expect(direct.error).not.toBeNull();                                                        // ni por la API del navegador
  });
  it('sin la configuración de Meta falla con un mensaje claro', async () => {
    const e = await rejects(completeMetaLogin(admin(), { code: 'x', redirectUri: 'https://crm.test/cb', orgId: org, userId: A }, { fetchImpl, env: {} as never }));
    expect(e).toBeInstanceOf(UserFacingError); expect(toUserMessage(e)).toMatch(/META_APP_ID/);
  });
  it('elige página + Instagram: quedan conectadas, con la app suscrita al webhook, y el token no sale', async () => {
    meta.subscribed = false; meta.posts.length = 0;
    const out = await connectMetaSelection(a, admin(), { orgId: org, userId: A, sid, selection: [{ pageId: PAGE, facebook: true, instagram: true }] }, deps);
    expect(out).toEqual([{ kind: 'facebook', name: 'Arkos Página', state: 'connected' }, { kind: 'instagram', name: '@arkos_co', state: 'connected' }]);
    expect(meta.posts).toContain(`POST ${PAGE}/subscribed_apps`);
    const list = await repo.listChannels(a, org);
    const fb = list.find((c) => c.kind === 'facebook')!, ig = list.find((c) => c.kind === 'instagram')!;
    expect(fb).toMatchObject({ externalId: PAGE, accountName: 'Arkos Página', connectionStatus: 'connected' });
    expect(ig).toMatchObject({ externalId: IG, displayPhone: '@arkos_co', connectionStatus: 'connected' });
    expect(ig.metadata).toMatchObject({ page_id: PAGE, username: 'arkos_co' });
    expect(JSON.stringify(list)).not.toContain('EAAPAGE');
    expect((await admin().rpc('channel_credentials', { p_channel: fb.id })).data).toBe(PAGE_TOKEN);
    expect(count(`select count(*) from oauth_sessions where id = '${sid}'`)).toBe(0);           // la sesión se consumió
  });
  it('una sesión no se puede reutilizar, ni siquiera por quien la inició', async () => {
    const e = await rejects(connectMetaSelection(a, admin(), { orgId: org, userId: A, sid, selection: [{ pageId: PAGE2, facebook: true, instagram: false }] }, deps));
    expect(toUserMessage(e)).toMatch(/venció/);
  });
  it('una página sin Instagram y otra selección: solo lo elegido', async () => {
    const s2 = await completeMetaLogin(admin(), { code: 'C2', redirectUri: 'https://crm.test/cb', orgId: org, userId: A }, deps);
    const out = await connectMetaSelection(a, admin(), { orgId: org, userId: A, sid: s2, selection: [{ pageId: PAGE2, facebook: true, instagram: true }] }, deps);
    expect(out.map((o) => o.kind)).toEqual(['facebook']);
    const e = await rejects(connectMetaSelection(a, admin(), { orgId: org, userId: A, sid: await completeMetaLogin(admin(), { code: 'C3', redirectUri: 'x', orgId: org, userId: A }, deps), selection: [] }, deps));
    expect(toUserMessage(e)).toMatch(/al menos una/);
  });
  it('un vendedor no puede conectar cuentas', async () => {
    const e = await rejects(repo.connectChannel(s1, org, { kind: 'facebook', name: 'x', externalId: '100000000000999', token: 'EAA-token-largo-suficiente-abc' }));
    expect(e.code).toBe('42501');
  });
});

describe('recibir mensajes de Messenger e Instagram', () => {
  let fb = '', ig = '';
  beforeAll(() => { fb = chanId('facebook', PAGE); ig = chanId('instagram', IG); });

  it('un contacto nuevo crea cliente + lead + conversación, y el NOMBRE se completa desde Meta', async () => {
    const r = await processMetaPayload(admin(), fbPayload('mid.1', 'Hola, quiero cotizar un deck'), { fetchImpl });
    expect(r).toMatchObject({ messages: 1, retry: false, ignored: 0 });
    const conv = convId(fb, PSID);
    expect(conv).toBeTruthy();
    expect(sql(`select c.full_name from customers c join conversations v on v.customer_id = c.id where v.id = '${conv}'`)).toBe('Ana Gómez');
    expect(count(`select count(*) from customer_identifiers where type = 'facebook' and value = '${PSID}'`)).toBe(1);
    expect(count(`select count(*) from leads where source = 'facebook' and org_id = '${org}'`)).toBe(1);
  });
  it('la misma persona escribiendo otra vez (o el mismo aviso repetido) NO duplica cliente, lead, conversación ni mensaje', async () => {
    await processMetaPayload(admin(), fbPayload('mid.2', 'Otra pregunta'), { fetchImpl });
    await processMetaPayload(admin(), fbPayload('mid.2', 'Otra pregunta'), { fetchImpl });
    expect(count(`select count(*) from conversations where channel_id = '${fb}'`)).toBe(1);
    expect(count(`select count(*) from leads where source = 'facebook' and org_id = '${org}'`)).toBe(1);
    expect(count(`select count(*) from customers where org_id = '${org}' and full_name = 'Ana Gómez'`)).toBe(1);
    expect(count(`select count(*) from messages where conversation_id = '${convId(fb, PSID)}'`)).toBe(2);
    expect(sql(`select unread_count from conversations where id = '${convId(fb, PSID)}'`)).toBe('2');
  });
  it('Instagram tiene su propia conversación y toma el nombre de Meta', async () => {
    const r = await processMetaPayload(admin(), fbPayload('mid.ig1', 'Hola desde Instagram', IGSID, IG, 'instagram'), { fetchImpl });
    expect(r.messages).toBe(1);
    const conv = convId(ig, IGSID);
    expect(conv).toBeTruthy();
    expect(count(`select count(*) from customer_identifiers where type = 'instagram' and value = '${IGSID}'`)).toBe(1);
    expect(sql(`select c.full_name from customers c join conversations v on v.customer_id = c.id where v.id = '${conv}'`)).toBe('Ana G');
  });
  it('lo que no es un mensaje del cliente se ignora sin error: cuenta desconocida, ecos, WhatsApp', async () => {
    const before = count('select count(*) from messages');
    expect((await processMetaPayload(admin(), fbPayload('mid.x', 'hola', PSID, '100000000009999'), { fetchImpl }))).toMatchObject({ messages: 0, ignored: 1, retry: false });
    const echo = { object: 'page', entry: [{ id: PAGE, messaging: [{ sender: { id: PSID }, recipient: { id: PAGE }, timestamp: 1, message: { mid: 'e', text: 'x', is_echo: true } }] }] };
    expect((await processMetaPayload(admin(), echo, { fetchImpl })).messages).toBe(0);
    expect(count('select count(*) from messages')).toBe(before);
  });
  it('un mensaje recibido demuestra que el webhook llega: «Webhook no configurado» pasa a «Conectado»', async () => {
    await admin().rpc('record_channel_health', { p_channel: fb, p_state: 'webhook_missing', p_code: 'no_webhook', p_detail: 'x' });
    sql(`update channels set last_webhook_at = null where id = '${fb}'`);
    await processMetaPayload(admin(), fbPayload('mid.3', 'sigo aquí'), { fetchImpl });
    expect(sql(`select connection_status from channels where id = '${fb}'`)).toBe('connected');
  });
});

describe('responder por Messenger', () => {
  let fb = '', conv = '';
  beforeAll(() => { fb = chanId('facebook', PAGE); conv = convId(fb, PSID); });
  const social = (r: unknown) => vi.fn(async () => r as never);

  it('se envía con el token de la página, queda «enviado» y luego «entregado» por el webhook', async () => {
    const id = await repo.queueMessage(a, conv, 'Hola Ana, con gusto');
    const send = vi.fn(async (i: { token: string; to: string; body: string }) => ({ ok: true as const, externalId: 'mid.out.1', _i: i }));
    expect(await deliverMessage(admin(), id, undefined, { social: send as never })).toBe('sent');
    expect(send.mock.calls[0]![0]).toMatchObject({ token: PAGE_TOKEN, to: PSID, body: 'Hola Ana, con gusto' });
    expect(sql(`select status from messages where id = '${id}'`)).toBe('sent');
    const delivery = { object: 'page', entry: [{ id: PAGE, messaging: [{ sender: { id: PSID }, recipient: { id: PAGE }, timestamp: Date.now(), delivery: { mids: ['mid.out.1'], watermark: 1 } }] }] };
    expect((await processMetaPayload(admin(), delivery, { fetchImpl })).statuses).toBe(1);
    expect(sql(`select status from messages where id = '${id}'`)).toBe('delivered');
  });
  it('token vencido al enviar: el mensaje falla y la CONEXIÓN pasa a «Token expirado»; un envío bueno la recupera', async () => {
    const id = await repo.queueMessage(a, conv, 'Segundo');
    expect(await deliverMessage(admin(), id, undefined, { social: social({ ok: false, definitive: true, code: '190', message: 'venció' }) })).toBe('failed');
    expect(sql(`select connection_status from channels where id = '${fb}'`)).toBe('token_expired');
    const id2 = await repo.queueMessage(a, conv, 'Tercero');
    expect(await deliverMessage(admin(), id2, undefined, { social: social({ ok: true, externalId: 'mid.out.3' }) })).toBe('sent');
    expect(sql(`select connection_status from channels where id = '${fb}'`)).toBe('connected');
  });
  it('«fuera de la ventana de 24 h» rechaza el mensaje pero NO marca la conexión como caída', async () => {
    const id = await repo.queueMessage(a, conv, 'Cuarto');
    await deliverMessage(admin(), id, undefined, { social: social({ ok: false, definitive: true, code: '10', subcode: '2018278', message: 'fuera de ventana' }) });
    expect(sql(`select status from messages where id = '${id}'`)).toBe('failed');
    expect(sql(`select connection_status from channels where id = '${fb}'`)).toBe('connected');
  });
  it('resultado desconocido (red) no se reintenta solo: se queda «enviando»', async () => {
    const id = await repo.queueMessage(a, conv, 'Quinto');
    expect(await deliverMessage(admin(), id, undefined, { social: social({ ok: false, definitive: false, message: 'sin respuesta' }) })).toBe('unknown');
    expect(sql(`select status from messages where id = '${id}'`)).toBe('sending');
  });
  it('pasadas 24 h del último mensaje del cliente, no se puede escribir texto libre', async () => {
    sql(`update conversations set last_inbound_at = now() - interval '25 hours' where id = '${conv}'`);
    const e = await rejects(repo.queueMessage(a, conv, 'Tarde'));
    expect(toUserMessage(e)).toMatch(/24 horas/);
    sql(`update conversations set last_inbound_at = now() where id = '${conv}'`);
  });
});

describe('Gmail', () => {
  let ch = '';
  const login = () => completeGoogleLogin(a, admin(), { code: 'GCODE', redirectUri: 'https://crm.test/api/connections/google/callback', orgId: org }, deps);

  beforeAll(async () => {
    await customers.createCustomer(a, org, 'person', 'Cliente Existente', [{ type: 'email', value: 'cliente@ejemplo.com' }], {});
    deliver(mail('a0b1c2d3e4f50001', { from: 'Cliente Existente <Cliente@Ejemplo.com>', subject: 'Cotización Wallpanel', body: 'Necesito 40 m2 de Wallpanel.\n\nGracias' }));
    deliver(mail('a0b1c2d3e4f50002', { from: 'Ofertas <promo@tienda.com>', subject: '50% de descuento', body: 'compra ya', labels: ['INBOX', 'CATEGORY_PROMOTIONS'] }));
    deliver(mail('a0b1c2d3e4f50003', { from: 'Banco <noreply@banco.com>', subject: 'Tu estado de cuenta', body: 'adjunto' }));
    deliver(mail('a0b1c2d3e4f50004', { from: 'Nuevo Contacto <nuevo@empresa.com>', subject: 'Consulta de precios', body: 'Hola, ¿precio del Arkodeck?' }));
  });

  it('sin todos los permisos, o sin acceso permanente, se explica qué hacer y no se guarda nada', async () => {
    gm.scope = 'openid email https://www.googleapis.com/auth/gmail.readonly';
    expect(toUserMessage(await rejects(login()))).toMatch(/Faltan permisos/);
    gm.scope = 'openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send'; gm.refresh = undefined;
    expect(toUserMessage(await rejects(login()))).toMatch(/acceso permanente/);
    gm.refresh = REFRESH;
    expect(count(`select count(*) from channels where kind = 'gmail' and org_id = '${org}'`)).toBe(0);
    expect(toUserMessage(await rejects(completeGoogleLogin(a, admin(), { code: 'x', redirectUri: 'x', orgId: org }, { fetchImpl, env: {} as never })))).toMatch(/GOOGLE_CLIENT_ID/);
  });
  it('conecta la cuenta, guarda el acceso sin exponerlo y trae solo los correos relevantes, unidos al cliente por su correo', async () => {
    const r = await login();
    ch = r.channelId;
    expect(r).toMatchObject({ email: 'ventas@arkos.co', synced: 2, outcome: { state: 'connected' } });
    const c = (await repo.listChannels(a, org)).find((x) => x.id === ch)!;
    expect(c).toMatchObject({ kind: 'gmail', externalId: 'ventas@arkos.co', connectionStatus: 'connected' });
    expect(JSON.stringify(c)).not.toContain(REFRESH);
    expect((await admin().rpc('channel_credentials', { p_channel: ch })).data).toBe(REFRESH);
    expect(c.metadata.history_id).toBe(String(historyId));
    // relevantes: el cliente conocido y la persona nueva; NO promoción ni noreply
    expect(count(`select count(*) from conversations where channel_id = '${ch}'`)).toBe(2);
    expect(count(`select count(*) from customers where org_id = '${org}' and full_name = 'Cliente Existente'`)).toBe(1);    // no se duplicó
    const known = convId(ch, 'cliente@ejemplo.com');
    expect(sql(`select c.full_name from customers c join conversations v on v.customer_id = c.id where v.id = '${known}'`)).toBe('Cliente Existente');
    expect(sql(`select body from messages where conversation_id = '${known}'`)).toBe('Cotización Wallpanel\n\nNecesito 40 m2 de Wallpanel.\n\nGracias');
    expect(count(`select count(*) from customer_identifiers where type = 'email' and value = 'nuevo@empresa.com'`)).toBe(1);
    expect(gm.auth.every((h) => h === 'Bearer ya29.first' || h === 'Bearer ya29.fresh')).toBe(true);
  });
  it('sincronizar de nuevo no duplica; un correo nuevo se une a la misma conversación (por el historial)', async () => {
    expect((await syncGmail(admin(), ch, deps)).ingested).toBe(0);
    deliver(mail('a0b1c2d3e4f50005', { from: 'Cliente Existente <cliente@ejemplo.com>', subject: 'Re: Cotización Wallpanel', body: 'Sí, me sirve.\n\nEl sáb, Arkos <ventas@arkos.co> escribió:\n> propuesta' }));
    expect(await syncGmail(admin(), ch, deps)).toMatchObject({ ingested: 1, note: null });
    expect(count(`select count(*) from conversations where channel_id = '${ch}'`)).toBe(2);
    expect(count(`select count(*) from messages where conversation_id = '${convId(ch, 'cliente@ejemplo.com')}'`)).toBe(2);
    expect(sql(`select body from messages where external_id = 'a0b1c2d3e4f50005'`)).toBe('Re: Cotización Wallpanel\n\nSí, me sirve.');    // sin la cita
  });
  it('si el historial de Gmail ya no existe, vuelve a leer la bandeja sin duplicar nada', async () => {
    gm.historyGone = true;
    deliver(mail('a0b1c2d3e4f50006', { from: 'Cliente Existente <cliente@ejemplo.com>', subject: 'Re: Cotización Wallpanel', body: 'Una consulta más' }));
    expect((await syncGmail(admin(), ch, deps)).ingested).toBe(1);
    gm.historyGone = false;
    expect(count(`select count(*) from messages where conversation_id = '${convId(ch, 'cliente@ejemplo.com')}'`)).toBe(3);
  });
  it('si un correo falla a medias, NO se avanza el punto de lectura: el siguiente intento lo recupera', async () => {
    const before = sql(`select metadata ->> 'history_id' from channels where id = '${ch}'`);
    deliver(mail('a0b1c2d3e4f50007', { from: 'Cliente Existente <cliente@ejemplo.com>', subject: 'Re: Cotización Wallpanel', body: 'Se me pasó esto' }));
    gm.failIds.add('a0b1c2d3e4f50007');
    expect(await syncGmail(admin(), ch, deps)).toMatchObject({ ingested: 0, note: 'partial' });
    expect(sql(`select metadata ->> 'history_id' from channels where id = '${ch}'`)).toBe(before);
    gm.failIds.clear();
    expect((await syncGmail(admin(), ch, deps)).ingested).toBe(1);
  });
  it('responder: llega al correo del cliente, en su hilo, con «Re:» y las cabeceras de respuesta al ÚLTIMO mensaje', async () => {
    const conv = convId(ch, 'cliente@ejemplo.com');
    const id = await repo.queueMessage(a, conv, 'Hola, le enviamos la cotización adjunta.');
    const email = (i: Parameters<typeof sendGmailReply>[0]) => sendGmailReply({ ...i, fetchImpl });
    expect(await deliverMessage(admin(), id, undefined, { email, env: ENV })).toBe('sent');
    const sent = gm.sent.at(-1)!;
    const raw = Buffer.from(sent.raw, 'base64url').toString('utf8');
    expect(raw).toContain('To: cliente@ejemplo.com'); expect(raw).toContain('From: ventas@arkos.co');
    expect(raw).toContain('In-Reply-To: <mid-a0b1c2d3e4f50007@mail.gmail.com>');
    expect(raw).toContain(`Subject: Re: Cotización Wallpanel`.includes('ó') ? `=?UTF-8?B?${Buffer.from('Re: Cotización Wallpanel').toString('base64')}?=` : 'Subject: Re: Cotización Wallpanel');
    expect(sent.threadId).toBe('t-a0b1c2d3e4f50007');
    expect(sql(`select status || ':' || external_id from messages where id = '${id}'`)).toBe('sent:sent-1');
  });
  it('acceso revocado en Google: enviar falla con un mensaje claro y la conexión pasa a «Token expirado»; al volver a autorizar se recupera', async () => {
    gm.revoked = true;
    const id = await repo.queueMessage(a, convId(ch, 'cliente@ejemplo.com'), 'Otro mensaje');
    const email = (i: Parameters<typeof sendGmailReply>[0]) => sendGmailReply({ ...i, fetchImpl });
    expect(await deliverMessage(admin(), id, undefined, { email, env: ENV })).toBe('failed');
    expect(sql(`select error from messages where id = '${id}'`)).toMatch(/requiere autorización nuevamente/);
    expect(sql(`select connection_status from channels where id = '${ch}'`)).toBe('token_expired');
    expect((await syncGmail(admin(), ch, deps)).note).toBe('invalid_grant');
    expect((await verifyChannel(admin(), ch, deps)).state).toBe('token_expired');
    gm.revoked = false;
    expect((await verifyChannel(admin(), ch, deps)).state).toBe('connected');
  });
  it('la cuenta autorizada debe ser la conectada; sin credenciales de Google en el servidor se avisa', async () => {
    gm.email = 'otra@arkos.co';
    const r = await verifyChannel(admin(), ch, deps);
    expect(r.state).toBe('error');
    expect(sql(`select last_error_code from channels where id = '${ch}'`)).toBe('account_mismatch');
    gm.email = 'ventas@arkos.co';
    expect((await verifyChannel(admin(), ch, { fetchImpl, env: {} as never })).state).toBe('error');
    expect(sql(`select last_error_code from channels where id = '${ch}'`)).toBe('not_configured');
    expect((await verifyChannel(admin(), ch, deps)).state).toBe('connected');
  });
  it('el barrido periódico sincroniza las cuentas de Gmail conectadas', async () => {
    deliver(mail('a0b1c2d3e4f50008', { from: 'Nuevo Contacto <nuevo@empresa.com>', subject: 'Seguimiento', body: '¿Ya tienen precio?' }));
    const r = await sweepGmail(admin(), deps);
    expect(r).toEqual({ synced: 1, ingested: 1 });
  });
  it('un vendedor no ve las credenciales ni el registro técnico de Gmail', async () => {
    expect(await repo.listConnectionEvents(s1, ch)).toEqual([]);
    expect(JSON.stringify(await repo.listChannels(s1, org))).not.toContain(REFRESH);
  });
  it('desconectar Gmail borra el acceso, detiene la sincronización y conserva los correos', async () => {
    const before = count(`select count(*) from messages where channel_id = '${ch}'`);
    await repo.disconnectChannel(a, ch);
    expect((await admin().rpc('channel_credentials', { p_channel: ch })).data).toBeNull();
    deliver(mail('a0b1c2d3e4f50009', { from: 'Nuevo Contacto <nuevo@empresa.com>', subject: 'Otro', body: 'hola' }));
    expect((await syncGmail(admin(), ch, deps)).note).toBe('disconnected');
    expect(count(`select count(*) from messages where channel_id = '${ch}'`)).toBe(before);
    expect((await sweepGmail(admin(), deps)).synced).toBe(0);
  });
});

/**
 * Integración Fase 5 contra PostgREST + Postgres reales: la RUTA REAL del webhook (firma, durabilidad, reintentos),
 * los repositorios/servicios reales con usuarios de JWT firmado, y el envío hacia un servidor Meta simulado que
 * verifica el formato exacto de la petición (URL, token, cuerpo). Nunca se contacta a Meta de verdad.
 */
import { createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';

vi.mock('server-only', () => ({}));

import type { ServerSupabase } from '@/lib/supabase/server';
import { DbError, toUserMessage } from '@/lib/errors';
import { signBody } from '@/lib/meta';
import { describeEvent } from '@/lib/timeline';
import { createOrganization } from '@/repositories/organizations';
import * as customers from '@/repositories/customers';
import * as repo from '@/repositories/inbox';
import * as inbox from '@/services/inbox';
import { createAdminClient } from '@/server/supabase-admin';
import { deliverMessage, sweepOutbound } from '@/server/outbound';
import { sweepWebhooks } from '@/server/inbound';

const REST_URL = process.env.REST_URL!;
const SECRET = process.env.JWT_SECRET!;
const DB = process.env.INT_DB!;

const A = 'aaaaaaaa-3333-0000-0000-00000000000a';
const S1 = '51000000-3333-0000-0000-000000000001';
const S2 = '52000000-3333-0000-0000-000000000002';
const PID = '109876543210';
const TOKEN = 'EAAB-token-secreto-abcdefghijklmnopqrstuvwxyz';
const APP_SECRET = 'app-secret-de-integracion-123';
const VERIFY = 'verify-token-de-integracion';
const CARLOS = '573001112233';

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
const rejects = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as Error & Partial<DbError>; } throw new Error('se esperaba un error y no ocurrió'); };

// ---- Meta simulado
const graph = { mode: 'ok' as 'ok' | 'window' | 'down', nextId: null as string | null, n: 0, requests: [] as { url: string; auth: string; body: Record<string, unknown> }[] };
let server: Server;

// ---- Payloads de Meta
const inboundPayload = (from: string, id: string, text: string, name = 'Carlos R.') => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'WABA', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp', metadata: { display_phone_number: '15550001111', phone_number_id: PID },
    contacts: [{ profile: { name }, wa_id: from }], messages: [{ from, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }],
  } }] }],
});
const statusPayload = (id: string, status: string) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'WABA', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp', metadata: { phone_number_id: PID }, statuses: [{ id, status, timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: CARLOS }],
  } }] }],
});
async function post(payload: unknown, o: { secret?: string | null; raw?: string; headers?: Record<string, string> } = {}) {
  const { POST } = await import('@/app/api/webhooks/meta/route');
  const body = o.raw ?? JSON.stringify(payload);
  const headers: Record<string, string> = { 'content-type': 'application/json', ...o.headers };
  if (o.secret !== null) headers['x-hub-signature-256'] = signBody(body, o.secret ?? APP_SECRET);
  return POST(new Request('http://localhost/api/webhooks/meta', { method: 'POST', headers, body }));
}
async function get(params: Record<string, string>) {
  const { GET } = await import('@/app/api/webhooks/meta/route');
  return GET(new Request(`http://localhost/api/webhooks/meta?${new URLSearchParams(params)}`));
}

const a = asUser(A), s1 = asUser(S1), s2 = asUser(S2);
let org = '', channel = '', convCarlos = '', tplId = '';
const admin = () => createAdminClient();

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      graph.requests.push({ url: req.url ?? '', auth: String(req.headers.authorization ?? ''), body: raw ? JSON.parse(raw) : {} });
      const send = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (graph.mode === 'down') return send(503, { error: { message: 'unavailable' } });
      if (graph.mode === 'window') return send(400, { error: { message: '(#131047) Re-engagement message', type: 'OAuthException', code: 131047 } });
      const id = graph.nextId ?? `wamid.OUT${++graph.n}`;
      graph.nextId = null;
      send(200, { messaging_product: 'whatsapp', contacts: [{ wa_id: CARLOS }], messages: [{ id }] });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  process.env.META_GRAPH_BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.NEXT_PUBLIC_SUPABASE_URL = REST_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY = jwt({ role: 'service_role' });
  process.env.META_APP_SECRET = APP_SECRET;
  process.env.META_VERIFY_TOKEN = VERIFY;

  for (const [id, email] of [[A, 'a@inbox.test'], [S1, 's1@inbox.test'], [S2, 's2@inbox.test']]) sql(`insert into auth.users (id, email) values ('${id}', '${email}')`);
  org = await createOrganization(a, 'Inbox Int', 'inbox-int');
  for (const [uid, role] of [[S1, 'sales_agent'], [S2, 'sales_agent']]) {
    sql(`insert into memberships (org_id, user_id, role_id) select '${org}', '${uid}', id from roles where key = '${role}' and org_id is null`);
  }
  const r = await customers.createCustomer(s1, org, 'person', 'Carlos Rodríguez', [{ type: 'phone', value: `+${CARLOS}` }], {});
  if (r.outcome !== 'created') throw new Error('setup');
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('canal y secretos', () => {
  it('el administrador conecta el número; el token queda guardado pero NADIE con sesión puede leerlo', async () => {
    channel = await inbox.createChannel(a, org, { name: 'Ventas', phoneNumberId: PID, displayPhone: '+57 300 000 0000', token: TOKEN });
    expect((await repo.channelTokenStatus(a, org)).get(channel)).toBe(true);
    const direct = await a.from('channel_secrets' as never).select('*');
    expect((direct as { error: { code?: string } | null }).error?.code).toBe('42501');
    const rpc = await a.rpc('channel_credentials', { p_channel: channel });
    expect((rpc as { error: { code?: string } | null }).error).not.toBeNull();
    expect(toUserMessage(await rejects(inbox.createChannel(s1, org, { name: 'X', phoneNumberId: '111111111' })))).toMatch(/permiso/i);
    await inbox.createTemplate(a, org, { channelId: channel, name: 'seguimiento_pedido', language: 'es', body: 'Hola {{1}}, seguimos con tu pedido {{2}}' });
    tplId = (await repo.listTemplates(a, org))[0]!.id;
  });
});

describe('webhook real: verificación y firma', () => {
  it('GET: responde el challenge solo con el token correcto', async () => {
    const ok = await get({ 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY, 'hub.challenge': '424242' });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('424242');
    expect((await get({ 'hub.mode': 'subscribe', 'hub.verify_token': 'otro', 'hub.challenge': '1' })).status).toBe(403);
  });
  it('POST sin firma, con firma ajena o con cuerpo alterado: 401 y NO se guarda nada', async () => {
    const before = sql('select count(*) from raw_events');
    const p = inboundPayload('573999000111', 'wamid.EVIL', 'hola');
    expect((await post(p, { secret: null })).status).toBe(401);
    expect((await post(p, { secret: 'otro-secreto-cualquiera-123' })).status).toBe(401);
    const good = JSON.stringify(p);
    const { POST } = await import('@/app/api/webhooks/meta/route');
    const tampered = await POST(new Request('http://localhost/x', { method: 'POST', headers: { 'x-hub-signature-256': signBody(good, APP_SECRET) }, body: good.replace('hola', 'chao') }));
    expect(tampered.status).toBe(401);
    expect(sql('select count(*) from raw_events')).toBe(before);
    expect(sql(`select count(*) from customers where full_name = 'Carlos R.' and org_id = '${org}' and id not in (select customer_id from customer_identifiers where value = '+${CARLOS}')`)).toBe('0');
    expect(sql(`select count(*) from messages where external_id = 'wamid.EVIL'`)).toBe('0');
  });
  it('sin App Secret configurado el sistema rechaza TODO (503), aunque venga «firmado»', async () => {
    const saved = process.env.META_APP_SECRET;
    delete process.env.META_APP_SECRET;
    try { expect((await post(inboundPayload(CARLOS, 'wamid.NOSECRET', 'x'), { secret: '' })).status).toBe(503); }
    finally { process.env.META_APP_SECRET = saved; }
    expect(sql(`select count(*) from messages where external_id = 'wamid.NOSECRET'`)).toBe('0');
  });
  it('cuerpo demasiado grande → 413; JSON inválido firmado → 400', async () => {
    expect((await post(null, { raw: 'x'.repeat(1024 * 1024 + 10) })).status).toBe(413);
    expect((await post(null, { raw: '{no es json' })).status).toBe(400);
  });
  it('payloads firmados pero raros nunca producen error 500 ni cambian datos', async () => {
    const before = sql('select count(*) from messages');
    for (const p of [{}, [], null, { object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: '999' }, messages: [{ id: 'x' }] } }] }] },
      { object: 'instagram', entry: [] }, { object: 'whatsapp_business_account', entry: 'x' }]) {
      const r = await post(p);
      expect(r.status).toBe(200);
    }
    expect(sql('select count(*) from messages')).toBe(before);
  });
});

describe('recepción de mensajes', () => {
  it('un contacto NUEVO crea cliente, lead y conversación; el reintento idéntico de Meta no duplica nada', async () => {
    const p = inboundPayload('573109998877', 'wamid.L1', 'Hola, ¿tienen sillas?', 'Laura Gómez');
    expect((await post(p)).status).toBe(200);
    expect((await post(p)).status).toBe(200);
    expect(sql(`select count(*) from customer_identifiers where value = '+573109998877'`)).toBe('1');
    expect(sql(`select count(*) from leads l join customer_identifiers i on i.customer_id = l.customer_id where i.value = '+573109998877' and l.source = 'whatsapp'`)).toBe('1');
    expect(sql(`select count(*) from messages where external_id = 'wamid.L1'`)).toBe('1');
    expect(sql(`select status from raw_events order by id desc limit 1`)).toBe('processed');
  });
  it('un cliente EXISTENTE se enlaza por su teléfono: la conversación queda a nombre de su dueño', async () => {
    expect((await post(inboundPayload(CARLOS, 'wamid.C1', 'Buenas tardes'))).status).toBe(200);
    const convs = await repo.listConversations(s1, { orgId: org, filter: 'reply' });
    expect(convs.items).toHaveLength(1);
    convCarlos = convs.items[0]!.id;
    expect(convs.items[0]).toMatchObject({ threadKey: CARLOS, unread: true, needsReply: true, lastMessagePreview: 'Buenas tardes', ownerId: S1 });
    expect(sql(`select count(*) from customers where org_id = '${org}' and full_name like 'Carlos%'`)).toBe('1');
  });
  it('visibilidad: el vendedor ve SOLO lo de su cliente; el otro vendedor, nada; el admin, todo', async () => {
    expect((await repo.listConversations(s2, { orgId: org, filter: 'open' })).items).toHaveLength(0);
    expect((await repo.listMessages(s2, convCarlos))).toHaveLength(0);
    expect((await repo.listConversations(a, { orgId: org, filter: 'open' })).items).toHaveLength(2);
    expect((await repo.listConversations(a, { orgId: org, filter: 'unassigned' })).items.map((c) => c.threadKey)).toEqual(['573109998877']);
    expect((await repo.listMessages(s1, convCarlos)).map((m) => m.body)).toEqual(['Buenas tardes']);
  });
  it('la línea de tiempo del cliente muestra que escribió por WhatsApp', async () => {
    const carlos = sql(`select customer_id from conversations where id = '${convCarlos}'`);
    const ev = await customers.timeline(s1, carlos, 20);
    expect(ev.map((e) => describeEvent(e, () => 'x').title)).toContain('Escribió por WhatsApp por primera vez');
  });
});

describe('envío real hacia Meta (simulado)', () => {
  it('el vendedor responde: se encola, se entrega con el formato exacto de la API y queda «enviado»', async () => {
    const id = await inbox.sendMessage(s1, { conversationId: convCarlos, body: '  Hola Carlos, ¿en qué te ayudo?  ' });
    expect((await repo.getMessageOutcome(s1, id))?.status).toBe('queued');
    expect(await deliverMessage(admin(), id)).toBe('sent');
    const req = graph.requests.at(-1)!;
    expect(req.url).toBe(`/v24.0/${PID}/messages`);
    expect(req.auth).toBe(`Bearer ${TOKEN}`);
    expect(req.body).toEqual({ messaging_product: 'whatsapp', recipient_type: 'individual', to: CARLOS, type: 'text', text: { preview_url: false, body: 'Hola Carlos, ¿en qué te ayudo?' } });
    expect(sql(`select status || '/' || external_id from messages where id = '${id}'`)).toMatch(/^sent\/wamid\.OUT\d+$/);
    expect(sql(`select needs_reply::text from conversations where id = '${convCarlos}'`)).toBe('false');
  });
  it('entregar dos veces el mismo mensaje NO lo envía dos veces', async () => {
    const id = await inbox.sendMessage(s1, { conversationId: convCarlos, body: 'un solo envío' });
    const before = graph.requests.length;
    expect(await deliverMessage(admin(), id)).toBe('sent');
    expect(await deliverMessage(admin(), id)).toBe('skipped');
    expect(graph.requests.length).toBe(before + 1);
  });
  it('8 entregas SIMULTÁNEAS del mismo mensaje: una sola llega a Meta', async () => {
    const id = await inbox.sendMessage(s1, { conversationId: convCarlos, body: 'carrera de entregas' });
    const before = graph.requests.length;
    const results = await Promise.all(Array.from({ length: 8 }, () => deliverMessage(admin(), id)));
    expect(results.filter((r) => r === 'sent')).toHaveLength(1);
    expect(results.filter((r) => r === 'skipped')).toHaveLength(7);
    expect(graph.requests.length).toBe(before + 1);
  });
  it('un rechazo definitivo de Meta (131047) queda «falló» con el motivo en español', async () => {
    graph.mode = 'window';
    const id = await inbox.sendMessage(s1, { conversationId: convCarlos, body: 'Meta dirá que no' });
    expect(await deliverMessage(admin(), id)).toBe('failed');
    graph.mode = 'ok';
    const out = await repo.getMessageOutcome(s1, id);
    expect(out?.status).toBe('failed');
    expect(out?.error).toMatch(/plantilla aprobada/);
  });
  it('resultado DESCONOCIDO (Meta caído): no se reenvía; el barrido lo marca «falló» y jamás duplica el mensaje', async () => {
    graph.mode = 'down';
    const id = await inbox.sendMessage(s1, { conversationId: convCarlos, body: 'no sabremos si salió' });
    expect(await deliverMessage(admin(), id)).toBe('unknown');
    graph.mode = 'ok';
    expect((await repo.getMessageOutcome(s1, id))?.status).toBe('sending');
    const before = graph.requests.length;
    sql(`update messages set created_at = now() - interval '10 minutes' where id = '${id}'`);
    const sw = await sweepOutbound(admin());
    expect(sw.expired).toBeGreaterThanOrEqual(1);
    expect(graph.requests.length).toBe(before);                          // NO se reenvió
    const out = await repo.getMessageOutcome(s1, id);
    expect(out?.status).toBe('failed');
    expect(out?.error).toMatch(/Revisa en WhatsApp/);
  });
  it('un mensaje que quedó encolado sin entregar lo recoge el barrido', async () => {
    const id = await inbox.sendMessage(s1, { conversationId: convCarlos, body: 'se cayó la petición antes de enviar' });
    sql(`update messages set created_at = now() - interval '2 minutes' where id = '${id}'`);
    const sw = await sweepOutbound(admin());
    expect(sw.retried).toBeGreaterThanOrEqual(1);
    expect((await repo.getMessageOutcome(s1, id))?.status).toBe('sent');
  });
  it('un vendedor NO puede escribir en la conversación de otro; el error sale en español', async () => {
    const e = await rejects(inbox.sendMessage(s2, { conversationId: convCarlos, body: 'intruso' }));
    expect(e.code).toBe('42501');
    expect(toUserMessage(e)).toMatch(/permiso/i);
  });
});

describe('estados de entrega (webhook)', () => {
  it('entregado y leído avanzan el estado; uno atrasado no lo retrocede', async () => {
    const wamid = sql(`select external_id from messages where body = 'un solo envío'`);
    expect((await post(statusPayload(wamid, 'delivered'))).status).toBe(200);
    expect(sql(`select status from messages where external_id = '${wamid}'`)).toBe('delivered');
    await post(statusPayload(wamid, 'read'));
    await post(statusPayload(wamid, 'sent'));
    expect(sql(`select status from messages where external_id = '${wamid}'`)).toBe('read');
  });
  it('CARRERA: el estado llega antes de que guardemos el id del envío → queda pendiente y el barrido lo aplica', async () => {
    expect((await post(statusPayload('wamid.RACE', 'delivered'))).status).toBe(200);
    expect(sql(`select status from raw_events order by id desc limit 1`)).toBe('pending');
    graph.nextId = 'wamid.RACE';
    const id = await inbox.sendMessage(s1, { conversationId: convCarlos, body: 'mensaje de la carrera' });
    expect(await deliverMessage(admin(), id)).toBe('sent');
    sql(`update raw_events set last_attempt_at = now() - interval '2 minutes' where status = 'pending'`);
    const sw = await sweepWebhooks(admin());
    expect(sw.retried).toBeGreaterThanOrEqual(1);
    expect((await repo.getMessageOutcome(s1, id))?.status).toBe('delivered');
    expect(sql(`select count(*) from raw_events where status = 'pending'`)).toBe('0');
  });
});

describe('ventana de 24 h, plantillas y «no contactar»', () => {
  it('fuera de las 24 h el texto libre se rechaza (en español) y la plantilla sale con el formato exacto', async () => {
    sql(`update conversations set last_inbound_at = now() - interval '25 hours' where id = '${convCarlos}'`);
    const e = await rejects(inbox.sendMessage(s1, { conversationId: convCarlos, body: '¿sigues ahí?' }));
    expect(toUserMessage(e)).toMatch(/24 horas/);
    const id = await inbox.sendTemplate(s1, { conversationId: convCarlos, templateId: tplId, params: ['Carlos', 'A-100'] });
    expect(await deliverMessage(admin(), id)).toBe('sent');
    expect(graph.requests.at(-1)!.body).toEqual({
      messaging_product: 'whatsapp', recipient_type: 'individual', to: CARLOS, type: 'template',
      template: { name: 'seguimiento_pedido', language: { code: 'es' }, components: [{ type: 'body', parameters: [{ type: 'text', text: 'Carlos' }, { type: 'text', text: 'A-100' }] }] },
    });
    expect(sql(`select body from messages where id = '${id}'`)).toBe('Hola Carlos, seguimos con tu pedido A-100');
  });
  it('el cliente escribe «STOP»: queda «no contactar»; ya no recibe plantillas, pero sí se le puede responder', async () => {
    expect((await post(inboundPayload(CARLOS, 'wamid.STOP', 'STOP'))).status).toBe(200);
    expect(sql(`select do_not_contact::text from customers where id = (select customer_id from conversations where id = '${convCarlos}')`)).toBe('true');
    const e = await rejects(inbox.sendTemplate(s1, { conversationId: convCarlos, templateId: tplId, params: ['Carlos', 'A-101'] }));
    expect(toUserMessage(e)).toMatch(/no ser contactado/);
    const id = await inbox.sendMessage(s1, { conversationId: convCarlos, body: 'Listo, no te escribiremos más.' });
    expect(await deliverMessage(admin(), id)).toBe('sent');
  });
  it('con el canal en pausa no se envía, pero los mensajes entrantes se siguen guardando', async () => {
    await repo.setChannelStatus(a, channel, 'paused');
    expect(toUserMessage(await rejects(inbox.sendMessage(s1, { conversationId: convCarlos, body: 'hola' })))).toMatch(/en pausa/);
    expect((await post(inboundPayload(CARLOS, 'wamid.PAUSED', 'sigo aquí'))).status).toBe(200);
    expect(sql(`select count(*) from messages where external_id = 'wamid.PAUSED'`)).toBe('1');
    await repo.setChannelStatus(a, channel, 'active');
  });
  it('cerrar y reabrir; un mensaje nuevo reabre solo', async () => {
    await repo.setConversationStatus(s1, convCarlos, 'closed');
    expect((await repo.getConversation(s1, convCarlos))?.status).toBe('closed');
    await post(inboundPayload(CARLOS, 'wamid.AGAIN', 'una duda más'));
    expect((await repo.getConversation(s1, convCarlos))?.status).toBe('open');
  });
});

describe('el token jamás se filtra', () => {
  it('no aparece en eventos, auditoría, webhooks ni mensajes; y todo lo enviado llevó el token por la cabecera correcta', () => {
    for (const t of ['domain_events', 'audit_logs', 'raw_events', 'messages', 'channels']) {
      expect(sql(`select count(*) from ${t} where ${t}::text like '%EAAB-token%'`)).toBe('0');
    }
    expect(graph.requests.every((r) => r.auth === `Bearer ${TOKEN}`)).toBe(true);
  });
});

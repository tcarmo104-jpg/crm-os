/**
 * Integración de adjuntos contra PostgREST + Postgres reales: recepción → registro → descarga verificada → almacén privado →
 * acceso con seguridad por organización. Meta, Google y el almacén son simulados (el almacén en memoria).
 */
import { createHash, createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';

vi.mock('server-only', () => ({}));

import type { ServerSupabase } from '@/lib/supabase/server';
import { createOrganization } from '@/repositories/organizations';
import * as customers from '@/repositories/customers';
import * as repo from '@/repositories/inbox';
import { syncGmail } from '@/server/connections';
import { processMetaPayload } from '@/server/inbound';
import { expireStoredAttachments, mediaAccessUrl, processAttachment, sweepAttachments, type MediaStore } from '@/server/media';
import { createAdminClient } from '@/server/supabase-admin';

const REST_URL = process.env.REST_URL!, SECRET = process.env.JWT_SECRET!, DB = process.env.INT_DB!;
const A = 'aaaaaaaa-d555-0000-0000-00000000000a', B = 'bbbbbbbb-d555-0000-0000-00000000000b', S1 = '51000000-d555-0000-0000-000000000001';
const WA_PID = '419876543210', WA_TOKEN = 'EAAWAtokenWAtokenWAtokenWAtoken0001', PAGE = '100000000000555', GMAIL = 'ventas.adj@arkos.co';
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (c: Record<string, unknown>) => { const h = b64({ alg: 'HS256', typ: 'JWT' }), p = b64({ ...c, exp: Math.floor(Date.now() / 1000) + 3600 }); return `${h}.${p}.${createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url')}`; };
const client = (t: string) => createClient(REST_URL, t, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${t}` } } }) as unknown as ServerSupabase;
const asUser = (uid: string) => client(jwt({ role: 'authenticated', sub: uid }));
const sql = (q: string) => execFileSync('psql', ['-X', '-tA', '-d', DB, '-c', q], { encoding: 'utf8' }).trim();
const a = asUser(A), b = asUser(B), s1 = asUser(S1);
const admin = () => createAdminClient();
let org = '';

// ------------------------------------------------------------------------------------------------ archivos de prueba
const pad = (x: Uint8Array, n = 200) => { const o = new Uint8Array(Math.max(n, x.length)); o.set(x); return o; };
const enc = (s: string) => new TextEncoder().encode(s);
const JPEG = pad(new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0x01, 0xe0, 0x02, 0x80, 3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]));   // 640 x 480
const PDF = pad(enc('%PDF-1.7\n1 0 obj<<>>endobj\n'));
const EXE = pad(new Uint8Array([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0]));
const OGG = pad(enc('OggS\x00\x02\x00\x00'));
const PNG = pad(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 100, 0, 0, 0, 50]));

// ------------------------------------------------------------------------------------------------ almacén en memoria
const files = new Map<string, { bytes: Uint8Array; mime: string }>();
const store: MediaStore = {
  put: async (p, bytes, mime) => { files.set(p, { bytes, mime }); },
  signedUrl: async (p, ttl, dl) => (files.has(p) ? `https://storage.test/${p}?ttl=${ttl}${dl ? `&download=${encodeURIComponent(dl)}` : ''}` : null),
  remove: async (ps) => { ps.forEach((p) => files.delete(p)); },
  head: async (p) => { const f = files.get(p); return f ? { size: f.bytes.length, head: f.bytes.slice(0, 4096) } : null; },
  get: async (p) => files.get(p)?.bytes ?? null,
  signedUploadUrl: async (p) => ({ token: 'tok', path: p }),
};

// ------------------------------------------------------------------------------------------------ Meta y Google simulados
type Route = { status?: number; body?: unknown; bytes?: Uint8Array; headers?: Record<string, string> } | 'network';
const net = { routes: new Map<string, Route>(), calls: [] as { method: string; url: string; auth: string | null }[] };
const res = (status: number, o: { body?: unknown; bytes?: Uint8Array; headers?: Record<string, string> }) => {
  const h = new Map(Object.entries(o.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  return { ok: status < 400, status, headers: { get: (k: string) => h.get(k.toLowerCase()) ?? null }, body: undefined,
    json: async () => o.body, arrayBuffer: async () => (o.bytes ?? new Uint8Array()).buffer.slice(0) };
};
const fetchImpl = (async (url: string, init?: RequestInit) => {
  const method = init?.method ?? 'GET';
  net.calls.push({ method, url, auth: ((init?.headers ?? {}) as Record<string, string>).Authorization ?? null });
  const u = new URL(url);
  const key = u.host === 'graph.facebook.com' ? `graph ${u.pathname.split('/').slice(2).join('/')}` : u.host === 'oauth2.googleapis.com' ? 'g-token' : u.host === 'gmail.googleapis.com' ? `gmail ${u.pathname.replace('/gmail/v1/users/me', '')}${u.search.includes('startHistoryId') ? '?h' : ''}` : `cdn ${url}`;
  const r = net.routes.get(key);
  if (r === 'network') throw new Error('ECONNRESET');
  if (!r) return res(404, { body: { error: { code: 100, message: `sin ruta ${key}` } } });
  return res(r.status ?? 200, r);
}) as unknown as typeof fetch;
const ENV = { GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'gsecret' } as unknown as NodeJS.ProcessEnv;
const deps = () => ({ store, fetchImpl, env: ENV });
const waInfo = (id: string, mime: string, url: string, size = 1000) => net.routes.set(`graph ${id}`, { body: { url, mime_type: mime, file_size: size, sha256: 'x' } });
const cdn = (url: string, bytes: Uint8Array, headers?: Record<string, string>) => net.routes.set(`cdn ${url}`, { bytes, headers });

const waPayload = (thread: string, wamid: string, msg: Record<string, unknown>, ts = Math.floor(Date.now() / 1000)) => ({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: {
  messaging_product: 'whatsapp', metadata: { phone_number_id: WA_PID }, contacts: [{ wa_id: thread, profile: { name: 'Cliente' } }],
  messages: [{ from: thread, id: wamid, timestamp: String(ts), ...msg }] } }] }] });
const T1 = '573001110091', T2 = '573001110092';
const att = (wamid: string) => JSON.parse(sql(`select coalesce(json_agg(row_to_json(t) order by position), '[]') from (select a.* from message_attachments a join messages m on m.id = a.message_id where m.external_id = '${wamid}') t`)) as Record<string, unknown>[];
const one = (wamid: string) => att(wamid)[0]!;
const run = async () => sweepAttachments(admin(), deps(), 10);

afterAll(() => { sql(`update channels set connection_status = 'disconnected' where org_id = '${org}' and kind = 'gmail'`); });   // no dejar cuentas «vivas» para otras pruebas

beforeAll(async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = REST_URL; process.env.SUPABASE_SERVICE_ROLE_KEY = jwt({ role: 'service_role' });
  for (const [id, email] of [[A, 'a@ad.test'], [B, 'b@ad.test'], [S1, 's1@ad.test']]) sql(`insert into auth.users (id, email) values ('${id}', '${email}')`);
  org = await createOrganization(a, 'Adjuntos Int', 'adjuntos-int'); await createOrganization(b, 'Otra Org Adj', 'otra-org-adj');
  sql(`insert into memberships (org_id, user_id, role_id) select '${org}', '${S1}', id from roles where key = 'sales_agent' and org_id is null`);
  await repo.createChannel(a, org, { name: 'Ventas WA', phoneNumberId: WA_PID, token: WA_TOKEN });
  await repo.connectChannel(a, org, { kind: 'facebook', name: 'Página', externalId: PAGE, token: 'EAAPAGEtokenPAGEtokenPAGEtoken0001' });
  await repo.connectChannel(a, org, { kind: 'gmail', name: GMAIL, externalId: GMAIL, token: '1//refresh-token-abcdefghijklmnopqrstuvwxyz' });
  await customers.createCustomer(s1, org, 'person', 'Cliente del vendedor', [{ type: 'phone', value: `+${T1}` }], {});
  await customers.createCustomer(a, org, 'person', 'Cliente del admin', [{ type: 'phone', value: `+${T2}` }], {});
}, 60_000);

describe('WhatsApp: recibir y guardar', () => {
  it('una imagen: se registra pendiente, se descarga con el token, se verifica y queda en el almacén privado', async () => {
    net.calls.length = 0;
    const r = await processMetaPayload(admin(), waPayload(T1, 'wamid.img1', { type: 'image', image: { id: '900000000001', mime_type: 'image/jpeg', caption: 'Mira' } }));
    expect(r).toMatchObject({ messages: 1, retry: false });
    expect(one('wamid.img1')).toMatchObject({ status: 'pending', kind: 'image', direction: 'inbound', storage_path: null });
    waInfo('900000000001', 'image/jpeg', 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1'); cdn('https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1', JPEG);
    expect(await run()).toEqual({ tried: 1, stored: 1 });
    const x = one('wamid.img1');
    expect(x).toMatchObject({ status: 'stored', kind: 'image', mime_type: 'image/jpeg', width: 640, height: 480, file_size: JPEG.length, file_name: 'imagen.jpg', error_code: null });
    expect(x.sha256).toBe(createHash('sha256').update(JPEG).digest('hex'));
    expect(x.storage_path).toBe(`${org}/${sql(`select conversation_id from messages where external_id = 'wamid.img1'`)}/${x.id}`);
    expect(files.get(x.storage_path as string)).toMatchObject({ mime: 'image/jpeg' });
    expect(net.calls.filter((c) => c.auth === `Bearer ${WA_TOKEN}`).map((c) => new URL(c.url).host)).toEqual(['graph.facebook.com', 'lookaside.fbsbx.com']);   // el token solo va a Meta
    expect(JSON.stringify(att('wamid.img1'))).not.toContain('EAAWA');
  });
  it('el mismo aviso repetido no duplica; si el adjunto se hubiera perdido, el reintento lo recupera', async () => {
    await processMetaPayload(admin(), waPayload(T1, 'wamid.img1', { type: 'image', image: { id: '900000000001', mime_type: 'image/jpeg' } }));
    expect(att('wamid.img1')).toHaveLength(1);
    sql(`delete from message_attachments where message_id = (select id from messages where external_id = 'wamid.img1')`);
    await processMetaPayload(admin(), waPayload(T1, 'wamid.img1', { type: 'image', image: { id: '900000000001', mime_type: 'image/jpeg' } }));
    expect(att('wamid.img1')).toHaveLength(1);
    expect(sql(`select count(*) from messages where external_id = 'wamid.img1'`)).toBe('1');
    await run();                                            // vuelve a quedar guardado
    expect(one('wamid.img1').status).toBe('stored');
  });
  it('documento con nombre malicioso: se guarda con el nombre LIMPIO; nota de voz OGG', async () => {
    await processMetaPayload(admin(), waPayload(T1, 'wamid.doc1', { type: 'document', document: { id: '900000000002', filename: '../../etc/<script>alert(1)</script>.pdf', mime_type: 'application/pdf' } }));
    await processMetaPayload(admin(), waPayload(T1, 'wamid.voz1', { type: 'audio', audio: { id: '900000000003', mime_type: 'audio/ogg; codecs=opus', voice: true } }));
    waInfo('900000000002', 'application/pdf', 'https://lookaside.fbsbx.com/d2'); cdn('https://lookaside.fbsbx.com/d2', PDF);
    waInfo('900000000003', 'audio/ogg; codecs=opus', 'https://lookaside.fbsbx.com/a3'); cdn('https://lookaside.fbsbx.com/a3', OGG);
    await run();
    expect(one('wamid.doc1')).toMatchObject({ status: 'stored', kind: 'document', mime_type: 'application/pdf' });
    expect(String(one('wamid.doc1').file_name)).not.toMatch(/[<>\/\\]/);
    expect(one('wamid.voz1')).toMatchObject({ status: 'stored', kind: 'audio', is_voice: true, mime_type: 'audio/ogg' });
  });
  it('ubicación y contacto: quedan guardados sin archivo, con sus datos', async () => {
    await processMetaPayload(admin(), waPayload(T1, 'wamid.loc1', { type: 'location', location: { latitude: 6.2442, longitude: -75.5812, name: 'Oficina' } }));
    expect(one('wamid.loc1')).toMatchObject({ kind: 'location', status: 'stored', storage_path: null, meta: { lat: 6.2442, lng: -75.5812, name: 'Oficina' } });
  });
});

describe('seguridad del contenido', () => {
  it('un ejecutable disfrazado de PDF se BLOQUEA y no se guarda nada', async () => {
    const before = files.size;
    await processMetaPayload(admin(), waPayload(T1, 'wamid.exe1', { type: 'document', document: { id: '900000000010', filename: 'factura.pdf', mime_type: 'application/pdf' } }));
    waInfo('900000000010', 'application/pdf', 'https://lookaside.fbsbx.com/e1'); cdn('https://lookaside.fbsbx.com/e1', EXE);
    await run();
    expect(one('wamid.exe1')).toMatchObject({ status: 'blocked', error_code: 'dangerous_file', storage_path: null });
    expect(files.size).toBe(before);
  });
  it('un tipo suplantado (dice JPG, es PDF) se rechaza; la doble extensión también', async () => {
    await processMetaPayload(admin(), waPayload(T1, 'wamid.mm1', { type: 'image', image: { id: '900000000011', mime_type: 'image/jpeg' } }));
    await processMetaPayload(admin(), waPayload(T1, 'wamid.dbl1', { type: 'document', document: { id: '900000000012', filename: 'plano.pdf.exe', mime_type: 'application/pdf' } }));
    waInfo('900000000011', 'image/jpeg', 'https://lookaside.fbsbx.com/m1'); cdn('https://lookaside.fbsbx.com/m1', PDF);
    waInfo('900000000012', 'application/pdf', 'https://lookaside.fbsbx.com/d1'); cdn('https://lookaside.fbsbx.com/d1', PDF);
    await run();
    expect(one('wamid.mm1')).toMatchObject({ status: 'blocked', error_code: 'mime_mismatch' });
    expect(one('wamid.dbl1')).toMatchObject({ status: 'blocked', error_code: 'dangerous_file' });
  });
  it('un archivo demasiado grande no se guarda (por lo que declara Meta o por lo que llega)', async () => {
    await processMetaPayload(admin(), waPayload(T1, 'wamid.big1', { type: 'video', video: { id: '900000000013', mime_type: 'video/mp4' } }));
    await processMetaPayload(admin(), waPayload(T1, 'wamid.big2', { type: 'video', video: { id: '900000000014', mime_type: 'video/mp4' } }));
    waInfo('900000000013', 'video/mp4', 'https://lookaside.fbsbx.com/b1', 101 * 1024 * 1024);
    waInfo('900000000014', 'video/mp4', 'https://lookaside.fbsbx.com/b2'); cdn('https://lookaside.fbsbx.com/b2', pad(new Uint8Array(), 10), { 'content-length': String(101 * 1024 * 1024) });
    await run();
    expect(one('wamid.big1')).toMatchObject({ status: 'failed', error_code: 'too_large' });
    expect(one('wamid.big2')).toMatchObject({ status: 'failed', error_code: 'too_large' });
  });
});

describe('fallos y reintentos', () => {
  it('archivo caducado en Meta: «expirado» sin reintentos inútiles', async () => {
    await processMetaPayload(admin(), waPayload(T1, 'wamid.exp1', { type: 'image', image: { id: '900000000020', mime_type: 'image/jpeg' } }));
    net.routes.set('graph 900000000020', { status: 400, body: { error: { code: 100, error_subcode: 33, message: 'Unsupported get request. Object with ID does not exist' } } });
    await run();
    expect(one('wamid.exp1')).toMatchObject({ status: 'expired', error_code: 'expired_at_channel', attempts: 1 });
  });
  it('un fallo de red se reintenta con espera creciente y al volver la red se guarda; tras 6 intentos se rinde', async () => {
    await processMetaPayload(admin(), waPayload(T1, 'wamid.net1', { type: 'image', image: { id: '900000000021', mime_type: 'image/jpeg' } }));
    net.routes.set('graph 900000000021', 'network');
    await run();
    expect(one('wamid.net1')).toMatchObject({ status: 'pending', attempts: 1, error_code: 'transient' });
    expect(Date.parse(String(one('wamid.net1').next_attempt_at))).toBeGreaterThan(Date.now() + 20_000);
    expect(await run()).toEqual({ tried: 0, stored: 0 });                                  // todavía no toca
    sql(`update message_attachments set next_attempt_at = now() where id = '${one('wamid.net1').id}'`);
    waInfo('900000000021', 'image/jpeg', 'https://lookaside.fbsbx.com/n1'); cdn('https://lookaside.fbsbx.com/n1', JPEG);
    await run();
    expect(one('wamid.net1')).toMatchObject({ status: 'stored', attempts: 2, error_code: null });
    await processMetaPayload(admin(), waPayload(T1, 'wamid.net2', { type: 'image', image: { id: '900000000022', mime_type: 'image/jpeg' } }));
    net.routes.set('graph 900000000022', 'network');
    for (let i = 0; i < 6; i++) { sql(`update message_attachments set next_attempt_at = now() where id = '${one('wamid.net2').id}'`); await run(); }
    expect(one('wamid.net2')).toMatchObject({ status: 'failed', attempts: 6 });
  });
  it('un archivo de WhatsApp con más de 7 días que sigue sin bajar se da por expirado', async () => {
    await processMetaPayload(admin(), waPayload(T1, 'wamid.old1', { type: 'image', image: { id: '900000000023', mime_type: 'image/jpeg' } }, Math.floor(Date.now() / 1000) - 8 * 86400));
    net.routes.set('graph 900000000023', 'network');
    await run();
    expect(one('wamid.old1')).toMatchObject({ status: 'expired', error_code: 'expired_at_channel' });
  });
  it('dos procesos a la vez: solo uno descarga', async () => {
    await processMetaPayload(admin(), waPayload(T1, 'wamid.par1', { type: 'image', image: { id: '900000000024', mime_type: 'image/jpeg' } }));
    waInfo('900000000024', 'image/jpeg', 'https://lookaside.fbsbx.com/p1'); cdn('https://lookaside.fbsbx.com/p1', JPEG);
    const id = String(one('wamid.par1').id);
    const outs = await Promise.all([processAttachment(admin(), id, deps()), processAttachment(admin(), id, deps())]);
    expect(outs.sort()).toEqual(['skipped', 'stored']);
  });
});

describe('Messenger / Instagram: solo se descarga de Meta', () => {
  const fbPayload = (mid: string, attachments: unknown[]) => ({ object: 'page', entry: [{ id: PAGE, messaging: [{ sender: { id: '5500000000000555' }, recipient: { id: PAGE }, timestamp: Date.now(), message: { mid, attachments } }] }] });
  it('una imagen de la página se guarda; un enlace a una dirección interna NUNCA se visita', async () => {
    net.calls.length = 0;
    await processMetaPayload(admin(), fbPayload('mid.fb1', [{ type: 'image', payload: { url: 'https://scontent.xx.fbcdn.net/v/a.jpg?sig=1' } }]), { fetchImpl });
    cdn('https://scontent.xx.fbcdn.net/v/a.jpg?sig=1', PNG);
    await processMetaPayload(admin(), fbPayload('mid.fb2', [{ type: 'image', payload: { url: 'https://169.254.169.254/latest/meta-data' } }]), { fetchImpl });
    await run();
    expect(one('mid.fb1')).toMatchObject({ status: 'stored', kind: 'image', mime_type: 'image/png', width: 100, height: 50 });
    expect(one('mid.fb2')).toMatchObject({ status: 'failed', error_code: 'bad_source' });   // dirección que no es de Meta: se rechaza SIN visitarla
    expect(net.calls.some((c) => c.url.includes('169.254'))).toBe(false);
    expect(net.calls.find((c) => c.url.includes('fbcdn'))!.auth).toBeNull();                 // ninguna credencial viaja a la CDN
  });
  it('una redirección a otro dominio se rechaza; dentro de Meta se sigue', async () => {
    await processMetaPayload(admin(), fbPayload('mid.fb3', [{ type: 'image', payload: { url: 'https://scontent.xx.fbcdn.net/redir-malo' } }]), { fetchImpl });
    await processMetaPayload(admin(), fbPayload('mid.fb4', [{ type: 'image', payload: { url: 'https://scontent.xx.fbcdn.net/redir-bueno' } }]), { fetchImpl });
    net.routes.set('cdn https://scontent.xx.fbcdn.net/redir-malo', { status: 302, headers: { location: 'http://10.0.0.5/secreto' } });
    net.routes.set('cdn https://scontent.xx.fbcdn.net/redir-bueno', { status: 302, headers: { location: 'https://scontent-mad1-1.xx.fbcdn.net/final.jpg' } });
    cdn('https://scontent-mad1-1.xx.fbcdn.net/final.jpg', JPEG);
    net.calls.length = 0;
    await run();
    expect(one('mid.fb3')).toMatchObject({ status: 'failed', error_code: 'bad_source' });
    expect(one('mid.fb4')).toMatchObject({ status: 'stored', kind: 'image' });
    expect(net.calls.some((c) => c.url.includes('10.0.0.5'))).toBe(false);
  });
  it('un enlace caducado (403/404) queda «expirado»', async () => {
    await processMetaPayload(admin(), fbPayload('mid.fb5', [{ type: 'video', payload: { url: 'https://video.xx.fbcdn.net/v.mp4' } }]), { fetchImpl });
    net.routes.set('cdn https://video.xx.fbcdn.net/v.mp4', { status: 403 });
    await run();
    expect(one('mid.fb5')).toMatchObject({ status: 'expired' });
  });
});

describe('Gmail: adjuntos', () => {
  const mail = (id: string, files: { name: string; mime: string; att: string }[]) => ({ id, threadId: `t-${id}`, labelIds: ['INBOX'], internalDate: String(Date.now() - 60_000), payload: { mimeType: 'multipart/mixed',
    headers: [{ name: 'From', value: 'Ana <ana@ejemplo.com>' }, { name: 'Subject', value: 'Planos' }, { name: 'Message-ID', value: `<${id}@x>` }],
    parts: [{ mimeType: 'text/plain', body: { data: Buffer.from('Adjunto planos', 'utf8').toString('base64url') } }, ...files.map((f) => ({ mimeType: f.mime, filename: f.name, body: { attachmentId: f.att, size: 1000 } }))] } });
  it('un correo con varios adjuntos: se registran todos, se descargan y el .exe se bloquea', async () => {
    const chId = sql(`select id from channels where kind = 'gmail' and external_id = '${GMAIL}'`);
    net.routes.set('g-token', { body: { access_token: 'ya29.x' } });
    net.routes.set('gmail /profile', { body: { emailAddress: GMAIL, historyId: '500' } });
    net.routes.set('gmail /messages', { body: { messages: [{ id: 'a0b1c2d3e4f50101' }] } });
    net.routes.set('gmail /messages/a0b1c2d3e4f50101', { body: mail('a0b1c2d3e4f50101', [{ name: 'plano.pdf', mime: 'application/pdf', att: 'ATTPDF1' }, { name: 'foto.png', mime: 'image/png', att: 'ATTPNG1' }, { name: 'nota.txt', mime: 'application/pdf', att: 'ATTEXE1' }]) });
    net.routes.set('gmail /messages/a0b1c2d3e4f50101/attachments/ATTPDF1', { body: { data: Buffer.from(PDF).toString('base64url'), size: PDF.length } });
    net.routes.set('gmail /messages/a0b1c2d3e4f50101/attachments/ATTPNG1', { body: { data: Buffer.from(PNG).toString('base64url'), size: PNG.length } });
    net.routes.set('gmail /messages/a0b1c2d3e4f50101/attachments/ATTEXE1', { body: { data: Buffer.from(EXE).toString('base64url'), size: EXE.length } });
    expect((await syncGmail(admin(), chId, { fetchImpl, env: ENV })).ingested).toBe(1);
    expect(att('a0b1c2d3e4f50101').map((x) => `${x.file_name}:${x.status}`)).toEqual(['plano.pdf:pending', 'foto.png:pending', 'nota.txt:pending']);
    await syncGmail(admin(), chId, { fetchImpl, env: ENV });                                // de nuevo: sin duplicar
    expect(att('a0b1c2d3e4f50101')).toHaveLength(3);
    await run();
    const got = Object.fromEntries(att('a0b1c2d3e4f50101').map((x) => [x.file_name, x]));
    expect(got['plano.pdf']).toMatchObject({ status: 'stored', kind: 'document', mime_type: 'application/pdf', file_name: 'plano.pdf' });
    expect(got['foto.png']).toMatchObject({ status: 'stored', kind: 'image', width: 100, height: 50 });
    expect(got['nota.txt']).toMatchObject({ status: 'blocked', error_code: 'dangerous_file' });
  });
  it('acceso revocado en Google: el adjunto se reintenta (no se pierde) y no se guarda nada', async () => {
    const chId = sql(`select id from channels where kind = 'gmail' and external_id = '${GMAIL}'`);
    net.routes.set('gmail /messages', { body: { messages: [{ id: 'a0b1c2d3e4f50102' }] } });
    net.routes.set('gmail /messages/a0b1c2d3e4f50102', { body: mail('a0b1c2d3e4f50102', [{ name: 'contrato.pdf', mime: 'application/pdf', att: 'ATTPDF2' }]) });
    sql(`update channels set metadata = metadata - 'history_id' where id = '${chId}'`);
    await syncGmail(admin(), chId, { fetchImpl, env: ENV });
    net.routes.set('g-token', { status: 400, body: { error: 'invalid_grant' } });
    await run();
    expect(one('a0b1c2d3e4f50102')).toMatchObject({ status: 'pending', error_code: 'auth' });
    net.routes.set('g-token', { body: { access_token: 'ya29.y' } });
    net.routes.set('gmail /messages/a0b1c2d3e4f50102/attachments/ATTPDF2', { body: { data: Buffer.from(PDF).toString('base64url') } });
    sql(`update message_attachments set next_attempt_at = now() where id = '${one('a0b1c2d3e4f50102').id}'`);
    await run();
    expect(one('a0b1c2d3e4f50102').status).toBe('stored');
  });
});

describe('acceso a los archivos', () => {
  let mine = '', theirs = '';
  beforeAll(() => {
    mine = String(one('wamid.img1').id);                                                    // conversación del vendedor
    processMetaPayload(admin(), waPayload(T2, 'wamid.adm1', { type: 'image', image: { id: '900000000030', mime_type: 'image/jpeg' } }));
  });
  it('el dueño ve su archivo con un enlace de vida corta; con «descargar» lleva el nombre limpio', async () => {
    const r = await mediaAccessUrl(s1, store, mine);
    expect(r).toMatchObject({ ok: true }); expect((r as { url: string }).url).toMatch(/ttl=120$/);
    const d = await mediaAccessUrl(a, store, mine, { download: true, ttlSeconds: 60 });
    expect((d as { url: string }).url).toMatch(/ttl=60&download=imagen\.jpg$/);
  });
  it('el administrador ve todo; el vendedor NO ve el archivo de una conversación ajena; otra organización tampoco', async () => {
    waInfo('900000000030', 'image/jpeg', 'https://lookaside.fbsbx.com/x30'); cdn('https://lookaside.fbsbx.com/x30', JPEG);
    await processMetaPayload(admin(), waPayload(T2, 'wamid.adm1', { type: 'image', image: { id: '900000000030', mime_type: 'image/jpeg' } }));
    await run();
    theirs = String(one('wamid.adm1').id);
    expect(one('wamid.adm1').status).toBe('stored');
    expect(await mediaAccessUrl(a, store, theirs)).toMatchObject({ ok: true });
    expect(await mediaAccessUrl(s1, store, theirs)).toEqual({ ok: false, reason: 'not_found' });
    expect(await mediaAccessUrl(b, store, mine)).toEqual({ ok: false, reason: 'not_found' });
    expect(await mediaAccessUrl(b, store, theirs)).toEqual({ ok: false, reason: 'not_found' });
    expect(await mediaAccessUrl(a, store, 'no-es-uuid')).toEqual({ ok: false, reason: 'not_found' });
    expect(await mediaAccessUrl(a, store, '00000000-0000-4000-8000-000000000000')).toEqual({ ok: false, reason: 'not_found' });
  });
  it('pendiente, bloqueado o expirado: «no disponible» (nunca un enlace)', async () => {
    for (const w of ['wamid.exe1', 'wamid.exp1', 'wamid.loc1']) expect(await mediaAccessUrl(a, store, String(one(w).id))).toEqual({ ok: false, reason: 'unavailable' });
  });
  it('desde el navegador nadie escribe adjuntos, y un usuario ve solo los de su organización', async () => {
    expect((await a.from('message_attachments').update({ status: 'stored' }).eq('id', mine)).error).not.toBeNull();
    expect((await a.from('message_attachments').delete().eq('id', mine)).error).not.toBeNull();
    expect(((await b.from('message_attachments').select('id')).data ?? []).length).toBe(0);
    expect((((await s1.from('message_attachments').select('id, storage_path')).data ?? []) as { id: string }[]).some((r) => r.id === theirs)).toBe(false);
  });
});

describe('conservación de 12 meses', () => {
  it('vencido el plazo se borra el archivo del almacén y el adjunto queda «expirado»; el mensaje se conserva', async () => {
    const x = one('wamid.doc1'); const path = String(x.storage_path);
    expect(files.has(path)).toBe(true);
    sql(`update message_attachments set expires_at = now() - interval '1 day' where id = '${x.id}'`);
    expect(await expireStoredAttachments(admin(), store)).toBeGreaterThanOrEqual(1);
    expect(files.has(path)).toBe(false);
    expect(one('wamid.doc1')).toMatchObject({ status: 'expired', storage_path: null, error_code: 'retention' });
    expect(sql(`select count(*) from messages where external_id = 'wamid.doc1'`)).toBe('1');
  });
});

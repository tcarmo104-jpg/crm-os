/**
 * Integración del ENVÍO de archivos contra PostgREST + Postgres reales: reservar → subir → verificar por contenido → encolar →
 * entregar por WhatsApp / Messenger / Gmail. Meta, Google y el almacén son simulados.
 */
import { createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';

vi.mock('server-only', () => ({}));

import type { ServerSupabase } from '@/lib/supabase/server';
import { UserFacingError, toUserMessage } from '@/lib/errors';
import { createOrganization } from '@/repositories/organizations';
import * as customers from '@/repositories/customers';
import * as repo from '@/repositories/inbox';
import { cancelUpload, mediaAccessUrl, prepareUpload, purgeStaleUploads, sendAttachments, type MediaStore } from '@/server/media';
import { processMetaPayload } from '@/server/inbound';
import { deliverMessage } from '@/server/outbound';
import { createAdminClient } from '@/server/supabase-admin';

const REST_URL = process.env.REST_URL!, SECRET = process.env.JWT_SECRET!, DB = process.env.INT_DB!;
const A = 'aaaaaaaa-d888-0000-0000-00000000000a', B = 'bbbbbbbb-d888-0000-0000-00000000000b', S1 = '51000000-d888-0000-0000-000000000001';
const WA_PID = '429876543210', PAGE = '100000000000666', GMAIL = 'ventas.out@arkos.co', PSID = '5500000000000666';
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (c: Record<string, unknown>) => { const h = b64({ alg: 'HS256', typ: 'JWT' }), p = b64({ ...c, exp: Math.floor(Date.now() / 1000) + 3600 }); return `${h}.${p}.${createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url')}`; };
const client = (t: string) => createClient(REST_URL, t, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${t}` } } }) as unknown as ServerSupabase;
const asUser = (uid: string) => client(jwt({ role: 'authenticated', sub: uid }));
const sql = (q: string) => execFileSync('psql', ['-X', '-tA', '-d', DB, '-c', q], { encoding: 'utf8' }).trim();
const a = asUser(A), b = asUser(B), s1 = asUser(S1);
const admin = () => createAdminClient();
let org = '';
const rejects = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as Error & { code?: string }; } throw new Error('se esperaba un error'); };

// ------------------------------------------------------------------------------------------------ archivos y almacén
const pad = (x: Uint8Array, n = 300) => { const o = new Uint8Array(Math.max(n, x.length)); o.set(x); return o; };
const enc = (s: string) => new TextEncoder().encode(s);
const JPEG = pad(new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0x01, 0xe0, 0x02, 0x80, 3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]));
const PNG = pad(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 100, 0, 0, 0, 50]));
const PDF = pad(enc('%PDF-1.7\n1 0 obj<<>>endobj\n'));
const OGG = pad(enc('OggS\x00\x02\x00\x00'));
const EXE = pad(new Uint8Array([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0]));
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
const net = { calls: [] as { method: string; path: string; body: unknown; auth: string | null }[], n: 0, mediaFail: null as null | { status: number; code: number } };
const res = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
const fetchImpl = (async (url: string, init?: RequestInit) => {
  const u = new URL(url); const method = init?.method ?? 'GET';
  const path = u.host === 'graph.facebook.com' ? u.pathname.split('/').slice(2).join('/') : `${u.host}${u.pathname}`;
  net.calls.push({ method, path, body: init?.body, auth: ((init?.headers ?? {}) as Record<string, string>).Authorization ?? null });
  if (path === `${WA_PID}/media`) return net.mediaFail ? res(net.mediaFail.status, { error: { code: net.mediaFail.code, message: 'fallo simulado' } }) : res(200, { id: `MEDIA${++net.n}` });
  if (path === `${WA_PID}/messages`) return res(200, { messages: [{ id: `wamid.out.${++net.n}` }] });
  if (path === 'me/messages') return res(200, { recipient_id: PSID, message_id: `mid.out.${++net.n}` });
  if (u.host === 'oauth2.googleapis.com') return res(200, { access_token: 'ya29.x' });
  if (path === 'gmail.googleapis.com/upload/gmail/v1/users/me/messages/send') return res(200, { id: `gsent.${++net.n}` });
  return res(404, { error: { code: 100, message: `sin ruta ${path}` } });
}) as unknown as typeof fetch;
const ENV = { GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'gsecret' } as unknown as NodeJS.ProcessEnv;
const dv = () => ({ store, fetchImpl, env: ENV });
const deliver = (id: string) => deliverMessage(admin(), id, undefined, dv());
const last = (path: string) => net.calls.filter((c) => c.path === path).at(-1)!;

// ------------------------------------------------------------------------------------------------ ayudas
const convOf = (channelId: string, thread: string) => sql(`select id from conversations where channel_id = '${channelId}' and thread_key = '${thread}'`);
const chan = (kind: string, ext: string) => sql(`select id from channels where kind = '${kind}' and external_id = '${ext}'`);
const msg = (id: string) => JSON.parse(sql(`select row_to_json(m) from messages m where id = '${id}'`)) as Record<string, unknown>;
const atts = (id: string) => JSON.parse(sql(`select coalesce(json_agg(a order by position), '[]') from message_attachments a where message_id = '${id}'`)) as Record<string, unknown>[];
let C_WA = '', C_FB = '', C_GM = '';
/** Reserva + sube (simulado) un archivo como lo hace el redactor. */
async function stage(conv: string, name: string, mime: string, bytes: Uint8Array, db: ServerSupabase = s1, declared = bytes.length): Promise<string> {
  const r = await prepareUpload(db, store, { conversationId: conv, fileName: name, mime, size: declared });
  if (!r.ok) throw new Error(`prepare: ${r.message}`);
  await store.put(r.path, bytes, mime);
  return r.uploadId;
}
const send = (conv: string, ids: string[], caption?: string, db: ServerSupabase = s1, user = S1) => sendAttachments(db, admin(), store, { userId: user, conversationId: conv, uploadIds: ids, caption });

beforeAll(async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = REST_URL; process.env.SUPABASE_SERVICE_ROLE_KEY = jwt({ role: 'service_role' });
  for (const [id, email] of [[A, 'a@eo.test'], [B, 'b@eo.test'], [S1, 's1@eo.test']]) sql(`insert into auth.users (id, email) values ('${id}', '${email}')`);
  org = await createOrganization(a, 'Envio Int', 'envio-int'); await createOrganization(b, 'Otra Org Envio', 'otra-org-envio');
  sql(`insert into memberships (org_id, user_id, role_id) select '${org}', '${S1}', id from roles where key = 'sales_agent' and org_id is null`);
  await repo.createChannel(a, org, { name: 'Ventas WA', phoneNumberId: WA_PID, token: 'EAAWAtokenWAtokenWAtokenWAtoken0002' });
  await repo.connectChannel(a, org, { kind: 'facebook', name: 'Página', externalId: PAGE, token: 'EAAPAGEtokenPAGEtokenPAGEtoken0002' });
  await repo.connectChannel(a, org, { kind: 'gmail', name: GMAIL, externalId: GMAIL, token: '1//refresh-token-abcdefghijklmnopqrstuvwxyz' });
  await customers.createCustomer(s1, org, 'person', 'Cliente WA', [{ type: 'phone', value: '+573001110081' }], {});
  await customers.createCustomer(s1, org, 'person', 'Cliente FB', [{ type: 'facebook', value: PSID }], {});
  await customers.createCustomer(s1, org, 'person', 'Cliente Gmail', [{ type: 'email', value: 'cliente.out@ejemplo.com' }], {});
  await processMetaPayload(admin(), { object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: WA_PID },
    contacts: [{ wa_id: '573001110081', profile: { name: 'Ana' } }], messages: [{ from: '573001110081', id: 'wamid.in1', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'hola' } }] } }] }] });
  await processMetaPayload(admin(), { object: 'page', entry: [{ id: PAGE, messaging: [{ sender: { id: PSID }, recipient: { id: PAGE }, timestamp: Date.now(), message: { mid: 'mid.in1', text: 'hola' } }] }] }, { fetchImpl });
  await admin().rpc('ingest_channel_message', { p_kind: 'gmail', p_account_id: GMAIL, p_thread: 'cliente.out@ejemplo.com', p_contact_name: 'Cliente', p_external_id: 'gm.in1', p_msg_kind: 'text', p_body: 'necesito planos', p_occurred_at: new Date().toISOString(), p_meta: { message_id: '<in1@x>', subject: 'Planos', gmail_thread_id: 'th1' } });
  C_WA = convOf(chan('whatsapp', WA_PID), '573001110081'); C_FB = convOf(chan('facebook', PAGE), PSID); C_GM = convOf(chan('gmail', GMAIL), 'cliente.out@ejemplo.com');
}, 60_000);
afterAll(() => { sql(`update channels set connection_status = 'disconnected' where org_id = '${org}' and kind = 'gmail'`); });

describe('antes de subir: reglas del canal', () => {
  it('WhatsApp rechaza GIF, imágenes de más de 5 MB y ejecutables SIN crear ninguna subida, con el mensaje en español', async () => {
    const before = sql(`select count(*) from attachment_uploads`);
    for (const [name, mime, size, re] of [['a.gif', 'image/gif', 1000, /no puede enviarse mediante WhatsApp/], ['a.jpg', 'image/jpeg', 6 * 1024 * 1024, /supera el tamaño máximo permitido para WhatsApp \(5 MB para imágenes\)/],
      ['virus.exe', 'application/octet-stream', 1000, /Por seguridad/], ['a.jpg.exe', 'image/jpeg', 1000, /Por seguridad/], ['a.jpg', 'image/jpeg', 0, /vacío/]] as const) {
      const r = await prepareUpload(s1, store, { conversationId: C_WA, fileName: name, mime, size });
      expect(r).toMatchObject({ ok: false }); expect((r as { message: string }).message).toMatch(re);
    }
    expect(sql(`select count(*) from attachment_uploads`)).toBe(before);
  });
  it('Instagram/Messenger: cada canal aplica SUS reglas', async () => {
    expect(await prepareUpload(s1, store, { conversationId: C_FB, fileName: 'a.webp', mime: 'image/webp', size: 1000 })).toMatchObject({ ok: false });
    expect(await prepareUpload(s1, store, { conversationId: C_FB, fileName: 'a.zip', mime: 'application/zip', size: 1000 })).toMatchObject({ ok: true });
    expect(await prepareUpload(s1, store, { conversationId: C_WA, fileName: 'a.zip', mime: 'application/zip', size: 1000 })).toMatchObject({ ok: false });
  });
  it('otra organización no puede ni reservar: ni siquiera ve la conversación', async () => {
    const e = await rejects(prepareUpload(b, store, { conversationId: C_WA, fileName: 'a.pdf', mime: 'application/pdf', size: 100 }));
    expect(e).toBeInstanceOf(UserFacingError); expect(toUserMessage(e)).toMatch(/No encontramos esa conversación/);
  });
});

describe('WhatsApp: enviar archivos', () => {
  it('imagen con texto: se verifica, se encola, se sube a Meta y se envía con su pie de foto; queda «enviado»', async () => {
    net.calls.length = 0;
    const up = await stage(C_WA, 'fachada.jpg', 'image/jpeg', JPEG);
    const ids = await send(C_WA, [up], 'Mira la fachada');
    expect(ids).toHaveLength(1);
    expect(msg(ids[0]!)).toMatchObject({ kind: 'media', status: 'queued', direction: 'outbound', body: 'Mira la fachada', sent_by: S1 });
    expect(atts(ids[0]!)[0]).toMatchObject({ id: up, direction: 'outbound', status: 'stored', kind: 'image', mime_type: 'image/jpeg', file_name: 'fachada.jpg', width: 640, height: 480, file_size: JPEG.length });
    expect(await deliver(ids[0]!)).toBe('sent');
    const file = ((last(`${WA_PID}/media`).body as FormData).get('file')) as File;
    expect(Buffer.from(await file.arrayBuffer()).equals(Buffer.from(JPEG))).toBe(true);
    expect(JSON.parse(String(last(`${WA_PID}/messages`).body))).toMatchObject({ type: 'image', to: '573001110081', image: { caption: 'Mira la fachada' } });
    expect(msg(ids[0]!)).toMatchObject({ status: 'sent' }); expect(String(msg(ids[0]!).external_id)).toMatch(/^wamid\.out\./);
    expect(sql(`select last_direction || '|' || last_message_preview from conversations where id = '${C_WA}'`)).toBe('outbound|Mira la fachada');
  });
  it('documento sin texto: etiqueta automática y SIN pie de foto (la etiqueta no es un texto del agente)', async () => {
    const up = await stage(C_WA, 'plano cliente.pdf', 'application/pdf', PDF);
    const [id] = await send(C_WA, [up]);
    expect(msg(id!).body).toBe('[Documento: plano cliente.pdf]');
    await deliver(id!);
    expect(JSON.parse(String(last(`${WA_PID}/messages`).body)).document).toEqual({ id: expect.stringMatching(/^MEDIA/), filename: 'plano cliente.pdf' });
  });
  it('audio con texto: WhatsApp no lo permite junto → el archivo y el texto salen como DOS mensajes, en orden', async () => {
    net.calls.length = 0;
    const up = await stage(C_WA, 'nota.ogg', 'audio/ogg', OGG);
    const ids = await send(C_WA, [up], 'Te dejo este audio');
    expect(ids).toHaveLength(2);
    expect(msg(ids[0]!)).toMatchObject({ kind: 'media', body: '[Audio]' }); expect(msg(ids[1]!)).toMatchObject({ kind: 'text', body: 'Te dejo este audio' });
    for (const id of ids) expect(await deliver(id)).toBe('sent');
    const sent = net.calls.filter((c) => c.path === `${WA_PID}/messages`).map((c) => JSON.parse(String(c.body)));
    expect(sent[0]).toMatchObject({ type: 'audio' }); expect(sent[0].audio.caption).toBeUndefined(); expect(sent[1]).toMatchObject({ type: 'text', text: { body: 'Te dejo este audio' } });
  });
  it('un texto de más de 1024 caracteres no cabe como pie de foto: se explica y se borra la subida', async () => {
    const up = await stage(C_WA, 'a.jpg', 'image/jpeg', JPEG);
    const e = await rejects(send(C_WA, [up], 'a'.repeat(1100)));
    expect(toUserMessage(e)).toMatch(/demasiado largo \(máximo 1024/);
    expect(sql(`select status from attachment_uploads where id = '${up}'`)).toBe('cancelled');
  });
  it('un archivo por mensaje: dos se rechazan', async () => {
    const u1 = await stage(C_WA, 'a.jpg', 'image/jpeg', JPEG), u2 = await stage(C_WA, 'b.jpg', 'image/jpeg', JPEG);
    expect(toUserMessage(await rejects(send(C_WA, [u1, u2])))).toMatch(/solo permite enviar un archivo por mensaje/);
  });
});

describe('verificación por contenido en el servidor', () => {
  const expectCancelled = async (up: string) => { expect(sql(`select status from attachment_uploads where id = '${up}'`)).toBe('cancelled'); expect(files.has(sql(`select storage_path from attachment_uploads where id = '${up}'`))).toBe(false); };
  it('un ejecutable disfrazado de imagen se rechaza, se cancela y se BORRA del almacén', async () => {
    const up = await stage(C_WA, 'foto.png', 'image/png', EXE);
    expect(toUserMessage(await rejects(send(C_WA, [up])))).toMatch(/Por seguridad/); await expectCancelled(up);
  });
  it('un PDF que dice ser JPG (tipo suplantado) se rechaza', async () => {
    const up = await stage(C_WA, 'plano.jpg', 'image/jpeg', PDF);
    expect(toUserMessage(await rejects(send(C_WA, [up])))).toMatch(/no coincide con su tipo/); await expectCancelled(up);
  });
  it('un archivo que no se subió completo, o que nunca llegó, se rechaza', async () => {
    const half = await stage(C_WA, 'a.jpg', 'image/jpeg', JPEG, s1, JPEG.length + 500);
    expect(toUserMessage(await rejects(send(C_WA, [half])))).toMatch(/no se subió completo/);
    const r = await prepareUpload(s1, store, { conversationId: C_WA, fileName: 'b.jpg', mime: 'image/jpeg', size: 300 });
    expect(toUserMessage(await rejects(send(C_WA, [(r as { uploadId: string }).uploadId])))).toMatch(/no llegó completo/);
  });
  it('nadie usa la subida de otra persona; y la del vendedor sigue vigente tras ese intento', async () => {
    const up = await stage(C_WA, 'a.jpg', 'image/jpeg', JPEG);
    expect(toUserMessage(await rejects(send(C_WA, [up], undefined, a, A)))).toMatch(/venció o no es válida/);
    expect(sql(`select status from attachment_uploads where id = '${up}'`)).toBe('created');
    expect((await send(C_WA, [up])).length).toBe(1);
  });
  it('con la ventana de 24 h vencida no se envía; el mensaje de la base de datos sale en español y no quedan archivos huérfanos', async () => {
    const up = await stage(C_WA, 'a.jpg', 'image/jpeg', JPEG);
    sql(`update conversations set last_inbound_at = now() - interval '25 hours' where id = '${C_WA}'`);
    try {
      expect(toUserMessage(await rejects(send(C_WA, [up])))).toMatch(/24 horas/);
      await expectCancelled(up);
    } finally { sql(`update conversations set last_inbound_at = now() where id = '${C_WA}'`); }   // que un fallo aquí no arrastre a las demás pruebas
  });
});

describe('Messenger y Gmail', () => {
  it('Messenger: imagen + texto → el archivo por multipart y el texto APARTE (Meta no los mezcla)', async () => {
    net.calls.length = 0;
    const up = await stage(C_FB, 'muestra.png', 'image/png', PNG);
    const ids = await send(C_FB, [up], 'Esta es la muestra');
    expect(ids).toHaveLength(2);
    for (const id of ids) expect(await deliver(id)).toBe('sent');
    const calls = net.calls.filter((c) => c.path === 'me/messages');
    expect(calls[0]!.body).toBeInstanceOf(FormData); expect(JSON.parse(String((calls[0]!.body as FormData).get('message')))).toEqual({ attachment: { type: 'image', payload: { is_reusable: false } } });
    expect(JSON.parse(String(calls[1]!.body))).toMatchObject({ message: { text: 'Esta es la muestra' } });
    expect(msg(ids[0]!).body).toBe('[Imagen]'); expect(msg(ids[1]!).body).toBe('Esta es la muestra');     // el archivo lleva su etiqueta; el texto va en su propio mensaje
    expect(String(msg(ids[0]!).external_id)).toMatch(/^mid\.out\./);
    expect(atts(ids[0]!)[0]).toMatchObject({ kind: 'image', width: 100, height: 50 });
  });
  it('Gmail: varios adjuntos y el texto en UN solo correo, en el hilo, con «Re:»', async () => {
    net.calls.length = 0;
    const [u1, u2] = [await stage(C_GM, 'plano.pdf', 'application/pdf', PDF), await stage(C_GM, 'foto.png', 'image/png', PNG)];
    const ids = await send(C_GM, [u1, u2], 'Adjunto los planos');
    expect(ids).toHaveLength(1); expect(msg(ids[0]!).body).toBe('Adjunto los planos');
    expect(atts(ids[0]!).map((x) => x.file_name)).toEqual(['plano.pdf', 'foto.png']);
    expect(await deliver(ids[0]!)).toBe('sent');
    const call = last('gmail.googleapis.com/upload/gmail/v1/users/me/messages/send');
    const body = Buffer.from(call.body as Uint8Array).toString('utf8');
    expect(body).toContain('{"threadId":"th1"}'); expect(body).toContain('To: cliente.out@ejemplo.com'); expect(body).toContain('In-Reply-To: <in1@x>');
    expect(body).toContain('name="plano.pdf"'); expect(body).toContain('name="foto.png"');
    expect(String(msg(ids[0]!).external_id)).toMatch(/^gsent\./);
  });
  it('Gmail: más de 25 MB en total se rechaza al reservar', async () => {
    expect(await prepareUpload(s1, store, { conversationId: C_GM, fileName: 'gigante.zip', mime: 'application/zip', size: 26 * 1024 * 1024 })).toMatchObject({ ok: false, code: 'too_large' });
  });
});

describe('fallos al entregar', () => {
  it('Meta rechaza el archivo: el mensaje queda «falló» con el motivo, el archivo sigue visible y nada se envió', async () => {
    const up = await stage(C_WA, 'a.jpg', 'image/jpeg', JPEG); const [id] = await send(C_WA, [up]);
    net.calls.length = 0; net.mediaFail = { status: 400, code: 131053 };
    expect(await deliver(id!)).toBe('failed');
    expect(msg(id!)).toMatchObject({ status: 'failed', error_code: '131053' }); expect(String(msg(id!).error).length).toBeGreaterThan(5);
    expect(net.calls.some((c) => c.path === `${WA_PID}/messages`)).toBe(false);
    expect(atts(id!)).toHaveLength(1); net.mediaFail = null;
  });
  it('token vencido al subir: el mensaje falla Y la conexión pasa a «Token expirado»', async () => {
    const up = await stage(C_WA, 'a.jpg', 'image/jpeg', JPEG); const [id] = await send(C_WA, [up]);
    net.mediaFail = { status: 400, code: 190 };
    await deliver(id!);
    expect(sql(`select connection_status from channels where kind = 'whatsapp' and external_id = '${WA_PID}'`)).toBe('token_expired');
    net.mediaFail = null; sql(`update channels set connection_status = 'connected' where kind = 'whatsapp' and external_id = '${WA_PID}'`);
  });
  it('si el archivo ya no está en el almacén al entregar: falla con un mensaje claro, sin enviar nada', async () => {
    const up = await stage(C_WA, 'a.jpg', 'image/jpeg', JPEG); const [id] = await send(C_WA, [up]);
    files.delete(String(atts(id!)[0]!.storage_path)); net.calls.length = 0;
    expect(await deliver(id!)).toBe('failed');
    expect(msg(id!)).toMatchObject({ status: 'failed', error_code: 'attachment_missing' }); expect(net.calls).toHaveLength(0);
  });
  it('entregar dos veces el mismo mensaje NO lo envía dos veces', async () => {
    const up = await stage(C_WA, 'a.jpg', 'image/jpeg', JPEG); const [id] = await send(C_WA, [up]);
    net.calls.length = 0;
    const outs = await Promise.all([deliver(id!), deliver(id!)]);
    expect(outs.sort()).toEqual(['sent', 'skipped']); expect(net.calls.filter((c) => c.path === `${WA_PID}/messages`)).toHaveLength(1);
  });
});

describe('visibilidad y limpieza', () => {
  it('lo enviado aparece de inmediato entre los adjuntos de la conversación y se puede abrir con su enlace firmado; otra organización no', async () => {
    const list = await repo.listAttachments(s1, C_WA);
    const sent = list.find((x) => x.fileName === 'fachada.jpg')!;
    expect(sent).toMatchObject({ kind: 'image', status: 'stored', width: 640 });
    expect(await mediaAccessUrl(s1, store, sent.id)).toMatchObject({ ok: true });
    expect(await mediaAccessUrl(b, store, sent.id)).toEqual({ ok: false, reason: 'not_found' });
  });
  it('cancelar borra lo subido; la limpieza periódica borra lo abandonado y no toca lo enviado', async () => {
    const up = await stage(C_WA, 'a.jpg', 'image/jpeg', JPEG); const path = sql(`select storage_path from attachment_uploads where id = '${up}'`);
    await cancelUpload(s1, store, up); expect(files.has(path)).toBe(false);
    const ab = await stage(C_WA, 'b.jpg', 'image/jpeg', JPEG); const abPath = sql(`select storage_path from attachment_uploads where id = '${ab}'`);
    sql(`update attachment_uploads set expires_at = now() - interval '1 minute' where id = '${ab}'`);
    const sentPath = String((await repo.listAttachments(s1, C_WA)).length ? sql(`select storage_path from message_attachments where file_name = 'fachada.jpg'`) : '');
    expect(await purgeStaleUploads(admin(), store)).toBeGreaterThanOrEqual(1);
    expect(files.has(abPath)).toBe(false); expect(files.has(sentPath)).toBe(true);
  });
  it('nadie ve las subidas ni escribe adjuntos desde el navegador', async () => {
    expect((await a.from('attachment_uploads').select('id')).error).not.toBeNull();
    expect((await s1.from('message_attachments').insert({ org_id: org, message_id: '00000000-0000-4000-8000-000000000000', conversation_id: C_WA, direction: 'outbound', kind: 'file' })).error).not.toBeNull();
  });
});

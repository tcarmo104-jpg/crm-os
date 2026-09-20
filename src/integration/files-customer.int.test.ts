/**
 * Archivos del cliente y de la oportunidad: todo lo guardado de un cliente en TODOS sus canales, con la seguridad de la base de datos
 * (organización y alcance), y los archivos de la conversación vinculada a una oportunidad.
 */
import { createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';

vi.mock('server-only', () => ({}));

import type { ServerSupabase } from '@/lib/supabase/server';
import { createOrganization } from '@/repositories/organizations';
import * as customers from '@/repositories/customers';
import * as repo from '@/repositories/inbox';
import * as opps from '@/repositories/opportunities';
import * as board from '@/repositories/opportunities-board';
import * as kanban from '@/services/kanban';
import { processMetaPayload } from '@/server/inbound';
import { createAdminClient } from '@/server/supabase-admin';

const REST_URL = process.env.REST_URL!, SECRET = process.env.JWT_SECRET!, DB = process.env.INT_DB!;
const A = 'aaaaaaaa-d999-0000-0000-00000000000a', B = 'bbbbbbbb-d999-0000-0000-00000000000b', S1 = '51000000-d999-0000-0000-000000000001';
const WA_PID = '439876543210', GMAIL = 'ventas.files@arkos.co';
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (c: Record<string, unknown>) => { const h = b64({ alg: 'HS256', typ: 'JWT' }), p = b64({ ...c, exp: Math.floor(Date.now() / 1000) + 3600 }); return `${h}.${p}.${createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url')}`; };
const client = (t: string) => createClient(REST_URL, t, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${t}` } } }) as unknown as ServerSupabase;
const asUser = (uid: string) => client(jwt({ role: 'authenticated', sub: uid }));
const sql = (q: string) => execFileSync('psql', ['-X', '-tA', '-d', DB, '-c', q], { encoding: 'utf8' }).trim();
const a = asUser(A), b = asUser(B), s1 = asUser(S1);
const admin = () => createAdminClient();
let org = '', orgB = '';
let convWa = '', convGm = '', convAdmin = '', c1 = '', c2 = '';

const waPayload = (thread: string, wamid: string, msg: Record<string, unknown>) => ({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: WA_PID },
  contacts: [{ wa_id: thread, profile: { name: 'Cliente' } }], messages: [{ from: thread, id: wamid, timestamp: String(Math.floor(Date.now() / 1000)), ...msg }] } }] }] });
/** Registra un adjunto de un mensaje ya guardado y lo deja en el estado pedido (como lo haría la descarga). */
async function attach(kind: 'whatsapp' | 'gmail', account: string, external: string, item: Record<string, unknown>, state: 'stored' | 'pending' | 'blocked', name?: string) {
  await admin().rpc('register_message_attachments', { p_kind: kind, p_account: account, p_external_id: external, p_items: [item] });
  const id = sql(`select a.id from message_attachments a join messages m on m.id = a.message_id where m.external_id = '${external}' order by a.created_at desc limit 1`);
  if (state === 'pending') return id;
  await admin().rpc('claim_attachment', { p_id: id });
  if (state === 'blocked') await admin().rpc('finish_attachment', { p_id: id, p_status: 'blocked', p_error: 'dangerous_file' });
  else await admin().rpc('finish_attachment', { p_id: id, p_status: 'stored', p_kind: item.kind, p_mime: item.mime_type, p_size: 1234, p_path: `${org}/x/${id}`, p_file_name: name ?? String(item.file_name ?? 'archivo') });
  return id;
}
const tick = () => new Promise((r) => setTimeout(r, 30));

beforeAll(async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = REST_URL; process.env.SUPABASE_SERVICE_ROLE_KEY = jwt({ role: 'service_role' });
  for (const [id, email] of [[A, 'a@fi.test'], [B, 'b@fi.test'], [S1, 's1@fi.test']]) sql(`insert into auth.users (id, email) values ('${id}', '${email}')`);
  org = await createOrganization(a, 'Archivos Int', 'archivos-int'); orgB = await createOrganization(b, 'Otra Org Archivos', 'otra-org-archivos');
  sql(`insert into memberships (org_id, user_id, role_id) select '${org}', '${S1}', id from roles where key = 'sales_agent' and org_id is null`);
  await repo.createChannel(a, org, { name: 'Ventas WA', phoneNumberId: WA_PID, token: 'EAAWAtokenWAtokenWAtokenWAtoken0003' });
  await repo.connectChannel(a, org, { kind: 'gmail', name: GMAIL, externalId: GMAIL, token: '1//refresh-token-abcdefghijklmnopqrstuvwxyz' });
  const r1 = await customers.createCustomer(s1, org, 'person', 'Cliente del vendedor', [{ type: 'phone', value: '+573001110091' }, { type: 'email', value: 'cliente.files@ejemplo.com' }], {});
  const r2 = await customers.createCustomer(a, org, 'person', 'Cliente del admin', [{ type: 'phone', value: '+573001110092' }], {});
  c1 = (r1 as { customerId: string }).customerId; c2 = (r2 as { customerId: string }).customerId;
  // el cliente 1 escribe por WhatsApp Y por Gmail (mismo cliente, dos conversaciones)
  await processMetaPayload(admin(), waPayload('573001110091', 'wamid.f1', { type: 'image', image: { id: '910000000001', mime_type: 'image/jpeg' } }));
  await tick(); await processMetaPayload(admin(), waPayload('573001110091', 'wamid.f2', { type: 'document', document: { id: '910000000002', filename: 'plano.pdf', mime_type: 'application/pdf' } }));
  await tick(); await processMetaPayload(admin(), waPayload('573001110091', 'wamid.f3', { type: 'image', image: { id: '910000000003', mime_type: 'image/png' } }));
  await tick(); await processMetaPayload(admin(), waPayload('573001110091', 'wamid.f4', { type: 'document', document: { id: '910000000004', filename: 'raro.pdf', mime_type: 'application/pdf' } }));
  await tick(); await processMetaPayload(admin(), waPayload('573001110091', 'wamid.f5', { type: 'location', location: { latitude: 6.2, longitude: -75.5 } }));
  await tick(); await processMetaPayload(admin(), waPayload('573001110092', 'wamid.g1', { type: 'image', image: { id: '910000000005', mime_type: 'image/jpeg' } }));
  for (const [ext, subject] of [['gm.f1', 'Planos'], ['gm.f2', 'Fotos']]) {
    await tick(); await admin().rpc('ingest_channel_message', { p_kind: 'gmail', p_account_id: GMAIL, p_thread: 'cliente.files@ejemplo.com', p_contact_name: 'Cliente', p_external_id: ext, p_msg_kind: 'text', p_body: subject, p_occurred_at: new Date().toISOString(), p_meta: {} });
  }
  convWa = sql(`select id from conversations where org_id = '${org}' and thread_key = '573001110091'`);
  convGm = sql(`select id from conversations where org_id = '${org}' and thread_key = 'cliente.files@ejemplo.com'`);
  convAdmin = sql(`select id from conversations where org_id = '${org}' and thread_key = '573001110092'`);
  const wa = (kind: string, mime: string, media: string, extra: Record<string, unknown> = {}) => ({ kind, mime_type: mime, source: { media_id: media }, ...extra });
  await attach('whatsapp', WA_PID, 'wamid.f1', wa('image', 'image/jpeg', '910000000001'), 'stored', 'fachada.jpg'); await tick();
  await attach('whatsapp', WA_PID, 'wamid.f2', wa('document', 'application/pdf', '910000000002', { file_name: 'plano.pdf' }), 'stored'); await tick();
  await attach('whatsapp', WA_PID, 'wamid.f3', wa('image', 'image/png', '910000000003'), 'pending'); await tick();
  await attach('whatsapp', WA_PID, 'wamid.f4', wa('document', 'application/pdf', '910000000004', { file_name: 'raro.pdf' }), 'blocked'); await tick();
  await attach('whatsapp', WA_PID, 'wamid.f5', { kind: 'location', meta: { lat: 6.2, lng: -75.5 } }, 'stored'); await tick();
  await attach('whatsapp', WA_PID, 'wamid.g1', wa('image', 'image/jpeg', '910000000005'), 'stored', 'privada.jpg'); await tick();
  await attach('gmail', GMAIL, 'gm.f1', { kind: 'document', mime_type: 'application/pdf', file_name: 'cotizacion.pdf', source: { gmail_id: 'aa', attachment_id: 'bb' } }, 'stored'); await tick();
  await attach('gmail', GMAIL, 'gm.f2', { kind: 'image', mime_type: 'image/png', file_name: 'foto.png', source: { gmail_id: 'aa', attachment_id: 'cc' } }, 'stored');
}, 60_000);
afterAll(() => {
  sql(`update channels set connection_status = 'disconnected' where org_id = '${org}' and kind = 'gmail'`);
  sql(`update message_attachments set status = 'expired' where org_id = '${org}' and status in ('pending', 'downloading')`);   // la cola de descargas es global: no dejar pendientes para otras pruebas
});

describe('archivos de un cliente (todos sus canales)', () => {
  it('reúne lo guardado de WhatsApp Y de Gmail, lo más reciente primero, sin lo pendiente, bloqueado ni ubicaciones', async () => {
    const list = await repo.listCustomerAttachments(s1, c1);
    expect(list.map((x) => x.fileName)).toEqual(['foto.png', 'cotizacion.pdf', 'plano.pdf', 'fachada.jpg']);
    expect(list.map((x) => x.channel)).toEqual(['gmail', 'gmail', 'whatsapp', 'whatsapp']);
    expect(list.every((x) => x.status === 'stored' && x.direction === 'inbound' && x.conversationId && x.createdAt)).toBe(true);
    expect(new Set(list.map((x) => x.conversationId))).toEqual(new Set([convWa, convGm]));
    expect(list.map((x) => x.createdAt!).sort().reverse()).toEqual(list.map((x) => x.createdAt));
  });
  it('el límite se respeta (los más recientes)', async () => {
    expect((await repo.listCustomerAttachments(s1, c1, 2)).map((x) => x.fileName)).toEqual(['foto.png', 'cotizacion.pdf']);
  });
  it('la ruta del archivo nunca sale en la lista', async () => {
    expect(JSON.stringify(await repo.listCustomerAttachments(s1, c1))).not.toMatch(/storage_path|storagePath|\/x\//);
  });
  it('un cliente sin conversaciones o sin archivos devuelve una lista vacía', async () => {
    const r = await customers.createCustomer(a, org, 'person', 'Cliente sin nada', [{ type: 'phone', value: '+573001119999' }], {});
    expect(await repo.listCustomerAttachments(a, (r as { customerId: string }).customerId)).toEqual([]);
  });
});

describe('seguridad: organización y alcance', () => {
  it('el administrador ve los archivos de todos los clientes de su organización', async () => {
    expect((await repo.listCustomerAttachments(a, c1)).length).toBe(4);
    expect((await repo.listCustomerAttachments(a, c2)).map((x) => x.fileName)).toEqual(['privada.jpg']);
  });
  it('un vendedor NO ve los archivos de un cliente que no es suyo', async () => {
    expect(await repo.listCustomerAttachments(s1, c2)).toEqual([]);
    expect(await repo.listConversationFiles(s1, convAdmin)).toEqual([]);
  });
  it('otra organización no ve nada, ni por cliente ni por conversación', async () => {
    expect(await repo.listCustomerAttachments(b, c1)).toEqual([]);
    expect(await repo.listConversationFiles(b, convWa)).toEqual([]);
    expect(orgB).toBeTruthy();
  });
});

describe('archivos de una conversación / oportunidad', () => {
  it('lista solo los guardados de ESA conversación', async () => {
    expect((await repo.listConversationFiles(s1, convWa)).map((x) => x.fileName)).toEqual(['plano.pdf', 'fachada.jpg']);
    expect((await repo.listConversationFiles(s1, convGm)).map((x) => x.fileName)).toEqual(['foto.png', 'cotizacion.pdf']);
    expect((await repo.listConversationFiles(s1, convWa, 1)).length).toBe(1);
  });
  it('el detalle de la oportunidad trae los archivos de la conversación vinculada, y nada si no hay vínculo', async () => {
    const oppId = await opps.createOpportunity(s1, { customerId: c1, title: 'Wallpanel oficina', amount: 2500000 });
    const id = typeof oppId === 'string' ? oppId : (oppId as { id: string }).id;
    // Una oportunidad nace vinculada a la ÚLTIMA conversación del cliente (aquí, Gmail): sus archivos ya salen.
    expect((await board.loadOpportunityDetail(s1, org, id))!.files.map((x) => x.fileName)).toEqual(['foto.png', 'cotizacion.pdf']);
    await kanban.linkConversation(s1, { id, conversationId: '' });
    expect((await board.loadOpportunityDetail(s1, org, id))!.files).toEqual([]);
    await kanban.linkConversation(s1, { id, conversationId: convWa });
    const d = await board.loadOpportunityDetail(s1, org, id);
    expect(d!.files.map((x) => x.fileName)).toEqual(['plano.pdf', 'fachada.jpg']);
    await kanban.linkConversation(s1, { id, conversationId: convGm });
    expect((await board.loadOpportunityDetail(s1, org, id))!.files.map((x) => x.fileName)).toEqual(['foto.png', 'cotizacion.pdf']);
    await kanban.linkConversation(s1, { id, conversationId: '' });
    expect((await board.loadOpportunityDetail(s1, org, id))!.files).toEqual([]);
  });
});

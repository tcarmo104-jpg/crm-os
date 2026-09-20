/**
 * Integración del Inbox de tres paneles contra PostgREST + Postgres reales, con usuarios de JWT firmado:
 * lista con filtros/búsqueda/paginación, contadores, etiquetas, notas internas, respuestas rápidas y ficha del cliente.
 */
import { createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';

vi.mock('server-only', () => ({}));

import type { ServerSupabase } from '@/lib/supabase/server';
import { toUserMessage } from '@/lib/errors';
import { parseInboxQuery, type InboxQuery } from '@/lib/inbox-view';
import { createOrganization } from '@/repositories/organizations';
import * as customers from '@/repositories/customers';
import * as repo from '@/repositories/inbox';
import { loadCustomerContext } from '@/repositories/inbox-context';
import * as inbox from '@/services/inbox';
import { createAdminClient } from '@/server/supabase-admin';

const REST_URL = process.env.REST_URL!;
const SECRET = process.env.JWT_SECRET!;
const DB = process.env.INT_DB!;
const A = 'aaaaaaaa-5555-0000-0000-00000000000a';
const S1 = '51000000-5555-0000-0000-000000000001';
const S2 = '52000000-5555-0000-0000-000000000002';
const PID = '409876543210';

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
const q = (o: Record<string, string> = {}): InboxQuery => parseInboxQuery(o);

const a = asUser(A), s1 = asUser(S1), s2 = asUser(S2);
let org = '';
const ids = {} as { carlos: string; diana: string; convCarlos: string; convElena: string; tagVip: string };
const names = async (db: ServerSupabase, query: InboxQuery, extra: { limit?: number; cursor?: string } = {}) =>
  (await repo.searchConversations(db, { orgId: org, userId: db === a ? A : db === s1 ? S1 : S2, query, ...extra })).items;
const custName = async (db: ServerSupabase, list: { customerId: string }[]) =>
  (await customers.getCustomersByIds(db, list.map((c) => c.customerId))).map((c) => c.fullName).sort();

async function mkCustomer(db: ServerSupabase, name: string, phone: string): Promise<string> {
  const r = await customers.createCustomer(db, org, 'person', name, [{ type: 'phone', value: phone }], {});
  if (r.outcome !== 'created') throw new Error(`no se pudo crear a ${name}: ${r.outcome}`);
  return r.customerId;
}
async function ingest(phone: string, name: string | null, id: string, text: string, ago = 0) {
  const r = await createAdminClient().rpc('ingest_whatsapp_message', {
    p_phone_number_id: PID, p_thread: phone, p_contact_name: name, p_external_id: id, p_kind: 'text', p_body: text,
    p_occurred_at: new Date(Date.now() - ago).toISOString(), p_meta: {},
  });
  if (r.error) throw new Error(r.error.message);
}

beforeAll(async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = REST_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY = jwt({ role: 'service_role' });
  for (const [id, email] of [[A, 'a@ctx.test'], [S1, 's1@ctx.test'], [S2, 's2@ctx.test']]) sql(`insert into auth.users (id, email) values ('${id}', '${email}')`);
  org = await createOrganization(a, 'Ctx Int', 'ctx-int');
  for (const [uid, role] of [[S1, 'sales_agent'], [S2, 'sales_agent']]) {
    sql(`insert into memberships (org_id, user_id, role_id) select '${org}', '${uid}', id from roles where key = '${role}' and org_id is null`);
  }
  await inbox.createChannel(a, org, { name: 'Ventas', phoneNumberId: PID, token: 'EAAB-token-abcdefghijklmnopqrstuvwxyz' });
  ids.carlos = await mkCustomer(s1, 'Carlos Ruiz', '+573001110101');
  ids.diana = await mkCustomer(s2, 'Diana Mora', '+573001110102');
  await ingest('573001110101', 'Carlos Ruiz', 'k.1', 'hola, ¿tienen sillas?', 3000);
  await ingest('573001110101', null, 'k.2', 'precio de la silla ergonómica', 2000);
  await ingest('573001110101', null, 'k.3', 'es urgente', 1000);
  await ingest('573001110102', 'Diana Mora', 'k.4', 'Necesito una mesa de centro');
  await ingest('573001110103', 'Elena Vega', 'k.5', 'mensaje muy antiguo', 40 * 24 * 3600 * 1000);      // contacto nuevo, sin dueño
}, 60_000);

describe('lista de conversaciones: pestañas y contadores', () => {
  it('el administrador ve las 3 conversaciones; el contador de no leídos es real', async () => {
    const all = await names(a, q());
    expect(await custName(a, all)).toEqual(['Carlos Ruiz', 'Diana Mora', 'Elena Vega']);
    const carlos = all.find((c) => c.threadKey === '573001110101')!;
    expect(carlos.unreadCount).toBe(3);
    expect(carlos.unread).toBe(true);
    expect(all.find((c) => c.threadKey === '573001110102')!.unreadCount).toBe(1);
    ids.convCarlos = carlos.id;
    ids.convElena = all.find((c) => c.threadKey === '573001110103')!.id;
  });
  it('cada pestaña filtra lo que dice', async () => {
    expect(await names(a, q({ f: 'unread' }))).toHaveLength(3);
    expect(await names(a, q({ f: 'pending' }))).toHaveLength(3);
    expect(await custName(a, await names(a, q({ f: 'unassigned' })))).toEqual(['Elena Vega']);
    expect(await names(a, q({ f: 'mine' }))).toHaveLength(0);                       // el admin no es dueño de ninguna
    expect(await names(a, q({ f: 'closed' }))).toHaveLength(0);
    expect(await repo.tabCounts(a, org)).toEqual({ unread: 3, pending: 3, unassigned: 1 });
  });
  it('visibilidad por rol: cada vendedor ve SOLO las de sus clientes (también en los contadores)', async () => {
    expect(await custName(s1, await names(s1, q()))).toEqual(['Carlos Ruiz']);
    expect(await custName(s2, await names(s2, q()))).toEqual(['Diana Mora']);
    expect(await names(s1, q({ f: 'mine' }))).toHaveLength(1);
    expect(await names(s1, q({ f: 'unassigned' }))).toHaveLength(0);
    expect(await repo.tabCounts(s1, org)).toEqual({ unread: 1, pending: 1, unassigned: 0 });
  });
  it('abrir la conversación la marca leída y el contador vuelve a 0; responder también', async () => {
    await repo.markRead(s1, ids.convCarlos);
    expect((await repo.getConversation(s1, ids.convCarlos))).toMatchObject({ unread: false, unreadCount: 0 });
    await ingest('573001110101', null, 'k.6', 'gracias');
    expect((await repo.getConversation(s1, ids.convCarlos))!.unreadCount).toBe(1);
    await inbox.sendMessage(s1, { conversationId: ids.convCarlos, body: 'de nada' });
    expect((await repo.getConversation(s1, ids.convCarlos))).toMatchObject({ unread: false, unreadCount: 0, needsReply: false });
  });
  it('cerrar mueve la conversación a «Cerradas»', async () => {
    await repo.setConversationStatus(s1, ids.convCarlos, 'closed');
    expect(await names(s1, q({ f: 'closed' }))).toHaveLength(1);
    expect(await names(s1, q({ f: 'pending' }))).toHaveLength(0);
    await repo.setConversationStatus(s1, ids.convCarlos, 'open');
  });
});

describe('filtros avanzados y búsqueda', () => {
  it('canal, asesor, fecha y estado', async () => {
    expect(await names(a, q({ canal: 'whatsapp' }))).toHaveLength(3);
    expect(await names(a, q({ canal: 'instagram' }))).toHaveLength(0);              // canal sin conectar: vacío, no error
    expect(await names(a, q({ canal: 'facebook' }))).toHaveLength(0);
    expect(await custName(a, await names(a, q({ asesor: S1 })))).toEqual(['Carlos Ruiz']);
    expect(await custName(a, await names(a, q({ asesor: 'none' })))).toEqual(['Elena Vega']);
    expect(await custName(a, await names(a, q({ fecha: 'hoy' })))).toEqual(['Carlos Ruiz', 'Diana Mora']);   // Elena tiene 40 días
    expect(await names(a, q({ fecha: '7d' }))).toHaveLength(2);
    expect(await names(a, q({ fecha: '30d' }))).toHaveLength(2);
    expect(await names(a, q({ estado: 'closed' }))).toHaveLength(0);
    expect(await names(a, q({ estado: 'open' }))).toHaveLength(3);
  });
  it('los filtros se combinan (Y lógico)', async () => {
    expect(await custName(a, await names(a, q({ canal: 'whatsapp', asesor: S1, fecha: 'hoy', estado: 'open' })))).toEqual(['Carlos Ruiz']);
    expect(await names(a, q({ asesor: S1, fecha: '30d', f: 'unassigned' }))).toHaveLength(0);
  });
  it('la búsqueda encuentra por nombre, teléfono y texto del mensaje (sin distinguir mayúsculas)', async () => {
    expect(await custName(a, await names(a, q({ q: 'CARLOS' })))).toEqual(['Carlos Ruiz']);
    expect(await custName(a, await names(a, q({ q: '3001110102' })))).toEqual(['Diana Mora']);
    expect(await custName(a, await names(a, q({ q: 'mesa de centro' })))).toEqual(['Diana Mora']);
    expect(await custName(a, await names(a, q({ q: 'vega' })))).toEqual(['Elena Vega']);
    expect(await names(a, q({ q: 'no existe jamás' }))).toHaveLength(0);
  });
  it('una búsqueda hostil no rompe la consulta ni devuelve datos de más', async () => {
    for (const evil of ['x,customer_id.neq.0)', 'a),or(id.not.is.null', '%', '_', "'; drop table conversations; --", '*', '\\']) {
      const r = await names(a, q({ q: evil }));
      expect(Array.isArray(r)).toBe(true);
    }
    expect(await names(a, q({ q: 'x,customer_id.neq.0)' }))).toHaveLength(0);
    expect(sql('select count(*) from conversations')).not.toBe('0');
  });
  it('la búsqueda respeta la visibilidad: un vendedor no encuentra clientes ajenos', async () => {
    expect(await names(s1, q({ q: 'diana' }))).toHaveLength(0);
    expect(await names(s1, q({ q: 'mesa' }))).toHaveLength(0);
  });
  it('paginación por cursor: sin repetidos ni faltantes', async () => {
    const p1 = await repo.searchConversations(a, { orgId: org, userId: A, query: q(), limit: 2 });
    expect(p1.items).toHaveLength(2);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = await repo.searchConversations(a, { orgId: org, userId: A, query: q(), limit: 2, cursor: p1.nextCursor! });
    expect(p2.items).toHaveLength(1);
    expect(p2.nextCursor).toBeNull();
    expect(new Set([...p1.items, ...p2.items].map((c) => c.id)).size).toBe(3);
  });
});

describe('etiquetas', () => {
  it('el vendedor etiqueta a su cliente; la misma etiqueta con otras mayúsculas reutiliza la existente', async () => {
    const t1 = await inbox.addTag(s1, { customerId: ids.carlos, name: 'VIP' });
    const t2 = await inbox.addTag(s1, { customerId: ids.carlos, name: '  vip ' });
    expect(t1).toBe(t2);
    await inbox.addTag(s1, { customerId: ids.carlos, name: 'Interesado', color: 'blue' });
    expect((await repo.listTags(s1, org)).map((t) => t.name).sort()).toEqual(['Interesado', 'VIP']);
    const m = await repo.tagsByCustomer(s1, [ids.carlos]);
    expect(m.get(ids.carlos)!.map((t) => t.name)).toEqual(['Interesado', 'VIP']);        // ordenadas alfabéticamente
    expect(m.get(ids.carlos)!.find((t) => t.name === 'Interesado')!.color).toBe('blue');
    ids.tagVip = t1;
  });
  it('validaciones y permisos, con mensajes en español', async () => {
    expect(toUserMessage(await rejects(inbox.addTag(s1, { customerId: ids.carlos, name: '   ' })))).toMatch(/nombre de la etiqueta/);
    expect(toUserMessage(await rejects(inbox.addTag(s1, { customerId: ids.carlos, name: 'x'.repeat(41) })))).toMatch(/demasiado larga/);
    expect(toUserMessage(await rejects(inbox.addTag(s1, { customerId: 'no-uuid', name: 'A' })))).toMatch(/Cliente no válido/);
    expect(toUserMessage(await rejects(inbox.addTag(s1, { customerId: ids.carlos, name: 'A', color: 'fucsia' })))).toBeTruthy();
    const e = await rejects(inbox.addTag(s2, { customerId: ids.carlos, name: 'Intruso' }));         // cliente de otro vendedor
    expect(e.code).toBe('42501');
    expect(toUserMessage(e)).toMatch(/permiso/i);
    expect((await repo.tagsByCustomer(s2, [ids.carlos])).size).toBe(0);                            // ni siquiera ve sus vínculos
  });
  it('el filtro por etiqueta respeta la visibilidad', async () => {
    await inbox.addTag(a, { customerId: await mkCustomer(a, 'Zoe Prieto', '+573001110104'), name: 'VIP' });
    await ingest('573001110104', 'Zoe Prieto', 'k.7', 'hola');
    expect(await custName(a, await names(a, q({ etiqueta: ids.tagVip })))).toEqual(['Carlos Ruiz', 'Zoe Prieto']);
    expect(await custName(s1, await names(s1, q({ etiqueta: ids.tagVip })))).toEqual(['Carlos Ruiz']);
    expect(await names(s2, q({ etiqueta: ids.tagVip }))).toHaveLength(0);
  });
  it('quitar la etiqueta borra el vínculo, no la etiqueta; otro vendedor no puede', async () => {
    expect(toUserMessage(await rejects(inbox.removeTag(s2, { customerId: ids.carlos, tagId: ids.tagVip })))).toMatch(/permiso/i);
    await inbox.removeTag(s1, { customerId: ids.carlos, tagId: ids.tagVip });
    expect((await repo.tagsByCustomer(s1, [ids.carlos])).get(ids.carlos)!.map((t) => t.name)).toEqual(['Interesado']);
    expect((await repo.listTags(a, org)).some((t) => t.name === 'VIP')).toBe(true);
  });
});

describe('notas internas y ficha del cliente', () => {
  it('una nota interna queda como actividad del cliente y JAMÁS como mensaje saliente', async () => {
    const outBefore = sql(`select count(*) from messages where direction = 'outbound' and org_id = '${org}'`);
    await inbox.sendNote(s1, { customerId: ids.carlos, body: 'Prefiere entrega los sábados' });
    expect(sql(`select count(*) from messages where direction = 'outbound' and org_id = '${org}'`)).toBe(outBefore);
    expect(sql(`select count(*) from messages where body like '%sábados%'`)).toBe('0');
    const ctx = (await loadCustomerContext(s1, org, ids.carlos))!;
    expect(ctx.notes.map((n) => n.summary)).toEqual(['Prefiere entrega los sábados']);
    expect(ctx.noteCount).toBe(1);
  });
  it('validaciones de la nota, en español', async () => {
    expect(toUserMessage(await rejects(inbox.sendNote(s1, { customerId: ids.carlos, body: '  ' })))).toMatch(/Escribe la nota/);
    expect(toUserMessage(await rejects(inbox.sendNote(s1, { customerId: ids.carlos, body: 'x'.repeat(2001) })))).toMatch(/demasiado larga/);
  });
  it('la ficha reúne datos, etiquetas y contadores; un cliente ajeno o inexistente devuelve null', async () => {
    const ctx = (await loadCustomerContext(s1, org, ids.carlos))!;
    expect(ctx.customer.fullName).toBe('Carlos Ruiz');
    expect(ctx.identifiers.map((i) => i.value)).toContain('+573001110101');
    expect(ctx.tags.map((t) => t.name)).toEqual(['Interesado']);
    expect(ctx.sales).toEqual({ items: [], total: 0, count: 0 });
    expect(ctx.tasks).toEqual([]);
    expect(ctx.products).toEqual([]);
    expect(ctx.company).toBeNull();
    expect(await loadCustomerContext(s2, org, ids.carlos)).toBeNull();              // no es su cliente
    expect(await loadCustomerContext(s1, org, '00000000-0000-4000-8000-000000000000')).toBeNull();
  });
});

describe('respuestas rápidas', () => {
  it('se crean, se comparten y se borran según permisos', async () => {
    const id = await inbox.createQuickReply(s1, org, { title: 'Saludo', body: '  Hola, ¿en qué te ayudo?  ' });
    expect(await repo.listQuickReplies(s2, org)).toEqual([{ id, title: 'Saludo', body: 'Hola, ¿en qué te ayudo?' }]);
    expect(toUserMessage(await rejects(inbox.createQuickReply(s2, org, { title: 'SALUDO', body: 'otro' })))).toMatch(/Ya existe/);
    expect(toUserMessage(await rejects(inbox.createQuickReply(s1, org, { title: ' ', body: 'x' })))).toMatch(/título/);
    expect(toUserMessage(await rejects(inbox.createQuickReply(s1, org, { title: 'X', body: 'y'.repeat(1001) })))).toMatch(/demasiado largo/);
    expect(toUserMessage(await rejects(inbox.deleteQuickReply(s2, id)))).toMatch(/permiso/i);
    await inbox.deleteQuickReply(s1, id);
    expect(await repo.listQuickReplies(a, org)).toEqual([]);
  });
});

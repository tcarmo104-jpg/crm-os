/**
 * Integración del tablero de Oportunidades contra PostgREST + Postgres reales, con usuarios de JWT firmado:
 * filtros combinados, búsqueda, ventana de cerradas, visibilidad por rol, movimientos e historial.
 */
import { createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';

vi.mock('server-only', () => ({}));

import type { ServerSupabase } from '@/lib/supabase/server';
import { toUserMessage } from '@/lib/errors';
import { EMPTY_KANBAN, parseKanbanQuery, type KanbanQuery } from '@/lib/kanban';
import { buildHistory } from '@/lib/kanban-history';
import { createOrganization } from '@/repositories/organizations';
import * as customers from '@/repositories/customers';
import * as opps from '@/repositories/opportunities';
import * as boardRepo from '@/repositories/opportunities-board';
import { listMembers } from '@/repositories/members';
import { listPipelines } from '@/repositories/pipelines';
import { listProducts, createProduct } from '@/repositories/products';
import * as quotes from '@/repositories/quotes';
import * as inbox from '@/services/inbox';
import * as kanban from '@/services/kanban';
import { createAdminClient } from '@/server/supabase-admin';

const REST_URL = process.env.REST_URL!;
const SECRET = process.env.JWT_SECRET!;
const DB = process.env.INT_DB!;
const A = 'aaaaaaaa-7777-0000-0000-00000000000a';
const S1 = '51000000-7777-0000-0000-000000000001';
const S2 = '52000000-7777-0000-0000-000000000002';
const T1 = '11111111-7777-0000-0000-000000000001';
const T2 = '22222222-7777-0000-0000-000000000002';
const PID = '609876543210';

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
const Q = (o: Record<string, string> = {}): KanbanQuery => ({ ...EMPTY_KANBAN, ...parseKanbanQuery(o) });

const a = asUser(A), s1 = asUser(S1), s2 = asUser(S2);
let org = '';
const id = {} as Record<'carlos' | 'dana' | 'elena' | 'o1' | 'o2' | 'o3' | 'o4' | 'silla' | 'convCarlos', string>;
const st = {} as Record<string, string>;
let pipeline: Awaited<ReturnType<typeof listPipelines>>[number];
let members: Awaited<ReturnType<typeof listMembers>>;

const load = async (db: ServerSupabase, q: KanbanQuery = Q()) => boardRepo.loadBoard(db, { orgId: org, pipeline, query: q, members });
const titles = async (db: ServerSupabase, o: Record<string, string> = {}) => (await load(db, Q(o))).cards.map((c) => c.title).sort();
async function mk(db: ServerSupabase, name: string, phone: string, city: string): Promise<string> {
  const r = await customers.createCustomer(db, org, 'person', name, [{ type: 'phone', value: phone }], {});
  if (r.outcome !== 'created') throw new Error(`no se pudo crear a ${name}`);
  await customers.updateCustomer(db, r.customerId, { city });
  return r.customerId;
}

beforeAll(async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = REST_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY = jwt({ role: 'service_role' });
  for (const [uid, email] of [[A, 'a@kb.test'], [S1, 's1@kb.test'], [S2, 's2@kb.test']]) sql(`insert into auth.users (id, email) values ('${uid}', '${email}')`);
  org = await createOrganization(a, 'Kanban Int', 'kanban-int');
  sql(`insert into teams (id, org_id, name) values ('${T1}', '${org}', 'Norte'), ('${T2}', '${org}', 'Sur')`);
  for (const [uid, team] of [[S1, T1], [S2, T2]]) sql(`insert into memberships (org_id, user_id, role_id, team_id) select '${org}', '${uid}', id, '${team}' from roles where key = 'sales_agent' and org_id is null`);
  await inbox.createChannel(a, org, { name: 'Ventas', phoneNumberId: PID, token: 'EAAB-token-abcdefghijklmnopqrstuvwxyz' });
  id.carlos = await mk(s1, 'Carlos Ruiz', '+573001110201', 'Medellín');
  id.dana = await mk(s2, 'Dana Mora', '+573001110202', 'Bogotá');
  id.elena = await mk(a, 'Elena Vega', '+573001110203', 'Medellín');
  await customers.updateCustomer(a, id.elena, { owner_id: null });                       // sin asesor asignado
  await customers.addIdentifier(s2, id.dana, 'email', 'dana.mora@ejemplo.com');
  await createAdminClient().rpc('ingest_whatsapp_message', { p_phone_number_id: PID, p_thread: '573001110201', p_contact_name: 'Carlos Ruiz', p_external_id: 'kb.1', p_kind: 'text', p_body: 'hola', p_occurred_at: new Date().toISOString(), p_meta: {} });
  id.convCarlos = sql(`select id from conversations where thread_key = '573001110201' and org_id = '${org}'`);

  id.o1 = await opps.createOpportunity(s1, { customerId: id.carlos, title: 'Compra de sillas', amount: 1000000, productInterest: 'Silla ergonómica' });
  id.o2 = await opps.createOpportunity(s2, { customerId: id.dana, title: 'Compra de mesas', amount: 500000 });
  id.o3 = await opps.createOpportunity(a, { customerId: id.elena, title: 'Wallpanel oficina', amount: 2500000, productInterest: 'Wallpanel' });
  id.o4 = await opps.createOpportunity(s1, { customerId: id.carlos, title: 'Proyecto grande', amount: 4000000 });
  await createProduct(a, org, { kind: 'product', sku: 'SIL-1', name: 'Silla', unit: 'unidad', unitPrice: 250000, taxRate: 19 });
  id.silla = (await listProducts(a, { orgId: org })).find((p) => p.sku === 'SIL-1')!.id;
  const q = await quotes.createQuote(s1, id.o4);
  await quotes.addItem(s1, q, { productId: id.silla, quantity: 4, discountPct: 0 });

  pipeline = (await listPipelines(a, org)).find((p) => p.isDefault)!;
  for (const s of pipeline.stages) st[s.name] = s.id;
  members = await listMembers(a, org);
  await boardRepo.setOpportunityFields(s1, id.o1, { priority: 'high', temperature: 'hot', channel: 'whatsapp' });
  await opps.moveOpportunity(a, id.o3, st['Cotización']!);
  await opps.moveOpportunity(s2, id.o2, st['Perdida']!, 'Compró con la competencia');
  await opps.moveOpportunity(a, id.o4, st['Ganada']!);
}, 90_000);

describe('el tablero carga tarjetas reales', () => {
  it('etapas por defecto, números correlativos y datos de cada tarjeta', async () => {
    expect(pipeline.stages.filter((s) => s.kind === 'open').sort((x, y) => x.position - y.position).map((s) => s.name)).toEqual(['Nueva', 'Contactado', 'Calificada', 'Cotización', 'Negociación']);
    const { cards } = await load(a);
    expect(cards.map((c) => c.number).sort()).toEqual(['OPP-0001', 'OPP-0002', 'OPP-0003', 'OPP-0004']);
    const o1 = cards.find((c) => c.id === id.o1)!;
    expect(o1).toMatchObject({ customerName: 'Carlos Ruiz', title: 'Compra de sillas', amount: 1000000, priority: 'high', temperature: 'hot', channel: 'whatsapp', status: 'open', product: 'Silla ergonómica' });
    expect(o1.ownerName).toBe('s1@kb.test');
    expect(cards.find((c) => c.id === id.o3)!.ownerName).toBeNull();                       // sin asesor asignado
    expect(cards.find((c) => c.id === id.o4)!.product).toBe('Silla');                       // sin interés declarado: el 1.er producto de su cotización
  });
  it('una oportunidad hereda la conversación y el canal del cliente al crearse', async () => {
    const { cards } = await load(a);
    expect(cards.find((c) => c.id === id.o4)).toMatchObject({ conversationId: id.convCarlos, channel: 'whatsapp' });
    expect(cards.find((c) => c.id === id.o2)).toMatchObject({ conversationId: null, channel: null });
  });
  it('ganadas y perdidas aparecen solo si cerraron en los últimos 30 días (salvo al filtrar por su etapa)', async () => {
    expect((await load(a)).cards.map((c) => c.status).sort()).toEqual(['lost', 'open', 'open', 'won']);
    sql(`update opportunities set closed_at = now() - interval '40 days' where id = '${id.o2}'`);
    expect(await titles(a)).not.toContain('Compra de mesas');
    expect(await titles(a, { etapa: st['Perdida']! })).toEqual(['Compra de mesas']);
    sql(`update opportunities set closed_at = now() where id = '${id.o2}'`);
    expect(await titles(a)).toContain('Compra de mesas');
  });
  it('visibilidad por rol: cada vendedor ve solo lo de sus clientes', async () => {
    expect(await titles(s1)).toEqual(['Compra de sillas', 'Proyecto grande']);
    expect(await titles(s2)).toEqual(['Compra de mesas']);
    expect(await titles(a)).toHaveLength(4);
  });
});

describe('filtros (se combinan)', () => {
  it('asesor, equipo, canal, prioridad, temperatura, etapa', async () => {
    expect(await titles(a, { asesor: S1 })).toEqual(['Compra de sillas', 'Proyecto grande']);
    expect(await titles(a, { asesor: 'none' })).toEqual(['Wallpanel oficina']);
    expect(await titles(a, { equipo: T2 })).toEqual(['Compra de mesas']);
    expect(await titles(a, { canal: 'whatsapp' })).toEqual(['Compra de sillas', 'Proyecto grande']);
    expect(await titles(a, { canal: 'instagram' })).toEqual([]);
    expect(await titles(a, { prioridad: 'high' })).toEqual(['Compra de sillas']);
    expect(await titles(a, { prioridad: 'low' })).toEqual([]);
    expect(await titles(a, { temperatura: 'hot' })).toEqual(['Compra de sillas']);
    expect(await titles(a, { etapa: st['Cotización']! })).toEqual(['Wallpanel oficina']);
  });
  it('región (ciudad del cliente), producto y valor', async () => {
    expect(await titles(a, { region: 'medellín' })).toEqual(['Compra de sillas', 'Proyecto grande', 'Wallpanel oficina']);
    expect(await titles(a, { region: 'Cali' })).toEqual([]);
    expect(await titles(a, { producto: id.silla })).toEqual(['Compra de sillas', 'Proyecto grande']);   // por cotización y por interés declarado
    expect(await titles(a, { min: '1500000' })).toEqual(['Proyecto grande', 'Wallpanel oficina']);
    expect(await titles(a, { max: '600000' })).toEqual(['Compra de mesas']);
    expect(await titles(a, { min: '1000000', max: '2500000' })).toEqual(['Compra de sillas', 'Wallpanel oficina']);
  });
  it('fecha de creación y de cierre estimado', async () => {
    expect(await titles(a, { creada: '7d' })).toHaveLength(4);
    sql(`update opportunities set created_at = now() - interval '60 days' where id = '${id.o3}'`);
    expect(await titles(a, { creada: '30d' })).not.toContain('Wallpanel oficina');
    expect(await titles(a, { creada: '90d' })).toContain('Wallpanel oficina');
    sql(`update opportunities set expected_close_date = current_date - 5 where id = '${id.o1}'; update opportunities set expected_close_date = current_date + 3 where id = '${id.o3}'`);
    expect(await titles(a, { cierre: 'vencidas' })).toEqual(['Compra de sillas']);
    expect(await titles(a, { cierre: 'semana' })).toEqual(['Wallpanel oficina']);
    expect(await titles(a, { cierre: 'sin' })).toEqual(['Compra de mesas', 'Proyecto grande']);
  });
  it('varios a la vez: Región + Asesor + Etapa', async () => {
    expect(await titles(a, { region: 'Medellín', asesor: S1, etapa: st['Nueva']! })).toEqual(['Compra de sillas']);
    expect(await titles(a, { region: 'Bogotá', asesor: S1 })).toEqual([]);
  });
});

describe('búsqueda', () => {
  it('por cliente, teléfono, correo, oportunidad, número, producto y texto de la cotización', async () => {
    expect(await titles(a, { q: 'dana' })).toEqual(['Compra de mesas']);
    expect(await titles(a, { q: '3001110203' })).toEqual(['Wallpanel oficina']);
    expect(await titles(a, { q: '300 111 0203' })).toEqual(['Wallpanel oficina']);
    expect(await titles(a, { q: 'dana.mora@ejemplo' })).toEqual(['Compra de mesas']);
    expect(await titles(a, { q: 'proyecto' })).toEqual(['Proyecto grande']);
    expect(await titles(a, { q: 'OPP-0003' })).toEqual(['Wallpanel oficina']);
    expect(await titles(a, { q: 'wallpanel' })).toEqual(['Wallpanel oficina']);
    expect(await titles(a, { q: 'silla' })).toEqual(['Compra de sillas', 'Proyecto grande']);
    expect(await titles(a, { q: 'no existe jamás' })).toEqual([]);
  });
  it('búsqueda + filtros; y una búsqueda hostil no rompe nada ni filtra de más', async () => {
    expect(await titles(a, { q: 'silla', asesor: S1, prioridad: 'high' })).toEqual(['Compra de sillas']);
    for (const evil of ['x,customer_id.neq.0)', 'a),or(id.not.is.null', '%', "'; drop table opportunities; --"]) expect(Array.isArray((await load(a, Q({ q: evil }))).cards)).toBe(true);
    expect(await titles(a, { q: 'x,customer_id.neq.0)' })).toEqual([]);
    expect(sql('select count(*) from opportunities')).not.toBe('0');
  });
  it('la búsqueda respeta la visibilidad', async () => {
    expect(await titles(s1, { q: 'dana' })).toEqual([]);
    expect(await titles(s2, { q: 'silla' })).toEqual([]);
  });
});

describe('movimientos, reglas e historial', () => {
  it('mover registra quién, cuándo y de qué etapa a cuál; el motivo de la pérdida queda guardado', async () => {
    await kanban.moveCard(s1, { id: id.o1, stageId: st['Contactado']! });
    await kanban.moveCard(s1, { id: id.o1, stageId: st['Calificada']! });
    const t = await opps.listTransitions(a, 'opportunity', id.o1);
    expect(t.map((x) => [x.fromState, x.toState, x.actorId])).toEqual([['Contactado', 'Calificada', S1], ['Nueva', 'Contactado', S1], [null, 'Nueva', S1]]);
    const [h] = buildHistory(t, [], (u) => members.find((m) => m.userId === u)?.email ?? '?');
    expect(h!.text).toBe('s1@kb.test movió la oportunidad de Contactado a Calificada.');
    const lost = await opps.listTransitions(a, 'opportunity', id.o2);
    expect(lost[0]).toMatchObject({ fromState: 'Nueva', toState: 'Perdida', reason: 'Compró con la competencia', actorId: S2 });
  });
  it('perder sin motivo se rechaza con un mensaje claro y no cambia nada', async () => {
    const e = await rejects(kanban.moveCard(s1, { id: id.o1, stageId: st['Perdida']! }));
    expect(toUserMessage(e)).toMatch(/motivo/i);
    expect((await opps.getOpportunity(s1, id.o1))!.status).toBe('open');
  });
  it('una cerrada solo la reabre un manager/administrador', async () => {
    expect(toUserMessage(await rejects(kanban.moveCard(s2, { id: id.o2, stageId: st['Nueva']! })))).toMatch(/manager o administrador/);
    await kanban.moveCard(a, { id: id.o2, stageId: st['Nueva']! });
    expect((await opps.getOpportunity(a, id.o2))!).toMatchObject({ status: 'open', lostReason: null });
    await kanban.moveCard(s2, { id: id.o2, stageId: st['Perdida']! , reason: 'Sin presupuesto' });
    expect((await opps.getOpportunity(a, id.o2))!.status).toBe('lost');
  });
  it('un vendedor no mueve oportunidades ajenas', async () => {
    const e = await rejects(kanban.moveCard(s2, { id: id.o1, stageId: st['Negociación']! }));
    expect(e.code).toBe('42501');
    expect(toUserMessage(e)).toMatch(/permiso/i);
  });
  it('prioridad, temperatura y canal: cambian con validación y solo quien puede', async () => {
    await kanban.setFields(s1, { id: id.o4, priority: 'low', temperature: 'warm', channel: 'email' });
    expect(await opps.getOpportunity(s1, id.o4)).toMatchObject({ priority: 'low', temperature: 'warm', channel: 'email' });
    await kanban.setFields(s1, { id: id.o4, temperature: '', channel: '' });
    expect(await opps.getOpportunity(s1, id.o4)).toMatchObject({ priority: 'low', temperature: null, channel: null });
    await rejects(kanban.setFields(s2, { id: id.o1, priority: 'low' }));                              // ajena: no se modifica
    expect((await opps.getOpportunity(a, id.o1))!.priority).toBe('high');
    expect(toUserMessage(await rejects(kanban.setFields(s1, { id: id.o1, priority: 'urgente' })))).toMatch(/Prioridad no válida/);
  });
});

describe('detalle y conversación', () => {
  it('el detalle reúne cliente, cotizaciones, productos, actividades e historial', async () => {
    await kanban.logActivity(s1, { opportunityId: id.o4, customerId: id.carlos, type: 'call', summary: 'Confirmó la cantidad' });
    const d = (await boardRepo.loadOpportunityDetail(s1, org, id.o4))!;
    expect(d.customer.fullName).toBe('Carlos Ruiz');
    expect(d.identifiers.map((i) => i.value)).toContain('+573001110201');
    expect(d.quotes).toHaveLength(1);
    expect(d.products).toEqual([expect.objectContaining({ description: 'Silla', quantity: 4 })]);
    expect(d.productsFrom).toBe(d.quotes[0]!.number);
    expect(d.activities.map((x) => x.summary)).toEqual(['Confirmó la cantidad']);
    const hist = buildHistory(d.transitions, d.activities, () => 'Alguien');
    expect(hist.map((h) => h.kind)).toContain('stage');
    expect(hist.map((h) => h.kind)).toContain('activity');
  });
  it('una oportunidad ajena o inexistente devuelve null', async () => {
    expect(await boardRepo.loadOpportunityDetail(s2, org, id.o4)).toBeNull();
    expect(await boardRepo.loadOpportunityDetail(s1, org, '00000000-0000-4000-8000-000000000000')).toBeNull();
  });
  it('vincular la conversación del MISMO cliente; la de otro cliente se rechaza en español', async () => {
    await kanban.linkConversation(s1, { id: id.o1, conversationId: '' });
    expect((await opps.getOpportunity(s1, id.o1))!.conversationId).toBeNull();
    await kanban.linkConversation(s1, { id: id.o1, conversationId: id.convCarlos });
    expect((await opps.getOpportunity(s1, id.o1))!.conversationId).toBe(id.convCarlos);
    expect(toUserMessage(await rejects(kanban.linkConversation(s2, { id: id.o2, conversationId: id.convCarlos })))).toMatch(/permiso|otro cliente/i);
    expect(toUserMessage(await rejects(kanban.linkConversation(a, { id: id.o2, conversationId: id.convCarlos })))).toMatch(/otro cliente/);
  });
  it('las ciudades de los clientes se sugieren ordenadas por frecuencia', async () => {
    expect(await boardRepo.listCities(a, org)).toEqual(['Medellín', 'Bogotá']);
  });
});

describe('búsqueda por número no se confunde con teléfonos', () => {
  it('«OPP-0004» encuentra solo esa oportunidad, aunque otro cliente tenga un teléfono que termina en 0004', async () => {
    const zoe = await mk(a, 'Zoe Prieto', '+573000000004', 'Cali');
    await opps.createOpportunity(a, { customerId: zoe, title: 'Oportunidad de Zoe', amount: 1 });
    expect(await titles(a, { q: 'OPP-0004' })).toEqual(['Proyecto grande']);
    expect(await titles(a, { q: '0004' })).toEqual(['Oportunidad de Zoe', 'Proyecto grande']);   // solo dígitos: busca en teléfonos y en números
  });
});

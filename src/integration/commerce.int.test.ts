/**
 * Integración Fase 4 contra PostgREST + Postgres reales: catálogo, cotizaciones, ventas, postventa y casos,
 * usando los MISMOS repositorios y servicios que la aplicación (usuarios reales con JWT firmados).
 */
import { createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';

vi.mock('server-only', () => ({}));

import type { ServerSupabase } from '@/lib/supabase/server';
import { DbError, toUserMessage } from '@/lib/errors';
import { describeEvent } from '@/lib/timeline';
import { createOrganization } from '@/repositories/organizations';
import * as customers from '@/repositories/customers';
import * as pipes from '@/repositories/pipelines';
import * as oppsRepo from '@/repositories/opportunities';
import * as tasksRepo from '@/repositories/tasks';
import * as productsRepo from '@/repositories/products';
import * as quotesRepo from '@/repositories/quotes';
import * as salesRepo from '@/repositories/sales';
import * as sales from '@/services/sales';
import * as commerce from '@/services/commerce';

const REST_URL = process.env.REST_URL!;
const SECRET = process.env.JWT_SECRET!;
const DB = process.env.INT_DB!;

const A = 'aaaaaaaa-2222-0000-0000-00000000000a';
const S1 = '51000000-2222-0000-0000-000000000001';
const S2 = '52000000-2222-0000-0000-000000000002';
const M = '4d000000-2222-0000-0000-00000000000d';
const CS = 'c5000000-2222-0000-0000-0000000000c5';

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

const a = asUser(A), s1 = asUser(S1), s2 = asUser(S2), m = asUser(M), cs = asUser(CS);
let org = '';
let carlos = '';
let opp = '';
let quote = '';
let sale = '';

beforeAll(async () => {
  for (const [id, email] of [[A, 'a@com.test'], [S1, 's1@com.test'], [S2, 's2@com.test'], [M, 'm@com.test'], [CS, 'cs@com.test']]) {
    sql(`insert into auth.users (id, email) values ('${id}', '${email}')`);
  }
  org = await createOrganization(a, 'Comercio Int', 'comercio-int');
  for (const [uid, role] of [[S1, 'sales_agent'], [S2, 'sales_agent'], [M, 'manager'], [CS, 'customer_service']]) {
    sql(`insert into memberships (org_id, user_id, role_id) select '${org}', '${uid}', id from roles where key = '${role}' and org_id is null`);
  }
  const r = await customers.createCustomer(s1, org, 'person', 'Carlos Rodríguez', [{ type: 'phone', value: '+573001112233' }], {});
  if (r.outcome !== 'created') throw new Error('setup');
  carlos = r.customerId;
  opp = await sales.createOpportunity(s1, { customerId: carlos, title: 'Plan A', amount: '1' });
});

describe('catálogo', () => {
  it('el manager crea productos (precios escritos como persona); un vendedor los ve pero no los crea', async () => {
    await commerce.createProduct(m, org, { kind: 'service', sku: 'CON-1', name: 'Consultoría', unit: 'hora', unitPrice: '$ 100.000', taxRate: '19' });
    await commerce.createProduct(m, org, { kind: 'product', sku: 'SIL-1', name: 'Silla', unitPrice: '250.000', taxRate: '19' });
    const list = await productsRepo.listProducts(s1, { orgId: org });
    expect(list.map((p) => p.name).sort()).toEqual(['Consultoría', 'Silla']);
    expect(list.find((p) => p.sku === 'CON-1')).toMatchObject({ kind: 'service', unitPrice: 100000, taxRate: 19, unit: 'hora' });
    const err = await rejects(commerce.createProduct(s1, org, { kind: 'product', name: 'Hack', unitPrice: '1' }));
    expect(err.code).toBe('42501');
    expect(toUserMessage(await rejects(commerce.createProduct(m, org, { kind: 'product', sku: 'sil-1', name: 'Otra', unitPrice: '1' })))).toMatch(/SKU/);
  });
  it('búsqueda por nombre o código y filtro por tipo', async () => {
    expect((await productsRepo.listProducts(s1, { orgId: org, q: 'sil' })).map((p) => p.sku)).toEqual(['SIL-1']);
    expect((await productsRepo.listProducts(s1, { orgId: org, kind: 'service' })).map((p) => p.sku)).toEqual(['CON-1']);
  });
});

describe('cotización: de borrador a aceptada', () => {
  it('se crea numerada; el dinero lo calcula la base de datos', async () => {
    quote = await commerce.createQuote(s1, opp, { notes: 'Prueba' });
    const [con, sil] = await productsRepo.listProducts(s1, { orgId: org });
    await commerce.addItem(s1, quote, { productId: con!.id, quantity: '2' });
    await commerce.addItem(s1, quote, { productId: sil!.id, quantity: '3', discountPct: '10' });
    const q = (await quotesRepo.getQuote(s1, quote))!;
    expect(q).toMatchObject({ number: 'COT-0001', version: 1, status: 'draft', subtotal: 950000, discountTotal: 75000, taxTotal: 166250, total: 1041250, maxDiscountPct: 10 });
    const items = await quotesRepo.listItems(s1, quote);
    expect(items.map((i) => i.lineTotal)).toEqual([238000, 803250]);
  });
  it('el catálogo puede cambiar sin alterar lo cotizado', async () => {
    const [con] = await productsRepo.listProducts(s1, { orgId: org, kind: 'service' });
    await commerce.updateProduct(m, con!.id, { name: 'Consultoría PREMIUM', unitPrice: '999.999', taxRate: '19' });
    const items = await quotesRepo.listItems(s1, quote);
    expect(items[0]).toMatchObject({ description: 'Consultoría', unitPrice: 100000 });
  });
  it('S2 no la ve; los errores llegan en español', async () => {
    expect(await quotesRepo.getQuote(s2, quote)).toBeNull();
    expect((await rejects(commerce.addItem(s2, quote, { description: 'X', unitPrice: '1' }))).code).toBe('42501');
    expect(toUserMessage(await rejects(commerce.addItem(s1, quote, { description: 'X', unitPrice: '1', discountPct: '200' })))).toMatch(/entre 0 y 100/);
  });
  it('enviarla la congela; los descuentos altos requieren a un manager', async () => {
    await quotesRepo.sendQuote(s1, quote);
    expect(toUserMessage(await rejects(commerce.addItem(s1, quote, { description: 'X', unitPrice: '1' })))).toMatch(/nueva versión/i);
    expect(toUserMessage(await rejects(commerce.updateItem(s1, (await quotesRepo.listItems(s1, quote))[0]!.id, { quantity: '1', unitPrice: '1', discountPct: '0' })))).toMatch(/nueva versión/i);

    const q2 = await commerce.createQuote(s1, opp, {});
    await commerce.addItem(s1, q2, { description: 'Con descuento alto', unitPrice: '1.000.000', discountPct: '25', taxRate: '19' });
    expect(toUserMessage(await rejects(quotesRepo.sendQuote(s1, q2)))).toMatch(/manager o administrador debe enviarla/);
    await quotesRepo.sendQuote(m, q2);
    expect((await quotesRepo.getQuote(s1, q2))?.status).toBe('sent');
    await quotesRepo.rejectQuote(s1, q2, 'Muy caro');
    // el historial llega del más reciente al más antiguo
    expect((await oppsRepo.listTransitions(s1, 'quote', q2)).map((t) => t.toState)).toEqual(['rejected', 'sent', 'draft']);
    const v2 = await quotesRepo.reviseQuote(s1, q2);
    expect(await quotesRepo.getQuote(s1, v2)).toMatchObject({ number: 'COT-0002', version: 2, status: 'draft', total: 892500 });
    expect((await quotesRepo.listVersions(s1, org, 'COT-0002')).map((v) => v.version)).toEqual([2, 1]);
  });
  it('solo una cotización aceptada por oportunidad', async () => {
    await quotesRepo.acceptQuote(s1, quote);
    const other = await commerce.createQuote(s1, opp, {});
    await commerce.addItem(s1, other, { description: 'Otra', unitPrice: '100' });
    await quotesRepo.sendQuote(s1, other);
    expect(toUserMessage(await rejects(quotesRepo.acceptQuote(s1, other)))).toMatch(/ya tiene una cotización aceptada/);
  });
});

describe('venta y postventa', () => {
  it('un vendedor no registra ventas; el manager sí, y se cierra la oportunidad con seguimiento', async () => {
    expect((await rejects(salesRepo.createSale(s1, quote))).code).toBe('42501');
    sale = await salesRepo.createSale(m, quote);
    const sv = (await salesRepo.getSale(s1, sale))!;
    expect(sv).toMatchObject({ number: 'VTA-0001', status: 'confirmed', total: 1041250, customerId: carlos, ownerId: S1 });
    expect((await salesRepo.listSaleItems(s1, sale)).map((i) => i.lineTotal)).toEqual([238000, 803250]);
    expect(await oppsRepo.getOpportunity(s1, opp)).toMatchObject({ status: 'won', amount: 875000 });
    const tasks = await tasksRepo.listTasks(s1, { orgId: org, opportunityId: opp, limit: 20 });
    expect(tasks.filter((t) => t.description?.startsWith('Seguimiento postventa de VTA-0001'))).toHaveLength(3);
    expect(toUserMessage(await rejects(salesRepo.createSale(m, quote)))).toMatch(/ya tiene una venta/);
    expect(await salesRepo.getSale(s2, sale)).toBeNull();
  });
  it('la foto de la venta es inmutable incluso para el propio dueño', async () => {
    const err = await rejects(Promise.resolve((s1 as unknown as { from: (t: string) => { update: (v: unknown) => { eq: (c: string, v: string) => Promise<{ error: unknown }> } } })
      .from('sales').update({ total: 1 }).eq('id', sale).then((r) => { if (r.error) throw Object.assign(new Error('x'), r.error); })));
    expect(err.code).toBe('42501');
  });
  it('solo un manager anula (con motivo); el seguimiento pendiente se cancela', async () => {
    expect(toUserMessage(await rejects(salesRepo.cancelSale(s1, sale, 'Error')))).toBeTruthy();
    await salesRepo.cancelSale(m, sale, 'El cliente desistió');
    expect(await salesRepo.getSale(s1, sale)).toMatchObject({ status: 'cancelled', cancelReason: 'El cliente desistió' });
    const tasks = await tasksRepo.listTasks(s1, { orgId: org, opportunityId: opp, limit: 20 });
    expect(tasks.filter((t) => t.description?.startsWith('Seguimiento postventa de VTA-0001') && t.status === 'open')).toHaveLength(0);
  });
  it('la línea de tiempo del cliente narra cotizaciones y ventas', async () => {
    const events = await customers.timeline(s1, carlos, 200);
    const titles = events.map((e) => describeEvent(e, () => 'Alguien').title);
    expect(titles).toEqual(expect.arrayContaining(['Cotización creada', 'Cotización enviada', '✔ Cotización aceptada', '🎉 Venta registrada', 'Venta anulada']));
  });
});

describe('casos', () => {
  let caseId = '';
  it('servicio al cliente abre casos de SUS clientes y los gestiona hasta cerrar', async () => {
    sql(`update customers set owner_id = '${CS}' where id = '${carlos}'`);
    caseId = await commerce.openCase(cs, org, { customerId: carlos, title: 'No llegó el pedido', kind: 'support', priority: 'high' });
    expect((await salesRepo.listCases(cs, { orgId: org })).map((c) => c.number)).toEqual(['CAS-0001']);
    await commerce.changeCaseStatus(cs, caseId, 'in_progress');
    expect(toUserMessage(await rejects(commerce.changeCaseStatus(cs, caseId, 'resolved', '')))).toMatch(/cómo se resolvió/);
    await commerce.changeCaseStatus(cs, caseId, 'resolved', 'Se reenvió el pedido');
    await commerce.changeCaseStatus(cs, caseId, 'closed');
    expect((await salesRepo.listCases(cs, { orgId: org, openOnly: true }))).toHaveLength(0);
    expect((await salesRepo.listCases(cs, { orgId: org }))[0]).toMatchObject({ status: 'closed', resolution: 'Se reenvió el pedido' });
  });
  it('reabrir un caso cerrado es cosa del manager; S2 no ve casos ajenos', async () => {
    expect(toUserMessage(await rejects(commerce.changeCaseStatus(cs, caseId, 'open')))).toMatch(/manager o administrador puede reabrir/);
    await commerce.changeCaseStatus(m, caseId, 'open', 'Sigue sin llegar');
    expect((await salesRepo.listCases(s2, { orgId: org }))).toHaveLength(0);
    expect((await oppsRepo.listTransitions(m, 'case', caseId)).map((t) => t.toState)).toEqual(['open', 'closed', 'resolved', 'in_progress', 'open']);
  });
});

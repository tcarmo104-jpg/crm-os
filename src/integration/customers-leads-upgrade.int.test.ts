/**
 * Integración de la mejora de Clientes y Leads contra PostgREST + Postgres reales: crear un lead a mano
 * (de punta a punta, con la misma resolución de identidad que la importación CSV), los filtros nuevos de
 * `listLeads` y `listCustomers` (etiqueta, ciudad, tipo, «no contactar»), y las listas de opciones para los filtros.
 */
import { createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';

vi.mock('server-only', () => ({}));

import type { ServerSupabase } from '@/lib/supabase/server';
import { UserFacingError } from '@/lib/errors';
import { createOrganization } from '@/repositories/organizations';
import * as customers from '@/repositories/customers';
import * as leadsRepo from '@/repositories/leads';
import * as leadsService from '@/services/leads';
import * as inboxService from '@/services/inbox';

const REST_URL = process.env.REST_URL!, SECRET = process.env.JWT_SECRET!, DB = process.env.INT_DB!;
const A = 'aaaaaaaa-e505-0000-0000-00000000000a', S1 = '51000000-e505-0000-0000-000000000001';
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (c: Record<string, unknown>) => { const h = b64({ alg: 'HS256', typ: 'JWT' }), p = b64({ ...c, exp: Math.floor(Date.now() / 1000) + 3600 }); return `${h}.${p}.${createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url')}`; };
const client = (token: string) => createClient(REST_URL, token, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${token}` } } }) as unknown as ServerSupabase;
const asUser = (uid: string) => client(jwt({ role: 'authenticated', sub: uid }));
const sql = (q: string) => execFileSync('psql', ['-X', '-tA', '-d', DB, '-c', q], { encoding: 'utf8' }).trim();
const a = asUser(A), s1 = asUser(S1);
let org = '';

beforeAll(async () => {
  for (const [id, email] of [[A, 'a@cl.test'], [S1, 's1@cl.test']]) sql(`insert into auth.users (id, email) values ('${id}', '${email}')`);
  org = await createOrganization(a, 'Clientes Leads Int', 'clientes-leads-int');
  sql(`insert into memberships (org_id, user_id, role_id) select '${org}', '${S1}', id from roles where key = 'sales_agent' and org_id is null`);
}, 30_000);

describe('crear un lead a mano, de punta a punta', () => {
  it('crea el cliente y el lead, y el lead aparece con los filtros nuevos de listLeads', async () => {
    const r = await leadsService.createLead(a, org, { name: 'Diana Torres', phone: '+573101110001', source: 'feria', productInterest: 'Cielo raso' });
    expect(r.outcome).toBe('created'); expect(r.deduplicated).toBe(false);
    const bySource = await leadsRepo.listLeads(a, { orgId: org, source: 'feria' });
    expect(bySource.items.some((l) => l.id === r.leadId)).toBe(true);
    const byResolution = await leadsRepo.listLeads(a, { orgId: org, resolution: 'created' });
    expect(byResolution.items.some((l) => l.id === r.leadId)).toBe(true);
    const byText = await leadsRepo.listLeads(a, { orgId: org, q: 'Cielo raso' });
    expect(byText.items.map((l) => l.id)).toContain(r.leadId);
  });
  it('el MISMO teléfono no duplica el cliente, pero sí crea un nuevo lead (misma lógica que el CSV)', async () => {
    const r1 = await leadsService.createLead(a, org, { name: 'Cliente Repetido', phone: '+573101110002', source: 'web' });
    const r2 = await leadsService.createLead(a, org, { name: 'Cliente Repetido', phone: '+573101110002', source: 'referido' });
    expect(r2.customerId).toBe(r1.customerId); expect(r2.leadId).not.toBe(r1.leadId); expect(r2.outcome).toBe('matched');
  });
  it('un vendedor que crea un lead queda como su propietario (no ve toda la cartera)', async () => {
    const r = await leadsService.createLead(s1, org, { name: 'Cliente De Vendedor', phone: '+573101110003', source: 'web' });
    const rows = await leadsRepo.listLeads(s1, { orgId: org, ownerId: S1 });
    expect(rows.items.some((l) => l.id === r.leadId)).toBe(true);
  });
  it('sin teléfono ni correo se rechaza antes de tocar la base de datos', async () => {
    await expect(leadsService.createLead(a, org, { name: 'Sin contacto', source: 'web' })).rejects.toBeInstanceOf(UserFacingError);
  });
  it('«listLeadSources» trae las fuentes ya usadas, sin repetir', async () => {
    const sources = await leadsRepo.listLeadSources(a, org);
    expect(sources).toEqual(expect.arrayContaining(['feria', 'web', 'referido']));
    expect(new Set(sources).size).toBe(sources.length);
  });
});

describe('filtros nuevos de Clientes: etiqueta, ciudad, tipo y «no contactar»', () => {
  it('por ciudad y por tipo (persona/empresa)', async () => {
    const p1 = await customers.createCustomer(a, org, 'person', 'Persona Bogotá', [{ type: 'phone', value: '+573101110010' }], { city: 'Bogotá' });
    const c1 = await customers.createCustomer(a, org, 'company', 'Empresa Medellín', [{ type: 'phone', value: '+573101110011' }], { city: 'Medellín' });
    const byCity = await customers.listCustomers(a, { orgId: org, userId: A, city: 'Bogotá' });
    expect(byCity.items.map((c) => c.id)).toContain(p1.customerId);
    expect(byCity.items.map((c) => c.id)).not.toContain(c1.customerId);
    const byType = await customers.listCustomers(a, { orgId: org, userId: A, type: 'company' });
    expect(byType.items.every((c) => c.type === 'company')).toBe(true);
    expect(byType.items.map((c) => c.id)).toContain(c1.customerId);
    const cities = await customers.listCitiesUsed(a, org);
    expect(cities).toEqual(expect.arrayContaining(['Bogotá', 'Medellín']));
  });
  it('por «no contactar»', async () => {
    const r = await customers.createCustomer(a, org, 'person', 'Cliente DNC', [{ type: 'phone', value: '+573101110012' }], {});
    const id = r.customerId!;
    await customers.updateCustomer(a, id, { do_not_contact: true, dnc_reason: 'Pidió no ser contactado' });
    const rows = await customers.listCustomers(a, { orgId: org, userId: A, doNotContact: true });
    expect(rows.items.map((c) => c.id)).toContain(id);
    expect((await customers.listCustomers(a, { orgId: org, userId: A, doNotContact: false })).items.map((c) => c.id)).not.toContain(id);
  });
  it('por etiqueta: reutiliza el mismo sistema de etiquetas del Inbox, sin tabla nueva', async () => {
    const r1 = await customers.createCustomer(a, org, 'person', 'Cliente Etiquetado', [{ type: 'phone', value: '+573101110013' }], {});
    const r2 = await customers.createCustomer(a, org, 'person', 'Cliente Sin Etiqueta', [{ type: 'phone', value: '+573101110014' }], {});
    const id1 = r1.customerId!, id2 = r2.customerId!;
    const tagId = await inboxService.addTag(a, { customerId: id1, name: 'VIP Prueba Integración' });
    const rows = await customers.listCustomers(a, { orgId: org, userId: A, tagId });
    expect(rows.items.map((c) => c.id)).toEqual([id1]);
    expect(rows.items.map((c) => c.id)).not.toContain(id2);
  });
  it('una organización sin ningún cliente con esa etiqueta devuelve una lista vacía (no un error)', async () => {
    const rows = await customers.listCustomers(a, { orgId: org, userId: A, tagId: '00000000-0000-4000-8000-000000000000' });
    expect(rows).toEqual({ items: [], nextCursor: null });
  });
});

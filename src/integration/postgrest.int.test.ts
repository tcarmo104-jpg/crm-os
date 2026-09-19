/**
 * Pruebas de INTEGRACIÓN: los repositorios y la ruta pública de la API reales, contra PostgREST + Postgres
 * con todas las migraciones y RLS. Ejecutar con scripts/test-postgrest.sh (no corren en `npm test`).
 */
import { createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';

vi.mock('server-only', () => ({}));

import type { ServerSupabase } from '@/lib/supabase/server';
import { DbError, toUserMessage } from '@/lib/errors';
import { createOrganization } from '@/repositories/organizations';
import * as customers from '@/repositories/customers';
import * as leads from '@/repositories/leads';
import * as reviews from '@/repositories/reviews';
import * as fields from '@/repositories/custom-fields';
import * as apiKeys from '@/repositories/api-keys';

const REST_URL = process.env.REST_URL!;
const SECRET = process.env.JWT_SECRET!;
const DB = process.env.INT_DB!;

const A = 'aaaaaaaa-0000-0000-0000-00000000000a';
const S1 = '51000000-0000-0000-0000-000000000001';
const S2 = '52000000-0000-0000-0000-000000000002';
const M = '4d000000-0000-0000-0000-00000000000d';

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
function jwt(claims: Record<string, unknown>) {
  const h = b64({ alg: 'HS256', typ: 'JWT' });
  const p = b64({ ...claims, exp: Math.floor(Date.now() / 1000) + 3600 });
  return `${h}.${p}.${createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url')}`;
}
const client = (token: string) =>
  createClient(REST_URL, token, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  }) as unknown as ServerSupabase;
const asUser = (uid: string) => client(jwt({ role: 'authenticated', sub: uid }));
const sql = (q: string) => execFileSync('psql', ['-X', '-tA', '-d', DB, '-c', q], { encoding: 'utf8' }).trim();
const rejects = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as DbError; } throw new Error('se esperaba un error y no ocurrió'); };

const a = asUser(A), s1 = asUser(S1), s2 = asUser(S2), m = asUser(M);
let org = '';

const phone = '+573001112233';
let carlosId = '';

beforeAll(async () => {
  for (const [id, email] of [[A, 'a@x.test'], [S1, 's1@x.test'], [S2, 's2@x.test'], [M, 'm@x.test']]) {
    sql(`insert into auth.users (id, email) values ('${id}', '${email}')`);
  }
  org = await createOrganization(a, 'Acme Int', 'acme-int');
  for (const [uid, role] of [[S1, 'sales_agent'], [S2, 'sales_agent'], [M, 'manager']]) {
    sql(`insert into memberships (org_id, user_id, role_id) select '${org}', '${uid}', id from roles where key = '${role}' and org_id is null`);
  }
});

describe('clientes vía PostgREST', () => {
  it('crea un cliente y lo encuentra por nombre (sin acentos), teléfono y correo', async () => {
    const r = await customers.createCustomer(s1, org, 'person', 'Carlos Rodríguez',
      [{ type: 'phone', value: phone }, { type: 'email', value: 'carlos@x.com' }], { city: 'Bogotá', country: 'CO' });
    expect(r.outcome).toBe('created');
    if (r.outcome !== 'created') return;
    carlosId = r.customerId;
    for (const q of ['carlos', 'RODRIGUEZ', '300 111 2233', '3001112233', 'CARLOS@X.COM', 'los@x']) {
      const p = await customers.listCustomers(s1, { orgId: org, userId: S1, q });
      expect(p.items.map((c) => c.id), q).toEqual([carlosId]);
    }
  });

  it('las búsquedas hostiles no rompen ni amplían el filtro (sin inyección)', async () => {
    const hostile = ['zzz),id.not.is.null', "'; drop table customers;--", '%', '*', 'a,b', '"x"', '\\', 'x),owner_id.is.null,(y'];
    for (const q of hostile) {
      const p = await customers.listCustomers(m, { orgId: org, userId: M, q });   // M ve TODO: si el filtro se ampliara, devolvería a Carlos
      expect(p.items.map((c) => c.id), q).not.toContain(carlosId);
    }
  });

  it('un alta duplicada de otra persona es genérica y no crea nada', async () => {
    const r = await customers.createCustomer(s2, org, 'person', 'Otro', [{ type: 'phone', value: phone }], {});
    expect(r).toEqual({ outcome: 'duplicate_hidden' });
    expect((await customers.listCustomers(s2, { orgId: org, userId: S2 })).items).toHaveLength(0);
    expect(await customers.getCustomer(s2, carlosId)).toBeNull();
  });

  it('paginación por cursor sin repetir ni omitir, incluso con created_at idéntico (lote en una transacción)', async () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({
      name: `Lote ${i + 1} Cliente`, source: 'csv', identifiers: [{ type: 'phone', value: `+57320000${String(i + 1).padStart(4, '0')}` }],
    }));
    const res = await leads.importLeads(s1, org, rows, false);
    expect(res.filter((r) => r.outcome === 'created')).toHaveLength(30);

    const seen: string[] = [];
    const times: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const p = await customers.listCustomers(s1, { orgId: org, userId: S1, owner: 'all', cursor, limit: 10 });
      seen.push(...p.items.map((c) => c.id));
      times.push(...p.items.map((c) => c.createdAt));
      cursor = p.nextCursor ?? undefined;
      pages++;
    } while (cursor && pages < 10);
    expect(seen).toHaveLength(31);
    expect(new Set(seen).size).toBe(31);
    expect(pages).toBe(4);
    expect([...times].sort().reverse()).toEqual(times);
  });

  it('el manager ve todo; «sin asignar» y reasignación funcionan; el equipo/propietario cambia la visibilidad', async () => {
    const all = await customers.listCustomers(m, { orgId: org, userId: M, limit: 100 });
    expect(all.items).toHaveLength(31);

    const rows = Array.from({ length: 5 }, (_, i) => ({ name: `Sin dueño ${i + 1} X`, identifiers: [{ type: 'phone', value: `+57330000000${i + 1}` }] }));
    await leads.importLeads(m, org, rows, false);
    const none = await customers.listCustomers(m, { orgId: org, userId: M, owner: 'none' });
    expect(none.items).toHaveLength(5);
    expect(await customers.listCustomers(s1, { orgId: org, userId: S1, owner: 'none' })).toMatchObject({ items: [] });

    const target = none.items[0]!.id;
    await customers.updateCustomer(m, target, { owner_id: S2 });
    expect((await customers.listCustomers(s2, { orgId: org, userId: S2 })).items.map((c) => c.id)).toEqual([target]);
    expect(await customers.getCustomer(s1, target)).toBeNull();
    const e = await rejects(customers.updateCustomer(s1, carlosId, { owner_id: S2 }));
    expect(e.code).toBe('42501');
    expect(toUserMessage(e)).toMatch(/manager o administrador puede reasignar/);
  });

  it('identificadores: `in`, conflicto sin revelar dueño, y borrado protegido por RLS', async () => {
    const ids = await customers.listIdentifiers(s1, [carlosId]);
    expect(ids.map((i) => i.value).sort()).toEqual([phone, 'carlos@x.com']);
    expect(await customers.addIdentifier(s1, carlosId, 'phone', '+573001119999')).toBe('added');
    expect(await customers.addIdentifier(s1, carlosId, 'phone', '+573300000001')).toBe('conflict');  // pertenece a un cliente de nadie visible para S1
    const victim = ids.find((i) => i.type === 'email')!;
    expect((await rejects(customers.removeIdentifier(s2, victim.id))).message).toBeTruthy();       // S2 no ve ese cliente
    await customers.removeIdentifier(s1, victim.id);
    expect((await customers.listIdentifiers(s1, [carlosId])).map((i) => i.type)).not.toContain('email');
  });

  it('línea de tiempo: el propietario la ve; quien no ve al cliente, no', async () => {
    const t = await customers.timeline(s1, carlosId);
    expect(t.map((e) => e.type)).toContain('customer.created');
    expect(await customers.timeline(s2, carlosId)).toEqual([]);
  });

  it('«no contactar»: activar es libre, levantar solo manager (mensaje claro en español)', async () => {
    await customers.updateCustomer(s1, carlosId, { do_not_contact: true, dnc_reason: 'Pidió baja' });
    const c = await customers.getCustomer(s1, carlosId);
    expect(c).toMatchObject({ doNotContact: true, dncReason: 'Pidió baja' });
    expect(c?.dncAt).toBeTruthy();
    const e = await rejects(customers.updateCustomer(s1, carlosId, { do_not_contact: false }));
    expect(toUserMessage(e)).toMatch(/no contactar/);
    await customers.updateCustomer(m, carlosId, { do_not_contact: false });
    expect((await customers.getCustomer(m, carlosId))?.doNotContact).toBe(false);
  });
});

describe('duplicados y fusión vía PostgREST', () => {
  it('mismo nombre → revisión; solo el manager la ve; fusionar une todo', async () => {
    const res = await leads.importLeads(m, org, [
      { name: 'Ana Ruiz', identifiers: [{ type: 'phone', value: '+573101110001' }] },
      { name: 'ana  RUIZ', identifiers: [{ type: 'phone', value: '+573101110002' }] },
    ], false);
    expect(res.map((r) => r.outcome)).toEqual(['created', 'review']);

    const pending = await reviews.listPendingReviews(m, org);
    const rev = pending.find((r) => r.kind === 'possible_duplicate')!;
    expect(rev).toBeTruthy();
    expect(await reviews.listPendingReviews(s1, org)).toEqual([]);

    await reviews.mergeCustomers(m, rev.candidateId!, rev.customerId);
    expect((await reviews.listPendingReviews(m, org)).some((r) => r.id === rev.id)).toBe(false);
    expect(await customers.getCustomer(m, rev.customerId)).toBeNull();
    expect((await customers.listIdentifiers(m, [rev.candidateId!])).map((i) => i.value).sort()).toEqual(['+573101110001', '+573101110002']);
    expect((await customers.timeline(m, rev.candidateId!)).map((e) => e.type)).toContain('customer.merged');
    const e = await rejects(reviews.mergeCustomers(s1, rev.candidateId!, carlosId));
    expect(toUserMessage(e)).toMatch(/no puedes|permiso|manager|no existe/i);
  });
});

describe('campos personalizados vía PostgREST', () => {
  it('admin define; vendedor no; los valores se validan al guardar', async () => {
    await fields.createFieldDefinition(a, org, { entity: 'customer', key: 'nivel', label: 'Nivel', type: 'select', options: ['oro', 'plata'] });
    expect((await rejects(fields.createFieldDefinition(s1, org, { entity: 'customer', key: 'zz', label: 'Z', type: 'text', options: [] }))).code).toBe('42501');
    const defs = await fields.listFieldDefinitions(s1, org, 'customer');
    expect(defs).toHaveLength(1);
    expect(defs[0]).toMatchObject({ key: 'nivel', options: ['oro', 'plata'], archivedAt: null });

    await customers.updateCustomer(s1, carlosId, { custom_fields: { nivel: 'oro' } });
    expect((await customers.getCustomer(s1, carlosId))?.customFields).toEqual({ nivel: 'oro' });
    const e = await rejects(customers.updateCustomer(s1, carlosId, { custom_fields: { nivel: 'bronce' } }));
    expect(toUserMessage(e)).toMatch(/campos personalizados/);

    await fields.setFieldArchived(a, defs[0]!.id, true);
    expect((await fields.listFieldDefinitions(a, org))[0]?.archivedAt).toBeTruthy();
  });
});

describe('API pública POST /api/v1/leads (ruta real, llave real)', () => {
  let key = '';
  let keyId = '';
  const post = async (body: unknown, k = key, raw = false) => {
    const { POST } = await import('@/app/api/v1/leads/route');
    return POST(new Request('http://localhost/api/v1/leads', {
      method: 'POST', headers: { authorization: `Bearer ${k}`, 'content-type': 'application/json' },
      body: raw ? (body as string) : JSON.stringify(body),
    }));
  };

  beforeAll(async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = REST_URL;
    process.env.SUPABASE_SERVICE_ROLE_KEY = jwt({ role: 'service_role' });
    key = await apiKeys.createApiKey(a, org, 'Pruebas');
    keyId = (await apiKeys.listApiKeys(a, org))[0]!.id;
  });

  it('crea un lead, normaliza el teléfono según el país de la organización y NO revela al cliente', async () => {
    const res = await post({ name: 'Laura Gómez', phone: '310 111 2233', email: 'LAURA@X.com', source: 'web', campaign: 'verano', external_id: 'form-1' });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(['deduplicated', 'id', 'warnings']);
    expect(body.deduplicated).toBe(false);
    expect(sql(`select value from customer_identifiers where value in ('+573101112233','laura@x.com') order by value`)).toBe('+573101112233\nlaura@x.com'.split('\n').sort().join('\n'));
  });

  it('es idempotente con external_id (200 la segunda vez, sin duplicar)', async () => {
    const res = await post({ name: 'Laura Gómez', phone: '310 111 2233', source: 'web', external_id: 'form-1' });
    expect(res.status).toBe(200);
    expect((await res.json()).deduplicated).toBe(true);
    expect(sql(`select count(*) from leads where external_id = 'form-1'`)).toBe('1');
  });

  it('una persona que ya es cliente no se duplica y el lead sigue a su responsable', async () => {
    const before = sql(`select count(*) from customers where org_id = '${org}'`);
    const res = await post({ name: 'Carlos R', phone: '+57 300 111 2233', source: 'instagram' });
    expect(res.status).toBe(201);
    expect(sql(`select count(*) from customers where org_id = '${org}'`)).toBe(before);
    expect(sql(`select owner_id from leads where source = 'instagram'`)).toBe(S1);
    expect((await res.json())).not.toHaveProperty('customer_id');
  });

  it('valida entradas con códigos HTTP claros', async () => {
    expect((await post('{no es json', key, true)).status).toBe(400);
    expect((await post([1, 2])).status).toBe(400);
    expect((await post({ name: 'Sin contacto' })).status).toBe(422);
    expect((await post({ phone: '123' })).status).toBe(422);
    expect((await post({ email: 'a@b.co', consent: 'sí' })).status).toBe(400);
    expect((await post({ email: 'cf@b.co', custom_fields: { inexistente: 1 } })).status).toBe(422);
    expect((await post({ email: 'a@b.co' }, 'crm_' + '0'.repeat(64))).status).toBe(401);
  });

  it('los leads recibidos aparecen para el manager y paginan sin repetir', async () => {
    const seen = new Set<string>();
    let cursor: string | undefined;
    let n = 0;
    do {
      const p = await leads.listLeads(m, { orgId: org, cursor, limit: 10 });
      p.items.forEach((l) => seen.add(l.id));
      n += p.items.length;
      cursor = p.nextCursor ?? undefined;
    } while (cursor);
    expect(n).toBe(seen.size);
    expect(n).toBeGreaterThanOrEqual(35);
    expect((await leads.listLeads(s2, { orgId: org })).items.every((l) => l.ownerId === S2)).toBe(true);
  });

  it('aplica el límite de peticiones (429 + Retry-After)', async () => {
    sql(`update api_keys set rate_limit_per_min = 2 where id = '${keyId}'`);
    sql(`delete from api_rate_limits`);
    const codes: number[] = [];
    let retry: string | null = null;
    for (let i = 0; i < 4; i++) {
      const r = await post({ email: `rl${i}@b.co` });
      codes.push(r.status);
      if (r.status === 429) retry = r.headers.get('retry-after');
    }
    expect(codes).toEqual([201, 201, 429, 429]);
    expect(Number(retry)).toBeGreaterThanOrEqual(1);
  });

  it('una llave revocada deja de funcionar de inmediato; un vendedor no puede gestionar llaves', async () => {
    expect((await rejects(apiKeys.createApiKey(s1, org, 'x'))).code).toBe('42501');
    expect(await apiKeys.listApiKeys(s1, org)).toEqual([]);
    await apiKeys.revokeApiKey(a, keyId);
    sql(`delete from api_rate_limits`);
    expect((await post({ email: 'zz@b.co' })).status).toBe(401);
  });
});

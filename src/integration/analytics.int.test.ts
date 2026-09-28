/**
 * Integración de Analítica (Fase 10) contra PostgREST + Postgres reales: los filtros de fecha nuevos en
 * oportunidades, ventas y tareas (usados por Dashboard, Reportes, Embudo y Desempeño), y que cada rol solo
 * ve lo que sus permisos ya le permiten ver (sin lógica de alcance nueva: se apoya en la RLS existente).
 */
import { createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';

vi.mock('server-only', () => ({}));

import type { ServerSupabase } from '@/lib/supabase/server';
import { createOrganization } from '@/repositories/organizations';
import * as customers from '@/repositories/customers';
import * as opportunities from '@/repositories/opportunities';
import * as tasksRepo from '@/repositories/tasks';

const REST_URL = process.env.REST_URL!, SECRET = process.env.JWT_SECRET!, DB = process.env.INT_DB!;
const A = 'aaaaaaaa-a808-0000-0000-00000000000a', S1 = '51000000-a808-0000-0000-000000000001';
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (c: Record<string, unknown>) => { const h = b64({ alg: 'HS256', typ: 'JWT' }), p = b64({ ...c, exp: Math.floor(Date.now() / 1000) + 3600 }); return `${h}.${p}.${createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url')}`; };
const client = (token: string) => createClient(REST_URL, token, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${token}` } } }) as unknown as ServerSupabase;
const asUser = (uid: string) => client(jwt({ role: 'authenticated', sub: uid }));
const sql = (q: string) => execFileSync('psql', ['-X', '-tA', '-d', DB, '-c', q], { encoding: 'utf8' }).trim();
const a = asUser(A), s1 = asUser(S1);
let org = '';

beforeAll(async () => {
  for (const [id, email] of [[A, 'a@an.test'], [S1, 's1@an.test']]) sql(`insert into auth.users (id, email) values ('${id}', '${email}')`);
  org = await createOrganization(a, 'Analitica Int', 'analitica-int');
  sql(`insert into memberships (org_id, user_id, role_id) select '${org}', '${S1}', id from roles where key = 'sales_agent' and org_id is null`);
}, 30_000);

describe('listOpportunities: el filtro por fecha de cierre solo trae lo que quedó cerrado dentro del rango', () => {
  it('deja fuera una oportunidad cerrada antes del rango pedido', async () => {
    const c = await customers.createCustomer(a, org, 'person', 'Cliente Analítica Int', [{ type: 'phone', value: '+573101110040' }], {});
    const oppId = await opportunities.createOpportunity(a, { customerId: c.customerId!, title: 'Oportunidad vieja Int', amount: 1000 });
    sql(`update opportunities set status = 'won', closed_at = '2020-01-01T00:00:00Z' where id = '${oppId}'`);

    const inRange = await opportunities.listOpportunities(a, { orgId: org, closedFrom: '2026-01-01', closedTo: '2026-12-31' });
    expect(inRange.map((o) => o.id)).not.toContain(oppId);
    const outOfRange = await opportunities.listOpportunities(a, { orgId: org, closedFrom: '2019-01-01', closedTo: '2020-12-31' });
    expect(outOfRange.map((o) => o.id)).toContain(oppId);
  });
});

describe('listTasks: el filtro por fecha de completada solo trae lo completado dentro del rango', () => {
  it('una tarea completada fuera del rango no aparece', async () => {
    const c = await customers.createCustomer(a, org, 'person', 'Cliente Tareas Analítica Int', [{ type: 'phone', value: '+573101110041' }], {});
    const taskId = await tasksRepo.createTask(a, org, { title: 'Tarea vieja Int', type: 'call', priority: 'normal', customerId: c.customerId!, assigneeId: A });
    sql(`update tasks set status = 'done', completed_at = '2020-01-01T00:00:00Z' where id = '${taskId}'`);

    const inRange = await tasksRepo.listTasks(a, { orgId: org, status: 'done', completedFrom: '2026-01-01', completedTo: '2026-12-31' });
    expect(inRange.map((t) => t.id)).not.toContain(taskId);
    const outOfRange = await tasksRepo.listTasks(a, { orgId: org, status: 'done', completedFrom: '2019-01-01', completedTo: '2020-12-31' });
    expect(outOfRange.map((t) => t.id)).toContain(taskId);
  });
});

describe('reports:read respeta el mismo alcance que ya tienen los datos (sin una capa de permisos nueva)', () => {
  it('un vendedor solo ve, en su propia consulta, las oportunidades de las que ya tenía acceso (las suyas)', async () => {
    const c1 = await customers.createCustomer(s1, org, 'person', 'Cliente De S1 Int', [{ type: 'phone', value: '+573101110042' }], {});
    await opportunities.createOpportunity(s1, { customerId: c1.customerId!, title: 'Oportunidad de S1 Int', amount: 500 });
    const c2 = await customers.createCustomer(a, org, 'person', 'Cliente De A Int', [{ type: 'phone', value: '+573101110043' }], {});
    await opportunities.createOpportunity(a, { customerId: c2.customerId!, title: 'Oportunidad de A Int', amount: 700 });

    const seenByS1 = await opportunities.listOpportunities(s1, { orgId: org, status: 'open' });
    expect(seenByS1.some((o) => o.title === 'Oportunidad de S1 Int')).toBe(true);
    expect(seenByS1.some((o) => o.title === 'Oportunidad de A Int')).toBe(false);

    const seenByA = await opportunities.listOpportunities(a, { orgId: org, status: 'open' });
    expect(seenByA.some((o) => o.title === 'Oportunidad de A Int')).toBe(true);
    expect(seenByA.some((o) => o.title === 'Oportunidad de S1 Int')).toBe(true);
  });
});

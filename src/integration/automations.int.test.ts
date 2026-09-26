/**
 * Integración de Automatizaciones contra PostgREST + Postgres reales: crear una regla, ejecutarla por
 * un evento real (como lo haría el despachador), condiciones que sí y que no se cumplen, idempotencia,
 * y que una persona sin permiso no pueda gestionar reglas.
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
import * as automationsService from '@/services/automations';
import * as automations from '@/repositories/automations';
import * as tasksRepo from '@/repositories/tasks';

const REST_URL = process.env.REST_URL!, SECRET = process.env.JWT_SECRET!, DB = process.env.INT_DB!;
const A = 'aaaaaaaa-a707-0000-0000-00000000000a', S1 = '51000000-a707-0000-0000-000000000001';
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (c: Record<string, unknown>) => { const h = b64({ alg: 'HS256', typ: 'JWT' }), p = b64({ ...c, exp: Math.floor(Date.now() / 1000) + 3600 }); return `${h}.${p}.${createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url')}`; };
const client = (token: string) => createClient(REST_URL, token, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${token}` } } }) as unknown as ServerSupabase;
const asUser = (uid: string) => client(jwt({ role: 'authenticated', sub: uid }));
const asService = () => client(jwt({ role: 'service_role' }));
const sql = (q: string) => execFileSync('psql', ['-X', '-tA', '-d', DB, '-c', q], { encoding: 'utf8' }).trim();
const a = asUser(A), s1 = asUser(S1), service = asService();
let org = '';

beforeAll(async () => {
  for (const [id, email] of [[A, 'a@au.test'], [S1, 's1@au.test']]) sql(`insert into auth.users (id, email) values ('${id}', '${email}')`);
  org = await createOrganization(a, 'Automatizaciones Int', 'automatizaciones-int');
  sql(`insert into memberships (org_id, user_id, role_id) select '${org}', '${S1}', id from roles where key = 'sales_agent' and org_id is null`);
}, 30_000);

describe('crear una regla y validar antes de la base de datos', () => {
  it('rechaza sin acciones, sin llamar al servidor', async () => {
    await expect(automationsService.createRule(a, org, { name: 'X', trigger: 'lead.created', actions: [] })).rejects.toBeInstanceOf(UserFacingError);
  });
  it('un vendedor no puede crear una regla (solo automations:read)', async () => {
    await expect(automationsService.createRule(s1, org, { name: 'X', trigger: 'lead.created', actions: [{ type: 'add_tag', name: 'x' }] })).rejects.toThrow();
  });
  it('crea la regla activa', async () => {
    const id = await automationsService.createRule(a, org, { name: 'Etiquetar feria Int', trigger: 'lead.created', conditions: [{ field: 'source', op: 'eq', value: 'feria' }], actions: [{ type: 'add_tag', name: 'Feria Int' }] });
    const rule = await automations.getRule(a, id);
    expect(rule?.isActive).toBe(true); expect(rule?.trigger).toBe('lead.created');
  });
});

describe('ejecutar una regla por un evento real (como lo haría el despachador)', () => {
  it('condición cumplida: etiqueta al cliente; queda registrada en el historial', async () => {
    const ruleId = await automationsService.createRule(a, org, { name: 'Regla ejecución Int', trigger: 'lead.created', conditions: [{ field: 'source', op: 'eq', value: 'feria' }], actions: [{ type: 'add_tag', name: 'De feria' }] });
    const c = await customers.createCustomer(a, org, 'person', 'Cliente Automatización Int', [{ type: 'phone', value: '+573101110030' }], {});
    const eventId = sql(`select app.emit_event('${org}', 'lead.created', 'lead', gen_random_uuid(), '{"source":"feria"}'::jsonb, '${c.customerId}')`);

    const { data, error } = await service.rpc('run_automation_rule', { p_rule_id: ruleId, p_event_id: eventId, p_event: { customer_id: c.customerId, payload: { source: 'feria' } } });
    expect(error).toBeNull(); expect((data as { status: string }).status).toBe('ok');

    const runs = await automations.listRuns(a, ruleId);
    expect(runs[0]).toMatchObject({ status: 'ok' });
  });

  it('condición NO cumplida: no actúa, y queda «omitida»', async () => {
    const ruleId = await automationsService.createRule(a, org, { name: 'Regla condición Int', trigger: 'lead.created', conditions: [{ field: 'source', op: 'eq', value: 'feria' }], actions: [{ type: 'add_tag', name: 'No debería aparecer' }] });
    const c = await customers.createCustomer(a, org, 'person', 'Cliente Sin Feria Int', [{ type: 'phone', value: '+573101110031' }], {});
    const eventId = sql(`select app.emit_event('${org}', 'lead.created', 'lead', gen_random_uuid(), '{"source":"instagram"}'::jsonb, '${c.customerId}')`);
    const { data } = await service.rpc('run_automation_rule', { p_rule_id: ruleId, p_event_id: eventId, p_event: { customer_id: c.customerId, payload: { source: 'instagram' } } });
    expect((data as { status: string }).status).toBe('skipped');
  });

  it('el mismo evento no dispara la misma regla dos veces (idempotencia)', async () => {
    const ruleId = await automationsService.createRule(a, org, { name: 'Regla idempotencia Int', trigger: 'opportunity.won', actions: [{ type: 'create_task', title: 'Tarea idempotente Int', taskType: 'email', offsetDays: 0 }] });
    const c = await customers.createCustomer(a, org, 'person', 'Cliente Idempotencia Int', [{ type: 'phone', value: '+573101110032' }], {});
    const eventId = sql(`select app.emit_event('${org}', 'opportunity.won', 'opportunity', gen_random_uuid(), '{}'::jsonb, '${c.customerId}')`);
    const p = { customer_id: c.customerId, payload: {} };
    await service.rpc('run_automation_rule', { p_rule_id: ruleId, p_event_id: eventId, p_event: p });
    const { data } = await service.rpc('run_automation_rule', { p_rule_id: ruleId, p_event_id: eventId, p_event: p });
    expect((data as { status: string }).status).toBe('skipped');
    const tasks = await tasksRepo.listTasks(a, { orgId: org, customerId: c.customerId! });
    expect(tasks.filter((t) => t.title === 'Tarea idempotente Int')).toHaveLength(1);
  });

  it('crear tarea: el responsable es quien creó la regla, actuando con sus propios permisos', async () => {
    const ruleId = await automationsService.createRule(a, org, { name: 'Regla tarea Int', trigger: 'opportunity.won', actions: [{ type: 'create_task', title: 'Encuesta Int', taskType: 'email', offsetDays: 2 }] });
    const c = await customers.createCustomer(a, org, 'person', 'Cliente Tarea Auto Int', [{ type: 'phone', value: '+573101110033' }], {});
    const eventId = sql(`select app.emit_event('${org}', 'opportunity.won', 'opportunity', gen_random_uuid(), '{}'::jsonb, '${c.customerId}')`);
    await service.rpc('run_automation_rule', { p_rule_id: ruleId, p_event_id: eventId, p_event: { customer_id: c.customerId, payload: {} } });
    const task = (await tasksRepo.listTasks(a, { orgId: org, customerId: c.customerId! })).find((t) => t.title === 'Encuesta Int')!;
    expect(task.assigneeId).toBe(A);
  });
});

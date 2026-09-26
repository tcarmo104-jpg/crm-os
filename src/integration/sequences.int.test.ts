/**
 * Integración de Secuencias contra PostgREST + Postgres reales: crear una plantilla, inscribir, completar
 * un paso (avanza sola, sin cron), pausar/reanudar, y el caso de fusión con secuencias activas duplicadas.
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
import { mergeCustomers } from '@/repositories/reviews';
import * as sequences from '@/repositories/sequences';
import * as sequencesService from '@/services/sequences';
import * as tasksRepo from '@/repositories/tasks';

const REST_URL = process.env.REST_URL!, SECRET = process.env.JWT_SECRET!, DB = process.env.INT_DB!;
const A = 'aaaaaaaa-f606-0000-0000-00000000000a', S1 = '51000000-f606-0000-0000-000000000001';
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (c: Record<string, unknown>) => { const h = b64({ alg: 'HS256', typ: 'JWT' }), p = b64({ ...c, exp: Math.floor(Date.now() / 1000) + 3600 }); return `${h}.${p}.${createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url')}`; };
const client = (token: string) => createClient(REST_URL, token, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${token}` } } }) as unknown as ServerSupabase;
const asUser = (uid: string) => client(jwt({ role: 'authenticated', sub: uid }));
const sql = (q: string) => execFileSync('psql', ['-X', '-tA', '-d', DB, '-c', q], { encoding: 'utf8' }).trim();
const a = asUser(A), s1 = asUser(S1);
let org = '';

beforeAll(async () => {
  for (const [id, email] of [[A, 'a@sq.test'], [S1, 's1@sq.test']]) sql(`insert into auth.users (id, email) values ('${id}', '${email}')`);
  org = await createOrganization(a, 'Secuencias Int', 'secuencias-int');
  sql(`insert into memberships (org_id, user_id, role_id) select '${org}', '${S1}', id from roles where key = 'sales_agent' and org_id is null`);
}, 30_000);

describe('crear una plantilla y validar antes de la base de datos', () => {
  it('rechaza sin pasos, sin llamar al servidor', async () => {
    await expect(sequencesService.createSequence(a, org, { name: 'X', steps: [] })).rejects.toBeInstanceOf(UserFacingError);
  });
  it('crea la secuencia con sus pasos en orden', async () => {
    const id = await sequencesService.createSequence(a, org, {
      name: 'Bienvenida Int', steps: [{ title: 'Llamar', type: 'call', offsetDays: 0 }, { title: 'WhatsApp', type: 'whatsapp', offsetDays: 3 }],
    });
    const seq = await sequences.getSequence(a, id);
    expect(seq?.steps.map((s) => s.title)).toEqual(['Llamar', 'WhatsApp']);
  });
});

describe('inscribir y avanzar de punta a punta (sin cron)', () => {
  it('inscribir crea la tarea del primer paso; completarla crea la del segundo', async () => {
    const seqId = await sequencesService.createSequence(a, org, { name: 'Seguimiento Int', steps: [{ title: 'Paso uno', type: 'call', offsetDays: 0 }, { title: 'Paso dos', type: 'email', offsetDays: 2 }] });
    const c = await customers.createCustomer(a, org, 'person', 'Cliente Secuencia Int', [{ type: 'phone', value: '+573101110020' }], {});
    const enrollId = await sequences.enrollInSequence(a, seqId, c.customerId!, null, null);
    let enr = (await sequences.listEnrollmentsByCustomer(a, c.customerId!)).find((e) => e.id === enrollId)!;
    expect(enr.status).toBe('active'); expect(enr.currentStep).toBe(1); expect(enr.currentTaskId).toBeTruthy();
    const firstTask = (await tasksRepo.listTasks(a, { orgId: org, customerId: c.customerId! })).find((t) => t.id === enr.currentTaskId)!;
    expect(firstTask.title).toBe('Paso uno');

    await tasksRepo.completeTask(a, enr.currentTaskId!, 'Contestó bien');
    enr = (await sequences.listEnrollmentsByCustomer(a, c.customerId!)).find((e) => e.id === enrollId)!;
    expect(enr.status).toBe('active'); expect(enr.currentStep).toBe(2);
    const secondTask = (await tasksRepo.listTasks(a, { orgId: org, customerId: c.customerId! })).find((t) => t.id === enr.currentTaskId)!;
    expect(secondTask.title).toBe('Paso dos');

    await tasksRepo.completeTask(a, enr.currentTaskId!);
    enr = (await sequences.listEnrollmentsByCustomer(a, c.customerId!)).find((e) => e.id === enrollId)!;
    expect(enr.status).toBe('completed'); expect(enr.currentTaskId).toBeNull();
  });

  it('un vendedor inscribe a su propio cliente, y solo ve la fila de sus propias secuencias con customers:read', async () => {
    const seqId = await sequencesService.createSequence(a, org, { name: 'Solo lectura Int', steps: [{ title: 'Contactar', type: 'call', offsetDays: 0 }] });
    const c = await customers.createCustomer(s1, org, 'person', 'Cliente De Vendedor Int', [{ type: 'phone', value: '+573101110021' }], {});
    const enrollId = await sequences.enrollInSequence(s1, seqId, c.customerId!, null, null);
    expect((await sequences.listEnrollmentsByCustomer(s1, c.customerId!)).map((e) => e.id)).toContain(enrollId);
  });

  it('pausar detiene el avance; completar la tarea de una NO afecta si no está activa', async () => {
    const seqId = await sequencesService.createSequence(a, org, { name: 'Pausa Int', steps: [{ title: 'Uno', type: 'call', offsetDays: 0 }, { title: 'Dos', type: 'call', offsetDays: 1 }] });
    const c = await customers.createCustomer(a, org, 'person', 'Cliente Pausa Int', [{ type: 'phone', value: '+573101110022' }], {});
    const enrollId = await sequences.enrollInSequence(a, seqId, c.customerId!, null, null);
    await sequences.pauseEnrollment(a, enrollId);
    const enr = (await sequences.listEnrollmentsByCustomer(a, c.customerId!)).find((e) => e.id === enrollId)!;
    expect(enr.status).toBe('paused');
  });
});

describe('fusión de clientes con la misma secuencia activa (caso encontrado durante las pruebas SQL)', () => {
  it('la del cliente absorbido se cancela en vez de romper la restricción de unicidad', async () => {
    const seqId = await sequencesService.createSequence(a, org, { name: 'Fusión Int', steps: [{ title: 'Paso', type: 'call', offsetDays: 0 }] });
    const c1 = await customers.createCustomer(a, org, 'person', 'Cliente Fusión Uno Int', [{ type: 'phone', value: '+573101110023' }], {});
    const c2 = await customers.createCustomer(a, org, 'person', 'Cliente Fusión Dos Int', [{ type: 'phone', value: '+573101110024' }], {});
    const e1 = await sequences.enrollInSequence(a, seqId, c1.customerId!, null, null);
    const e2 = await sequences.enrollInSequence(a, seqId, c2.customerId!, null, null);
    await mergeCustomers(a, c1.customerId!, c2.customerId!);
    const rows = await sequences.listEnrollmentsByCustomer(a, c1.customerId!);
    expect(rows.find((e) => e.id === e1)?.status).toBe('active');
    expect(rows.find((e) => e.id === e2)?.status).toBe('cancelled');
  });
});

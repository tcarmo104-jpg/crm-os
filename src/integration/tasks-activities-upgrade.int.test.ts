/**
 * Integración de la mejora de Tareas y Actividades contra PostgREST + Postgres reales: filtros nuevos del
 * repositorio (tipo, prioridad, texto, varios estados), el estado «en progreso» de punta a punta, y el
 * listado global de actividades (con sus filtros) que alimenta la nueva página /activities.
 */
import { createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';

vi.mock('server-only', () => ({}));

import type { ServerSupabase } from '@/lib/supabase/server';
import { isOverdue } from '@/lib/tasks';
import { createOrganization } from '@/repositories/organizations';
import * as customers from '@/repositories/customers';
import * as tasksRepo from '@/repositories/tasks';
import * as actsRepo from '@/repositories/activities';
import * as sales from '@/services/sales';

const REST_URL = process.env.REST_URL!, SECRET = process.env.JWT_SECRET!, DB = process.env.INT_DB!;
const A = 'aaaaaaaa-e404-0000-0000-00000000000a', S1 = '51000000-e404-0000-0000-000000000001';
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (c: Record<string, unknown>) => { const h = b64({ alg: 'HS256', typ: 'JWT' }), p = b64({ ...c, exp: Math.floor(Date.now() / 1000) + 3600 }); return `${h}.${p}.${createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url')}`; };
const client = (token: string) => createClient(REST_URL, token, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${token}` } } }) as unknown as ServerSupabase;
const asUser = (uid: string) => client(jwt({ role: 'authenticated', sub: uid }));
const sql = (q: string) => execFileSync('psql', ['-X', '-tA', '-d', DB, '-c', q], { encoding: 'utf8' }).trim();
const a = asUser(A), s1 = asUser(S1);
let org = '', custId = '';

beforeAll(async () => {
  for (const [id, email] of [[A, 'a@ta.test'], [S1, 's1@ta.test']]) sql(`insert into auth.users (id, email) values ('${id}', '${email}')`);
  org = await createOrganization(a, 'Tareas Up Int', 'tareas-up-int');
  sql(`insert into memberships (org_id, user_id, role_id) select '${org}', '${S1}', id from roles where key = 'sales_agent' and org_id is null`);
  const c = await customers.createCustomer(a, org, 'person', 'Cliente Filtros', [{ type: 'phone', value: '+573001110077' }], {});
  custId = (c as { customerId: string }).customerId;
}, 30_000);

describe('filtros del repositorio de tareas', () => {
  it('por tipo, prioridad y texto (título o descripción), combinados', async () => {
    await sales.createTask(a, org, 'UTC', { title: 'Llamar a Ana sobre el contrato', type: 'call', priority: 'high', customerId: custId });
    await sales.createTask(a, org, 'UTC', { title: 'Enviar cotización', type: 'email', priority: 'normal', description: 'Incluir el contrato firmado' });
    await sales.createTask(a, org, 'UTC', { title: 'Visitar showroom', type: 'visit', priority: 'low' });

    expect((await tasksRepo.listTasks(a, { orgId: org, type: 'call' })).map((t) => t.title)).toEqual(['Llamar a Ana sobre el contrato']);
    expect((await tasksRepo.listTasks(a, { orgId: org, priority: 'high' })).length).toBe(1);
    const byText = await tasksRepo.listTasks(a, { orgId: org, q: 'contrato' });
    expect(byText.map((t) => t.title).sort()).toEqual(['Enviar cotización', 'Llamar a Ana sobre el contrato']);
    expect((await tasksRepo.listTasks(a, { orgId: org, type: 'call', priority: 'high' })).length).toBe(1);
    expect((await tasksRepo.listTasks(a, { orgId: org, type: 'call', priority: 'low' })).length).toBe(0);
  });
  it('«statuses» trae varios estados a la vez (para el tablero) sin repetir el parámetro «status»', async () => {
    const id = await sales.createTask(a, org, 'UTC', { title: 'Tarea para el tablero', type: 'other' });
    await tasksRepo.startTask(a, id as string);
    const rows = await tasksRepo.listTasks(a, { orgId: org, statuses: ['open', 'in_progress'] });
    expect(rows.some((t) => t.id === id)).toBe(true);
    expect(rows.every((t) => t.status === 'open' || t.status === 'in_progress')).toBe(true);
  });
  it('el texto de búsqueda no permite inyectar comodines ni romper la consulta', async () => {
    await expect(tasksRepo.listTasks(a, { orgId: org, q: '%_,malicioso' })).resolves.toBeDefined();
  });
});

describe('«en progreso» de punta a punta (repositorio + RPC real)', () => {
  it('abierta → en progreso → completada, visible para quien la puede ver', async () => {
    const id = (await sales.createTask(a, org, 'UTC', { title: 'Seguimiento showroom', type: 'follow_up', assigneeId: S1 })) as string;
    await tasksRepo.startTask(s1, id);
    let row = (await tasksRepo.listTasks(s1, { orgId: org, statuses: ['open', 'in_progress'] })).find((t) => t.id === id)!;
    expect(row.status).toBe('in_progress');
    await tasksRepo.completeTask(s1, id, 'Visita realizada');
    row = (await tasksRepo.listTasks(s1, { orgId: org, status: 'done' })).find((t) => t.id === id)!;
    expect(row.status).toBe('done'); expect(row.outcome).toBe('Visita realizada');
  });
  it('«vencida» es visual: una tarea en progreso con fecha pasada se marca vencida sin cambiar de estado', async () => {
    const past = new Date(Date.now() - 3600_000).toISOString();
    const id = (await sales.createTask(a, org, 'UTC', { title: 'Ya debería estar hecha', type: 'call', due: past.slice(0, 16) })) as string;
    await tasksRepo.startTask(a, id);
    const row = (await tasksRepo.listTasks(a, { orgId: org, statuses: ['open', 'in_progress'] })).find((t) => t.id === id)!;
    expect(row.status).toBe('in_progress'); expect(isOverdue(row)).toBe(true);
  });
});

describe('editar una tarea (la funcionalidad que existía en el servicio pero nunca se veía en pantalla)', () => {
  it('cambia título, tipo, prioridad, fecha y descripción de una tarea abierta', async () => {
    const id = (await sales.createTask(a, org, 'UTC', { title: 'Original', type: 'call', priority: 'low' })) as string;
    await sales.editTask(a, id, 'UTC', { title: 'Editada', type: 'meeting', priority: 'high', due: '2027-01-10T09:00', description: 'Nueva descripción' });
    const row = (await tasksRepo.listTasks(a, { orgId: org, statuses: ['open', 'in_progress'] })).find((t) => t.id === id)!;
    expect(row).toMatchObject({ title: 'Editada', type: 'meeting', priority: 'high', description: 'Nueva descripción' });
    expect(row.dueAt).toMatch(/2027-01-10/);
  });
  it('una tarea cerrada no se puede editar (el trigger la protege)', async () => {
    const id = (await sales.createTask(a, org, 'UTC', { title: 'Se completa', type: 'call' })) as string;
    await tasksRepo.completeTask(a, id);
    await expect(sales.editTask(a, id, 'UTC', { title: 'Intento de cambio', type: 'call', priority: 'normal' })).rejects.toBeTruthy();
  });
});

describe('listado global de Actividades (para la nueva página del módulo)', () => {
  it('filtra por organización, tipo, cliente, responsable, texto y rango de fechas', async () => {
    const c2 = (await customers.createCustomer(a, org, 'person', 'Cliente Actividades 2', [{ type: 'email', value: 'act2@ejemplo.com' }], {}) as { customerId: string }).customerId;
    await sales.logActivity(a, { customerId: custId, type: 'call', direction: 'outbound', summary: 'Llamada de seguimiento al contrato' });
    await sales.logActivity(a, { customerId: c2, type: 'visit', summary: 'Visita a la obra' });
    await sales.logActivity(a, { customerId: c2, type: 'note', summary: 'Prefiere que lo llamen en la tarde' });

    expect((await actsRepo.listActivities(a, { orgId: org, type: 'visit' })).map((x) => x.summary)).toEqual(['Visita a la obra']);
    expect((await actsRepo.listActivities(a, { orgId: org, customerId: c2 })).length).toBe(2);
    expect((await actsRepo.listActivities(a, { orgId: org, q: 'contrato' })).map((x) => x.customerId)).toEqual([custId]);
    expect((await actsRepo.listActivities(a, { orgId: org, createdBy: A })).length).toBeGreaterThanOrEqual(3);
    const future = new Date(Date.now() + 86_400_000).toISOString();
    expect(await actsRepo.listActivities(a, { orgId: org, from: future })).toEqual([]);
  });
  it('la actividad de tipo «visita» no exige dirección, pero llamada/whatsapp/correo sí', async () => {
    await expect(sales.logActivity(a, { customerId: custId, type: 'call', summary: 'Sin dirección' })).rejects.toThrow(/entrante o saliente/);
    await expect(sales.logActivity(a, { customerId: custId, type: 'visit', summary: 'Visita sin dirección' })).resolves.toBeTruthy();
  });
  it('registrar con una fecha manual la guarda en la zona horaria de la organización', async () => {
    await sales.logActivity(a, { customerId: custId, type: 'note', summary: 'Nota con fecha manual', occurredAt: '2026-06-01T09:00' }, 'America/Bogota');
    const row = (await actsRepo.listActivities(a, { orgId: org, q: 'fecha manual' }))[0]!;
    expect(new Date(row.occurredAt).getTime()).toBe(new Date('2026-06-01T14:00:00.000Z').getTime());
  });
});

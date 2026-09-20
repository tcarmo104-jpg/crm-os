/**
 * Integración Fase 3 contra PostgREST + Postgres reales: pipelines, oportunidades, log de transiciones,
 * máquina de estados de leads (comparada con la de TypeScript), tareas y actividades.
 */
import { createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';

vi.mock('server-only', () => ({}));

import type { ServerSupabase } from '@/lib/supabase/server';
import { DbError, toUserMessage } from '@/lib/errors';
import { LEAD_TRANSITIONS, nextLeadStatuses, type LeadStatus } from '@/lib/leads';
import { forecast, orderedStages } from '@/lib/pipeline';
import { describeEvent } from '@/lib/timeline';
import { dueBucket } from '@/lib/tasks';
import { createOrganization } from '@/repositories/organizations';
import * as customers from '@/repositories/customers';
import * as pipes from '@/repositories/pipelines';
import * as oppsRepo from '@/repositories/opportunities';
import * as tasksRepo from '@/repositories/tasks';
import * as actsRepo from '@/repositories/activities';
import * as leadsRepo from '@/repositories/leads';
import * as sales from '@/services/sales';

const REST_URL = process.env.REST_URL!;
const SECRET = process.env.JWT_SECRET!;
const DB = process.env.INT_DB!;

const A = 'aaaaaaaa-1111-0000-0000-00000000000a';
const S1 = '51000000-1111-0000-0000-000000000001';
const S2 = '52000000-1111-0000-0000-000000000002';
const M = '4d000000-1111-0000-0000-00000000000d';

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
function jwt(claims: Record<string, unknown>) {
  const h = b64({ alg: 'HS256', typ: 'JWT' });
  const p = b64({ ...claims, exp: Math.floor(Date.now() / 1000) + 3600 });
  return `${h}.${p}.${createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url')}`;
}
const client = (token: string) =>
  createClient(REST_URL, token, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${token}` } } }) as unknown as ServerSupabase;
const asUser = (uid: string) => client(jwt({ role: 'authenticated', sub: uid }));
const svc = client(jwt({ role: 'service_role' }));
const sql = (q: string) => execFileSync('psql', ['-X', '-tA', '-d', DB, '-c', q], { encoding: 'utf8' }).trim();
const rejects = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as Error & Partial<DbError>; } throw new Error('se esperaba un error y no ocurrió'); };

const a = asUser(A), s1 = asUser(S1), s2 = asUser(S2), m = asUser(M);
let org = '';
let carlos = '';
let pipelineId = '';
let stages: Awaited<ReturnType<typeof pipes.listPipelines>>[number]['stages'] = [];
const stage = (name: string) => stages.find((s) => s.name === name)!.id;
let phoneSeq = 0;
const nextPhone = () => `+5733100${String(++phoneSeq).padStart(5, '0')}`;

async function newLead(): Promise<{ leadId: string; customerId: string }> {
  const r = (await svc.rpc('ingest_lead', { p_org: org, p_payload: { name: `Lead ${phoneSeq + 1}`, identifiers: [{ type: 'phone', value: nextPhone() }], source: 'int' } })).data as
    { lead_id: string; customer_id: string };
  return { leadId: r.lead_id, customerId: r.customer_id };
}

beforeAll(async () => {
  for (const [id, email] of [[A, 'a@sales.test'], [S1, 's1@sales.test'], [S2, 's2@sales.test'], [M, 'm@sales.test']]) {
    sql(`insert into auth.users (id, email) values ('${id}', '${email}')`);
  }
  org = await createOrganization(a, 'Ventas Int', 'ventas-int');
  for (const [uid, role] of [[S1, 'sales_agent'], [S2, 'sales_agent'], [M, 'manager']]) {
    sql(`insert into memberships (org_id, user_id, role_id) select '${org}', '${uid}', id from roles where key = '${role}' and org_id is null`);
  }
  const r = await customers.createCustomer(s1, org, 'person', 'Carlos Rodríguez', [{ type: 'phone', value: '+573001112233' }], {});
  if (r.outcome !== 'created') throw new Error('setup');
  carlos = r.customerId;
  const list = await pipes.listPipelines(s1, org);
  pipelineId = list[0]!.id;
  stages = list[0]!.stages;
});

describe('pipelines', () => {
  it('la organización nace con su pipeline por defecto y 6 etapas en orden', async () => {
    const list = await pipes.listPipelines(s1, org);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: 'Ventas', isDefault: true });
    expect(orderedStages(stages).map((s) => s.name)).toEqual(['Nueva', 'Contactado', 'Calificada', 'Cotización', 'Negociación', 'Ganada', 'Perdida']);
  });
  it('solo quien tiene pipelines:manage crea pipelines y etapas (con mensajes claros)', async () => {
    expect((await rejects(pipes.createPipeline(s1, org, 'Mío'))).code).toBe('42501');
    const id = await sales.createPipeline(a, org, 'Renovaciones');
    expect((await pipes.listPipelines(s1, org)).find((p) => p.id === id)?.stages).toHaveLength(7);
    await sales.addStage(a, org, { pipelineId: id, name: 'Demo', kind: 'open', probability: '35' });
    const err = await rejects(sales.addStage(a, org, { pipelineId: id, name: 'demo', kind: 'open', probability: '10' }));
    expect(toUserMessage(err)).toMatch(/ya existe/i);
  });
});

describe('oportunidades y log de transiciones', () => {
  let opp = '';
  it('crear con monto escrito por una persona; visibilidad por rol', async () => {
    opp = await sales.createOpportunity(s1, { customerId: carlos, title: 'Plan A', amount: '$ 1.500.000', expectedClose: '2026-12-31', productInterest: 'Producto A' });
    const o = await oppsRepo.getOpportunity(s1, opp);
    expect(o).toMatchObject({ amount: 1500000, status: 'open', expectedCloseDate: '2026-12-31', currency: 'COP', ownerId: S1 });
    expect(o?.stageId).toBe(stage('Nueva'));
    expect(await oppsRepo.getOpportunity(s2, opp)).toBeNull();
    expect((await oppsRepo.listOpportunities(m, { orgId: org })).map((x) => x.id)).toContain(opp);
    expect((await rejects(sales.createOpportunity(s2, { customerId: carlos, title: 'X', amount: '1' }))).code).toBe('42501');
  });

  it('mover, perder (con motivo obligatorio y mensaje claro), y reabrir solo el manager', async () => {
    await sales.moveOpportunity(s1, opp, { stageId: stage('Cotización') });
    const noReason = await rejects(sales.moveOpportunity(s1, opp, { stageId: stage('Perdida') }));
    expect(toUserMessage(noReason)).toMatch(/motivo/i);
    await sales.moveOpportunity(s1, opp, { stageId: stage('Perdida'), reason: 'Eligió a la competencia' });
    expect(await oppsRepo.getOpportunity(s1, opp)).toMatchObject({ status: 'lost', lostReason: 'Eligió a la competencia' });

    const cant = await rejects(sales.moveOpportunity(s1, opp, { stageId: stage('Nueva') }));
    expect(toUserMessage(cant)).toMatch(/manager o administrador/);
    await sales.moveOpportunity(m, opp, { stageId: stage('Nueva') });
    expect(await oppsRepo.getOpportunity(s1, opp)).toMatchObject({ status: 'open', lostReason: null, closedAt: null });
  });

  it('el historial se lee en orden y es una cadena continua; S2 no lo ve', async () => {
    const t = await oppsRepo.listTransitions(s1, 'opportunity', opp);   // más reciente primero
    expect(t.map((x) => x.toState)).toEqual(['Nueva', 'Perdida', 'Cotización', 'Nueva']);
    const chrono = [...t].reverse();
    chrono.forEach((x, i) => expect(x.fromState).toBe(i === 0 ? null : chrono[i - 1]!.toState));
    expect(t[1]).toMatchObject({ reason: 'Eligió a la competencia', source: 'user', actorId: S1 });
    expect(await oppsRepo.listTransitions(s2, 'opportunity', opp)).toEqual([]);
  });

  it('el tablero: consulta por pipeline y estado, y el resumen del embudo', async () => {
    await sales.createOpportunity(s1, { customerId: carlos, title: 'Plan B', amount: '500.000' });
    const open = await oppsRepo.listOpportunities(s1, { orgId: org, pipelineId, status: 'open' });
    expect(open.map((o) => o.title).sort()).toEqual(['Plan A', 'Plan B']);
    const f = forecast(open, orderedStages(stages).filter((s) => s.kind === 'open'));
    expect(f.open).toBe(2);
    expect(f.amount).toBe(2000000);
    expect(f.weighted).toBe(2000000 * 0.1);   // ambas en «Nuevo» (10 %)
  });

  it('editar datos; cliente sin dueño no se puede operar por un vendedor', async () => {
    await sales.updateOpportunity(s1, opp, { title: 'Plan A+', amount: '1.750.000', expectedClose: '', productInterest: '' });
    expect(await oppsRepo.getOpportunity(s1, opp)).toMatchObject({ title: 'Plan A+', amount: 1750000, expectedCloseDate: null });
    const { customerId } = await newLead();      // cliente sin propietario
    expect((await rejects(sales.createOpportunity(s1, { customerId, title: 'X', amount: '1' }))).code).toBe('42501');
  });
});

describe('máquina de estados de leads: TypeScript == base de datos', () => {
  const targets: LeadStatus[] = ['new', 'contacted', 'qualified', 'disqualified'];
  const sources = Object.keys(LEAD_TRANSITIONS) as LeadStatus[];

  it('las 20 combinaciones origen → destino coinciden con nextLeadStatuses()', async () => {
    const mismatches: string[] = [];
    for (const from of sources) {
      for (const to of targets) {
        if (to === from) continue;   // mismo estado = no-op (se comprueba aparte)
        const { leadId, customerId } = await newLead();
        sql(`update customers set owner_id = '${M}' where id = '${customerId}'`);   // que el manager lo vea/opere (dueño real)
        // llevar el lead al estado de origen por caminos válidos
        if (from === 'contacted') await leadsRepo.setLeadStatus(m, leadId, 'contacted');
        if (from === 'qualified') await leadsRepo.setLeadStatus(m, leadId, 'qualified');
        if (from === 'disqualified') await leadsRepo.setLeadStatus(m, leadId, 'disqualified', 'Sin presupuesto');
        if (from === 'converted') await leadsRepo.convertLead(m, leadId);
        let allowed = true;
        try { await leadsRepo.setLeadStatus(m, leadId, to, to === 'disqualified' ? 'Motivo de prueba' : undefined); } catch { allowed = false; }
        const expected = nextLeadStatuses(from).includes(to);
        if (allowed !== expected) mismatches.push(`${from} → ${to}: BD=${allowed} TS=${expected}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('pedir el mismo estado es un no-op: no falla y NO escribe en el historial', async () => {
    const { leadId, customerId } = await newLead();
    sql(`update customers set owner_id = '${M}' where id = '${customerId}'`);
    await leadsRepo.setLeadStatus(m, leadId, 'new');
    expect(await oppsRepo.listTransitions(m, 'lead', leadId)).toHaveLength(1);   // solo el estado inicial
  });

  it('«converted» nunca se alcanza con set_lead_status, desde ningún estado', async () => {
    const { leadId, customerId } = await newLead();
    sql(`update customers set owner_id = '${M}' where id = '${customerId}'`);
    await leadsRepo.setLeadStatus(m, leadId, 'qualified');
    const e = await rejects(leadsRepo.setLeadStatus(m, leadId, 'converted'));
    expect(toUserMessage(e)).toMatch(/Convertir en oportunidad/);
  });

  it('convertir un lead: oportunidad creada y log del lead completo y en orden', async () => {
    const { leadId, customerId } = await newLead();
    sql(`update customers set owner_id = '${S1}' where id = '${customerId}'`);
    const oppId = await leadsRepo.convertLead(s1, leadId);
    const o = await oppsRepo.getOpportunity(s1, oppId);
    expect(o).toMatchObject({ customerId, status: 'open', ownerId: S1 });
    const t = (await oppsRepo.listTransitions(s1, 'lead', leadId)).map((x) => x.toState).reverse();
    expect(t).toEqual(['new', 'qualified', 'converted']);
    expect(toUserMessage(await rejects(leadsRepo.convertLead(s1, leadId)))).toMatch(/ya fue convertido|descartado/);
  });
});

describe('tareas y actividades', () => {
  let task = '';
  it('crear una tarea con fecha en la zona de la organización', async () => {
    sql(`update organizations set timezone = 'America/Bogota' where id = '${org}'`);
    task = await sales.createTask(s1, org, 'America/Bogota', { title: 'Llamar a Carlos', type: 'call', priority: 'high', due: '2026-12-01T09:30', customerId: carlos });
    const [t] = await tasksRepo.listTasks(s1, { orgId: org, customerId: carlos, status: 'open' });
    expect(t).toMatchObject({ id: task, assigneeId: S1, type: 'call', priority: 'high', status: 'open' });
    expect(t?.dueAt && new Date(t.dueAt).toISOString()).toBe('2026-12-01T14:30:00.000Z');
    expect(dueBucket(t!.dueAt, new Date('2026-12-01T13:00:00Z'), 'America/Bogota')).toBe('today');
    expect(await tasksRepo.listTasks(s2, { orgId: org, status: 'open' })).toEqual([]);
  });

  it('asignar a otra persona depende del alcance (mensaje claro)', async () => {
    const e = await rejects(sales.createTask(s1, org, 'UTC', { title: 'Para S2', assigneeId: S2 }));
    expect(toUserMessage(e)).toMatch(/No puedes asignar/);
    const id = await sales.createTask(m, org, 'UTC', { title: 'Para S2', assigneeId: S2 });
    expect((await tasksRepo.listTasks(s2, { orgId: org, status: 'open' })).map((t) => t.id)).toContain(id);
  });

  it('completar, no doble completar, reabrir y cancelar', async () => {
    await tasksRepo.completeTask(s1, task, 'Contestó y agendó demo');
    expect((await tasksRepo.listTasks(s1, { orgId: org, status: 'done' }))[0]).toMatchObject({ id: task, outcome: 'Contestó y agendó demo' });
    expect(toUserMessage(await rejects(tasksRepo.completeTask(s1, task)))).toMatch(/ya no está abierta/);
    await tasksRepo.reopenTask(s1, task);
    await tasksRepo.cancelTask(s1, task);
    expect((await tasksRepo.listTasks(s1, { orgId: org, status: 'cancelled' })).map((t) => t.id)).toContain(task);
  });

  it('vencidas: se cuentan solo las abiertas y del responsable', async () => {
    const past = new Date(Date.now() - 3600_000).toISOString();
    sql(`insert into tasks (org_id, title, assignee_id, due_at, customer_id) values ('${org}', 'Vencida', '${S1}', '${past}', '${carlos}')`);
    expect(await tasksRepo.countOverdue(s1, org, S1)).toBe(1);
    expect(await tasksRepo.countOverdue(m, org, M)).toBe(0);
  });

  it('actividades: se registran, no se editan, y aparecen en la línea de tiempo con su texto', async () => {
    await sales.logActivity(s1, { customerId: carlos, type: 'call', direction: 'outbound', summary: 'Pidió cotización del plan A' });
    const acts = await actsRepo.listActivities(s1, { customerId: carlos });
    expect(acts[0]).toMatchObject({ type: 'call', direction: 'outbound', summary: 'Pidió cotización del plan A' });
    expect(await actsRepo.listActivities(s2, { customerId: carlos })).toEqual([]);
    expect((await rejects(sales.logActivity(s2, { customerId: carlos, type: 'note', summary: 'x' }))).code).toBe('42501');
    const tl = await customers.timeline(s1, carlos, 200);
    const types = new Set(tl.map((e) => e.type));
    for (const t of ['customer.created', 'opportunity.created', 'opportunity.stage_changed', 'opportunity.lost', 'task.created', 'task.completed', 'task.cancelled', 'activity.logged']) {
      expect(types.has(t), t).toBe(true);
    }
    // ningún evento conocido se muestra con su nombre técnico
    for (const e of tl) expect(describeEvent(e, () => 'X').title, e.type).not.toBe(e.type);
  });

  it('las tareas abiertas siguen al cliente cuando el manager lo reasigna', async () => {
    const id = await sales.createTask(s1, org, 'UTC', { title: 'Seguimiento reasignable', customerId: carlos });
    await customers.updateCustomer(m, carlos, { owner_id: S2 });
    expect((await tasksRepo.listTasks(s2, { orgId: org, status: 'open' })).map((t) => t.id)).toContain(id);
    expect((await tasksRepo.listTasks(s1, { orgId: org, status: 'open' })).map((t) => t.id)).not.toContain(id);
  });
});

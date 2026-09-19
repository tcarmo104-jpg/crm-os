import { z } from 'zod';
import type { ServerSupabase } from '@/lib/supabase/server';
import { UserFacingError } from '@/lib/errors';
import { parseAmount } from '@/lib/money';
import { zonedLocalToUtcIso } from '@/lib/time';
import { needsReason } from '@/lib/leads';
import * as opps from '@/repositories/opportunities';
import * as tasks from '@/repositories/tasks';
import * as activities from '@/repositories/activities';
import * as leadsRepo from '@/repositories/leads';
import * as pipes from '@/repositories/pipelines';
import { firstIssue } from './schemas';

const blank = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const optStr = (max: number) => z.preprocess(blank, z.string().trim().max(max, 'El texto es demasiado largo.').optional());
const optUuid = z.preprocess(blank, z.string().uuid('Selección no válida.').optional());
const amountField = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() !== '' ? parseAmount(v) : v === '' || v === undefined ? 0 : v),
  z.number({ invalid_type_error: 'Escribe un monto válido (por ejemplo 1.500.000).' }).min(0).max(999_999_999_999),
);
const dateOnly = z.preprocess(blank, z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha no válida.').optional());

function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) throw new UserFacingError(firstIssue(r.error));
  return r.data;
}

// ---------------------------------------------------------------- oportunidades
const newOppSchema = z.object({
  customerId: z.string().uuid('Selecciona un cliente.'),
  title: z.string().trim().min(1, 'Escribe un título.').max(160, 'El título es demasiado largo.'),
  amount: amountField, expectedClose: dateOnly, pipelineId: optUuid, productInterest: optStr(200),
});
export async function createOpportunity(db: ServerSupabase, input: unknown) {
  const d = parse(newOppSchema, input);
  return opps.createOpportunity(db, d);
}

const moveSchema = z.object({ stageId: z.string().uuid('Selecciona una etapa.'), reason: optStr(500) });
export async function moveOpportunity(db: ServerSupabase, id: string, input: unknown) {
  const d = parse(moveSchema, input);
  await opps.moveOpportunity(db, id, d.stageId, d.reason);
}

const editOppSchema = z.object({
  title: z.string().trim().min(1, 'Escribe un título.').max(160), amount: amountField, expectedClose: dateOnly, productInterest: optStr(200),
});
export async function updateOpportunity(db: ServerSupabase, id: string, input: unknown, customFields?: Record<string, unknown>) {
  const d = parse(editOppSchema, input);
  await opps.updateOpportunity(db, id, {
    title: d.title, amount: d.amount, expected_close_date: d.expectedClose ?? null, product_interest: d.productInterest ?? null,
    ...(customFields ? { custom_fields: customFields } : {}),
  });
}

// ---------------------------------------------------------------- tareas
const TASK_TYPES = ['call', 'whatsapp', 'email', 'meeting', 'follow_up', 'other'] as const;
const newTaskSchema = z.object({
  title: z.string().trim().min(1, 'Escribe qué hay que hacer.').max(160, 'El título es demasiado largo.'),
  type: z.enum(TASK_TYPES).default('follow_up'),
  priority: z.enum(['low', 'normal', 'high']).default('normal'),
  due: optStr(20), description: optStr(2000), customerId: optUuid, opportunityId: optUuid, assigneeId: optUuid,
});
export async function createTask(db: ServerSupabase, orgId: string, timezone: string, input: unknown) {
  const d = parse(newTaskSchema, input);
  let dueAt: string | undefined;
  if (d.due) {
    const iso = zonedLocalToUtcIso(d.due, timezone);
    if (!iso) throw new UserFacingError('La fecha y hora no son válidas.');
    dueAt = iso;
  }
  return tasks.createTask(db, orgId, { ...d, dueAt });
}

export async function editTask(db: ServerSupabase, id: string, timezone: string, input: unknown) {
  const d = parse(newTaskSchema.pick({ title: true, type: true, priority: true, due: true, description: true }), input);
  let due_at: string | null = null;
  if (d.due) {
    due_at = zonedLocalToUtcIso(d.due, timezone);
    if (!due_at) throw new UserFacingError('La fecha y hora no son válidas.');
  }
  await tasks.updateTask(db, id, { title: d.title, type: d.type, priority: d.priority, due_at, description: d.description ?? null });
}

// ---------------------------------------------------------------- actividades
const activitySchema = z.object({
  customerId: z.string().uuid(),
  type: z.enum(['call', 'whatsapp', 'email', 'meeting', 'note'], { errorMap: () => ({ message: 'Selecciona el tipo de actividad.' }) }),
  direction: z.preprocess(blank, z.enum(['inbound', 'outbound']).optional()),
  summary: z.string().trim().min(1, 'Cuenta brevemente qué pasó.').max(2000, 'El resumen es demasiado largo.'),
  opportunityId: optUuid,
});
export async function logActivity(db: ServerSupabase, input: unknown) {
  const d = parse(activitySchema, input);
  if (['call', 'whatsapp', 'email'].includes(d.type) && !d.direction) {
    throw new UserFacingError('Indica si fue entrante o saliente.');
  }
  return activities.logActivity(db, { ...d, direction: d.type === 'note' || d.type === 'meeting' ? undefined : d.direction });
}

// ---------------------------------------------------------------- leads
export async function changeLeadStatus(db: ServerSupabase, id: string, to: string, reason?: string) {
  const status = parse(z.enum(['new', 'contacted', 'qualified', 'disqualified']), to);
  const r = reason?.trim() ?? '';
  if (needsReason(status) && r.length < 3) throw new UserFacingError('Escribe el motivo del descarte (al menos 3 letras).');
  await leadsRepo.setLeadStatus(db, id, status, r || undefined);
}

// ---------------------------------------------------------------- pipelines
const stageSchema = z.object({
  pipelineId: z.string().uuid(),
  name: z.string().trim().min(1, 'Escribe el nombre de la etapa.').max(60, 'El nombre es demasiado largo.'),
  kind: z.enum(['open', 'won', 'lost']),
  probability: z.coerce.number({ invalid_type_error: 'La probabilidad debe ser un número.' }).int('La probabilidad debe ser un número entero.').min(0).max(100),
});
export async function addStage(db: ServerSupabase, orgId: string, input: unknown) {
  const d = parse(stageSchema, input);
  // La BD exige: ganada = 100 %, perdida = 0 %, abierta = 0–99 %. Se ajusta aquí para dar un mensaje claro.
  if (d.kind === 'open' && d.probability > 99) throw new UserFacingError('Una etapa abierta no puede valer 100 %: eso es «ganada».');
  const probability = d.kind === 'won' ? 100 : d.kind === 'lost' ? 0 : d.probability;
  await pipes.addStage(db, orgId, d.pipelineId, { name: d.name, kind: d.kind, probability });
}
export async function renameStage(db: ServerSupabase, id: string, name: string, probability: unknown, kind: string) {
  const n = parse(z.string().trim().min(1, 'Escribe el nombre de la etapa.').max(60), name);
  const fields: { name: string; probability?: number } = { name: n };
  if (kind === 'open') {
    const p = parse(z.coerce.number().int().min(0, 'La probabilidad va de 0 a 99.').max(99, 'Una etapa abierta llega hasta 99 %.'), probability);
    fields.probability = p;
  }
  await pipes.updateStage(db, id, fields);
}
export async function createPipeline(db: ServerSupabase, orgId: string, name: string) {
  return pipes.createPipeline(db, orgId, parse(z.string().trim().min(1, 'Escribe el nombre del pipeline.').max(80), name));
}

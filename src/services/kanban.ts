import { z } from 'zod';
import type { ServerSupabase } from '@/lib/supabase/server';
import { UserFacingError } from '@/lib/errors';
import { OPP_CHANNELS, PRIORITIES, TEMPERATURES } from '@/lib/kanban';
import * as activities from '@/repositories/activities';
import * as opps from '@/repositories/opportunities';
import * as board from '@/repositories/opportunities-board';
import { firstIssue } from './schemas';

const blank = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) throw new UserFacingError(firstIssue(r.error));
  return r.data;
}

/** Mueve una oportunidad de etapa. Perder exige un motivo (regla de la base de datos, que es la que manda). */
export async function moveCard(db: ServerSupabase, input: unknown): Promise<void> {
  const d = parse(z.object({
    id: z.string().uuid('Oportunidad no válida.'), stageId: z.string().uuid('Etapa no válida.'),
    reason: z.preprocess(blank, z.string().trim().max(500, 'El motivo es demasiado largo (máximo 500 caracteres).').optional()),
  }), input);
  await opps.moveOpportunity(db, d.id, d.stageId, d.reason);
}

/** Prioridad, temperatura y canal: independientes de la etapa. Vacío = «sin definir» (temperatura y canal). */
export async function setFields(db: ServerSupabase, input: unknown): Promise<void> {
  const d = parse(z.object({
    id: z.string().uuid('Oportunidad no válida.'),
    priority: z.preprocess(blank, z.enum(PRIORITIES as [string, ...string[]], { errorMap: () => ({ message: 'Prioridad no válida.' }) }).optional()),
    temperature: z.union([z.literal(''), z.enum(TEMPERATURES as [string, ...string[]], { errorMap: () => ({ message: 'Temperatura no válida.' }) })]).optional(),
    channel: z.union([z.literal(''), z.enum(OPP_CHANNELS, { errorMap: () => ({ message: 'Canal no válido.' }) })]).optional(),
  }), input);
  await board.setOpportunityFields(db, d.id, {
    priority: d.priority, temperature: d.temperature === undefined ? undefined : d.temperature || null, channel: d.channel === undefined ? undefined : d.channel || null,
  });
}

export async function logActivity(db: ServerSupabase, input: unknown): Promise<string> {
  const d = parse(z.object({
    opportunityId: z.string().uuid('Oportunidad no válida.'), customerId: z.string().uuid('Cliente no válido.'),
    type: z.enum(['note', 'call', 'whatsapp', 'email', 'meeting'], { errorMap: () => ({ message: 'Tipo de actividad no válido.' }) }),
    summary: z.string().trim().min(1, 'Escribe qué pasó.').max(2000, 'El texto es demasiado largo (máximo 2000 caracteres).'),
    direction: z.preprocess(blank, z.enum(['inbound', 'outbound']).optional()),
  }), input);
  const needsDirection = d.type === 'call' || d.type === 'whatsapp' || d.type === 'email';
  return activities.logActivity(db, {
    customerId: d.customerId, type: d.type, summary: d.summary, opportunityId: d.opportunityId, ...(needsDirection ? { direction: d.direction ?? 'outbound' } : {}),
  });
}

export async function linkConversation(db: ServerSupabase, input: unknown): Promise<void> {
  const d = parse(z.object({ id: z.string().uuid('Oportunidad no válida.'), conversationId: z.preprocess(blank, z.string().uuid('Conversación no válida.').optional()) }), input);
  await board.linkConversation(db, d.id, d.conversationId ?? null);
}

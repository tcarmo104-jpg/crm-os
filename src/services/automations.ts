import { z } from 'zod';
import type { ServerSupabase } from '@/lib/supabase/server';
import { UserFacingError } from '@/lib/errors';
import { AUTOMATION_ACTIONS, AUTOMATION_TRIGGERS, CONDITION_OPS } from '@/lib/automations';
import * as automations from '@/repositories/automations';
import { firstIssue } from './schemas';

const blank = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

const conditionSchema = z.object({ field: z.string().trim().min(1), op: z.enum(CONDITION_OPS), value: z.string().trim().min(1, 'Escribe un valor para comparar.').max(200) });

// Cada tipo de acción tiene sus propios campos requeridos; se valida por tipo en `validateAction` más abajo,
// en vez de una unión estricta que repetiría 4 veces el mismo bloque de errores.
const genericActionSchema = z.object({ type: z.enum(AUTOMATION_ACTIONS, { errorMap: () => ({ message: 'Elige un tipo de acción válido.' }) }) }).passthrough();

const newRuleSchema = z.object({
  name: z.string().trim().min(1, 'Escribe el nombre de la regla.').max(120),
  trigger: z.enum(AUTOMATION_TRIGGERS, { errorMap: () => ({ message: 'Elige cuándo se debe disparar la regla.' }) }),
  conditions: z.array(conditionSchema).max(10, 'Máximo 10 condiciones.').default([]),
  actions: z.array(genericActionSchema).min(1, 'Agrega al menos una acción.').max(10, 'Máximo 10 acciones.'),
});

function validateAction(a: { type: string; [k: string]: unknown }): void {
  if (a.type === 'create_task' && !String(a.title ?? '').trim()) throw new UserFacingError('El título de la tarea es obligatorio.');
  if (a.type === 'add_tag' && !String(a.name ?? '').trim()) throw new UserFacingError('El nombre de la etiqueta es obligatorio.');
  if (a.type === 'assign_owner' && !String(a.ownerId ?? '').trim()) throw new UserFacingError('Elige a quién asignar.');
  if (a.type === 'enroll_sequence' && !String(a.sequenceId ?? '').trim()) throw new UserFacingError('Elige una secuencia.');
}

/** Crea una regla de automatización. Valida disparador, condiciones y acciones antes de tocar la base de datos. */
export async function createRule(db: ServerSupabase, orgId: string, input: unknown): Promise<string> {
  const r = newRuleSchema.safeParse(input);
  if (!r.success) throw new UserFacingError(firstIssue(r.error));
  for (const a of r.data.actions) validateAction(a);
  return automations.createRule(db, orgId, r.data.name, r.data.trigger, r.data.conditions, r.data.actions);
}

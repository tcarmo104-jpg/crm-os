import { z } from 'zod';
import type { ServerSupabase } from '@/lib/supabase/server';
import { UserFacingError } from '@/lib/errors';
import { SEQUENCE_STEP_TYPES } from '@/lib/sequences';
import * as sequences from '@/repositories/sequences';
import { firstIssue } from './schemas';

const blank = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const optStr = (max: number) => z.preprocess(blank, z.string().trim().max(max, 'El texto es demasiado largo.').optional());

const stepSchema = z.object({
  title: z.string().trim().min(1, 'Cada paso necesita un título.').max(160),
  type: z.enum(SEQUENCE_STEP_TYPES).default('follow_up'),
  offsetDays: z.coerce.number().int().min(0, 'Los días no pueden ser negativos.').max(365, 'Máximo 365 días.'),
  priority: z.enum(['low', 'normal', 'high']).default('normal'),
  description: optStr(2000),
});
const newSequenceSchema = z.object({
  name: z.string().trim().min(1, 'Escribe el nombre de la secuencia.').max(120),
  description: optStr(2000),
  steps: z.array(stepSchema).min(1, 'Agrega al menos un paso.').max(20, 'Máximo 20 pasos.'),
});

/** Crea una plantilla de secuencia. Valida que los pasos tengan sentido antes de tocar la base de datos. */
export async function createSequence(db: ServerSupabase, orgId: string, input: unknown): Promise<string> {
  const r = newSequenceSchema.safeParse(input);
  if (!r.success) throw new UserFacingError(firstIssue(r.error));
  return sequences.createSequence(db, orgId, r.data.name, r.data.description, r.data.steps);
}

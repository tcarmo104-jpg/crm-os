import { z } from 'zod';
import type { ServerSupabase } from '@/lib/supabase/server';
import { UserFacingError } from '@/lib/errors';
import { keyFromLabel, parseOptions } from '@/lib/custom-fields';
import * as repo from '@/repositories/custom-fields';
import { firstIssue } from './schemas';

import { FIELD_TYPE_LABELS } from '@/lib/custom-fields';
export { FIELD_TYPE_LABELS };

const schema = z.object({
  entity: z.enum(['customer', 'lead', 'opportunity'], { errorMap: () => ({ message: 'Selecciona dónde se usará el campo.' }) }),
  label: z.string().trim().min(1, 'Escribe el nombre del campo.').max(80, 'El nombre es demasiado largo.'),
  type: z.enum(Object.keys(FIELD_TYPE_LABELS) as [keyof typeof FIELD_TYPE_LABELS, ...(keyof typeof FIELD_TYPE_LABELS)[]], {
    errorMap: () => ({ message: 'Selecciona el tipo de campo.' }),
  }),
  options: z.string().max(5000).optional(),
});

export async function createField(db: ServerSupabase, orgId: string, input: unknown) {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new UserFacingError(firstIssue(parsed.error));
  const { entity, label, type, options } = parsed.data;
  const key = keyFromLabel(label);
  if (key.length < 2) throw new UserFacingError('El nombre debe incluir letras o números.');
  const opts = parseOptions(options ?? '');
  const isList = type === 'select' || type === 'multi_select';
  if (isList && opts.length === 0) throw new UserFacingError('Escribe al menos una opción (una por línea).');
  await repo.createFieldDefinition(db, orgId, { entity, key, label, type, options: isList ? opts : [] });
}

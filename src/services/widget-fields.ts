import { z } from 'zod';
import type { ServerSupabase } from '@/lib/supabase/server';
import { UserFacingError } from '@/lib/errors';
import { keyFromLabel, parseOptions } from '@/lib/custom-fields';
import { WIDGET_FIELD_TYPES, type WidgetFieldType } from '@/lib/widget-fields';
import * as repo from '@/repositories/widget-fields';
import { firstIssue } from './schemas';

const createSchema = z.object({
  label: z.string().trim().min(1, 'Escribe el nombre del campo.').max(80, 'El nombre es demasiado largo.'),
  fieldType: z.enum(WIDGET_FIELD_TYPES as [WidgetFieldType, ...WidgetFieldType[]], { errorMap: () => ({ message: 'Selecciona el tipo de campo.' }) }),
  placeholder: z.string().trim().max(160).optional(),
  options: z.string().max(5000).optional(),
});
const updateSchema = z.object({
  label: z.string().trim().min(1, 'Escribe el nombre del campo.').max(80),
  placeholder: z.string().trim().max(160).optional(),
  options: z.string().max(5000).optional(),
});

export async function createWidgetField(db: ServerSupabase, orgId: string, input: unknown): Promise<string> {
  const r = createSchema.safeParse(input);
  if (!r.success) throw new UserFacingError(firstIssue(r.error));
  const key = keyFromLabel(r.data.label);
  if (key.length < 2) throw new UserFacingError('El nombre debe incluir letras o números.');
  const opts = parseOptions(r.data.options ?? '');
  if (r.data.fieldType === 'select' && opts.length === 0) throw new UserFacingError('Escribe al menos una opción (una por línea).');
  return repo.createWidgetField(db, orgId, { key, label: r.data.label, fieldType: r.data.fieldType, placeholder: r.data.placeholder || null, options: r.data.fieldType === 'select' ? opts : [] });
}
export async function updateWidgetField(db: ServerSupabase, id: string, fieldType: WidgetFieldType, input: unknown): Promise<void> {
  const r = updateSchema.safeParse(input);
  if (!r.success) throw new UserFacingError(firstIssue(r.error));
  const opts = parseOptions(r.data.options ?? '');
  if (fieldType === 'select' && opts.length === 0) throw new UserFacingError('Escribe al menos una opción (una por línea).');
  await repo.updateWidgetField(db, id, { label: r.data.label, placeholder: r.data.placeholder || null, options: fieldType === 'select' ? opts : [] });
}

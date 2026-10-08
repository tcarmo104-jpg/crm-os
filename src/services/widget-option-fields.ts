import { z } from 'zod';
import type { ServerSupabase } from '@/lib/supabase/server';
import { UserFacingError } from '@/lib/errors';
import * as repo from '@/repositories/widget-option-fields';

const emptyToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

const schema = z.object({
  fieldId: z.string().uuid('Selecciona un campo.'),
  required: z.boolean(),
  labelOverride: z.preprocess(emptyToUndefined, z.string().trim().max(80).optional()),
  placeholderOverride: z.preprocess(emptyToUndefined, z.string().trim().max(160).optional()),
  defaultValue: z.preprocess(emptyToUndefined, z.string().trim().max(200).optional()),
});

/** Agrega un campo del catálogo a una intención, al final de su orden actual. */
export async function addFieldToOption(db: ServerSupabase, orgId: string, optionId: string, input: unknown): Promise<void> {
  const r = schema.safeParse(input);
  if (!r.success) throw new UserFacingError(r.error.issues[0]?.message ?? 'Revisa los datos ingresados.');
  const existing = await repo.listOptionFields(db, optionId);
  if (existing.some((f) => f.fieldId === r.data.fieldId)) throw new UserFacingError('Ese campo ya está agregado a esta opción.');
  const nextPosition = existing.length === 0 ? 10 : Math.max(...existing.map((f) => f.position)) + 10;
  await repo.addFieldToOption(db, orgId, optionId, r.data.fieldId, nextPosition, {
    required: r.data.required, labelOverride: r.data.labelOverride ?? null, placeholderOverride: r.data.placeholderOverride ?? null, defaultValue: r.data.defaultValue ?? null,
  });
}
export async function updateOptionField(db: ServerSupabase, optionId: string, input: unknown): Promise<void> {
  const r = schema.safeParse(input);
  if (!r.success) throw new UserFacingError(r.error.issues[0]?.message ?? 'Revisa los datos ingresados.');
  await repo.updateOptionField(db, optionId, r.data.fieldId, {
    required: r.data.required, labelOverride: r.data.labelOverride ?? null, placeholderOverride: r.data.placeholderOverride ?? null, defaultValue: r.data.defaultValue ?? null,
  });
}
/** Igual patrón de reordenar-y-renumerar que las opciones del widget, pero dentro de una sola intención. */
export async function moveOptionField(db: ServerSupabase, optionId: string, fieldId: string, dir: 'up' | 'down'): Promise<void> {
  const delta = dir === 'up' ? -1 : 1;
  const all = (await repo.listOptionFields(db, optionId)).sort((a, b) => a.position - b.position);
  const i = all.findIndex((f) => f.fieldId === fieldId);
  const other = all[i + delta];
  if (i === -1 || !other) return;
  const reordered = all.slice();
  reordered[i] = other;
  reordered[i + delta] = all[i]!;
  for (const [idx, f] of reordered.entries()) {
    const position = (idx + 1) * 10;
    if (f.position !== position) await repo.setOptionFieldPosition(db, optionId, f.fieldId, position);
  }
}

import { z } from 'zod';
import type { ServerSupabase } from '@/lib/supabase/server';
import { UserFacingError } from '@/lib/errors';
import * as repo from '@/repositories/widget-options';

const emptyToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

const schema = z.object({
  icon: z.preprocess(emptyToUndefined, z.string().trim().max(16).optional()),
  label: z.string().trim().min(1, 'Escribe el nombre de la opción.').max(60, 'El nombre es demasiado largo.'),
  messageTemplate: z.preprocess(emptyToUndefined, z.string().trim().max(1000).optional()),
});

export async function createWidgetOption(db: ServerSupabase, orgId: string, widgetId: string, input: unknown): Promise<string> {
  const r = schema.safeParse(input);
  if (!r.success) throw new UserFacingError(r.error.issues[0]?.message ?? 'Revisa los datos ingresados.');
  const existing = await repo.listWidgetOptions(db, widgetId);
  const nextPosition = existing.length === 0 ? 10 : Math.max(...existing.map((o) => o.position)) + 10;
  return repo.createWidgetOption(db, orgId, widgetId, nextPosition, { icon: r.data.icon ?? null, label: r.data.label, messageTemplate: r.data.messageTemplate ?? null });
}
export async function updateWidgetOption(db: ServerSupabase, id: string, input: unknown): Promise<void> {
  const r = schema.safeParse(input);
  if (!r.success) throw new UserFacingError(r.error.issues[0]?.message ?? 'Revisa los datos ingresados.');
  await repo.updateWidgetOption(db, id, { icon: r.data.icon ?? null, label: r.data.label, messageTemplate: r.data.messageTemplate ?? null });
}
/** Mueve una opción un lugar arriba/abajo dentro de su widget y renumera todo el grupo (10, 20, 30…), igual
 * que las etapas del pipeline — así no depende de que las posiciones vengan ya sin huecos ni repetidas. */
export async function moveWidgetOption(db: ServerSupabase, widgetId: string, optionId: string, dir: 'up' | 'down'): Promise<void> {
  const delta = dir === 'up' ? -1 : 1;
  const all = (await repo.listWidgetOptions(db, widgetId)).sort((a, b) => a.position - b.position || a.label.localeCompare(b.label));
  const i = all.findIndex((o) => o.id === optionId);
  const other = all[i + delta];
  if (i === -1 || !other) return;
  const reordered = all.slice();
  reordered[i] = other;
  reordered[i + delta] = all[i]!;
  for (const [idx, o] of reordered.entries()) {
    const position = (idx + 1) * 10;
    if (o.position !== position) await repo.setWidgetOptionPosition(db, o.id, position);
  }
}

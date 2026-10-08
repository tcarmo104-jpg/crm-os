import type { ServerSupabase } from '@/lib/supabase/server';
import { unwrap } from '@/lib/errors';
import type { WidgetFieldType } from '@/lib/widget-fields';

export interface WidgetFieldRow {
  id: string; key: string; label: string; fieldType: WidgetFieldType; placeholder: string | null; options: string[]; active: boolean; createdAt: string;
}
const COLUMNS = 'id, key, label, field_type, placeholder, options, active, created_at';
const map = (r: Record<string, unknown>): WidgetFieldRow => ({
  id: r.id as string, key: r.key as string, label: r.label as string, fieldType: r.field_type as WidgetFieldType,
  placeholder: (r.placeholder as string | null) ?? null, options: (r.options as string[]) ?? [], active: r.active as boolean, createdAt: r.created_at as string,
});

/** El catálogo completo de la organización (activos primero, luego por nombre) — se reutiliza entre widgets. */
export async function listWidgetFields(db: ServerSupabase, orgId: string): Promise<WidgetFieldRow[]> {
  const rows = unwrap(
    await db.from('widget_fields').select(COLUMNS).eq('org_id', orgId).order('active', { ascending: false }).order('label'),
  ) as unknown as Record<string, unknown>[];
  return rows.map(map);
}
export async function getWidgetField(db: ServerSupabase, id: string): Promise<WidgetFieldRow | null> {
  const rows = unwrap(await db.from('widget_fields').select(COLUMNS).eq('id', id).limit(1)) as unknown as Record<string, unknown>[];
  return rows[0] ? map(rows[0]) : null;
}
export interface WidgetFieldInput { key: string; label: string; fieldType: WidgetFieldType; placeholder: string | null; options: string[] }
export async function createWidgetField(db: ServerSupabase, orgId: string, i: WidgetFieldInput): Promise<string> {
  const row = unwrap(
    await db.from('widget_fields').insert({ org_id: orgId, key: i.key, label: i.label, field_type: i.fieldType, placeholder: i.placeholder, options: i.options }).select('id').single(),
  ) as unknown as { id: string };
  return row.id;
}
export async function updateWidgetField(db: ServerSupabase, id: string, i: Pick<WidgetFieldInput, 'label' | 'placeholder' | 'options'>): Promise<void> {
  unwrap(await db.from('widget_fields').update({ label: i.label, placeholder: i.placeholder, options: i.options }).eq('id', id));
}
export async function setWidgetFieldActive(db: ServerSupabase, id: string, active: boolean): Promise<void> {
  unwrap(await db.from('widget_fields').update({ active }).eq('id', id));
}
export async function deleteWidgetField(db: ServerSupabase, id: string): Promise<void> {
  unwrap(await db.from('widget_fields').delete().eq('id', id));
}

import type { ServerSupabase } from '@/lib/supabase/server';
import { unwrap } from '@/lib/errors';
import type { WidgetFieldType } from '@/lib/widget-fields';

/** Un campo del formulario BASE del widget (Entrega 4): el que el visitante siempre ve, tenga o no
 * intenciones configuradas. Mismo molde que `WidgetOptionFieldRow`, pero sin una opción por delante. */
export interface WidgetDefaultFieldRow {
  fieldId: string; key: string; fieldType: WidgetFieldType; catalogLabel: string; catalogPlaceholder: string | null; catalogOptions: string[];
  position: number; required: boolean; labelOverride: string | null; placeholderOverride: string | null; defaultValue: string | null;
}
interface Raw {
  field_id: string; position: number; required: boolean; label_override: string | null; placeholder_override: string | null; default_value: string | null;
  field: { key: string; field_type: WidgetFieldType; label: string; placeholder: string | null; options: string[] } | null;
}
const map = (r: Raw): WidgetDefaultFieldRow => ({
  fieldId: r.field_id, key: r.field?.key ?? '', fieldType: r.field?.field_type ?? 'text', catalogLabel: r.field?.label ?? '(campo eliminado)',
  catalogPlaceholder: r.field?.placeholder ?? null, catalogOptions: r.field?.options ?? [],
  position: r.position, required: r.required, labelOverride: r.label_override, placeholderOverride: r.placeholder_override, defaultValue: r.default_value,
});

/** Los campos del formulario base de un widget, en orden, con los datos del catálogo ya incluidos. */
export async function listDefaultFields(db: ServerSupabase, widgetId: string): Promise<WidgetDefaultFieldRow[]> {
  const rows = unwrap(
    await db.from('widget_default_fields')
      .select('field_id, position, required, label_override, placeholder_override, default_value, field:widget_fields(key, field_type, label, placeholder, options)')
      .eq('widget_id', widgetId).order('position'),
  ) as unknown as Raw[];
  return rows.map(map);
}
export interface DefaultFieldInput { required: boolean; labelOverride: string | null; placeholderOverride: string | null; defaultValue: string | null }
export async function addDefaultField(db: ServerSupabase, orgId: string, widgetId: string, fieldId: string, position: number, i: DefaultFieldInput): Promise<void> {
  unwrap(
    await db.from('widget_default_fields').insert({
      org_id: orgId, widget_id: widgetId, field_id: fieldId, position,
      required: i.required, label_override: i.labelOverride, placeholder_override: i.placeholderOverride, default_value: i.defaultValue,
    }),
  );
}
export async function updateDefaultField(db: ServerSupabase, widgetId: string, fieldId: string, i: DefaultFieldInput): Promise<void> {
  unwrap(
    await db.from('widget_default_fields')
      .update({ required: i.required, label_override: i.labelOverride, placeholder_override: i.placeholderOverride, default_value: i.defaultValue })
      .eq('widget_id', widgetId).eq('field_id', fieldId),
  );
}
export async function setDefaultFieldPosition(db: ServerSupabase, widgetId: string, fieldId: string, position: number): Promise<void> {
  unwrap(await db.from('widget_default_fields').update({ position }).eq('widget_id', widgetId).eq('field_id', fieldId));
}
export async function removeDefaultField(db: ServerSupabase, widgetId: string, fieldId: string): Promise<void> {
  unwrap(await db.from('widget_default_fields').delete().eq('widget_id', widgetId).eq('field_id', fieldId));
}

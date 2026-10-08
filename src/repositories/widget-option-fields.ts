import type { ServerSupabase } from '@/lib/supabase/server';
import { unwrap } from '@/lib/errors';
import type { WidgetFieldType } from '@/lib/widget-fields';

/** Un campo ya asignado a una intención, con el campo del catálogo que referencia (para mostrarlo sin una
 * segunda consulta: tipo, opciones de lista) y las variaciones propias de esta intención. */
export interface WidgetOptionFieldRow {
  fieldId: string; key: string; fieldType: WidgetFieldType; catalogLabel: string; catalogPlaceholder: string | null; catalogOptions: string[];
  position: number; required: boolean; labelOverride: string | null; placeholderOverride: string | null; defaultValue: string | null;
}
interface Raw {
  field_id: string; position: number; required: boolean; label_override: string | null; placeholder_override: string | null; default_value: string | null;
  field: { key: string; field_type: WidgetFieldType; label: string; placeholder: string | null; options: string[] } | null;
}
const map = (r: Raw): WidgetOptionFieldRow => ({
  fieldId: r.field_id, key: r.field?.key ?? '', fieldType: r.field?.field_type ?? 'text', catalogLabel: r.field?.label ?? '(campo eliminado)',
  catalogPlaceholder: r.field?.placeholder ?? null, catalogOptions: r.field?.options ?? [],
  position: r.position, required: r.required, labelOverride: r.label_override, placeholderOverride: r.placeholder_override, defaultValue: r.default_value,
});

/** Los campos de una intención, en orden, con los datos del catálogo ya incluidos. */
export async function listOptionFields(db: ServerSupabase, optionId: string): Promise<WidgetOptionFieldRow[]> {
  const rows = unwrap(
    await db.from('widget_option_fields')
      .select('field_id, position, required, label_override, placeholder_override, default_value, field:widget_fields(key, field_type, label, placeholder, options)')
      .eq('option_id', optionId).order('position'),
  ) as unknown as Raw[];
  return rows.map(map);
}
export interface OptionFieldInput { required: boolean; labelOverride: string | null; placeholderOverride: string | null; defaultValue: string | null }
export async function addFieldToOption(db: ServerSupabase, orgId: string, optionId: string, fieldId: string, position: number, i: OptionFieldInput): Promise<void> {
  unwrap(
    await db.from('widget_option_fields').insert({
      org_id: orgId, option_id: optionId, field_id: fieldId, position,
      required: i.required, label_override: i.labelOverride, placeholder_override: i.placeholderOverride, default_value: i.defaultValue,
    }),
  );
}
export async function updateOptionField(db: ServerSupabase, optionId: string, fieldId: string, i: OptionFieldInput): Promise<void> {
  unwrap(
    await db.from('widget_option_fields')
      .update({ required: i.required, label_override: i.labelOverride, placeholder_override: i.placeholderOverride, default_value: i.defaultValue })
      .eq('option_id', optionId).eq('field_id', fieldId),
  );
}
export async function setOptionFieldPosition(db: ServerSupabase, optionId: string, fieldId: string, position: number): Promise<void> {
  unwrap(await db.from('widget_option_fields').update({ position }).eq('option_id', optionId).eq('field_id', fieldId));
}
export async function removeFieldFromOption(db: ServerSupabase, optionId: string, fieldId: string): Promise<void> {
  unwrap(await db.from('widget_option_fields').delete().eq('option_id', optionId).eq('field_id', fieldId));
}

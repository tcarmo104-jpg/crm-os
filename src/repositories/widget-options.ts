import type { ServerSupabase } from '@/lib/supabase/server';
import { unwrap } from '@/lib/errors';

export interface WidgetOptionRow {
  id: string; widgetId: string; icon: string | null; label: string; messageTemplate: string | null; position: number; active: boolean; createdAt: string;
}
const COLUMNS = 'id, widget_id, icon, label, message_template, position, active, created_at';
const map = (r: Record<string, unknown>): WidgetOptionRow => ({
  id: r.id as string, widgetId: r.widget_id as string, icon: (r.icon as string | null) ?? null, label: r.label as string,
  messageTemplate: (r.message_template as string | null) ?? null, position: r.position as number, active: r.active as boolean, createdAt: r.created_at as string,
});

/** Las intenciones de un widget, en el orden en que se muestran (incluye inactivas, para administrarlas). */
export async function listWidgetOptions(db: ServerSupabase, widgetId: string): Promise<WidgetOptionRow[]> {
  const rows = unwrap(
    await db.from('widget_options').select(COLUMNS).eq('widget_id', widgetId).order('position').order('created_at'),
  ) as unknown as Record<string, unknown>[];
  return rows.map(map);
}
export async function getWidgetOption(db: ServerSupabase, id: string): Promise<WidgetOptionRow | null> {
  const rows = unwrap(await db.from('widget_options').select(COLUMNS).eq('id', id).limit(1)) as unknown as Record<string, unknown>[];
  return rows[0] ? map(rows[0]) : null;
}
export interface WidgetOptionInput { icon: string | null; label: string; messageTemplate: string | null }
export async function createWidgetOption(db: ServerSupabase, orgId: string, widgetId: string, position: number, i: WidgetOptionInput): Promise<string> {
  const row = unwrap(
    await db.from('widget_options')
      .insert({ org_id: orgId, widget_id: widgetId, icon: i.icon, label: i.label, message_template: i.messageTemplate, position })
      .select('id').single(),
  ) as unknown as { id: string };
  return row.id;
}
export async function updateWidgetOption(db: ServerSupabase, id: string, i: WidgetOptionInput): Promise<void> {
  unwrap(await db.from('widget_options').update({ icon: i.icon, label: i.label, message_template: i.messageTemplate }).eq('id', id));
}
export async function setWidgetOptionPosition(db: ServerSupabase, id: string, position: number): Promise<void> {
  unwrap(await db.from('widget_options').update({ position }).eq('id', id));
}
export async function setWidgetOptionActive(db: ServerSupabase, id: string, active: boolean): Promise<void> {
  unwrap(await db.from('widget_options').update({ active }).eq('id', id));
}
export async function deleteWidgetOption(db: ServerSupabase, id: string): Promise<void> {
  unwrap(await db.from('widget_options').delete().eq('id', id));
}

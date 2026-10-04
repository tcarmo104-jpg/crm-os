import type { ServerSupabase } from '@/lib/supabase/server';
import { unwrap } from '@/lib/errors';
import type { WidgetPosition, WidgetSize } from '@/lib/widgets';

export interface WidgetRow {
  id: string; channelId: string; name: string; buttonText: string; initialMessage: string | null; position: WidgetPosition;
  showText: boolean; color: string; size: WidgetSize; active: boolean; allowedDomains: string[]; conversationsCount: number; createdAt: string;
}
const COLUMNS = 'id, channel_id, name, button_text, initial_message, position, show_text, color, size, active, allowed_domains, conversations_count, created_at';
const map = (r: Record<string, unknown>): WidgetRow => ({
  id: r.id as string, channelId: r.channel_id as string, name: r.name as string, buttonText: r.button_text as string,
  initialMessage: r.initial_message as string | null, position: r.position as WidgetPosition, showText: r.show_text as boolean,
  color: r.color as string, size: r.size as WidgetSize, active: r.active as boolean, allowedDomains: (r.allowed_domains as string[]) ?? [],
  conversationsCount: r.conversations_count as number, createdAt: r.created_at as string,
});

export async function listWidgets(db: ServerSupabase, orgId: string): Promise<WidgetRow[]> {
  const rows = unwrap(await db.from('whatsapp_widgets').select(COLUMNS).eq('org_id', orgId).order('created_at', { ascending: false })) as unknown as Record<string, unknown>[];
  return rows.map(map);
}
export async function getWidget(db: ServerSupabase, id: string): Promise<WidgetRow | null> {
  const rows = unwrap(await db.from('whatsapp_widgets').select(COLUMNS).eq('id', id).limit(1)) as unknown as Record<string, unknown>[];
  return rows[0] ? map(rows[0]) : null;
}
export interface WidgetInput {
  channelId: string; name: string; buttonText: string; initialMessage: string | null; position: WidgetPosition;
  showText: boolean; color: string; size: WidgetSize; allowedDomains: string[];
}
export async function createWidget(db: ServerSupabase, orgId: string, i: WidgetInput): Promise<string> {
  const row = unwrap(await db.from('whatsapp_widgets').insert({
    org_id: orgId, channel_id: i.channelId, name: i.name, button_text: i.buttonText, initial_message: i.initialMessage,
    position: i.position, show_text: i.showText, color: i.color, size: i.size, allowed_domains: i.allowedDomains,
  }).select('id').single()) as unknown as { id: string };
  return row.id;
}
export async function updateWidget(db: ServerSupabase, id: string, i: WidgetInput): Promise<void> {
  unwrap(await db.from('whatsapp_widgets').update({
    channel_id: i.channelId, name: i.name, button_text: i.buttonText, initial_message: i.initialMessage,
    position: i.position, show_text: i.showText, color: i.color, size: i.size, allowed_domains: i.allowedDomains,
  }).eq('id', id));
}
export async function setWidgetActive(db: ServerSupabase, id: string, active: boolean): Promise<void> { unwrap(await db.from('whatsapp_widgets').update({ active }).eq('id', id)); }
export async function deleteWidget(db: ServerSupabase, id: string): Promise<void> { unwrap(await db.from('whatsapp_widgets').delete().eq('id', id)); }

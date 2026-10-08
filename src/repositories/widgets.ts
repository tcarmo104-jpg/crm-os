import type { ServerSupabase } from '@/lib/supabase/server';
import { unwrap } from '@/lib/errors';
import type { BusinessHourRange, WidgetPosition, WidgetSize } from '@/lib/widgets';

export interface WidgetRow {
  id: string; channelId: string; name: string; buttonText: string; initialMessage: string | null; position: WidgetPosition;
  showText: boolean; color: string; size: WidgetSize; active: boolean; allowedDomains: string[]; region: string | null; messageTemplate: string | null; conversationsCount: number; createdAt: string;
  businessHours: BusinessHourRange[]; timezone: string; outOfHoursMessage: string | null; showAdvisor: boolean; advisorUserId: string | null;
}
const COLUMNS = 'id, channel_id, name, button_text, initial_message, position, show_text, color, size, active, allowed_domains, region, message_template, conversations_count, created_at, business_hours, timezone, out_of_hours_message, show_advisor, advisor_user_id';
const map = (r: Record<string, unknown>): WidgetRow => ({
  id: r.id as string, channelId: r.channel_id as string, name: r.name as string, buttonText: r.button_text as string,
  initialMessage: r.initial_message as string | null, position: r.position as WidgetPosition, showText: r.show_text as boolean,
  color: r.color as string, size: r.size as WidgetSize, active: r.active as boolean, allowedDomains: (r.allowed_domains as string[]) ?? [],
  region: (r.region as string | null) ?? null, messageTemplate: (r.message_template as string | null) ?? null,
  conversationsCount: r.conversations_count as number, createdAt: r.created_at as string,
  businessHours: (r.business_hours as BusinessHourRange[]) ?? [], timezone: (r.timezone as string) ?? 'America/Bogota',
  outOfHoursMessage: (r.out_of_hours_message as string | null) ?? null, showAdvisor: Boolean(r.show_advisor), advisorUserId: (r.advisor_user_id as string | null) ?? null,
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
  showText: boolean; color: string; size: WidgetSize; allowedDomains: string[]; region: string | null; messageTemplate: string | null;
  businessHours: BusinessHourRange[]; timezone: string; outOfHoursMessage: string | null; showAdvisor: boolean; advisorUserId: string | null;
}
export async function createWidget(db: ServerSupabase, orgId: string, i: WidgetInput): Promise<string> {
  const row = unwrap(await db.from('whatsapp_widgets').insert({
    org_id: orgId, channel_id: i.channelId, name: i.name, button_text: i.buttonText, initial_message: i.initialMessage,
    position: i.position, show_text: i.showText, color: i.color, size: i.size, allowed_domains: i.allowedDomains, region: i.region, message_template: i.messageTemplate,
    business_hours: i.businessHours, timezone: i.timezone, out_of_hours_message: i.outOfHoursMessage, show_advisor: i.showAdvisor, advisor_user_id: i.advisorUserId,
  }).select('id').single()) as unknown as { id: string };
  return row.id;
}
export async function updateWidget(db: ServerSupabase, id: string, i: WidgetInput): Promise<void> {
  unwrap(await db.from('whatsapp_widgets').update({
    channel_id: i.channelId, name: i.name, button_text: i.buttonText, initial_message: i.initialMessage,
    position: i.position, show_text: i.showText, color: i.color, size: i.size, allowed_domains: i.allowedDomains, region: i.region, message_template: i.messageTemplate,
    business_hours: i.businessHours, timezone: i.timezone, out_of_hours_message: i.outOfHoursMessage, show_advisor: i.showAdvisor, advisor_user_id: i.advisorUserId,
  }).eq('id', id));
}
export async function setWidgetActive(db: ServerSupabase, id: string, active: boolean): Promise<void> { unwrap(await db.from('whatsapp_widgets').update({ active }).eq('id', id)); }
export async function deleteWidget(db: ServerSupabase, id: string): Promise<void> { unwrap(await db.from('whatsapp_widgets').delete().eq('id', id)); }

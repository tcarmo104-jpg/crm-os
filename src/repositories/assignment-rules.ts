import type { ServerSupabase } from '@/lib/supabase/server';
import { unwrap } from '@/lib/errors';
import type { ChannelKindFilter, Weekday } from '@/lib/assignment-rules';

export interface AssignmentRuleRow {
  id: string; name: string; active: boolean; priority: number; channelKind: ChannelKindFilter | null; widgetId: string | null;
  region: string | null; teamId: string; hoursStart: string | null; hoursEnd: string | null; hoursDays: Weekday[]; timezone: string; createdAt: string;
}
const COLUMNS = 'id, name, active, priority, channel_kind, widget_id, region, team_id, hours_start, hours_end, hours_days, timezone, created_at';
const map = (r: Record<string, unknown>): AssignmentRuleRow => ({
  id: r.id as string, name: r.name as string, active: r.active as boolean, priority: r.priority as number,
  channelKind: r.channel_kind as ChannelKindFilter | null, widgetId: r.widget_id as string | null, region: r.region as string | null,
  teamId: r.team_id as string, hoursStart: r.hours_start as string | null, hoursEnd: r.hours_end as string | null,
  hoursDays: (r.hours_days as number[] | null ?? []) as Weekday[], timezone: r.timezone as string, createdAt: r.created_at as string,
});

export async function listAssignmentRules(db: ServerSupabase, orgId: string): Promise<AssignmentRuleRow[]> {
  const rows = unwrap(await db.from('assignment_rules').select(COLUMNS).eq('org_id', orgId).order('priority', { ascending: true })) as unknown as Record<string, unknown>[];
  return rows.map(map);
}
export async function getAssignmentRule(db: ServerSupabase, id: string): Promise<AssignmentRuleRow | null> {
  const rows = unwrap(await db.from('assignment_rules').select(COLUMNS).eq('id', id).limit(1)) as unknown as Record<string, unknown>[];
  return rows[0] ? map(rows[0]) : null;
}
export interface AssignmentRuleInput {
  name: string; active: boolean; priority: number; channelKind: ChannelKindFilter | null; widgetId: string | null;
  region: string | null; teamId: string; hoursStart: string | null; hoursEnd: string | null; hoursDays: Weekday[]; timezone: string;
}
export async function createAssignmentRule(db: ServerSupabase, orgId: string, i: AssignmentRuleInput): Promise<string> {
  const row = unwrap(await db.from('assignment_rules').insert({
    org_id: orgId, name: i.name, active: i.active, priority: i.priority, channel_kind: i.channelKind, widget_id: i.widgetId,
    region: i.region, team_id: i.teamId, hours_start: i.hoursStart, hours_end: i.hoursEnd, hours_days: i.hoursDays, timezone: i.timezone,
  }).select('id').single()) as unknown as { id: string };
  return row.id;
}
export async function updateAssignmentRule(db: ServerSupabase, id: string, i: AssignmentRuleInput): Promise<void> {
  unwrap(await db.from('assignment_rules').update({
    name: i.name, active: i.active, priority: i.priority, channel_kind: i.channelKind, widget_id: i.widgetId,
    region: i.region, team_id: i.teamId, hours_start: i.hoursStart, hours_end: i.hoursEnd, hours_days: i.hoursDays, timezone: i.timezone,
  }).eq('id', id));
}
export async function setAssignmentRuleActive(db: ServerSupabase, id: string, active: boolean): Promise<void> { unwrap(await db.from('assignment_rules').update({ active }).eq('id', id)); }
export async function deleteAssignmentRule(db: ServerSupabase, id: string): Promise<void> { unwrap(await db.from('assignment_rules').delete().eq('id', id)); }

import type { ServerSupabase } from '@/lib/supabase/server';
import { unwrap } from '@/lib/errors';
import type { AutomationTrigger, RuleAction, RuleCondition, RunStatus } from '@/lib/automations';

export interface RuleRow {
  id: string; name: string; trigger: AutomationTrigger; conditions: RuleCondition[]; actions: RuleAction[];
  isActive: boolean; createdBy: string; createdAt: string;
}
export interface RunRow { id: string; ruleId: string; eventId: string; status: RunStatus; detail: string | null; ranAt: string }

const mapRule = (r: Record<string, unknown>): RuleRow => ({
  id: r.id as string, name: r.name as string, trigger: r.trigger as AutomationTrigger,
  conditions: (r.conditions as RuleCondition[]) ?? [], actions: (r.actions as RuleAction[]) ?? [],
  isActive: r.is_active as boolean, createdBy: r.created_by as string, createdAt: r.created_at as string,
});
const mapRun = (r: Record<string, unknown>): RunRow => ({
  id: r.id as string, ruleId: r.rule_id as string, eventId: r.event_id as string,
  status: r.status as RunStatus, detail: (r.detail as string | null) ?? null, ranAt: r.ran_at as string,
});

export async function listRules(db: ServerSupabase, orgId: string): Promise<RuleRow[]> {
  const rows = unwrap(await db.from('automation_rules').select('*').eq('org_id', orgId).order('created_at', { ascending: false })) as unknown as Record<string, unknown>[];
  return rows.map(mapRule);
}
export async function getRule(db: ServerSupabase, id: string): Promise<RuleRow | null> {
  const rows = unwrap(await db.from('automation_rules').select('*').eq('id', id).limit(1)) as unknown as Record<string, unknown>[];
  return rows[0] ? mapRule(rows[0]) : null;
}
export const createRule = async (db: ServerSupabase, orgId: string, name: string, trigger: string, conditions: RuleCondition[], actions: RuleAction[]) =>
  unwrap(await db.rpc('create_automation_rule', { p_org: orgId, p_name: name, p_trigger: trigger, p_conditions: conditions, p_actions: actions })) as unknown as string;
export const setRuleActive = async (db: ServerSupabase, id: string, active: boolean) => { unwrap(await db.rpc('set_automation_active', { p_id: id, p_active: active })); };

export async function listRuns(db: ServerSupabase, ruleId: string, limit = 50): Promise<RunRow[]> {
  const rows = unwrap(await db.from('automation_runs').select('*').eq('rule_id', ruleId).order('ran_at', { ascending: false }).limit(limit)) as unknown as Record<string, unknown>[];
  return rows.map(mapRun);
}

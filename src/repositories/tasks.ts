import type { ServerSupabase } from '@/lib/supabase/server';
import { DbError, unwrap } from '@/lib/errors';
import type { TaskRow, TaskStatus } from '@/lib/types';

const COLUMNS = 'id, title, description, type, priority, due_at, status, assignee_id, customer_id, opportunity_id, outcome, completed_at, created_at';
interface Raw {
  id: string; title: string; description: string | null; type: string; priority: string; due_at: string | null; status: TaskStatus;
  assignee_id: string | null; customer_id: string | null; opportunity_id: string | null; outcome: string | null;
  completed_at: string | null; created_at: string;
}
const map = (r: Raw): TaskRow => ({
  id: r.id, title: r.title, description: r.description, type: r.type, priority: r.priority, dueAt: r.due_at, status: r.status,
  assigneeId: r.assignee_id, customerId: r.customer_id, opportunityId: r.opportunity_id, outcome: r.outcome,
  completedAt: r.completed_at, createdAt: r.created_at,
});

export async function listTasks(
  db: ServerSupabase,
  p: {
    orgId: string; status?: TaskStatus; statuses?: TaskStatus[]; assigneeId?: string; unassigned?: boolean;
    customerId?: string; opportunityId?: string; type?: string; priority?: string; q?: string; limit?: number;
  },
): Promise<TaskRow[]> {
  let q = db.from('tasks').select(COLUMNS).eq('org_id', p.orgId);
  if (p.status) q = q.eq('status', p.status);
  else if (p.statuses && p.statuses.length > 0) q = q.in('status', p.statuses);
  if (p.assigneeId) q = q.eq('assignee_id', p.assigneeId);
  if (p.unassigned) q = q.is('assignee_id', null);
  if (p.customerId) q = q.eq('customer_id', p.customerId);
  if (p.opportunityId) q = q.eq('opportunity_id', p.opportunityId);
  if (p.type) q = q.eq('type', p.type);
  if (p.priority) q = q.eq('priority', p.priority);
  if (p.q && p.q.trim()) { const t = p.q.trim().replace(/[%_,]/g, ''); q = q.or(`title.ilike.%${t}%,description.ilike.%${t}%`); }
  const closed = p.status === 'done' || p.status === 'cancelled';
  q = closed ? q.order('completed_at', { ascending: false, nullsFirst: false }) : q.order('due_at', { ascending: true, nullsFirst: false });
  return (unwrap(await q.order('id').limit(Math.min(p.limit ?? 200, 500))) as unknown as Raw[]).map(map);
}

export async function countOverdue(db: ServerSupabase, orgId: string, assigneeId: string): Promise<number> {
  const res = await db.from('tasks').select('id', { count: 'exact', head: true })
    .eq('org_id', orgId).eq('assignee_id', assigneeId).eq('status', 'open').lt('due_at', new Date().toISOString());
  if (res.error) throw new DbError(res.error);
  return res.count ?? 0;
}

export async function createTask(
  db: ServerSupabase, orgId: string,
  a: { title: string; type: string; dueAt?: string; priority: string; description?: string; customerId?: string; opportunityId?: string; assigneeId?: string },
): Promise<string> {
  return unwrap(await db.rpc('create_task', {
    p_org: orgId, p_title: a.title, p_type: a.type, p_due: a.dueAt ?? null, p_priority: a.priority, p_description: a.description ?? null,
    p_customer: a.customerId ?? null, p_opportunity: a.opportunityId ?? null, p_assignee: a.assigneeId ?? null,
  })) as string;
}
export const completeTask = async (db: ServerSupabase, id: string, outcome?: string) => { unwrap(await db.rpc('complete_task', { p_id: id, p_outcome: outcome ?? null })); };
export const cancelTask = async (db: ServerSupabase, id: string, reason?: string) => { unwrap(await db.rpc('cancel_task', { p_id: id, p_reason: reason ?? null })); };
export const reopenTask = async (db: ServerSupabase, id: string) => { unwrap(await db.rpc('reopen_task', { p_id: id })); };
export async function updateTask(db: ServerSupabase, id: string, fields: Record<string, unknown>) {
  unwrap(await db.from('tasks').update(fields).eq('id', id).select('id').single());
}

export const startTask = async (db: ServerSupabase, id: string) => { unwrap(await db.rpc('start_task', { p_id: id })); };

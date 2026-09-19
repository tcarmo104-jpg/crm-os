import type { ServerSupabase } from '@/lib/supabase/server';
import { unwrap } from '@/lib/errors';
import type { ActivityRow } from '@/lib/types';

export async function logActivity(
  db: ServerSupabase,
  a: { customerId: string; type: string; summary: string; direction?: string; opportunityId?: string; occurredAt?: string },
): Promise<string> {
  return unwrap(await db.rpc('log_activity', {
    p_customer: a.customerId, p_type: a.type, p_summary: a.summary, p_direction: a.direction ?? null,
    p_opportunity: a.opportunityId ?? null, p_occurred_at: a.occurredAt ?? null,
  })) as string;
}

export async function listActivities(db: ServerSupabase, p: { customerId?: string; opportunityId?: string; limit?: number }): Promise<ActivityRow[]> {
  let q = db.from('activities').select('id, customer_id, opportunity_id, type, direction, summary, occurred_at, created_by');
  if (p.customerId) q = q.eq('customer_id', p.customerId);
  if (p.opportunityId) q = q.eq('opportunity_id', p.opportunityId);
  const rows = unwrap(await q.order('occurred_at', { ascending: false }).order('id', { ascending: false }).limit(p.limit ?? 50)) as
    { id: string; customer_id: string; opportunity_id: string | null; type: string; direction: string | null; summary: string; occurred_at: string; created_by: string | null }[];
  return rows.map((r) => ({
    id: r.id, customerId: r.customer_id, opportunityId: r.opportunity_id, type: r.type, direction: r.direction,
    summary: r.summary, occurredAt: r.occurred_at, createdBy: r.created_by,
  }));
}

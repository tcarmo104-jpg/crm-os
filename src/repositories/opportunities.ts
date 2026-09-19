import type { ServerSupabase } from '@/lib/supabase/server';
import { unwrap } from '@/lib/errors';
import type { OpportunityRow, OpportunityStatus, TransitionRow } from '@/lib/types';

const COLUMNS =
  'id, customer_id, pipeline_id, stage_id, title, amount, currency, expected_close_date, product_interest, status, lost_reason, closed_at, owner_id, custom_fields, created_at';
interface Raw {
  id: string; customer_id: string; pipeline_id: string; stage_id: string; title: string; amount: number | string; currency: string | null;
  expected_close_date: string | null; product_interest: string | null; status: OpportunityStatus; lost_reason: string | null;
  closed_at: string | null; owner_id: string | null; custom_fields: Record<string, unknown>; created_at: string;
}
const map = (r: Raw): OpportunityRow => ({
  id: r.id, customerId: r.customer_id, pipelineId: r.pipeline_id, stageId: r.stage_id, title: r.title,
  amount: Number(r.amount), currency: r.currency, expectedCloseDate: r.expected_close_date, productInterest: r.product_interest,
  status: r.status, lostReason: r.lost_reason, closedAt: r.closed_at, ownerId: r.owner_id, customFields: r.custom_fields ?? {}, createdAt: r.created_at,
});

export async function listOpportunities(
  db: ServerSupabase,
  p: { orgId: string; pipelineId?: string; status?: OpportunityStatus; customerId?: string; limit?: number },
): Promise<OpportunityRow[]> {
  let q = db.from('opportunities').select(COLUMNS).eq('org_id', p.orgId);
  if (p.pipelineId) q = q.eq('pipeline_id', p.pipelineId);
  if (p.status) q = q.eq('status', p.status);
  if (p.customerId) q = q.eq('customer_id', p.customerId);
  const order = p.status && p.status !== 'open' ? 'closed_at' : 'created_at';
  return (unwrap(await q.order(order, { ascending: false }).order('id', { ascending: false }).limit(Math.min(p.limit ?? 300, 500))) as unknown as Raw[]).map(map);
}

export async function getOpportunity(db: ServerSupabase, id: string): Promise<OpportunityRow | null> {
  const r = unwrap(await db.from('opportunities').select(COLUMNS).eq('id', id).maybeSingle()) as unknown as Raw | null;
  return r ? map(r) : null;
}

export async function createOpportunity(
  db: ServerSupabase,
  a: { customerId: string; title: string; amount: number; pipelineId?: string; expectedClose?: string; productInterest?: string },
): Promise<string> {
  return unwrap(await db.rpc('create_opportunity', {
    p_customer: a.customerId, p_title: a.title, p_amount: a.amount, p_pipeline: a.pipelineId ?? null,
    p_expected_close: a.expectedClose ?? null, p_product_interest: a.productInterest ?? null,
  })) as string;
}

export async function moveOpportunity(db: ServerSupabase, id: string, stageId: string, reason?: string) {
  unwrap(await db.rpc('move_opportunity', { p_id: id, p_stage: stageId, p_reason: reason ?? null }));
}

export async function updateOpportunity(db: ServerSupabase, id: string, fields: Record<string, unknown>) {
  unwrap(await db.from('opportunities').update(fields).eq('id', id).select('id').single());
}

export async function listTransitions(db: ServerSupabase, entityType: 'lead' | 'opportunity', entityId: string): Promise<TransitionRow[]> {
  const rows = unwrap(
    await db.from('state_transitions').select('id, entity_type, entity_id, from_state, to_state, actor_id, source, reason, occurred_at')
      .eq('entity_type', entityType).eq('entity_id', entityId).order('occurred_at', { ascending: false }).order('id', { ascending: false }).limit(100),
  ) as { id: string; entity_type: 'lead' | 'opportunity'; entity_id: string; from_state: string | null; to_state: string; actor_id: string | null; source: string; reason: string | null; occurred_at: string }[];
  return rows.map((r) => ({
    id: r.id, entityType: r.entity_type, entityId: r.entity_id, fromState: r.from_state, toState: r.to_state,
    actorId: r.actor_id, source: r.source, reason: r.reason, occurredAt: r.occurred_at,
  }));
}

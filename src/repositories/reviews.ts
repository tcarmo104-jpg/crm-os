import type { ServerSupabase } from '@/lib/supabase/server';
import { unwrap } from '@/lib/errors';
import type { ReviewKind, ReviewRow } from '@/lib/types';

export async function listPendingReviews(db: ServerSupabase, orgId: string): Promise<ReviewRow[]> {
  const rows = unwrap(
    await db.from('identity_reviews').select('id, kind, customer_id, candidate_id, reason, created_by, created_at')
      .eq('org_id', orgId).eq('status', 'pending').order('created_at', { ascending: false }).limit(200),
  ) as { id: string; kind: ReviewKind; customer_id: string; candidate_id: string | null; reason: string | null; created_by: string | null; created_at: string }[];
  return rows.map((r) => ({ id: r.id, kind: r.kind, customerId: r.customer_id, candidateId: r.candidate_id, reason: r.reason, createdBy: r.created_by, createdAt: r.created_at }));
}

export async function countPendingReviews(db: ServerSupabase, orgId: string): Promise<number> {
  const res = await db.from('identity_reviews').select('id', { count: 'exact', head: true }).eq('org_id', orgId).eq('status', 'pending');
  return res.error ? 0 : (res.count ?? 0);
}

export async function dismissReview(db: ServerSupabase, id: string) {
  unwrap(await db.rpc('dismiss_review', { p_id: id }));
}

export async function mergeCustomers(db: ServerSupabase, keepId: string, dropId: string) {
  unwrap(await db.rpc('merge_customers', { p_keep: keepId, p_drop: dropId }));
}

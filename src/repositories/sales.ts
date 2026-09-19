import type { ServerSupabase } from '@/lib/supabase/server';
import { unwrap } from '@/lib/errors';
import { decodeCursor, encodeCursor } from '@/lib/cursor';
import type { CaseRow, CaseStatus, LineItem, Page, SaleRow, SaleStatus } from '@/lib/types';
import { mapItem } from './quotes';

const COLUMNS = 'id, number, customer_id, opportunity_id, quote_id, status, currency, subtotal, discount_total, tax_total, total, sold_at, delivered_at, cancelled_at, cancel_reason, owner_id';
interface Raw {
  id: string; number: string; customer_id: string; opportunity_id: string; quote_id: string; status: SaleStatus; currency: string | null;
  subtotal: number | string; discount_total: number | string; tax_total: number | string; total: number | string; sold_at: string;
  delivered_at: string | null; cancelled_at: string | null; cancel_reason: string | null; owner_id: string | null;
}
const map = (r: Raw): SaleRow => ({
  id: r.id, number: r.number, customerId: r.customer_id, opportunityId: r.opportunity_id, quoteId: r.quote_id, status: r.status, currency: r.currency,
  subtotal: Number(r.subtotal), discountTotal: Number(r.discount_total), taxTotal: Number(r.tax_total), total: Number(r.total),
  soldAt: r.sold_at, deliveredAt: r.delivered_at, cancelledAt: r.cancelled_at, cancelReason: r.cancel_reason, ownerId: r.owner_id,
});

export async function listSales(db: ServerSupabase, p: { orgId: string; customerId?: string; cursor?: string; limit?: number }): Promise<Page<SaleRow>> {
  const limit = Math.min(p.limit ?? 25, 100);
  let q = db.from('sales').select(COLUMNS).eq('org_id', p.orgId);
  if (p.customerId) q = q.eq('customer_id', p.customerId);
  const cur = decodeCursor(p.cursor);
  if (cur) q = q.or(`sold_at.lt.${cur.ts},and(sold_at.eq.${cur.ts},id.lt.${cur.id})`);
  const rows = unwrap(await q.order('sold_at', { ascending: false }).order('id', { ascending: false }).limit(limit + 1)) as unknown as Raw[];
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return { items: page.map(map), nextCursor: rows.length > limit && last ? encodeCursor({ ts: last.sold_at, id: last.id }) : null };
}
export async function getSale(db: ServerSupabase, id: string): Promise<SaleRow | null> {
  const r = unwrap(await db.from('sales').select(COLUMNS).eq('id', id).maybeSingle()) as unknown as Raw | null;
  return r ? map(r) : null;
}
export async function getSaleByQuote(db: ServerSupabase, quoteId: string): Promise<SaleRow | null> {
  const rows = unwrap(await db.from('sales').select(COLUMNS).eq('quote_id', quoteId).neq('status', 'cancelled').limit(1)) as unknown as Raw[];
  return rows[0] ? map(rows[0]) : null;
}
export async function listSaleItems(db: ServerSupabase, saleId: string): Promise<LineItem[]> {
  const rows = unwrap(await db.from('sale_items').select('id, position, product_id, description, unit, quantity, unit_price, discount_pct, tax_rate, line_gross, line_discount, line_tax, line_total')
    .eq('sale_id', saleId).order('position')) as unknown as Parameters<typeof mapItem>[0][];
  return rows.map(mapItem);
}
export async function createSale(db: ServerSupabase, quoteId: string): Promise<string> { return unwrap(await db.rpc('create_sale', { p_quote: quoteId })) as string; }
export async function markDelivered(db: ServerSupabase, id: string) { unwrap(await db.rpc('mark_sale_delivered', { p_id: id })); }
export async function cancelSale(db: ServerSupabase, id: string, reason: string) { unwrap(await db.rpc('cancel_sale', { p_id: id, p_reason: reason })); }

// ---------------------------------------------------------------- casos
const CASE_COLUMNS = 'id, number, customer_id, sale_id, kind, priority, status, title, description, resolution, assignee_id, created_at';
interface RawCase {
  id: string; number: string; customer_id: string; sale_id: string | null; kind: string; priority: string; status: CaseStatus; title: string;
  description: string | null; resolution: string | null; assignee_id: string | null; created_at: string;
}
const mapCase = (r: RawCase): CaseRow => ({
  id: r.id, number: r.number, customerId: r.customer_id, saleId: r.sale_id, kind: r.kind, priority: r.priority, status: r.status,
  title: r.title, description: r.description, resolution: r.resolution, assigneeId: r.assignee_id, createdAt: r.created_at,
});
export async function listCases(db: ServerSupabase, p: { orgId: string; customerId?: string; openOnly?: boolean; limit?: number }): Promise<CaseRow[]> {
  let q = db.from('cases').select(CASE_COLUMNS).eq('org_id', p.orgId);
  if (p.customerId) q = q.eq('customer_id', p.customerId);
  if (p.openOnly) q = q.in('status', ['open', 'in_progress']);
  return (unwrap(await q.order('created_at', { ascending: false }).order('id', { ascending: false }).limit(Math.min(p.limit ?? 100, 300))) as unknown as RawCase[]).map(mapCase);
}
export async function openCase(
  db: ServerSupabase, orgId: string,
  a: { customerId: string; title: string; kind: string; description?: string; priority: string; saleId?: string; assigneeId?: string },
): Promise<string> {
  return unwrap(await db.rpc('open_case', {
    p_org: orgId, p_customer: a.customerId, p_title: a.title, p_kind: a.kind, p_description: a.description ?? null,
    p_priority: a.priority, p_sale: a.saleId ?? null, p_assignee: a.assigneeId ?? null,
  })) as string;
}
export async function setCaseStatus(db: ServerSupabase, id: string, to: string, note?: string) {
  unwrap(await db.rpc('set_case_status', { p_id: id, p_to: to, p_note: note ?? null }));
}

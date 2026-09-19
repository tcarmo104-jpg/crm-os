import type { ServerSupabase } from '@/lib/supabase/server';
import { unwrap } from '@/lib/errors';
import { decodeCursor, encodeCursor } from '@/lib/cursor';
import type { LineItem, Page, QuoteRow, QuoteStatus } from '@/lib/types';

const COLUMNS = 'id, number, version, opportunity_id, customer_id, status, currency, valid_until, notes, subtotal, discount_total, tax_total, total, max_discount_pct, owner_id, sent_at, created_at';
interface Raw {
  id: string; number: string; version: number; opportunity_id: string; customer_id: string; status: QuoteStatus; currency: string | null;
  valid_until: string | null; notes: string | null; subtotal: number | string; discount_total: number | string; tax_total: number | string;
  total: number | string; max_discount_pct: number | string; owner_id: string | null; sent_at: string | null; created_at: string;
}
const map = (r: Raw): QuoteRow => ({
  id: r.id, number: r.number, version: r.version, opportunityId: r.opportunity_id, customerId: r.customer_id, status: r.status,
  currency: r.currency, validUntil: r.valid_until, notes: r.notes, subtotal: Number(r.subtotal), discountTotal: Number(r.discount_total),
  taxTotal: Number(r.tax_total), total: Number(r.total), maxDiscountPct: Number(r.max_discount_pct), ownerId: r.owner_id,
  sentAt: r.sent_at, createdAt: r.created_at,
});

export async function listQuotes(
  db: ServerSupabase, p: { orgId: string; opportunityId?: string; customerId?: string; status?: QuoteStatus; cursor?: string; limit?: number },
): Promise<Page<QuoteRow>> {
  const limit = Math.min(p.limit ?? 25, 100);
  let q = db.from('quotes').select(COLUMNS).eq('org_id', p.orgId);
  if (p.opportunityId) q = q.eq('opportunity_id', p.opportunityId);
  if (p.customerId) q = q.eq('customer_id', p.customerId);
  if (p.status) q = q.eq('status', p.status);
  const cur = decodeCursor(p.cursor);
  if (cur) q = q.or(`created_at.lt.${cur.ts},and(created_at.eq.${cur.ts},id.lt.${cur.id})`);
  const rows = unwrap(await q.order('created_at', { ascending: false }).order('id', { ascending: false }).limit(limit + 1)) as unknown as Raw[];
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return { items: page.map(map), nextCursor: rows.length > limit && last ? encodeCursor({ ts: last.created_at, id: last.id }) : null };
}

export async function getQuote(db: ServerSupabase, id: string): Promise<QuoteRow | null> {
  const r = unwrap(await db.from('quotes').select(COLUMNS).eq('id', id).maybeSingle()) as unknown as Raw | null;
  return r ? map(r) : null;
}

/** Todas las versiones de una misma cotización (mismo número), de la más nueva a la más antigua. */
export async function listVersions(db: ServerSupabase, orgId: string, number: string): Promise<QuoteRow[]> {
  return (unwrap(await db.from('quotes').select(COLUMNS).eq('org_id', orgId).eq('number', number).order('version', { ascending: false })) as unknown as Raw[]).map(map);
}

interface RawItem {
  id: string; position: number; product_id: string | null; description: string; unit: string; quantity: number | string; unit_price: number | string;
  discount_pct: number | string; tax_rate: number | string; line_gross: number | string; line_discount: number | string; line_tax: number | string; line_total: number | string;
}
export const mapItem = (r: RawItem): LineItem => ({
  id: r.id, position: r.position, productId: r.product_id, description: r.description, unit: r.unit, quantity: Number(r.quantity),
  unitPrice: Number(r.unit_price), discountPct: Number(r.discount_pct), taxRate: Number(r.tax_rate), lineGross: Number(r.line_gross),
  lineDiscount: Number(r.line_discount), lineTax: Number(r.line_tax), lineTotal: Number(r.line_total),
});
const ITEM_COLUMNS = 'id, position, product_id, description, unit, quantity, unit_price, discount_pct, tax_rate, line_gross, line_discount, line_tax, line_total';

export async function listItems(db: ServerSupabase, quoteId: string): Promise<LineItem[]> {
  return (unwrap(await db.from('quote_items').select(ITEM_COLUMNS).eq('quote_id', quoteId).order('position')) as unknown as RawItem[]).map(mapItem);
}

export async function createQuote(db: ServerSupabase, opportunityId: string, validUntil?: string, notes?: string): Promise<string> {
  return unwrap(await db.rpc('create_quote', { p_opportunity: opportunityId, p_valid_until: validUntil ?? null, p_notes: notes ?? null })) as string;
}
export async function addItem(
  db: ServerSupabase, quoteId: string,
  a: { productId?: string; description?: string; quantity: number; unitPrice?: number; discountPct: number; taxRate?: number },
): Promise<string> {
  return unwrap(await db.rpc('add_quote_item', {
    p_quote: quoteId, p_product: a.productId ?? null, p_description: a.description ?? null, p_quantity: a.quantity,
    p_unit_price: a.unitPrice ?? null, p_discount_pct: a.discountPct, p_tax_rate: a.taxRate ?? null,
  })) as string;
}
export async function updateItem(db: ServerSupabase, itemId: string, a: { quantity: number; unitPrice: number; discountPct: number; description?: string }) {
  unwrap(await db.rpc('update_quote_item', { p_item: itemId, p_quantity: a.quantity, p_unit_price: a.unitPrice, p_discount_pct: a.discountPct, p_description: a.description ?? null }));
}
export async function removeItem(db: ServerSupabase, itemId: string) { unwrap(await db.rpc('remove_quote_item', { p_item: itemId })); }
export async function sendQuote(db: ServerSupabase, id: string) { unwrap(await db.rpc('send_quote', { p_id: id })); }
export async function acceptQuote(db: ServerSupabase, id: string) { unwrap(await db.rpc('accept_quote', { p_id: id })); }
export async function rejectQuote(db: ServerSupabase, id: string, reason?: string) { unwrap(await db.rpc('reject_quote', { p_id: id, p_reason: reason ?? null })); }
export async function reviseQuote(db: ServerSupabase, id: string): Promise<string> { return unwrap(await db.rpc('revise_quote', { p_id: id })) as string; }
export async function updateQuoteHeader(db: ServerSupabase, id: string, fields: { valid_until?: string | null; notes?: string | null }) {
  unwrap(await db.from('quotes').update(fields).eq('id', id).select('id').single());
}

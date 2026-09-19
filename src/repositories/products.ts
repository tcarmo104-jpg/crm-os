import type { ServerSupabase } from '@/lib/supabase/server';
import { unwrap } from '@/lib/errors';
import type { ProductRow } from '@/lib/types';

const COLUMNS = 'id, kind, sku, name, description, unit, unit_price, tax_rate, active';
interface Raw { id: string; kind: 'product' | 'service'; sku: string | null; name: string; description: string | null; unit: string; unit_price: number | string; tax_rate: number | string; active: boolean }
const map = (r: Raw): ProductRow => ({
  id: r.id, kind: r.kind, sku: r.sku, name: r.name, description: r.description, unit: r.unit,
  unitPrice: Number(r.unit_price), taxRate: Number(r.tax_rate), active: r.active,
});

export async function listProducts(db: ServerSupabase, p: { orgId: string; kind?: 'product' | 'service'; activeOnly?: boolean; q?: string }): Promise<ProductRow[]> {
  let q = db.from('products').select(COLUMNS).eq('org_id', p.orgId);
  if (p.kind) q = q.eq('kind', p.kind);
  if (p.activeOnly) q = q.eq('active', true);
  const term = (p.q ?? '').trim().replace(/[^\p{L}\p{N} .-]/gu, '').slice(0, 60);
  if (term) q = q.or(`name.ilike.*${term}*,sku.ilike.*${term}*`);
  return (unwrap(await q.order('active', { ascending: false }).order('name').limit(300)) as unknown as Raw[]).map(map);
}

export async function createProduct(
  db: ServerSupabase, orgId: string, p: { kind: string; sku?: string; name: string; description?: string; unit: string; unitPrice: number; taxRate: number },
) {
  unwrap(await db.from('products').insert({
    org_id: orgId, kind: p.kind, sku: p.sku ?? null, name: p.name, description: p.description ?? null,
    unit: p.unit, unit_price: p.unitPrice, tax_rate: p.taxRate,
  }).select('id').single());
}

export async function updateProduct(db: ServerSupabase, id: string, fields: Record<string, unknown>) {
  unwrap(await db.from('products').update(fields).eq('id', id).select('id').single());
}

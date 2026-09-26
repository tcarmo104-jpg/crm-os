import type { ServerSupabase } from '@/lib/supabase/server';
import { unwrap } from '@/lib/errors';
import { decodeCursor, encodeCursor } from '@/lib/cursor';
import type { LeadResolution, LeadRow, Page } from '@/lib/types';

const COLUMNS = 'id, customer_id, owner_id, status, source, channel, campaign, product_interest, resolution, received_at';
interface Raw {
  id: string; customer_id: string; owner_id: string | null; status: string; source: string; channel: string | null;
  campaign: string | null; product_interest: string | null; resolution: LeadResolution; received_at: string;
}
const map = (r: Raw): LeadRow => ({
  id: r.id, customerId: r.customer_id, ownerId: r.owner_id, status: r.status, source: r.source, channel: r.channel,
  campaign: r.campaign, productInterest: r.product_interest, resolution: r.resolution, receivedAt: r.received_at,
});

export interface LeadFilters {
  orgId: string; cursor?: string; limit?: number; customerId?: string; status?: string; source?: string;
  resolution?: string; ownerId?: string; unassigned?: boolean; from?: string; to?: string; q?: string;
}
export async function listLeads(db: ServerSupabase, p: LeadFilters): Promise<Page<LeadRow>> {
  const limit = Math.min(p.limit ?? 25, 100);
  let query = db.from('leads').select(COLUMNS).eq('org_id', p.orgId);
  if (p.customerId) query = query.eq('customer_id', p.customerId);
  if (p.status) query = query.eq('status', p.status);
  if (p.source) query = query.eq('source', p.source);
  if (p.resolution) query = query.eq('resolution', p.resolution);
  if (p.ownerId) query = query.eq('owner_id', p.ownerId);
  if (p.unassigned) query = query.is('owner_id', null);
  if (p.from) query = query.gte('received_at', p.from);
  if (p.to) query = query.lte('received_at', p.to);
  if (p.q && p.q.trim()) {
    const t = p.q.trim().replace(/[%_,]/g, '');
    query = query.or(`contact_name.ilike.%${t}%,contact_email.ilike.%${t}%,contact_phone.ilike.%${t}%,campaign.ilike.%${t}%,product_interest.ilike.%${t}%`);
  }
  const cur = decodeCursor(p.cursor);
  if (cur) query = query.or(`received_at.lt.${cur.ts},and(received_at.eq.${cur.ts},id.lt.${cur.id})`);
  const rows = unwrap(
    await query.order('received_at', { ascending: false }).order('id', { ascending: false }).limit(limit + 1),
  ) as unknown as Raw[];
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map(map),
    nextCursor: rows.length > limit && last ? encodeCursor({ ts: last.received_at, id: last.id }) : null,
  };
}

/** Fuentes distintas ya usadas en la organización (para el filtro «Fuente»), sin traer todos los leads. */
export async function listLeadSources(db: ServerSupabase, orgId: string): Promise<string[]> {
  const rows = unwrap(await db.from('leads').select('source').eq('org_id', orgId).limit(2000)) as unknown as { source: string }[];
  return [...new Set(rows.map((r) => r.source))].sort();
}

export interface CreateLeadResult { leadId: string; customerId: string; outcome: string; deduplicated: boolean }
/** Crea un lead a mano, reutilizando la MISMA resolución de identidad que la importación CSV y la API pública. */
export async function createLead(db: ServerSupabase, orgId: string, row: Record<string, unknown>): Promise<CreateLeadResult> {
  const r = unwrap(await db.rpc('create_lead', { p_org: orgId, p_row: row })) as unknown as { lead_id: string; customer_id: string; outcome: string; deduplicated: boolean };
  return { leadId: r.lead_id, customerId: r.customer_id, outcome: r.outcome, deduplicated: r.deduplicated };
}

export interface ImportRowResult { row: number; outcome?: string; deduplicated?: boolean; error_code?: string; error?: string | null }

export async function importLeads(
  db: ServerSupabase, orgId: string, rows: Record<string, unknown>[], assignToMe: boolean,
): Promise<ImportRowResult[]> {
  return unwrap(await db.rpc('import_leads', { p_org: orgId, p_rows: rows, p_assign_to_me: assignToMe })) as ImportRowResult[];
}

export async function setLeadStatus(db: ServerSupabase, id: string, to: string, reason?: string) {
  unwrap(await db.rpc('set_lead_status', { p_lead: id, p_to: to, p_reason: reason ?? null }));
}

/** Convierte el lead en oportunidad (atómico). Devuelve el id de la oportunidad. */
export async function convertLead(db: ServerSupabase, id: string, opts: { pipelineId?: string; title?: string; amount?: number } = {}): Promise<string> {
  return unwrap(await db.rpc('convert_lead', {
    p_lead: id, p_pipeline: opts.pipelineId ?? null, p_title: opts.title ?? null, p_amount: opts.amount ?? 0,
  })) as string;
}

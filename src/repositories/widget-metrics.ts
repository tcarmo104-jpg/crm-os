import type { ServerSupabase } from '@/lib/supabase/server';
import { unwrap } from '@/lib/errors';
import type { WidgetLeadFact } from '@/lib/analytics';

/** Tope de filas que trae `widget_lead_facts` por llamada (igual al default de la función en 0036). Si el
 * período tiene más leads del widget que esto, se truncan (los más recientes) y la página lo avisa. */
export const WIDGET_FACTS_LIMIT = 5000;

interface WidgetLeadFactRow {
  lead_id: string; received_at: string; customer_id: string; is_new: boolean;
  widget_id: string | null; widget_name: string | null; page_url: string | null; product_url: string | null;
  utm_source: string | null; utm_medium: string | null; utm_campaign: string | null; region: string | null;
  owner_id: string | null; team_id: string | null;
  first_inbound_at: string | null; first_response_at: string | null; closed_at: string | null;
  opportunity_id: string | null; opportunity_created_at: string | null; opportunity_status: string | null;
  sale_id: string | null; sale_total: number | null; sold_at: string | null;
}

const map = (r: WidgetLeadFactRow): WidgetLeadFact => ({
  leadId: r.lead_id, receivedAt: r.received_at, customerId: r.customer_id, isNew: r.is_new,
  widgetId: r.widget_id, widgetName: r.widget_name, pageUrl: r.page_url, productUrl: r.product_url,
  utmSource: r.utm_source, utmMedium: r.utm_medium, utmCampaign: r.utm_campaign, region: r.region,
  ownerId: r.owner_id, teamId: r.team_id,
  firstInboundAt: r.first_inbound_at, firstResponseAt: r.first_response_at, closedAt: r.closed_at,
  opportunityId: r.opportunity_id, saleId: r.sale_id, saleTotal: r.sale_total,
});

/** Leads del widget en `[from, to]` (bordes incluidos) con todo lo que les pasó después: si escribieron por
 * WhatsApp, cuándo les respondieron, si se cerró la conversación, y si llegaron a oportunidad/venta.
 * `truncated` es true si había más de `WIDGET_FACTS_LIMIT` y se recortó a los más recientes. */
export async function listWidgetLeadFacts(
  db: ServerSupabase,
  orgId: string,
  from: string,
  to: string,
  limit: number = WIDGET_FACTS_LIMIT,
): Promise<{ facts: WidgetLeadFact[]; truncated: boolean }> {
  const rows = unwrap(
    await db.rpc('widget_lead_facts', { p_org: orgId, p_from: from, p_to: to, p_limit: limit }),
  ) as unknown as WidgetLeadFactRow[];
  return { facts: rows.map(map), truncated: rows.length >= limit };
}

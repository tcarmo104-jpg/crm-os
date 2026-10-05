import type { ServerSupabase } from '@/lib/supabase/server';
import { unwrap } from '@/lib/errors';
import type { WidgetLeadFact } from '@/lib/analytics';

/** Tope de filas por consulta (como el resto de Analítica). La página avisa si se alcanza. */
export const WIDGET_FACTS_LIMIT = 5000;

const map = (r: Record<string, unknown>): WidgetLeadFact => ({
  leadId: r.lead_id as string, receivedAt: r.received_at as string, customerId: r.customer_id as string, isNew: r.is_new as boolean,
  widgetId: (r.widget_id as string | null) ?? null, widgetName: (r.widget_name as string | null) ?? null,
  pageUrl: (r.page_url as string | null) ?? null, productUrl: (r.product_url as string | null) ?? null,
  utmSource: (r.utm_source as string | null) ?? null, utmMedium: (r.utm_medium as string | null) ?? null, utmCampaign: (r.utm_campaign as string | null) ?? null,
  region: (r.region as string | null) ?? null, ownerId: (r.owner_id as string | null) ?? null, teamId: (r.team_id as string | null) ?? null,
  firstInboundAt: (r.first_inbound_at as string | null) ?? null, firstResponseAt: (r.first_response_at as string | null) ?? null, closedAt: (r.closed_at as string | null) ?? null,
  opportunityId: (r.opportunity_id as string | null) ?? null, saleId: (r.sale_id as string | null) ?? null,
  saleTotal: r.sale_total === null || r.sale_total === undefined ? null : Number(r.sale_total),
});

/** Una fila por lead del widget en el rango, con lo que le pasó después. La base de datos aplica los permisos
 * (`reports:read` + lo que cada rol ya veía de los leads): aquí no se filtra nada a mano. */
export async function listWidgetLeadFacts(db: ServerSupabase, a: { orgId: string; from: string; to: string; limit?: number }): Promise<{ items: WidgetLeadFact[]; truncated: boolean }> {
  const limit = a.limit ?? WIDGET_FACTS_LIMIT;
  const rows = unwrap(await db.rpc('widget_lead_facts', { p_org: a.orgId, p_from: a.from, p_to: a.to, p_limit: limit })) as unknown as Record<string, unknown>[];
  return { items: rows.map(map), truncated: rows.length >= limit };
}

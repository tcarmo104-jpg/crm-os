import type { ServerSupabase } from '@/lib/supabase/server';
import { unwrap } from '@/lib/errors';

export interface WidgetOrigin {
  widgetName: string | null; pageUrl: string | null; productUrl: string | null; domain: string | null;
  utmSource: string | null; utmMedium: string | null; utmCampaign: string | null; utmContent: string | null; receivedAt: string;
  // Entrega 2 del refactor del widget (0038): qué intención eligió en el menú y las respuestas de sus campos propios.
  optionLabel: string | null; fieldValues: Record<string, string> | null;
}

/** De dónde vino este cliente si llegó por un widget de WhatsApp (el más reciente, si escribió varias veces).
 * `raw_payload` no está en las columnas normales de `leads` (son muchos datos de origen distintos según la
 * fuente): se consulta aparte, solo cuando hace falta mostrarlo. */
export async function getWidgetOrigin(db: ServerSupabase, customerId: string): Promise<WidgetOrigin | null> {
  const rows = unwrap(
    await db.from('leads').select('received_at, raw_payload').eq('customer_id', customerId).eq('source', 'widget_web').order('received_at', { ascending: false }).limit(1),
  ) as unknown as { received_at: string; raw_payload: Record<string, unknown> | null }[];
  const r = rows[0];
  if (!r) return null;
  const p = r.raw_payload ?? {};
  const fv = p.field_values;
  return {
    widgetName: (p.widget_name as string | undefined) ?? null, pageUrl: (p.page_url as string | undefined) ?? null,
    productUrl: (p.product_url as string | undefined) ?? null, domain: (p.domain as string | undefined) ?? null,
    utmSource: (p.utm_source as string | undefined) ?? null, utmMedium: (p.utm_medium as string | undefined) ?? null,
    utmCampaign: (p.utm_campaign as string | undefined) ?? null, utmContent: (p.utm_content as string | undefined) ?? null,
    receivedAt: r.received_at,
    optionLabel: (p.option_label as string | undefined) ?? null,
    fieldValues: fv && typeof fv === 'object' ? (fv as Record<string, string>) : null,
  };
}

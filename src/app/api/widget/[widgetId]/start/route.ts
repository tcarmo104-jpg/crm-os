import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/server/supabase-admin';
import { buildPrefilledMessage, buildWhatsAppLink } from '@/lib/widgets';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Cache-Control': 'no-store' };
const MAX_BODY_BYTES = 8 * 1024;

const bodySchema = z.object({
  name: z.string().trim().min(1).max(160), phone: z.string().trim().min(5).max(30), company: z.string().trim().max(160).optional(),
  message: z.string().trim().max(500).optional(), pageUrl: z.string().trim().max(500).optional(), referrer: z.string().trim().max(500).optional(),
  productUrl: z.string().trim().max(500).optional(), utmSource: z.string().trim().max(120).optional(), utmMedium: z.string().trim().max(120).optional(),
  utmCampaign: z.string().trim().max(120).optional(), utmContent: z.string().trim().max(120).optional(),
});

const REASON_MESSAGE: Record<string, string> = {
  not_found: 'Este formulario no está disponible en este momento.',
  domain_not_allowed: 'Este formulario no está habilitado para este sitio web.',
  rate_limited: 'Demasiados mensajes seguidos. Espera un momento e inténtalo de nuevo.',
  invalid_name: 'Escribe tu nombre.',
  invalid_phone: 'Escribe un número de WhatsApp válido.',
  channel_unavailable: 'No pudimos conectar con WhatsApp en este momento. Inténtalo más tarde.',
  internal_error: 'Algo salió mal. Inténtalo de nuevo en un momento.',
};

/** POST /api/widget/:widgetId/start — crea (o encuentra) el contacto y devuelve el enlace de WhatsApp al
 * que el navegador del visitante debe redirigirse. Nunca envía nada por WhatsApp desde aquí: quien manda el
 * primer mensaje de verdad es el propio visitante, desde su WhatsApp, al dar «Enviar» allá. */
export async function POST(req: Request, { params }: { params: Promise<{ widgetId: string }> }) {
  const { widgetId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(widgetId)) return NextResponse.json({ ok: false, message: 'Formulario no válido.' }, { status: 400, headers: CORS });

  const declared = Number(req.headers.get('content-length') ?? 0);
  if (declared > MAX_BODY_BYTES) return NextResponse.json({ ok: false, message: 'Solicitud demasiado grande.' }, { status: 413, headers: CORS });

  const origin = req.headers.get('origin') ?? req.headers.get('referer') ?? '';
  let host = '';
  try { host = origin ? new URL(origin).hostname : ''; } catch { host = ''; }

  let json: unknown;
  try { json = JSON.parse(await req.text()); } catch { return NextResponse.json({ ok: false, message: 'Solicitud no válida.' }, { status: 400, headers: CORS }); }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) return NextResponse.json({ ok: false, message: 'Revisa el nombre y el número de WhatsApp.' }, { status: 400, headers: CORS });
  const b = parsed.data;

  const admin = createAdminClient();
  const r = await admin.rpc('start_widget_conversation', {
    p_widget_id: widgetId, p_origin_host: host, p_name: b.name, p_phone: b.phone, p_company: b.company ?? null, p_message: b.message ?? null,
    p_page_url: b.pageUrl ?? null, p_referrer: b.referrer ?? null, p_product_url: b.productUrl ?? null,
    p_utm_source: b.utmSource ?? null, p_utm_medium: b.utmMedium ?? null, p_utm_campaign: b.utmCampaign ?? null, p_utm_content: b.utmContent ?? null,
  });
  if (r.error) return NextResponse.json({ ok: false, message: 'Algo salió mal. Inténtalo de nuevo en un momento.' }, { status: 500, headers: CORS });
  const d = r.data as { ok: boolean; reason?: string; phone?: string };
  if (!d.ok) return NextResponse.json({ ok: false, message: REASON_MESSAGE[d.reason ?? ''] ?? REASON_MESSAGE.internal_error }, { status: 200, headers: CORS });

  const link = buildWhatsAppLink(d.phone!, buildPrefilledMessage(b.name, b.message ?? ''));
  return NextResponse.json({ ok: true, redirectUrl: link }, { headers: CORS });
}

export function OPTIONS() { return new NextResponse(null, { status: 204, headers: CORS }); }

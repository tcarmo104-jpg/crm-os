import { NextResponse } from 'next/server';
import { createAdminClient } from '@/server/supabase-admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Cache-Control': 'no-store' };

/** GET /api/widget/:widgetId/config — lo que el botón necesita para dibujarse (sin nada sensible). Público
 * a propósito, igual que el propio widgetId: cualquiera puede ver cómo se ve un botón en una página web. */
export async function GET(_req: Request, { params }: { params: Promise<{ widgetId: string }> }) {
  const { widgetId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(widgetId)) return NextResponse.json({ active: false }, { headers: CORS });
  const admin = createAdminClient();
  const r = await admin.rpc('get_widget_config', { p_widget_id: widgetId });
  if (r.error) return NextResponse.json({ active: false }, { headers: CORS });
  return NextResponse.json(r.data, { headers: CORS });
}

export function OPTIONS() { return new NextResponse(null, { status: 204, headers: CORS }); }

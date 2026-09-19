import { NextResponse } from 'next/server';
import { createAdminClient } from '@/server/supabase-admin';
import { extractApiKey, hashApiKey } from '@/server/api-keys';
import { buildIngestPayload, leadInputSchema } from '@/services/ingest';
import { countryFromLocale } from '@/lib/identity';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 32 * 1024;

function fail(status: number, code: string, message: string, extra?: Record<string, unknown>, headers?: Record<string, string>) {
  return NextResponse.json({ error: { code, message, ...extra } }, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
}

/**
 * POST /api/v1/leads — captura de leads desde tu web, formularios, Zapier, Make, etc.
 * Autenticación: `Authorization: Bearer crm_…` (o cabecera `X-API-Key`).
 * Idempotente si envías `external_id`: reintentar no duplica el lead.
 * La respuesta NO revela si la persona ya era cliente.
 */
export async function POST(req: Request) {
  const key = extractApiKey(req.headers);
  if (!key) return fail(401, 'unauthorized', 'Falta una llave de API válida (Authorization: Bearer crm_…).');

  const declared = Number(req.headers.get('content-length') ?? 0);
  if (declared > MAX_BODY_BYTES) return fail(413, 'payload_too_large', 'El cuerpo supera los 32 KB.');

  const admin = createAdminClient();

  // 1) Autenticar y aplicar el límite ANTES de leer el cuerpo.
  const auth = await admin.rpc('api_authenticate', { p_key_hash: hashApiKey(key) });
  if (auth.error) {
    console.error('api_authenticate failed', auth.error.code);
    return fail(500, 'internal_error', 'No pudimos procesar la solicitud. Inténtalo de nuevo.');
  }
  const a = auth.data as { ok: boolean; reason?: string; org_id?: string; retry_after?: number };
  if (!a.ok) {
    if (a.reason === 'rate_limited') {
      const retry = String(a.retry_after ?? 60);
      return fail(429, 'rate_limited', 'Demasiadas solicitudes. Reintenta más tarde.', { retry_after: Number(retry) }, { 'Retry-After': retry });
    }
    return fail(401, 'unauthorized', 'La llave de API no es válida o fue revocada.');
  }
  const orgId = a.org_id!;

  // 2) Cuerpo
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) return fail(413, 'payload_too_large', 'El cuerpo supera los 32 KB.');
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return fail(400, 'invalid_json', 'El cuerpo debe ser JSON válido.');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return fail(400, 'invalid_request', 'El cuerpo debe ser un objeto JSON.');
  }

  const parsed = leadInputSchema.safeParse(body);
  if (!parsed.success) {
    return fail(400, 'invalid_request', 'Hay campos con formato inválido.', {
      issues: parsed.error.issues.slice(0, 10).map((i) => ({ field: i.path.join('.'), message: i.message })),
    });
  }

  // 3) Normalizar contacto según el país de la organización
  const org = await admin.from('organizations').select('locale').eq('id', orgId).single();
  const built = buildIngestPayload(parsed.data, countryFromLocale((org.data as { locale?: string } | null)?.locale), body);
  if (!built.ok) return fail(422, 'contact_required', built.message);

  // 4) Resolver identidad + crear el lead
  const res = await admin.rpc('ingest_lead', { p_org: orgId, p_payload: built.payload });
  if (res.error) {
    if (res.error.code === '22023' || res.error.code === '23514') {
      const m = res.error.message.toLowerCase();
      return fail(422, m.includes('custom_field') ? 'invalid_custom_field' : 'invalid_data',
        m.includes('custom_field') ? 'Un campo personalizado tiene un valor no válido o no existe.' : 'Algún dato no cumple el formato esperado.');
    }
    console.error('ingest_lead failed', res.error.code);
    return fail(500, 'internal_error', 'No pudimos procesar la solicitud. Inténtalo de nuevo.');
  }
  const r = res.data as { lead_id: string; deduplicated: boolean };
  return NextResponse.json(
    { id: r.lead_id, deduplicated: r.deduplicated, warnings: built.warnings },
    { status: r.deduplicated ? 200 : 201, headers: { 'Cache-Control': 'no-store' } },
  );
}

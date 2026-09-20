import { NextResponse, after } from 'next/server';
import { verifyChallenge, verifySignature } from '@/lib/meta';
import { createAdminClient } from '@/server/supabase-admin';
import { handleWebhook } from '@/server/inbound';
import { createSupabaseMediaStore, sweepAttachments } from '@/server/media';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const MAX_BODY_BYTES = 1024 * 1024;

/** GET: Meta verifica la URL al configurarla (handshake con hub.challenge). */
export async function GET(req: Request) {
  const challenge = verifyChallenge(new URL(req.url).searchParams, process.env.META_VERIFY_TOKEN);
  if (challenge === null) {
    // Diagnóstico para los registros de Vercel (nunca se imprime ningún valor secreto).
    console.warn(JSON.stringify({ msg: 'meta_verify_rejected', token_configured: Boolean(process.env.META_VERIFY_TOKEN?.trim()) }));
    return new NextResponse('forbidden', { status: 403 });
  }
  return new NextResponse(challenge, { status: 200, headers: { 'Content-Type': 'text/plain' } });
}

/**
 * POST: eventos de WhatsApp. Solo se acepta lo que Meta FIRMÓ con el App Secret (sobre el cuerpo crudo).
 * Se guarda de forma durable antes de procesar y se responde 200 rápido: si algo falla al procesar, el barrido
 * lo reintenta; si ni siquiera se pudo guardar, se responde 500 para que Meta reintente.
 */
export async function POST(req: Request) {
  const secret = process.env.META_APP_SECRET?.trim();
  if (!secret) {
    console.error(JSON.stringify({ msg: 'meta_webhook_not_configured' }));
    return NextResponse.json({ error: 'not_configured' }, { status: 503 });
  }
  const declared = Number(req.headers.get('content-length') ?? 0);
  if (declared > MAX_BODY_BYTES) return NextResponse.json({ error: 'payload_too_large' }, { status: 413 });

  const raw = await req.text();
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) return NextResponse.json({ error: 'payload_too_large' }, { status: 413 });
  if (!verifySignature(raw, req.headers.get('x-hub-signature-256'), secret)) {
    return NextResponse.json({ error: 'invalid_signature' }, { status: 401 });
  }

  let payload: unknown;
  try { payload = JSON.parse(raw); } catch { return NextResponse.json({ error: 'invalid_json' }, { status: 400 }); }

  // Meta siempre envía un objeto. Cualquier otra cosa (aun firmada) se acusa recibo y se ignora: un error 500
  // haría que Meta reintente indefinidamente algo que nunca podremos procesar.
  if (typeof payload !== 'object' || payload === null) return NextResponse.json({ ok: true, ignored: true });

  try {
    const admin = createAdminClient();
    const sum = await handleWebhook(admin, payload);
    // Descargar los archivos recibidos DESPUÉS de responder a Meta (rápido); lo que no alcance lo toma el barrido periódico.
    // Una tarea de segundo plano NUNCA debe poder hacer fallar el webhook (Meta reintentaría sin fin): si `after` no está disponible se ignora.
    try {
      after(async () => { try { await sweepAttachments(admin, { store: createSupabaseMediaStore(admin) }, 3); } catch (e) { console.error(JSON.stringify({ msg: 'attachments_after_failed', error: e instanceof Error ? e.message : String(e) })); } });
    } catch { /* fuera de una petición de Next (pruebas): el barrido periódico lo cubre */ }
    return NextResponse.json({ ok: true, messages: sum.messages, statuses: sum.statuses });
  } catch (e) {
    console.error(JSON.stringify({ msg: 'meta_webhook_failed', error: e instanceof Error ? e.message : String(e) }));
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}

import { NextResponse, after } from 'next/server';
import { verifyChallenge, verifySignature } from '@/lib/meta';
import { createAdminClient } from '@/server/supabase-admin';
import { handleWebhook, restrictPayloadToOrg } from '@/server/inbound';
import { metaAppsForWebhook, type MetaAppCreds } from '@/server/provider-apps';
import { createSupabaseMediaStore, sweepAttachments } from '@/server/media';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const MAX_BODY_BYTES = 1024 * 1024;

/** Anota (solo un contador, sin contenido) qué pasó con una llamada de Meta, para el diagnóstico del CRM. Nunca puede hacer fallar la respuesta. */
async function note(outcome: 'verify_ok' | 'verify_rejected' | 'accepted' | 'bad_signature' | 'no_secret' | 'bad_payload') {
  try { await createAdminClient().rpc('bump_webhook_stat', { p_outcome: outcome }); } catch { /* el diagnóstico es un extra: el webhook no depende de él */ }
}

/** GET: Meta verifica la URL al configurarla (handshake con hub.challenge). */
/** Aplicaciones de Meta que pueden hablar con este CRM: las de las organizaciones (guardadas en el CRM) y la de la plataforma (variables). */
async function candidates(): Promise<MetaAppCreds[]> {
  try { return await metaAppsForWebhook(createAdminClient()); }
  catch { return process.env.META_APP_SECRET?.trim() ? [{ appId: '', secret: process.env.META_APP_SECRET.trim(), verifyToken: process.env.META_VERIFY_TOKEN?.trim() || null, source: 'env', orgId: null }] : []; }
}

export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  let challenge: string | null = null;
  const apps = await candidates();
  for (const a of apps) { if (a.verifyToken) { challenge = verifyChallenge(params, a.verifyToken); if (challenge !== null) break; } }
  if (challenge === null) {
    // Diagnóstico para los registros de Vercel (nunca se imprime ningún valor secreto).
    console.warn(JSON.stringify({ msg: 'meta_verify_rejected', apps_configured: apps.length }));
    // Solo cuentan las llamadas que INTENTAN verificar (traen «hub.mode»): abrir la dirección en el navegador no es un intento de Meta.
    if (params.has('hub.mode')) await note('verify_rejected');
    return new NextResponse('forbidden', { status: 403 });
  }
  await note('verify_ok');
  return new NextResponse(challenge, { status: 200, headers: { 'Content-Type': 'text/plain' } });
}

/**
 * POST: eventos de WhatsApp. Solo se acepta lo que Meta FIRMÓ con el App Secret (sobre el cuerpo crudo).
 * Se guarda de forma durable antes de procesar y se responde 200 rápido: si algo falla al procesar, el barrido
 * lo reintenta; si ni siquiera se pudo guardar, se responde 500 para que Meta reintente.
 */
export async function POST(req: Request) {
  const apps = await candidates();
  if (apps.length === 0) {
    console.error(JSON.stringify({ msg: 'meta_webhook_not_configured' }));
    await note('no_secret');
    return NextResponse.json({ error: 'not_configured' }, { status: 503 });
  }
  const declared = Number(req.headers.get('content-length') ?? 0);
  if (declared > MAX_BODY_BYTES) return NextResponse.json({ error: 'payload_too_large' }, { status: 413 });

  const raw = await req.text();
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) return NextResponse.json({ error: 'payload_too_large' }, { status: 413 });
  // Solo se acepta lo que Meta FIRMÓ con la clave de alguna de las aplicaciones conocidas; la que coincide dice de quién es el aviso.
  const signature = req.headers.get('x-hub-signature-256');
  const matched = apps.find((a) => verifySignature(raw, signature, a.secret));
  if (!matched) {
    await note('bad_signature');
    return NextResponse.json({ error: 'invalid_signature' }, { status: 401 });
  }

  let payload: unknown;
  try { payload = JSON.parse(raw); } catch { await note('bad_payload'); return NextResponse.json({ error: 'invalid_json' }, { status: 400 }); }

  // Meta siempre envía un objeto. Cualquier otra cosa (aun firmada) se acusa recibo y se ignora: un error 500
  // haría que Meta reintente indefinidamente algo que nunca podremos procesar.
  if (typeof payload !== 'object' || payload === null) return NextResponse.json({ ok: true, ignored: true });

  try {
    const admin = createAdminClient();
    // Un aviso de la aplicación de una organización solo puede tocar los canales de ESA organización.
    const safe = matched.orgId ? await restrictPayloadToOrg(admin, payload, matched.orgId) : payload;
    const sum = await handleWebhook(admin, safe);
    await note('accepted');
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

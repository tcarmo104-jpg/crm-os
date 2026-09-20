import { isAuthorizedCron } from '@/server/auth-secret';
import { dispatchEvents } from '@/server/events/dispatcher';
import { registry } from '@/server/events/handlers';
import { createSupabaseEventStore } from '@/server/events/supabase-store';
import { createAdminClient } from '@/server/supabase-admin';
import { sweepWebhooks } from '@/server/inbound';
import { sweepOutbound } from '@/server/outbound';
import { sweepConnections, sweepGmail } from '@/server/connections';
import { createSupabaseMediaStore, expireStoredAttachments, sweepAttachments } from '@/server/media';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * Procesa la cola de eventos. Lo invoca un programador externo (pg_cron de Supabase o Vercel Cron)
 * con "Authorization: Bearer $CRON_SECRET". Sin secreto válido responde 401.
 */
async function run(request: Request) {
  if (!isAuthorizedCron(request.headers.get('authorization'), process.env.CRON_SECRET)) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
  try {
    const summary = await dispatchEvents(createSupabaseEventStore(), registry);
    // Bandeja: reintenta webhooks pendientes y envíos encolados (cada parte es independiente y no tumba a las demás).
    const admin = createAdminClient();
    const inbox: { webhooks?: unknown; outbound?: unknown; connections?: unknown; gmail?: unknown; attachments?: unknown } = {};
    try { inbox.webhooks = await sweepWebhooks(admin); } catch (e) { console.error(JSON.stringify({ msg: 'sweep_webhooks_failed', error: e instanceof Error ? e.message : String(e) })); }
    try { inbox.outbound = await sweepOutbound(admin); } catch (e) { console.error(JSON.stringify({ msg: 'sweep_outbound_failed', error: e instanceof Error ? e.message : String(e) })); }
    try { inbox.connections = await sweepConnections(admin); } catch (e) { console.error(JSON.stringify({ msg: 'sweep_connections_failed', error: e instanceof Error ? e.message : String(e) })); }
    try { inbox.gmail = await sweepGmail(admin); } catch (e) { console.error(JSON.stringify({ msg: 'sweep_gmail_failed', error: e instanceof Error ? e.message : String(e) })); }
    try { const store = createSupabaseMediaStore(admin); inbox.attachments = { ...(await sweepAttachments(admin, { store }, 5)), expired: await expireStoredAttachments(admin, store) }; } catch (e) { console.error(JSON.stringify({ msg: 'sweep_attachments_failed', error: e instanceof Error ? e.message : String(e) })); }
    return Response.json({ ok: true, ...summary, inbox });
  } catch (e) {
    console.error(JSON.stringify({ msg: 'dispatch_failed', error: e instanceof Error ? e.message : String(e) }));
    return Response.json({ ok: false, error: 'dispatch_failed' }, { status: 500 });
  }
}

export const GET = run;
export const POST = run;

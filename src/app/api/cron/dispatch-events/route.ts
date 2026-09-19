import { isAuthorizedCron } from '@/server/auth-secret';
import { dispatchEvents } from '@/server/events/dispatcher';
import { registry } from '@/server/events/handlers';
import { createSupabaseEventStore } from '@/server/events/supabase-store';

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
    return Response.json({ ok: true, ...summary });
  } catch (e) {
    console.error(JSON.stringify({ msg: 'dispatch_failed', error: e instanceof Error ? e.message : String(e) }));
    return Response.json({ ok: false, error: 'dispatch_failed' }, { status: 500 });
  }
}

export const GET = run;
export const POST = run;

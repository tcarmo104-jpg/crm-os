import { createClient } from '@/lib/supabase/server';
import { getSession } from '@/lib/session';
import { createSupabaseMediaStore, mediaAccessUrl } from '@/server/media';
import { createAdminClient } from '@/server/supabase-admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Entrega de un archivo del Inbox. Comprueba el acceso con la seguridad de la base de datos (organización y alcance del usuario)
 * y responde con una redirección a un enlace firmado de vida corta. Nunca hay un enlace permanente ni público.
 * Sin acceso o si no existe → 404 idéntico (no revela si el archivo existe).
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession();
  if (!session?.active) return new Response('unauthorized', { status: 401, headers: { 'Cache-Control': 'no-store' } });
  const download = new URL(req.url).searchParams.get('download') === '1';
  const r = await mediaAccessUrl(await createClient(), createSupabaseMediaStore(createAdminClient()), id, { download });
  if (!r.ok) return new Response(r.reason === 'not_found' ? 'not found' : 'unavailable', { status: r.reason === 'not_found' ? 404 : 409, headers: { 'Cache-Control': 'no-store' } });
  return new Response(null, { status: 302, headers: { Location: r.url, 'Cache-Control': download ? 'no-store' : 'private, max-age=60', 'Referrer-Policy': 'no-referrer' } });
}

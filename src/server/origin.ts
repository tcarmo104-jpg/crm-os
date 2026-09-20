import 'server-only';
import { headers } from 'next/headers';
import { pickOrigin } from '@/lib/origin';

/** Dirección pública del CRM, detectada por la petición actual (o NEXT_PUBLIC_SITE_URL si está definida con https). */
export async function serverOrigin(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const h = await headers();
  return pickOrigin({ envUrl: env.NEXT_PUBLIC_SITE_URL, host: h.get('x-forwarded-host') ?? h.get('host'), proto: h.get('x-forwarded-proto') }) ?? 'http://localhost:3000';
}

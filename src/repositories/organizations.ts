import type { ServerSupabase } from '@/lib/supabase/server';
import { unwrap } from '@/lib/errors';

export async function createOrganization(db: ServerSupabase, name: string, slug: string): Promise<string> {
  return unwrap(await db.rpc('create_organization', { p_name: name, p_slug: slug })) as string;
}

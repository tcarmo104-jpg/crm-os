import type { ServerSupabase } from '@/lib/supabase/server';
import { unwrap } from '@/lib/errors';
import type { ApiKeyRow } from '@/lib/types';

export async function listApiKeys(db: ServerSupabase, orgId: string): Promise<ApiKeyRow[]> {
  const rows = unwrap(
    await db.from('api_keys').select('id, name, key_prefix, rate_limit_per_min, created_at, last_used_at, revoked_at')
      .eq('org_id', orgId).order('created_at', { ascending: false }),
  ) as { id: string; name: string; key_prefix: string; rate_limit_per_min: number; created_at: string; last_used_at: string | null; revoked_at: string | null }[];
  return rows.map((r) => ({
    id: r.id, name: r.name, keyPrefix: r.key_prefix, rateLimitPerMin: r.rate_limit_per_min,
    createdAt: r.created_at, lastUsedAt: r.last_used_at, revokedAt: r.revoked_at,
  }));
}

export async function createApiKey(db: ServerSupabase, orgId: string, name: string): Promise<string> {
  return unwrap(await db.rpc('create_api_key', { p_org: orgId, p_name: name })) as string;
}

export async function revokeApiKey(db: ServerSupabase, id: string) {
  unwrap(await db.rpc('revoke_api_key', { p_id: id }));
}

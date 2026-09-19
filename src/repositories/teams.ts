import type { ServerSupabase } from '@/lib/supabase/server';
import { unwrap } from '@/lib/errors';
import type { TeamRow } from '@/lib/types';

export async function listTeams(db: ServerSupabase, orgId: string): Promise<TeamRow[]> {
  const rows = unwrap(
    await db.from('teams').select('id, name, region').eq('org_id', orgId).order('name'),
  ) as TeamRow[];
  return rows;
}

export async function insertTeam(db: ServerSupabase, orgId: string, name: string, region: string | null) {
  unwrap(await db.from('teams').insert({ org_id: orgId, name, region }).select('id').single());
}

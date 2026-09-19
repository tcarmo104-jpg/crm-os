import type { ServerSupabase } from '@/lib/supabase/server';
import * as repo from '@/repositories/teams';
import { teamSchema, firstIssue } from './schemas';
import { UserFacingError } from '@/lib/errors';

export async function createTeam(db: ServerSupabase, orgId: string, input: { name: string; region?: string }) {
  const parsed = teamSchema.safeParse(input);
  if (!parsed.success) throw new UserFacingError(firstIssue(parsed.error));
  await repo.insertTeam(db, orgId, parsed.data.name, parsed.data.region ?? null);
}

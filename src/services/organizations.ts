import type { ServerSupabase } from '@/lib/supabase/server';
import * as repo from '@/repositories/organizations';
import { organizationSchema, firstIssue } from './schemas';
import { UserFacingError } from '@/lib/errors';

export async function createOrganization(db: ServerSupabase, input: { name: string; slug: string }) {
  const parsed = organizationSchema.safeParse(input);
  if (!parsed.success) throw new UserFacingError(firstIssue(parsed.error));
  return repo.createOrganization(db, parsed.data.name, parsed.data.slug);
}

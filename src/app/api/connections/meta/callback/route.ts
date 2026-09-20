import { completeMetaLogin } from '@/server/connections';
import { finishOAuth } from '@/server/oauth-flow';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = (req: Request) => finishOAuth(req, 'meta', async (c) => {
  const sid = await completeMetaLogin(c.admin, { code: c.code, redirectUri: c.redirectUri, orgId: c.orgId, userId: c.userId });
  return { to: `/settings/connections/meta/select?s=${encodeURIComponent(sid)}` };
});

import { completeGoogleLogin } from '@/server/connections';
import { finishOAuth } from '@/server/oauth-flow';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
export const GET = (req: Request) => finishOAuth(req, 'google', async (c) => {
  const r = await completeGoogleLogin(c.db, c.admin, { code: c.code, redirectUri: c.redirectUri, orgId: c.orgId });
  const base = r.outcome.state === 'connected' ? `Gmail conectado: ${r.email}.${r.synced > 0 ? ` Se trajeron ${r.synced} ${r.synced === 1 ? 'correo' : 'correos'} a tu Inbox.` : ' Los correos nuevos llegarán a tu Inbox.'}` : `Se guardó ${r.email}, pero la verificación no terminó bien. Revisa el estado en «Configurar».`;
  return { flash: { kind: r.outcome.state === 'connected' ? 'ok' : 'error', message: base }, to: '/settings/connections' };
});

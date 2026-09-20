import { beginOAuth } from '@/server/oauth-flow';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = () => beginOAuth('google');

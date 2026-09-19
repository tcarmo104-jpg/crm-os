import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co');
vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-key-de-prueba');
import { isSelfAuthenticated, updateSession } from './middleware';

describe('rutas que se autentican solas (sin sesión de usuario)', () => {
  it('los webhooks de Meta y la API de leads NO exigen sesión (Meta no tiene cuenta en el CRM)', () => {
    for (const p of ['/api/webhooks/meta', '/api/webhooks', '/api/webhooks/otro', '/api/v1/leads']) expect(isSelfAuthenticated(p), p).toBe(true);
  });
  it('las páginas y demás rutas siguen protegidas; prefijos parecidos no se cuelan', () => {
    for (const p of ['/inbox', '/inbox/123', '/settings/channels', '/api/webhooksx', '/api/webhooks-evil', '/api/v10', '/', '/customers']) expect(isSelfAuthenticated(p), p).toBe(false);
  });
  it('REGRESIÓN: una petición sin sesión al webhook (como la de Meta) pasa; no se redirige al login', async () => {
    for (const [method, url] of [['GET', 'https://crm.test/api/webhooks/meta?hub.mode=subscribe&hub.verify_token=x&hub.challenge=1'], ['POST', 'https://crm.test/api/webhooks/meta']] as const) {
      const res = await updateSession(new NextRequest(url, { method }));
      expect(res.status, `${method} ${url}`).toBe(200);
      expect(res.headers.get('location')).toBeNull();
    }
  });
});

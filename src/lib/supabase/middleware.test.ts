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

  it('las páginas legales (política de privacidad y eliminación de datos) son PÚBLICAS: Meta y Google las abren sin sesión', async () => {
    for (const path of ['/privacidad', '/eliminacion-de-datos']) {
      const res = await updateSession(new NextRequest(`https://crm.test${path}`));
      expect(res.headers.get('location'), path).toBeNull();
    }
  });
  it('...pero el resto sigue exigiendo sesión (sin ella, al inicio de sesión) y un prefijo parecido no se cuela', async () => {
    for (const path of ['/inbox', '/settings/connections', '/privacidad-interna', '/eliminacion-de-datos-x/y']) {
      const res = await updateSession(new NextRequest(`https://crm.test${path}`));
      expect(res.headers.get('location') ?? '', path).toMatch(/\/login/);
    }
  });
});

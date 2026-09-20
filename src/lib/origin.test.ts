import { describe, expect, it } from 'vitest';
import { isLocalHost, isPublicHttps, pickOrigin } from './origin';

describe('dirección pública del CRM (sin variable de Vercel)', () => {
  it('se detecta sola por la petición y siempre con https en un dominio público', () => {
    expect(pickOrigin({ host: 'crm-os-steel.vercel.app', proto: 'https' })).toBe('https://crm-os-steel.vercel.app');
    expect(pickOrigin({ host: 'crm-os-steel.vercel.app', proto: 'http' })).toBe('https://crm-os-steel.vercel.app');      // un dominio público se fuerza a https
    expect(pickOrigin({ host: 'crm.miempresa.com' })).toBe('https://crm.miempresa.com');
  });
  it('detrás de un proxy toma el primer valor', () => { expect(pickOrigin({ host: 'a.example.com, b.internal', proto: 'https, http' })).toBe('https://a.example.com'); });
  it('la variable explícita con https manda, pero una inválida o local se ignora', () => {
    expect(pickOrigin({ envUrl: 'https://crm.miempresa.com/', host: 'otro.vercel.app' })).toBe('https://crm.miempresa.com');
    expect(pickOrigin({ envUrl: 'http://localhost:3000', host: 'crm.vercel.app' })).toBe('https://crm.vercel.app');
    expect(pickOrigin({ envUrl: 'crm.sin-protocolo.com', host: 'crm.vercel.app' })).toBe('https://crm.vercel.app');
    expect(pickOrigin({ envUrl: 'https://con-ruta.com/api', host: 'crm.vercel.app' })).toBe('https://crm.vercel.app');
  });
  it('en local respeta http; y nunca acepta rutas, credenciales ni caracteres raros', () => {
    expect(pickOrigin({ host: 'localhost:3000', proto: 'http' })).toBe('http://localhost:3000');
    expect(pickOrigin({ host: '127.0.0.1:3999' })).toBe('http://127.0.0.1:3999');
    for (const bad of ['evil.com/path', 'user:pw@evil.com', 'a b.com', 'evil.com\r\nX: y', '<script>', '']) expect(pickOrigin({ host: bad })).toBeNull();
    expect(pickOrigin({})).toBeNull();
  });
  it('¿es una dirección pública https?', () => {
    expect(isPublicHttps('https://crm.vercel.app')).toBe(true); expect(isPublicHttps('http://crm.vercel.app')).toBe(false); expect(isPublicHttps('https://localhost')).toBe(false);
    expect(isPublicHttps('https://127.0.0.1:3000')).toBe(false); expect(isPublicHttps('https://crm.vercel.app/x')).toBe(false); expect(isPublicHttps(null)).toBe(false);
    expect(isLocalHost('localhost:3000')).toBe(true); expect(isLocalHost('crm.vercel.app')).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { safeNext } from './redirect';
import { slugify } from './slug';

describe('safeNext (anti open-redirect)', () => {
  it('acepta rutas internas', () => {
    expect(safeNext('/invite/abc')).toBe('/invite/abc');
    expect(safeNext('/settings/members?x=1')).toBe('/settings/members?x=1');
  });
  it('rechaza URLs externas y trucos', () => {
    for (const bad of ['https://evil.com', '//evil.com', '/\\evil.com', 'javascript:alert(1)', 'evil.com', '/ok\r\nSet-Cookie: a=b']) {
      expect(safeNext(bad)).toBe('/');
    }
    expect(safeNext(null)).toBe('/');
    expect(safeNext('', '/x')).toBe('/x');
  });
});

describe('slugify', () => {
  it('normaliza acentos, símbolos y espacios', () => {
    expect(slugify('Distribuidora Andina S.A.S.')).toBe('distribuidora-andina-s-a-s');
    expect(slugify('  Ñandú & Compañía  ')).toBe('nandu-compania');
  });
  it('respeta la longitud máxima sin dejar guion final', () => {
    const s = slugify('a'.repeat(30) + ' ' + 'b'.repeat(30), 31);
    expect(s.length).toBeLessThanOrEqual(31);
    expect(s.endsWith('-')).toBe(false);
  });
});

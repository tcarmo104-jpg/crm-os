import { describe, expect, it } from 'vitest';
import { extractApiKey, hashApiKey } from './api-keys';

const KEY = 'crm_' + 'a1'.repeat(32);

describe('hashApiKey', () => {
  it('es SHA-256 hexadecimal (mismo vector que la BD)', () => {
    expect(hashApiKey('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('extractApiKey', () => {
  it('lee Bearer y X-API-Key', () => {
    expect(extractApiKey(new Headers({ authorization: `Bearer ${KEY}` }))).toBe(KEY);
    expect(extractApiKey(new Headers({ 'x-api-key': KEY }))).toBe(KEY);
  });
  it('rechaza formatos inválidos sin llegar a la base de datos', () => {
    expect(extractApiKey(new Headers())).toBeNull();
    expect(extractApiKey(new Headers({ authorization: 'Bearer corta' }))).toBeNull();
    expect(extractApiKey(new Headers({ authorization: `Basic ${KEY}` }))).toBeNull();
    expect(extractApiKey(new Headers({ authorization: `Bearer ${KEY.toUpperCase()}` }))).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor } from './cursor';

const ok = { ts: '2026-09-19T12:00:00.123456+00:00', id: '11111111-2222-3333-4444-555555555555' };

describe('cursor', () => {
  it('ida y vuelta', () => expect(decodeCursor(encodeCursor(ok))).toEqual(ok));
  it('rechaza valores inválidos o con intento de inyección en filtros', () => {
    expect(decodeCursor(undefined)).toBeNull();
    expect(decodeCursor('no-base64-json')).toBeNull();
    expect(decodeCursor(encodeCursor({ ...ok, id: 'x),or(owner_id.not.is.null' }))).toBeNull();
    expect(decodeCursor(encodeCursor({ ...ok, ts: '2026-01-01,id.gt.0' }))).toBeNull();
    expect(decodeCursor('a'.repeat(300))).toBeNull();
  });
});

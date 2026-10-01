import { describe, expect, it } from 'vitest';
import { canReplyPrivately } from './comments';

describe('canReplyPrivately: Meta solo permite responder en privado dentro de los 7 días', () => {
  const now = new Date('2026-09-15T12:00:00Z');
  it('un comentario de hace unas horas: sí se puede', () => { expect(canReplyPrivately('2026-09-15T08:00:00Z', now)).toBe(true); });
  it('un comentario de hace exactamente 7 días: todavía sí', () => { expect(canReplyPrivately('2026-09-08T12:00:00Z', now)).toBe(true); });
  it('un comentario de hace 8 días: ya no', () => { expect(canReplyPrivately('2026-09-07T11:00:00Z', now)).toBe(false); });
});

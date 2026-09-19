import { timingSafeEqual } from 'node:crypto';

/** Compara el header "Authorization: Bearer <secreto>" en tiempo constante. */
export function isAuthorizedCron(header: string | null, secret: string | undefined): boolean {
  if (!secret || secret.length < 16 || !header) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const received = Buffer.from(header);
  if (expected.length !== received.length) return false;
  return timingSafeEqual(expected, received);
}

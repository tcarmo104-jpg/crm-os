import { createHash } from 'node:crypto';

export const API_KEY_RE = /^crm_[0-9a-f]{64}$/;

/** Mismo algoritmo que la base de datos: SHA-256 en hexadecimal del texto UTF-8. */
export function hashApiKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

/** Acepta "Authorization: Bearer <llave>" o "X-API-Key: <llave>". Devuelve null si no tiene formato válido. */
export function extractApiKey(headers: Headers): string | null {
  const auth = headers.get('authorization');
  const candidate = auth?.match(/^Bearer\s+(\S+)$/i)?.[1] ?? headers.get('x-api-key')?.trim() ?? null;
  return candidate && API_KEY_RE.test(candidate) ? candidate : null;
}

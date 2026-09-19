/** Paginación por cursor (keyset): estable aunque lleguen registros nuevos mientras se pagina. */
const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface Cursor { ts: string; id: string }

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

/** Devuelve null si el cursor es inválido (nunca se interpola en filtros sin validar). */
export function decodeCursor(raw: string | undefined | null): Cursor | null {
  if (!raw || raw.length > 200) return null;
  try {
    const v = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<Cursor>;
    if (typeof v.ts === 'string' && typeof v.id === 'string' && TS_RE.test(v.ts) && UUID_RE.test(v.id)) {
      return { ts: v.ts, id: v.id };
    }
  } catch { /* cursor corrupto */ }
  return null;
}
